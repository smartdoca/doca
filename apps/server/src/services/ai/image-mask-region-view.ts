import sharp from "sharp";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { AppError, fail } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import {
  imageEditMaskReceiptSchema,
  readImageEditMask,
} from "./image-edit-mask.js";

export const IMAGE_MASK_REGION_MAX_EDGE = 1024;
export const IMAGE_MASK_REGION_MAX_PIXELS = 1_000_000;
const fraction = z.number().finite().min(0).max(1);
const normalizedRegion = z
  .object({
    left: fraction,
    top: fraction,
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .refine(
    (value) => value.left + value.width <= 1 && value.top + value.height <= 1,
    {
      message: "查看框必须完整位于原页，不裁切越界部分",
    },
  );
export const imageMaskRegionViewInputSchema = z
  .object({
    maskReceiptId: z.string().uuid(),
    region: normalizedRegion,
    points: z.array(z.tuple([fraction, fraction])).max(16),
  })
  .strict();
export type ImageMaskRegionViewInput = z.infer<
  typeof imageMaskRegionViewInputSchema
>;
const nativeRect = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const pixel = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();
const byte = z.number().int().min(0).max(255);
const rgba = z.tuple([byte, byte, byte, byte]);
const binary = z.union([z.literal(0), z.literal(255)]);
const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instruction =
  "这是已绑定v2蒙版的小框只读像素诊断，不是完整蒙版查看许可、人物覆盖验收或遮挡授权。region和points均属于完整原页归一化坐标；框按左上floor、右下ceil转原尺寸像素，不缩小、不重采样。点按floor采样，坐标1明确表示最后一列/行；每点必须在实际框内。三帧是同一nativeRect的原图、raw原页坐标投影和覆盖诊断，保持原尺寸无损PNG；RGBA为旋转到原页显示方向后的8位像素。生成窗口外的raw投影来自原稿，未经生成，不能视为新背景或新人物。SGPOT与union仅是精确二值事实，零冲突和P/O归属不证明语义正确或用户已允许遮挡；小框不能替代完整/局部两帧及其后轮合成门禁。";
export const imageMaskRegionViewOutputSchema = z
  .object({
    kind: z.literal("image_mask_region_view"),
    state: z.literal("diagnostic-only"),
    readonly: z.literal(true),
    maskReceiptId: z.string().uuid(),
    digest: hash,
    maskDigest: hash,
    protectionDigest: hash.nullable(),
    referenceImageId: z.string().uuid(),
    generationOperationId: z.string().uuid(),
    source: imageEditMaskReceiptSchema.shape.source.omit({
      referenceImageId: true,
    }),
    raw: imageEditMaskReceiptSchema.shape.raw,
    transform: imageEditMaskReceiptSchema.shape.transform,
    generatedWindow: nativeRect,
    region: normalizedRegion,
    nativeRect,
    coverage: z
      .object({
        sourceTargetPixels: count,
        generatedTargetPixels: count,
        protectionPixels: count,
        allowedOcclusionPixels: count,
        textPixels: count,
        selectedPixels: count,
        remainingProtectionPixels: count,
        conflictPixels: count,
        generatedPixels: count,
        ungeneratedPixels: count,
        totalPixels: count,
      })
      .strict(),
    points: z
      .array(
        z
          .object({
            point: z.tuple([fraction, fraction]),
            pixel,
            sourceRGBA: rgba,
            rawRGBA: rgba,
            generated: z.boolean(),
            rawOrigin: z.enum([
              "generated-candidate",
              "source-outside-generation-window",
            ]),
            S: binary,
            G: binary,
            P: binary,
            O: binary,
            T: binary,
            selected: binary,
            remainingProtection: binary,
            conflict: binary,
          })
          .strict(),
      )
      .max(16),
    instruction: z.literal(instruction),
  })
  .strict();
export type ImageMaskRegionViewOutput = z.infer<
  typeof imageMaskRegionViewOutputSchema
>;
type Options = {
  vision: boolean;
  storage?: StorageRuntime;
  signal?: AbortSignal;
};
type ReadMask = Awaited<ReturnType<typeof readImageEditMask>>;
type Rect = z.infer<typeof nativeRect>;

/** Native covering rectangle; oversize requests are rejected, never fitted. */
export function imageMaskRegionNativeRect(
  region: ImageMaskRegionViewInput["region"],
  width: number,
  height: number,
): Rect {
  const value = normalizedRegion.parse(region);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    fail(422, "原图尺寸无效，不能查看小框");
  const left = Math.floor(value.left * width),
    top = Math.floor(value.top * height);
  const right = Math.ceil((value.left + value.width) * width),
    bottom = Math.ceil((value.top + value.height) * height);
  const result = { left, top, width: right - left, height: bottom - top };
  if (
    right > width ||
    bottom > height ||
    result.width <= 0 ||
    result.height <= 0
  )
    fail(422, "查看框无法在当前原尺寸内完整表达，不裁切或修正坐标");
  if (
    result.width > IMAGE_MASK_REGION_MAX_EDGE ||
    result.height > IMAGE_MASK_REGION_MAX_EDGE ||
    result.width * result.height > IMAGE_MASK_REGION_MAX_PIXELS
  )
    fail(
      413,
      "查看框最多1024像素每边且不超过100万像素，请明确选择更小的框；本次不缩小或采样",
    );
  return result;
}
function inside(point: { x: number; y: number }, region: Rect) {
  return (
    point.x >= region.left &&
    point.x < region.left + region.width &&
    point.y >= region.top &&
    point.y < region.top + region.height
  );
}
function selectedPixel(
  data: Buffer,
  width: number,
  x: number,
  y: number,
): 0 | 255 {
  return data[y * width + x] === 255 ? 255 : 0;
}
async function crop(data: Buffer, region: Rect) {
  const result = await sharp(data, {
    limitInputPixels: 25_000_000,
    failOn: "warning",
  })
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .extract(region)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    result.info.width !== region.width ||
    result.info.height !== region.height ||
    result.info.channels !== 4
  )
    fail(422, "小框解码尺寸或RGBA通道与原页坐标不一致");
  return result.data;
}
async function boundary<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
) {
  try {
    return await run();
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw new DOMException("蒙版小框查看已取消或授权已撤回", "AbortError");
    if (error instanceof AppError || error instanceof z.ZodError) throw error;
    fail(503, "蒙版小框资料暂不可读取，原记录保留；本次没有调用图片服务");
  }
}
async function load(
  db: DB,
  ctx: ToolContext,
  value: ImageMaskRegionViewInput,
  options: Options,
) {
  const input = imageMaskRegionViewInputSchema.parse(value);
  if (!options.vision) fail(409, "蒙版小框查看需要能实际读取图片的视觉模型");
  options.signal?.throwIfAborted();
  const mask = await readImageEditMask(db, ctx, input.maskReceiptId, options);
  const { width, height } = mask.receipt.source;
  const region = imageMaskRegionNativeRect(input.region, width, height);
  const points = input.points.map(([x, y]) => ({
    x: Math.min(width - 1, Math.floor(x * width)),
    y: Math.min(height - 1, Math.floor(y * height)),
  }));
  if (points.some((point) => !inside(point, region)))
    fail(400, "核验点必须位于明确查看的小框内");
  const [source, raw] = await Promise.all([
    crop(mask.sourceData, region),
    crop(mask.generatedCanvas, region),
  ]);
  options.signal?.throwIfAborted();
  return { input, mask, region, points, source, raw };
}
type Loaded = Awaited<ReturnType<typeof load>>;
function facts(value: Loaded): ImageMaskRegionViewOutput {
  const { mask, region, input, source, raw } = value;
  const { receipt, computed } = mask,
    { width } = receipt.source;
  const coverage = {
    sourceTargetPixels: 0,
    generatedTargetPixels: 0,
    protectionPixels: 0,
    allowedOcclusionPixels: 0,
    textPixels: 0,
    selectedPixels: 0,
    remainingProtectionPixels: 0,
    conflictPixels: 0,
    generatedPixels: 0,
    ungeneratedPixels: 0,
    totalPixels: region.width * region.height,
  };
  const layers = (x: number, y: number) => {
    const S = selectedPixel(computed.s.pixels, width, x, y),
      G = selectedPixel(computed.g.pixels, width, x, y),
      P = selectedPixel(computed.p.pixels, width, x, y),
      O = selectedPixel(computed.o.pixels, width, x, y),
      T = selectedPixel(computed.t.pixels, width, x, y);
    return {
      S,
      G,
      P,
      O,
      T,
      selected: S || G || T ? (255 as const) : (0 as const),
      remainingProtection: P && !O ? (255 as const) : (0 as const),
      conflict: selectedPixel(computed.conflicts, width, x, y),
    };
  };
  for (let y = region.top; y < region.top + region.height; y++)
    for (let x = region.left; x < region.left + region.width; x++) {
      const v = layers(x, y);
      coverage.sourceTargetPixels += v.S ? 1 : 0;
      coverage.generatedTargetPixels += v.G ? 1 : 0;
      coverage.protectionPixels += v.P ? 1 : 0;
      coverage.allowedOcclusionPixels += v.O ? 1 : 0;
      coverage.textPixels += v.T ? 1 : 0;
      coverage.selectedPixels += v.selected ? 1 : 0;
      coverage.remainingProtectionPixels += v.remainingProtection ? 1 : 0;
      coverage.conflictPixels += v.conflict ? 1 : 0;
      if (inside({ x, y }, receipt.generatedWindow)) coverage.generatedPixels++;
      else coverage.ungeneratedPixels++;
    }
  const pixelRGBA = (data: Buffer, point: { x: number; y: number }) => {
    const i =
      ((point.y - region.top) * region.width + point.x - region.left) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as [
      number,
      number,
      number,
      number,
    ];
  };
  return imageMaskRegionViewOutputSchema.parse({
    kind: "image_mask_region_view",
    state: "diagnostic-only",
    readonly: true,
    maskReceiptId: receipt.receiptId,
    digest: receipt.digest,
    maskDigest: receipt.maskDigest,
    protectionDigest: receipt.protectionDigest,
    referenceImageId: receipt.source.referenceImageId,
    generationOperationId: receipt.raw.generationOperationId,
    source: {
      width: receipt.source.width,
      height: receipt.source.height,
      sha256: receipt.source.sha256,
    },
    raw: receipt.raw,
    transform: receipt.transform,
    generatedWindow: receipt.generatedWindow,
    region: input.region,
    nativeRect: region,
    coverage,
    points: value.points.map((point, index) => {
      const generated = inside(point, receipt.generatedWindow);
      return {
        point: input.points[index],
        pixel: point,
        sourceRGBA: pixelRGBA(source, point),
        rawRGBA: pixelRGBA(raw, point),
        generated,
        rawOrigin: generated
          ? "generated-candidate"
          : "source-outside-generation-window",
        ...layers(point.x, point.y),
      };
    }),
    instruction,
  });
}
async function recheck(
  db: DB,
  ctx: ToolContext,
  mask: ReadMask,
  options: Options,
) {
  options.signal?.throwIfAborted();
  const current = await readImageEditMask(
    db,
    ctx,
    mask.receipt.receiptId,
    options,
  );
  if (JSON.stringify(current.receipt) !== JSON.stringify(mask.receipt))
    fail(409, "蒙版小框绑定或精确像素事实已改变，请重新查看");
}
/** Only bound facts; never saves a mask, asset, operation or usage. */
export async function viewImageMaskRegion(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskRegionViewInput,
  options: Options,
): Promise<ImageMaskRegionViewOutput> {
  return boundary(options.signal, async () => {
    const value = await load(db, ctx, input, options);
    const output = facts(value);
    await recheck(db, ctx, value.mask, options);
    return output;
  });
}
/** Three same-coordinate native lossless crops, with no full-mask inspection grant. */
export async function previewImageMaskRegion(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskRegionViewInput,
  options: Options,
) {
  return boundary(options.signal, async () => {
    const value = await load(db, ctx, input, options),
      output = facts(value),
      overlay = Buffer.from(value.raw);
    const { region, mask } = value,
      { width } = mask.receipt.source,
      { computed } = mask;
    for (let y = 0; y < region.height; y++)
      for (let x = 0; x < region.width; x++) {
        const i = (region.top + y) * width + region.left + x,
          inS = computed.s.pixels[i] === 255,
          inG = computed.g.pixels[i] === 255;
        const color =
          computed.conflicts[i] === 255
            ? [235, 30, 35]
            : computed.o.pixels[i] === 255
              ? [0, 200, 200]
              : computed.t.pixels[i] === 255
                ? [240, 150, 0]
                : computed.p.pixels[i] === 255
                  ? [230, 180, 40]
                  : inS && inG
                    ? [0, 185, 100]
                    : inS
                      ? [175, 70, 205]
                      : inG
                        ? [235, 205, 0]
                        : [25, 87, 180];
        const offset = (y * region.width + x) * 4;
        for (let c = 0; c < 3; c++)
          overlay[offset + c] = Math.round(
            overlay[offset + c]! * 0.55 + color[c]! * 0.45,
          );
      }
    const frames = await Promise.all(
      (
        [
          ["source-region", value.source],
          ["raw-region", value.raw],
          ["mask-region-overlay", overlay],
        ] as const
      ).map(async ([view, pixels]) => ({
        view,
        data: await sharp(pixels, {
          raw: { width: region.width, height: region.height, channels: 4 },
        })
          .png()
          .toBuffer(),
        mime: "image/png" as const,
        width: region.width,
        height: region.height,
        sourceRect: region,
        contentRect: {
          left: 0,
          top: 0,
          width: region.width,
          height: region.height,
        },
      })),
    );
    await recheck(db, ctx, mask, options);
    return { facts: output, frames };
  });
}
/** Runtime media envelope only. Its pixel buffers never enter the durable DTO. */
export async function imageMaskRegionViewModelOutput(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskRegionViewInput,
  expectedFacts: ImageMaskRegionViewOutput,
  options: Options,
) {
  const expected = imageMaskRegionViewOutputSchema.parse(expectedFacts),
    parsed = imageMaskRegionViewInputSchema.parse(input);
  if (expected.maskReceiptId !== parsed.maskReceiptId)
    fail(409, "蒙版小框回执与本次输出不一致");
  const preview = await previewImageMaskRegion(db, ctx, parsed, options);
  if (JSON.stringify(preview.facts) !== JSON.stringify(expected))
    fail(409, "蒙版小框绑定、范围或像素事实已改变，请重新查看");
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: JSON.stringify(preview.facts) },
      ...preview.frames.flatMap((frame) => [
        {
          type: "text" as const,
          text: JSON.stringify({
            maskReceiptId: expected.maskReceiptId,
            digest: expected.digest,
            referenceImageId: expected.referenceImageId,
            generationOperationId: expected.generationOperationId,
            coordinateSpace: "source",
            view: frame.view,
            sourceRect: frame.sourceRect,
            contentRect: frame.contentRect,
            width: frame.width,
            height: frame.height,
            generatedWindow: expected.generatedWindow,
            ungeneratedPixels: expected.coverage.ungeneratedPixels,
            instruction:
              frame.view === "raw-region"
                ? "生成窗口外是原稿投影，未经生成。"
                : frame.view === "mask-region-overlay"
                  ? "绿S+G、紫S、黄G、金P、青O、橙T、红冲突、蓝保留；仅数学诊断，不授权遮挡。"
                  : "原图同坐标无损小框。",
          }),
        },
        {
          type: "media" as const,
          mediaType: frame.mime,
          data: frame.data.toString("base64"),
        },
      ]),
    ],
  };
}
