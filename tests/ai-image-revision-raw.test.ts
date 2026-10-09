import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { beginCall, settleCall } from "@core/modules/ai/usage.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import {
  imageRevisionBindingSchema,
  imageRevisionReceiptSchema,
} from "../apps/server/src/services/ai/image-revision-contract.js";
import { imageModelProfiles } from "@core/modules/ai/image-model-catalog.js";
import {
  imageRevisionBindingV2Schema,
  imageRevisionV2ReceiptSchema,
  imageRevisionLocalPreviewSchema,
  imageRevisionBindingDigest,
  imageRevisionAnyReceiptSchema,
  isSavedImageReceipt,
  savedImageReviewGeneration,
  type RevisionProviderReference,
} from "../apps/server/src/services/ai/image-revision-contract.js";
import { prepareSavedLocalBitmap } from "../apps/server/src/services/ai/image-saved-local-bitmap.js";
import {
  rawImageReferences,
  rawImageCandidateSchema,
  rawImageCandidateReceiptId,
  rawImageCandidateCanvas,
  revisionRawImageCandidateSchema,
  revisionRawImageCandidateReceiptSchema,
  revisionRawImageCandidateReceiptId,
  saveRevisionRawImageCandidate,
  readRevisionRawImageCandidateRecord,
  readRawImageCandidateRecord,
  type SaveRawImageCandidateInput,
} from "../apps/server/src/services/ai/image-candidates.js";
import {
  revisionRawImageCandidateV2Schema,
  revisionRawImageCandidateV2ReceiptSchema,
  revisionRawImageCandidateV2ReceiptId,
  readAnyRevisionRawImageCandidateRecord,
  saveRawImageCandidate,
  type SaveRevisionRawImageCandidateInput,
} from "../apps/server/src/services/ai/image-candidates.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  ctx: ToolContext,
  sessionId: string;
let input: SaveRawImageCandidateInput & {
  binding: ReturnType<typeof imageRevisionBindingSchema.parse>;
};
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const png = (color: string, width = 80, height = 120) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
const runtime = () => ({ ...storage.storageRuntime(), root });
const rawRow = () =>
  db
    .selectFrom("ai_operations")
    .selectAll()
    .where(
      "id",
      "=",
      revisionRawImageCandidateReceiptId(input.generationOperationId),
    )
    .executeTakeFirst();
const parentRow = () =>
  db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", input.generationOperationId)
    .executeTakeFirstOrThrow();
async function job(session = sessionId) {
  const id = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      session_id: session,
      user_id: owner.id,
      model_id: "image",
      status: "running",
      input: "{}",
      digest: id,
      result: "",
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { actor: owner, jobId: id, lease, writable: true } as ToolContext;
}
async function reference(data: Buffer) {
  const id = randomUUID(),
    profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow();
  const key = objectKey(id, "image/png");
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), profile),
      key,
      data,
      "image/png",
      "fixture.png",
    );
  await db
    .insertInto("assets")
    .values({
      id,
      owner_id: owner.id,
      uploaded_by: owner.id,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: profile.id,
      object_key: key,
      filename: "fixture.png",
      mime: "image/png",
      size: data.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  return id;
}
async function readReferences(ids: string[], readerDB = db) {
  return Promise.all(
    ids.map(async (id) => {
      const asset = await readerDB
        .selectFrom("assets")
        .selectAll()
        .where("id", "=", id)
        .where("owner_id", "=", owner.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!asset) throw Error("Reference permission withdrawn");
      const profile = await readerDB
        .selectFrom("storage_profiles")
        .selectAll()
        .where("id", "=", asset.profile_id)
        .executeTakeFirstOrThrow();
      return {
        data: await storage
          .createStorage(runtime())
          .read(
            storage.storageConfigForProfile(runtime(), profile),
            asset.object_key,
            asset.size,
          ),
        mime: asset.mime,
        filename: asset.filename,
      };
    }),
  );
}
const options = () => ({
  storage: runtime(),
  authorize: async (tx: typeof db) => {
    await readReferences(
      input.references.map((reference) => reference.referenceImageId),
      tx,
    );
    await readReferences([input.binding.original.referenceImageId], tx);
  },
});
const read = (context = ctx, reader = readReferences) =>
  readRevisionRawImageCandidateRecord(
    db,
    context,
    input.generationOperationId,
    { storage: runtime(), readReferences: reader },
  );
async function rewriteParent(change: (value: any) => void) {
  const row = await parentRow(),
    value = JSON.parse(row.result);
  change(value);
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(value) })
    .where("id", "=", row.id)
    .execute();
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-revision-raw-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "revision-raw",
        displayName: "Owner",
        password: "isolated-revision-raw-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      vendors: [
        {
          id: "mock",
          name: "Fixture",
          provider: "openai",
          baseUrl: "https://unused.invalid/v1",
          apiKey: "fixture",
          enabled: true,
        },
      ],
      models: [
        {
          id: "image",
          vendorId: "mock",
          model: "gpt-image-test",
          alias: "Fixture",
          enabled: true,
          tools: false,
          imageGeneration: true,
          imageProfile: "gpt-image-2",
          imageRate: 1,
          maxInput: 32000,
          maxOutput: 1000,
        },
      ],
    },
    0,
  );
  sessionId = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: owner.id,
      title: "Revision raw fixture",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  ctx = await job();
  const originalId = await reference(await png("#2255aa")),
    baseId = await reference(await png("#bb6633")),
    identityId = await reference(await png("#44aa66", 64, 64));
  const [original] = await rawImageReferences(
    [originalId],
    await readReferences([originalId]),
  );
  const references = await rawImageReferences(
    [baseId, identityId],
    await readReferences([baseId, identityId]),
  );
  const binding = imageRevisionBindingSchema.parse({
    version: 1,
    actorId: owner.id,
    sessionId,
    requirementsDigest: "a".repeat(64),
    attemptScope: {
      version: 2,
      operationId: randomUUID(),
      taskRootJobId: ctx.jobId,
      manifestDigest: "b".repeat(64),
    },
    original,
    base: {
      ...references[0]!,
      operationId: randomUUID(),
      receiptDigest: "c".repeat(64),
    },
  });
  const call = await beginCall(
    db,
    owner.id,
    "image",
    ctx.jobId!,
    10,
    10,
    1,
    "80x120",
  );
  await settleCall(db, call.id, {
    input: 10,
    output: 10,
    images: 1,
    raw: { fixture: "actual isolated unit provider result" },
  });
  input = {
    generationOperationId: randomUUID(),
    providerCallId: call.id,
    bytes: await png("#dc2470", 40, 60),
    references,
    resourceId: null,
    request: {
      modelId: "image",
      model: "gpt-image-test",
      protocol: "openai-edits",
      prompt: "Correct the saved full page",
      size: { width: 80, height: 120 },
      transportDimensions: references.map(({ width, height }) => ({
        width,
        height,
      })),
    },
    transform: { kind: "full" },
    nativeUsage: { state: "not-reported" },
    binding,
  };
  const parent = imageRevisionReceiptSchema.parse({
    kind: "image_revision",
    version: 1,
    state: "generating",
    generationOperationId: input.generationOperationId,
    originalReferenceImageId: originalId,
    binding,
    providerReferenceImageIds: references.map(
      (reference) => reference.referenceImageId,
    ),
    reviewGeneration: {
      prompt: input.request.prompt,
      referenceImageIds: [originalId, identityId],
    },
    paidAttempt: {
      version: 2,
      scope: binding.attemptScope,
      referenceImageId: originalId,
      ordinal: 1,
    },
  });
  await db
    .insertInto("ai_operations")
    .values({
      id: input.generationOperationId,
      user_id: owner.id,
      job_id: ctx.jobId!,
      digest: digest(parent),
      result: JSON.stringify(parent),
      created_at: now,
    })
    .execute();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

it.each(["png", "jpeg"] as const)(
  "retains exact %s revision raw bytes, ordered provider sources and separate original without delivery or a new fee",
  async (format) => {
    if (format === "jpeg")
      input.bytes = await sharp(input.bytes).jpeg().toBuffer();
    const before = await db.selectFrom("ai_calls").selectAll().execute();
    const pointer = await saveRevisionRawImageCandidate(
      db,
      ctx,
      input,
      options(),
    );
    expect(pointer).toMatchObject({
      kind: "image_revision_raw",
      version: 1,
      receiptId: revisionRawImageCandidateReceiptId(
        input.generationOperationId,
      ),
      sha256: sha(input.bytes),
    });
    expect(pointer.receiptId).not.toBe(
      rawImageCandidateReceiptId(input.generationOperationId),
    );
    const reads: string[][] = [];
    const value = await read(ctx, async (ids) => {
      reads.push(ids);
      return readReferences(ids);
    });
    expect(value.data).toEqual(input.bytes);
    expect(value.candidate).toMatchObject({
      kind: "image_revision_raw",
      version: 1,
      state: "saved",
      binding: input.binding,
      references: input.references,
      nativeUsage: { state: "not-reported" },
      transform: { kind: "full" },
    });
    expect(value.sources.map((source) => sha(source.data))).toEqual(
      input.references.map((reference) => reference.sha256),
    );
    expect(reads.filter((ids) => ids.length === 1)).toEqual([
      [input.binding.original.referenceImageId],
      [input.binding.original.referenceImageId],
    ]);
    expect(reads.filter((ids) => ids.length === 2)).toEqual([
      input.references.map((reference) => reference.referenceImageId),
      input.references.map((reference) => reference.referenceImageId),
    ]);
    expect(JSON.parse((await parentRow()).result).rawCandidate).toEqual(
      pointer,
    );
    expect(await db.selectFrom("file_items").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual(
      before,
    );
    expect(rawImageCandidateSchema.safeParse(value.candidate).success).toBe(
      false,
    );
    await expect(
      readRawImageCandidateRecord(db, ctx, input.generationOperationId, {
        storage: runtime(),
        readReferences,
      }),
    ).rejects.toThrow("没有持久原始候选");
    await expect(
      rawImageCandidateCanvas(
        value.candidate as any,
        value.data,
        value.sources[0]!.data,
      ),
    ).rejects.toThrow();
    expect(
      await saveRevisionRawImageCandidate(db, ctx, input, options()),
    ).toEqual(pointer);
  },
);

it.each(["missing-binding", "base-order", "viewport"])(
  "rejects unsupported revision input %s before storing",
  async (kind) => {
    const supplied: any = structuredClone(input);
    supplied.bytes = input.bytes;
    if (kind === "missing-binding") delete supplied.binding;
    if (kind === "base-order") supplied.references.reverse();
    if (kind === "viewport")
      supplied.transform = {
        kind: "viewport",
        rect: { left: 0, top: 0, width: 80, height: 120 },
        workspace: null,
      };
    await expect(
      saveRevisionRawImageCandidate(db, ctx, supplied, options()),
    ).rejects.toThrow();
    expect(await rawRow()).toBeUndefined();
    expect(JSON.parse((await parentRow()).result)).not.toHaveProperty(
      "rawCandidate",
    );
  },
);

it.each(["kind", "version", "binding", "order"])(
  "rejects a changed parent %s without changing confirmed usage or writing raw",
  async (kind) => {
    await rewriteParent((value) => {
      if (kind === "kind") value.kind = "image_generation";
      if (kind === "version") value.version = 2;
      if (kind === "binding") value.binding.requirementsDigest = "d".repeat(64);
      if (kind === "order") value.providerReferenceImageIds.reverse();
    });
    const before = await parentRow(),
      calls = await db.selectFrom("ai_calls").selectAll().execute();
    await expect(
      saveRevisionRawImageCandidate(db, ctx, input, options()),
    ).rejects.toThrow();
    expect(await parentRow()).toEqual(before);
    expect(await rawRow()).toBeUndefined();
    expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual(
      calls,
    );
  },
);

it("retains confirmed revision raw after cancellation and a current-base pointer change, but does not adopt a final delivery", async () => {
  await db
    .updateTable("ai_jobs")
    .set({
      cancelled: 1,
      status: "cancelled",
      result: JSON.stringify({
        checkpoint: {
          delivered: {
            [input.binding.original.referenceImageId]: randomUUID(),
          },
        },
      }),
    })
    .where("id", "=", ctx.jobId!)
    .execute();
  const abort = new AbortController();
  abort.abort();
  const pointer = await saveRevisionRawImageCandidate(db, ctx, input, {
    ...options(),
    signal: abort.signal,
  });
  expect(JSON.parse((await rawRow())!.result).state).toBe("saved");
  const resumed = await job();
  const value = await read(resumed);
  expect(value.data).toEqual(input.bytes);
  expect(JSON.parse((await parentRow()).result)).toMatchObject({
    state: "generating",
    rawCandidate: pointer,
  });
  expect(await db.selectFrom("file_items").selectAll().execute()).toEqual([]);
  expect(
    (await db.selectFrom("ai_calls").selectAll().execute()).map(
      (call) => call.state,
    ),
  ).toEqual(["confirmed"]);
});

it.each([
  "original-changed",
  "original-revoked",
  "base-changed",
  "unknown-version",
  "parent-pointer",
])(
  "reauthorizes independent original and provider sources and rejects %s",
  async (kind) => {
    await saveRevisionRawImageCandidate(db, ctx, input, options());
    if (kind === "original-revoked")
      await db
        .updateTable("assets")
        .set({ deleted_at: new Date().toISOString() })
        .where("id", "=", input.binding.original.referenceImageId)
        .execute();
    if (kind === "original-changed" || kind === "base-changed") {
      const id =
        kind === "original-changed"
          ? input.binding.original.referenceImageId
          : input.binding.base.referenceImageId;
      const row = await db
        .selectFrom("assets")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const bytes = await png("#ffffff");
      await writeFile(join(root, row.object_key), bytes);
      await db
        .updateTable("assets")
        .set({ size: bytes.length })
        .where("id", "=", id)
        .execute();
    }
    if (kind === "unknown-version") {
      const row = (await rawRow())!,
        value = JSON.parse(row.result);
      value.version = 2;
      expect(
        revisionRawImageCandidateReceiptSchema.safeParse(value).success,
      ).toBe(false);
      await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(value) })
        .where("id", "=", row.id)
        .execute();
    }
    if (kind === "parent-pointer")
      await rewriteParent((value) => {
        value.rawCandidate.sha256 = "f".repeat(64);
      });
    await expect(read()).rejects.toThrow();
  },
);

it("rejects cross-session reading before authorizing any source bytes", async () => {
  await saveRevisionRawImageCandidate(db, ctx, input, options());
  const otherSession = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: otherSession,
      user_id: owner.id,
      title: "Other",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const another = await job(otherSession),
    reader = vi.fn(readReferences);
  await expect(read(another, reader)).rejects.toThrow("不属于当前会话");
  expect(reader).not.toHaveBeenCalled();
});

it("rejects a forged binding actor before storing, even with a matching strict parent", async () => {
  input.binding = { ...input.binding, actorId: randomUUID() };
  await rewriteParent((value) => {
    value.binding = input.binding;
  });
  const authorize = vi.fn(options().authorize);
  await expect(
    saveRevisionRawImageCandidate(db, ctx, input, {
      storage: runtime(),
      authorize,
    }),
  ).rejects.toThrow("账号或会话绑定无效");
  expect(authorize).not.toHaveBeenCalled();
  expect(await rawRow()).toBeUndefined();
});

it("rejects original access revoked between the two read boundaries", async () => {
  await saveRevisionRawImageCandidate(db, ctx, input, options());
  let originalReads = 0;
  await expect(
    read(ctx, async (ids) => {
      const values = await readReferences(ids);
      if (
        ids.length === 1 &&
        ids[0] === input.binding.original.referenceImageId &&
        ++originalReads === 1
      )
        await db
          .updateTable("assets")
          .set({ deleted_at: new Date().toISOString() })
          .where("id", "=", ids[0])
          .execute();
      return values;
    }),
  ).rejects.toThrow("permission withdrawn");
  expect(originalReads).toBe(1);
});

it("keeps failed storage evidence and confirmed fees when reference authorization is revoked before raw commit", async () => {
  const createStorage = storage.createStorage;
  vi.spyOn(storage, "createStorage").mockImplementation((value) => {
    const store = createStorage(value);
    return {
      ...store,
      put: async (...args) => {
        await store.put(...args);
        await db
          .updateTable("assets")
          .set({ deleted_at: new Date().toISOString() })
          .where("id", "=", input.binding.base.referenceImageId)
          .execute();
      },
    };
  });
  await expect(
    saveRevisionRawImageCandidate(db, ctx, input, options()),
  ).rejects.toThrow("permission withdrawn");
  const raw = JSON.parse((await rawRow())!.result);
  expect(raw).toMatchObject({
    kind: "image_revision_raw",
    state: "save_failed",
    failure: { stage: "commit", cleanup: "removed" },
  });
  expect(revisionRawImageCandidateReceiptSchema.safeParse(raw).success).toBe(
    true,
  );
  expect(
    await db
      .selectFrom("assets")
      .selectAll()
      .where("purpose", "=", "ai_image_candidate")
      .execute(),
  ).toEqual([]);
  expect(JSON.parse((await parentRow()).result)).not.toHaveProperty(
    "rawCandidate",
  );
  expect(
    (await db.selectFrom("ai_calls").selectAll().execute()).map(
      (call) => call.state,
    ),
  ).toEqual(["confirmed"]);
});

async function v2Fixture(mode: "whole" | "local") {
  const originalId = input.binding.original.referenceImageId;
  const ids = [
    ...input.references.map((ref) => ref.referenceImageId),
    ...(mode === "local" ? [originalId] : []),
  ];
  const sourceReferences = await readReferences(ids);
  const prepared =
    mode === "local"
      ? await prepareSavedLocalBitmap(
          sourceReferences[0]!.data,
          { left: 0.2, top: 0.25, width: 0.4, height: 0.25 },
          imageModelProfiles.find((profile) => profile.id === "gpt-image-2")!,
          4,
        )
      : undefined;
  const binding = imageRevisionBindingV2Schema.parse({
    ...input.binding,
    version: 2,
    mode,
    attemptScope: { ...input.binding.attemptScope, version: 3 },
    ...(prepared ? { localFacts: prepared.facts } : {}),
  });
  const actualReferences = sourceReferences.map((source, index) =>
    index === 0 && prepared
      ? {
          data: prepared.providerPNG,
          mime: "image/png",
          filename: "viewport.png",
        }
      : source,
  );
  const providerReferences: RevisionProviderReference[] = (
    await rawImageReferences(ids, actualReferences)
  ).map((facts, index) => ({
    ...facts,
    order: index,
    role:
      index === 0
        ? mode === "local"
          ? "base-viewport"
          : "base"
        : ids[index] === originalId
          ? "original-context"
          : "identity",
    mime: actualReferences[index]!.mime as "image/png",
  }));
  const previewBinding =
    binding.mode === "local"
      ? imageRevisionLocalPreviewSchema.parse({
          kind: "image_revision_local_preview",
          version: 1,
          binding,
          bindingDigest: imageRevisionBindingDigest(binding),
          geometryDigest: binding.localFacts.digest,
          instruction: "Current saved-base selection",
        })
      : undefined;
  const supplied: SaveRevisionRawImageCandidateInput = {
    ...input,
    mode,
    binding,
    providerReferences,
    references: await rawImageReferences(ids, sourceReferences),
    request: {
      ...input.request,
      size: prepared
        ? {
            width: prepared.facts.provider.width,
            height: prepared.facts.provider.height,
          }
        : input.request.size,
      transportDimensions: providerReferences.map(({ width, height }) => ({
        width,
        height,
      })),
    },
    transform: prepared
      ? { kind: "saved-local", facts: prepared.facts }
      : { kind: "full" },
  };
  const parent = imageRevisionV2ReceiptSchema.parse({
    kind: "image_revision",
    version: 2,
    mode,
    state: "generating",
    generationOperationId: input.generationOperationId,
    originalReferenceImageId: originalId,
    binding,
    providerReferenceImageIds: ids,
    providerReferences,
    reviewGeneration: {
      prompt: input.request.prompt,
      referenceImageIds: [originalId, ids[1]],
    },
    paidAttempt: {
      version: 3,
      scope: binding.attemptScope,
      referenceImageId: originalId,
      ordinal: 4,
    },
    ...(previewBinding ? { previewBinding } : {}),
  });
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(parent) })
    .where("id", "=", input.generationOperationId)
    .execute();
  const writeOptions = {
    storage: runtime(),
    authorize: async (tx: typeof db) => {
      await readReferences(ids, tx);
      await readReferences([originalId], tx);
    },
  };
  const reader = vi.fn(async () => actualReferences);
  const readOptions = {
    storage: runtime(),
    readReferences,
    readProviderReferences: reader,
  };
  return {
    supplied,
    writeOptions,
    readOptions,
    reader,
    prepared,
    sourceReferences,
    actualReferences,
    parent,
  };
}

it.each(["whole", "local"] as const)(
  "retains v2 %s raw with exact actual provider bytes and explicit roles, without reinterpreting v1",
  async (mode) => {
    const f = await v2Fixture(mode),
      calls = await db.selectFrom("ai_calls").selectAll().execute();
    const pointer = await saveRevisionRawImageCandidate(
      db,
      ctx,
      f.supplied,
      f.writeOptions,
    );
    expect(pointer).toMatchObject({
      kind: "image_revision_raw",
      version: 2,
      receiptId: revisionRawImageCandidateV2ReceiptId(
        input.generationOperationId,
      ),
      sha256: sha(input.bytes),
    });
    const result = await readAnyRevisionRawImageCandidateRecord(
      db,
      ctx,
      input.generationOperationId,
      f.readOptions,
    );
    if (result.candidate.version !== 2)
      throw Error("Expected an explicit v2 raw candidate");
    expect(result.candidate).toMatchObject({
      version: 2,
      mode,
      references: f.supplied.references,
      providerReferences: f.supplied.providerReferences,
    });
    expect(result.data).toEqual(input.bytes);
    expect(result.sources.map((ref) => sha(ref.data))).toEqual(
      f.actualReferences.map((ref) => sha(ref.data)),
    );
    expect(result.sourceReferences.map((ref) => sha(ref.data))).toEqual(
      f.sourceReferences.map((ref) => sha(ref.data)),
    );
    expect(f.reader).toHaveBeenCalledTimes(2);
    if (mode === "local") {
      expect(result.candidate.references[0]!.sha256).not.toBe(
        result.candidate.providerReferences[0]!.sha256,
      );
      expect(result.sources[0]!.data).not.toEqual(
        result.sourceReferences[0]!.data,
      );
      expect(result.candidate.transform).toMatchObject({
        kind: "saved-local",
        facts: f.prepared!.facts,
      });
    }
    expect(
      revisionRawImageCandidateReceiptSchema.safeParse(result.candidate)
        .success,
    ).toBe(false);
    expect(rawImageCandidateSchema.safeParse(result.candidate).success).toBe(
      false,
    );
    await expect(
      readRevisionRawImageCandidateRecord(
        db,
        ctx,
        input.generationOperationId,
        f.readOptions,
      ),
    ).rejects.toThrow("没有持久原始候选");
    await expect(
      rawImageCandidateCanvas(
        result.candidate as any,
        result.data,
        result.sourceReferences[0]!.data,
      ),
    ).rejects.toThrow();
    expect(
      await saveRevisionRawImageCandidate(db, ctx, f.supplied, f.writeOptions),
    ).toEqual(pointer);
    expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual(
      calls,
    );
    expect(await db.selectFrom("file_items").selectAll().execute()).toEqual([]);
  },
);

it.each([
  "missing-transmission-reader",
  "full-base-as-crop",
  "changed-transport-bytes",
  "changed-parent-roles",
])("rejects v2 actual transport ambiguity %s", async (defect) => {
  const f = await v2Fixture("local");
  await saveRevisionRawImageCandidate(db, ctx, f.supplied, f.writeOptions);
  const opts:
    | typeof f.readOptions
    | {
        storage: ReturnType<typeof runtime>;
        readReferences: typeof readReferences;
      } =
    defect === "missing-transmission-reader"
      ? { storage: runtime(), readReferences }
      : f.readOptions;
  if (defect === "full-base-as-crop")
    f.reader.mockImplementation(async () => f.sourceReferences);
  if (defect === "changed-transport-bytes")
    f.reader.mockImplementation(async () => [
      { ...f.actualReferences[0]!, data: await png("white") },
      ...f.actualReferences.slice(1),
    ]);
  if (defect === "changed-parent-roles")
    await rewriteParent((value) => {
      value.providerReferences[1].role = "original-context";
    });
  await expect(
    readAnyRevisionRawImageCandidateRecord(
      db,
      ctx,
      input.generationOperationId,
      opts,
    ),
  ).rejects.toThrow();
});

it.each([
  "provider-order",
  "wrong-mode",
  "wrong-workspace",
  "source-as-transport",
  "old-paid",
  "preview-base",
])(
  "rejects v2 %s before writing any raw receipt or losing paid facts",
  async (defect) => {
    const f = await v2Fixture("local"),
      supplied: any = structuredClone(f.supplied);
    supplied.bytes = input.bytes;
    if (defect === "provider-order") supplied.providerReferences.reverse();
    if (defect === "wrong-mode") supplied.binding.mode = "whole";
    if (defect === "wrong-workspace")
      supplied.transform.facts.workspace.contentRect.left += 1;
    if (defect === "source-as-transport")
      supplied.providerReferences[0] = {
        ...supplied.providerReferences[0],
        ...supplied.references[0],
      };
    if (defect === "old-paid")
      await rewriteParent((value) => {
        value.paidAttempt.version = 2;
      });
    if (defect === "preview-base")
      await rewriteParent((value) => {
        value.previewBinding.binding.base.sha256 = "d".repeat(64);
      });
    const before = await parentRow(),
      calls = await db.selectFrom("ai_calls").selectAll().execute();
    await expect(
      saveRevisionRawImageCandidate(db, ctx, supplied, f.writeOptions),
    ).rejects.toThrow();
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where(
          "id",
          "=",
          revisionRawImageCandidateV2ReceiptId(input.generationOperationId),
        )
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await parentRow()).toEqual(before);
    expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual(
      calls,
    );
  },
);

it("retains v2 paid raw after cancellation without adopting a final asset, and reauthorizes in a new same-session job", async () => {
  const f = await v2Fixture("local"),
    cancelled = new AbortController();
  cancelled.abort();
  await db
    .updateTable("ai_jobs")
    .set({ cancelled: 1, status: "cancelled" })
    .where("id", "=", ctx.jobId!)
    .execute();
  const pointer = await saveRevisionRawImageCandidate(db, ctx, f.supplied, {
    ...f.writeOptions,
    signal: cancelled.signal,
  });
  const resumed = await job(),
    result = await readAnyRevisionRawImageCandidateRecord(
      db,
      resumed,
      input.generationOperationId,
      f.readOptions,
    );
  expect(result.data).toEqual(input.bytes);
  expect(JSON.parse((await parentRow()).result)).toMatchObject({
    version: 2,
    state: "generating",
    rawCandidate: pointer,
  });
  expect(await db.selectFrom("file_items").selectAll().execute()).toEqual([]);
});

it("rejects a v2 cross-session read before reading full sources or reconstructing provider pixels", async () => {
  const f = await v2Fixture("local");
  await saveRevisionRawImageCandidate(db, ctx, f.supplied, f.writeOptions);
  const anotherSession = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: anotherSession,
      user_id: owner.id,
      title: "Other v2 session",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const another = await job(anotherSession),
    sourceReader = vi.fn(readReferences);
  await expect(
    readAnyRevisionRawImageCandidateRecord(
      db,
      another,
      input.generationOperationId,
      { ...f.readOptions, readReferences: sourceReader },
    ),
  ).rejects.toThrow("不属于当前会话");
  expect(sourceReader).not.toHaveBeenCalled();
  expect(f.reader).not.toHaveBeenCalled();
});

it("retains v2 storage failure facts and confirmed fee if base permission is withdrawn before commit", async () => {
  const f = await v2Fixture("local"),
    createStorage = storage.createStorage;
  vi.spyOn(storage, "createStorage").mockImplementation((value) => {
    const store = createStorage(value);
    return {
      ...store,
      put: async (...args) => {
        await store.put(...args);
        await db
          .updateTable("assets")
          .set({ deleted_at: new Date().toISOString() })
          .where("id", "=", f.supplied.binding.base.referenceImageId)
          .execute();
      },
    };
  });
  await expect(
    saveRevisionRawImageCandidate(db, ctx, f.supplied, f.writeOptions),
  ).rejects.toThrow("permission withdrawn");
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where(
      "id",
      "=",
      revisionRawImageCandidateV2ReceiptId(input.generationOperationId),
    )
    .executeTakeFirstOrThrow();
  const receipt = revisionRawImageCandidateV2ReceiptSchema.parse(
    JSON.parse(row.result),
  );
  expect(receipt).toMatchObject({
    version: 2,
    mode: "local",
    state: "save_failed",
    failure: { stage: "commit", cleanup: "removed" },
  });
  expect(
    await db
      .selectFrom("assets")
      .selectAll()
      .where("purpose", "=", "ai_image_candidate")
      .execute(),
  ).toEqual([]);
  expect(
    (await db.selectFrom("ai_calls").selectAll().execute()).map(
      (call) => call.state,
    ),
  ).toEqual(["confirmed"]);
});

it("binds a saved local canvas, preview and immutable raw; whole mode cannot acquire local semantics", async () => {
  const f = await v2Fixture("local");
  const pointer = await saveRevisionRawImageCandidate(
    db,
    ctx,
    f.supplied,
    f.writeOptions,
  );
  const facts = f.prepared!.facts,
    total = input.binding.base.width * input.binding.base.height,
    edited = facts.nativeRect.width * facts.nativeRect.height;
  const saved = {
    ...f.parent,
    state: "saved",
    assetId: randomUUID(),
    filename: "revision.png",
    rawCandidate: pointer,
    providerCallId: input.providerCallId,
    width: input.binding.base.width,
    height: input.binding.base.height,
    mime: "image/png",
    size: 1000,
    ready: true,
    url: "/fixture.png",
    instruction: "Review the complete original task",
    composition: {
      geometryDigest: facts.digest,
      actual: {
        width: 40,
        height: 60,
        sha256: pointer.sha256,
        rgbaSHA256: "d".repeat(64),
      },
      result: {
        width: input.binding.base.width,
        height: input.binding.base.height,
        sha256: "e".repeat(64),
        rgbaSHA256: "f".repeat(64),
        editedPixels: edited,
        preservedPixels: total - edited,
      },
    },
  };
  expect(imageRevisionAnyReceiptSchema.safeParse(saved).success).toBe(true);
  expect(imageRevisionReceiptSchema.safeParse(saved).success).toBe(false);
  expect(isSavedImageReceipt(saved)).toBe(true);
  expect(savedImageReviewGeneration(saved)).toEqual(f.parent.reviewGeneration);
  for (const change of [
    (value: any) => {
      value.version = 3;
    },
    (value: any) => {
      value.mode = "whole";
    },
    (value: any) => {
      delete value.previewBinding;
    },
    (value: any) => {
      delete value.composition;
    },
    (value: any) => {
      value.width += 1;
    },
    (value: any) => {
      value.composition.result.editedPixels -= 1;
      value.composition.result.preservedPixels += 1;
    },
    (value: any) => {
      value.composition.actual.sha256 = "0".repeat(64);
    },
    (value: any) => {
      value.previewBinding.bindingDigest = "0".repeat(64);
    },
  ]) {
    const invalid = structuredClone(saved);
    change(invalid);
    expect(imageRevisionAnyReceiptSchema.safeParse(invalid).success).toBe(
      false,
    );
    expect(isSavedImageReceipt(invalid)).toBe(false);
  }
  const old = JSON.parse((await parentRow()).result);
  old.version = 1;
  expect(imageRevisionReceiptSchema.safeParse(old).success).toBe(false);
});

it("does not accept fabricated local facts even when their declared digest and preview digest are recomputed", async () => {
  const f = await v2Fixture("local"),
    invalid: any = structuredClone(f.parent);
  invalid.binding.localFacts.workspace.inverseScale.x *= 0.5;
  const { digest: _digest, ...body } = invalid.binding.localFacts;
  invalid.binding.localFacts.digest = sha(Buffer.from(JSON.stringify(body)));
  invalid.previewBinding.binding = invalid.binding;
  invalid.previewBinding.geometryDigest = invalid.binding.localFacts.digest;
  invalid.previewBinding.bindingDigest = imageRevisionBindingDigest(
    invalid.binding,
  );
  expect(imageRevisionV2ReceiptSchema.safeParse(invalid).success).toBe(false);
});

async function originalV1Parent() {
  const scope = { ...input.binding.attemptScope, version: 3 };
  const parent = {
    kind: "image_generation",
    version: 1,
    state: "generating",
    generationOperationId: input.generationOperationId,
    generation: {
      prompt: input.request.prompt,
      referenceImageIds: input.references.map(
        (reference) => reference.referenceImageId,
      ),
    },
    paidAttempt: {
      version: 3,
      scope,
      referenceImageId: input.references[0]!.referenceImageId,
      ordinal: 5,
    },
  };
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(parent) })
    .where("id", "=", input.generationOperationId)
    .execute();
  const { binding: _binding, ...original } = input;
  return { original, parent };
}

it("preserves original raw v1 meaning under a strict new-generation v1 parent, without accepting it as a revision", async () => {
  const { original } = await originalV1Parent();
  const calls = await db.selectFrom("ai_calls").selectAll().execute();
  const pointer = await saveRawImageCandidate(db, ctx, original, options());
  const result = await readRawImageCandidateRecord(
    db,
    ctx,
    input.generationOperationId,
    { storage: runtime(), readReferences },
  );
  expect(result.candidate).toMatchObject({
    kind: "image_raw_candidate",
    version: 1,
    transform: { kind: "full" },
  });
  expect(result.data).toEqual(input.bytes);
  expect(JSON.parse((await parentRow()).result)).toMatchObject({
    version: 1,
    paidAttempt: { version: 3, ordinal: 5 },
    rawCandidate: pointer,
  });
  await expect(
    readAnyRevisionRawImageCandidateRecord(
      db,
      ctx,
      input.generationOperationId,
      { storage: runtime(), readReferences },
    ),
  ).rejects.toThrow();
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual(calls);
});

it.each(["unknown-version", "wrong-source", "wrong-operation", "old-paid"])(
  "rejects new-generation %s before saving original raw",
  async (defect) => {
    const { original } = await originalV1Parent();
    await rewriteParent((value) => {
      if (defect === "unknown-version") value.version = 2;
      if (defect === "wrong-source")
        value.generation.referenceImageIds[0] = randomUUID();
      if (defect === "wrong-operation")
        value.generationOperationId = randomUUID();
      if (defect === "old-paid") value.paidAttempt.version = 2;
    });
    await expect(
      saveRawImageCandidate(db, ctx, original, options()),
    ).rejects.toThrow();
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where(
          "id",
          "=",
          rawImageCandidateReceiptId(input.generationOperationId),
        )
        .executeTakeFirst(),
    ).toBeUndefined();
  },
);

it("revalidates the strict new-generation parent and raw pointer before reading original raw", async () => {
  const { original } = await originalV1Parent();
  await saveRawImageCandidate(db, ctx, original, options());
  await rewriteParent((value) => {
    value.rawCandidate.sha256 = "0".repeat(64);
  });
  await expect(
    readRawImageCandidateRecord(db, ctx, input.generationOperationId, {
      storage: runtime(),
      readReferences,
    }),
  ).rejects.toThrow("图片生成操作状态已改变");
});

it("rejects unknown generation versions and malformed scope3 saved facts without using the historical reader", async () => {
  const { parent } = await originalV1Parent();
  const saved = {
    ...parent,
    state: "saved",
    assetId: randomUUID(),
    filename: "generation.png",
    width: 80,
    height: 120,
    mime: "image/png",
    size: 1000,
    ready: true,
    url: "/fixture.png",
    instruction: "Review",
  };
  expect(isSavedImageReceipt(saved)).toBe(true);
  expect(isSavedImageReceipt({ ...saved, version: 2 })).toBe(false);
  expect(savedImageReviewGeneration({ ...saved, version: 2 })).toBeUndefined();
  const missing = { ...saved, paidAttempt: undefined };
  expect(isSavedImageReceipt(missing)).toBe(false);
  expect(
    isSavedImageReceipt({
      kind: "image_generation",
      state: "saved",
      assetId: randomUUID(),
    }),
  ).toBe(true);
});
