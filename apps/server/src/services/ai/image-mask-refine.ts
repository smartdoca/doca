import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import { editRegionsSchema, type EditRegions } from "./image-edit-regions.js";
import {
  imageEditMaskInputSchema,
  imageEditMaskReceiptSchema,
  prepareImageEditMask,
  readImageEditMask,
} from "./image-edit-mask.js";
import {
  readImageMaskGeometry,
  type ImageMaskGeometryOutput,
} from "./image-mask-geometry.js";

const regions = z.union([z.tuple([]), editRegionsSchema]);
const explicitRegions = (message: string) =>
  regions.refine((items) => items.length <= 32, { message });
const sourceExclusion = z
  .object({
    selection: z.literal("source-protected"),
    clipRegions: editRegionsSchema.optional(),
  })
  .strict();
const occlusionAddition = z
  .object({
    selection: z.literal("generated-protected"),
    clipRegions: editRegionsSchema.optional(),
  })
  .strict();
export const imageMaskRefineInputSchema = z
  .object({
    baseMaskReceiptId: z.string().uuid(),
    sourceExclude: z.array(sourceExclusion).max(32),
    allowedOcclusionAdd: z.array(occlusionAddition).max(32),
    sourceInclude: explicitRegions("原人补充最多接受32个显式区域"),
    generatedInclude: explicitRegions("新人补充最多接受32个显式区域"),
    generatedExclude: explicitRegions("新人扣除最多接受32个显式区域"),
  })
  .strict();
export type ImageMaskRefineInput = z.infer<typeof imageMaskRefineInputSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const mathematicalSource = z
  .object({
    selection: z.enum(["source-protected", "generated-protected"]),
    selectedPixels: z.number().int().nonnegative(),
    selectionSha256: hash,
  })
  .strict();
const refinementInstruction =
  "这是当前完整version:2蒙版选区的数学细化，不是重新分割、遮挡授权或语义验收。保留base全部提案、既有扣除及生成窗口，整页S/G/O和组合选区逐像素回验零差才返回。新增新人范围不会自动获得遮挡授权；数学遮挡追加仅来自base新人和保护物交集，新增冲突仍须后轮明确修正及语义查看。新增回执须实际接收完整和局部两帧诊断，后续模型轮次才能合成；不能用此结果代替原页、raw和全部提案的实际查看。";
export const imageMaskRefineOutputSchema = imageEditMaskReceiptSchema
  .pick({
    kind: true,
    state: true,
    digest: true,
    generatedWindow: true,
    coverage: true,
    diagnostics: true,
    instruction: true,
  })
  .extend({
    maskReceiptId: z.string().uuid(),
    referenceImageId: z.string().uuid(),
    generationOperationId: z.string().uuid(),
    source: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    refinement: z
      .object({
        baseMaskReceiptId: z.string().uuid(),
        baseMaskReceiptDigest: hash,
        sourceIncludeSha256: hash,
        generatedIncludeSha256: hash,
        generatedExcludeSha256: hash,
        sourceExcluded: z
          .array(
            mathematicalSource.extend({
              selection: z.literal("source-protected"),
            }),
          )
          .max(32),
        allowedOcclusionAdded: z
          .array(
            mathematicalSource.extend({
              selection: z.literal("generated-protected"),
            }),
          )
          .max(32),
        sourceTargetSha256: hash,
        generatedTargetSha256: hash,
        allowedOcclusionSha256: hash,
        roundTripExact: z.literal(true),
        semanticCoverage: z.literal("unverified"),
        instruction: z.literal(refinementInstruction),
      })
      .strict(),
  })
  .strict();
export type ImageMaskRefineOutput = z.infer<typeof imageMaskRefineOutputSchema>;
type Options = { storage?: StorageRuntime; signal?: AbortSignal };
type ReadMask = Awaited<ReturnType<typeof readImageEditMask>>;
type Selection = "source-protected" | "generated-protected";
const sha = (pixels: Buffer) =>
  createHash("sha256").update(pixels).digest("hex");

async function raster(input: EditRegions | [], width: number, height: number) {
  if (!input.length) return Buffer.alloc(width * height);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${input.map((region) => `<polygon fill="white" points="${region.points.map(([x, y]) => `${x * width},${y * height}`).join(" ")}"/>`).join("")}</svg>`,
  );
  const alpha = await sharp(svg, { limitInputPixels: 25_000_000 })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  for (let i = 0; i < alpha.length; i++) alpha[i] = alpha[i]! >= 128 ? 255 : 0;
  return alpha;
}
async function selectedPixels(
  base: ReadMask,
  selection: Selection,
  clipRegions?: EditRegions,
) {
  const { width, height } = base.receipt.source;
  const clip = clipRegions
    ? await raster(clipRegions, width, height)
    : undefined;
  const pixels = Buffer.alloc(width * height),
    { s, g, p, t } = base.computed;
  for (let i = 0; i < pixels.length; i++) {
    const selected =
      selection === "source-protected"
        ? s.pixels[i] === 255 && p.pixels[i] === 255
        : g.pixels[i] === 255 && p.pixels[i] === 255 && t.pixels[i] !== 255;
    if (selected && (!clip || clip[i] === 255)) pixels[i] = 255;
  }
  return pixels;
}
function assertGeometryBinding(
  base: ReadMask,
  geometry: ImageMaskGeometryOutput,
  pixels: Buffer,
  request: { selection: Selection; clipRegions?: EditRegions },
) {
  const receipt = base.receipt;
  if (
    geometry.maskReceiptId !== receipt.receiptId ||
    geometry.maskReceiptDigest !== receipt.digest ||
    geometry.maskDigest !== receipt.maskDigest ||
    geometry.referenceImageId !== receipt.source.referenceImageId ||
    geometry.generationOperationId !== receipt.raw.generationOperationId ||
    geometry.selection !== request.selection ||
    JSON.stringify(geometry.clipRegions) !==
      JSON.stringify(request.clipRegions ?? []) ||
    geometry.source.width !== receipt.source.width ||
    geometry.source.height !== receipt.source.height ||
    geometry.diagnostics.selectionSha256 !== sha(pixels) ||
    geometry.diagnostics.selectedPixels !==
      pixels.reduce((n, v) => n + (v === 255 ? 1 : 0), 0)
  )
    fail(409, "细化的数学选区与base完整v2绑定或原尺寸像素不一致", {
      code: "image_mask_refine_binding",
    });
}
function assertRetainedBinding(base: ReadMask, current: ReadMask) {
  for (const name of [
    "source",
    "raw",
    "transform",
    "proposalBindings",
    "generatedWindow",
  ] as const)
    if (
      JSON.stringify(base.receipt[name]) !==
      JSON.stringify(current.receipt[name])
    )
      fail(409, "细化不能改变原页、raw、提案或生成窗口绑定", {
        code: "image_mask_refine_binding",
      });
  for (const name of [
    "sourceTarget",
    "generatedTarget",
    "protected",
    "allowedOcclusion",
    "textEdits",
  ] as const)
    if (
      JSON.stringify(base.receipt.input[name].proposalIds) !==
      JSON.stringify(current.receipt.input[name].proposalIds)
    )
      fail(409, "细化不能改变任何既有提案列表", {
        code: "image_mask_refine_binding",
      });
  if (
    !base.sourceData.equals(current.sourceData) ||
    !base.generatedCanvas.equals(current.generatedCanvas)
  )
    fail(409, "细化不能改变原页或raw的实际像素来源", {
      code: "image_mask_refine_binding",
    });
  for (const name of ["p", "t"] as const)
    if (!base.computed[name].pixels.equals(current.computed[name].pixels))
      fail(409, "细化不能改变保护物或改字的任何像素", {
        code: "image_mask_refine_binding",
      });
}

/** New v2 receipt only. The runner owns prior visual proof and later-frame gates.
 * A failed whole-canvas comparison rolls back the new receipt, never the base.
 */
export async function refineImageEditMask(
  db: DB,
  ctx: ToolContext,
  value: ImageMaskRefineInput,
  operationId: string,
  options: Options = {},
): Promise<ImageMaskRefineOutput> {
  const parsed = imageMaskRefineInputSchema.safeParse(value);
  if (!parsed.success)
    fail(422, "细化输入必须完整提供当前严格字段及有效显式区域", {
      code: "image_mask_refine_input",
    });
  const input = parsed.data;
  z.string().uuid().parse(operationId);
  if (operationId === input.baseMaskReceiptId)
    fail(409, "细化必须创建独立回执，不能覆盖base", {
      code: "image_mask_refine_operation",
    });
  if (ctx.writable === false) fail(403, "本次授权仅允许读取，不能细化持久蒙版");
  options.signal?.throwIfAborted();
  return transact(db, async (tx) => {
    const base = await readImageEditMask(
      tx,
      ctx,
      input.baseMaskReceiptId,
      options,
    );
    const sourceGeometry: ImageMaskGeometryOutput[] = [],
      occlusionGeometry: ImageMaskGeometryOutput[] = [];
    // Retain two union bitmaps, never up to 64 complete request bitmaps.
    const sourcePixels = Buffer.alloc(base.computed.s.pixels.length),
      occlusionPixels = Buffer.alloc(base.computed.s.pixels.length);
    for (const [requests, geometries, pixels] of [
      [input.sourceExclude, sourceGeometry, sourcePixels],
      [input.allowedOcclusionAdd, occlusionGeometry, occlusionPixels],
    ] as const) {
      for (const request of requests) {
        options.signal?.throwIfAborted();
        const geometry = await readImageMaskGeometry(
          tx,
          ctx,
          {
            maskReceiptId: input.baseMaskReceiptId,
            ...request,
          },
          options,
        );
        if (
          geometry.state !== "ready" ||
          !geometry.geometry ||
          !geometry.diagnostics.roundTripExact
        )
          fail(409, "数学选区无法在既有格式完整精确表达，不能细化部分区域", {
            code: "image_mask_refine_unrepresentable",
          });
        const selected = await selectedPixels(
          base,
          request.selection,
          request.clipRegions,
        );
        assertGeometryBinding(base, geometry, selected, request);
        if (
          request.selection === "source-protected" &&
          geometry.geometry.exclude.length
        )
          fail(
            409,
            "原人扣除选区含孔，扁平sourceTarget.exclude不能表达该减集",
            { code: "image_mask_refine_source_holes" },
          );
        geometries.push(geometry);
        for (let i = 0; i < pixels.length; i++)
          if (selected[i] === 255) pixels[i] = 255;
      }
    }
    // Explicitly retain all five proposal lists and every unrelated v2 field.
    const nextInput = imageEditMaskInputSchema.parse({
      ...base.receipt.input,
      sourceTarget: {
        ...base.receipt.input.sourceTarget,
        include: [
          ...base.receipt.input.sourceTarget.include,
          ...input.sourceInclude,
        ],
        exclude: [
          ...base.receipt.input.sourceTarget.exclude,
          ...sourceGeometry.flatMap((item) => item.geometry!.include),
        ],
      },
      generatedTarget: {
        ...base.receipt.input.generatedTarget,
        include: [
          ...base.receipt.input.generatedTarget.include,
          ...input.generatedInclude,
        ],
        exclude: [
          ...base.receipt.input.generatedTarget.exclude,
          ...input.generatedExclude,
        ],
      },
      allowedOcclusion: {
        ...base.receipt.input.allowedOcclusion,
        include: [
          ...base.receipt.input.allowedOcclusion.include,
          ...occlusionGeometry.flatMap((item) => item.geometry!.include),
        ],
        exclude: [
          ...base.receipt.input.allowedOcclusion.exclude,
          ...occlusionGeometry.flatMap((item) => item.geometry!.exclude),
        ],
      },
    });
    const { width, height } = base.receipt.source;
    const expectedS = Buffer.from(base.computed.s.pixels),
      expectedG = Buffer.from(base.computed.g.pixels),
      expectedO = Buffer.from(base.computed.o.pixels);
    async function append(target: Buffer, regions: EditRegions | []) {
      const pixels = await raster(regions, width, height);
      for (let i = 0; i < target.length; i++)
        if (pixels[i] === 255) target[i] = 255;
      return sha(pixels);
    }
    async function subtract(target: Buffer, regions: EditRegions | []) {
      const pixels = await raster(regions, width, height);
      for (let i = 0; i < target.length; i++)
        if (pixels[i] === 255) target[i] = 0;
      return sha(pixels);
    }
    const sourceIncludeSha256 = await append(expectedS, input.sourceInclude);
    // Old exclusions remain authoritative even over newly included pixels.
    await subtract(expectedS, base.receipt.input.sourceTarget.exclude);
    const generatedIncludeSha256 = await append(
      expectedG,
      input.generatedInclude,
    );
    await subtract(expectedG, base.receipt.input.generatedTarget.exclude);
    const generatedExcludeSha256 = await subtract(
      expectedG,
      input.generatedExclude,
    );
    for (let i = 0; i < expectedS.length; i++) {
      if (sourcePixels[i] === 255) expectedS[i] = 0;
      if (occlusionPixels[i] === 255) expectedO[i] = 255;
    }
    await subtract(expectedO, base.receipt.input.allowedOcclusion.exclude);
    const expectedCombined = Buffer.alloc(expectedS.length);
    for (let i = 0; i < expectedCombined.length; i++)
      if (
        expectedS[i] === 255 ||
        expectedG[i] === 255 ||
        base.computed.t.pixels[i] === 255
      )
        expectedCombined[i] = 255;
    options.signal?.throwIfAborted();
    const receipt = await prepareImageEditMask(
      tx,
      ctx,
      nextInput,
      operationId,
      options,
    );
    const current = await readImageEditMask(
      tx,
      ctx,
      receipt.receiptId,
      options,
    );
    assertRetainedBinding(base, current);
    const combined = await sharp(current.maskPNG, {
      limitInputPixels: 25_000_000,
    })
      .toColourspace("b-w")
      .raw()
      .toBuffer();
    if (
      current.receipt.digest !== receipt.digest ||
      !current.computed.s.pixels.equals(expectedS) ||
      !current.computed.g.pixels.equals(expectedG) ||
      !current.computed.o.pixels.equals(expectedO) ||
      !combined.equals(expectedCombined)
    )
      fail(
        409,
        "细化整组原尺寸S/G/O或组合选区与明确并集及减集逐像素不一致，拒绝整个新回执",
        { code: "image_mask_refine_roundtrip" },
      );
    const finalBase = await readImageEditMask(
      tx,
      ctx,
      input.baseMaskReceiptId,
      options,
    );
    if (finalBase.receipt.digest !== base.receipt.digest)
      fail(409, "细化期间base回执绑定已改变", {
        code: "image_mask_refine_binding",
      });
    options.signal?.throwIfAborted();
    return imageMaskRefineOutputSchema.parse({
      kind: receipt.kind,
      state: receipt.state,
      digest: receipt.digest,
      maskReceiptId: receipt.receiptId,
      referenceImageId: receipt.input.referenceImageId,
      generationOperationId: receipt.input.generationOperationId,
      source: { width, height },
      generatedWindow: receipt.generatedWindow,
      coverage: receipt.coverage,
      diagnostics: receipt.diagnostics,
      instruction: receipt.instruction,
      refinement: {
        baseMaskReceiptId: base.receipt.receiptId,
        baseMaskReceiptDigest: base.receipt.digest,
        sourceIncludeSha256,
        generatedIncludeSha256,
        generatedExcludeSha256,
        sourceExcluded: sourceGeometry.map((item) => ({
          selection: item.selection,
          selectedPixels: item.diagnostics.selectedPixels,
          selectionSha256: item.diagnostics.selectionSha256,
        })),
        allowedOcclusionAdded: occlusionGeometry.map((item) => ({
          selection: item.selection,
          selectedPixels: item.diagnostics.selectedPixels,
          selectionSha256: item.diagnostics.selectionSha256,
        })),
        sourceTargetSha256: sha(expectedS),
        generatedTargetSha256: sha(expectedG),
        allowedOcclusionSha256: sha(expectedO),
        roundTripExact: true,
        semanticCoverage: "unverified",
        instruction: refinementInstruction,
      },
    });
  });
}
