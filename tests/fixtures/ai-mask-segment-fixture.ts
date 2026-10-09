import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  resolveSegmentationProfile,
  segmentationEngineTreeHash,
  type SegmentationProfileConfig,
} from "../../apps/server/src/services/ai/segmentation-profile.js";
import type {
  SegmentationWorkerTask,
  SegmentationWorkerResult,
} from "../../apps/server/src/services/ai/image-mask-segment.js";

const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
/** Trusted-files fixture only. Never imports a model, downloads weights or launches Python. */
export async function fixtureSegmentationProfile(root: string) {
  const engineRoot = join(root, "fixture-engine"),
    workerPath = join(root, "fixture-worker"),
    checkpointPath = join(root, "fixture-weights");
  await mkdir(engineRoot, { recursive: true });
  await writeFile(join(engineRoot, "config.yaml"), "model: fixture\n");
  await writeFile(join(engineRoot, "__init__.py"), "fixture\n");
  await writeFile(workerPath, "# injected isolated worker\n");
  await writeFile(checkpointPath, "fixture weights");
  const config: SegmentationProfileConfig = {
    version: 1,
    id: "mask-fixture",
    pythonPath: process.execPath,
    workerPath,
    workerSha256: sha(await readFile(workerPath)),
    engineRoot,
    engineCommit: "1".repeat(40),
    engineTreeSha256: await segmentationEngineTreeHash(engineRoot),
    checkpointPath,
    checkpointVersion: "fixture-v1",
    checkpointSha256: sha(await readFile(checkpointPath)),
    config: "config.yaml",
    configSha256: sha(await readFile(join(engineRoot, "config.yaml"))),
    dependencies: {
      python: "3.12.14",
      torch: "2.5.1",
      torchvision: "0.20.1",
      numpy: "2.5.3",
      pillow: "12.3.0",
    },
    threads: 1,
    timeoutMs: 1000,
  };
  const path = join(root, "fixture-profile.json");
  await writeFile(path, JSON.stringify(config));
  const status = await resolveSegmentationProfile(
    { DOCA_AI_IMAGE_SEGMENT_PROFILE: path },
    {
      probe: async () => ({ engineRoot, dependencies: config.dependencies }),
    },
  );
  if (status.status !== "ready") throw new Error("Fixture profile unavailable");
  return status.profile;
}

/** A real strict worker report and exact PNG artifacts, with no inference quality claim. */
export function fixtureSegmentationWorker(pixels: Buffer) {
  return async (
    profile: Awaited<ReturnType<typeof fixtureSegmentationProfile>>,
    task: SegmentationWorkerTask,
    signal: AbortSignal,
  ): Promise<SegmentationWorkerResult> => {
    signal.throwIfAborted();
    const source = await readFile(task.sourcePath),
      meta = await sharp(source).metadata();
    const width = meta.width!,
      height = meta.height!,
      exclusion = Buffer.alloc(width * height);
    if (pixels.length !== width * height)
      throw new Error("Fixture dimensions mismatch");
    const encode = (data: Buffer) =>
      sharp(data, { raw: { width, height, channels: 1 } })
        .toColourspace("b-w")
        .png()
        .toBuffer();
    const targetPNG = await encode(pixels),
      exclusionPNG = await encode(exclusion);
    const reportParts = (parts: typeof task.targets, mask: Buffer) =>
      parts.map((part) => {
        const check = (point: [number, number]) => {
          const pixel: [number, number] = [
            Math.min(Math.floor(point[0] * width), width - 1),
            Math.min(Math.floor(point[1] * height), height - 1),
          ];
          return {
            point,
            pixel,
            included: mask[pixel[1] * width + pixel[0]] === 255,
          };
        };
        const positivePoints = part.positivePoints.map(check),
          negativePoints = part.negativePoints.map(check),
          positiveMissing = positivePoints.filter((p) => !p.included).length,
          negativeIncluded = negativePoints.filter((p) => p.included).length;
        return {
          label: part.label,
          box: part.box,
          selectedStage: "initial",
          selectedIndex: 0,
          modelScore: 0.9,
          pixels: mask.filter((p) => p === 255).length,
          pointChecks: {
            positivePoints,
            negativePoints,
            positiveMissing,
            negativeIncluded,
          },
          pointConstraintsSatisfied: !positiveMissing && !negativeIncluded,
          predictionSeconds: 0.01,
          candidates: [
            {
              stage: "initial",
              index: 0,
              modelScore: 0.9,
              positiveMissing,
              negativeIncluded,
            },
          ],
        };
      });
    const parts = {
      targets: reportParts(task.targets, pixels),
      exclusions: reportParts(task.exclusions, exclusion),
    };
    const constraintFailures = [
      ...parts.targets.map((p) => ({ group: "targets", p })),
      ...parts.exclusions.map((p) => ({ group: "exclusions", p })),
    ]
      .filter(({ p }) => !p.pointConstraintsSatisfied)
      .map(({ group, p }) => ({
        group,
        label: p.label,
        positiveMissing: p.pointChecks.positiveMissing,
        negativeIncluded: p.pointChecks.negativeIncluded,
        missingPositive: p.pointChecks.positivePoints.filter(
          (p) => !p.included,
        ),
        includedNegative: p.pointChecks.negativePoints.filter(
          (p) => p.included,
        ),
      }));
    const count = pixels.filter((p) => p === 255).length;
    const report = {
      version: 1,
      candidateOnly: true,
      engine: {
        name: "sam2",
        device: "cpu",
        commit: profile.facts.engineCommit,
        checkpointVersion: profile.facts.checkpointVersion,
        checkpointSha256: profile.facts.checkpointSha256,
        config: profile.facts.config,
        configSha256: profile.facts.configSha256,
        torchVersion: profile.facts.dependencies.torch,
        pythonVersion: profile.facts.dependencies.python,
      },
      source: {
        width,
        height,
        originalWidth: width,
        originalHeight: height,
        exifOrientation: null,
        sha256: sha(source),
      },
      parts,
      pointConstraintsSatisfied: constraintFailures.length === 0,
      constraintFailures,
      conflicts: {
        overlapPixels: 0,
        targetPositiveExcluded: [],
        exclusionPositiveInTarget: [],
      },
      counts: {
        targetPixels: count,
        exclusionPixels: 0,
        editablePixelsAfterExclusion: count,
      },
      timings: {
        loadSeconds: 0.01,
        embeddingSeconds: 0.01,
        predictionSeconds: 0.01,
        writeSeconds: 0.01,
        totalSeconds: 0.04,
      },
      acceptance:
        "This is a segmentation candidate, not visual coverage or final-edit acceptance.",
      artifacts: {
        target: {
          path: join(task.outputDir, "target-union.png"),
          mime: "image/png",
          width,
          height,
          sha256: sha(targetPNG),
        },
        exclusion: {
          path: join(task.outputDir, "exclusion-union.png"),
          mime: "image/png",
          width,
          height,
          sha256: sha(exclusionPNG),
        },
      },
    };
    await mkdir(task.outputDir);
    await writeFile(report.artifacts.target.path, targetPNG);
    await writeFile(report.artifacts.exclusion.path, exclusionPNG);
    await writeFile(
      join(task.outputDir, "result.json"),
      JSON.stringify(report),
    );
    const failed = constraintFailures.length > 0;
    return {
      exitCode: failed ? 2 : 0,
      stdout: Buffer.from(
        JSON.stringify(
          failed
            ? {
                ok: false,
                version: 1,
                error: {
                  code: "point_constraints_unsatisfied",
                  message: "fixture constraint failure",
                  facts: report,
                },
              }
            : { ok: true, ...report },
        ),
      ),
      stderr: Buffer.alloc(0),
      code: null,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  };
}
