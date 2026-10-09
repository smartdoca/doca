// Actual captured whole-only implementation; original SHA256: 8a097994bbebe5893acba5a810365b5da0810c29eb9ddb0002511e7e7873c441.
// Test-only rollback fence evidence. Imports relocated; implementation unchanged.
// This fixture is never a product compatibility reader or migration path.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "@core/shared/errors.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { imagePageAttemptLimit } from "../../apps/server/src/services/ai/image-attempt-policy.js";
import {
  checkJob,
  digest,
  type ToolContext,
} from "@core/workflows/ai-documents.js";
import {
  batchSourceSchema,
  verifyImageBatchRequirements,
} from "../../apps/server/src/services/ai/image-batch-requirements.js";
import {
  imageBatchAttemptScopeSchema,
  imageBatchAttemptScopeV1Schema,
  imageBatchAttemptScopeV2Schema,
  requireImageBatch,
  type ImageBatch,
  type ImageBatchAttemptScope,
} from "../../apps/server/src/services/ai/image-batch.js";

const pageSchema = z
  .object({
    referenceImageId: z.string().uuid(),
    source: batchSourceSchema,
    objectId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const recordV1Schema = z
  .object({
    kind: z.literal("image_batch_attempt_scope"),
    version: z.literal(1),
    sessionId: z.string().uuid(),
    taskRootJobId: z.string().uuid(),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    pages: z.array(pageSchema).min(1),
  })
  .strict();
const archivePointerSchema = z
  .object({
    operationId: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const recordV2Schema = recordV1Schema
  .extend({
    version: z.literal(2),
    predecessor: archivePointerSchema.nullable(),
  })
  .strict();
const recordSchema = z.discriminatedUnion("version", [
  recordV1Schema,
  recordV2Schema,
]);
const operationSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    job_id: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    result: z.string(),
    created_at: z.string(),
  })
  .strict();
export const imageBatchScopeArchiveSchema = z
  .object({
    kind: z.literal("image_batch_attempt_scope_archive"),
    version: z.literal(1),
    scopeOperationId: z.string().uuid(),
    predecessor: operationSnapshotSchema,
  })
  .strict();
const paidFields = {
  referenceImageId: z.string().uuid(),
  ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
export const paidImageAttemptSchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal(1),
      scope: imageBatchAttemptScopeV1Schema,
      ...paidFields,
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      scope: imageBatchAttemptScopeV2Schema,
      ...paidFields,
    })
    .strict(),
]);
export type PaidImageAttempt = z.infer<typeof paidImageAttemptSchema>;
type ScopeRecord = z.infer<typeof recordSchema>;
type ScopeState = {
  record: ScopeRecord;
  scope: ImageBatchAttemptScope;
  row: Schema["ai_operations"];
  predecessor: z.infer<typeof recordV1Schema> | null;
};
type ScopeInput = Pick<ImageBatch, "requirements" | "books">;
function parseJSON(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function scopeOperationId(sessionId: string, rootJobId: string) {
  const hex = createHash("sha256")
    .update(`image-batch-attempt-scope:1:${sessionId}:${rootJobId}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
async function context(db: DB, ctx: ToolContext) {
  if (!ctx.jobId) fail(409, "批次尝试必须绑定当前任务");
  await checkJob(db, ctx);
  const job = await db
    .selectFrom("ai_jobs as j")
    .innerJoin("ai_sessions as s", "s.id", "j.session_id")
    .innerJoin("users as u", "u.id", "j.user_id")
    .select(["j.id", "j.session_id", "j.result", "j.input"])
    .where("j.id", "=", ctx.jobId)
    .where("j.user_id", "=", ctx.actor.id)
    .where("s.user_id", "=", ctx.actor.id)
    .where("u.status", "=", "active")
    .executeTakeFirst();
  if (!job) fail(403, "批次任务不属于当前账号、会话或账号已停用");
  return {
    job,
    requirementContext: {
      userId: ctx.actor.id,
      actor: ctx.actor,
      sessionId: job.session_id,
      currentJobId: job.id,
    },
  };
}
async function expectedRecord(db: DB, ctx: ToolContext, batch: ScopeInput) {
  const { job, requirementContext } = await context(db, ctx);
  await verifyImageBatchRequirements(
    db,
    requirementContext,
    batch.requirements,
  );
  if (
    batch.books.length !== batch.requirements.sources.length ||
    batch.books.some(
      (book, index) =>
        !book.pages.length ||
        JSON.stringify(book.source) !==
          JSON.stringify(batch.requirements.sources[index]!.source),
    )
  )
    fail(409, "批次必须绑定全部正式原文件，不能缩减页来源");
  const pages = batch.books.flatMap((book) => {
    const source = batch.requirements.scope.inputManifest.find(
      (item) => JSON.stringify(item.source) === JSON.stringify(book.source),
    );
    if (!source || source.role !== "target")
      fail(409, "批次页缺少冻结原文件绑定");
    return book.pages.map((page) => ({
      referenceImageId: page.referenceImageId,
      source: book.source,
      objectId: source.objectId,
      sha256: source.sha256,
    }));
  });
  if (
    !pages.length ||
    new Set(pages.map((page) => page.referenceImageId)).size !== pages.length
  )
    fail(409, "批次原页清单为空或有重复");
  for (const page of pages) {
    const derived = await db
      .selectFrom("file_derivatives")
      .select("id")
      .where("id", "=", page.referenceImageId)
      .where("source_id", "=", page.objectId)
      .where("kind", "=", "extract-image")
      .where("mime", "=", "image/png")
      .executeTakeFirst();
    if (!derived) fail(409, "批次原页与冻结源文件不一致");
  }
  const manifestDigest = createHash("sha256")
    .update(
      JSON.stringify({
        sources: batch.requirements.sources,
        inputManifest: batch.requirements.scope.inputManifest,
        pages,
      }),
    )
    .digest("hex");
  return recordV1Schema.parse({
    kind: "image_batch_attempt_scope",
    version: 1,
    sessionId: job.session_id,
    taskRootJobId: batch.requirements.original.rootJobId,
    manifestDigest,
    pages,
  });
}
function pointer(record: ScopeRecord): ImageBatchAttemptScope {
  return imageBatchAttemptScopeSchema.parse({
    version: record.version,
    operationId: scopeOperationId(record.sessionId, record.taskRootJobId),
    taskRootJobId: record.taskRootJobId,
    manifestDigest: record.manifestDigest,
  });
}
async function readScope(
  db: DB,
  ctx: ToolContext,
  batch: ScopeInput & { attemptScope: ImageBatchAttemptScope },
): Promise<ScopeState> {
  const expected = await expectedRecord(db, ctx, batch),
    actualPointer = imageBatchAttemptScopeSchema.parse({
      ...pointer(expected),
      version: batch.attemptScope.version,
    });
  if (JSON.stringify(batch.attemptScope) !== JSON.stringify(actualPointer))
    fail(409, "批次 attemptScope 与正式原任务、会话或页清单不一致");
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", actualPointer.operationId)
    .where("user_id", "=", ctx.actor.id)
    .where("job_id", "=", actualPointer.taskRootJobId)
    .executeTakeFirst();
  const parsed = recordSchema.safeParse(
    row ? parseJSON(row.result) : undefined,
  );
  if (
    !row ||
    !parsed.success ||
    row.digest !== digest(parsed.data) ||
    parsed.data.version !== batch.attemptScope.version ||
    JSON.stringify({
      ...parsed.data,
      version: 1,
      ...(parsed.data.version === 2 ? { predecessor: undefined } : {}),
    }) !== JSON.stringify(expected)
  )
    fail(409, "持久批次 attemptScope 记录缺失或不一致，不能续批；原记录保留");
  let predecessor: z.infer<typeof recordV1Schema> | null = null;
  if (parsed.data.version === 2 && parsed.data.predecessor !== null) {
    const archive = await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", parsed.data.predecessor.operationId)
      .where("user_id", "=", ctx.actor.id)
      .where("job_id", "=", actualPointer.taskRootJobId)
      .executeTakeFirst();
    const archived = imageBatchScopeArchiveSchema.safeParse(
      archive ? parseJSON(archive.result) : undefined,
    );
    if (
      !archive ||
      !archived.success ||
      archive.digest !== parsed.data.predecessor.digest ||
      archive.digest !== digest(archived.data) ||
      archived.data.scopeOperationId !== actualPointer.operationId
    )
      fail(409, "持久批次 attemptScope 记录缺失或不一致，不能续批；原记录保留");
    const original = archived.data.predecessor,
      old = recordV1Schema.safeParse(parseJSON(original.result));
    if (
      !old.success ||
      original.id !== actualPointer.operationId ||
      original.user_id !== ctx.actor.id ||
      original.job_id !== actualPointer.taskRootJobId ||
      original.created_at !== row.created_at ||
      original.digest !== digest(old.data) ||
      JSON.stringify(old.data) !== JSON.stringify(expected) ||
      parsed.data.predecessor.operationId !== archiveOperationId(original)
    )
      fail(409, "持久批次 attemptScope 记录缺失或不一致，不能续批；原记录保留");
    predecessor = old.data;
  }
  return { record: parsed.data, scope: actualPointer, row, predecessor };
}
function archiveOperationId(row: z.infer<typeof operationSnapshotSchema>) {
  const hex = createHash("sha256")
    .update(`image-batch-attempt-scope-archive:1:${digest(row)}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
/** New workflows register v2; historical fixtures/unchanged v1 paths are explicit. */
export async function registerImageBatchAttemptScope(
  db: DB,
  ctx: ToolContext,
  batch: ScopeInput,
  options: { version: 1 | 2 } = { version: 2 },
) {
  if (options.version !== 1 && options.version !== 2)
    fail(409, "批次 attemptScope 与正式原任务、会话或页清单不一致");
  return transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    if (ctx.writable === false) fail(403, "本次授权仅允许读取");
    const original = await expectedRecord(tx, ctx, batch);
    const record =
        options.version === 1
          ? original
          : recordV2Schema.parse({
              ...original,
              version: 2,
              predecessor: null,
            }),
      scope = pointer(record);
    const existing = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", scope.operationId)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.user_id !== ctx.actor.id ||
        existing.job_id !== scope.taskRootJobId ||
        recordSchema.safeParse(parseJSON(existing.result)).data?.version !==
          options.version
      )
        fail(
          409,
          "同一正式原任务已有不同的批次页清单或无效尝试范围，不能重置尝试次数",
        );
      return (await readScope(tx, ctx, { ...batch, attemptScope: scope }))
        .scope;
    }
    await tx
      .insertInto("ai_operations")
      .values({
        id: scope.operationId,
        user_id: ctx.actor.id,
        job_id: scope.taskRootJobId,
        digest: digest(record),
        result: JSON.stringify(record),
        created_at: new Date().toISOString(),
      })
      .execute();
    return scope;
  });
}
export async function verifyImageBatchAttemptScope(
  db: DB,
  ctx: ToolContext,
  batch: ImageBatch,
) {
  return transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    return (await readScope(tx, ctx, batch)).scope;
  });
}

function assertPaidScope(
  state: ScopeState,
  supplied: unknown,
  referenceImageId: string,
) {
  const parsed = paidImageAttemptSchema.safeParse(supplied);
  const old =
    state.record.version === 1
      ? state.scope
      : state.predecessor
        ? pointer(state.predecessor)
        : null;
  const expected =
    parsed.success && parsed.data.version === 1
      ? old
      : state.record.version === 2
        ? state.scope
        : null;
  if (
    !parsed.success ||
    !expected ||
    JSON.stringify(parsed.data.scope) !== JSON.stringify(expected) ||
    parsed.data.referenceImageId !== referenceImageId ||
    !state.record.pages.some(
      (page) => page.referenceImageId === referenceImageId,
    )
  )
    fail(409, "已有图片请求没有本批次的有效 paidAttempt，不能复用或自动补值");
  return parsed.data;
}

/** Validate the explicit active/predecessor association without rewriting paid facts. */
export async function validatePaidImageAttemptScope(
  db: DB,
  ctx: ToolContext,
  batch: ImageBatch,
  supplied: unknown,
  referenceImageId: string,
): Promise<PaidImageAttempt> {
  return transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    return assertPaidScope(
      await readScope(tx, ctx, batch),
      supplied,
      referenceImageId,
    );
  });
}

type AssociatedRow = Schema["ai_operations"] & {
  jobSessionId: string | null;
  jobUserId: string | null;
  jobScopeOperationId: unknown;
  jobStatus: string | null;
  jobCancelled: number | null;
  leaseUntil: string | null;
};
const paidStates = new Set(["generating", "saved", "save_failed", "failed"]);
const nonpaidRawKinds = new Set(["image_raw_candidate", "image_revision_raw"]);
const generationFactsSchema = z
  .object({
    prompt: z.string(),
    referenceImageIds: z.array(z.string().uuid()).min(1).max(8),
  })
  .passthrough();
function invalidAttempts(): never {
  fail(
    409,
    "批次图片尝试回执无有效 paidAttempt，不能推断次数或继续计费；原记录保留",
  );
}
async function associatedRows(
  db: DB,
  ctx: ToolContext,
  state: ScopeState,
): Promise<AssociatedRow[]> {
  // A task checkpoint can be large. Read and parse it once per owned job,
  // rather than duplicating it for every operation joined to that job.
  const jobs = await db
    .selectFrom("ai_jobs as j")
    .select([
      "j.id",
      "j.user_id",
      "j.session_id",
      "j.status",
      "j.cancelled",
      "j.lease_until",
      "j.result",
    ])
    .where((eb) =>
      eb.or([
        eb("j.user_id", "=", ctx.actor.id),
        // A corrupt owned operation can point at another account's job.
        // Discover that job once so its scope still causes an ownership reject.
        eb.exists(
          eb
            .selectFrom("ai_operations as linked")
            .select("linked.id")
            .whereRef("linked.job_id", "=", "j.id")
            .where("linked.user_id", "=", ctx.actor.id),
        ),
      ]),
    )
    .execute();
  const jobFacts = new Map(
    jobs.map((job) => [
      job.id,
      {
        jobUserId: job.user_id,
        jobSessionId: job.session_id,
        jobStatus: job.status,
        jobCancelled: job.cancelled,
        leaseUntil: job.lease_until,
        jobScopeOperationId: parseJSON(job.result)?.checkpoint?.imageBatch
          ?.attemptScope?.operationId,
      },
    ]),
  );
  const scopedJobIds = [...jobFacts]
    .filter(([, job]) => job.jobScopeOperationId === state.scope.operationId)
    .map(([id]) => id);
  const rows = await db
    .selectFrom("ai_operations as o")
    .select([
      "o.id",
      "o.user_id",
      "o.job_id",
      "o.digest",
      "o.result",
      "o.created_at",
    ])
    .where("o.user_id", "=", ctx.actor.id)
    .where((eb) =>
      eb.or([
        eb("o.result", "like", `%${state.scope.operationId}%`),
        ...(scopedJobIds.length ? [eb("o.job_id", "in", scopedJobIds)] : []),
      ]),
    )
    .execute();
  return rows.map((row) => {
    const job = row.job_id ? jobFacts.get(row.job_id) : undefined;
    // Direct paid-scope references remain queryable even from an absent job.
    // Missing or foreign metadata must still fail requireOwnedRow.
    return {
      ...row,
      jobUserId: job ? job.jobUserId : null,
      jobSessionId: job ? job.jobSessionId : null,
      jobStatus: job ? job.jobStatus : null,
      jobCancelled: job ? job.jobCancelled : null,
      leaseUntil: job ? job.leaseUntil : null,
      jobScopeOperationId: job?.jobScopeOperationId,
    };
  });
}
function requireOwnedRow(
  row: AssociatedRow,
  ctx: ToolContext,
  state: ScopeState,
) {
  if (
    !row.job_id ||
    row.jobUserId !== ctx.actor.id ||
    row.jobSessionId !== state.record.sessionId
  )
    invalidAttempts();
}
function paidRow(row: AssociatedRow, ctx: ToolContext, state: ScopeState) {
  const value = parseJSON(row.result);
  requireOwnedRow(row, ctx, state);
  if (!value || !paidStates.has(value.state) || value.origin !== undefined)
    invalidAttempts();
  let referenceImageId: string;
  if (value.kind === "image_generation") {
    if (value.version !== undefined) invalidAttempts();
    const facts = generationFactsSchema.safeParse(value.generation);
    if (!facts.success) invalidAttempts();
    referenceImageId = facts.data.referenceImageIds[0]!;
  } else if (value.kind === "image_revision" && value.version === 1) {
    if (
      !z.string().uuid().safeParse(value.originalReferenceImageId).success ||
      value.paidAttempt?.version !== 2
    )
      invalidAttempts();
    referenceImageId = value.originalReferenceImageId;
  } else invalidAttempts();
  return {
    row,
    value,
    attempt: assertPaidScope(state, value.paidAttempt, referenceImageId),
    referenceImageId,
  };
}

async function collectAttempts(db: DB, ctx: ToolContext, state: ScopeState) {
  const rows = await associatedRows(db, ctx, state),
    byId = new Map(rows.map((row) => [row.id, row]));
  const attempts: ReturnType<typeof paidRow>[] = [];
  const nonpaid: AssociatedRow[] = [];
  for (const row of rows) {
    const value = parseJSON(row.result);
    const fromJob = row.jobScopeOperationId === state.scope.operationId;
    if (!value) {
      if (fromJob) invalidAttempts();
      else continue;
    }
    const direct =
      value.paidAttempt?.scope?.operationId === state.scope.operationId;
    if (!direct && !fromJob) continue;
    if (
      value.paidAttempt !== undefined ||
      (value.kind === "image_generation" && value.origin === undefined) ||
      value.kind === "image_revision"
    ) {
      attempts.push(paidRow(row, ctx, state));
    } else if (
      value.kind === "image_generation" ||
      nonpaidRawKinds.has(value.kind)
    ) {
      nonpaid.push(row);
    }
  }
  for (const row of nonpaid) {
    const value = parseJSON(row.result);
    requireOwnedRow(row, ctx, state);
    if (value.kind === "image_generation") {
      const facts = generationFactsSchema.safeParse(value.generation);
      if (
        !facts.success ||
        !state.record.pages.some(
          (page) => page.referenceImageId === facts.data.referenceImageIds[0],
        )
      )
        invalidAttempts();
      if (value.origin === "reference-export") {
        if (
          value.version !== undefined ||
          facts.data.referenceImageIds.length !== 1 ||
          !["generating", "saved", "save_failed", "failed"].includes(
            value.state,
          ) ||
          value.providerCallId !== undefined ||
          value.rawCandidate !== undefined ||
          value.paidAttempt !== undefined
        )
          invalidAttempts();
      } else if (value.origin === "local-recomposition") {
        const parent = byId.get(value.generationOperationId);
        if (
          !parent ||
          parent.id === row.id ||
          !["composing", "saved", "save_failed"].includes(value.state) ||
          JSON.stringify(
            paidRow(parent, ctx, state).value.generation?.referenceImageIds,
          ) !== JSON.stringify(facts.data.referenceImageIds)
        )
          invalidAttempts();
      } else invalidAttempts();
    } else {
      const parent = byId.get(value.generationOperationId);
      if (!parent || parent.id === row.id || value.version !== 1)
        invalidAttempts();
      const paid = paidRow(parent, ctx, state);
      const schemas =
        await import("../../apps/server/src/services/ai/image-candidates.js");
      const schema =
        value.kind === "image_raw_candidate"
          ? schemas.rawImageCandidateReceiptSchema
          : schemas.revisionRawImageCandidateReceiptSchema;
      if (
        !schema.safeParse(value).success ||
        (value.kind === "image_raw_candidate" &&
          paid.value.kind !== "image_generation") ||
        (value.kind === "image_revision_raw" &&
          paid.value.kind !== "image_revision")
      )
        invalidAttempts();
      if (value.kind === "image_raw_candidate") {
        if (
          value.scope.sessionId !== state.record.sessionId ||
          value.references[0]?.referenceImageId !== paid.referenceImageId
        )
          invalidAttempts();
      } else if (
        value.binding.actorId !== ctx.actor.id ||
        value.binding.sessionId !== state.record.sessionId ||
        value.binding.original.referenceImageId !== paid.referenceImageId ||
        digest(value.binding.attemptScope) !== digest(paid.attempt.scope) ||
        digest(value.binding) !== digest(paid.value.binding)
      )
        invalidAttempts();
    }
  }
  const pages = new Map<string, number[]>();
  for (const entry of attempts) {
    const ordinals = pages.get(entry.referenceImageId) ?? [];
    ordinals.push(entry.attempt.ordinal);
    pages.set(entry.referenceImageId, ordinals);
  }
  for (const ordinals of pages.values()) {
    ordinals.sort((a, b) => a - b);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1))
      invalidAttempts();
  }
  return { rows, attempts, pages };
}

async function validateCarriedState(
  db: DB,
  ctx: ToolContext,
  state: ScopeState,
  batch: ImageBatch,
) {
  const { rows } = await collectAttempts(db, ctx, state);
  for (const [referenceImageId, assetId] of Object.entries(batch.delivered)) {
    if (
      !state.record.pages.some(
        (page) => page.referenceImageId === referenceImageId,
      )
    )
      invalidAttempts();
    const matches = rows.filter((row) => {
      const value = parseJSON(row.result);
      return (
        value?.state === "saved" &&
        value.assetId === assetId &&
        (value.kind === "image_generation"
          ? value.generation?.referenceImageIds?.[0] === referenceImageId
          : value.kind === "image_revision" &&
            value.originalReferenceImageId === referenceImageId)
      );
    });
    if (matches.length !== 1) invalidAttempts();
    const asset = await db
      .selectFrom("assets")
      .select("id")
      .where("id", "=", assetId)
      .where("owner_id", "=", ctx.actor.id)
      .where("purpose", "=", "ai_attachment")
      .where("deleted_at", "is", null)
      .where("mime", "like", "image/%")
      .executeTakeFirst();
    if (!asset) invalidAttempts();
  }
  for (const [referenceImageId, review] of Object.entries(batch.reviews)) {
    if (
      !batch.delivered[referenceImageId] ||
      review.assetId !== batch.delivered[referenceImageId]
    )
      invalidAttempts();
  }
}

/** Explicit authorized transition. Original jobs, attempts and usage rows are untouched. */
export async function upgradeImageBatchAttemptScope(
  db: DB,
  ctx: ToolContext,
  supplied: ImageBatch,
) {
  return transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    if (ctx.writable === false) fail(403, "本次授权仅允许读取");
    const batch = requireImageBatch(supplied);
    if (batch.version !== 3 || batch.attemptScope.version !== 1)
      invalidAttempts();
    const expected = await expectedRecord(tx, ctx, batch),
      id = pointer(expected).operationId;
    const row = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", id)
      .where("user_id", "=", ctx.actor.id)
      .where("job_id", "=", expected.taskRootJobId)
      .executeTakeFirst();
    const parsed = recordSchema.safeParse(
      row ? parseJSON(row.result) : undefined,
    );
    if (!row || !parsed.success) invalidAttempts();
    if (parsed.data.version === 2) {
      const state = await readScope(tx, ctx, {
        ...batch,
        attemptScope: pointer(parsed.data),
      });
      if (!state.predecessor) invalidAttempts();
      return state.scope;
    }
    const state = await readScope(tx, ctx, batch),
      facts = await collectAttempts(tx, ctx, state);
    const now = new Date().toISOString();
    if (
      facts.attempts.some(
        ({ row: operation, value }) =>
          value.state === "generating" &&
          operation.jobStatus === "running" &&
          !operation.jobCancelled &&
          operation.leaseUntil !== null &&
          operation.leaseUntil >= now,
      )
    )
      fail(
        409,
        "相同的图片请求正在生成或结果待核对，不能重复提交；请先核对已有结果",
      );
    const activeJobIds = [
      ...new Set(
        facts.rows
          .filter(
            (operation) =>
              operation.jobStatus === "running" &&
              !operation.jobCancelled &&
              operation.leaseUntil !== null &&
              operation.leaseUntil >= now,
          )
          .flatMap((operation) => (operation.job_id ? [operation.job_id] : [])),
      ),
    ];
    if (activeJobIds.length) {
      const calls = await tx
        .selectFrom("ai_calls")
        .select(["state", "model_snapshot"])
        .where("user_id", "=", ctx.actor.id)
        .where("job_id", "in", activeJobIds)
        .execute();
      if (
        calls.some(
          (call) =>
            ["reserved", "pending"].includes(call.state) &&
            parseJSON(call.model_snapshot)?.callKind === "image",
        )
      )
        fail(
          409,
          "相同的图片请求正在生成或结果待核对，不能重复提交；请先核对已有结果",
        );
    }
    await validateCarriedState(tx, ctx, state, batch);
    const archive = imageBatchScopeArchiveSchema.parse({
      kind: "image_batch_attempt_scope_archive",
      version: 1,
      scopeOperationId: id,
      predecessor: operationSnapshotSchema.parse(row),
    });
    const archiveId = archiveOperationId(archive.predecessor),
      archiveDigest = digest(archive);
    const existing = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", archiveId)
      .executeTakeFirst();
    if (
      existing &&
      (existing.user_id !== ctx.actor.id ||
        existing.job_id !== expected.taskRootJobId ||
        existing.digest !== archiveDigest ||
        existing.result !== JSON.stringify(archive))
    )
      invalidAttempts();
    if (!existing)
      await tx
        .insertInto("ai_operations")
        .values({
          id: archiveId,
          user_id: ctx.actor.id,
          job_id: expected.taskRootJobId,
          digest: archiveDigest,
          result: JSON.stringify(archive),
          created_at: now,
        })
        .execute();
    const next = recordV2Schema.parse({
      ...expected,
      version: 2,
      predecessor: { operationId: archiveId, digest: archiveDigest },
    });
    const updated = await tx
      .updateTable("ai_operations")
      .set({ result: JSON.stringify(next), digest: digest(next) })
      .where("id", "=", id)
      .where("user_id", "=", ctx.actor.id)
      .where("job_id", "=", expected.taskRootJobId)
      .where("digest", "=", row.digest)
      .where("result", "=", row.result)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) invalidAttempts();
    return (await readScope(tx, ctx, { ...batch, attemptScope: pointer(next) }))
      .scope;
  });
}
/** Caller owns the user lock. Validate again immediately before reserving a request. */
export async function reserveImageBatchAttempt(
  db: DB,
  ctx: ToolContext,
  supplied: ImageBatchAttemptScope | undefined,
  referenceImageId: string | undefined,
  options: { paid: boolean; existingResult?: unknown },
) {
  if (!ctx.jobId) {
    if (supplied) fail(409, "批次尝试缺少当前任务");
    return undefined;
  }
  const { job } = await context(db, ctx);
  const storedBatch = parseJSON(job.result)?.checkpoint?.imageBatch;
  if (!storedBatch && !supplied) return undefined;
  if (!storedBatch || !supplied)
    fail(409, "图片请求缺少当前任务的持久批次 attemptScope");
  const batch = requireImageBatch(storedBatch),
    state = await readScope(db, ctx, batch),
    scope = state.scope;
  const parsed = imageBatchAttemptScopeSchema.safeParse(supplied);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(scope))
    fail(409, "图片请求的批次 attemptScope 不一致");
  if (
    !referenceImageId ||
    !batch.books[batch.current]?.pages.some(
      (page) => page.referenceImageId === referenceImageId,
    )
  )
    fail(409, "图片请求必须为当前批次书册的冻结原页");
  if (!options.paid) return undefined;
  if (options.existingResult !== undefined) {
    return assertPaidScope(
      state,
      (options.existingResult as any)?.paidAttempt,
      referenceImageId,
    );
  }
  const { pages } = await collectAttempts(db, ctx, state);
  const count = pages.get(referenceImageId)?.length ?? 0;
  const limit = imagePageAttemptLimit();
  if (count >= limit)
    fail(
      409,
      `本批次来源页已提交${limit}次图片请求（含结果或费用待核对的请求），续跑或修改提示词不能重置次数。请保留失败证据并调整方案，不能放宽验收标准。`,
      { code: "image_page_attempt_limit" },
    );
  return paidImageAttemptSchema.parse({
    version: scope.version,
    scope,
    referenceImageId,
    ordinal: count + 1,
  });
}

/** Standalone retries keep their existing request receipts, but cannot omit the real retry lineage. */
export async function imageRelatedJobIds(
  db: DB,
  ctx: ToolContext,
  supplied: string[] = [],
) {
  if (!ctx.jobId) {
    if (supplied.length) fail(409, "关联图片请求缺少当前任务");
    return [];
  }
  const { job } = await context(db, ctx),
    ids = new Set([job.id]);
  let input = parseJSON(job.input);
  for (let depth = 0; input?.retryOf; depth++) {
    if (
      depth >= 10 ||
      typeof input.retryOf !== "string" ||
      ids.has(input.retryOf)
    )
      fail(409, "图片重试来源无效");
    const previous = await db
      .selectFrom("ai_jobs")
      .select(["id", "input"])
      .where("id", "=", input.retryOf)
      .where("user_id", "=", ctx.actor.id)
      .where("session_id", "=", job.session_id)
      .executeTakeFirst();
    if (!previous) fail(403, "图片重试来源不属于当前账号或会话");
    ids.add(previous.id);
    input = parseJSON(previous.input);
  }
  for (const id of supplied) {
    const related = await db
      .selectFrom("ai_jobs")
      .select("id")
      .where("id", "=", id)
      .where("user_id", "=", ctx.actor.id)
      .where("session_id", "=", job.session_id)
      .executeTakeFirst();
    if (!related) fail(403, "关联图片请求不属于当前账号或会话");
    ids.add(id);
  }
  return [...ids];
}
