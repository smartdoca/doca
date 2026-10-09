import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { fail } from "@core/shared/errors.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !/[\x00-\x1f]/.test(value));
const version = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.+\-]+$/);
export const segmentationProfileSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    pythonPath: localPath,
    workerPath: localPath,
    workerSha256: hash,
    engineRoot: localPath,
    engineCommit: z.string().regex(/^[a-f0-9]{40}$/),
    engineTreeSha256: hash,
    checkpointPath: localPath,
    checkpointVersion: version,
    checkpointSha256: hash,
    config: z
      .string()
      .regex(/^[A-Za-z0-9_./+\-]+\.yaml$/)
      .refine(
        (value) => !isAbsolute(value) && !value.split("/").includes(".."),
      ),
    configSha256: hash,
    dependencies: z
      .object({
        python: version,
        torch: version,
        torchvision: version,
        numpy: version,
        pillow: version,
      })
      .strict(),
    threads: z.number().int().min(1).max(32),
    timeoutMs: z.number().int().min(1000).max(300_000),
  })
  .strict();
export type SegmentationProfileConfig = z.infer<
  typeof segmentationProfileSchema
>;
export const segmentationEngineFactsSchema = z
  .object({
    profileId: z.string(),
    profileDigest: hash,
    name: z.literal("sam2"),
    device: z.literal("cpu"),
    workerSha256: hash,
    engineCommit: z.string().regex(/^[a-f0-9]{40}$/),
    engineTreeSha256: hash,
    checkpointVersion: version,
    checkpointSha256: hash,
    config: z.string(),
    configSha256: hash,
    dependencies: segmentationProfileSchema.shape.dependencies,
    threads: z.number().int().min(1).max(32),
  })
  .strict();
export type SegmentationEngineFacts = z.infer<
  typeof segmentationEngineFactsSchema
>;
export type VerifiedSegmentationProfile = {
  config: SegmentationProfileConfig;
  facts: SegmentationEngineFacts;
};
export type SegmentationProfileStatus =
  | { status: "disabled" }
  | { status: "unavailable"; code: "local_segmentation_unavailable" }
  | { status: "ready"; profile: VerifiedSegmentationProfile };
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);

async function regular(path: string, allowExecutableLink = false) {
  const info = await lstat(path);
  if (!info.isFile() && !(allowExecutableLink && info.isSymbolicLink()))
    throw Error("local_file_required");
  const resolved = await realpath(path),
    actual = await lstat(resolved);
  if (!actual.isFile() || actual.mode & 0o022)
    throw Error("trusted_file_required");
  return resolved;
}
async function fileHash(path: string) {
  await regular(path);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

/** Installer and host use the same sorted byte manifest. No Git string is treated as attestation. */
export async function segmentationEngineTreeHash(root: string) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022)
    throw Error("trusted_engine_required");
  const manifest: { path: string; sha256: string }[] = [];
  let total = 0;
  const walk = async (directory: string) => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("engine_symlink_forbidden");
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || manifest.length >= 4096)
        throw Error("engine_manifest_invalid");
      const info = await lstat(path);
      total += info.size;
      if (total > 64 * 1024 * 1024) throw Error("engine_manifest_too_large");
      manifest.push({
        path: relative(root, path).split(sep).join("/"),
        sha256: await fileHash(path),
      });
    }
  };
  await walk(root);
  if (!manifest.length) throw Error("engine_manifest_empty");
  return sha(JSON.stringify(manifest));
}

export async function verifySegmentationProfileFiles(
  profile: VerifiedSegmentationProfile,
) {
  const config = segmentationProfileSchema.parse(profile.config);
  if (
    JSON.stringify(profileFacts(config)) !==
    JSON.stringify(segmentationEngineFactsSchema.parse(profile.facts))
  )
    fail(503, "本地分割配置已改变", { code: "local_segmentation_unavailable" });
  try {
    await regular(config.pythonPath, true);
    const values = await Promise.all([
      fileHash(config.workerPath),
      fileHash(config.checkpointPath),
      fileHash(join(config.engineRoot, config.config)),
      segmentationEngineTreeHash(config.engineRoot),
    ]);
    if (
      values.join() !==
      [
        config.workerSha256,
        config.checkpointSha256,
        config.configSha256,
        config.engineTreeSha256,
      ].join()
    )
      throw Error("engine_identity_changed");
  } catch {
    fail(503, "可信本地分割运行文件不可用或摘要已改变", {
      code: "local_segmentation_unavailable",
    });
  }
}

const probeScript = `import contextlib,json,sys\nfrom pathlib import Path\nwith contextlib.redirect_stdout(sys.stderr):\n import sam2,torch,torchvision,numpy,PIL\nprint(json.dumps({"engineRoot":str(Path(sam2.__file__).resolve().parent),"dependencies":{"python":sys.version.split()[0],"torch":torch.__version__,"torchvision":torchvision.__version__,"numpy":numpy.__version__,"pillow":PIL.__version__}}))`;
function profileFacts(
  config: SegmentationProfileConfig,
): SegmentationEngineFacts {
  return {
    profileId: config.id,
    profileDigest: sha(JSON.stringify(config)),
    name: "sam2",
    device: "cpu",
    workerSha256: config.workerSha256,
    engineCommit: config.engineCommit,
    engineTreeSha256: config.engineTreeSha256,
    checkpointVersion: config.checkpointVersion,
    checkpointSha256: config.checkpointSha256,
    config: config.config,
    configSha256: config.configSha256,
    dependencies: config.dependencies,
    threads: config.threads,
  };
}
export type SegmentationDependencyProbe = (pythonPath: string) => Promise<{
  engineRoot: string;
  dependencies: SegmentationProfileConfig["dependencies"];
}>;
const defaultProbe: SegmentationDependencyProbe = async (pythonPath) => {
  const result = await execute(pythonPath, ["-I", "-B", "-c", probeScript], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    shell: false,
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      PYTHONNOUSERSITE: "1",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      OMP_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
    },
  });
  return z
    .object({
      engineRoot: localPath,
      dependencies: segmentationProfileSchema.shape.dependencies,
    })
    .strict()
    .parse(JSON.parse(result.stdout));
};

/** Absence disables this new capability. Malformed explicit configuration is never ignored. */
export async function resolveSegmentationProfile(
  env: Record<string, string | undefined> = process.env,
  options: { probe?: SegmentationDependencyProbe } = {},
): Promise<SegmentationProfileStatus> {
  const path = env.DOCA_AI_IMAGE_SEGMENT_PROFILE;
  if (path === undefined) return { status: "disabled" };
  if (!localPath.safeParse(path).success)
    fail(503, "本地分割 profile 路径无效", {
      code: "local_segmentation_profile_invalid",
    });
  let config: SegmentationProfileConfig;
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 256 * 1024 ||
      info.mode & 0o022
    )
      throw Error("profile_invalid");
    config = segmentationProfileSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
      ),
    );
  } catch {
    fail(503, "本地分割 profile 必须为完整严格 version:1 配置", {
      code: "local_segmentation_profile_invalid",
    });
  }
  const profile: VerifiedSegmentationProfile = {
    config,
    facts: profileFacts(config),
  };
  try {
    await verifySegmentationProfileFiles(profile);
    const actual = await (options.probe ?? defaultProbe)(config.pythonPath);
    if (
      JSON.stringify(
        segmentationProfileSchema.shape.dependencies.parse(actual.dependencies),
      ) !== JSON.stringify(config.dependencies) ||
      (await realpath(actual.engineRoot)) !==
        (await realpath(config.engineRoot))
    )
      throw Error("installed_engine_mismatch");
    return { status: "ready", profile };
  } catch {
    return { status: "unavailable", code: "local_segmentation_unavailable" };
  }
}
