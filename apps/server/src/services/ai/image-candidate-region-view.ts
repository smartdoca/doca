import sharp from "sharp";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { AppError, fail } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import { rawImageCandidateCanvas } from "./image-candidates.js";
import {
  imageCandidateViewOutputSchema,
  loadImageCandidateFacts,
} from "./image-candidate-view.js";
import {
  imageMaskRegionNativeRect,
  imageMaskRegionViewInputSchema,
} from "./image-mask-region-view.js";

export const imageCandidateRegionViewInputSchema = z
  .object({
    generationOperationId: z.string().uuid(),
    region: imageMaskRegionViewInputSchema.shape.region,
    points: imageMaskRegionViewInputSchema.shape.points,
  })
  .strict();
export type ImageCandidateRegionViewInput = z.infer<
  typeof imageCandidateRegionViewInputSchema
>;
const nativeRect = imageCandidateViewOutputSchema.shape.generatedWindow;
const byte = z.number().int().min(0).max(255);
const rgba = z.tuple([byte, byte, byte, byte]);
const count = z.number().int().nonnegative();
const instruction =
  "这是持久原始候选的小框只读像素诊断，不是交付、候选完整查看、分割提案、蒙版或轮廓许可，也不授权P/O遮挡。region和points均属于完整原页归一化坐标，不能使用厂商raw工作空间坐标。框按左上floor、右下ceil转原尺寸像素，每边最多1024且不超过100万像素，不缩图、不裁超限；点按floor采样，坐标1表示最后一列/行，每点须在框内。两帧是同一nativeRect的原图和raw原页坐标投影，保持原尺寸无损PNG，RGBA是显示方向8位像素。生成窗口外的raw投影来自原稿，没有生成像素。先完整接收image_candidate_view三帧，在后续模型轮次才使用此工具；小框不能替代任何完整视觉证明或语义验收。选择SAM正负点应对照这两张同坐标图及真实点RGBA，不因raw原生尺寸恰好等于原页尺寸而混用坐标。";
export const imageCandidateRegionViewOutputSchema = z
  .object({
    kind: z.literal("image_candidate_region_view"),
    state: z.literal("diagnostic-only"),
    readonly: z.literal(true),
    generationOperationId: z.string().uuid(),
    referenceImageId: z.string().uuid(),
    source: imageCandidateViewOutputSchema.shape.source,
    raw: imageCandidateViewOutputSchema.shape.raw,
    transform: imageCandidateViewOutputSchema.shape.transform,
    generatedWindow: nativeRect,
    region: imageCandidateRegionViewInputSchema.shape.region,
    nativeRect,
    coverage: z
      .object({
        generatedPixels: count,
        ungeneratedPixels: count,
        totalPixels: count,
      })
      .strict(),
    points: z
      .array(
        z
          .object({
            point: z.tuple([
              z.number().finite().min(0).max(1),
              z.number().finite().min(0).max(1),
            ]),
            pixel: z.object({ x: count, y: count }).strict(),
            sourceRGBA: rgba,
            rawRGBA: rgba,
            generated: z.boolean(),
            rawOrigin: z.enum([
              "generated-candidate",
              "source-outside-generation-window",
            ]),
          })
          .strict(),
      )
      .max(16),
    instruction: z.literal(instruction),
  })
  .strict();
export type ImageCandidateRegionViewOutput = z.infer<
  typeof imageCandidateRegionViewOutputSchema
>;
type Options = {
  vision: boolean;
  storage?: StorageRuntime;
  signal?: AbortSignal;
};
type Rect = z.infer<typeof nativeRect>;
function inside(point: { x: number; y: number }, rect: Rect) {
  return (
    point.x >= rect.left &&
    point.x < rect.left + rect.width &&
    point.y >= rect.top &&
    point.y < rect.top + rect.height
  );
}
async function crop(data: Buffer, rect: Rect) {
  const result = await sharp(data, {
    limitInputPixels: 25_000_000,
    failOn: "warning",
  })
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .extract(rect)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    result.info.width !== rect.width ||
    result.info.height !== rect.height ||
    result.info.channels !== 4
  )
    fail(422, "候选小框解码尺寸或RGBA通道与原页坐标不一致", {
      code: "image_reference_decode",
    });
  return result.data;
}
async function boundary<T>(options: Options, run: () => Promise<T>) {
  try {
    options.signal?.throwIfAborted();
    return await run();
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw new DOMException("候选小框查看已取消或授权已撤回", "AbortError");
    if (error instanceof AppError || error instanceof z.ZodError) throw error;
    fail(503, "图片诊断来源暂不可读取，请查询当前附件和候选；原记录保留", {
      code: "image_raw_unavailable",
    });
  }
}
async function load(
  db: DB,
  ctx: ToolContext,
  value: ImageCandidateRegionViewInput,
  options: Options,
) {
  const input = imageCandidateRegionViewInputSchema.parse(value);
  const candidate = await loadImageCandidateFacts(
    db,
    ctx,
    input.generationOperationId,
    options,
  );
  const { width, height } = candidate.facts.source;
  const rect = imageMaskRegionNativeRect(input.region, width, height);
  const points = input.points.map(([x, y]) => ({
    x: Math.min(width - 1, Math.floor(x * width)),
    y: Math.min(height - 1, Math.floor(y * height)),
  }));
  if (points.some((point) => !inside(point, rect)))
    fail(400, "核验点必须位于明确查看的小框内", {
      code: "image_candidate_region_invalid",
    });
  const projected = await rawImageCandidateCanvas(
    candidate.raw.candidate,
    candidate.raw.data,
    candidate.raw.sources[0]!.data,
  );
  const [source, raw] = await Promise.all([
    crop(candidate.raw.sources[0]!.data, rect),
    crop(projected, rect),
  ]);
  options.signal?.throwIfAborted();
  const pixelRGBA = (data: Buffer, point: { x: number; y: number }) => {
    const offset =
      ((point.y - rect.top) * rect.width + point.x - rect.left) * 4;
    return [...data.subarray(offset, offset + 4)];
  };
  const window = candidate.facts.generatedWindow;
  const intersectionWidth = Math.max(
    0,
    Math.min(rect.left + rect.width, window.left + window.width) -
      Math.max(rect.left, window.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(rect.top + rect.height, window.top + window.height) -
      Math.max(rect.top, window.top),
  );
  const generatedPixels = intersectionWidth * intersectionHeight,
    totalPixels = rect.width * rect.height;
  const facts = imageCandidateRegionViewOutputSchema.parse({
    kind: "image_candidate_region_view",
    state: "diagnostic-only",
    readonly: true,
    generationOperationId: input.generationOperationId,
    referenceImageId: candidate.facts.referenceImageId,
    source: candidate.facts.source,
    raw: candidate.facts.raw,
    transform: candidate.facts.transform,
    generatedWindow: window,
    region: input.region,
    nativeRect: rect,
    coverage: {
      generatedPixels,
      ungeneratedPixels: totalPixels - generatedPixels,
      totalPixels,
    },
    points: points.map((point, index) => ({
      point: input.points[index],
      pixel: point,
      sourceRGBA: pixelRGBA(source, point),
      rawRGBA: pixelRGBA(raw, point),
      generated: inside(point, window),
      rawOrigin: inside(point, window)
        ? "generated-candidate"
        : "source-outside-generation-window",
    })),
    instruction,
  });
  return { candidate, facts, source, raw, rect };
}
type Loaded = Awaited<ReturnType<typeof load>>;
async function recheck(
  db: DB,
  ctx: ToolContext,
  loaded: Loaded,
  options: Options,
) {
  options.signal?.throwIfAborted();
  const current = await loadImageCandidateFacts(
    db,
    ctx,
    loaded.facts.generationOperationId,
    options,
  );
  if (
    JSON.stringify(current.raw.candidate) !==
    JSON.stringify(loaded.candidate.raw.candidate)
  )
    fail(409, "候选小框来源、原始回执或坐标映射已改变，请重新查看", {
      code: "image_reference_changed",
    });
  options.signal?.throwIfAborted();
}
/** Transient facts only: no receipt, asset, model usage or inspection permission is saved. */
export async function viewImageCandidateRegion(
  db: DB,
  ctx: ToolContext,
  input: ImageCandidateRegionViewInput,
  options: Options,
) {
  return boundary(options, async () => {
    const loaded = await load(db, ctx, input, options);
    await recheck(db, ctx, loaded, options);
    return loaded.facts;
  });
}
/** Two lossless native crops from the same bound source coordinate rectangle. */
export async function imageCandidateRegionViewModelOutput(
  db: DB,
  ctx: ToolContext,
  input: ImageCandidateRegionViewInput,
  expected: ImageCandidateRegionViewOutput,
  options: Options,
) {
  return boundary(options, async () => {
    const facts = imageCandidateRegionViewOutputSchema.parse(expected);
    const loaded = await load(db, ctx, input, options);
    if (JSON.stringify(loaded.facts) !== JSON.stringify(facts))
      fail(409, "候选小框绑定、范围或像素事实已改变，请重新查看", {
        code: "image_reference_changed",
      });
    const frames = await Promise.all(
      (
        [
          ["source-region", loaded.source],
          ["source-projection-region", loaded.raw],
        ] as const
      ).map(async ([view, pixels]) => ({
        view,
        data: await sharp(pixels, {
          raw: {
            width: loaded.rect.width,
            height: loaded.rect.height,
            channels: 4,
          },
        })
          .png()
          .toBuffer(),
      })),
    );
    await recheck(db, ctx, loaded, options);
    return {
      type: "content" as const,
      value: [
        { type: "text" as const, text: JSON.stringify(facts) },
        ...frames.flatMap((frame) => [
          {
            type: "text" as const,
            text: JSON.stringify({
              label:
                frame.view === "source-region"
                  ? "原页原生小框，采样点属于完整原页坐标。"
                  : "raw同原页坐标原生小框；生成窗口外仍是原稿。",
              view: frame.view,
              coordinateSpace: "source",
              referenceImageId: facts.referenceImageId,
              generationOperationId: facts.generationOperationId,
              sourceRect: loaded.rect,
              contentRect: {
                left: 0,
                top: 0,
                width: loaded.rect.width,
                height: loaded.rect.height,
              },
              sourceSize: {
                width: facts.source.width,
                height: facts.source.height,
              },
              displaySize: {
                width: loaded.rect.width,
                height: loaded.rect.height,
              },
              generatedWindow: facts.generatedWindow,
            }),
          },
          {
            type: "media" as const,
            mediaType: "image/png",
            data: frame.data.toString("base64"),
          },
        ]),
      ],
    };
  });
}
