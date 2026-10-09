import sharp from "sharp";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { AppError, fail } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import { readRawImageCandidate } from "./images.js";
import {
  rawImageCandidateCanvas,
  rawImageTransformSchema,
} from "./image-candidates.js";
import { modelImage } from "./model-image.js";
import type { ImageReviewSceneContext } from "./image-review.js";

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
export const imageCandidateViewInputSchema = z
  .object({ generationOperationId: z.string().uuid() })
  .strict();
export const imageCandidateViewOutputSchema = z
  .object({
    kind: z.literal("image_candidate_view"),
    state: z.literal("diagnostic-only"),
    generationOperationId: z.string().uuid(),
    referenceImageId: z.string().uuid(),
    source: size.safeExtend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    raw: z
      .object({
        mime: z.enum(["image/png", "image/jpeg"]),
        nativeSize: size,
        displaySize: size,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    transform: rawImageTransformSchema,
    generatedWindow: rect,
    projectedSize: size,
    instruction: z.string(),
  })
  .strict();
export type ImageCandidateViewOutput = z.infer<
  typeof imageCandidateViewOutputSchema
>;
type Options = { storage?: StorageRuntime; vision: boolean };

export async function loadImageCandidateFacts(
  db: DB,
  ctx: ToolContext,
  generationOperationId: string,
  options: Options,
) {
  try {
    return await loadCandidateFacts(db, ctx, generationOperationId, options);
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(503, "图片诊断来源暂不可读取，请查询当前附件和候选；原记录保留", { code: "image_raw_unavailable" });
  }
}

async function loadCandidateFacts(
  db: DB,
  ctx: ToolContext,
  generationOperationId: string,
  options: Options,
) {
  imageCandidateViewInputSchema.parse({ generationOperationId });
  if (!options.vision) fail(409, "原始候选查看需要能读取图片的视觉模型");
  const raw = await readRawImageCandidate(
    db,
    ctx,
    generationOperationId,
    options.storage,
  );
  const source = raw.candidate.references[0];
  if (!source || !raw.sources[0])
    fail(422, "此原始候选没有绑定原页，不能补造来源坐标投影");
  const native = await sharp(raw.data, {
    limitInputPixels: 25_000_000,
  }).metadata();
  const sourceSize = { width: source.width, height: source.height };
  const facts = imageCandidateViewOutputSchema.parse({
    kind: "image_candidate_view",
    state: "diagnostic-only",
    generationOperationId,
    referenceImageId: source.referenceImageId,
    source: { ...sourceSize, sha256: source.sha256 },
    raw: {
      mime: raw.candidate.mime,
      nativeSize: { width: native.width, height: native.height },
      displaySize: raw.candidate.dimensions,
      sha256: raw.candidate.sha256,
    },
    transform: raw.candidate.transform,
    generatedWindow:
      raw.candidate.transform.kind === "viewport"
        ? raw.candidate.transform.rect
        : { left: 0, top: 0, ...sourceSize },
    projectedSize: sourceSize,
    instruction:
      "仅用于诊断的原始候选，不是交付图片或验收通过证明，也不能作为身份参考。投影属于原页坐标；实际生成窗口之外是原稿，没有新生成像素。查看完整人物、肩手和边缘范围不等于授权扩大编辑范围；不能自动将原人物与生成主体取并集覆盖保护对象。raw内容正确但覆盖裁错时，复杂轮廓优先分割原人和新人，准备并实际查看完整蒙版覆盖诊断，下一模型轮次免费image_mask_compose；明确简单轮廓才重新image_edit_preview后轮image_recompose。每条路线都须核对完整目标、保护物和允许遮挡，保持实际查看及后轮门禁；raw内容缺陷才重新生成，最终仍须独立验收。",
  });
  return { raw, facts };
}

/** Only facts enter tool receipts and checkpoints; intermediate pixels remain private. */
export async function viewImageCandidate(
  db: DB,
  ctx: ToolContext,
  generationOperationId: string,
  options: Options,
) {
  return (await loadImageCandidateFacts(db, ctx, generationOperationId, options)).facts;
}

/** Reauthorize before making bounded media; this path never reserves usage or writes an asset. */
export async function imageCandidateViewModelOutput(
  db: DB,
  ctx: ToolContext,
  generationOperationId: string,
  options: Options & { sceneContext: ImageReviewSceneContext | null },
) {
  const { raw, facts } = await loadImageCandidateFacts(
    db,
    ctx,
    generationOperationId,
    options,
  );
  const projected = await rawImageCandidateCanvas(
    raw.candidate,
    raw.data,
    raw.sources[0]!.data,
  );
  if (options.sceneContext !== null && (!options.sceneContext
    || options.sceneContext.currentPage.referenceImageId !== facts.referenceImageId))
    fail(409, "候选场景来源不一致，请重新查看", { code: "image_reference_changed" });
  const scene = options.sceneContext?.adjacentPages.length === 1
    ? options.sceneContext.adjacentPages[0]! : undefined;
  const sceneIndex = scene ? raw.candidate.references.findIndex(reference => reference.referenceImageId === scene.referenceImageId) : -1;
  if (scene && (sceneIndex < 1 || raw.candidate.references[sceneIndex]?.sha256 !== scene.sha256 || !raw.sources[sceneIndex]))
    fail(409, "候选相邻原页字节或引用不一致，请重新查看", { code: "image_reference_changed" });
  const sceneSize = scene ? (await sharp(raw.sources[sceneIndex]!.data).metadata()).autoOrient : undefined;
  const declaration = {
    kind: "image_candidate_view_runtime",
    frameCount: scene ? 4 : 3,
    sceneReferenceImageId: scene?.referenceImageId ?? null,
    sceneStatus: scene ? "included" : "not-merged",
    reason: scene ? null : options.sceneContext ? "multiple-adjacent-scenes" : "no-bound-adjacent-scene",
  };
  const frames = [
    {
      label: "绑定原页；所有编辑轮廓归一化坐标以此原页为准。",
      view: "source",
      coordinateSpace: "source",
      data: raw.sources[0]!.data,
    },
    {
      label:
        "厂商原始候选，按显示方向展示；其坐标属于生成工作空间，不能直接当原页坐标。",
      view: "raw",
      coordinateSpace: "generation-workspace",
      data: raw.data,
    },
    {
      label:
        "原始候选投影到原页坐标；只有实际生成窗口具有生成像素，窗口之外是原稿。",
      view: "source-projection",
      coordinateSpace: "source",
      data: projected,
    },
    ...(scene ? [{
      label: `同一冻结PDF的相邻原场景，物理第${scene.physicalPage}页；不是身份参考或用户授权，宿主不声明肢体归属。结合实际连续画面判断；该页坐标不能用来画当前页蒙版。`,
      view: "scene-context",
      coordinateSpace: "scene-source-page",
      data: raw.sources[sceneIndex]!.data,
    }] : []),
  ];
  const previews = await Promise.all(
    frames.map(async (frame) => ({
      label: frame.label,
      view: frame.view,
      coordinateSpace: frame.coordinateSpace,
      image: await modelImage(frame.data),
    })),
  );
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: JSON.stringify(facts) },
      // Explicit current runtime group; canonical facts and durable raw v1 stay unchanged.
      { type: "text" as const, text: JSON.stringify(declaration) },
      ...previews.flatMap((frame) => [
        {
          type: "text" as const,
          text: JSON.stringify({
            label: frame.label,
            view: frame.view,
            coordinateSpace: frame.coordinateSpace,
            referenceImageId: frame.view === "scene-context" ? scene!.referenceImageId : facts.referenceImageId,
            generationOperationId: facts.generationOperationId,
            sourceFilename: frame.view === "scene-context" ? raw.sources[sceneIndex]!.filename : raw.sources[0]!.filename,
            ...(frame.view === "scene-context" ? {
              role: "scene-context", nonCitable: true,
              currentReferenceImageId: facts.referenceImageId,
              physicalPage: scene!.physicalPage,
              currentPhysicalPage: options.sceneContext!.currentPage.physicalPage,
              sourceObjectId: options.sceneContext!.objectId,
              sourceSha256: options.sceneContext!.sha256,
              sceneSha256: scene!.sha256,
              sourceRect: { left: 0, top: 0, ...sceneSize! },
            } : {}),
            ...(frame.view !== "raw" && frame.view !== "scene-context"
              ? { sourceRect: { left: 0, top: 0, ...facts.projectedSize } }
              : {}),
            ...(frame.view === "source-projection"
              ? { generatedWindow: facts.generatedWindow }
              : {}),
          }),
        },
        {
          type: "media" as const,
          mediaType: frame.image.mime,
          data: frame.image.data.toString("base64"),
        },
      ]),
    ],
  };
}
