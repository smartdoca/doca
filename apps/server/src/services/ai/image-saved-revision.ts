import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "@core/shared/errors.js";
import { lockAIUser,aiConfig,requireImageModel } from "@core/modules/ai/config.js";
import { imageModelIdForOperation } from "@core/modules/ai/image-model-catalog.js";
import {
  checkJob,
  digest,
  type ToolContext,
} from "@core/workflows/ai-documents.js";
import { type StorageRuntime } from "../../adapters/storage.js";
import { requireImageBatch, type ImageBatch } from "./image-batch.js";
import { verifyImageBatchRequirements } from "./image-batch-requirements.js";
import {
  validatePaidImageAttemptScope,
  verifyImageBatchAttemptScope,
  upgradeImageBatchAttemptScope,
  upgradeLocalImageBatchAttemptScope,
} from "./image-batch-attempts.js";
import {
  readReferenceImages,
  readRawImageCandidate,
  generateImageAsset,
  type ImageInput,
} from "./images.js";
import { readAnyRevisionRawImageCandidateRecord } from "./image-candidates.js";
import {
  imageRevisionAnyBindingSchema,
  anySavedRevision,
  isSavedImageReceipt,
  type ImageRevisionAnyBinding,
  imageRevisionLocalBindingV2Schema,imageRevisionLocalPreviewSchema,imageRevisionBindingDigest,
} from "./image-revision-contract.js";
import { imageEditSavedInputSchema,imageEditSavedLocalInputSchema } from "./image-tool-schemas.js";
import { prepareSavedLocalBitmap,savedLocalBitmapPreview,composeSavedLocalBitmap } from "./image-saved-local-bitmap.js";
import { reconstructRevisionProviderReferences } from "./image-revision-provider-references.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pointerSchema = z
  .object({
    version: z.literal(1),
    receiptId: z.string().uuid(),
    assetId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
async function jobContext(db: DB, ctx: ToolContext) {
  await checkJob(db, ctx);
  if (!ctx.jobId) fail(409, "成品续改必须绑定当前批次任务");
  const job = await db
    .selectFrom("ai_jobs as j")
    .innerJoin("ai_sessions as s", "s.id", "j.session_id")
    .select(["j.id", "j.session_id", "j.result"])
    .where("j.id", "=", ctx.jobId)
    .where("j.user_id", "=", ctx.actor.id)
    .where("s.user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!job) fail(403, "成品续改任务不属于当前账号或会话");
  return job;
}

/** Shared strict reader for an existing saved artifact; this never rewrites its receipt. */
export async function verifySavedBatchArtifact(
  db: DB,
  ctx: ToolContext,
  batch: ImageBatch,
  referenceImageId: string,
  assetId: string,
  storage?: StorageRuntime,
) {
  const job = await jobContext(db, ctx);
  if (
    !batch.books.some((book) =>
      book.pages.some((page) => page.referenceImageId === referenceImageId),
    )
  )
    fail(409, "成品不属于冻结原页清单");
  const rows = await db
    .selectFrom("ai_operations as o")
    .innerJoin("ai_jobs as j", "j.id", "o.job_id")
    .select([
      "o.id",
      "o.digest",
      "o.result",
      "o.user_id",
      "o.job_id",
      "o.created_at",
    ])
    .where("o.user_id", "=", ctx.actor.id)
    .where("j.user_id", "=", ctx.actor.id)
    .where("j.session_id", "=", job.session_id)
    .where("o.result", "like", `%"assetId":"${assetId}"%`)
    .execute();
  const matches = rows.filter((row) => {
    const value = JSON.parse(row.result);
    return isSavedImageReceipt(value) && value.assetId === assetId;
  });
  if (matches.length !== 1) fail(409, "当前成品缺少唯一、有效的已保存操作回执");
  const row = matches[0]!,
    receipt = JSON.parse(row.result);
  const [original, base] = await readReferenceImages(
    db,
    ctx,
    [referenceImageId, assetId],
    storage,
  );
  const originalMeta = await sharp(original!.data).metadata(),
    baseMeta = await sharp(base!.data).metadata();
  if (
    receipt.width !== baseMeta.autoOrient.width ||
    receipt.height !== baseMeta.autoOrient.height ||
    receipt.size !== base!.data.length
  )
    fail(409, "成品尺寸或字节与保存回执不一致");
  const object = await db
    .selectFrom("file_storage_objects")
    .select(["sha256", "size", "mime"])
    .where("id", "=", assetId)
    .executeTakeFirst();
  if (
    !object ||
    object.sha256 !== sha(base!.data) ||
    object.size !== base!.data.length ||
    object.mime !== base!.mime
  )
    fail(409, "成品存储内容已经改变");
  if (receipt.kind === "image_revision") {
    const revision = anySavedRevision(receipt);
    if (
      !revision ||
      revision.generationOperationId !== row.id ||
      revision.originalReferenceImageId !== referenceImageId ||
      revision.binding.actorId !== ctx.actor.id ||
      revision.binding.sessionId !== job.session_id ||
      revision.binding.attemptScope.operationId !== batch.attemptScope.operationId ||
      revision.binding.attemptScope.taskRootJobId !== batch.attemptScope.taskRootJobId
    )
      fail(409, "续改成品来源、版本或原始任务范围不一致");
    // This is an immutable historical artifact, not a pending edit permission.
    // Its creation-time requirements digest must match its own actual raw parent
    // below. A subsequent formal bind invalidates its verdict, not its pixels.
    // New edits still use bind/validateSavedImageRevisionBinding with CURRENT
    // requirements, and all adoption/review paths verify those formal sources.
    await validatePaidImageAttemptScope(
      db,
      ctx,
      batch,
      revision.paidAttempt,
      referenceImageId,
    );
    const raw = await readAnyRevisionRawImageCandidateRecord(
      db,
      ctx,
      revision.generationOperationId,
      {
        storage,
        readReferences: (ids) => readReferenceImages(db, ctx, ids, storage),
        readProviderReferences:(candidate,sources)=>reconstructRevisionProviderReferences(candidate,sources,revision.reviewGeneration.referenceCrops),
      },
    );
    if (
      !revision.rawCandidate ||
      digest(revision.binding) !== digest(raw.candidate.binding) ||
      revision.rawCandidate.receiptId !== raw.receiptId ||
      revision.rawCandidate.assetId !== raw.candidate.assetId ||
      revision.rawCandidate.sha256 !== raw.candidate.sha256
    )
      fail(409, "续改成品与原始候选绑定不一致");
    if(revision.version===2&&revision.mode==="local"){
      const composed=await composeSavedLocalBitmap(raw.sourceReferences[0]!.data,raw.data,revision.binding.localFacts);
      const actualPixels=await sharp(base!.data).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer();
      if(digest(revision.composition)!==digest({geometryDigest:composed.geometryDigest,actual:composed.actual,result:composed.result})||
        revision.composition.result.sha256!==sha(base!.data)||revision.composition.result.rgbaSHA256!==sha(actualPixels))
        fail(409,"局部成品像素、实际原始候选或合成事实不一致");
    }
  } else {
    if (receipt.generation?.referenceImageIds?.[0] !== referenceImageId)
      fail(409, "保存成品不是本页来源");
    if (receipt.origin === "reference-export") {
      if (
        receipt.paidAttempt ||
        receipt.rawCandidate ||
        receipt.providerCallId ||
        receipt.generation.referenceImageIds.length !== 1
      )
        fail(409, "原样导出回执包含不一致的生成事实");
      const pixels = await Promise.all(
        [original!.data, base!.data].map((data) =>
          sharp(data)
            .rotate()
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true }),
        ),
      );
      if (
        pixels[0]!.info.width !== pixels[1]!.info.width ||
        pixels[0]!.info.height !== pixels[1]!.info.height ||
        !pixels[0]!.data.equals(pixels[1]!.data)
      )
        fail(409, "原样导出成品与冻结原页像素不一致");
    } else {
      if (
        receipt.origin !== undefined &&
        receipt.origin !== "local-recomposition"
      )
        fail(409, "未知成品来源格式，不能转换为续改底图");
      const paid =
        receipt.origin === "local-recomposition"
          ? await db
              .selectFrom("ai_operations as o")
              .innerJoin("ai_jobs as j", "j.id", "o.job_id")
              .select(["o.id", "o.result", "o.user_id"])
              .where("o.id", "=", receipt.generationOperationId)
              .where("o.user_id", "=", ctx.actor.id)
              .where("j.user_id", "=", ctx.actor.id)
              .where("j.session_id", "=", job.session_id)
              .executeTakeFirst()
          : row;
      const paidReceipt = paid ? JSON.parse(paid.result) : undefined;
      if (
        !paidReceipt ||
        paidReceipt.kind !== "image_generation" ||
        paidReceipt.origin !== undefined ||
        paidReceipt.generationOperationId !== paid!.id ||
        paidReceipt.generation?.referenceImageIds?.[0] !== referenceImageId
      )
        fail(409, "成品缺少真实付费来源");
      await validatePaidImageAttemptScope(
        db,
        ctx,
        batch,
        paidReceipt.paidAttempt,
        referenceImageId,
      );
      const raw = await readRawImageCandidate(
        db,
        ctx,
        receipt.generationOperationId,
        storage,
      );
      for (const value of [receipt, paidReceipt]) {
        const pointer = pointerSchema.safeParse(value.rawCandidate);
        if (
          !pointer.success ||
          pointer.data.receiptId !== raw.receiptId ||
          pointer.data.assetId !== raw.candidate.assetId ||
          pointer.data.sha256 !== raw.candidate.sha256
        )
          fail(409, "成品与持久原始候选不一致");
      }
      if (
        raw.candidate.references[0]?.referenceImageId !== referenceImageId ||
        raw.candidate.references[0]?.sha256 !== sha(original!.data)
      )
        fail(409, "成品原页内容已经改变");
    }
  }
  return {
    row,
    receipt,
    original: {
      referenceImageId,
      sha256: sha(original!.data),
      size: original!.data.length,
      width: originalMeta.autoOrient.width,
      height: originalMeta.autoOrient.height,
    },
    base: {
      referenceImageId: assetId,
      operationId: row.id,
      receiptDigest: digest(row),
      sha256: sha(base!.data),
      size: base!.data.length,
      width: baseMeta.autoOrient.width,
      height: baseMeta.autoOrient.height,
    },
  };
}

export async function bindSavedImageRevision(
  db: DB,
  ctx: ToolContext,
  referenceImageId: string,
  baseAssetId: string,
  storage?: StorageRuntime,
): Promise<ImageRevisionAnyBinding> {
  const job = await jobContext(db, ctx),
    batch = requireImageBatch(JSON.parse(job.result)?.checkpoint?.imageBatch);
  if (!((batch.version === 4 && batch.attemptScope.version === 2)||(batch.version===5&&batch.attemptScope.version===3)))
    fail(409, "当前批次需显式升级至 version:4 后才能续改", {
      code: "image_revision_batch_upgrade_required",
    });
  if (
    !batch.books[batch.current]?.pages.some(
      (page) => page.referenceImageId === referenceImageId,
    ) ||
    batch.delivered[referenceImageId] !== baseAssetId
  )
    fail(409, "底图必须是当前书册本页的最新交付成品", {
      code: "image_revision_base_stale",
    });
  if (
    batch.reviews[referenceImageId]?.assetId !== baseAssetId ||
    batch.reviews[referenceImageId]?.passed !== false
  )
    fail(409, "先完整查看并登记当前成品的具体缺陷，再续改。" +
      `当前成品没有匹配的失败记录；先 image_view 查看 referenceImageIds:[\"${referenceImageId}\",\"${baseAssetId}\"]，` +
      `后续轮次调用 image_batch，action:\"review\"，review:{referenceImageId:\"${referenceImageId}\",assetId:\"${baseAssetId}\",passed:实际判断,evidence:具体图像证据}。` +
      "不要只在回复中宣称已登记，也不要重复更改续改提示词。合格则继续余页；验收尚未完成不等于内容失败。本次没有发起付费生图。");
  await verifyImageBatchRequirements(
    db,
    {
      userId: ctx.actor.id,
      actor: ctx.actor,
      sessionId: job.session_id,
      currentJobId: job.id,
    },
    batch.requirements,
  );
  await verifyImageBatchAttemptScope(db, ctx, batch);
  const artifact = await verifySavedBatchArtifact(
    db,
    ctx,
    batch,
    referenceImageId,
    baseAssetId,
    storage,
  );
  return imageRevisionAnyBindingSchema.parse({
    version: batch.version===5?2:1,...(batch.version===5?{mode:"whole"}:{}),
    actorId: ctx.actor.id,
    sessionId: job.session_id,
    attemptScope: batch.attemptScope,
    requirementsDigest: digest(batch.requirements),
    original: artifact.original,
    base: artifact.base,
  });
}
export async function validateSavedImageRevisionBinding(
  db: DB,
  ctx: ToolContext,
  binding: ImageRevisionAnyBinding,
  storage?: StorageRuntime,
) {
  const current = await bindSavedImageRevision(
    db,
    ctx,
    binding.original.referenceImageId,
    binding.base.referenceImageId,
    storage,
  );
  if(binding.version===2&&binding.mode==="local"){
    const {localFacts,...whole}=binding;
    if(digest({...whole,mode:"whole"})!==digest(current))fail(409,"局部续改来源或当前成品已变化",{code:"image_revision_base_stale"});
    const [base]=await readReferenceImages(db,ctx,[binding.base.referenceImageId],storage);
    const config=await aiConfig(db),id=imageModelIdForOperation(config,"edit");
    const {profile}=await requireImageModel(db,ctx.actor.id,id,"edit");
    const prepared=await prepareSavedLocalBitmap(base!.data,localFacts.region,profile,localFacts.contextPaddingPixels);
    if(digest(prepared.facts)!==digest(localFacts))fail(409,"局部续改工作窗口或模型规格已变化",{code:"image_revision_base_stale"});
  } else if (digest(current) !== digest(binding))
    fail(409, "成品续改绑定、字节或当前指针已经改变", {
      code: "image_revision_base_stale",
    });
}

/** Explicit upgrade; no original job or v3 checkpoint is rewritten. */
export async function upgradeSavedImageBatch(
  db: DB,
  ctx: ToolContext,
  batch: ImageBatch,
  storage?: StorageRuntime,
): Promise<ImageBatch> {
  return transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    await checkJob(tx, ctx);
    if (ctx.writable === false) fail(403, "本次授权只允许读取");
    if (batch.version !== 3 || batch.attemptScope.version !== 1)
      fail(409, "只接受显式 version:3 批次升级");
    const job = await jobContext(tx, ctx),
      stored = JSON.parse(job.result)?.checkpoint?.imageBatch;
    if (!stored || digest(stored) !== digest(batch))
      fail(409, "当前持久批次与升级快照不一致");
    if (job.id === batch.requirements.original.rootJobId)
      fail(409, "升级必须在新的续跑任务中执行，历史原始任务及 v3 检查点保留");
    const currentOperations = await tx
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", job.id)
      .where("user_id", "=", ctx.actor.id)
      .execute();
    if (
      currentOperations.some((row) =>
        ["image_generation", "image_revision"].includes(
          JSON.parse(row.result)?.kind,
        ),
      )
    )
      fail(409, "已有图片操作的历史任务不能改写版本；请在新的续跑任务显式升级");
    await verifyImageBatchAttemptScope(tx, ctx, batch);
    for (const [page, asset] of Object.entries(batch.delivered))
      await verifySavedBatchArtifact(tx, ctx, batch, page, asset, storage);
    for (const [page, review] of Object.entries(batch.reviews))
      if (batch.delivered[page] !== review.assetId)
        fail(409, "旧验收不属于当前交付，不能带入升级");
    const attemptScope = await upgradeImageBatchAttemptScope(tx, ctx, batch);
    const upgraded = requireImageBatch({ ...batch, version: 4, attemptScope });
    const result = JSON.parse(job.result);
    result.checkpoint.imageBatch = upgraded;
    const update = await tx
      .updateTable("ai_jobs")
      .set({ result: JSON.stringify(result) })
      .where("id", "=", job.id)
      .where("user_id", "=", ctx.actor.id)
      .where("result", "=", job.result)
      .executeTakeFirst();
    if (update.numUpdatedRows !== 1n) fail(409, "升级期间持久批次已改变");
    return upgraded;
  });
}

export async function reviseSavedImageAsset(
  db: DB,
  ctx: ToolContext,
  input: ImageInput & { originalReferenceImageId: string; baseAssetId: string },
  operationId: string,
  options: Parameters<typeof generateImageAsset>[4] & {
    assertCurrent?: () => void;
  } = {},
) {
  if (input.editRegions)
    fail(400, "当前成品续改仅支持整页，不接受旧原页轮廓或蒙版", {
      code: "image_revision_local_unsupported",
    });
  const parsed = imageEditSavedInputSchema.safeParse(input);
  if (!parsed.success)
    fail(400, "成品续改参数无效；不接受旧蒙版、viewport 或未声明字段", {
      code: "image_revision_input_invalid",
    });
  const { originalReferenceImageId, baseAssetId, ...args } = parsed.data;
  const binding = await bindSavedImageRevision(
    db,
    ctx,
    originalReferenceImageId,
    baseAssetId,
    options.storage,
  );
  options.assertCurrent?.();
  const refs = args.referenceImageIds ?? [];
  if (refs.includes(baseAssetId) || refs.includes(originalReferenceImageId))
    fail(400, "附加参考不能重复底图或冻结原页");
  return generateImageAsset(
    db,
    ctx,
    { ...args, referenceImageIds: [baseAssetId, ...refs] },
    operationId,
    {
      ...options,
      operation: "edit",
      batchAttemptScope: binding.attemptScope,
      savedRevision: {
        binding,
        validate: async (tx) => {
          options.assertCurrent?.();
          await validateSavedImageRevisionBinding(
            tx,
            ctx,
            binding,
            options.storage,
          );
          options.assertCurrent?.();
        },
      },
    },
  );
}

/** Explicit v4 -> v5 migration; historical jobs and all receipt bytes stay intact. */
export async function upgradeLocalSavedImageBatch(db:DB,ctx:ToolContext,batch:ImageBatch,storage?:StorageRuntime):Promise<ImageBatch>{
  return transact(db,async tx=>{
    await lockAIUser(tx,ctx.actor.id);await checkJob(tx,ctx);
    if(ctx.writable===false)fail(403,"本次授权只允许读取");
    if(batch.version!==4)fail(409,"局部续改升级只接受明确的v4批次");
    const job=await jobContext(tx,ctx),result=JSON.parse(job.result);
    if(digest(result.checkpoint?.imageBatch)!==digest(batch))fail(409,"当前持久批次与升级快照不一致");
    await verifyImageBatchRequirements(tx,{userId:ctx.actor.id,actor:ctx.actor,sessionId:job.session_id,currentJobId:job.id},batch.requirements);
    await verifyImageBatchAttemptScope(tx,ctx,batch);
    for(const [page,asset]of Object.entries(batch.delivered))await verifySavedBatchArtifact(tx,ctx,batch,page,asset,storage);
    for(const [page,review]of Object.entries(batch.reviews))if(batch.delivered[page]!==review.assetId)fail(409,"旧验收不属于当前成品，不能带入升级");
    const attemptScope=await upgradeLocalImageBatchAttemptScope(tx,ctx,batch);
    const upgraded=requireImageBatch({...batch,version:5,attemptScope});
    result.checkpoint.imageBatch=upgraded;
    const changed=await tx.updateTable("ai_jobs").set({result:JSON.stringify(result)}).where("id","=",job.id).where("user_id","=",ctx.actor.id).where("result","=",job.result).executeTakeFirst();
    if(changed.numUpdatedRows!==1n)fail(409,"升级期间持久批次已改变");
    await verifyImageBatchAttemptScope(tx,ctx,upgraded);
    return upgraded;
  });
}

export async function prepareSavedLocalRevision(db:DB,ctx:ToolContext,input:z.infer<typeof imageEditSavedLocalInputSchema>,storage?:StorageRuntime){
  const parsed=imageEditSavedLocalInputSchema.parse(input);
  const whole=await bindSavedImageRevision(db,ctx,parsed.originalReferenceImageId,parsed.baseAssetId,storage);
  if(whole.version!==2)fail(409,"局部续改需要显式升级至批次v5",{code:"image_revision_batch_upgrade_required"});
  const config=await aiConfig(db),id=imageModelIdForOperation(config,"edit");
  const {model,profile}=await requireImageModel(db,ctx.actor.id,id,"edit");
  if((parsed.referenceImageIds?.length??0)+2>profile.maxReferences)fail(400,"当前模型无法容纳成品窗口、身份参考及原页上下文",{code:"image_reference_limit",data:{count:profile.maxReferences}});
  const [original,base]=await readReferenceImages(db,ctx,[parsed.originalReferenceImageId,parsed.baseAssetId],storage);
  const prepared=await prepareSavedLocalBitmap(base!.data,parsed.region,profile,parsed.contextPaddingPixels??64);
  const binding=imageRevisionLocalBindingV2Schema.parse({...whole,mode:"local",localFacts:prepared.facts});
  const previewBinding=imageRevisionLocalPreviewSchema.parse({kind:"image_revision_local_preview",version:1,binding,bindingDigest:imageRevisionBindingDigest(binding),geometryDigest:prepared.facts.digest,
    instruction:"选区属于当前成品；原页只供核对全部正式要求。选区外逐像素保留当前成品。三个实际视图完整送达并正常结束响应后，在后轮才能付费续改。"});
  const preview=await savedLocalBitmapPreview(original!.data,base!.data,prepared.facts);
  return {binding,previewBinding,frames:preview.frames,modelId:model.id};
}

export async function reviseSavedLocalImageAsset(db:DB,ctx:ToolContext,input:z.infer<typeof imageEditSavedLocalInputSchema>,operationId:string,
  options:Parameters<typeof generateImageAsset>[4]&{expectedPreview:ReturnType<typeof imageRevisionLocalPreviewSchema.parse>;assertCurrent?:()=>void}){
  const prepared=await prepareSavedLocalRevision(db,ctx,input,options.storage);
  if(digest(prepared.previewBinding)!==digest(options.expectedPreview))fail(409,"局部续改预览、当前底图或工作窗口已经改变",{code:"image_revision_base_stale"});
  options.assertCurrent?.();
  const {region,contextPaddingPixels,baseAssetId,originalReferenceImageId,...args}=imageEditSavedLocalInputSchema.parse(input);
  return generateImageAsset(db,ctx,{...args,size:prepared.binding.localFacts.provider.requestedSize,referenceImageIds:[baseAssetId,...(args.referenceImageIds??[]),originalReferenceImageId]},operationId,
    {...options,operation:"edit",batchAttemptScope:prepared.binding.attemptScope,savedRevision:{binding:prepared.binding,previewBinding:prepared.previewBinding,
      validate:async tx=>{options.assertCurrent?.();await validateSavedImageRevisionBinding(tx,ctx,prepared.binding,options.storage);options.assertCurrent?.();}}});
}
