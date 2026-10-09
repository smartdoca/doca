import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  resolveSegmentationProfile,
  segmentationEngineTreeHash,
  verifySegmentationProfileFiles,
  type SegmentationProfileConfig,
} from "../apps/server/src/services/ai/segmentation-profile.js";

let root: string, path: string, config: SegmentationProfileConfig;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const probe = () =>
  vi.fn(async () => ({
    engineRoot: config.engineRoot,
    dependencies: config.dependencies,
  }));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-segment-profile-"));
  path = join(root, "profile.json");
  const engineRoot = join(root, "engine"),
    workerPath = join(root, "worker.py"),
    checkpointPath = join(root, "tiny.pt");
  await mkdir(join(engineRoot, "configs"), { recursive: true });
  await writeFile(workerPath, "# isolated trusted fixture\n", { mode: 0o600 });
  await writeFile(checkpointPath, "isolated weights", { mode: 0o600 });
  await writeFile(join(engineRoot, "__init__.py"), "VERSION = 1\n", {
    mode: 0o600,
  });
  await writeFile(
    join(engineRoot, "configs", "tiny.yaml"),
    "model: fixture\n",
    { mode: 0o600 },
  );
  config = {
    version: 1,
    id: "isolated-tiny",
    pythonPath: process.execPath,
    workerPath,
    workerSha256: sha(await readFile(workerPath)),
    engineRoot,
    engineCommit: "1".repeat(40),
    engineTreeSha256: await segmentationEngineTreeHash(engineRoot),
    checkpointPath,
    checkpointVersion: "fixture-v1",
    checkpointSha256: sha(await readFile(checkpointPath)),
    config: "configs/tiny.yaml",
    configSha256: sha(await readFile(join(engineRoot, "configs", "tiny.yaml"))),
    dependencies: {
      python: "3.12.14",
      torch: "2.5.1",
      torchvision: "0.20.1",
      numpy: "2.5.3",
      pillow: "12.3.0",
    },
    threads: 2,
    timeoutMs: 1000,
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("requires explicit opt-in and returns unavailable for missing installed dependencies without downloading or echoing details", async () => {
  const check = probe();
  expect(await resolveSegmentationProfile({}, { probe: check })).toEqual({
    status: "disabled",
  });
  expect(check).not.toHaveBeenCalled();
  const missing = vi.fn(async () => {
    throw Error("private local path and secret installation details");
  });
  expect(
    await resolveSegmentationProfile(
      { DOCA_AI_IMAGE_SEGMENT_PROFILE: path },
      { probe: missing },
    ),
  ).toEqual({ status: "unavailable", code: "local_segmentation_unavailable" });
  expect(missing).toHaveBeenCalledOnce();
});
it.each(["", "relative.json", "https://private.invalid/profile?key=sensitive"])(
  "rejects an invalid explicit path safely: %s",
  async (value) => {
    const error = await resolveSegmentationProfile(
      { DOCA_AI_IMAGE_SEGMENT_PROFILE: value },
      { probe: probe() },
    ).catch((e) => e);
    expect(error).toMatchObject({ status: 503 });
    expect(error.message).not.toContain(value || "relative.json");
  },
);
it.each([
  { version: 0 },
  { version: 2 },
  { extra: true },
  { timeoutMs: 0 },
  { threads: 0 },
  { config: "../outside.yaml" },
])("strictly rejects malformed profile %j", async (changes) => {
  await writeFile(path, JSON.stringify({ ...config, ...changes }));
  const check = probe();
  await expect(
    resolveSegmentationProfile(
      { DOCA_AI_IMAGE_SEGMENT_PROFILE: path },
      { probe: check },
    ),
  ).rejects.toThrow("version:1");
  expect(check).not.toHaveBeenCalled();
});
it("verifies actual worker, config, weight and complete engine manifest bytes, including executable bytecode", async () => {
  const ready = await resolveSegmentationProfile(
    { DOCA_AI_IMAGE_SEGMENT_PROFILE: path },
    { probe: probe() },
  );
  expect(ready.status).toBe("ready");
  if (ready.status !== "ready") throw Error("Expected ready fixture");
  expect(JSON.stringify(ready.profile.facts)).not.toContain(root);
  await verifySegmentationProfileFiles(ready.profile);
  await mkdir(join(config.engineRoot, "__pycache__"));
  await writeFile(
    join(config.engineRoot, "__pycache__", "loaded.pyc"),
    "different executable bytes",
  );
  await expect(verifySegmentationProfileFiles(ready.profile)).rejects.toThrow(
    "摘要已改变",
  );
});
it.each(["worker", "weights", "config", "engine"])(
  "does not trust an unchanged commit label when %s bytes differ",
  async (changed) => {
    const target =
      changed === "worker"
        ? config.workerPath
        : changed === "weights"
          ? config.checkpointPath
          : changed === "config"
            ? join(config.engineRoot, config.config)
            : join(config.engineRoot, "__init__.py");
    await writeFile(target, "changed trusted installation");
    const check = probe();
    expect(
      await resolveSegmentationProfile(
        { DOCA_AI_IMAGE_SEGMENT_PROFILE: path },
        { probe: check },
      ),
    ).toEqual({
      status: "unavailable",
      code: "local_segmentation_unavailable",
    });
    expect(check).not.toHaveBeenCalled();
  },
);
it("rejects a symlink in the source manifest and a symlink profile", async () => {
  await symlink(config.workerPath, join(config.engineRoot, "redirect.py"));
  await expect(segmentationEngineTreeHash(config.engineRoot)).rejects.toThrow(
    "symlink",
  );
  const linked = join(root, "linked.json");
  await symlink(path, linked);
  await expect(
    resolveSegmentationProfile(
      { DOCA_AI_IMAGE_SEGMENT_PROFILE: linked },
      { probe: probe() },
    ),
  ).rejects.toThrow("version:1");
});
it("rejects mismatched imported package roots and dependency versions", async () => {
  for (const actual of [
    { engineRoot: root, dependencies: config.dependencies },
    {
      engineRoot: config.engineRoot,
      dependencies: { ...config.dependencies, torch: "changed" },
    },
  ])
    expect(
      await resolveSegmentationProfile(
        { DOCA_AI_IMAGE_SEGMENT_PROFILE: path },
        { probe: async () => actual },
      ),
    ).toEqual({
      status: "unavailable",
      code: "local_segmentation_unavailable",
    });
});

it("runs the real startup process with an isolated minimal environment, excludes test secrets and arbitrary host variables, and still validates an exact ready profile", async () => {
  const interpreter: { path: string; version: string } = JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-B",
        "-c",
        'import json,sys;print(json.dumps({"path":sys.executable,"version":sys.version.split()[0]}))',
      ],
      { encoding: "utf8" },
    ),
  );
  const launcher = join(root, "probe-python"),
    auditPath = join(root, "audit.json");
  const code = `#!${interpreter.path} -IB
import json,os,sys,types
expected={'PATH','LANG','PYTHONNOUSERSITE','HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','OMP_NUM_THREADS','MKL_NUM_THREADS','LC_CTYPE','__CF_USER_TEXT_ENCODING'}
# Python/macOS may create locale variables themselves; parent application variables stay absent.
# Record booleans and counts only: never persist or print inherited credential values.
with open(${JSON.stringify(auditPath)},'w') as output:
 json.dump({'secretInherited':'OPENAI_API_KEY' in os.environ,'arbitraryInherited':'DOCA_STARTUP_PROBE_UNRELATED' in os.environ,
  'unexpectedVariableCount':len(set(os.environ)-expected),'offline':os.environ.get('HF_HUB_OFFLINE')=='1' and os.environ.get('TRANSFORMERS_OFFLINE')=='1',
  'singleThread':os.environ.get('OMP_NUM_THREADS')=='1' and os.environ.get('MKL_NUM_THREADS')=='1',
  'isolated':sys.flags.isolated==1,'noBytecode':sys.dont_write_bytecode,
  'fixedArguments':sys.argv[1:4]==['-I','-B','-c']},output)
for name,version in [('torch','2.5.1'),('torchvision','0.20.1'),('numpy','2.5.3'),('PIL','12.3.0')]:
 module=types.ModuleType(name);module.__version__=version;sys.modules[name]=module
sam2=types.ModuleType('sam2');sam2.__file__=${JSON.stringify(join(config.engineRoot, "__init__.py"))};sys.modules['sam2']=sam2
exec(compile(sys.argv[4],'<fixed-host-probe>','exec'))
`;
  await writeFile(launcher, code, { mode: 0o700 });
  await chmod(launcher, 0o700);
  config = {
    ...config,
    pythonPath: launcher,
    dependencies: { ...config.dependencies, python: interpreter.version },
  };
  await writeFile(path, JSON.stringify(config));
  vi.stubEnv("OPENAI_API_KEY", "never-print-startup-test-key");
  vi.stubEnv(
    "DOCA_STARTUP_PROBE_UNRELATED",
    "never-inherit-startup-test-value",
  );
  const ready = await resolveSegmentationProfile({
    DOCA_AI_IMAGE_SEGMENT_PROFILE: path,
  });
  expect(ready.status).toBe("ready");
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  expect(audit).toEqual({
    secretInherited: false,
    arbitraryInherited: false,
    unexpectedVariableCount: 0,
    offline: true,
    singleThread: true,
    isolated: true,
    noBytecode: true,
    fixedArguments: true,
  });
  if (ready.status !== "ready")
    throw Error("Fixture startup probe unavailable");
  expect(ready.profile.facts.dependencies).toEqual(config.dependencies);
  await verifySegmentationProfileFiles(ready.profile);
});
