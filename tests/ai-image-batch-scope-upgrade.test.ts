import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import { transact } from "@db/transactions.js";
import { openTestDatabase } from "./database.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { registerVisualReferences } from "../apps/server/src/services/ai/session-attachments.js";
import { createImageBatchRequirements } from "../apps/server/src/services/ai/image-batch-requirements.js";
import {
  imageBatchSchema,
  type ImageBatch,
  type ImageBatchAttemptScope,
} from "../apps/server/src/services/ai/image-batch.js";
import {
  paidImageAttemptSchema,
  type PaidImageAttempt,
  registerImageBatchAttemptScope,
  reserveImageBatchAttempt,
  upgradeImageBatchAttemptScope,
  upgradeLocalImageBatchAttemptScope,
  validatePaidImageAttemptScope,
  verifyImageBatchAttemptScope,
} from "../apps/server/src/services/ai/image-batch-attempts.js";
import { imagePageAttemptLimit } from "../apps/server/src/services/ai/image-attempt-policy.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  owner: Actor,
  other: Actor,
  sessionId: string,
  originalContext: ToolContext,
  originalBatch: Extract<ImageBatch, { version: 3 }>;
let clock = 0;

async function session(actor = owner) {
  const id = randomUUID(),
    now = new Date((clock += 1000)).toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: actor.id,
      title: "Isolated scope upgrade metadata",
      model_id: "scope-fixture",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function job(
  options: {
    actor?: Actor;
    sessionId?: string;
    input?: object;
    status?: "running" | "completed" | "failed";
    batch?: ImageBatch;
  } = {},
): Promise<ToolContext> {
  const actor = options.actor ?? owner,
    id = randomUUID(),
    lease = randomUUID(),
    status = options.status ?? "running",
    now = new Date((clock += 1000)).toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      user_id: actor.id,
      session_id: options.sessionId ?? sessionId,
      model_id: "scope-fixture",
      status,
      input: JSON.stringify({
        text: "Complete every page of the original book without changing the fee history",
        ...options.input,
      }),
      result: JSON.stringify(
        options.batch ? { checkpoint: { imageBatch: options.batch } } : {},
      ),
      digest: id,
      error: "",
      lease: status === "running" ? lease : null,
      lease_until:
        status === "running"
          ? new Date(Date.now() + 120_000).toISOString()
          : null,
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { actor, jobId: id, lease };
}

async function attachBatch(context: ToolContext, batch: ImageBatch) {
  await db
    .updateTable("ai_jobs")
    .set({ result: JSON.stringify({ checkpoint: { imageBatch: batch } }) })
    .where("id", "=", context.jobId!)
    .execute();
}

const page = (index = 0) =>
  originalBatch.books[0]!.pages[index]!.referenceImageId;
const canonicalRow = () =>
  db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", originalBatch.attemptScope.operationId)
    .executeTakeFirstOrThrow();
const operationRows = () =>
  db.selectFrom("ai_operations").selectAll().orderBy("id").execute();
async function archives() {
  return (await operationRows()).filter(
    (row) =>
      JSON.parse(row.result).kind === "image_batch_attempt_scope_archive",
  );
}

function upgradedBatch(scope: ImageBatchAttemptScope) {
  const value = imageBatchSchema.parse({
    ...originalBatch,
    version: 4,
    attemptScope: scope,
  });
  if (value.version !== 4) throw Error("Fixture expected an explicit batch v4");
  return value;
}

async function reserve(
  context: ToolContext,
  batch: ImageBatch,
  index = 0,
  existingResult?: unknown,
) {
  return transact(db, async (tx) => {
    await lockAIUser(tx, context.actor.id);
    return reserveImageBatchAttempt(
      tx,
      context,
      batch.attemptScope,
      page(index),
      {
        paid: true,
        ...(existingResult === undefined ? {} : { existingResult }),
      },
    );
  });
}

type FeeKind = "image_generation" | "image_revision";
type FeeState = "generating" | "saved" | "save_failed" | "failed";
async function seedFeeEnvelope(
  batch: ImageBatch,
  kind: FeeKind,
  state: FeeState,
  active = false,
) {
  const context = await job({ batch }),
    id = randomUUID();
  const receipt = await transact(db, async (tx) => {
    await lockAIUser(tx, context.actor.id);
    const paidAttempt = await reserveImageBatchAttempt(
      tx,
      context,
      batch.attemptScope,
      page(),
      { paid: true },
    );
    if (!paidAttempt)
      throw Error("Fixture requires an actual scoped reservation");
    if (kind === "image_revision" && paidAttempt.version !== 2)
      throw Error("Revision metadata may only use a current v2 paid attempt");
    // This is only the strict scope counter's fee envelope. It is deliberately
    // not a rendered image receipt or an assertion that any provider fee exists.
    const value =
      kind === "image_generation"
        ? {
            kind,
            state,
            generationOperationId: id,
            generation: {
              prompt: "Scope metadata reservation",
              referenceImageIds: [page()],
            },
            paidAttempt,
          }
        : {
            kind,
            version: 1,
            state,
            generationOperationId: id,
            originalReferenceImageId: page(),
            paidAttempt,
          };
    await tx
      .insertInto("ai_operations")
      .values({
        id,
        user_id: owner.id,
        job_id: context.jobId!,
        digest: digest(value),
        result: JSON.stringify(value),
        created_at: new Date((clock += 1000)).toISOString(),
      })
      .execute();
    return value;
  });
  if (!active)
    await db
      .updateTable("ai_jobs")
      .set({ status: "failed", lease: null, lease_until: null })
      .where("id", "=", context.jobId!)
      .execute();
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return { context, id, receipt, paid: receipt.paidAttempt, row };
}

async function seedFreeExportEnvelope(
  context: ToolContext,
  state: FeeState,
  overrides: Record<string, unknown> = {},
  referenceImageId = page(),
) {
  const id = randomUUID(),
    value = {
      kind: "image_generation",
      state,
      origin: "reference-export",
      generationOperationId: id,
      generation: {
        prompt: "Export the frozen original page without generating new pixels",
        referenceImageIds: [referenceImageId],
      },
      ...overrides,
    };
  // Match the metadata envelope persisted before export rendering starts.
  // No provider result, image pixels, or usage fact is invented by this fixture.
  await db
    .insertInto("ai_operations")
    .values({
      id,
      user_id: context.actor.id,
      job_id: context.jobId!,
      digest: digest(value),
      result: JSON.stringify(value),
      created_at: new Date((clock += 1000)).toISOString(),
    })
    .execute();
  return value;
}

async function metadataSnapshot() {
  return {
    jobs: await db.selectFrom("ai_jobs").selectAll().orderBy("id").execute(),
    calls: await db.selectFrom("ai_calls").selectAll().orderBy("id").execute(),
    assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    objects: await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .orderBy("id")
      .execute(),
    derivatives: await db
      .selectFrom("file_derivatives")
      .selectAll()
      .orderBy("id")
      .execute(),
  };
}

beforeEach(async () => {
  clock = Date.now() - 60_000;
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "scope-upgrade-owner",
        displayName: "Scope upgrade owner",
        password: "isolated-scope-upgrade-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "scope-upgrade-other",
        displayName: "Other fixture owner",
        password: "isolated-scope-upgrade-2026",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  sessionId = await session();
  const sourceId = randomUUID(),
    objectId = randomUUID(),
    sourceKey = objectKey(sourceId, "application/pdf"),
    profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow(),
    sourceMetadata = Buffer.from(
      "Isolated scope manifest only; no file or image is downloaded or rendered",
    ),
    now = new Date((clock += 1000)).toISOString();
  // These are metadata associations for a frozen document and its derived pages.
  // This suite creates no raster bytes, provider request, usage fee or storage file.
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profile.id,
      object_key: sourceKey,
      sha256: createHash("sha256").update(sourceMetadata).digest("hex"),
      size: sourceMetadata.length,
      mime: "application/pdf",
      created_at: now,
    })
    .execute();
  await db
    .insertInto("assets")
    .values({
      id: sourceId,
      owner_id: owner.id,
      uploaded_by: owner.id,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: profile.id,
      object_key: sourceKey,
      filename: "scope-manifest.pdf",
      mime: "application/pdf",
      size: sourceMetadata.length,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  originalContext = await job({ input: { attachments: [sourceId] } });
  const parts = [];
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(),
      recipe = `scope-fixture-page-${index + 1}`;
    await db
      .insertInto("file_derivatives")
      .values({
        id,
        source_id: objectId,
        profile_id: profile.id,
        object_key: objectKey(id, "image/png"),
        kind: "extract-image",
        recipe,
        mime: "image/png",
        size: 0,
        created_at: now,
      })
      .execute();
    parts.push({
      type: "image" as const,
      recipe,
      filename: `page-${index + 1}.png`,
      mime: "image/png",
    });
  }
  const source = { assetId: sourceId },
    pages = await registerVisualReferences(
      db,
      originalContext,
      source,
      objectId,
      parts,
    ),
    requirements = await createImageBatchRequirements(
      db,
      {
        userId: owner.id,
        actor: owner,
        sessionId,
        currentJobId: originalContext.jobId!,
      },
      originalContext.jobId!,
      [source],
      "all-documents",
      ["Keep the complete original book and every accumulated paid request"],
    ),
    books = [{ source, filename: "scope-manifest.pdf", pages }],
    attemptScope = await registerImageBatchAttemptScope(
      db,
      originalContext,
      { requirements, books },
      { version: 1 },
    ),
    value = imageBatchSchema.parse({
      version: 3,
      attemptScope,
      requirements,
      books,
      current: 0,
      notes: "metadata-only fixture",
      delivered: {},
      reviews: {},
    });
  if (value.version !== 3)
    throw Error("Fixture expected the explicit legacy batch v3");
  originalBatch = value;
  await attachBatch(originalContext, originalBatch);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Scope metadata tests must not call any API"),
  );
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(await db.selectFrom("ai_calls").select("id").execute()).toHaveLength(
    0,
  );
  vi.restoreAllMocks();
  await db.destroy();
});

it("upgrades at the same canonical ID with an exact immutable predecessor archive and leaves every existing job and metadata fact unchanged", async () => {
  const before = await canonicalRow(),
    metadataBefore = await metadataSnapshot(),
    operationsBefore = await operationRows();
  const scope = await upgradeImageBatchAttemptScope(
    db,
    originalContext,
    originalBatch,
  );
  expect(scope).toEqual({ ...originalBatch.attemptScope, version: 2 });
  expect(await metadataSnapshot()).toEqual(metadataBefore);
  const archiveRows = await archives();
  expect(archiveRows).toHaveLength(1);
  const archive = archiveRows[0]!,
    archived = JSON.parse(archive.result);
  expect(archived).toMatchObject({
    kind: "image_batch_attempt_scope_archive",
    version: 1,
    scopeOperationId: before.id,
    predecessor: before,
  });
  expect(archived.predecessor).toEqual(before);
  expect(archive).toMatchObject({
    user_id: before.user_id,
    job_id: before.job_id,
  });
  expect(archive.digest).toBe(digest(archived));
  const current = await canonicalRow(),
    active = JSON.parse(current.result);
  expect(current.id).toBe(before.id);
  expect(current).toMatchObject({
    user_id: before.user_id,
    job_id: before.job_id,
    created_at: before.created_at,
  });
  expect(active).toEqual({
    ...JSON.parse(before.result),
    version: 2,
    predecessor: { operationId: archive.id, digest: archive.digest },
  });
  expect(current.digest).toBe(digest(active));
  expect(
    await verifyImageBatchAttemptScope(
      db,
      originalContext,
      upgradedBatch(scope),
    ),
  ).toEqual(scope);
  expect(
    await upgradeImageBatchAttemptScope(db, originalContext, originalBatch),
  ).toEqual(scope);
  expect(await archives()).toEqual(archiveRows);
  expect(await canonicalRow()).toEqual(current);
  expect(await metadataSnapshot()).toEqual(metadataBefore);
  for (const row of operationsBefore.filter((row) => row.id !== before.id))
    expect(
      (await operationRows()).find((current) => current.id === row.id),
    ).toEqual(row);
});

it("the frozen pre-upgrade strict scope-v1 schema accepts the archived original record and rejects the complete actual upgraded canonical v2 record", async () => {
  // Copy the actual pre-upgrade pageSchema/recordSchema declarations read from
  // image-batch-attempts.ts in this session, plus their batchSourceSchema dependency.
  // The historical 600 report records a source SHA, but has no full source snapshot.
  // This proves the old schema fence only, not execution of historical reader functions.
  const batchSourceSchema = z
    .object({
      assetId: z.string().uuid().optional(),
      fileId: z.string().uuid().optional(),
    })
    .strict()
    .refine((source) => !!source.assetId !== !!source.fileId);
  const pageSchema = z
    .object({
      referenceImageId: z.string().uuid(),
      source: batchSourceSchema,
      objectId: z.string().uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
  const recordSchema = z
    .object({
      kind: z.literal("image_batch_attempt_scope"),
      version: z.literal(1),
      sessionId: z.string().uuid(),
      taskRootJobId: z.string().uuid(),
      manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      pages: z.array(pageSchema).min(1),
    })
    .strict();
  const original = await canonicalRow();
  expect(recordSchema.parse(JSON.parse(original.result))).toEqual(
    JSON.parse(original.result),
  );
  const scope = await upgradeImageBatchAttemptScope(
      db,
      originalContext,
      originalBatch,
    ),
    current = await canonicalRow(),
    upgraded = JSON.parse(current.result),
    archive = JSON.parse((await archives())[0]!.result);
  expect(scope).toEqual({ ...originalBatch.attemptScope, version: 2 });
  expect(current.id).toBe(original.id);
  expect(upgraded.version).toBe(2);
  expect(upgraded.predecessor).toEqual({
    operationId: (await archives())[0]!.id,
    digest: (await archives())[0]!.digest,
  });
  expect(archive.predecessor).toEqual(original);
  expect(recordSchema.parse(JSON.parse(archive.predecessor.result))).toEqual(
    JSON.parse(original.result),
  );
  const oldReaderResult = recordSchema.safeParse(upgraded);
  expect(oldReaderResult.success).toBe(false);
  if (oldReaderResult.success)
    throw Error("The actual old scope-v1 schema must reject v2");
  expect(
    oldReaderResult.error.issues.some(
      (issue) => issue.path.length === 1 && issue.path[0] === "version",
    ),
  ).toBe(true);
  expect(
    oldReaderResult.error.issues.some(
      (issue) =>
        issue.code === "unrecognized_keys" &&
        issue.keys.includes("predecessor"),
    ),
  ).toBe(true);
});

it("rejects retired v3 verification and explicit v1 registration instead of reopening the old scope, while explicit v2 registration remains unchanged", async () => {
  const scope = await upgradeImageBatchAttemptScope(
      db,
      originalContext,
      originalBatch,
    ),
    before = await operationRows(),
    args = {
      requirements: originalBatch.requirements,
      books: originalBatch.books,
    };
  await expect(
    verifyImageBatchAttemptScope(db, originalContext, originalBatch),
  ).rejects.toThrow();
  await expect(
    registerImageBatchAttemptScope(db, originalContext, args, { version: 1 }),
  ).rejects.toThrow();
  expect(
    await registerImageBatchAttemptScope(db, originalContext, args, {
      version: 2,
    }),
  ).toEqual(scope);
  expect(await operationRows()).toEqual(before);
  expect(
    await verifyImageBatchAttemptScope(
      db,
      originalContext,
      upgradedBatch(scope),
    ),
  ).toEqual(scope);
});

it("registers a fresh root as strict scope v2 with an explicit null predecessor and rejects an explicit v1 rewrite", async () => {
  const fresh = await job({
      input: { attachments: [originalBatch.books[0]!.source.assetId!] },
    }),
    requirements = await createImageBatchRequirements(
      db,
      {
        userId: owner.id,
        actor: owner,
        sessionId,
        currentJobId: fresh.jobId!,
      },
      fresh.jobId!,
      originalBatch.books.map((book) => book.source),
      "all-documents",
      ["A separate current root"],
    ),
    args = { requirements, books: originalBatch.books },
    scope = await registerImageBatchAttemptScope(db, fresh, args, {
      version: 2,
    });
  expect(scope.version).toBe(2);
  expect(scope.operationId).not.toBe(originalBatch.attemptScope.operationId);
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", scope.operationId)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(row.result)).toMatchObject({
    kind: "image_batch_attempt_scope",
    version: 2,
    predecessor: null,
  });
  expect(row.digest).toBe(digest(JSON.parse(row.result)));
  const freshBatch = imageBatchSchema.parse({
    ...originalBatch,
    version: 4,
    requirements,
    attemptScope: scope,
  });
  expect(await verifyImageBatchAttemptScope(db, fresh, freshBatch)).toEqual(
    scope,
  );
  await expect(
    validatePaidImageAttemptScope(
      db,
      fresh,
      freshBatch,
      {
        version: 1,
        scope: { ...scope, version: 1 },
        referenceImageId: page(),
        ordinal: 1,
      },
      page(),
    ),
  ).rejects.toThrow();
  const before = await operationRows();
  await expect(
    registerImageBatchAttemptScope(db, fresh, args, { version: 1 }),
  ).rejects.toThrow();
  expect(await operationRows()).toEqual(before);
  expect(await archives()).toHaveLength(0);
});

it.each([{ version: 4 }, { version: "2" }, {}])(
  "rejects explicitly supplied invalid register options %j without defaulting to the active v2 scope or changing any stored fact",
  async (options) => {
    const scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      args = {
        requirements: originalBatch.requirements,
        books: originalBatch.books,
      };
    // The exact same current scope is otherwise valid, so a rejection must come
    // from the explicit invalid options rather than a retired v1 registry.
    expect(
      await registerImageBatchAttemptScope(db, originalContext, args, {
        version: 2,
      }),
    ).toEqual(scope);
    const canonicalBefore = await canonicalRow(),
      archivesBefore = await archives(),
      operationsBefore = await operationRows(),
      metadataBefore = await metadataSnapshot();
    await expect(
      registerImageBatchAttemptScope(db, originalContext, args, options as any),
    ).rejects.toThrow();
    expect(await canonicalRow()).toEqual(canonicalBefore);
    expect(await archives()).toEqual(archivesBefore);
    expect(await operationRows()).toEqual(operationsBefore);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
  },
);

it("validates archived v1 and active v2 attempts without rewriting them and counts both paid operation kinds in the same capped original-page budget", async () => {
  const historical = [
    await seedFeeEnvelope(originalBatch, "image_generation", "failed"),
    await seedFeeEnvelope(originalBatch, "image_generation", "generating"),
  ];
  const metadataBefore = await metadataSnapshot(),
    historicalRows = historical.map((item) => item.row),
    scope = await upgradeImageBatchAttemptScope(
      db,
      originalContext,
      originalBatch,
    ),
    current = upgradedBatch(scope);
  expect(await metadataSnapshot()).toEqual(metadataBefore);
  for (const item of historical) {
    expect(
      await validatePaidImageAttemptScope(
        db,
        originalContext,
        current,
        item.paid,
        page(),
      ),
    ).toEqual(item.paid);
    expect(item.paid.version).toBe(1);
    expect(item.paid.scope).toEqual(originalBatch.attemptScope);
  }
  const limit = imagePageAttemptLimit();
  expect(limit).toBeGreaterThanOrEqual(5);
  const added = [];
  for (let ordinal = historical.length + 1; ordinal <= limit; ordinal++) {
    const item = await seedFeeEnvelope(
      current,
      ordinal === 3 ? "image_generation" : "image_revision",
      ordinal === 3 ? "saved" : ordinal === 4 ? "save_failed" : "failed",
    );
    expect(item.paid).toEqual({
      version: 2,
      scope,
      referenceImageId: page(),
      ordinal,
    });
    expect(
      await validatePaidImageAttemptScope(
        db,
        originalContext,
        current,
        item.paid,
        page(),
      ),
    ).toEqual(item.paid);
    added.push(item);
  }
  const active = await job({ batch: current });
  const before = await operationRows();
  await expect(reserve(active, current)).rejects.toThrow(`已提交${limit}次`);
  expect(await reserve(active, current, 0, historical[0]!.receipt)).toEqual(
    historical[0]!.paid,
  );
  expect(await reserve(active, current, 0, added.at(-1)!.receipt)).toEqual(
    added.at(-1)!.paid,
  );
  expect(await reserve(active, current, 1)).toEqual({
    version: 2,
    scope,
    referenceImageId: page(1),
    ordinal: 1,
  });
  expect(await operationRows()).toEqual(before);
  for (const row of historicalRows)
    expect(
      (await operationRows()).find((current) => current.id === row.id),
    ).toEqual(row);
});

it.each([
  ["image_generation", "generating"],
  ["image_generation", "saved"],
  ["image_generation", "save_failed"],
  ["image_generation", "failed"],
  ["image_revision", "generating"],
  ["image_revision", "saved"],
  ["image_revision", "save_failed"],
  ["image_revision", "failed"],
] as const)(
  "counts an explicitly scoped %s/%s fee envelope without creating or inventing any usage fact",
  async (kind, state) => {
    const scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope),
      stored = await seedFeeEnvelope(current, kind, state),
      active = await job({ batch: current });
    expect(await reserve(active, current)).toEqual({
      version: 2,
      scope,
      referenceImageId: page(),
      ordinal: 2,
    });
    expect(
      await validatePaidImageAttemptScope(
        db,
        active,
        current,
        stored.paid,
        page(),
      ),
    ).toEqual(stored.paid);
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", stored.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(stored.row);
  },
);

it.each(["generating", "saved", "save_failed", "failed"] as const)(
  "allows the first paid reservation while a same-job free reference-export is %s without counting or rewriting the export",
  async (state) => {
    const scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope),
      active = await job({ batch: current }),
      exported = await seedFreeExportEnvelope(active, state, {}, page(1)),
      operationsBefore = await operationRows(),
      metadataBefore = await metadataSnapshot();
    expect(exported).toEqual({
      kind: "image_generation",
      state,
      origin: "reference-export",
      generationOperationId: exported.generationOperationId,
      generation: {
        prompt: "Export the frozen original page without generating new pixels",
        referenceImageIds: [page(1)],
      },
    });
    expect(
      metadataBefore.jobs.find((row) => row.id === active.jobId),
    ).toMatchObject({ status: "running", cancelled: 0 });
    // The generating case reproduces the interleaving after the real export
    // inserts its initial receipt and before it saves the rendered page.
    expect(await reserve(active, current)).toEqual({
      version: 2,
      scope,
      referenceImageId: page(),
      ordinal: 1,
    });
    expect(await reserve(active, current, 1)).toEqual({
      version: 2,
      scope,
      referenceImageId: page(1),
      ordinal: 1,
    });
    expect(await operationRows()).toEqual(operationsBefore);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
    expect(metadataBefore.calls).toHaveLength(0);
  },
);

it.each([
  "providerCallId",
  "rawCandidate",
  "paidAttempt",
  "unknown-state",
  "version",
  "multiple-pages",
  "foreign-page",
] as const)(
  "rejects a free reference-export with %s before a paid reservation and preserves every fact",
  async (invalid) => {
    const scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope),
      active = await job({ batch: current }),
      paid = await reserve(active, current);
    expect(paid).toEqual({
      version: 2,
      scope,
      referenceImageId: page(),
      ordinal: 1,
    });
    const overrides: Record<string, unknown> =
      invalid === "providerCallId"
        ? { providerCallId: randomUUID() }
        : invalid === "rawCandidate"
          ? { rawCandidate: { version: 1, operationId: randomUUID() } }
          : invalid === "paidAttempt"
            ? { paidAttempt: paid }
            : invalid === "unknown-state"
              ? { state: "queued" }
              : invalid === "version"
                ? { version: 1 }
                : {
                    generation: {
                      prompt:
                        "Export the frozen original page without generating new pixels",
                      referenceImageIds:
                        invalid === "multiple-pages"
                          ? [page(), page(1)]
                          : [randomUUID()],
                    },
                  };
    await seedFreeExportEnvelope(active, "generating", overrides);
    const operationsBefore = await operationRows(),
      metadataBefore = await metadataSnapshot();
    await expect(reserve(active, current)).rejects.toThrow();
    expect(await operationRows()).toEqual(operationsBefore);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
    expect(metadataBefore.calls).toHaveLength(0);
  },
);

it("rejects an owned free export pointing to a foreign actor's exact-scope job even when the receipt contains no scope UUID", async () => {
  const scope = await upgradeImageBatchAttemptScope(
      db,
      originalContext,
      originalBatch,
    ),
    current = upgradedBatch(scope),
    active = await job({ batch: current });
  expect(await reserve(active, current)).toEqual({
    version: 2,
    scope,
    referenceImageId: page(),
    ordinal: 1,
  });
  const foreignSessionId = await session(other),
    foreign = await job({
      actor: other,
      sessionId: foreignSessionId,
      batch: current,
    });
  // Deliberately corrupt only the isolated metadata association: an operation
  // owned by this actor points at another actor's real stored checkpoint.
  const exported = await seedFreeExportEnvelope(
    { ...foreign, actor: owner },
    "generating",
  );
  expect(JSON.stringify(exported)).not.toContain(scope.operationId);
  const operationsBefore = await operationRows(),
    metadataBefore = await metadataSnapshot(),
    foreignJob = metadataBefore.jobs.find((row) => row.id === foreign.jobId);
  expect(foreignJob).toMatchObject({
    user_id: other.id,
    session_id: foreignSessionId,
    status: "running",
  });
  expect(
    JSON.parse(foreignJob!.result).checkpoint.imageBatch.attemptScope,
  ).toEqual(scope);
  expect(
    operationsBefore.find((row) => row.id === exported.generationOperationId),
  ).toMatchObject({ user_id: owner.id, job_id: foreign.jobId });
  await expect(reserve(active, current)).rejects.toMatchObject({
    status: 409,
    message:
      "批次图片尝试回执无有效 paidAttempt，不能推断次数或继续计费；原记录保留",
  });
  expect(await operationRows()).toEqual(operationsBefore);
  expect(await metadataSnapshot()).toEqual(metadataBefore);
  expect(metadataBefore.calls).toHaveLength(0);
});

it("refuses upgrade while a same-scope generating request has a live running job and preserves all records without an archive", async () => {
  await seedFeeEnvelope(originalBatch, "image_generation", "generating", true);
  const before = await operationRows(),
    metadataBefore = await metadataSnapshot();
  await expect(
    upgradeImageBatchAttemptScope(db, originalContext, originalBatch),
  ).rejects.toThrow();
  expect(await operationRows()).toEqual(before);
  expect(await metadataSnapshot()).toEqual(metadataBefore);
  expect(await archives()).toHaveLength(0);
});

it.each(["failed", "expired", "cancelled"] as const)(
  "retains and counts a dormant %s job's unknown generating attempt while allowing the explicit scope upgrade",
  async (dormant) => {
    const stored = await seedFeeEnvelope(
      originalBatch,
      "image_generation",
      "generating",
      true,
    );
    await db
      .updateTable("ai_jobs")
      .set(
        dormant === "failed"
          ? { status: "failed", lease: null, lease_until: null }
          : dormant === "expired"
            ? { lease_until: new Date(0).toISOString() }
            : { cancelled: 1 },
      )
      .where("id", "=", stored.context.jobId!)
      .execute();
    const metadataBefore = await metadataSnapshot(),
      scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", stored.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(stored.row);
    expect(
      await validatePaidImageAttemptScope(
        db,
        originalContext,
        current,
        stored.paid,
        page(),
      ),
    ).toEqual(stored.paid);
    const active = await job({ batch: current });
    expect(await reserve(active, current)).toEqual({
      version: 2,
      scope,
      referenceImageId: page(),
      ordinal: 2,
    });
  },
);

it.each(["kind", "paid-version", "revision-version"] as const)(
  "rejects an associated unknown %s before counting or reserving, rather than skipping the operation",
  async (unknown) => {
    const scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope),
      stored = await seedFeeEnvelope(
        current,
        unknown === "revision-version" ? "image_revision" : "image_generation",
        "failed",
      ),
      changed = structuredClone(stored.receipt) as any;
    if (unknown === "kind") changed.kind = "future_paid_image";
    else if (unknown === "paid-version") changed.paidAttempt.version = 999;
    else changed.version = 999;
    await db
      .updateTable("ai_operations")
      .set({ result: JSON.stringify(changed), digest: digest(changed) })
      .where("id", "=", stored.id)
      .execute();
    const active = await job({ batch: current }),
      before = await operationRows(),
      metadataBefore = await metadataSnapshot();
    await expect(reserve(active, current)).rejects.toThrow();
    expect(await operationRows()).toEqual(before);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
  },
);

it.each(["kind", "paid-version"] as const)(
  "rejects an associated historical v1 unknown %s transactionally before the first upgrade creates any archive",
  async (unknown) => {
    const stored = await seedFeeEnvelope(
        originalBatch,
        "image_generation",
        "failed",
      ),
      changed = structuredClone(stored.receipt) as any;
    expect(stored.paid.version).toBe(1);
    if (unknown === "kind") changed.kind = "future_paid_image";
    else changed.paidAttempt.version = 999;
    await db
      .updateTable("ai_operations")
      .set({ result: JSON.stringify(changed), digest: digest(changed) })
      .where("id", "=", stored.id)
      .execute();
    const before = await operationRows(),
      metadataBefore = await metadataSnapshot();
    await expect(
      upgradeImageBatchAttemptScope(db, originalContext, originalBatch),
    ).rejects.toThrow();
    expect(await operationRows()).toEqual(before);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
    expect(await archives()).toHaveLength(0);
    expect(JSON.parse((await canonicalRow()).result).version).toBe(1);
  },
);

it("accepts explicit safe historical ordinals beyond today's cap but rejects missing, fractional, zero and unsafe values without a guessed ordinal", async () => {
  const reserved = await reserve(originalContext, originalBatch);
  if (!reserved) throw Error("Fixture requires the original v1 reservation");
  const high: PaidImageAttempt = {
    ...reserved,
    ordinal: Number.MAX_SAFE_INTEGER,
  };
  expect(paidImageAttemptSchema.parse(high)).toEqual(high);
  const scope = await upgradeImageBatchAttemptScope(
      db,
      originalContext,
      originalBatch,
    ),
    current = upgradedBatch(scope);
  expect(
    await validatePaidImageAttemptScope(
      db,
      originalContext,
      current,
      high,
      page(),
    ),
  ).toEqual(high);
  for (const ordinal of [undefined, 0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...reserved, ordinal };
    expect(paidImageAttemptSchema.safeParse(invalid).success).toBe(false);
    await expect(
      validatePaidImageAttemptScope(
        db,
        originalContext,
        current,
        invalid,
        page(),
      ),
    ).rejects.toThrow();
  }
  const newHigh = { ...high, version: 2, scope };
  expect(paidImageAttemptSchema.parse(newHigh)).toEqual(newHigh);
  expect(
    await validatePaidImageAttemptScope(
      db,
      originalContext,
      current,
      newHigh,
      page(),
    ),
  ).toEqual(newHigh);
  expect(
    paidImageAttemptSchema.safeParse({ ...reserved, version: 1, scope })
      .success,
  ).toBe(false);
});

it.each([
  "actor",
  "session",
  "page-order",
  "source-sha",
  "scope-digest",
] as const)(
  "rejects a changed %s binding before upgrade and preserves the exact invalid state without repair or archive",
  async (binding) => {
    let context = originalContext,
      value = originalBatch;
    if (binding === "actor") context = { ...originalContext, actor: other };
    else if (binding === "session")
      context = await job({
        sessionId: await session(),
        batch: originalBatch,
        input: { attachments: [originalBatch.books[0]!.source.assetId!] },
      });
    else if (binding === "page-order") {
      const changed = structuredClone(originalBatch);
      changed.books[0]!.pages.reverse();
      const parsed = imageBatchSchema.parse(changed);
      if (parsed.version !== 3)
        throw Error("Fixture requires a v3 page-order mutation");
      value = parsed;
    } else if (binding === "source-sha")
      await db
        .updateTable("file_storage_objects")
        .set({ sha256: "f".repeat(64) })
        .where(
          "id",
          "=",
          originalBatch.requirements.scope.inputManifest[0]!.objectId,
        )
        .execute();
    else
      await db
        .updateTable("ai_operations")
        .set({ digest: "f".repeat(64) })
        .where("id", "=", originalBatch.attemptScope.operationId)
        .execute();
    const before = await operationRows(),
      metadataBefore = await metadataSnapshot();
    await expect(
      upgradeImageBatchAttemptScope(db, context, value),
    ).rejects.toThrow();
    expect(await operationRows()).toEqual(before);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
    expect(await archives()).toHaveLength(0);
  },
);

it.each(["actor", "session", "page", "scope-digest"] as const)(
  "refuses an archived historical paid attempt with the wrong %s instead of treating it as a current-scope payment",
  async (binding) => {
    const historical = await seedFeeEnvelope(
        originalBatch,
        "image_generation",
        "saved",
      ),
      scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope);
    let context = originalContext,
      requestedPage = page(),
      paid: unknown = historical.paid;
    if (binding === "actor") context = { ...originalContext, actor: other };
    else if (binding === "session")
      context = await job({ sessionId: await session(), batch: current });
    else if (binding === "page") requestedPage = page(1);
    else
      paid = {
        ...historical.paid,
        scope: { ...historical.paid.scope, manifestDigest: "f".repeat(64) },
      };
    const before = await operationRows(),
      metadataBefore = await metadataSnapshot();
    await expect(
      validatePaidImageAttemptScope(db, context, current, paid, requestedPage),
    ).rejects.toThrow();
    expect(await operationRows()).toEqual(before);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
  },
);

it.each(["image_generation", "image_revision"] as const)(
  "rejects a %s fee envelope whose explicit original page differs from its valid paid-attempt page",
  async (kind) => {
    const scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope),
      stored = await seedFeeEnvelope(current, kind, "failed"),
      receipt = structuredClone(stored.receipt) as any;
    if (kind === "image_generation")
      receipt.generation.referenceImageIds[0] = page(1);
    else receipt.originalReferenceImageId = page(1);
    await db
      .updateTable("ai_operations")
      .set({ result: JSON.stringify(receipt), digest: digest(receipt) })
      .where("id", "=", stored.id)
      .execute();
    const active = await job({ batch: current }),
      before = await operationRows();
    await expect(reserve(active, current)).rejects.toThrow();
    expect(await operationRows()).toEqual(before);
  },
);

it.each(["result-only", "result-and-digest"] as const)(
  "refuses a changed archive %s on verification, carry-forward and repeat upgrade without restoring the retired registry",
  async (mutation) => {
    const historical = await seedFeeEnvelope(
        originalBatch,
        "image_generation",
        "generating",
      ),
      scope = await upgradeImageBatchAttemptScope(
        db,
        originalContext,
        originalBatch,
      ),
      current = upgradedBatch(scope),
      archive = (await archives())[0]!,
      changed = JSON.parse(archive.result);
    changed.predecessor.result += " ";
    await db
      .updateTable("ai_operations")
      .set({
        result: JSON.stringify(changed),
        ...(mutation === "result-and-digest"
          ? { digest: digest(changed) }
          : {}),
      })
      .where("id", "=", archive.id)
      .execute();
    const active = await job({ batch: current }),
      before = await operationRows(),
      metadataBefore = await metadataSnapshot();
    await expect(
      verifyImageBatchAttemptScope(db, active, current),
    ).rejects.toThrow();
    await expect(
      validatePaidImageAttemptScope(
        db,
        active,
        current,
        historical.paid,
        page(),
      ),
    ).rejects.toThrow();
    await expect(reserve(active, current)).rejects.toThrow();
    await expect(
      upgradeImageBatchAttemptScope(db, originalContext, originalBatch),
    ).rejects.toThrow();
    expect(await operationRows()).toEqual(before);
    expect(await metadataSnapshot()).toEqual(metadataBefore);
    expect(JSON.parse((await canonicalRow()).result).version).toBe(2);
  },
);

describe("explicit local scope v3", () => {
  async function startLocalScope(seed?: () => Promise<void>) {
    if (seed) await seed();
    const oldScope = await upgradeImageBatchAttemptScope(
      db,
      originalContext,
      originalBatch,
    );
    const batch = upgradedBatch(oldScope);
    const predecessor = await canonicalRow();
    await db
      .updateTable("ai_jobs")
      .set({ status: "failed", lease: null, lease_until: null })
      .where("id", "=", originalContext.jobId!)
      .execute();
    const ctx = await job({ batch });
    return { ctx, batch, predecessor };
  }
  async function activateLocal(
    value: Awaited<ReturnType<typeof startLocalScope>>,
  ) {
    const scope = await upgradeLocalImageBatchAttemptScope(
      db,
      value.ctx,
      value.batch,
    );
    const batch = imageBatchSchema.parse({
      ...value.batch,
      version: 5,
      attemptScope: scope,
    });
    if (batch.version !== 5) throw Error("Expected explicit batch5/scope3");
    await attachBatch(value.ctx, batch);
    return { ...value, scope, current: batch };
  }
  async function localFee(
    batch: Extract<ImageBatch, { version: 5 }>,
    kind: "generation" | "whole" | "local",
    state: FeeState,
  ) {
    const ctx = await job({ batch });
    const paid = await reserve(ctx, batch);
    if (!paid || paid.version !== 3) throw Error("Expected paid3");
    const id = randomUUID();
    // Deliberately fee-envelope metadata, not a rendered receipt or charged call.
    const value =
      kind === "generation"
        ? {
            kind: "image_generation",
            version: 1,
            state,
            generationOperationId: id,
            generation: {
              prompt: "Current original-page request",
              referenceImageIds: [page()],
            },
            paidAttempt: paid,
          }
        : {
            kind: "image_revision",
            version: 2,
            mode: kind,
            state,
            generationOperationId: id,
            originalReferenceImageId: page(),
            paidAttempt: paid,
          };
    await db
      .insertInto("ai_operations")
      .values({
        id,
        user_id: owner.id,
        job_id: ctx.jobId!,
        digest: digest(value),
        result: JSON.stringify(value),
        created_at: new Date().toISOString(),
      })
      .execute();
    await db
      .updateTable("ai_jobs")
      .set({ status: "failed", lease: null, lease_until: null })
      .where("id", "=", ctx.jobId!)
      .execute();
    return { id, value, paid };
  }

  it("archives exact scope2 and its immutable scope1 chain at the SAME namespace1 ID without rewriting historical checkpoints or original usage", async () => {
    const value = await startLocalScope(),
      beforeJobs = await metadataSnapshot(),
      firstArchive = await archives();
    const scope = await upgradeLocalImageBatchAttemptScope(
      db,
      value.ctx,
      value.batch,
    );
    expect(scope).toEqual({ ...value.batch.attemptScope, version: 3 });
    expect(await metadataSnapshot()).toEqual(beforeJobs);
    const all = await archives();
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.id === firstArchive[0]!.id)).toEqual(
      firstArchive[0],
    );
    const archive2 = all.find((row) => JSON.parse(row.result).version === 2)!;
    expect(JSON.parse(archive2.result).predecessor).toEqual(value.predecessor);
    expect(archive2.digest).toBe(digest(JSON.parse(archive2.result)));
    const canonical = await canonicalRow();
    expect(canonical.id).toBe(value.predecessor.id);
    expect(canonical.created_at).toBe(value.predecessor.created_at);
    expect(JSON.parse(canonical.result)).toMatchObject({
      version: 3,
      predecessor: { operationId: archive2.id, digest: archive2.digest },
    });
    const active = imageBatchSchema.parse({
      ...value.batch,
      version: 5,
      attemptScope: scope,
    });
    expect(await verifyImageBatchAttemptScope(db, value.ctx, active)).toEqual(
      scope,
    );
    await expect(
      verifyImageBatchAttemptScope(db, value.ctx, value.batch),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      upgradeLocalImageBatchAttemptScope(db, value.ctx, value.batch),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects captured ACTUAL whole-only reader resume/register/reserve on canonical3 while new code can restore batch5 and continue the unchanged ordinal", async () => {
    const active = await activateLocal(await startLocalScope());
    const old = await import("./fixtures/ai-image-batch-attempts-whole-v2.js");
    const stale = await job({ batch: active.batch });
    const before = await operationRows();
    await expect(
      old.verifyImageBatchAttemptScope(db, stale, active.batch),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      old.registerImageBatchAttemptScope(db, stale, {
        requirements: active.batch.requirements,
        books: active.batch.books,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transact(db, async (tx) => {
        await lockAIUser(tx, owner.id);
        return old.reserveImageBatchAttempt(
          tx,
          stale,
          active.batch.attemptScope,
          page(),
          { paid: true },
        );
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await operationRows()).toEqual(before);
    expect(
      await verifyImageBatchAttemptScope(db, active.ctx, active.current),
    ).toEqual(active.scope);
    expect(await reserve(active.ctx, active.current)).toMatchObject({
      version: 3,
      ordinal: 1,
      scope: active.scope,
    });
    const registration = await registerImageBatchAttemptScope(db, active.ctx, {
      requirements: active.current.requirements,
      books: active.current.books,
    });
    expect(registration).toEqual(active.scope);
  });

  it("keeps paid1 and paid2 only through their verified archive lineage and counts generation1/revision2 whole/local in the same five-attempt original-page budget", async () => {
    let paid1: PaidImageAttempt;
    const initial = await startLocalScope(async () => {
      paid1 = (
        await seedFeeEnvelope(originalBatch, "image_generation", "generating")
      ).paid;
    });
    const historical2 = await seedFeeEnvelope(
      initial.batch,
      "image_revision",
      "save_failed",
    );
    const active = await activateLocal(initial);
    expect(
      await validatePaidImageAttemptScope(
        db,
        active.ctx,
        active.current,
        paid1!,
        page(),
      ),
    ).toEqual(paid1!);
    expect(
      await validatePaidImageAttemptScope(
        db,
        active.ctx,
        active.current,
        historical2.paid,
        page(),
      ),
    ).toEqual(historical2.paid);
    for (const [kind, state] of [
      ["generation", "failed"],
      ["whole", "saved"],
      ["local", "generating"],
    ] as const) {
      const item = await localFee(active.current, kind, state);
      expect(item.paid).toMatchObject({
        version: 3,
        ordinal: kind === "generation" ? 3 : kind === "whole" ? 4 : 5,
      });
    }
    const before = await operationRows();
    await expect(reserve(active.ctx, active.current)).rejects.toMatchObject({
      status: 409,
    });
    expect(await operationRows()).toEqual(before);
  });

  it.each(["generation", "whole", "local"] as const)(
    "counts every %s state including dormant unknown outcomes",
    async (kind) => {
      const active = await activateLocal(await startLocalScope());
      for (const state of [
        "generating",
        "saved",
        "save_failed",
        "failed",
      ] as const) {
        const item = await localFee(active.current, kind, state);
        expect(item.paid.ordinal).toBe(
          ["generating", "saved", "save_failed", "failed"].indexOf(state) + 1,
        );
      }
      expect(await reserve(active.ctx, active.current)).toMatchObject({
        ordinal: 5,
        version: 3,
      });
    },
  );

  it.each(["checkpoint", "empty", "expired"] as const)(
    "rejects another %s live executor before changing scope, archive, history or leases",
    async (shape) => {
      const value = await startLocalScope();
      const other = await job({
        ...(shape === "empty" ? {} : { batch: value.batch }),
      });
      if (shape === "expired")
        await db
          .updateTable("ai_jobs")
          .set({ lease_until: new Date(Date.now() - 1000).toISOString() })
          .where("id", "=", other.jobId!)
          .execute();
      const before = await operationRows(),
        metadata = await metadataSnapshot();
      await expect(
        upgradeLocalImageBatchAttemptScope(db, value.ctx, value.batch),
      ).rejects.toMatchObject({ status: 409 });
      expect(await operationRows()).toEqual(before);
      expect(await metadataSnapshot()).toEqual(metadata);
      expect(JSON.parse((await canonicalRow()).result).version).toBe(2);
    },
  );

  it("allows a different-session live task and preserves a cancelled same-session dormant unknown attempt without releasing or resetting it", async () => {
    const value = await startLocalScope();
    const unknown = await seedFeeEnvelope(
      value.batch,
      "image_generation",
      "generating",
      true,
    );
    await db
      .updateTable("ai_jobs")
      .set({ cancelled: 1 })
      .where("id", "=", unknown.context.jobId!)
      .execute();
    const other = await job({ sessionId: await session() });
    const otherBefore = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", other.jobId!)
      .executeTakeFirstOrThrow();
    const active = await activateLocal(value);
    expect(await reserve(active.ctx, active.current)).toMatchObject({
      ordinal: 2,
      version: 3,
    });
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", unknown.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(unknown.row);
    expect(
      await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", other.jobId!)
        .executeTakeFirstOrThrow(),
    ).toEqual(otherBefore);
  });

  it.each([1, 2] as const)(
    "rejects tampering with archive v%s even if its row digest is recomputed",
    async (version) => {
      const active = await activateLocal(await startLocalScope());
      const row = (await archives()).find(
        (row) => JSON.parse(row.result).version === version,
      )!;
      const changed = JSON.parse(row.result);
      changed.predecessor.result += " ";
      await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(changed), digest: digest(changed) })
        .where("id", "=", row.id)
        .execute();
      const before = await operationRows();
      await expect(
        verifyImageBatchAttemptScope(db, active.ctx, active.current),
      ).rejects.toMatchObject({ status: 409 });
      await expect(reserve(active.ctx, active.current)).rejects.toMatchObject({
        status: 409,
      });
      expect(await operationRows()).toEqual(before);
    },
  );

  it.each(["version", "mode", "scope", "page"] as const)(
    "rejects invalid current fee %s without inferring or rewriting its association",
    async (change) => {
      const active = await activateLocal(await startLocalScope());
      const item = await localFee(active.current, "local", "save_failed");
      const invalid: any = structuredClone(item.value);
      if (change === "version") invalid.version = 9;
      if (change === "mode") invalid.mode = "automatic";
      if (change === "scope")
        invalid.paidAttempt.scope.manifestDigest = "f".repeat(64);
      if (change === "page") invalid.originalReferenceImageId = page(1);
      await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(invalid), digest: digest(invalid) })
        .where("id", "=", item.id)
        .execute();
      const before = await operationRows();
      await expect(reserve(active.ctx, active.current)).rejects.toMatchObject({
        status: 409,
      });
      expect(await operationRows()).toEqual(before);
    },
  );

  it.each([
    "current-image",
    "stored-snapshot",
    "original-root",
    "readonly",
  ] as const)(
    "rejects an ineligible %s upgrade without changing any archived or current record",
    async (cause) => {
      const value = await startLocalScope();
      let ctx: ToolContext = value.ctx;
      if (cause === "current-image")
        await seedFreeExportEnvelope(ctx, "generating");
      if (cause === "stored-snapshot")
        await attachBatch(ctx, {
          ...value.batch,
          notes: "Changed actual checkpoint",
        });
      if (cause === "original-root") {
        await db
          .updateTable("ai_jobs")
          .set({
            status: "running",
            lease: originalContext.lease!,
            lease_until: new Date(Date.now() + 60000).toISOString(),
          })
          .where("id", "=", originalContext.jobId!)
          .execute();
        await attachBatch(originalContext, value.batch);
        ctx = originalContext;
      }
      if (cause === "readonly") ctx = { ...ctx, writable: false };
      const before = await operationRows(),
        metadata = await metadataSnapshot();
      await expect(
        upgradeLocalImageBatchAttemptScope(db, ctx, value.batch),
      ).rejects.toThrow();
      expect(await operationRows()).toEqual(before);
      expect(await metadataSnapshot()).toEqual(metadata);
    },
  );

  it("excludes only explicit scope3 versioned free exports from the new paid counter", async () => {
    const active = await activateLocal(await startLocalScope());
    await seedFreeExportEnvelope(
      active.ctx,
      "generating",
      { version: 1 },
      page(1),
    );
    const before = await operationRows();
    expect(await reserve(active.ctx, active.current)).toMatchObject({
      version: 3,
      ordinal: 1,
    });
    expect(await operationRows()).toEqual(before);
    await seedFreeExportEnvelope(active.ctx, "saved", {}, page(1));
    const invalidBefore = await operationRows();
    await expect(reserve(active.ctx, active.current)).rejects.toMatchObject({
      status: 409,
    });
    expect(await operationRows()).toEqual(invalidBefore);
  });

  it.each(["generation", "revision"] as const)(
    "counts a complete strict new %s receipt and its matching raw protocol without counting raw twice or permitting wrong-parent binding",
    async (kind) => {
      const active = await activateLocal(await startLocalScope());
      const paid = await reserve(active.ctx, active.current);
      if (!paid || paid.version !== 3) throw Error("Expected current paid3");
      const candidates =
        await import("../apps/server/src/services/ai/image-candidates.js");
      const contract =
        await import("../apps/server/src/services/ai/image-revision-contract.js");
      const id = randomUUID(),
        baseId = randomUUID(),
        rawAsset = randomUUID(),
        callId = randomUUID();
      const original = {
        referenceImageId: page(),
        sha256: "a".repeat(64),
        size: 16,
        width: 2,
        height: 2,
      };
      const base = {
        referenceImageId: baseId,
        sha256: "b".repeat(64),
        size: 16,
        width: 2,
        height: 2,
        operationId: randomUUID(),
        receiptDigest: "c".repeat(64),
      };
      const binding = {
        version: 2 as const,
        mode: "whole" as const,
        actorId: owner.id,
        sessionId,
        attemptScope: active.scope,
        requirementsDigest: digest(active.current.requirements),
        original,
        base,
      };
      const rawId =
        kind === "revision"
          ? candidates.revisionRawImageCandidateV2ReceiptId(id)
          : candidates.rawImageCandidateReceiptId(id);
      const reference = kind === "revision" ? { ...base } : original;
      if (kind === "revision") {
        delete (reference as any).operationId;
        delete (reference as any).receiptDigest;
      }
      // COMPLETE schema-validated metadata; no real bytes/storage/provider/usage are claimed.
      const raw = (
        kind === "revision"
          ? candidates.revisionRawImageCandidateV2ReceiptSchema
          : candidates.rawImageCandidateReceiptSchema
      ).parse({
        kind:
          kind === "revision" ? "image_revision_raw" : "image_raw_candidate",
        version: kind === "revision" ? 2 : 1,
        state: "saved",
        origin: "provider",
        generationOperationId: id,
        providerCallId: callId,
        assetId: rawAsset,
        profileId: "isolated",
        objectKey: "fixture-only/raw",
        mime: "image/png",
        size: 16,
        sha256: "d".repeat(64),
        dimensions: { width: 2, height: 2 },
        references: [reference],
        scope: { resourceId: null, jobId: active.ctx.jobId!, sessionId },
        request: {
          modelId: "isolated",
          model: "isolated",
          protocol: "openai-edits",
          prompt: "Fixture-only raw",
          size: { width: 2, height: 2 },
          transportDimensions: [{ width: 2, height: 2 }],
        },
        transform: { kind: "full" },
        nativeUsage: { state: "not-reported" },
        ...(kind === "revision"
          ? {
              mode: "whole",
              binding,
              providerReferences: [
                { ...reference, order: 0, role: "base", mime: "image/png" },
              ],
            }
          : {}),
      });
      const rawCandidate = {
        ...(kind === "revision" ? { kind: "image_revision_raw" } : {}),
        version: kind === "revision" ? 2 : 1,
        receiptId: rawId,
        assetId: rawAsset,
        sha256: raw.sha256,
      };
      const parent =
        kind === "revision"
          ? contract.imageRevisionV2ReceiptSchema.parse({
              kind: "image_revision",
              version: 2,
              mode: "whole",
              state: "saved",
              generationOperationId: id,
              originalReferenceImageId: page(),
              binding,
              providerReferenceImageIds: [baseId],
              providerReferences: [
                { ...reference, order: 0, role: "base", mime: "image/png" },
              ],
              reviewGeneration: {
                prompt: "Fixture-only complete receipt",
                referenceImageIds: [page()],
              },
              paidAttempt: paid,
              rawCandidate,
              providerCallId: callId,
              assetId: randomUUID(),
              filename: "fixture.png",
              width: 2,
              height: 2,
              mime: "image/png",
              size: 16,
              ready: true,
              url: "/fixture-only",
              instruction: "Metadata only, never a deliverable",
            })
          : {
              kind: "image_generation",
              version: 1,
              state: "saved",
              generationOperationId: id,
              generation: {
                prompt: "Fixture-only complete generation",
                referenceImageIds: [page()],
              },
              paidAttempt: paid,
              rawCandidate,
              providerCallId: callId,
              assetId: randomUUID(),
              filename: "fixture.png",
              width: 2,
              height: 2,
              mime: "image/png",
              size: 16,
              ready: true,
              url: "/fixture-only",
              instruction: "Metadata only, never a deliverable",
            };
      await db
        .insertInto("ai_operations")
        .values([
          {
            id,
            user_id: owner.id,
            job_id: active.ctx.jobId!,
            digest: digest(parent),
            result: JSON.stringify(parent),
            created_at: new Date().toISOString(),
          },
          {
            id: rawId,
            user_id: owner.id,
            job_id: active.ctx.jobId!,
            digest: digest(raw),
            result: JSON.stringify(raw),
            created_at: new Date().toISOString(),
          },
        ])
        .execute();
      expect(await reserve(active.ctx, active.current)).toMatchObject({
        version: 3,
        ordinal: 2,
      });
      const old =
        await import("./fixtures/ai-image-batch-attempts-whole-v2.js");
      await expect(
        old.verifyImageBatchAttemptScope(db, active.ctx, active.batch),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        old.registerImageBatchAttemptScope(db, active.ctx, {
          requirements: active.batch.requirements,
          books: active.batch.books,
        }),
      ).rejects.toMatchObject({ status: 409 });
      const invalid: any = structuredClone(raw);
      if (kind === "revision") invalid.binding.actorId = other.id;
      else invalid.references[0].referenceImageId = page(1);
      await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(invalid), digest: digest(invalid) })
        .where("id", "=", rawId)
        .execute();
      const before = await operationRows();
      await expect(reserve(active.ctx, active.current)).rejects.toMatchObject({
        status: 409,
      });
      expect(await operationRows()).toEqual(before);
    },
  );
});

it("registers a new original task as default scope3 with null predecessor and strict batch5 pairing, never converting the old task", async () => {
  const fresh = await job({
    input: { attachments: [originalBatch.books[0]!.source.assetId!] },
  });
  const requirements = await createImageBatchRequirements(
    db,
    { userId: owner.id, actor: owner, sessionId, currentJobId: fresh.jobId! },
    fresh.jobId!,
    originalBatch.books.map((book) => book.source),
    "all-documents",
    ["This is an explicitly separate formal task"],
  );
  const before = await canonicalRow();
  const scope = await registerImageBatchAttemptScope(db, fresh, {
    requirements,
    books: originalBatch.books,
  });
  expect(scope.version).toBe(3);
  expect(scope.operationId).not.toBe(before.id);
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", scope.operationId)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(row.result)).toMatchObject({
    version: 3,
    predecessor: null,
  });
  const batch = imageBatchSchema.parse({
    ...originalBatch,
    version: 5,
    attemptScope: scope,
    requirements,
  });
  await attachBatch(fresh, batch);
  expect(await verifyImageBatchAttemptScope(db, fresh, batch)).toEqual(scope);
  expect(await reserve(fresh, batch)).toMatchObject({ version: 3, ordinal: 1 });
  expect(imageBatchSchema.safeParse({ ...batch, version: 4 }).success).toBe(
    false,
  );
  expect(
    imageBatchSchema.safeParse({
      ...batch,
      attemptScope: { ...scope, version: 2 },
    }).success,
  ).toBe(false);
  for (const version of [1, 2] as const)
    await expect(
      registerImageBatchAttemptScope(
        db,
        fresh,
        { requirements, books: batch.books },
        { version },
      ),
    ).rejects.toMatchObject({ status: 409 });
  expect(await canonicalRow()).toEqual(before);
});
