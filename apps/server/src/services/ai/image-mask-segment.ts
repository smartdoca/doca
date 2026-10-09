import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  lstat,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { checkJob, type ToolContext } from "@core/workflows/ai-documents.js";
import {
  requireCapability,
  checkStorage,
} from "@core/modules/access/operation-policy.js";
import {
  createStorage,
  storageRuntime,
  storageConfigForProfile,
  type StorageRuntime,
} from "../../adapters/storage.js";
import { registerStoredObject } from "../stored-objects.js";
import { objectKey } from "../storage-policy.js";
import { readReferenceImages, readRawImageCandidate } from "./images.js";
import {
  rawImageCandidateCanvas,
  rawImageTransformSchema,
} from "./image-candidates.js";
import {
  segmentationEngineFactsSchema,
  verifySegmentationProfileFiles,
  type VerifiedSegmentationProfile,
} from "./segmentation-profile.js";

const MAX_PIXELS = 25_000_000,
  MAX_STDOUT = 8 * 1024 * 1024,
  MAX_STDERR = 1024 * 1024,
  MAX_ARTIFACT = 20 * 1024 * 1024;
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  coordinate = z.number().finite().min(0).max(1),
  point = z.tuple([coordinate, coordinate]);
const count = z.number().int().min(0).max(MAX_PIXELS),
  seconds = z.number().finite().nonnegative();
const box = z
  .tuple([coordinate, coordinate, coordinate, coordinate])
  .refine((value) => value[0] < value[2] && value[1] < value[3], {
    message:
      "box 必须是原页归一化 [left, top, right, bottom]，不是 [left, top, width, height]；left < right 且 top < bottom",
  })
  .describe(
    "完整原页归一化边界 [left, top, right, bottom]，不是宽高。像素框 (x1,y1,x2,y2) 按 [x1/原页宽,y1/原页高,x2/原页宽,y2/原页高] 换算；raw 仍使用原页坐标，不能用裁剪图尺寸归一化。",
  );
const part = z
  .object({
    label: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\x00-\x1f\ud800-\udfff]+$/u)
      .refine((value) => value === value.trim()),
    box,
    positivePoints: z
      .array(point)
      .min(1)
      .max(128)
      .describe(
        "必须包含的真实部位内点 [x/原页宽, y/原页高]，用于提示分割器；点满足不等于完整部位边缘已覆盖。",
      ),
    negativePoints: z
      .array(point)
      .max(127)
      .describe(
        "不应被该部位选中的背景或道具点 [x/原页宽, y/原页高]；不要放在真实人体上以强行消除保护冲突。",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const positive = value.positivePoints.map((p) => p.join()),
      negative = value.negativePoints.map((p) => p.join());
    if (
      positive.length + negative.length > 128 ||
      new Set(positive).size !== positive.length ||
      new Set(negative).size !== negative.length ||
      positive.some((p) => negative.includes(p))
    )
      ctx.addIssue({
        code: "custom",
        message: "Points must be unique, nonconflicting, at most 128 total",
      });
  });
const parts = z
  .array(part)
  .max(64)
  .refine(
    (values) =>
      new Set(values.map((value) => value.label)).size === values.length,
  );
export const imageMaskSegmentInputSchema = z
  .object({
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("reference"),
          referenceImageId: z.string().uuid(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("raw"),
          generationOperationId: z.string().uuid(),
        })
        .strict(),
    ]),
    targets: parts.refine((values) => values.length > 0),
    exclusions: parts,
  })
  .strict();
export type ImageMaskSegmentInput = z.infer<typeof imageMaskSegmentInputSchema>;
const size = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.width * value.height <= MAX_PIXELS);
const rect = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const bindingSchema = z
  .object({
    referenceImageId: z.string().uuid(),
    sourceSha256: hash,
    sourceSize: z.number().int().positive(),
    dimensions: size,
    workerInputSha256: hash,
    generatedWindow: rect,
    raw: z
      .object({
        generationOperationId: z.string().uuid(),
        receiptId: z.string().uuid(),
        sha256: hash,
        transform: rawImageTransformSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
const artifactSchema = z
  .object({
    role: z.enum([
      "target",
      "exclusion",
      "selection",
      "result",
      "stdout",
      "stderr",
    ]),
    assetId: z.string().uuid(),
    profileId: z.string().min(1),
    objectKey: z.string().min(1),
    sha256: hash,
    size: z.number().int().min(0).max(MAX_ARTIFACT),
    mime: z.enum([
      "image/png",
      "application/json",
      "application/octet-stream",
      "text/plain",
    ]),
    validated: z.boolean(),
  })
  .strict();
const pixel = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const pointCheck = z.object({ point, pixel, included: z.boolean() }).strict();
const checks = z
  .object({
    positivePoints: z.array(pointCheck).max(128),
    negativePoints: z.array(pointCheck).max(128),
    positiveMissing: count,
    negativeIncluded: count,
  })
  .strict();
const constraintFailure = z
  .object({
    group: z.enum(["targets", "exclusions", "target-exclusion-conflict"]),
    label: z.string().max(100),
    positiveMissing: count,
    negativeIncluded: count,
    missingPositive: z.array(pointCheck).max(128),
    includedNegative: z.array(pointCheck).max(128),
  })
  .strict();
const partReport = z
  .object({
    label: z.string().max(100),
    box,
    selectedStage: z.enum(["initial", "logits-refined"]),
    selectedIndex: z.number().int().min(0).max(2),
    modelScore: z.number().finite(),
    pixels: count,
    pointChecks: checks,
    pointConstraintsSatisfied: z.boolean(),
    predictionSeconds: seconds,
    candidates: z
      .array(
        z
          .object({
            stage: z.enum(["initial", "logits-refined"]),
            index: z.number().int().min(0).max(2),
            modelScore: z.number().finite(),
            positiveMissing: count,
            negativeIncluded: count,
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
const workerArtifact = z
  .object({
    path: z.string().max(4096),
    mime: z.literal("image/png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: hash,
  })
  .strict();
const overlapPoint = z
  .object({
    label: z.string().max(100),
    pointIndex: z.number().int().min(0).max(127),
    point,
    pixel,
  })
  .strict();
const workerReportSchema = z
  .object({
    version: z.literal(1),
    candidateOnly: z.literal(true),
    engine: z
      .object({
        name: z.literal("sam2"),
        device: z.literal("cpu"),
        commit: z.string(),
        checkpointVersion: z.string(),
        checkpointSha256: hash,
        config: z.string(),
        configSha256: hash,
        torchVersion: z.string(),
        pythonVersion: z.string(),
      })
      .strict(),
    source: size.safeExtend({
      originalWidth: z.number().int().positive(),
      originalHeight: z.number().int().positive(),
      exifOrientation: z.number().int().min(1).max(8).nullable(),
      sha256: hash,
    }),
    parts: z
      .object({
        targets: z.array(partReport).min(1).max(64),
        exclusions: z.array(partReport).max(64),
      })
      .strict(),
    pointConstraintsSatisfied: z.boolean(),
    constraintFailures: z.array(constraintFailure).max(16_384),
    conflicts: z
      .object({
        overlapPixels: count,
        targetPositiveExcluded: z.array(overlapPoint).max(8192),
        exclusionPositiveInTarget: z.array(overlapPoint).max(8192),
      })
      .strict(),
    counts: z
      .object({
        targetPixels: count,
        exclusionPixels: count,
        editablePixelsAfterExclusion: count,
      })
      .strict(),
    timings: z
      .object({
        loadSeconds: seconds,
        embeddingSeconds: seconds,
        predictionSeconds: seconds,
        writeSeconds: seconds,
        totalSeconds: seconds,
      })
      .strict(),
    acceptance: z.literal(
      "This is a segmentation candidate, not visual coverage or final-edit acceptance.",
    ),
    artifacts: z
      .object({ target: workerArtifact, exclusion: workerArtifact })
      .strict(),
  })
  .strict();
type WorkerReport = z.infer<typeof workerReportSchema>;
const diagnosticsSchema = z
  .object({
    semanticCoverage: z.literal("unverified"),
    pointConstraintsSatisfied: z.boolean(),
    failureCode: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .nullable(),
    targetPixels: count,
    exclusionPixels: count,
    selectionPixels: count,
    outsideGeneratedWindowPixels: count,
    constraintFailures: z.array(constraintFailure).max(16_384),
    exitCode: z.number().int().nullable(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  })
  .strict();
const instruction =
  "这是本地分割提案，不是人物完整覆盖、身份、背景或最终图片的语义验收。二值蒙版保留孔洞及不连通区域；模型分数或提示点满足不能证明边缘正确。必须查看完整/局部预览，再用原人、新人、可见保护物与用户明确允许的遮挡分别准备蒙版；失败提案只能诊断，不能用于合成。绿色为提案，红色为被排除区域；预览缩放及图例不改变原页坐标。";
const receiptBase = z
  .object({
    kind: z.literal("image_mask_segment"),
    version: z.literal(1),
    state: z.enum(["ready", "diagnostic-only"]),
    usable: z.boolean(),
    receiptId: z.string().uuid(),
    scope: z
      .object({
        preparedJobId: z.string().uuid(),
        sessionId: z.string().uuid(),
      })
      .strict(),
    input: imageMaskSegmentInputSchema,
    binding: bindingSchema,
    engine: segmentationEngineFactsSchema,
    artifacts: z
      .array(artifactSchema)
      .max(6)
      .refine(
        (values) =>
          new Set(values.map((value) => value.role)).size === values.length,
      ),
    selectionSha256: hash.nullable(),
    diagnostics: diagnosticsSchema,
    instruction: z.literal(instruction),
  })
  .strict()
  .refine(
    (value) =>
      value.usable === (value.state === "ready") &&
      (!value.usable ||
        (value.diagnostics.pointConstraintsSatisfied &&
          value.diagnostics.failureCode === null &&
          value.selectionSha256 !== null &&
          value.diagnostics.selectionPixels > 0 &&
          value.diagnostics.outsideGeneratedWindowPixels === 0)),
  );
export const imageMaskSegmentReceiptSchema = receiptBase.safeExtend({
  digest: hash,
});
export type ImageMaskSegmentReceipt = z.infer<
  typeof imageMaskSegmentReceiptSchema
>;
type Binding = z.infer<typeof bindingSchema>;
type Artifact = z.infer<typeof artifactSchema>;
const receiptDigest = (value: z.infer<typeof receiptBase>) =>
  sha("doca-image-mask-segment-v1\0" + JSON.stringify(value));
export type SegmentationWorkerResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  code: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};
export type SegmentationWorkerTask = {
  version: 1;
  sourcePath: string;
  outputDir: string;
  targets: ImageMaskSegmentInput["targets"];
  exclusions: ImageMaskSegmentInput["exclusions"];
};
type WorkerRun = (
  profile: VerifiedSegmentationProfile,
  task: SegmentationWorkerTask,
  signal: AbortSignal,
) => Promise<SegmentationWorkerResult>;
type Options = {
  storage?: StorageRuntime;
  signal?: AbortSignal;
  profile?: VerifiedSegmentationProfile;
  worker?: WorkerRun;
};
let activeWorker = false;

/** Tool-visible failures must never serialize private object paths, worker output or causes. */
async function publicBoundary<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // A caller may attach private diagnostics to signal.reason. Preserve cancellation
    // as AbortError while keeping that reason out of SDK/tool serialization.
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw new DOMException("本地分割已取消或任务授权已撤回", "AbortError");
    if (error instanceof AppError) throw error;
    fail(
      503,
      "本地分割资料或图像处理暂时不可用，原记录保留；本次没有调用图片服务",
      {
        code: "local_segmentation_io_failed",
      },
    );
  }
}

/** Only the host assigns paths. Text output is bounded and never printed or sent to the model. */
export async function runSegmentationWorker(
  profile: VerifiedSegmentationProfile,
  task: SegmentationWorkerTask,
  signal: AbortSignal,
): Promise<SegmentationWorkerResult> {
  signal.throwIfAborted();
  const input = Buffer.from(JSON.stringify(task));
  if (input.length > 256 * 1024) fail(413, "分割提示超过本地工作器输入限制");
  return new Promise((resolve, reject) => {
    const config = profile.config;
    const child = spawn(
      config.pythonPath,
      [
        "-I",
        "-B",
        config.workerPath,
        "--config",
        config.config,
        "--checkpoint",
        config.checkpointPath,
        "--engine-commit",
        config.engineCommit,
        "--checkpoint-version",
        config.checkpointVersion,
        "--threads",
        String(config.threads),
      ],
      {
        cwd: join(task.outputDir, ".."),
        shell: false,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          PYTHONNOUSERSITE: "1",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          OMP_NUM_THREADS: String(config.threads),
          MKL_NUM_THREADS: String(config.threads),
          TMPDIR: join(task.outputDir, ".."),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let outBytes = 0,
      errBytes = 0,
      code: string | null = null,
      outTruncated = false,
      errTruncated = false,
      killed: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      code ??= reason;
      child.kill("SIGTERM");
      killed ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const capture = (
      chunk: Buffer,
      target: Buffer[],
      maximum: number,
      stderr: boolean,
    ) => {
      const length = stderr ? errBytes : outBytes,
        remaining = Math.max(0, maximum - length);
      if (remaining) target.push(Buffer.from(chunk.subarray(0, remaining)));
      if (stderr) errBytes += chunk.length;
      else outBytes += chunk.length;
      if (length + chunk.length > maximum) {
        if (stderr) errTruncated = true;
        else outTruncated = true;
        stop("worker_output_limit");
      }
    };
    child.stdout.on("data", (chunk) =>
      capture(chunk, output, MAX_STDOUT, false),
    );
    child.stderr.on("data", (chunk) =>
      capture(chunk, errors, MAX_STDERR, true),
    );
    child.stdin.on("error", () => stop("worker_stdin_failed"));
    const abort = () => stop("worker_cancelled"),
      deadline = setTimeout(() => stop("worker_timeout"), config.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(deadline);
      if (killed) clearTimeout(killed);
      signal.removeEventListener("abort", abort);
    };
    child.on("error", () => {
      cleanup();
      reject(Error("local_segmentation_worker_start_failed"));
    });
    child.on("close", (exitCode) => {
      cleanup();
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(output),
        stderr: Buffer.concat(errors),
        code,
        stdoutTruncated: outTruncated,
        stderrTruncated: errTruncated,
      });
    });
    if (signal.aborted) abort();
    else child.stdin.end(input);
  });
}

async function context(db: DB, ctx: ToolContext, write: boolean) {
  if (!ctx.jobId) fail(409, "分割提案必须绑定当前正式任务");
  if (write && ctx.writable === false) fail(403, "当前上下文只允许读取");
  await checkJob(db, ctx);
  await requireCapability(db, ctx.actor.id, "ai.create");
  if (write) await requireCapability(db, ctx.actor.id, "assets.upload");
  const job = await db
    .selectFrom("ai_jobs as j")
    .innerJoin("ai_sessions as s", "s.id", "j.session_id")
    .select(["j.id", "j.session_id"])
    .where("j.id", "=", ctx.jobId)
    .where("j.user_id", "=", ctx.actor.id)
    .where("s.user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!job) fail(404, "分割来源不属于当前账号或会话");
  return job;
}
async function loadSource(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskSegmentInput,
  runtime: StorageRuntime,
) {
  let referenceImageId: string,
    source: Buffer,
    canvas: Buffer,
    raw: Binding["raw"] = null,
    generatedWindow: Binding["generatedWindow"];
  if (input.source.kind === "reference") {
    referenceImageId = input.source.referenceImageId;
    source = (
      await readReferenceImages(db, ctx, [referenceImageId], runtime)
    )[0]!.data;
    canvas = source;
    const metadata = await sharp(source, {
      limitInputPixels: MAX_PIXELS,
    }).metadata();
    generatedWindow = {
      left: 0,
      top: 0,
      width: metadata.autoOrient.width,
      height: metadata.autoOrient.height,
    };
  } else {
    const candidate = await readRawImageCandidate(
        db,
        ctx,
        input.source.generationOperationId,
        runtime,
      ),
      reference = candidate.candidate.references[0]!;
    if (!reference || !candidate.sources[0])
      fail(409, "原始候选缺少持久原页，不能补造分割来源");
    referenceImageId = reference.referenceImageId;
    source = candidate.sources[0].data;
    const transform = candidate.candidate.transform;
    if (
      transform.kind === "full" &&
      Math.abs(
        candidate.candidate.dimensions.width * reference.height -
          reference.width * candidate.candidate.dimensions.height,
      ) *
        100 >
        reference.width * candidate.candidate.dimensions.height
    )
      fail(409, "原始候选比例失真，不能拉伸分割修复");
    canvas = await rawImageCandidateCanvas(
      candidate.candidate,
      candidate.data,
      source,
    );
    generatedWindow =
      transform.kind === "viewport"
        ? transform.rect
        : { left: 0, top: 0, width: reference.width, height: reference.height };
    raw = {
      generationOperationId: input.source.generationOperationId,
      receiptId: candidate.receiptId,
      sha256: candidate.candidate.sha256,
      transform,
    };
  }
  const normalized = await sharp(canvas, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .png()
    .toBuffer({ resolveWithObject: true });
  const binding = bindingSchema.parse({
    referenceImageId,
    sourceSha256: sha(source),
    sourceSize: source.length,
    dimensions: {
      width: normalized.info.width,
      height: normalized.info.height,
    },
    workerInputSha256: sha(normalized.data),
    generatedWindow,
    raw,
  });
  for (const group of [input.targets, input.exclusions])
    for (const part of group) {
      const location = (p: [number, number]) =>
        [
          Math.min(
            Math.floor(p[0] * binding.dimensions.width),
            binding.dimensions.width - 1,
          ),
          Math.min(
            Math.floor(p[1] * binding.dimensions.height),
            binding.dimensions.height - 1,
          ),
        ].join();
      const positive = new Set(part.positivePoints.map(location));
      if (part.negativePoints.some((p) => positive.has(location(p))))
        fail(409, "提示点在原页像素坐标中冲突");
    }
  return { binding, normalized: normalized.data };
}
function parseJSON(bytes: Buffer | string): unknown {
  try {
    return JSON.parse(
      typeof bytes === "string"
        ? bytes
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    fail(422, "分割回执或工作器输出不是有效严格 JSON");
  }
}
async function binary(data: Buffer, dimensions: Binding["dimensions"]) {
  const metadata = await sharp(data, {
    limitInputPixels: MAX_PIXELS,
  }).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== dimensions.width ||
    metadata.height !== dimensions.height ||
    metadata.channels !== 1 ||
    metadata.hasAlpha ||
    metadata.isPalette ||
    (metadata.pages ?? 1) !== 1 ||
    (metadata.orientation ?? 1) !== 1 ||
    metadata.depth !== "uchar"
  )
    throw Error("invalid_binary_mask");
  const decoded = await sharp(data, {
    limitInputPixels: MAX_PIXELS,
    failOn: "warning",
  })
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  if (
    decoded.length !== dimensions.width * dimensions.height ||
    decoded.some((value) => value !== 0 && value !== 255)
  )
    throw Error("invalid_binary_mask");
  return decoded;
}
const png = (pixels: Buffer, dimensions: Binding["dimensions"]) =>
  sharp(pixels, { raw: { ...dimensions, channels: 1 } })
    .toColourspace("b-w")
    .png()
    .toBuffer();
function parseReport(result: SegmentationWorkerResult) {
  try {
    const value = parseJSON(result.stdout),
      success = workerReportSchema
        .safeExtend({ ok: z.literal(true) })
        .safeParse(value);
    if (success.success && result.exitCode === 0 && !result.code) {
      const { ok, ...report } = success.data;
      return { report: workerReportSchema.parse(report), failureCode: null };
    }
    const failed = z
      .object({
        ok: z.literal(false),
        version: z.literal(1),
        error: z
          .object({
            code: z.literal("point_constraints_unsatisfied"),
            message: z.string(),
            facts: workerReportSchema,
          })
          .strict(),
      })
      .strict()
      .safeParse(value);
    if (failed.success && result.exitCode === 2 && !result.code)
      return {
        report: failed.data.error.facts,
        failureCode: "point_constraints_unsatisfied",
      };
  } catch {
    /* Invalid output stays private failure evidence, never a usable proposal. */
  }
  return {
    report: undefined,
    failureCode: result.code ?? "worker_output_invalid",
  };
}
function reportMatches(
  report: WorkerReport,
  input: ImageMaskSegmentInput,
  binding: Binding,
  profile: VerifiedSegmentationProfile,
) {
  const engine = report.engine,
    facts = profile.facts,
    dims = binding.dimensions;
  if (
    engine.commit !== facts.engineCommit ||
    engine.checkpointVersion !== facts.checkpointVersion ||
    engine.checkpointSha256 !== facts.checkpointSha256 ||
    engine.config !== facts.config ||
    engine.configSha256 !== facts.configSha256 ||
    engine.torchVersion !== facts.dependencies.torch ||
    engine.pythonVersion !== facts.dependencies.python ||
    report.source.sha256 !== binding.workerInputSha256 ||
    report.source.width !== dims.width ||
    report.source.height !== dims.height ||
    report.source.originalWidth !== dims.width ||
    report.source.originalHeight !== dims.height ||
    ![null, 1].includes(report.source.exifOrientation)
  )
    return false;
  for (const group of ["targets", "exclusions"] as const) {
    if (input[group].length !== report.parts[group].length) return false;
    for (let i = 0; i < input[group].length; i++) {
      const hints = input[group][i]!,
        actual = report.parts[group][i]!;
      if (
        hints.label !== actual.label ||
        JSON.stringify(hints.box) !== JSON.stringify(actual.box)
      )
        return false;
      for (const field of ["positivePoints", "negativePoints"] as const) {
        if (hints[field].length !== actual.pointChecks[field].length)
          return false;
        for (let j = 0; j < hints[field].length; j++) {
          const p = hints[field][j]!,
            checked = actual.pointChecks[field][j]!;
          if (
            p.join() !== checked.point.join() ||
            checked.pixel.join() !==
              [
                Math.min(Math.floor(p[0] * dims.width), dims.width - 1),
                Math.min(Math.floor(p[1] * dims.height), dims.height - 1),
              ].join()
          )
            return false;
        }
      }
      if (
        actual.pointChecks.positiveMissing !==
          actual.pointChecks.positivePoints.filter((p) => !p.included).length ||
        actual.pointChecks.negativeIncluded !==
          actual.pointChecks.negativePoints.filter((p) => p.included).length ||
        actual.pointConstraintsSatisfied !==
          (!actual.pointChecks.positiveMissing &&
            !actual.pointChecks.negativeIncluded)
      )
        return false;
    }
  }
  return (
    report.pointConstraintsSatisfied ===
    (report.constraintFailures.length === 0 &&
      [...report.parts.targets, ...report.parts.exclusions].every(
        (part) => part.pointConstraintsSatisfied,
      ) &&
      report.conflicts.targetPositiveExcluded.length === 0)
  );
}
type OutputArtifact = {
  role: Artifact["role"];
  data: Buffer;
  mime: Artifact["mime"];
  validated: boolean;
};
async function collect(
  result: SegmentationWorkerResult,
  directory: string,
  input: ImageMaskSegmentInput,
  binding: Binding,
  profile: VerifiedSegmentationProfile,
) {
  const parsed = parseReport(result),
    artifacts: OutputArtifact[] = [
      {
        role: "stdout",
        data: result.stdout,
        mime: "text/plain",
        validated: false,
      },
      ...(result.stderr.length
        ? [
            {
              role: "stderr" as const,
              data: result.stderr,
              mime: "text/plain" as const,
              validated: false,
            },
          ]
        : []),
    ];
  let failureCode = parsed.failureCode,
    report = parsed.report,
    target: Buffer | undefined,
    exclusion: Buffer | undefined;
  if (report && !report.pointConstraintsSatisfied)
    failureCode ??= "point_constraints_unsatisfied";
  if (report && !reportMatches(report, input, binding, profile)) {
    report = undefined;
    failureCode = "worker_provenance_invalid";
  }
  let entries: string[] = [];
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("invalid_output_directory");
    entries = await readdir(directory);
  } catch {
    failureCode ??= "worker_artifacts_missing";
  }
  if (
    entries.some(
      (name) =>
        !["target-union.png", "exclusion-union.png", "result.json"].includes(
          name,
        ),
    )
  )
    failureCode = "worker_artifacts_invalid";
  for (const [role, name] of [
    ["target", "target-union.png"],
    ["exclusion", "exclusion-union.png"],
    ["result", "result.json"],
  ] as const) {
    if (!entries.includes(name)) {
      failureCode ??= "worker_artifacts_missing";
      continue;
    }
    const path = join(directory, name),
      info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > MAX_ARTIFACT
    ) {
      failureCode = "worker_artifacts_invalid";
      continue;
    }
    const data = await readFile(path);
    let validated = false;
    if (role === "result") {
      try {
        validated =
          !!report &&
          JSON.stringify(workerReportSchema.parse(parseJSON(data))) ===
            JSON.stringify(report);
      } catch {
        /* Keep invalid bytes private. */
      }
    } else {
      try {
        const pixels = await binary(data, binding.dimensions),
          metadata = report?.artifacts[role];
        validated =
          !!metadata &&
          metadata.path === path &&
          metadata.sha256 === sha(data) &&
          metadata.width === binding.dimensions.width &&
          metadata.height === binding.dimensions.height;
        if (validated) {
          if (role === "target") target = pixels;
          else exclusion = pixels;
        }
      } catch {
        /* Keep invalid bytes private, never resize or threshold them. */
      }
    }
    if (!validated) failureCode = "worker_artifacts_invalid";
    artifacts.push({
      role,
      data,
      mime: validated
        ? role === "result"
          ? "application/json"
          : "image/png"
        : "application/octet-stream",
      validated,
    });
  }
  let targetPixels = 0,
    exclusionPixels = 0,
    selectionPixels = 0,
    outside = 0,
    selection: Buffer | undefined;
  if (target && exclusion) {
    selection = Buffer.alloc(target.length);
    const window = binding.generatedWindow;
    for (let i = 0; i < target.length; i++) {
      if (target[i] === 255) targetPixels++;
      if (exclusion[i] === 255) exclusionPixels++;
      if (target[i] === 255 && exclusion[i] === 0) {
        selection[i] = 255;
        selectionPixels++;
        const x = i % binding.dimensions.width,
          y = Math.floor(i / binding.dimensions.width);
        if (
          x < window.left ||
          x >= window.left + window.width ||
          y < window.top ||
          y >= window.top + window.height
        )
          outside++;
      }
    }
    if (
      report &&
      (report.counts.targetPixels !== targetPixels ||
        report.counts.exclusionPixels !== exclusionPixels ||
        report.counts.editablePixelsAfterExclusion !== selectionPixels ||
        report.conflicts.overlapPixels !== targetPixels - selectionPixels)
    )
      failureCode = "worker_pixel_counts_invalid";
    const index = (p: [number, number]) =>
      Math.min(
        Math.floor(p[1] * binding.dimensions.height),
        binding.dimensions.height - 1,
      ) *
        binding.dimensions.width +
      Math.min(
        Math.floor(p[0] * binding.dimensions.width),
        binding.dimensions.width - 1,
      );
    if (
      input.targets.some((part) =>
        part.positivePoints.some((p) => selection![index(p)] !== 255),
      ) ||
      input.exclusions.some((part) =>
        part.positivePoints.some((p) => exclusion![index(p)] !== 255),
      )
    )
      failureCode ??= "point_constraints_unsatisfied";
    if (outside) failureCode ??= "image_mask_viewport_bounds";
    if (!selectionPixels) failureCode ??= "empty_selection";
    artifacts.push({
      role: "selection",
      data: await png(selection, binding.dimensions),
      mime: "image/png",
      validated: true,
    });
  }
  const usable =
    !failureCode && !!report?.pointConstraintsSatisfied && !!selectionPixels;
  return {
    artifacts,
    usable,
    selectionSha256: artifacts.find((artifact) => artifact.role === "selection")
      ? sha(artifacts.find((artifact) => artifact.role === "selection")!.data)
      : null,
    diagnostics: diagnosticsSchema.parse({
      semanticCoverage: "unverified",
      pointConstraintsSatisfied: !!report?.pointConstraintsSatisfied,
      failureCode,
      targetPixels,
      exclusionPixels,
      selectionPixels,
      outsideGeneratedWindowPixels: outside,
      constraintFailures: report?.constraintFailures ?? [],
      exitCode: result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    }),
  };
}

export async function prepareImageMaskSegment(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskSegmentInput,
  operationId: string,
  options: Options = {},
): Promise<ImageMaskSegmentReceipt> {
  return publicBoundary(options.signal, () =>
    prepareImageMaskSegmentInternal(db, ctx, input, operationId, options),
  );
}
async function prepareImageMaskSegmentInternal(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskSegmentInput,
  operationId: string,
  options: Options,
): Promise<ImageMaskSegmentReceipt> {
  input = imageMaskSegmentInputSchema.parse(input);
  z.string().uuid().parse(operationId);
  options.signal?.throwIfAborted();
  if (!options.profile)
    fail(503, "可信本地分割未启用或不可用", {
      code: "local_segmentation_unavailable",
    });
  if (activeWorker)
    fail(503, "本地分割工作器正在运行，请顺序处理", {
      code: "local_segmentation_busy",
    });
  activeWorker = true;
  let temporary: string | undefined;
  const profile = options.profile,
    runtime = options.storage ?? storageRuntime(),
    store = createStorage(runtime);
  const staged: {
    pointer: Artifact;
    config: ReturnType<typeof storageConfigForProfile>;
  }[] = [];
  let identity: string | undefined;
  let reserved = false;
  try {
    await verifySegmentationProfileFiles(profile);
    const scope = await context(db, ctx, true),
      loaded = await loadSource(db, ctx, input, runtime),
      binding = loaded.binding;
    identity = sha(JSON.stringify({ input, binding, engine: profile.facts }));
    const authorize = async (tx: DB, bytes: number) => {
      options.signal?.throwIfAborted();
      const current = await context(tx, ctx, true);
      if (
        current.session_id !== scope.session_id ||
        JSON.stringify((await loadSource(tx, ctx, input, runtime)).binding) !==
          JSON.stringify(binding)
      )
        fail(409, "分割来源或映射已改变");
      if (bytes) await checkStorage(tx, ctx.actor.id, bytes);
    };
    const existing = await transact(db, async (tx) => {
      await lockAIUser(tx, ctx.actor.id);
      await authorize(tx, 0);
      const old = await tx
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", operationId)
        .executeTakeFirst();
      if (old) {
        if (old.user_id !== ctx.actor.id || old.digest !== identity)
          fail(409, "分割操作标识冲突");
        const parsed = imageMaskSegmentReceiptSchema.safeParse(
          parseJSON(old.result),
        );
        if (!parsed.success) fail(409, "此前分割状态未确认，不会重跑或覆盖");
        return parsed.data;
      }
      await tx
        .insertInto("ai_operations")
        .values({
          id: operationId,
          user_id: ctx.actor.id,
          job_id: ctx.jobId!,
          digest: identity!,
          created_at: new Date().toISOString(),
          result: JSON.stringify({
            kind: "image_mask_segment",
            version: 1,
            state: "running",
            receiptId: operationId,
            scope: { preparedJobId: scope.id, sessionId: scope.session_id },
            input,
            binding,
            engine: profile.facts,
          }),
        })
        .execute();
      return null;
    });
    if (existing)
      return (
        await readImageMaskSegment(db, ctx, operationId, {
          storage: runtime,
          signal: options.signal,
        })
      ).receipt;
    reserved = true;
    temporary = await mkdtemp(join(tmpdir(), "doca-image-segment-"));
    // Resolve the host-created directory before deriving any worker paths.
    // Python resolves /var to /private/var on macOS; artifact paths must still
    // match exactly, without normalizing untrusted worker-returned paths.
    temporary = await realpath(temporary);
    const sourcePath = join(temporary, "input.png"),
      outputDir = join(temporary, "output");
    await writeFile(sourcePath, loaded.normalized, { mode: 0o600, flag: "wx" });
    const controller = new AbortController(),
      signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
    let checking = false;
    const watch = setInterval(() => {
      if (checking || signal.aborted) return;
      checking = true;
      context(db, ctx, true)
        .catch(() =>
          controller.abort(
            new DOMException("本地分割任务授权已撤回", "AbortError"),
          ),
        )
        .finally(() => {
          checking = false;
        });
    }, 250);
    let worker: SegmentationWorkerResult;
    try {
      worker = await (options.worker ?? runSegmentationWorker)(
        profile,
        {
          version: 1,
          sourcePath,
          outputDir,
          targets: input.targets,
          exclusions: input.exclusions,
        },
        signal,
      );
      signal.throwIfAborted();
    } finally {
      clearInterval(watch);
    }
    if (worker.stdout.length > MAX_STDOUT || worker.stderr.length > MAX_STDERR)
      fail(413, "本地分割工作器输出超过限制");
    await verifySegmentationProfileFiles(profile);
    const collected = await collect(worker, outputDir, input, binding, profile),
      storageProfile = await db
        .selectFrom("storage_profiles")
        .selectAll()
        .where("active", "=", 1)
        .executeTakeFirstOrThrow(),
      config = storageConfigForProfile(runtime, storageProfile);
    const artifacts = collected.artifacts.map((value) => {
      const assetId = randomUUID();
      return {
        ...value,
        pointer: artifactSchema.parse({
          role: value.role,
          assetId,
          profileId: storageProfile.id,
          objectKey: objectKey(assetId, value.mime),
          sha256: sha(value.data),
          size: value.data.length,
          mime: value.mime,
          validated: value.validated,
        }),
      };
    });
    const base = receiptBase.parse({
      kind: "image_mask_segment",
      version: 1,
      state: collected.usable ? "ready" : "diagnostic-only",
      usable: collected.usable,
      receiptId: operationId,
      scope: { preparedJobId: scope.id, sessionId: scope.session_id },
      input,
      binding,
      engine: profile.facts,
      artifacts: artifacts.map((value) => value.pointer),
      selectionSha256: collected.selectionSha256,
      diagnostics: collected.diagnostics,
      instruction,
    });
    const receipt = imageMaskSegmentReceiptSchema.parse({
        ...base,
        digest: receiptDigest(base),
      }),
      totalBytes = artifacts.reduce((sum, value) => sum + value.data.length, 0);
    await transact(db, async (tx) => {
      await lockAIUser(tx, ctx.actor.id);
      await authorize(tx, totalBytes);
      const old = await tx
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", operationId)
        .where("user_id", "=", ctx.actor.id)
        .where("digest", "=", identity!)
        .executeTakeFirstOrThrow();
      if (JSON.parse(old.result).state !== "running")
        fail(409, "分割状态已改变");
      const changed = await tx
        .updateTable("ai_operations")
        .set({
          result: JSON.stringify({
            ...JSON.parse(old.result),
            state: "storing",
            plannedArtifacts: receipt.artifacts,
          }),
        })
        .where("id", "=", operationId)
        .where("result", "=", old.result)
        .executeTakeFirst();
      if (changed.numUpdatedRows !== 1n) fail(409, "分割状态已改变");
    });
    for (const artifact of artifacts) {
      options.signal?.throwIfAborted();
      staged.push({ pointer: artifact.pointer, config });
      await store.put(
        config,
        artifact.pointer.objectKey,
        artifact.data,
        artifact.pointer.mime,
        `segment-${artifact.pointer.role}`,
      );
    }
    await transact(db, async (tx) => {
      await lockAIUser(tx, ctx.actor.id);
      await authorize(tx, totalBytes);
      const old = await tx
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", operationId)
        .where("user_id", "=", ctx.actor.id)
        .where("digest", "=", identity!)
        .executeTakeFirstOrThrow();
      if (JSON.parse(old.result).state !== "storing")
        fail(409, "分割状态已改变");
      const now = new Date().toISOString();
      for (const artifact of artifacts) {
        const pointer = artifact.pointer;
        const asset: Schema["assets"] = {
          id: pointer.assetId,
          owner_id: ctx.actor.id,
          uploaded_by: ctx.actor.id,
          resource_id: null,
          purpose: "ai_mask_segment",
          profile_id: pointer.profileId,
          object_key: pointer.objectKey,
          filename: `segment-${pointer.role}`,
          mime: pointer.mime,
          size: pointer.size,
          created_at: now,
          deleted_at: null,
        };
        await tx.insertInto("assets").values(asset).execute();
        await registerStoredObject(tx, {
          id: pointer.assetId,
          profile_id: pointer.profileId,
          object_key: pointer.objectKey,
          sha256: pointer.sha256,
          size: pointer.size,
          mime: pointer.mime,
          ai_description: "本地分割提案/私有诊断，非交付图片或AI参考图",
          ai_status: "skipped",
          ai_model: null,
          ai_generated_at: now,
          created_at: now,
        });
      }
      const changed = await tx
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(receipt) })
        .where("id", "=", operationId)
        .where("result", "=", old.result)
        .executeTakeFirst();
      if (changed.numUpdatedRows !== 1n) fail(409, "分割状态已改变");
      await context(tx, ctx, true);
      options.signal?.throwIfAborted();
    });
    return receipt;
  } catch (error) {
    if (identity && reserved) {
      const old = await db
        .selectFrom("ai_operations")
        .select(["result", "digest"])
        .where("id", "=", operationId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirst()
        .catch(() => undefined);
      if (old && old.digest === identity) {
        const parsed = imageMaskSegmentReceiptSchema.safeParse(
          parseJSON(old.result),
        );
        if (parsed.success) return parsed.data;
        const state = JSON.parse(old.result).state;
        if (state === "running" || state === "storing") {
          const failedResult = JSON.stringify({
            ...JSON.parse(old.result),
            state: "failed",
            failureCode: options.signal?.aborted
              ? "worker_cancelled"
              : "local_segmentation_failed",
            cleanup: staged.length ? "pending" : "not-written",
          });
          const updated = await db
            .updateTable("ai_operations")
            .set({ result: failedResult })
            .where("id", "=", operationId)
            .where("result", "=", old.result)
            .executeTakeFirst()
            .catch(() => undefined);
          if (updated?.numUpdatedRows === 1n) {
            const removed = await Promise.allSettled(
              staged.map((value) =>
                store.remove(value.config, value.pointer.objectKey),
              ),
            );
            await db
              .updateTable("ai_operations")
              .set({
                result: JSON.stringify({
                  ...JSON.parse(old.result),
                  state: "failed",
                  failureCode: options.signal?.aborted
                    ? "worker_cancelled"
                    : "local_segmentation_failed",
                  cleanup: removed.every(
                    (value) => value.status === "fulfilled",
                  )
                    ? "removed"
                    : "uncertain",
                }),
              })
              .where("id", "=", operationId)
              .where("user_id", "=", ctx.actor.id)
              .where("digest", "=", identity)
              .where("result", "=", failedResult)
              .execute()
              .catch(() => undefined);
          }
        }
      }
    }
    throw error;
  } finally {
    activeWorker = false;
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function readImageMaskSegment(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Pick<Options, "storage" | "signal"> = {},
) {
  return publicBoundary(options.signal, () =>
    readImageMaskSegmentInternal(db, ctx, receiptId, options),
  );
}
async function readImageMaskSegmentInternal(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Pick<Options, "storage" | "signal">,
) {
  z.string().uuid().parse(receiptId);
  options.signal?.throwIfAborted();
  const current = await context(db, ctx, false),
    runtime = options.storage ?? storageRuntime();
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", receiptId)
    .where("user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  const parsed = imageMaskSegmentReceiptSchema.safeParse(
    row ? parseJSON(row.result) : undefined,
  );
  if (!parsed.success)
    fail(422, "没有严格 version:1 分割提案回执，不能转换、补造或重跑");
  const receipt = parsed.data,
    { digest, ...base } = receipt;
  if (
    receipt.receiptId !== receiptId ||
    row!.job_id !== receipt.scope.preparedJobId ||
    receipt.scope.sessionId !== current.session_id ||
    receiptDigest(base) !== digest ||
    row!.digest !==
      sha(
        JSON.stringify({
          input: receipt.input,
          binding: receipt.binding,
          engine: receipt.engine,
        }),
      )
  )
    fail(409, "分割提案摘要或会话绑定不一致");
  const original = await db
    .selectFrom("ai_jobs")
    .select("id")
    .where("id", "=", receipt.scope.preparedJobId)
    .where("user_id", "=", ctx.actor.id)
    .where("session_id", "=", current.session_id)
    .executeTakeFirst();
  if (!original) fail(404, "分割提案原任务已不可用");
  const source = await loadSource(db, ctx, receipt.input, runtime);
  if (JSON.stringify(source.binding) !== JSON.stringify(receipt.binding))
    fail(409, "分割提案原页、候选或映射已改变");
  const store = createStorage(runtime),
    artifacts = new Map<Artifact["role"], Buffer>();
  for (const pointer of receipt.artifacts) {
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", pointer.assetId)
      .where("owner_id", "=", ctx.actor.id)
      .where("purpose", "=", "ai_mask_segment")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (
      !asset ||
      asset.profile_id !== pointer.profileId ||
      asset.object_key !== pointer.objectKey ||
      asset.mime !== pointer.mime ||
      asset.size !== pointer.size
    )
      fail(404, "私有分割证据已不可用");
    const object = await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", pointer.assetId)
      .executeTakeFirst();
    if (
      !object ||
      object.profile_id !== pointer.profileId ||
      object.object_key !== pointer.objectKey ||
      object.sha256 !== pointer.sha256 ||
      object.size !== pointer.size ||
      object.mime !== pointer.mime
    )
      fail(409, "分割存储对象事实与回执不一致");
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("id", "=", pointer.profileId)
      .executeTakeFirstOrThrow();
    const data = await store.read(
      storageConfigForProfile(runtime, profile),
      pointer.objectKey,
      pointer.size,
    );
    if (data.length !== pointer.size || sha(data) !== pointer.sha256)
      fail(409, "分割蒙版或证据内容已改变");
    if (pointer.validated && pointer.mime === "image/png")
      await binary(data, receipt.binding.dimensions);
    artifacts.set(pointer.role, data);
  }
  const selectionPNG = artifacts.get("selection");
  if (
    receipt.usable &&
    (!selectionPNG || sha(selectionPNG) !== receipt.selectionSha256)
  )
    fail(409, "分割提案缺少精确二值蒙版");
  options.signal?.throwIfAborted();
  if (
    JSON.stringify(
      (await loadSource(db, ctx, receipt.input, runtime)).binding,
    ) !== JSON.stringify(receipt.binding)
  )
    fail(409, "分割来源读取期间已改变");
  return { receipt, sourceCanvas: source.normalized, selectionPNG, artifacts };
}

/** The compose/prepare consumer must use this guard; diagnostics never become selection input. */
export async function readUsableImageMaskSegment(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Pick<Options, "storage" | "signal"> = {},
) {
  return publicBoundary(options.signal, () =>
    readUsableImageMaskSegmentInternal(db, ctx, receiptId, options),
  );
}
async function readUsableImageMaskSegmentInternal(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Pick<Options, "storage" | "signal">,
) {
  const result = await readImageMaskSegment(db, ctx, receiptId, options);
  if (
    !result.receipt.usable ||
    result.receipt.state !== "ready" ||
    !result.selectionPNG
  )
    fail(
      409,
      "分割提案未满足严格运行和点约束，仅可诊断，不能用于准备或合成蒙版",
    );
  return { ...result, selectionPNG: result.selectionPNG };
}

export async function previewImageMaskSegment(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Pick<Options, "storage" | "signal"> = {},
) {
  return publicBoundary(options.signal, () =>
    previewImageMaskSegmentInternal(db, ctx, receiptId, options),
  );
}
async function previewImageMaskSegmentInternal(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Pick<Options, "storage" | "signal">,
) {
  const result = await readImageMaskSegment(db, ctx, receiptId, options),
    dimensions = result.receipt.binding.dimensions;
  const base = await sharp(result.sourceCanvas).ensureAlpha().raw().toBuffer(),
    selection = result.selectionPNG
      ? await binary(result.selectionPNG, dimensions)
      : Buffer.alloc(dimensions.width * dimensions.height),
    exclusionData = result.artifacts.get("exclusion"),
    exclusion =
      exclusionData &&
      result.receipt.artifacts.some(
        (a) => a.role === "exclusion" && a.validated,
      )
        ? await binary(exclusionData, dimensions)
        : Buffer.alloc(selection.length);
  let left = dimensions.width,
    top = dimensions.height,
    right = -1,
    bottom = -1;
  for (let i = 0; i < selection.length; i++) {
    if (selection[i] === 255 || exclusion[i] === 255) {
      const x = i % dimensions.width,
        y = Math.floor(i / dimensions.width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      const color = selection[i] === 255 ? [20, 220, 80] : [240, 60, 50];
      for (let c = 0; c < 3; c++)
        base[i * 4 + c] = Math.round(
          base[i * 4 + c]! * 0.55 + color[c]! * 0.45,
        );
    }
  }
  const fullRect = { left: 0, top: 0, ...dimensions },
    padding = 24,
    localRect =
      right < 0
        ? fullRect
        : {
            left: Math.max(0, left - padding),
            top: Math.max(0, top - padding),
            width:
              Math.min(dimensions.width, right + 1 + padding) -
              Math.max(0, left - padding),
            height:
              Math.min(dimensions.height, bottom + 1 + padding) -
              Math.max(0, top - padding),
          };
  const overlay = await sharp(base, { raw: { ...dimensions, channels: 4 } })
    .png()
    .toBuffer();
  const frame = async (sourceRect: typeof fullRect, view: string) => {
    const cropped = await sharp(overlay)
      .extract(sourceRect)
      .resize({
        width: 1600,
        height: 1520,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    const width = Math.max(400, cropped.info.width),
      height = cropped.info.height + 80;
    const legend = Buffer.from(
      `<svg width="${width}" height="80" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${result.receipt.usable ? "#eef6ef" : "#ffe5e5"}"/><text x="12" y="24" font-family="sans-serif" font-size="17">${result.receipt.usable ? "SEGMENT PROPOSAL — NOT ACCEPTED" : "DIAGNOSTIC ONLY — DO NOT COMPOSE"}</text><text x="12" y="52" font-family="sans-serif" font-size="15">Green: selection; red: excluded. Semantic coverage unverified.</text></svg>`,
    );
    const data = await sharp({
      create: { width, height, channels: 4, background: "#ffffff" },
    })
      .composite([
        { input: legend, left: 0, top: 0 },
        { input: cropped.data, left: 0, top: 80 },
      ])
      .png()
      .toBuffer();
    return {
      view,
      sourceRect,
      contentRect: {
        left: 0,
        top: 80,
        width: cropped.info.width,
        height: cropped.info.height,
      },
      width,
      height,
      mime: "image/png" as const,
      data,
    };
  };
  const [full, local] = await Promise.all([
    frame(fullRect, "完整原页分割诊断"),
    frame(localRect, "局部边缘分割诊断"),
  ]);
  await readImageMaskSegment(db, ctx, receiptId, options);
  return { receipt: result.receipt, full, local };
}
