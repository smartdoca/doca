import { createHash } from "node:crypto";
import { z } from "zod";
import type { DB } from "@db/index.js";
import {
  checkJob,
  digest,
  type ToolContext,
} from "@core/workflows/ai-documents.js";
import { fail } from "@core/shared/errors.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import { batchPage, type ImageBatch } from "./image-batch.js";
import {
  validatePaidImageAttemptScope,
  verifyImageBatchAttemptScope,
} from "./image-batch-attempts.js";
import { readRawImageCandidate, readReferenceImages } from "./images.js";
import { isSavedImageReceipt, anySavedRevision } from "./image-revision-contract.js";
import { verifySavedBatchArtifact } from "./image-saved-revision.js";

export const imageBatchSelectionInputSchema = z
  .object({
    referenceImageId: z.string().uuid(),
    assetId: z.string().uuid(),
  })
  .strict();
export type ImageBatchSelectionInput = z.infer<
  typeof imageBatchSelectionInputSchema
>;
const rawPointerSchema = z
  .object({
    version: z.literal(1),
    receiptId: z.string().uuid(),
    assetId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const sha256 = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** Verify only existing current receipts; selection never reserves an image attempt. */
export async function inspectImageBatchSelection(
  db: DB,
  ctx: ToolContext,
  batch: ImageBatch,
  supplied: ImageBatchSelectionInput,
  storage?: StorageRuntime,
) {
  const candidate = imageBatchSelectionInputSchema.parse(supplied);
  if (ctx.writable === false)
    fail(403, "当前上下文只允许读取，不能修改批次交付");
  batchPage(batch, candidate.referenceImageId);
  const bookIndex = batch.current;
  await checkJob(db, ctx);
  const current = await db
    .selectFrom("ai_jobs")
    .select("session_id")
    .where("id", "=", ctx.jobId!)
    .where("user_id", "=", ctx.actor.id)
    .executeTakeFirstOrThrow();
  await verifyImageBatchAttemptScope(db, ctx, batch);
  const oldAssetId = batch.delivered[candidate.referenceImageId];
  if (!oldAssetId)
    fail(
      409,
      "该页尚无已保存交付，不能用其他图片登记验收；先 image_batch status 核对来源和实际成果",
    );
  const rows = await db
    .selectFrom("ai_operations as o")
    .innerJoin("ai_jobs as j", "j.id", "o.job_id")
    .select(["o.id", "o.digest", "o.result"])
    .where("o.user_id", "=", ctx.actor.id)
    .where("j.user_id", "=", ctx.actor.id)
    .where("j.session_id", "=", current.session_id)
    .where("o.result", "like", `%"assetId":"${candidate.assetId}"%`)
    .execute();
  const matches = rows.flatMap((row) => {
    const value = JSON.parse(row.result);
    return isSavedImageReceipt(value) &&
      value.assetId === candidate.assetId
      ? [{ row, value }]
      : [];
  });
  if (matches.length !== 1)
    fail(409, "待选图片没有唯一的当前账号、会话已保存生成回执");
  const selected = matches[0]!;
  const receipt = selected.value;
  if(receipt.kind==="image_revision") {
    const revision=anySavedRevision(receipt);
    if(!revision||revision.originalReferenceImageId!==candidate.referenceImageId) fail(409,"待选续改图片与冻结原页不一致");
    const verified=await verifySavedBatchArtifact(db,ctx,batch,candidate.referenceImageId,candidate.assetId,storage);
    return {candidate,bookIndex,actorId:ctx.actor.id,sessionId:current.session_id,attemptScope:batch.attemptScope,
      requirementsDigest:digest(batch.requirements),oldAssetId,sourceSha256:verified.original.sha256,candidateSha256:verified.base.sha256,
      receiptDigest:digest(selected.row),originalReceiptDigest:digest(selected.row),rawBindingDigest:digest(revision.rawCandidate)};
  }
  if (receipt.generation?.referenceImageIds?.[0] !== candidate.referenceImageId)
    fail(409, "待选图片与当前批次原页不一致");
  if (receipt.origin !== undefined && receipt.origin !== "local-recomposition")
    fail(409, "本动作只选择具备本批次付费来源与持久原始候选的已保存图片");
  const generationOperationId = z
    .string()
    .uuid()
    .parse(receipt.generationOperationId);
  const original =
    receipt.origin === "local-recomposition"
      ? await db
          .selectFrom("ai_operations as o")
          .innerJoin("ai_jobs as j", "j.id", "o.job_id")
          .select(["o.id", "o.digest", "o.result"])
          .where("o.id", "=", generationOperationId)
          .where("o.user_id", "=", ctx.actor.id)
          .where("j.user_id", "=", ctx.actor.id)
          .where("j.session_id", "=", current.session_id)
          .executeTakeFirst()
      : selected.row;
  if (!original || original.id !== generationOperationId)
    fail(409, "待选图片没有当前会话的原始付费生成回执");
  const generation = JSON.parse(original.result);
  await validatePaidImageAttemptScope(db,ctx,batch,generation.paidAttempt,candidate.referenceImageId);
  if (
    generation.kind !== "image_generation" ||
    generation.state !== "saved" ||
    generation.origin !== undefined ||
    generation.generation?.referenceImageIds?.[0] !== candidate.referenceImageId
  )
    fail(409, "待选图片的原始付费尝试不属于当前持久批次范围或原页");
  const raw = await readRawImageCandidate(
    db,
    ctx,
    generationOperationId,
    storage,
  );
  for (const value of [receipt, generation]) {
    const pointer = rawPointerSchema.safeParse(value.rawCandidate);
    if (
      !pointer.success ||
      pointer.data.receiptId !== raw.receiptId ||
      pointer.data.assetId !== raw.candidate.assetId ||
      pointer.data.sha256 !== raw.candidate.sha256
    )
      fail(409, "待选图片与持久原始候选绑定不一致");
  }
  if (
    raw.candidate.references[0]?.referenceImageId !== candidate.referenceImageId
  )
    fail(409, "待选图片与持久原始候选的原页不一致");
  const [source, saved] = await readReferenceImages(
    db,
    ctx,
    [candidate.referenceImageId, candidate.assetId],
    storage,
  );
  await checkJob(db, ctx);
  return {
    candidate,
    bookIndex,
    actorId: ctx.actor.id,
    sessionId: current.session_id,
    attemptScope: batch.attemptScope,
    requirementsDigest: digest(batch.requirements),
    oldAssetId,
    sourceSha256: sha256(source!.data),
    candidateSha256: sha256(saved!.data),
    receiptDigest: digest(selected.row),
    originalReceiptDigest: digest(original),
    rawBindingDigest: digest({
      receiptId: raw.receiptId,
      candidate: raw.candidate,
    }),
  };
}
