import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { requireCapability } from "@core/modules/access/operation-policy.js";
import { checkJob, type ToolContext } from "@core/workflows/ai-documents.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import { readRawImageCandidate } from "./images.js";
import {
  rawImageCandidateCanvas,
  rawImageTransformSchema,
} from "./image-candidates.js";
import { editRegionsSchema, type EditRegions } from "./image-edit-regions.js";
import { bindImageEditBitmap } from "./image-edit-bitmap.js";
import {
  readUsableImageMaskSegment,
  type ImageMaskSegmentInput,
} from "./image-mask-segment.js";

const regions = z.union([z.tuple([]), editRegionsSchema]);
export const imageEditMaskSelectionSchema = z
  .object({
    proposalIds: z
      .array(z.string().uuid())
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length),
    include: regions,
    exclude: regions,
  })
  .strict();
export const imageEditMaskInputSchema = z
  .object({
    generationOperationId: z.string().uuid(),
    referenceImageId: z.string().uuid(),
    sourceTarget: imageEditMaskSelectionSchema,
    generatedTarget: imageEditMaskSelectionSchema,
    protected: imageEditMaskSelectionSchema,
    allowedOcclusion: imageEditMaskSelectionSchema,
    textEdits: imageEditMaskSelectionSchema,
  })
  .strict();
export type ImageEditMaskInput = z.infer<typeof imageEditMaskInputSchema>;
type Selection = z.infer<typeof imageEditMaskSelectionSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const rect = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const count = z.number().int().nonnegative();
const instruction =
  "这是精确分割提案与手工修边的数学及覆盖诊断，不是人物、身份、背景或文字的语义验收。每组选区先合并已绑定的完整二值提案，再补充 include，最后扣除 exclude；保留孔洞和不连通区域。绿=原人和新人交集，紫=仅原人需清除，黄=仅新人外扩，青=明确允许的新人遮挡，红=与剩余保护区冲突，蓝=其余保留。原人或新人漏画、误画与扣除过多仍须对照原页和原始候选实际检查；不能把零数学缺失解释成完整人物已覆盖。文字编辑独立于人物与遮挡。所有多边形属于完整原页归一化坐标，图例和预览窗口不授权新范围。";
const proposalBindingSchema = z
  .object({
    receiptId: z.string().uuid(),
    digest: hash,
    selectionSha256: hash,
  })
  .strict();
const receiptBaseSchema = z
  .object({
    kind: z.literal("image_edit_mask"),
    version: z.literal(2),
    state: z.literal("diagnostic-only"),
    receiptId: z.string().uuid(),
    scope: z
      .object({
        preparedJobId: z.string().uuid(),
        sessionId: z.string().uuid(),
      })
      .strict(),
    input: imageEditMaskInputSchema,
    proposalBindings: z
      .array(proposalBindingSchema)
      .max(160)
      .refine((items) =>
        items.every(
          (item, i) => i === 0 || items[i - 1]!.receiptId < item.receiptId,
        ),
      ),
    source: size.safeExtend({
      referenceImageId: z.string().uuid(),
      sha256: hash,
    }),
    raw: z
      .object({
        generationOperationId: z.string().uuid(),
        receiptId: z.string().uuid(),
        sha256: hash,
      })
      .strict(),
    transform: rawImageTransformSchema,
    generatedWindow: rect,
    maskDigest: hash,
    protectionDigest: hash.nullable(),
    bounds: rect,
    coverage: z
      .object({
        sourceTargetPixels: count,
        generatedTargetPixels: count,
        textPixels: count,
        editablePixels: count,
        expandedPixels: count,
        protectedPixels: count,
        remainingProtectionPixels: count,
        allowedOcclusionPixels: count,
        totalPixels: count,
      })
      .strict(),
    diagnostics: z
      .object({
        semanticCoverage: z.literal("unverified"),
        sourceExcludedPixels: count,
        generatedExcludedPixels: count,
        declaredSourceOmittedPixels: count,
        declaredGeneratedOmittedPixels: count,
        protectionConflictPixels: count,
        sourceConflictPixels: count,
        generatedConflictPixels: count,
        textConflictPixels: count,
        conflictBounds: rect.nullable(),
        safeToCompose: z.boolean(),
      })
      .strict(),
    instruction: z.literal(instruction),
  })
  .strict();
export const imageEditMaskReceiptSchema = receiptBaseSchema.safeExtend({
  digest: hash,
});
export type ImageEditMaskReceipt = z.infer<typeof imageEditMaskReceiptSchema>;
type Options = { storage?: StorageRuntime; signal?: AbortSignal };
async function publicBoundary<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw new DOMException("蒙版操作已取消或任务授权已撤回", "AbortError");
    if (error instanceof AppError) throw error;
    fail(
      503,
      "蒙版资料或图像处理暂时不可用，原记录保留；本次没有调用图片服务",
      { code: "image_mask_io_failed" },
    );
  }
}
type Raw = Awaited<ReturnType<typeof readRawImageCandidate>>;
const selectionNames = [
  "sourceTarget",
  "generatedTarget",
  "protected",
  "allowedOcclusion",
  "textEdits",
] as const;
type SelectionName = (typeof selectionNames)[number];
type ProposalInspection = {
  receiptId: string;
  digest: string;
  source: ImageMaskSegmentInput["source"];
  usable: boolean;
  groups: SelectionName[];
  targetLabels: string[];
};
type ResolvedProposals = {
  bindings: z.infer<typeof proposalBindingSchema>[];
  pixels: Partial<Record<SelectionName, Buffer>>;
  inspections: ProposalInspection[];
};
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail(422, "蒙版回执 JSON 无效，不能转换或补造");
  }
}
function bounds(pixels: Buffer, width: number) {
  let left = width,
    top = pixels.length / width,
    right = -1,
    bottom = -1;
  for (let i = 0; i < pixels.length; i++)
    if (pixels[i] === 255) {
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  return right < 0
    ? null
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
}
const pixelsCount = (pixels: Buffer) =>
  pixels.reduce((sum, value) => sum + (value === 255 ? 1 : 0), 0);
async function png(pixels: Buffer, width: number, height: number) {
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .toColourspace("b-w")
    .png()
    .toBuffer();
}
async function polygons(
  input: EditRegions | [],
  width: number,
  height: number,
) {
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
async function selection(
  input: Selection,
  width: number,
  height: number,
  proposalPixels?: Buffer,
) {
  const [included, excluded] = await Promise.all([
    polygons(input.include, width, height),
    polygons(input.exclude, width, height),
  ]);
  if (proposalPixels)
    for (let i = 0; i < included.length; i++)
      if (proposalPixels[i] === 255) included[i] = 255;
  const pixels = Buffer.from(included);
  let excludedPixels = 0;
  for (let i = 0; i < pixels.length; i++)
    if (included[i] === 255 && excluded[i] === 255) {
      pixels[i] = 0;
      excludedPixels++;
    }
  return { included, pixels, excludedPixels };
}
async function loadRaw(
  db: DB,
  ctx: ToolContext,
  input: ImageEditMaskInput,
  options: Options,
) {
  options.signal?.throwIfAborted();
  const raw = await readRawImageCandidate(
    db,
    ctx,
    input.generationOperationId,
    options.storage,
  );
  const source = raw.candidate.references[0];
  if (
    !source ||
    !raw.sources[0] ||
    source.referenceImageId !== input.referenceImageId
  )
    fail(409, "蒙版必须绑定原始候选的第一张原页，不能补造来源");
  if (source.width * source.height > 25_000_000)
    fail(413, "蒙版原页超过 2500 万像素");
  if (raw.candidate.transform.kind === "full") {
    const denominator = source.width * raw.candidate.dimensions.height;
    if (
      Math.abs(raw.candidate.dimensions.width * source.height - denominator) *
        100 >
      denominator
    )
      fail(409, "整页候选与原页的实际比例偏差超过 1%，不能拉伸准备蒙版", {
        code: "image_recompose_aspect_mismatch",
      });
  }
  return raw;
}
async function resolveProposals(
  db: DB,
  ctx: ToolContext,
  raw: Raw,
  input: ImageEditMaskInput,
  options: Options,
): Promise<ResolvedProposals> {
  const source = raw.candidate.references[0]!;
  const ids = [
    ...new Set(selectionNames.flatMap((name) => input[name].proposalIds)),
  ].sort();
  const result: ResolvedProposals = {
    bindings: [],
    pixels: {},
    inspections: [],
  };
  const invalidGroups: {
    proposalReceiptId: string;
    group: SelectionName;
    expectedSourceKind: "reference" | "raw";
  }[] = [];
  const expectedWindow =
    raw.candidate.transform.kind === "viewport"
      ? raw.candidate.transform.rect
      : { left: 0, top: 0, width: source.width, height: source.height };
  for (const id of ids) {
    options.signal?.throwIfAborted();
    const proposal = await readUsableImageMaskSegment(db, ctx, id, options);
    const { receipt } = proposal,
      binding = receipt.binding;
    const inspection: ProposalInspection = {
      receiptId: id,
      digest: receipt.digest,
      source: receipt.input.source,
      usable: receipt.usable,
      groups: selectionNames.filter((name) =>
        input[name].proposalIds.includes(id),
      ),
      targetLabels: receipt.input.targets.slice(0, 4).map((part) => part.label),
    };
    result.inspections.push(inspection);
    const rejectBinding = (message: string): never =>
      fail(
        409,
        JSON.stringify({
          error: true,
          code: "image_mask_proposal_binding_mismatch",
          referenceImageId: input.referenceImageId,
          generationOperationId: input.generationOperationId,
          proposals: result.inspections.map(
            ({ digest: _digest, ...facts }) => facts,
          ),
          instruction: `${message}。请使用真实同页、同候选和正确selection的提案；重新查看不能授权错误来源，不自动转换或替换提案。`,
        }),
        { code: "image_mask_proposal_binding_mismatch" },
      );
    if (
      binding.referenceImageId !== source.referenceImageId ||
      binding.sourceSha256 !== source.sha256 ||
      binding.sourceSize !== raw.sources[0]!.data.length ||
      binding.dimensions.width !== source.width ||
      binding.dimensions.height !== source.height
    )
      rejectBinding(
        "分割提案与蒙版原页身份、字节或精确尺寸不一致，不能转换或重绑",
      );
    const proposalSource = receipt.input.source;
    const isReference = proposalSource.kind === "reference";
    if (isReference) {
      if (
        proposalSource.referenceImageId !== input.referenceImageId ||
        binding.raw !== null ||
        JSON.stringify(binding.generatedWindow) !==
          JSON.stringify({
            left: 0,
            top: 0,
            width: source.width,
            height: source.height,
          })
      )
        rejectBinding("原页分割提案来源或完整坐标映射不一致");
    } else if (
      proposalSource.generationOperationId !== input.generationOperationId ||
      !binding.raw ||
      binding.raw.generationOperationId !== input.generationOperationId ||
      binding.raw.receiptId !== raw.receiptId ||
      binding.raw.sha256 !== raw.candidate.sha256 ||
      JSON.stringify(binding.raw.transform) !==
        JSON.stringify(raw.candidate.transform) ||
      JSON.stringify(binding.generatedWindow) !== JSON.stringify(expectedWindow)
    )
      rejectBinding(
        "新人分割提案与原始候选、回执、字节或坐标映射不一致，不能转换或重绑",
      );
    const decoded = await sharp(proposal.selectionPNG, {
      limitInputPixels: 25_000_000,
    })
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== source.width ||
      decoded.info.height !== source.height ||
      decoded.info.channels !== 1 ||
      decoded.data.some((value) => value !== 0 && value !== 255)
    )
      fail(409, "分割提案缺少原页精确二值像素，不能缩放或填洞");
    for (const name of selectionNames) {
      if (!input[name].proposalIds.includes(id)) continue;
      if (
        ((name === "sourceTarget" || name === "protected") && !isReference) ||
        ((name === "generatedTarget" || name === "allowedOcclusion") &&
          isReference)
      ) {
        invalidGroups.push({
          proposalReceiptId: id,
          group: name,
          expectedSourceKind:
            name === "sourceTarget" || name === "protected"
              ? "reference"
              : "raw",
        });
        continue;
      }
      const pixels = (result.pixels[name] ??= Buffer.alloc(
        source.width * source.height,
      ));
      for (let i = 0; i < pixels.length; i++)
        if (decoded.data[i] === 255) pixels[i] = 255;
    }
    result.bindings.push({
      receiptId: id,
      digest: receipt.digest,
      selectionSha256: receipt.selectionSha256!,
    });
  }
  if (invalidGroups.length)
    fail(
      409,
      JSON.stringify({
        error: true,
        code: "image_mask_proposal_binding_mismatch",
        referenceImageId: input.referenceImageId,
        generationOperationId: input.generationOperationId,
        proposals: result.inspections.map(
          ({ digest: _digest, ...facts }) => facts,
        ),
        issues: invalidGroups,
        instruction:
          "原人及保护区只能使用原页提案，新人及允许遮挡只能使用同一原始候选提案。请按真实source和selection修正；重新查看不会改变来源，不按label自动判人物或道具，也不自动替换提案。",
      }),
      { code: "image_mask_proposal_binding_mismatch" },
    );
  return result;
}
/** Read-only preflight shares the exact binding/binary checks used by prepare. */
export async function inspectImageEditMaskProposals(
  db: DB,
  ctx: ToolContext,
  input: ImageEditMaskInput,
  options: Options = {},
): Promise<ProposalInspection[]> {
  return publicBoundary(options.signal, async () => {
    const parsed = imageEditMaskInputSchema.parse(input);
    const raw = await loadRaw(db, ctx, parsed, options);
    return (await resolveProposals(db, ctx, raw, parsed, options)).inspections;
  });
}
function assertProposalBindings(
  receipt: ImageEditMaskReceipt,
  proposals: ResolvedProposals,
) {
  if (
    JSON.stringify(receipt.proposalBindings) !==
    JSON.stringify(proposals.bindings)
  )
    fail(409, "蒙版绑定的全部分割回执摘要或精确二值摘要已变化，不能重绑原记录");
}
async function compute(
  raw: Raw,
  input: ImageEditMaskInput,
  proposals: ResolvedProposals,
) {
  const source = raw.candidate.references[0]!,
    { width, height } = source;
  const [s, g, p, o, t] = await Promise.all([
    selection(input.sourceTarget, width, height, proposals.pixels.sourceTarget),
    selection(
      input.generatedTarget,
      width,
      height,
      proposals.pixels.generatedTarget,
    ),
    selection(input.protected, width, height, proposals.pixels.protected),
    selection(
      input.allowedOcclusion,
      width,
      height,
      proposals.pixels.allowedOcclusion,
    ),
    selection(input.textEdits, width, height, proposals.pixels.textEdits),
  ]);
  const editable = Buffer.alloc(width * height),
    remainingProtection = Buffer.alloc(editable.length),
    conflicts = Buffer.alloc(editable.length);
  let sourceConflicts = 0,
    generatedConflicts = 0,
    textConflicts = 0,
    expandedPixels = 0;
  const generatedWindow =
    raw.candidate.transform.kind === "viewport"
      ? raw.candidate.transform.rect
      : { left: 0, top: 0, width, height };
  for (let i = 0; i < editable.length; i++) {
    const inS = s.pixels[i] === 255,
      inG = g.pixels[i] === 255,
      inP = p.pixels[i] === 255,
      inO = o.pixels[i] === 255,
      inT = t.pixels[i] === 255;
    if (inO && (!inG || !inP || inT))
      fail(
        409,
        "允许遮挡必须完全位于新人物与保护对象交集，且不能用于文字编辑",
        { code: "image_mask_invalid_occlusion" },
      );
    if (inP && !inO) remainingProtection[i] = 255;
    if (inS || inG || inT) {
      const x = i % width,
        y = Math.floor(i / width);
      if (
        x < generatedWindow.left ||
        x >= generatedWindow.left + generatedWindow.width ||
        y < generatedWindow.top ||
        y >= generatedWindow.top + generatedWindow.height
      )
        fail(409, "蒙版编辑范围超出原始候选实际生成窗口，不能补造新像素", {
          code: "image_mask_viewport_bounds",
        });
      editable[i] = 255;
    }
    if (inG && !inS) expandedPixels++;
    if (editable[i] === 255 && remainingProtection[i] === 255) {
      conflicts[i] = 255;
      if (inS) sourceConflicts++;
      if (inG) generatedConflicts++;
      if (inT) textConflicts++;
    }
  }
  if (!pixelsCount(editable))
    fail(409, "蒙版没有任何可编辑像素，不能准备空操作");
  const maskPNG = await png(editable, width, height);
  const bitmap = await bindImageEditBitmap(raw.sources[0]!.data, maskPNG);
  const remainingCount = pixelsCount(remainingProtection);
  const protectionPNG = remainingCount
    ? await png(remainingProtection, width, height)
    : undefined;
  const protection = protectionPNG
    ? await bindImageEditBitmap(raw.sources[0]!.data, protectionPNG)
    : undefined;
  return {
    maskPNG,
    protectionPNG,
    protectionDigest: protection?.digest ?? null,
    bitmap,
    s,
    g,
    p,
    o,
    t,
    conflicts,
    generatedWindow,
    coverage: {
      sourceTargetPixels: pixelsCount(s.pixels),
      generatedTargetPixels: pixelsCount(g.pixels),
      textPixels: pixelsCount(t.pixels),
      editablePixels: bitmap.coverage.editablePixels,
      expandedPixels,
      protectedPixels: bitmap.coverage.protectedPixels,
      remainingProtectionPixels: remainingCount,
      allowedOcclusionPixels: pixelsCount(o.pixels),
      totalPixels: width * height,
    },
    diagnostics: {
      semanticCoverage: "unverified" as const,
      sourceExcludedPixels: s.excludedPixels,
      generatedExcludedPixels: g.excludedPixels,
      // These compare declared binary selections with the union only; semantic misses are unverified.
      declaredSourceOmittedPixels: 0,
      declaredGeneratedOmittedPixels: 0,
      protectionConflictPixels: pixelsCount(conflicts),
      sourceConflictPixels: sourceConflicts,
      generatedConflictPixels: generatedConflicts,
      textConflictPixels: textConflicts,
      conflictBounds: bounds(conflicts, width),
      safeToCompose: pixelsCount(conflicts) === 0,
    },
  };
}
function receiptDigest(base: z.infer<typeof receiptBaseSchema>) {
  return sha("doca-image-edit-mask-v2\0" + JSON.stringify(base));
}
async function sessionContext(db: DB, ctx: ToolContext) {
  if (!ctx.jobId) fail(409, "正式蒙版必须绑定当前任务");
  await checkJob(db, ctx);
  const job = await db
    .selectFrom("ai_jobs as j")
    .innerJoin("ai_sessions as s", "s.id", "j.session_id")
    .select(["j.id", "j.session_id"])
    .where("j.id", "=", ctx.jobId)
    .where("j.user_id", "=", ctx.actor.id)
    .where("s.user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!job) fail(404, "蒙版任务不属于当前账号或会话");
  return job;
}
function assertBinding(receipt: ImageEditMaskReceipt, raw: Raw) {
  const source = raw.candidate.references[0]!;
  if (
    receipt.raw.generationOperationId !== raw.candidate.generationOperationId ||
    receipt.raw.receiptId !== raw.receiptId ||
    receipt.raw.sha256 !== raw.candidate.sha256 ||
    receipt.source.referenceImageId !== source.referenceImageId ||
    receipt.source.sha256 !== source.sha256 ||
    receipt.source.width !== source.width ||
    receipt.source.height !== source.height ||
    JSON.stringify(receipt.transform) !==
      JSON.stringify(raw.candidate.transform)
  )
    fail(409, "蒙版绑定的来源、候选字节、尺寸或坐标映射已变化，不能转换或重绑");
}

/** A new immutable host receipt; no assets, provider calls, or old-record conversions. */
export async function prepareImageEditMask(
  db: DB,
  ctx: ToolContext,
  input: ImageEditMaskInput,
  operationId: string,
  options: Options = {},
): Promise<ImageEditMaskReceipt> {
  return publicBoundary(options.signal, () =>
    prepareImageEditMaskInternal(db, ctx, input, operationId, options),
  );
}
async function prepareImageEditMaskInternal(
  db: DB,
  ctx: ToolContext,
  input: ImageEditMaskInput,
  operationId: string,
  options: Options,
): Promise<ImageEditMaskReceipt> {
  input = imageEditMaskInputSchema.parse(input);
  z.string().uuid().parse(operationId);
  if (ctx.writable === false) fail(403, "本次授权仅允许读取，不能准备持久蒙版");
  const raw = await loadRaw(db, ctx, input, options);
  const proposals = await resolveProposals(db, ctx, raw, input, options);
  const computed = await compute(raw, input, proposals);
  options.signal?.throwIfAborted();
  return transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    await requireCapability(tx, ctx.actor.id, "ai.create");
    const job = await sessionContext(tx, ctx);
    const current = await loadRaw(tx, ctx, input, options);
    const currentProposals = await resolveProposals(
      tx,
      ctx,
      current,
      input,
      options,
    );
    if (
      JSON.stringify(proposals.bindings) !==
      JSON.stringify(currentProposals.bindings)
    )
      fail(409, "分割提案在准备蒙版期间已变化，不能重绑");
    const prior = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", operationId)
      .executeTakeFirst();
    if (prior) {
      const existing = await readImageEditMask(tx, ctx, operationId, options);
      if (
        JSON.stringify(existing.receipt.input) !== JSON.stringify(input) ||
        existing.receipt.maskDigest !== computed.bitmap.digest
      )
        fail(409, "蒙版操作标识已用于不同参数，不能覆盖原记录");
      return existing.receipt;
    }
    const source = raw.candidate.references[0]!;
    const base = receiptBaseSchema.parse({
      kind: "image_edit_mask",
      version: 2,
      state: "diagnostic-only",
      receiptId: operationId,
      scope: { preparedJobId: job.id, sessionId: job.session_id },
      input,
      proposalBindings: proposals.bindings,
      source: {
        referenceImageId: source.referenceImageId,
        sha256: source.sha256,
        width: source.width,
        height: source.height,
      },
      raw: {
        generationOperationId: input.generationOperationId,
        receiptId: raw.receiptId,
        sha256: raw.candidate.sha256,
      },
      transform: raw.candidate.transform,
      generatedWindow: computed.generatedWindow,
      maskDigest: computed.bitmap.digest,
      protectionDigest: computed.protectionDigest,
      bounds: computed.bitmap.bounds,
      coverage: computed.coverage,
      diagnostics: computed.diagnostics,
      instruction,
    });
    const receipt = imageEditMaskReceiptSchema.parse({
      ...base,
      digest: receiptDigest(base),
    });
    assertBinding(receipt, current);
    options.signal?.throwIfAborted();
    await tx
      .insertInto("ai_operations")
      .values({
        id: operationId,
        user_id: ctx.actor.id,
        job_id: job.id,
        digest: receipt.digest,
        result: JSON.stringify(receipt),
        created_at: new Date().toISOString(),
      })
      .execute();
    return receipt;
  });
}

/** Reauthorize every exact retained proposal and reconstruct only the strict v2 recipe. */
export async function readImageEditMask(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Options = {},
) {
  return publicBoundary(options.signal, () =>
    readImageEditMaskInternal(db, ctx, receiptId, options),
  );
}
async function readImageEditMaskInternal(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Options,
) {
  z.string().uuid().parse(receiptId);
  const job = await sessionContext(db, ctx);
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", receiptId)
    .where("user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!row) fail(404, "蒙版回执不存在或无权访问");
  const parsed = imageEditMaskReceiptSchema.safeParse(parseJSON(row.result));
  if (!parsed.success)
    fail(422, "蒙版回执仅接受完整 version:2，原记录保留且不转换");
  const receipt = parsed.data,
    { digest: _digest, ...base } = receipt;
  if (
    receipt.receiptId !== receiptId ||
    row.job_id !== receipt.scope.preparedJobId ||
    receipt.scope.sessionId !== job.session_id ||
    row.digest !== receipt.digest ||
    receiptDigest(receiptBaseSchema.parse(base)) !== receipt.digest
  )
    fail(409, "蒙版回执身份、作用域或摘要不一致，不能修复原记录");
  const origin = await db
    .selectFrom("ai_jobs")
    .select("id")
    .where("id", "=", receipt.scope.preparedJobId)
    .where("user_id", "=", ctx.actor.id)
    .where("session_id", "=", receipt.scope.sessionId)
    .executeTakeFirst();
  if (!origin) fail(404, "蒙版原任务不属于当前会话");
  const raw = await loadRaw(db, ctx, receipt.input, options);
  assertBinding(receipt, raw);
  const proposals = await resolveProposals(
    db,
    ctx,
    raw,
    receipt.input,
    options,
  );
  assertProposalBindings(receipt, proposals);
  const computed = await compute(raw, receipt.input, proposals);
  const protectionDigest = computed.protectionDigest;
  if (
    computed.bitmap.digest !== receipt.maskDigest ||
    protectionDigest !== receipt.protectionDigest ||
    JSON.stringify(computed.coverage) !== JSON.stringify(receipt.coverage) ||
    JSON.stringify(computed.diagnostics) !==
      JSON.stringify(receipt.diagnostics) ||
    JSON.stringify(computed.generatedWindow) !==
      JSON.stringify(receipt.generatedWindow) ||
    JSON.stringify(computed.bitmap.bounds) !== JSON.stringify(receipt.bounds)
  )
    fail(409, "蒙版精确像素或诊断事实与持久回执不一致，不能重算覆盖旧事实");
  const generatedCanvas = await rawImageCandidateCanvas(
    raw.candidate,
    raw.data,
    raw.sources[0]!.data,
  );
  options.signal?.throwIfAborted();
  const finalRaw = await loadRaw(db, ctx, receipt.input, options);
  assertBinding(receipt, finalRaw);
  assertProposalBindings(
    receipt,
    await resolveProposals(db, ctx, finalRaw, receipt.input, options),
  );
  return {
    receipt,
    raw,
    sourceData: raw.sources[0]!.data,
    generatedCanvas,
    maskPNG: computed.maskPNG,
    protectionPNG: computed.protectionPNG,
    computed,
  };
}

const MAX_EDGE = 1600,
  LEGEND_HEIGHT = 80;
/** Bounded source/full and generated/local diagnostics, never a saved composition. */
export async function previewImageEditMask(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Options = {},
) {
  return publicBoundary(options.signal, () =>
    previewImageEditMaskInternal(db, ctx, receiptId, options),
  );
}
async function previewImageEditMaskInternal(
  db: DB,
  ctx: ToolContext,
  receiptId: string,
  options: Options,
) {
  const result = await readImageEditMask(db, ctx, receiptId, options),
    { receipt, computed } = result;
  const { width, height } = receipt.source;
  const overlay = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const inS = computed.s.pixels[i] === 255,
      inG = computed.g.pixels[i] === 255;
    const color =
      computed.conflicts[i] === 255
        ? [235, 30, 35, 160]
        : computed.o.pixels[i] === 255
          ? [0, 200, 200, 130]
          : computed.t.pixels[i] === 255
            ? [240, 150, 0, 130]
            : inS && inG
              ? [0, 185, 100, 90]
              : inS
                ? [175, 70, 205, 110]
                : inG
                  ? [235, 205, 0, 110]
                  : [25, 87, 180, 55];
    overlay.set(color, i * 4);
  }
  async function frame(
    data: Buffer,
    sourceRect: z.infer<typeof rect>,
    view: "source-full" | "generated-local",
  ) {
    const scale = Math.min(
      1,
      MAX_EDGE / sourceRect.width,
      (MAX_EDGE - LEGEND_HEIGHT) / sourceRect.height,
    );
    const contentWidth = Math.max(1, Math.round(sourceRect.width * scale)),
      contentHeight = Math.max(1, Math.round(sourceRect.height * scale));
    const canvasWidth = Math.max(640, contentWidth),
      canvasHeight = contentHeight + LEGEND_HEIGHT,
      left = Math.floor((canvasWidth - contentWidth) / 2);
    const croppedOverlay = await sharp(overlay, {
      raw: { width, height, channels: 4 },
    })
      .extract(sourceRect)
      .resize(contentWidth, contentHeight, { kernel: "nearest" })
      .raw()
      .toBuffer();
    const scene = await sharp(data, { limitInputPixels: 25_000_000 })
      .rotate()
      .extract(sourceRect)
      .resize(contentWidth, contentHeight, { fit: "fill" })
      .flatten({ background: "#fff" })
      .composite([
        {
          input: croppedOverlay,
          raw: { width: contentWidth, height: contentHeight, channels: 4 },
        },
      ])
      .png()
      .toBuffer();
    const legend = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${LEGEND_HEIGHT}"><rect width="100%" height="100%" fill="white"/><text x="10" y="18" font-family="sans-serif" font-size="12" fill="#111">GREEN S+G | PURPLE old only | YELLOW new only | CYAN allowed occlusion</text><text x="10" y="36" font-family="sans-serif" font-size="12" fill="#111">RED protection conflict | ORANGE text | BLUE preserve</text><text x="10" y="54" font-family="sans-serif" font-size="12" fill="#111">${view} x:${sourceRect.left} y:${sourceRect.top} w:${sourceRect.width} h:${sourceRect.height}</text><text x="10" y="72" font-family="sans-serif" font-size="12" fill="#111">SEMANTIC COVERAGE UNVERIFIED. Check missed body, props, holes and contact.</text></svg>`,
    );
    const rendered = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: "#fff",
      },
    })
      .composite([
        { input: legend, left: 0, top: 0 },
        { input: scene, left, top: LEGEND_HEIGHT },
      ])
      .png()
      .toBuffer();
    return {
      data: rendered,
      mime: "image/png" as const,
      width: canvasWidth,
      height: canvasHeight,
      view,
      sourceRect,
      contentRect: {
        left,
        top: LEGEND_HEIGHT,
        width: contentWidth,
        height: contentHeight,
      },
    };
  }
  const b = receipt.bounds,
    padding = Math.max(16, Math.ceil(Math.max(b.width, b.height) * 0.15));
  const left = Math.max(0, b.left - padding),
    top = Math.max(0, b.top - padding),
    right = Math.min(width, b.left + b.width + padding),
    bottom = Math.min(height, b.top + b.height + padding);
  const [full, local] = await Promise.all([
    frame(result.sourceData, { left: 0, top: 0, width, height }, "source-full"),
    frame(
      result.generatedCanvas,
      { left, top, width: right - left, height: bottom - top },
      "generated-local",
    ),
  ]);
  options.signal?.throwIfAborted();
  // Authorization may have changed while rendering; neither stale frames nor a new receipt are published.
  assertBinding(receipt, await loadRaw(db, ctx, receipt.input, options));
  return { receipt, full, local };
}
