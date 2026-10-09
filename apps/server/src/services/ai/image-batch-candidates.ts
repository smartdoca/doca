import { z } from "zod";
import type { DB } from "@db/index.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { checkJob } from "@core/workflows/ai-documents.js";
import { batchPage, type ImageBatch } from "./image-batch.js";
import {
  verifyImageBatchAttemptScope,
  paidImageAttemptSchema,
} from "./image-batch-attempts.js";
import {
  anySavedRevision,
  isSavedImageReceipt,
} from "./image-revision-contract.js";
import { inspectImageBatchSelection } from "./image-batch-selection.js";
import type { StorageRuntime } from "../../adapters/storage.js";

export const imageBatchCandidatesInputSchema = z
  .object({
    referenceImageId: z.string().uuid(),
    offset: z.number().int().nonnegative(),
    order: z.enum(["oldest", "newest"]),
  })
  .strict();
/** List saved paid candidates. Raw output is never presented as a delivered image. */
export async function listImageBatchCandidates(
  db: DB,
  ctx: ToolContext,
  batch: ImageBatch,
  supplied: z.infer<typeof imageBatchCandidatesInputSchema>,
  storage?: StorageRuntime,
) {
  const input = imageBatchCandidatesInputSchema.parse(supplied);
  await checkJob(db, ctx);
  batchPage(batch, input.referenceImageId);
  await verifyImageBatchAttemptScope(db, ctx, batch);
  const job = await db
    .selectFrom("ai_jobs")
    .select("session_id")
    .where("id", "=", ctx.jobId!)
    .where("user_id", "=", ctx.actor.id)
    .executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom("ai_operations as o")
    .innerJoin("ai_jobs as j", "j.id", "o.job_id")
    .select(["o.id", "o.result", "o.created_at"])
    .where("o.user_id", "=", ctx.actor.id)
    .where("j.user_id", "=", ctx.actor.id)
    .where("j.session_id", "=", job.session_id)
    .where("o.result", "like", `%${input.referenceImageId}%`)
    .orderBy("o.created_at", input.order === "oldest" ? "asc" : "desc")
    .execute();
  const candidates = rows.flatMap((row) => {
    const value = JSON.parse(row.result);
    if (!isSavedImageReceipt(value)) return [];
    const ref =
      value.kind === "image_revision"
        ? anySavedRevision(value)!.originalReferenceImageId
        : value.generation?.referenceImageIds?.[0];
    const paid = paidImageAttemptSchema.safeParse(value.paidAttempt);
    if (
      ref !== input.referenceImageId ||
      !paid.success ||
      paid.data.scope.operationId !== batch.attemptScope.operationId
    )
      return [];
    return [{ value, row, ordinal: paid.data.ordinal }];
  });
  const selected = candidates.slice(input.offset, input.offset + 6);
  for (const item of selected)
    await inspectImageBatchSelection(
      db,
      ctx,
      batch,
      { referenceImageId: input.referenceImageId, assetId: item.value.assetId },
      storage,
    );
  return {
    kind: "image_saved_candidates" as const,
    readonly: true as const,
    imageGenerationPaid: false as const,
    referenceImageId: input.referenceImageId,
    offset: input.offset,
    order: input.order,
    nextOffset:
      input.offset + selected.length < candidates.length
        ? input.offset + selected.length
        : null,
    candidates: selected.map(({ value, row, ordinal }) => ({
      assetId: value.assetId,
      generationOperationId: value.generationOperationId,
      filename: value.filename,
      width: value.width,
      height: value.height,
      ordinal,
      createdAt: row.created_at,
      current: batch.delivered[input.referenceImageId] === value.assetId,
    })),
    instruction:
      "这些是真实已保存成品，仅列候选，不更换交付、不判通过、不新增生图费用。image_view对照原页实看候选；择优用image_batch select并完成实际查看后选择，随后按当前正式要求独立验收。最晚生成不等于最好，历史费用保留。",
  };
}
