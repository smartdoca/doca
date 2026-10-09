import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, aiConfig, saveAIConfig } from "@core/modules/ai/config.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import {
  imageBatchSchema,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";
import {
  registerImageBatchAttemptScope,
  verifyImageBatchAttemptScope,
} from "../apps/server/src/services/ai/image-batch-attempts.js";
import {
  createImageBatchRequirements,
  imageBatchReviewSources,
} from "../apps/server/src/services/ai/image-batch-requirements.js";
import { registerVisualReferences } from "../apps/server/src/services/ai/session-attachments.js";
import {
  generateImageAsset,
  availableImageReferences,
  readRawImageCandidate,
} from "../apps/server/src/services/ai/images.js";
import {
  bindSavedImageRevision,
  reviseSavedImageAsset,
  upgradeSavedImageBatch,
} from "../apps/server/src/services/ai/image-saved-revision.js";
import {
  imageRevisionReceiptSchema,
  savedImageReviewGeneration,
} from "../apps/server/src/services/ai/image-revision-contract.js";
import { readRevisionRawImageCandidateRecord } from "../apps/server/src/services/ai/image-candidates.js";
import { readReferenceImages } from "../apps/server/src/services/ai/images.js";
import {
  storageRuntime,
  createStorage,
  storageConfigForProfile,
} from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { reviewImageDelivery } from "../apps/server/src/services/ai/image-review.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  ctx: ToolContext,
  batch: ImageBatch,
  sessionId: string,
  clock: number;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const runtime = () => ({ ...storageRuntime(), root });
const png = (color: string, size = { width: 80, height: 60 }) =>
  sharp({ create: { ...size, channels: 3, background: color } })
    .png()
    .toBuffer();
const page = () => batch.books[0]!.pages[0]!.referenceImageId;
async function persist() {
  await db
    .updateTable("ai_jobs")
    .set({ result: JSON.stringify({ checkpoint: { imageBatch: batch } }) })
    .where("id", "=", ctx.jobId!)
    .execute();
}
async function operation(id: string) {
  return JSON.parse(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).result,
  );
}
async function calls() {
  return Number(
    (
      await db
        .selectFrom("ai_calls")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .executeTakeFirstOrThrow()
    ).n,
  );
}
async function newJob(input: object = {}) {
  const id = randomUUID(),
    lease = randomUUID(),
    now = new Date((clock = Math.max(Date.now(), clock + 1000))).toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      user_id: owner.id,
      session_id: sessionId,
      model_id: "image",
      status: "running",
      input: JSON.stringify({
        text: "Replace target and update the text, preserve other content",
        ...input,
      }),
      result: "{}",
      digest: id,
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
      cancelled: 0,
      attempts: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { actor: owner, jobId: id, lease };
}
async function setup(version: 3 | 4 = 4, pageSize = { width: 80, height: 60 }) {
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const sourceId = randomUUID(),
    objectId = randomUUID(),
    key = objectKey(sourceId, "application/pdf"),
    bytes = Buffer.from("%PDF-1.7\n%%EOF"),
    now = new Date().toISOString();
  await createStorage(runtime()).put(
    storageConfigForProfile(runtime(), profile),
    key,
    bytes,
    "application/pdf",
    "fixture.pdf",
  );
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profile.id,
      object_key: key,
      sha256: hash(bytes),
      size: bytes.length,
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
      object_key: key,
      filename: "fixture.pdf",
      mime: "application/pdf",
      size: bytes.length,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  ctx = await newJob({ attachments: [sourceId] });
  const original = await png("#336699", pageSize),
    id = randomUUID(),
    imageKey = objectKey(id, "image/png");
  await createStorage(runtime()).put(
    storageConfigForProfile(runtime(), profile),
    imageKey,
    original,
    "image/png",
    "page-1.png",
  );
  await db
    .insertInto("file_derivatives")
    .values({
      id,
      source_id: objectId,
      profile_id: profile.id,
      object_key: imageKey,
      kind: "extract-image",
      recipe: "v4-img-0",
      mime: "image/png",
      size: original.length,
      created_at: now,
    })
    .execute();
  const source = { assetId: sourceId },
    pages = await registerVisualReferences(db, ctx, source, objectId, [
      {
        type: "image",
        recipe: "v4-img-0",
        filename: "page-1.png",
        mime: "image/png",
      },
    ]);
  const requirements = await createImageBatchRequirements(
    db,
    { userId: owner.id, actor: owner, sessionId, currentJobId: ctx.jobId! },
    ctx.jobId!,
    [source],
    "all-documents",
    ["All requested changes; other content preserved"],
    [],
  );
  const books = [{ source, filename: "fixture.pdf", pages }],
    attemptScope = await registerImageBatchAttemptScope(
      db,
      ctx,
      { requirements, books },
      { version: version === 3 ? 1 : 2 },
    );
  batch = imageBatchSchema.parse({
    version,
    attemptScope,
    requirements,
    books,
    current: 0,
    notes: "",
    delivered: {},
    reviews: {},
  });
  await persist();
}
const provider = (bytes: Buffer, inspect?: (body: any) => void) =>
  vi.fn(async (_url: any, init: any) => {
    inspect?.(JSON.parse(init.body));
    return Response.json({
      data: [{ b64_json: bytes.toString("base64") }],
      usage: { input_tokens: 1, output_tokens: 1, input_images: 1 },
    });
  });
async function base() {
  const fetch = provider(await png("#995533"));
  const result = await generateImageAsset(
    db,
    ctx,
    { prompt: "Original target edit", referenceImageIds: [page()] },
    randomUUID(),
    {
      operation: "edit",
      storage: runtime(),
      batchAttemptScope: batch.attemptScope,
      fetch: fetch as any,
    },
  );
  batch.delivered[page()] = result.assetId;
  batch.reviews[page()] = {
    assetId: result.assetId,
    passed: false,
    evidence: "Current text needs repair",
  };
  await persist();
  return result;
}
beforeEach(async () => {
  clock = Date.now() - 10000;
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-saved-revision-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "revision-owner",
        displayName: "Owner",
        password: "isolated-revision-2026",
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
      imageToolModels: { edit: "image" },
      vendors: [
        {
          id: "fixture",
          name: "Fixture",
          provider: "doubao",
          baseUrl: "https://images.invalid/v3",
          apiKey: "isolated-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "review",
          vendorId: "fixture",
          model: "mock-vision",
          alias: "Review",
          enabled: true,
          vision: true,
          tools: false,
          apiMode: "chat",
          maxInput: 64000,
          maxOutput: 6000,
        },
        {
          id: "image",
          vendorId: "fixture",
          model: "doubao-seedream-5.0-pro",
          alias: "Fixture",
          enabled: true,
          tools: false,
          imageGeneration: true,
          imageProfile: "doubao-seedream-5-0-pro-260628",
          imageRate: 1,
          maxInput: 32000,
          maxOutput: 1000,
        },
      ],
    },
    0,
  );
  sessionId = randomUUID();
  const now = new Date(clock).toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: owner.id,
      title: "Isolated revision",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await setup();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

it("uses actual saved pixels as provider image 1 and retains the original only for complete review", async () => {
  const old = await base(),
    basePixels = (
      await readReferenceImages(db, ctx, [old.assetId], runtime())
    )[0]!.data,
    newPixels = await png("#339955");
  let transmitted: Buffer | undefined;
  const fetch = provider(newPixels, (body) => {
    transmitted = Buffer.from(
      (typeof body.image === "string" ? body.image : body.image[0]).split(
        ",",
      )[1],
      "base64",
    );
  });
  const id = randomUUID(),
    result = await reviseSavedImageAsset(
      db,
      ctx,
      {
        originalReferenceImageId: page(),
        baseAssetId: old.assetId,
        prompt: "Correct the text; preserve current action",
      },
      id,
      { fetch: fetch as any, storage: runtime() },
    );
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.kind).toBe("image_revision");
  expect(result.paidAttempt.ordinal).toBe(2);
  expect(result.paidAttempt.version).toBe(2);
  const actual = await sharp(transmitted!)
      .raw()
      .toBuffer({ resolveWithObject: true }),
    expected = await sharp(basePixels)
      .raw()
      .toBuffer({ resolveWithObject: true });
  expect([actual.info.width, actual.info.height]).toEqual([
    expected.info.width,
    expected.info.height,
  ]);
  for (let n = 0; n < 3; n++)
    expect(Math.abs(actual.data[n]! - expected.data[n]!)).toBeLessThanOrEqual(
      3,
    );
  expect(result.providerReferenceImageIds[0]).toBe(old.assetId);
  expect((savedImageReviewGeneration(result) as any).referenceImageIds[0]).toBe(
    page(),
  );
  expect(imageRevisionReceiptSchema.safeParse(result).success).toBe(true);
  expect(
    (await availableImageReferences(db, ctx)).some(
      (r) => r.id === result.assetId,
    ),
  ).toBe(true);
  expect(await operation(id)).toEqual(result);
  expect(batch.reviews[page()]!.passed).toBe(false);
  await expect(
    readRawImageCandidate(db, ctx, id, runtime()),
  ).rejects.toMatchObject({ status: 422 });
  const raw = await readRevisionRawImageCandidateRecord(db, ctx, id, {
    storage: runtime(),
    readReferences: (ids) => readReferenceImages(db, ctx, ids, runtime()),
  });
  expect(raw.sources[0]!.data).toEqual(basePixels);
  expect(raw.candidate.binding.original.referenceImageId).toBe(page());
});
it.each([undefined, "2048x2048"] as const)(
  "requests the legal frozen-page canvas instead of inheriting a changed base canvas, respecting explicit size %s",
  async (size) => {
    await setup(4, { width: 1510, height: 2000 });
    const old = await base();
    const fetch = provider(await png("#339955"), (body) => {
      expect(body.size).toBe(size ?? "1510x2000");
    });
    await reviseSavedImageAsset(db, ctx, {
      originalReferenceImageId: page(), baseAssetId: old.assetId,
      prompt: "Repair current text; preserve the original page canvas",
      ...(size ? { size } : {}),
    }, randomUUID(), { fetch: fetch as any, storage: runtime() });
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it("accepts a verified unchanged export as a base without inventing an old paid attempt or raw", async () => {
  const old = await generateImageAsset(
    db,
    ctx,
    { prompt: "Unchanged source", referenceImageIds: [page()] },
    randomUUID(),
    {
      exportOnly: true,
      storage: runtime(),
      batchAttemptScope: batch.attemptScope,
    },
  );
  batch.delivered[page()] = old.assetId;
  batch.reviews[page()] = {
    assetId: old.assetId,
    passed: false,
    evidence: "Now requires text revision",
  };
  await persist();
  const result = await reviseSavedImageAsset(
    db,
    ctx,
    {
      originalReferenceImageId: page(),
      baseAssetId: old.assetId,
      prompt: "Correct the text",
    },
    randomUUID(),
    { fetch: provider(await png("#339955")) as any, storage: runtime() },
  );
  expect(result.paidAttempt.ordinal).toBe(1);
  expect(old.paidAttempt).toBeUndefined();
});
it.each([
  "old-base",
  "unknown-field",
  "local",
  "scope",
  "changed-bytes",
  "passed",
])("rejects %s before charging", async (defect) => {
  const old = await base(),
    input: any = {
      originalReferenceImageId: page(),
      baseAssetId: old.assetId,
      prompt: "Correct the text",
    };
  if (defect === "old-base") input.baseAssetId = randomUUID();
  if (defect === "unknown-field") input.maskReceiptId = randomUUID();
  if (defect === "local")
    input.editRegions = [
      {
        label: "text",
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
    ];
  if (defect === "scope") {
    batch.attemptScope = {
      ...batch.attemptScope,
      manifestDigest: "a".repeat(64),
    };
    await persist();
  }
  if (defect === "passed") {
    batch.reviews[page()]!.passed = true;
    await persist();
  }
  if (defect === "changed-bytes") {
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", old.assetId)
      .executeTakeFirstOrThrow();
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("id", "=", asset.profile_id)
      .executeTakeFirstOrThrow();
    await writeFile(join(root, asset.object_key), await png("#aa5533"));
  }
  const before = await calls(),
    fetch = provider(await png("#339955"));
  await expect(
    reviseSavedImageAsset(db, ctx, input, randomUUID(), {
      fetch: fetch as any,
      storage: runtime(),
    }),
  ).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(await calls()).toBe(before);
});
it("keeps confirmed usage and returned raw when a concurrent current pointer replacement prevents adoption", async () => {
  const old = await base(),
    id = randomUUID();
  const fetch = provider(await png("#339955"), () => {});
  fetch.mockImplementationOnce(async () => {
    batch.delivered[page()] = randomUUID();
    await persist();
    return Response.json({
      data: [{ b64_json: (await png("#339955")).toString("base64") }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  await expect(
    reviseSavedImageAsset(
      db,
      ctx,
      {
        originalReferenceImageId: page(),
        baseAssetId: old.assetId,
        prompt: "Correct text",
      },
      id,
      { fetch: fetch as any, storage: runtime() },
    ),
  ).rejects.toBeDefined();
  const result = await operation(id);
  expect(result.kind).toBe("image_revision");
  expect(result.state).toBe("save_failed");
  expect(result.rawCandidate.kind).toBe("image_revision_raw");
  expect(result.assetId).toBeUndefined();
  expect(await calls()).toBe(2);
  expect(batch.delivered[page()]).not.toBe(old.assetId);
  expect(
    (
      await db
        .selectFrom("ai_calls")
        .select("state")
        .where("id", "=", result.providerCallId)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("confirmed");
});
it("preserves returned raw and usage when cancelled after provider completion", async () => {
  const old = await base(),
    id = randomUUID(),
    controller = new AbortController();
  const fetch = provider(await png("#339955"));
  fetch.mockImplementationOnce(async () => {
    controller.abort();
    await db
      .updateTable("ai_jobs")
      .set({ cancelled: 1, status: "cancelled" })
      .where("id", "=", ctx.jobId!)
      .execute();
    return Response.json({
      data: [{ b64_json: (await png("#339955")).toString("base64") }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  await expect(
    reviseSavedImageAsset(
      db,
      ctx,
      {
        originalReferenceImageId: page(),
        baseAssetId: old.assetId,
        prompt: "Correct text",
      },
      id,
      { fetch: fetch as any, storage: runtime(), signal: controller.signal },
    ),
  ).rejects.toBeDefined();
  const result = await operation(id);
  expect(result.state).toBe("save_failed");
  expect(result.rawCandidate.kind).toBe("image_revision_raw");
  expect(result.assetId).toBeUndefined();
  expect(await calls()).toBe(2);
});
it("rejects standalone and v3 revision before a paid provider request", async () => {
  const old = await base(),
    fetch = provider(await png("#339955"));
  await db
    .updateTable("ai_jobs")
    .set({ result: "{}" })
    .where("id", "=", ctx.jobId!)
    .execute();
  await expect(
    reviseSavedImageAsset(
      db,
      ctx,
      {
        originalReferenceImageId: page(),
        baseAssetId: old.assetId,
        prompt: "Correct text",
      },
      randomUUID(),
      { fetch: fetch as any, storage: runtime() },
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(fetch).not.toHaveBeenCalled();
});
it("upgrades only new continuation progress, preserving predecessor jobs, assets and historical fee ordinals", async () => {
  await setup(3);
  const oldJob = ctx.jobId!,
    old = await base(),
    oldRow = await db
      .selectFrom("ai_jobs")
      .select("result")
      .where("id", "=", oldJob)
      .executeTakeFirstOrThrow();
  await expect(
    upgradeSavedImageBatch(db, ctx, batch, runtime()),
  ).rejects.toMatchObject({ status: 409 });
  ctx = await newJob({ text: "Technical continuation" });
  await persist();
  const oldScope = batch.attemptScope;
  batch = await upgradeSavedImageBatch(db, ctx, batch, runtime());
  expect(batch.version).toBe(4);
  expect(batch.attemptScope.version).toBe(2);
  expect(batch.attemptScope.operationId).toBe(oldScope.operationId);
  expect(batch.delivered[page()]).toBe(old.assetId);
  expect(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", oldJob)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(oldRow.result);
  await verifyImageBatchAttemptScope(db, ctx, batch);
  const result = await reviseSavedImageAsset(
    db,
    ctx,
    {
      originalReferenceImageId: page(),
      baseAssetId: old.assetId,
      prompt: "Correct text",
    },
    randomUUID(),
    { fetch: provider(await png("#339955")) as any, storage: runtime() },
  );
  expect(result.paidAttempt.ordinal).toBe(2);
  expect(result.paidAttempt.version).toBe(2);
});
it("rejects unknown revision versions rather than reading the asset through a generation fallback", async () => {
  const old = await base(),
    id = randomUUID(),
    result = await reviseSavedImageAsset(
      db,
      ctx,
      {
        originalReferenceImageId: page(),
        baseAssetId: old.assetId,
        prompt: "Correct text",
      },
      id,
      { fetch: provider(await png("#339955")) as any, storage: runtime() },
    );
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify({ ...result, version: 2 }) })
    .where("id", "=", id)
    .execute();
  expect(
    (await availableImageReferences(db, ctx)).some(
      (r) => r.id === result.assetId,
    ),
  ).toBe(false);
  expect(
    imageRevisionReceiptSchema.safeParse({ ...result, version: 2 }).success,
  ).toBe(false);
});

it("independently reviews revision against frozen original pixels and all formal requirements", async () => {
  const old = await base(),
    result = await reviseSavedImageAsset(
      db,
      ctx,
      {
        originalReferenceImageId: page(),
        baseAssetId: old.assetId,
        prompt: "Correct text; preserve current action",
      },
      randomUUID(),
      { fetch: provider(await png("#339955")) as any, storage: runtime() },
    );
  batch.delivered[page()] = result.assetId;
  delete batch.reviews[page()];
  await persist();
  let reviewedSource: Buffer | undefined,
    seenFormal = false;
  const fetch = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body),
      content = body.messages.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content : [],
      ),
      texts = content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text);
    const metadata = JSON.parse(
      texts.find((text: string) => text.startsWith('{"requiredChecks"')),
    );
    seenFormal =
      texts.join("\n").includes(batch.requirements.original.text) &&
      metadata.requiredChecks.some((c: any) => c.id === "criterion-0");
    const urls = content.filter((p: any) => p.type === "image_url");
    reviewedSource = Buffer.from(urls[0].image_url.url.split(",")[1], "base64");
    const report = {
      verdict: "pass",
      summary: "Mock verified complete requirement transport",
      checks: metadata.requiredChecks.map((c: any) => ({
        id: c.id,
        passed: true,
        evidence: "Isolated transport fixture supplied original and result",
      })),
    };
    return Response.json({
      id: "isolated-review",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(report) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
    });
  });
  const review = await reviewImageDelivery(
    db,
    ctx,
    {
      assetId: result.assetId,
      referenceImageId: page(),
      sceneContext: null,
      taskScope: {
        kind: "batch-page",
        bookIndex: 1,
        totalBooks: 1,
        filename: "fixture.pdf",
        physicalPage: 1,
        totalPages: 1,
        referenceImageId: page(),
      },
      ...imageBatchReviewSources(batch.requirements),
      criteria: batch.requirements.criteria,
      notes: "",
    },
    { precision: "native",
      model: (await aiConfig(db)).models.find((m) => m.id === "review")!,
      storage: runtime(),
      fetch: fetch as any,
    },
  );
  expect(review.passed).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(seenFormal).toBe(true);
  const [original] = await readReferenceImages(db, ctx, [page()], runtime());
  const pixels = await Promise.all(
    [original!.data, reviewedSource!].map((data) =>
      sharp(data).rotate().ensureAlpha().raw().toBuffer(),
    ),
  );
  expect(pixels[1]).toEqual(pixels[0]);
  expect(batch.reviews[page()]).toBeUndefined();
});
