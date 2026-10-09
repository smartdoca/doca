import { objectKey } from "../storage-policy.js";
import { registerStoredObject } from "../stored-objects.js";
import { createHash, randomUUID } from "node:crypto";
import sharp, { type OutputInfo } from "sharp";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import {
  aiConfig,
  requireImageModel,
  lockAIUser,
  type AIModel,
} from "@core/modules/ai/config.js";
import { imageProfileForModel, imageModelIdForOperation, imageSizeForRatio, validImageSize, type ImageOperation } from "@core/modules/ai/image-model-catalog.js";
import { invokeImageProvider, imageProviderPixels, validateImageProviderInput, ImageProviderHttpError, type ImageProviderOutput } from "./image-provider-adapters.js";
import { checkAttachments } from "./attachments.js";
import { visualSourceAccess } from "./session-attachments.js";
import { editRegionsSchema, preserveOutsideRegions, restoreViewport } from "./image-edit-regions.js";
import { prepareImageEdit, imageEditPatch, cropImageReferences, referenceCropsSchema } from "./image-edit-adapter.js";
import { aiJobSessionFolder } from "./session-file-folders.js";
import {
  saveRawImageCandidate, readRawImageCandidateRecord, rawImageReferences,
  saveRevisionRawImageCandidate,
  type RawImageCandidatePointer,
} from "./image-candidates.js";
import { imageRevisionAnyReceiptSchema, imageRevisionAnyBindingSchema, imageRevisionLocalPreviewSchema, isSavedImageReceipt, type ImageRevisionAnyBinding, type ImageRevisionLocalPreview, type RevisionProviderReference } from "./image-revision-contract.js";
import { imageGenerationV1ReceiptSchema } from "./image-generation-contract.js";
import { prepareSavedLocalBitmap, composeSavedLocalBitmap } from "./image-saved-local-bitmap.js";
import { beginCall, settleCall } from "@core/modules/ai/usage.js";
import { imageRelatedJobIds, reserveImageBatchAttempt, type PaidImageAttempt } from "./image-batch-attempts.js";
import { imagePageAttemptLimit } from "./image-attempt-policy.js";
import type { ImageBatchAttemptScope } from "./image-batch.js";
import {
  checkScope,
  checkJob,
  digest,
  type ToolContext,
} from "@core/workflows/ai-documents.js";
import {
  checkStorage,
  requireCapability,
} from "@core/modules/access/operation-policy.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
  type StorageRuntime,
  type StorageConfig,
} from "../../adapters/storage.js";

export const imageInputSchema = z.object({
  resourceId: z.string().uuid().optional(),
  prompt: z.string().trim().min(2).max(8000).describe("清楚、简洁地说明修改目标与参考图对应，避免重复约束和长坐标列表。局部编辑只描述目标变化，系统自动转换工作窗口并定位，勿在提示词中写原页坐标。Seedream 建议中文约300字以内。"),
  filename: z.string().trim().min(1).max(255).regex(/^[^/\\]+$/).optional()
    .describe("交付文件名，批量任务按书名与页码命名"),
  editRegions: editRegionsSchema.optional().describe(
    "仅在用户明确要求指定范围严格原样或局部精修时传入；动作、姿态、背景修改允许自然重绘且仅要求语义保留时省略，用原页参考做整页图生图，避免把新动作裁成旧轮廓。严格局部编辑的图1必须为原页，points是0到1的归一化坐标轮廓[x,y]，原点左上。只合成允许修改的完整目标与文字，区域外逐像素保留原图并输出无损PNG；保护的其他人物/狗/道具排除在轮廓外。先实际看原图，不用大包围矩形代替严格人物轮廓。没有可编辑人物不代表没有动作、背景或文字等修改目标。",
  ),
  referenceCrops:referenceCropsSchema.optional().describe("从六视图/拼图中选择本页需要的身份视角。只裁切图2及之后的参考图，原图和ID保留；box=[left,top,right,bottom]，0到1，左上原点。先看完整参考再选，不得裁切作为底图的图1。无需裁切时省略。"),
  referenceImageIds: z
    .array(z.string().uuid())
    .min(1)
    .max(8)
    .optional()
    .describe(
      "参考图的附件/图片 assetId，或 attachment_read/file_read 返回的 referenceImageId，按提示词中的图1、图2顺序排列。用户提供参考图或要求修改已有图片时必须传入；从当前会话参考图片或图片回执选择，不要使用文件 fileId。不需要参考图时省略。",
    ),
  aspectRatio: z
    .enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
    .optional()
    .describe("支持的图片长宽比；与 size 二选一"),
  size: z
    .string()
    .regex(/^\d{2,4}x\d{2,4}$/)
    .optional()
    .describe(
      "通常省略；原生 Seedream 参考图编辑按图1比例选择不低于原页分辨率的合法高分辨率，其他任务使用配置默认尺寸。仅在用户明确指定且模型支持时传入",
    ),
}).strict();
export type ImageInput = z.infer<typeof imageInputSchema>;
type ImageReference = Pick<
  Schema["assets"],
  "id" | "filename" | "mime" | "size" | "object_key" | "profile_id"
>;

/** Reference membership comes from owned session records, never model-supplied IDs alone. */
export async function availableImageReferences(db: DB, ctx: ToolContext, requestedIds?: readonly string[]) {
  if (!ctx.jobId) return [];
  const wanted=requestedIds?new Set(requestedIds):undefined;
  if(wanted?.size===0) return [];
  const job = await db
    .selectFrom("ai_jobs as j")
    .innerJoin("ai_sessions as s", "s.id", "j.session_id")
    .select(["j.session_id", "j.created_at"])
    .where("j.id", "=", ctx.jobId)
    .where("j.user_id", "=", ctx.actor.id)
    .where("s.user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!job) fail(404, "参考图片的会话不存在或无权访问");
  const [jobs, operations] = await Promise.all([
    db
      .selectFrom("ai_jobs")
      .select("input")
      .where("session_id", "=", job.session_id)
      .where("user_id", "=", ctx.actor.id)
      .where("created_at", "<=", job.created_at)
      .orderBy("created_at", "desc")
      .execute(),
    db
      .selectFrom("ai_operations as o")
      .innerJoin("ai_jobs as j", "j.id", "o.job_id")
      .select("o.result")
      .where("j.session_id", "=", job.session_id)
      .where("j.user_id", "=", ctx.actor.id)
      .where("o.user_id", "=", ctx.actor.id)
      .where("j.created_at", "<=", job.created_at)
      .where((eb) =>
        eb.or([
          eb("o.result", "like", '%"image_generation"%'),
          eb("o.result", "like", '%"image_revision"%'),
          eb("o.result", "like", '%"file_image_reference"%'),
        ]),
      )
      .$if(!!wanted,query=>query.where(eb=>eb.or([...wanted!].map(id=>eb("o.result","like",`%${id}%`)))))
      .orderBy("o.created_at", "desc")
      .execute(),
  ]);
  const ids = new Set<string>();
  const pages: ImageReference[] = [];
  for (const row of jobs)
    for (const id of JSON.parse(row.input).attachments ?? []) if(!wanted||wanted.has(id)) ids.add(id);
  for (const row of operations) {
    const result = JSON.parse(row.result);
    if (result.kind === "file_image_reference") {
      if(wanted&&!wanted.has(result.referenceImageId)) continue;
      try {
        const objectId = await visualSourceAccess(db, ctx, result.source);
        if (objectId !== result.objectId) continue;
        const derived = await db
          .selectFrom("file_derivatives")
          .selectAll()
          .where("id", "=", result.referenceImageId)
          .where("source_id", "=", objectId)
          .where("kind", "=", "extract-image")
          .executeTakeFirst();
        if (derived) pages.push({ ...derived, filename: result.filename });
      } catch {
        /* Revoked/deleted sources do not grant access to their page images. */
      }
    }
    if (
      isSavedImageReceipt(result) &&
      result.assetId && (!wanted||wanted.has(result.assetId))
    )
      ids.add(result.assetId);
  }
  const rows = ids.size
    ? await db
        .selectFrom("assets")
        .selectAll()
        .where("id", "in", [...ids])
        .where("owner_id", "=", ctx.actor.id)
        .where("purpose", "=", "ai_attachment")
        .where("deleted_at", "is", null)
        .where("mime", "like", "image/%")
        .execute()
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [
    ...new Map(
      [...ids]
        .flatMap((id): ImageReference[] =>
          byId.has(id) ? [byId.get(id)!] : [],
        )
        .concat(pages)
        .map((row) => [row.id, row]),
    ).values(),
  ];
}

async function checkImageReferences(db: DB, ctx: ToolContext, ids: string[], missingMessage = "参考图片不存在、已删除或不属于当前会话；请调用 session_attachments 或 attachment_read 查询当前有效 ID，不能推断为刷新失效。") {
  if (new Set(ids).size !== ids.length) fail(400, "参考图片不能重复");
  const available = new Map(
    (await availableImageReferences(db, ctx, ids)).map((row) => [row.id, row]),
  );
  return ids.map((id) => {
    const row = available.get(id);
    if (!row)
      fail(
        404,
        missingMessage,
      );
    return row;
  });
}

export async function readReferenceImages(
  db: DB,
  ctx: ToolContext,
  ids: string[],
  runtime: StorageRuntime = storageRuntime(),
) {
  const rows = await checkImageReferences(db, ctx, ids, "参考图片不存在、已删除或不属于当前会话");
  const storage = createStorage(runtime);
  const images: { data: Buffer; mime: string; filename: string }[] = [];
  for (const row of rows) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(row.mime))
      fail(400, "参考图片仅支持 PNG、JPEG 和 WebP");
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("id", "=", row.profile_id)
      .executeTakeFirstOrThrow();
    const data = await storage.read(
      storageConfigForProfile(runtime, profile),
      row.object_key,
      row.size,
    );
    if (data.length !== row.size) fail(409, "参考图片内容已改变，请重新上传");
    try {
      const image = sharp(data, { limitInputPixels: 25000000 });
      const metadata = await image.metadata();
      if (`image/${metadata.format}` !== row.mime || (metadata.pages ?? 1) > 1)
        fail(400, "参考图片格式与内容不一致或包含多帧");
      // Decode as well as inspecting metadata so corrupt pixels are rejected before billing.
      await image.stats();
    } catch {
      fail(400, "参考图片无法解析、格式不支持或分辨率过大");
    }
    images.push({ data, mime: row.mime, filename: row.filename });
  }
  return images;
}

/** Read a retained intermediate candidate, never treat it as a delivery or identity reference. */
export async function readRawImageCandidate(
  db: DB, ctx: ToolContext, generationOperationId: string,
  runtime: StorageRuntime = storageRuntime(),
) {
  return readRawImageCandidateRecord(db, ctx, generationOperationId, {
    storage: runtime,
    readReferences: ids => readReferenceImages(db, ctx, ids, runtime),
  });
}

export async function testAIImageModel(model: AIModel, fetcher: typeof fetch = fetch) {
  const profile = imageProfileForModel(model);
  if (!profile) fail(400, "请选择支持的图片模型规格", { code: "image_profile_invalid" });
  // Editing-only models are tested with an isolated generated fixture, not user data.
  const operation = profile.operations.includes("generate") ? "generate" : "edit";
  const images = operation === "generate" ? [] : [{
    data: await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#4080b0" } }).png().toBuffer(),
    mime: "image/png", filename: "connection-test.png",
  }];
  try {
    const output = await invokeImageProvider({
      profile, model: model.model, baseUrl: model.baseUrl, apiKey: model.apiKey ?? "",
      operation, prompt: "Doca 图片连接测试，请生成简单彩色几何图形。", size: model.imageSize ?? profile.defaultSize, images,
    }, { fetch: fetcher });
    return {
      usage: { inputTokens: { total: output.inputTokens }, outputTokens: { total: output.outputTokens } },
      nativeUsage: output.usage, images: 1,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(502, "图片模型连接失败，请检查模型标识、接口和密钥", { code: "image_connection_failed" });
  }
}

export async function generateImageAsset(
  db: DB,
  ctx: ToolContext,
  input: ImageInput,
  operationId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    storage?: StorageRuntime;
    relatedJobIds?: string[];
    /** Host-verified persistent batch binding; never accepted from model input. */
    batchAttemptScope?: ImageBatchAttemptScope;
    /** Export an unchanged reference page without calling or charging a model. */
    exportOnly?: boolean;
    operation?: ImageOperation;
    /** Isolated URL-download test seam; provider credentials are never passed. */
    downloadImage?: (url: string, signal?: AbortSignal) => Promise<Buffer>;
    /** Explicit whole/local contract. Caller validates current base and actual view proof. */
    savedRevision?: { binding: ImageRevisionAnyBinding; previewBinding?:ImageRevisionLocalPreview; validate: (db: DB) => Promise<void> };
  } = {},
) {
  if (input.aspectRatio && input.size)
    fail(400, "图片长宽比和尺寸只能选择一个");
  const config = await aiConfig(db);
  const operation = options.operation ?? "generate";
  const modelId = options.exportOnly
    ? config.imageModel || Object.values(config.imageToolModels ?? {}).find(Boolean) || ""
    : imageModelIdForOperation(config, operation);
  if (!modelId)
    fail(400, "未配置图片生成模型，请管理员在 AI 模型管理的工具配置中选择", { code: "image_model_missing" });
  const { model, profile } = await requireImageModel(
    db,
    ctx.actor.id,
    modelId,
    options.exportOnly ? undefined : operation,
  );
  await requireCapability(db, ctx.actor.id, "assets.upload");
  if (ctx.writable === false) fail(403, "本次授权仅允许读取");
  const runtime = options.storage ?? storageRuntime();
  const referenceIds = input.referenceImageIds ?? [];
  const revision = options.savedRevision;
  if(revision) imageRevisionAnyBindingSchema.parse(revision.binding);
  const localBinding=revision?.binding.version===2&&revision.binding.mode==="local"?revision.binding:undefined;
  if(localBinding && (!revision?.previewBinding||!imageRevisionLocalPreviewSchema.safeParse(revision.previewBinding).success||digest(revision.previewBinding.binding)!==digest(localBinding)))
    fail(409,"局部续改缺少当前选区的实际查看绑定");
  if(revision && (operation!=="edit" || options.exportOnly || input.editRegions ||
      referenceIds[0]!==revision.binding.base.referenceImageId))
    fail(400,"成品续改仅支持明确当前底图的整页编辑",{code:"image_revision_local_unsupported"});
  if (!options.exportOnly) {
    if (operation === "generate" && referenceIds.length) fail(400, "文生图不能传参考图，请使用参考图生图或图片编辑工具", { code: "image_generate_references" });
    if (operation !== "generate" && !referenceIds.length) fail(400, "参考图生图和图片编辑必须提供图片", { code: "image_edit_original_missing" });
    if (referenceIds.length > profile.maxReferences) fail(400, "参考图片数量超过模型上限", { code: "image_reference_limit", data: { count: profile.maxReferences } });
    if (operation !== "edit" && (input.editRegions || input.referenceCrops)) fail(400, "局部编辑和参考裁切参数仅用于图片编辑", { code: "image_edit_regions_invalid" });
  }
  if (input.referenceImageIds !== undefined) {
    const parsed =
      imageInputSchema.shape.referenceImageIds.safeParse(referenceIds);
    if (!parsed.success) fail(400, "参考图片参数无效，最多选择 8 张图片");
    await checkJob(db, ctx);
  }
  const referenceImages = referenceIds.length
    ? await readReferenceImages(db, ctx, referenceIds, runtime)
    : [];
  if (options.exportOnly && (referenceImages.length !== 1 || input.editRegions))
    fail(400, "原图导出只接受一张参考图且不能编辑");
  if (input.editRegions && !referenceImages.length)
    fail(400, "局部编辑必须提供原图作为第一张参考图");
  if (input.editRegions && !editRegionsSchema.safeParse(input.editRegions).success)
    fail(400, "局部编辑轮廓无效");
  if (input.referenceCrops && (!referenceCropsSchema.safeParse(input.referenceCrops).success || input.referenceCrops.some(crop => referenceIds.indexOf(crop.referenceImageId) < 1)))
    fail(400, "参考裁切只允许图2及之后的实际参考 ID 与有效边界", { code: "image_reference_crops_invalid" });
  const selectedReferences = await cropImageReferences(referenceImages, referenceIds, input.referenceCrops);
  let edit = await prepareImageEdit(profile.editMechanism, input.prompt, selectedReferences, input.editRegions);
  if(localBinding){
    if(referenceIds.at(-1)!==localBinding.original.referenceImageId) fail(400,"局部续改必须显式附带最后一张原页上下文");
    const prepared=await prepareSavedLocalBitmap(referenceImages[0]!.data,localBinding.localFacts.region,profile,localBinding.localFacts.contextPaddingPixels);
    if(digest(prepared.facts)!==digest(localBinding.localFacts)) fail(409,"局部续改工作窗口或模型规格已变化");
    if(input.aspectRatio||(input.size&&input.size!==prepared.facts.provider.requestedSize)) fail(400,"局部续改尺寸必须属于已查看的工作窗口");
    const f=prepared.facts,r=f.nativeRect,c=f.contextCrop,w=f.workspace;
    const coordinate=(value:number)=>Math.max(0,Math.min(999,Math.round(value*1000)));
    const box=[(w.contentRect.left+(r.left-c.left)*w.scale.x)/w.width,(w.contentRect.top+(r.top-c.top)*w.scale.y)/w.height,
      (w.contentRect.left+(r.left+r.width-c.left)*w.scale.x)/w.width,(w.contentRect.top+(r.top+r.height-c.top)*w.scale.y)/w.height].map(coordinate);
    const locator=profile.editMechanism==="coordinates"?`仅编辑 Image 1 <bbox>${box.join(" ")}</bbox> 中明确目标；框只定位，不绘制。`:"仅修复图1工作窗口中明确目标。";
    edit={...edit,images:[{...selectedReferences[0]!,data:prepared.providerPNG,mime:"image/png"},...edit.images.slice(1)],
      prompt:`图1是当前成品的裁切工作窗口，输出保持图1的视野、物体尺度与构图。${locator}保留无关物体、背景颜色纹理和窗口边缘。图${referenceIds.length}原书页只核对故事、动作和文字，禁止把整幅参考页或缩略图贴进窗口，不重置已有修改；其他图为参考。要求：${input.prompt}`};
  }
  const { viewport } = edit;
  let automaticSize: string | undefined;
  if(localBinding) automaticSize=localBinding.localFacts.provider.requestedSize;
  else if (input.aspectRatio) {
    const [width, height] = input.aspectRatio.split(":").map(Number);
    automaticSize = imageSizeForRatio(profile, width! / height!);
  } else if (!input.size && operation === "edit" && referenceImages.length && !options.exportOnly) {
    // Prefer a legal source canvas rather than needlessly enlarging an edit.
    // A saved base may have the provider's changed canvas; a revision instead
    // requests the frozen original page. Explicit output instructions still win.
    const source = revision?.binding.original ?? viewport?.rect ?? (await sharp(referenceImages[0]!.data).metadata()).autoOrient;
    const ratio = source.width / source.height;
    const originalSize = `${source.width}x${source.height}`;
    automaticSize = validImageSize(profile, originalSize)
      ? originalSize
      : viewport && profile.adapter === "openai-images"
        ? model.imageSize ?? profile.defaultSize : imageSizeForRatio(profile, ratio);
    if (automaticSize) {
      const [width, height] = automaticSize.split("x").map(Number);
      if (width! < source.width || height! < source.height) automaticSize = undefined;
    }
    automaticSize ??= imageSizeForRatio(profile, ratio, source);
    // A local work window may be padded to a fixed-size model's legal aspect.
    if (!automaticSize && viewport && profile.limits.sizes) {
      automaticSize = [...profile.limits.sizes].sort((a, b) => {
        const ar = a.split("x").map(Number), br = b.split("x").map(Number);
        return Math.abs(ar[0]! / ar[1]! - ratio) - Math.abs(br[0]! / br[1]! - ratio);
      }).find(size => {
        const [width, height] = size.split("x").map(Number);
        return width! >= source.width && height! >= source.height;
      });
    }
    if (!automaticSize) fail(400, "底图尺寸或比例超过模型支持范围，无法保持源分辨率", { code: "image_reference_size_unsupported" });
  }
  if (input.aspectRatio && !automaticSize) fail(400, "所选模型不支持该比例", { code: "image_size_invalid" });
  const size = input.size ?? automaticSize ?? model.imageSize ?? profile.defaultSize;
  const dimensions = size.split("x").map(Number);
  if (!options.exportOnly && !validImageSize(profile, size)) fail(400, "所选模型不支持该图片尺寸", { code: "image_size_invalid" });
  if (viewport) edit = await prepareImageEdit(profile.editMechanism, input.prompt, selectedReferences, input.editRegions, { width: dimensions[0]!, height: dimensions[1]! });
  // Validate the exact transport before reserving a paid attempt or a usage call.
  const providerInput = { profile, model: model.model, baseUrl: model.baseUrl, apiKey: model.apiKey!, operation,
    prompt: edit.prompt, size, images: edit.images, ...(edit.mask ? { mask: edit.mask } : {}) };
  if (!options.exportOnly) await validateImageProviderInput(providerInput, options.signal);
  const transportImages = edit.images;
  const generation = { prompt: input.prompt, referenceImageIds: referenceIds, ...(input.editRegions ? { editRegions: input.editRegions } : {}), ...(input.referenceCrops ? { referenceCrops: input.referenceCrops } : {}) };
  const providerReferences:RevisionProviderReference[]|undefined=revision?.binding.version===2?await Promise.all(transportImages.map(async(image,index)=>{
    const meta=await sharp(image.data).metadata();return {order:index,role:index===0?(localBinding?"base-viewport":"base"):referenceIds[index]===revision.binding.original.referenceImageId?"original-context":"identity",referenceImageId:referenceIds[index]!,sha256:createHash("sha256").update(image.data).digest("hex"),size:image.data.length,width:meta.autoOrient.width,height:meta.autoOrient.height,mime:image.mime as RevisionProviderReference["mime"]};
  })):undefined;
  const operationKind=revision?"image_revision":"image_generation";
  const receiptRequest=revision?{version:revision.binding.version,...(revision.binding.version===2?{mode:revision.binding.mode,providerReferences,...(localBinding?{previewBinding:revision.previewBinding}: {})}:{}),originalReferenceImageId:revision.binding.original.referenceImageId,
    binding:revision.binding,providerReferenceImageIds:referenceIds,
    reviewGeneration:{...generation,referenceImageIds:[revision.binding.original.referenceImageId,...referenceIds.slice(1).filter(id=>id!==revision.binding.original.referenceImageId)]}}:{...(options.batchAttemptScope?.version===3?{version:1}:{}),generation};
  const identity = digest({ ...input, operation, modelId: model.id, ...(options.exportOnly ? { exportOnly: true } : {}), ...(options.batchAttemptScope ? { batchAttemptScope: options.batchAttemptScope } : {}), ...(revision ? { savedRevision:revision.binding } : {}) });
  let paidAttempt: PaidImageAttempt | undefined;
  const existing = await transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    await checkJob(tx, ctx);
    if (referenceIds.length) await checkImageReferences(tx, ctx, referenceIds);
    if(revision) await revision.validate(tx);
    const resource = input.resourceId
      ? (await checkScope(tx, ctx, input.resourceId, true)).resource
      : undefined;
    if (resource && resource.kind !== "document")
      fail(400, "请先创建用于放置图片的文档或画板");
    const old = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", operationId)
      .executeTakeFirst();
    if (old) {
      if (old.user_id !== ctx.actor.id || old.digest !== identity)
        fail(409, "图片操作标识冲突");
    }
    paidAttempt = await reserveImageBatchAttempt(tx, ctx, options.batchAttemptScope, revision?.binding.original.referenceImageId ?? referenceIds[0],
      { paid: !options.exportOnly, ...(old ? { existingResult: JSON.parse(old.result) } : {}) });
    if(revision) imageRevisionAnyReceiptSchema.parse({kind:operationKind,state:"generating",generationOperationId:operationId,
      resourceId:input.resourceId,...receiptRequest,paidAttempt});
    if (old) return JSON.parse(old.result);
    const relatedJobs = await imageRelatedJobIds(tx, ctx, options.relatedJobIds);
    // A document (or a chat with no resourceId) can receive several different
    // images. Guard the request identity, not the shared destination.
    let pendingQuery = tx
          .selectFrom("ai_operations")
          .select("result")
          .where("user_id", "=", ctx.actor.id)
          .where("digest", "=", identity);
    if (!paidAttempt) pendingQuery = pendingQuery.where("job_id", "in", relatedJobs);
    const pending = ctx.jobId
      ? await pendingQuery.execute()
      : [];
    const blocked = pending
      .map((r) => JSON.parse(r.result))
      .find(
        (value) =>
          value.kind === operationKind &&
          ["generating", "save_failed"].includes(value.state),
      );
    if (blocked)
      fail(
        409,
        blocked.state === "save_failed"
          ? blocked.rawCandidate
            ? `相同的图片请求已生成但保存失败，原始候选已保留（生成操作 ID：${blocked.generationOperationId}）；请核对候选并本地重新合成，不能重复提交或计费生成`
            : "相同的图片请求已生成但保存失败，不能重复提交；请联系管理员检查存储"
          : "相同的图片请求正在生成或结果待核对，不能重复提交；请先核对已有结果",
        { code: blocked.state === "save_failed" ? "image_save_failed_retry_blocked" : "image_result_uncertain" },
      );
    if (ctx.jobId && referenceIds.length && !options.exportOnly && !paidAttempt) {
      const attempts = await tx.selectFrom("ai_operations").select("result")
        .where("user_id", "=", ctx.actor.id).where("job_id", "in", relatedJobs).execute();
      const samePage = attempts.map(row => JSON.parse(row.result)).filter(value =>
        value.kind === "image_generation" && value.generation?.referenceImageIds?.[0] === referenceIds[0] && !["reference-export", "local-recomposition"].includes(value.origin));
      const limit = imagePageAttemptLimit();
      if (samePage.length >= limit)
        fail(409, `本页已提交${limit}次图片请求，已停止继续计费尝试。请保留失败证据并调整方案后继续，不能放宽验收标准。`, { code: "image_page_attempt_limit" });
    }
    await tx
      .insertInto("ai_operations")
      .values({
        id: operationId,
        user_id: ctx.actor.id,
        job_id: ctx.jobId ?? null,
        digest: identity,
        result: JSON.stringify({
          kind: operationKind,
          state: "generating",
          generationOperationId: operationId,
          resourceId: input.resourceId,
          ...receiptRequest,
          ...(paidAttempt ? { paidAttempt } : {}),
          ...(options.exportOnly ? { origin: "reference-export" } : {}),
        }),
        created_at: new Date().toISOString(),
      })
      .execute();
    return null;
  });
  if (existing) {
    if (existing.state === "save_failed")
      fail(
        409,
        existing.rawCandidate
          ? `这次图片已生成但最终保存失败，原始候选已保留（生成操作 ID：${operationId}）；请先核对候选并本地重新合成，不能重复计费生成`
          : "这次图片已生成但保存失败，未确认持久原始候选；请先核对存储，不能用最终图片补造 raw 或重复计费生成",
        { code: "image_save_failed_retry_blocked" },
      );
    if (!existing.assetId)
      fail(
        409,
        "这次图片请求已执行或结果待核对，请勿重复生成。可查看任务记录后重新提出生成要求。",
        { code: existing.state === "failed" ? "image_request_failed" : "image_request_already_executed" },
      );
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", existing.assetId)
      .where("owner_id", "=", ctx.actor.id)
      .where("resource_id", "is", null)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!asset) fail(404, "生成的图片已不可用");
    return {
      ...existing,
      ready: true,
    };
  }
  let call: Awaited<ReturnType<typeof beginCall>> | undefined = undefined;
  try {
    if (!options.exportOnly) call = await beginCall(
      db,
      ctx.actor.id,
      model.id,
      ctx.jobId ?? null,
      0,
      0,
      1,
      size,
    );
  } catch (error) {
    // Batch reservations survive an unknown call-registration outcome. A lost
    // beginCall response is not proof its ledger transaction rolled back.
    if (!paidAttempt) await db
      .deleteFrom("ai_operations")
      .where("id", "=", operationId)
      .execute();
    throw error;
  }
  const storage = createStorage(runtime);
  let stored: { config: StorageConfig; key: string } | undefined;
  let committed = false,
    settled = false,
    definitiveRejection = false;
  let rawCandidate: RawImageCandidatePointer | Awaited<ReturnType<typeof saveRevisionRawImageCandidate>> | undefined;
  try {
    options.signal?.throwIfAborted();
    let output: ImageProviderOutput | undefined;
    let providerPixels: Buffer;
    if (options.exportOnly) {
      providerPixels = referenceImages[0]!.data;
      settled = true;
    } else {
      if(revision) await revision.validate(db);
      options.signal?.throwIfAborted();
      try {
        output = await invokeImageProvider(providerInput, { fetch: options.fetch, signal: options.signal });
      } catch (error) {
        if (error instanceof ImageProviderHttpError && [400, 401, 403, 404, 422, 429].includes(error.upstreamStatus)) {
          await settleCall(db, call!.id, { input: 0, output: 0, images: 0, raw: { images: 0, upstreamStatus: error.upstreamStatus } }, "failed");
          settled = true;
          definitiveRejection = true;
        }
        if (error instanceof ImageProviderHttpError && error.contentRejectionCode)
          throw error;
        if (error instanceof ImageProviderHttpError && operation !== "generate" && ![401, 403].includes(error.upstreamStatus))
          fail(502, `图生图调用失败（HTTP ${error.upstreamStatus}）；请检查模型接口与尺寸，不会自动改为文生图`, { code: "image_edit_failed", data: { status: error.upstreamStatus } });
        throw error;
      }
      // A completed paid generation remains paid even if its temporary URL fails.
      await settleCall(db, call!.id, { input: output.inputTokens, output: output.outputTokens, images: 1,
        raw: { images: 1, unit: "image", ...(output.usage !== undefined ? { nativeUsage: output.usage } : {}),
          ...(output.requestId ? { requestId: output.requestId } : {}) } });
      settled = true;
      providerPixels = await imageProviderPixels(output, revision ? undefined : options.signal, options.downloadImage);
    }
    if (!options.exportOnly) {
      const references = await rawImageReferences(referenceIds, referenceImages);
      const transportDimensions = await Promise.all(transportImages.map(async image => {
        const meta = await sharp(image.data).metadata();
        return { width: meta.autoOrient.width, height: meta.autoOrient.height };
      }));
      const rawInput = {
        generationOperationId: operationId, providerCallId: call!.id,
        bytes: providerPixels, references, resourceId: input.resourceId ?? null,
        request: { modelId: model.id, model: model.model,
          protocol: output!.protocol,
          prompt: edit.prompt, size: { width: dimensions[0]!, height: dimensions[1]! }, transportDimensions },
        transform: viewport ? { kind: "viewport" as const, rect: viewport.rect, workspace: edit.workspace ?? null } : { kind: "full" as const },
        nativeUsage: output!.usage === undefined ? { state: "not-reported" as const } : { state: "reported" as const, value: output!.usage },
      };
      const rawOptions = {
        storage: runtime, ...(revision ? {} : {signal:options.signal}),
        authorize: async (tx: DB) => {
          if (referenceIds.length) await checkImageReferences(tx, ctx, referenceIds);
          if (input.resourceId) await checkScope(tx, ctx, input.resourceId, true);
        },
      };
      rawCandidate = revision ? revision.binding.version===1
        ? await saveRevisionRawImageCandidate(db,ctx,{...rawInput,binding:revision.binding},rawOptions)
        : await saveRevisionRawImageCandidate(db,ctx,{...rawInput,binding:revision.binding,mode:revision.binding.mode,providerReferences:providerReferences!,transform:localBinding?{kind:"saved-local",facts:localBinding.localFacts}:{kind:"full"}},rawOptions)
        : await saveRawImageCandidate(db,ctx,rawInput,rawOptions);
    }
    let rendered: { data: Buffer; info: OutputInfo };
    let preservation: Awaited<ReturnType<typeof preserveOutsideRegions>>["preservation"] | undefined;
    let localComposition:Awaited<ReturnType<typeof composeSavedLocalBitmap>>|undefined;
    const mime = "image/png";
    try {
      const decoder = sharp(providerPixels, {
        limitInputPixels: 25000000,
        animated: false,
      });
      const meta = await decoder.metadata();
      if (!["png", "jpeg", "webp", "gif"].includes(meta.format ?? ""))
        fail(502, "图片格式不支持");
      if(localBinding){
        localComposition=await composeSavedLocalBitmap(referenceImages[0]!.data,providerPixels,localBinding.localFacts);
        rendered={data:localComposition.data,info:{width:localComposition.result.width,height:localComposition.result.height,channels:4,format:"png",size:localComposition.data.length,premultiplied:false,hasAlpha:true}};
      } else if (input.editRegions) {
        const generated = viewport ? await restoreViewport(referenceImages[0]!.data, await imageEditPatch(edit, providerPixels), viewport.rect) : providerPixels;
        const preserved = await preserveOutsideRegions(referenceImages[0]!.data, generated, input.editRegions);
        rendered = preserved;
        preservation = preserved.preservation;
      } else {
        rendered = await decoder.rotate().png().toBuffer({ resolveWithObject: true });
      }
    } catch {
      fail(502, "生成图片无法解析或分辨率过大");
    }
    if (rendered.data.length > 20 * 1024 * 1024) fail(413, "生成图片文件过大");
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow();
    const storageConfig = storageConfigForProfile(runtime, profile);
    const assetId = randomUUID(),
      key = objectKey(assetId, mime),
      filename = `${input.filename?.replace(/\.[^.]+$/, "") || `AI-${assetId.slice(0, 8)}`}.png`;
    options.signal?.throwIfAborted();
    await storage.put(
      storageConfig,
      key,
      rendered.data,
      mime,
      filename,
    );
    stored = { config: storageConfig, key };
    const result = await transact(db, async (tx) => {
      options.signal?.throwIfAborted();
      await lockAIUser(tx, ctx.actor.id);
      await checkJob(tx, ctx);
      await requireCapability(tx, ctx.actor.id, "ai.create");
      if (referenceIds.length)
        await checkImageReferences(tx, ctx, referenceIds);
      if(revision) await revision.validate(tx);
      if (input.resourceId) await checkScope(tx, ctx, input.resourceId, true);
      await requireCapability(tx, ctx.actor.id, "assets.upload");
      await checkStorage(tx, ctx.actor.id, rendered.data.length);
      const asset: Schema["assets"] = {
        id: assetId,
        owner_id: ctx.actor.id,
        uploaded_by: ctx.actor.id,
        resource_id: null,
        purpose: "ai_attachment",
        profile_id: profile.id,
        object_key: key,
        filename,
        mime,
        size: rendered.data.length,
        created_at: new Date().toISOString(),
        deleted_at: null,
      };
      await tx.insertInto("assets").values(asset).execute();
      const recognitionSetting = await tx
        .selectFrom("file_recognition_settings")
        .select("config")
        .where("id", "=", "default")
        .executeTakeFirst();
      const recognitionConfig = recognitionSetting
        ? (JSON.parse(recognitionSetting.config) as {
            enabled?: boolean;
            modelId?: string | null;
          })
        : {};
      const recognitionEnabled =
        !!recognitionConfig.enabled && !!recognitionConfig.modelId;
      const fileObject: Schema["file_storage_objects"] = {
        id: asset.id,
        profile_id: asset.profile_id,
        object_key: asset.object_key,
        sha256: createHash("sha256").update(rendered.data).digest("hex"),
        size: asset.size,
        mime: asset.mime,
        ai_description: recognitionEnabled ? null : "AI 生成图片",
        ai_status: recognitionEnabled ? "pending" : "skipped",
        ai_model: recognitionEnabled ? recognitionConfig.modelId! : null,
        ai_generated_at: asset.created_at,
        created_at: asset.created_at,
      };
      await registerStoredObject(tx, fileObject);
      await tx
        .insertInto("file_items")
        .values({
          id: randomUUID(),
          owner_id: asset.owner_id,
          parent_type: "system",
          parent_id: "ai",
          storage_object_id: fileObject.id,
          name: asset.filename,
          mime: asset.mime,
          size: asset.size,
          metadata: JSON.stringify({
            assetId: asset.id,
            aiSessionFolder: await aiJobSessionFolder(tx, ctx.actor.id, ctx.jobId),
          }),
          ai_description_override: null,
          locked: 0,
          version: 1,
          created_at: asset.created_at,
          updated_at: asset.created_at,
          deleted_at: null,
          delete_batch: null,
        })
        .execute();
      const sourceItem = await tx
        .selectFrom("file_items")
        .select("id")
        .where("storage_object_id", "=", fileObject.id)
        .where("parent_type", "=", "system")
        .where("parent_id", "=", "ai")
        .executeTakeFirstOrThrow();
      await enqueueProjection(tx, "search-file", sourceItem.id, {
        fileId: sourceItem.id,
      });
      const result = {
        kind: operationKind,
        state: "saved",
        generationOperationId: operationId,
        resourceId: input.resourceId,
        assetId,
        filename,
        width: rendered.info.width,
        height: rendered.info.height,
        mime,
        ...receiptRequest,
        ...(paidAttempt ? { paidAttempt } : {}),
        ...(rawCandidate ? { rawCandidate } : {}),
        ...(call ? { providerCallId: call.id } : {}),
        ...(output?.inputImages !== undefined ? { providerImageUsage: { inputImages: output.inputImages } } : {}),
        ...(preservation ? { preservation } : {}),
        ...(localComposition?{composition:{geometryDigest:localComposition.geometryDigest,actual:localComposition.actual,result:localComposition.result}}:{}),
        ...(options.exportOnly ? { origin: "reference-export" } : {}),
        size: rendered.data.length,
        ready: true,
        url: `/api/v1/assets/${assetId}/content`,
        instruction: input.resourceId
          ? "图片已存入 AI 助手文件夹并展示在对话中。仅在用户要求插入时调用 image_insert；加入文档只会创建位置引用，不会复制图片内容。"
          : "图片已存入 AI 助手文件夹并展示在对话中。用户可预览、下载或点击加入文档；加入文档只会创建位置引用。",
      };
      if(revision) imageRevisionAnyReceiptSchema.parse(result);
      else if(options.batchAttemptScope?.version===3)imageGenerationV1ReceiptSchema.parse(result);
      await tx
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(result) })
        .where("id", "=", operationId)
        .execute();
      await tx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          actor_id: ctx.actor.id,
          resource_id: input.resourceId ?? null,
          action: "ai.image.generated",
          created_at: asset.created_at,
        })
        .execute();
      options.signal?.throwIfAborted();
      return result;
    });
    committed = true;
    return result;
  } catch (error) {
    let failureRecorded = false;
    let recovered: Record<string, any> | undefined;
    try {
      if (definitiveRejection || settled) {
        await transact(db, async tx => {
          const row = await tx.selectFrom("ai_operations").select("result")
            .where("id", "=", operationId).where("user_id", "=", ctx.actor.id)
            .executeTakeFirstOrThrow();
          const current = JSON.parse(row.result);
          if (current.kind !== operationKind || current.generationOperationId !== operationId)
            fail(409, "当前图片操作回执不一致，不能覆盖");
          if (current.state === "saved") {
            committed = true;
            recovered = current;
            return;
          }
          // The raw transaction may have committed even when its response was lost.
          // Preserve that same-operation pointer instead of replacing it from memory.
          if (current.rawCandidate) rawCandidate = current.rawCandidate;
          await tx.updateTable("ai_operations").set({
            result: JSON.stringify({
              ...current,
              state: definitiveRejection ? "failed" : "save_failed",
              ...(rawCandidate ? { rawCandidate } : {}),
              ...(call ? { providerCallId: call.id } : {}),
            }),
          }).where("id", "=", operationId).execute();
        });
        failureRecorded = true;
      }
    } finally {
      // Unknown commit state is not permission to delete a possibly committed object.
      if (stored && !committed && failureRecorded)
        await storage.remove(stored.config, stored.key).catch(() => {});
    }
    if (recovered) return recovered;
    if (!settled && call) await settleCall(db, call.id, null);
    options.signal?.throwIfAborted();
    if (error instanceof AppError) {
      if (!definitiveRejection)
        fail(error.status, rawCandidate
          ? `${error.message}；原始候选已保留（生成操作 ID：${operationId}）${revision ? "，这是整页续改候选，不能使用原页蒙版或免费重合成；先核对持久候选与当前成品" : "，可读取并本地重新合成"}，不能重复计费生成`
          : error.message, { code: settled ? "image_save_failed" : "image_result_uncertain" });
      throw error;
    }
    if (settled)
      fail(
        500,
        rawCandidate
          ? `图片模型已返回结果，但图片保存失败；本次用量已记录，原始候选已保留（生成操作 ID：${operationId}）${revision ? "，这是整页续改候选，不能使用原页蒙版或免费重合成；先核对持久候选与当前成品" : "，可读取并本地重新合成"}，不能重复计费生成`
          : "图片模型已返回结果，但图片保存失败；本次用量已记录，请联系管理员检查存储和数据库",
        { code: "image_save_failed" },
      );
    fail(502, "图片生成未完成，结果和费用待核对，请稍后查看任务记录", { code: "image_result_uncertain" });
  }
}
