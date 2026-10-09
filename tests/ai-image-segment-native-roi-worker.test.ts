import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  resolveSegmentationProfile,
  segmentationEngineTreeHash,
  segmentationProfileSchema,
} from "../apps/server/src/services/ai/segmentation-profile.js";

const execute = promisify(execFile);
const workerPath = resolve("scripts/ai-image-segment-native-roi.py");
const wholeWorkerPath = resolve("scripts/ai-image-segment.py");
const fileHash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const isolatedEnv = { PATH: process.env.PATH, LANG: "C.UTF-8" };

it("exercises native projection, fixed crop context, all hints, holes, candidate metadata and crop-boundary failures without SAM dependencies", async () => {
  const result = await execute(
    "python3",
    [
      "-I",
      "-B",
      resolve("tests/fixtures/ai-image-segment-native-roi-unit.py"),
      workerPath,
    ],
    { env: isolatedEnv, timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Ran 10 tests");
  expect(result.stderr).toContain("OK");
});

it("keeps the new worker CLI strict v1 and fails before importing SAM for a missing field", async () => {
  const result = await new Promise<{ code: number | null; stdout: string }>(
    (done, reject) => {
      const child = execFile(
        "python3",
        [
          "-I",
          "-B",
          workerPath,
          "--config",
          "configs/sam2.1/sam2.1_hiera_t.yaml",
          "--checkpoint",
          "/isolated-not-installed/weights.pt",
          "--engine-commit",
          "1".repeat(40),
          "--checkpoint-version",
          "unit-v1",
        ],
        { env: isolatedEnv, timeout: 5000, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error && !Number.isInteger(error.code)) reject(error);
          else done({ code: error ? Number(error.code) : 0, stdout });
        },
      );
      child.stdin?.end(JSON.stringify({ version: 1 }));
    },
  );
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    version: 1,
    error: { code: "invalid_input" },
  });
});

it("identifies ROI through a separate explicit strict profile and actual worker hash, never accepting the whole-worker hash or rewriting its profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "doca-native-roi-profile-"));
  try {
    const engineRoot = join(root, "engine");
    await mkdir(join(engineRoot, "configs"), { recursive: true });
    await writeFile(join(engineRoot, "__init__.py"), "# isolated engine\n", {
      mode: 0o600,
    });
    await writeFile(join(engineRoot, "configs", "unit.yaml"), "unit: true\n", {
      mode: 0o600,
    });
    const checkpointPath = join(root, "unit.pt");
    await writeFile(checkpointPath, "isolated model facts", { mode: 0o600 });
    const common = {
      version: 1,
      pythonPath: process.execPath,
      engineRoot,
      engineCommit: "1".repeat(40),
      engineTreeSha256: await segmentationEngineTreeHash(engineRoot),
      checkpointPath,
      checkpointVersion: "unit-v1",
      checkpointSha256: await fileHash(checkpointPath),
      config: "configs/unit.yaml",
      configSha256: await fileHash(join(engineRoot, "configs", "unit.yaml")),
      dependencies: {
        python: "3.12.14",
        torch: "2.5.1",
        torchvision: "0.20.1",
        numpy: "2.5.3",
        pillow: "12.3.0",
      },
      threads: 2,
      timeoutMs: 10_000,
    };
    const whole = segmentationProfileSchema.parse({
      ...common,
      id: "isolated-whole",
      workerPath: wholeWorkerPath,
      workerSha256: await fileHash(wholeWorkerPath),
    });
    const native = segmentationProfileSchema.parse({
      ...common,
      id: "isolated-native-roi",
      workerPath,
      workerSha256: await fileHash(workerPath),
    });
    const wholePath = join(root, "whole-profile.json");
    const nativePath = join(root, "native-profile.json");
    await writeFile(wholePath, JSON.stringify(whole), { mode: 0o600 });
    await writeFile(nativePath, JSON.stringify(native), { mode: 0o600 });
    const originalWholeBytes = await readFile(wholePath);
    const probe = vi.fn(async () => ({
      engineRoot,
      dependencies: common.dependencies,
    }));
    const wholeStatus = await resolveSegmentationProfile(
      { DOCA_AI_IMAGE_SEGMENT_PROFILE: wholePath },
      { probe },
    );
    const nativeStatus = await resolveSegmentationProfile(
      { DOCA_AI_IMAGE_SEGMENT_PROFILE: nativePath },
      { probe },
    );
    expect(wholeStatus.status).toBe("ready");
    expect(nativeStatus.status).toBe("ready");
    if (wholeStatus.status !== "ready" || nativeStatus.status !== "ready")
      throw Error("Expected both separately pinned fixtures");
    expect(nativeStatus.profile.facts.profileId).toBe("isolated-native-roi");
    expect(nativeStatus.profile.facts.workerSha256).toBe(native.workerSha256);
    expect(nativeStatus.profile.facts.profileDigest).not.toBe(
      wholeStatus.profile.facts.profileDigest,
    );
    expect(native.workerSha256).not.toBe(whole.workerSha256);
    await writeFile(
      nativePath,
      JSON.stringify({ ...native, workerSha256: whole.workerSha256 }),
    );
    probe.mockClear();
    expect(
      await resolveSegmentationProfile(
        { DOCA_AI_IMAGE_SEGMENT_PROFILE: nativePath },
        { probe },
      ),
    ).toEqual({
      status: "unavailable",
      code: "local_segmentation_unavailable",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(await readFile(wholePath)).toEqual(originalWholeBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
