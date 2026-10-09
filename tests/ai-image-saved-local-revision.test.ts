import {
  prepareSavedLocalRevision,
  reviseSavedLocalImageAsset,
  reviseSavedImageAsset,
  upgradeLocalSavedImageBatch,
  verifySavedBatchArtifact,
} from "../apps/server/src/services/ai/image-saved-revision.js";
import { imageRevisionV2ReceiptSchema } from "../apps/server/src/services/ai/image-revision-contract.js";
import { readAnyRevisionRawImageCandidateRecord } from "../apps/server/src/services/ai/image-candidates.js";
import { reconstructRevisionProviderReferences } from "../apps/server/src/services/ai/image-revision-provider-references.js";
import { prepareImageEditMask } from "../apps/server/src/services/ai/image-edit-mask.js";
import type { ImageRevisionLocalPreview } from "../apps/server/src/services/ai/image-revision-contract.js";
import { systemErrorReason } from "@core/shared/errors.js";

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import {
  imageBatchSchema,
  updateImageBatchRequirements,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";
import {
  registerImageBatchAttemptScope,
  verifyImageBatchAttemptScope,
} from "../apps/server/src/services/ai/image-batch-attempts.js";
import {
  createImageBatchRequirements,
  bindImageBatchClarifications,
} from "../apps/server/src/services/ai/image-batch-requirements.js";
import { registerVisualReferences } from "../apps/server/src/services/ai/session-attachments.js";
import {
  generateImageAsset,
  readRawImageCandidate,
} from "../apps/server/src/services/ai/images.js";
import { readRevisionRawImageCandidateRecord } from "../apps/server/src/services/ai/image-candidates.js";
import { readReferenceImages } from "../apps/server/src/services/ai/images.js";
import {
  storageRuntime,
  createStorage,
  storageConfigForProfile,
} from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";

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
    const body = JSON.parse(init.body);
    inspect?.(body);
    return Response.json({
      data: [{ b64_json: bytes.toString("base64") }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        input_images: Array.isArray(body.image) ? body.image.length : 1,
      },
    });
  });
async function base(bytes?: Buffer) {
  const fetch = provider(bytes ?? (await patternedPNG(80, 60)));
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
  root = await mkdtemp(join(tmpdir(), "doca-saved-local-revision-"));
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

async function patternedPNG(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = (i * 17) % 256;
    pixels[i * 4 + 1] = (i * 31) % 256;
    pixels[i * 4 + 2] = (i * 43) % 256;
    pixels[i * 4 + 3] = [0, 83, 170, 255][i % 4]!;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
const rgba = (b: Buffer) => sharp(b).rotate().ensureAlpha().raw().toBuffer();
const selectedRegion = { left: 0.201, top: 0.252, width: 0.207, height: 0.298 };
function localInput(baseAssetId: string) {
  return {
    originalReferenceImageId: page(),
    baseAssetId,
    prompt:
      "Correct the punctuation in the selected current-base region; retain the current action",
    region: selectedRegion,
    contextPaddingPixels: 5,
  };
}
async function upgrade() {
  const oldJob = ctx.jobId!,
    old = await db
      .selectFrom("ai_jobs")
      .select("result")
      .where("id", "=", oldJob)
      .executeTakeFirstOrThrow(),
    oldScope = batch.attemptScope,
    oldScopeRow = await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", oldScope.operationId)
      .executeTakeFirstOrThrow();
  await db
    .updateTable("ai_jobs")
    .set({ status: "failed" })
    .where("id", "=", oldJob)
    .execute();
  ctx = await newJob({
    text: "Continue the same frozen task using explicit local saved-base revision",
  });
  await persist();
  batch = await upgradeLocalSavedImageBatch(db, ctx, batch, runtime());
  expect(batch.version).toBe(5);
  expect(batch.attemptScope.version).toBe(3);
  expect(batch.attemptScope.operationId).toBe(oldScope.operationId);
  expect(batch.attemptScope.manifestDigest).toBe(oldScope.manifestDigest);
  expect(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", oldJob)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(old.result);
  const currentScope = JSON.parse(
      (
        await db
          .selectFrom("ai_operations")
          .select("result")
          .where("id", "=", oldScope.operationId)
          .executeTakeFirstOrThrow()
      ).result,
    ),
    archive = JSON.parse(
      (
        await db
          .selectFrom("ai_operations")
          .select("result")
          .where("id", "=", currentScope.predecessor.operationId)
          .executeTakeFirstOrThrow()
      ).result,
    );
  expect(archive).toMatchObject({
    kind: "image_batch_attempt_scope_archive",
    version: 2,
    predecessor: oldScopeRow,
  });
  await verifyImageBatchAttemptScope(db, ctx, batch);
}
async function preparedBase() {
  const old = await base();
  await upgrade();
  const input = localInput(old.assetId),
    prepared = await prepareSavedLocalRevision(db, ctx, input, runtime());
  return { old, input, prepared };
}
async function actualFor(preview: ImageRevisionLocalPreview) {
  const w = preview.binding.localFacts.workspace;
  return png("#11cc77", { width: w.width, height: w.height });
}
function rawOptions() {
  return {
    storage: runtime(),
    readReferences: (ids: string[]) =>
      readReferenceImages(db, ctx, ids, runtime()),
    readProviderReferences: (
      candidate: Parameters<typeof reconstructRevisionProviderReferences>[0],
      sources: Parameters<typeof reconstructRevisionProviderReferences>[1],
    ) => reconstructRevisionProviderReferences(candidate, sources, undefined),
  };
}

it("keeps immutable saved revisions readable after a real formal clarification while rejecting stale permission for a new paid edit", async () => {
  const { input, prepared } = await preparedBase();
  const output = await reviseSavedLocalImageAsset(
    db,
    ctx,
    input,
    randomUUID(),
    {
      storage: runtime(),
      expectedPreview: prepared.previewBinding,
      fetch: (async () =>
        Response.json({
          data: [
            {
              b64_json: (await actualFor(prepared.previewBinding)).toString(
                "base64",
              ),
            },
          ],
          usage: { input_images: 2, input_tokens: 8, output_tokens: 5 },
        })) as typeof fetch,
    },
  );
  batch.delivered[page()] = output.assetId;
  batch.reviews[page()] = {
    assetId: output.assetId,
    passed: false,
    evidence: "Old strict style judgment",
  };
  await persist();
  const nextInput = localInput(output.assetId);
  const beforeBind = await prepareSavedLocalRevision(
    db,
    ctx,
    nextInput,
    runtime(),
  );
  const receipt = await operation(output.generationOperationId),
    raw = await operation(output.rawCandidate.receiptId),
    oldCalls = await calls();
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed" })
    .where("id", "=", ctx.jobId!)
    .execute();
  ctx = await newJob({
    text: "Accept natural fusion and illustrated clothing; preserve the required words.",
  });
  await persist();
  const requirements = await bindImageBatchClarifications(
    db,
    { userId: owner.id, actor: owner, sessionId, currentJobId: ctx.jobId! },
    batch.requirements,
    batch.requirements.original.jobId,
    [{ jobId: ctx.jobId!, scope: "batch" }],
  );
  batch = updateImageBatchRequirements(batch, requirements, batch.notes);
  await persist();
  expect(batch.reviews[page()]).toBeUndefined();
  await verifySavedBatchArtifact(
    db,
    ctx,
    batch,
    page(),
    output.assetId,
    runtime(),
  );
  // A new edit requires a new current-criteria defect, not the old verdict.
  batch.reviews[page()] = {
    assetId: output.assetId,
    passed: false,
    evidence: "Fresh current-criteria defect",
  };
  await persist();
  const afterBind = await prepareSavedLocalRevision(
    db,
    ctx,
    nextInput,
    runtime(),
  );
  expect(afterBind.binding.requirementsDigest).not.toBe(
    beforeBind.binding.requirementsDigest,
  );
  expect(await operation(output.generationOperationId)).toEqual(receipt);
  expect(await operation(output.rawCandidate.receiptId)).toEqual(raw);
  const provider = vi.fn();
  await expect(
    reviseSavedLocalImageAsset(db, ctx, nextInput, randomUUID(), {
      storage: runtime(),
      expectedPreview: beforeBind.previewBinding,
      fetch: provider,
    }),
  ).rejects.toThrow(/预览.*改变/);
  expect(provider).not.toHaveBeenCalled();
  expect(await calls()).toBe(oldCalls);
});

it("explicitly upgrades the same scope and uses actual viewport/identity/original transport with cumulative fees and outside RGBA exact", async () => {
  const initial = await base(),
    initialOperation = await operation(initial.generationOperationId),
    whole = await reviseSavedImageAsset(
      db,
      ctx,
      {
        originalReferenceImageId: page(),
        baseAssetId: initial.assetId,
        prompt: "Correct text while preserving this current saved action",
      },
      randomUUID(),
      {
        storage: runtime(),
        fetch: provider(await patternedPNG(80, 60)) as any,
      },
    );
  expect(whole.paidAttempt).toMatchObject({ version: 2, ordinal: 2 });
  batch.delivered[page()] = whole.assetId;
  batch.reviews[page()] = {
    assetId: whole.assetId,
    passed: false,
    evidence: "Punctuation still needs a local repair",
  };
  await persist();
  const identity = await generateImageAsset(
    db,
    ctx,
    { prompt: "Export context identity", referenceImageIds: [page()] },
    randomUUID(),
    {
      exportOnly: true,
      storage: runtime(),
      batchAttemptScope: batch.attemptScope,
    },
  );
  expect(await calls()).toBe(2);
  const baseData = (
      await readReferenceImages(db, ctx, [whole.assetId], runtime())
    )[0]!.data,
    originalData = (await readReferenceImages(db, ctx, [page()], runtime()))[0]!
      .data;
  await upgrade();
  const input = {
      ...localInput(whole.assetId),
      referenceImageIds: [identity.assetId],
    },
    before = await calls(),
    prepared = await prepareSavedLocalRevision(db, ctx, input, runtime());
  expect(prepared.frames.map((frame) => frame.role)).toEqual([
    "original-context",
    "current-base-coverage",
    "current-base-local-coverage",
  ]);
  expect(await calls()).toBe(before);
  expect(prepared.binding.mode).toBe("local");
  let transport: Buffer[] = [];
  const actual = await actualFor(prepared.previewBinding),
    fetch = provider(actual, (body) => {
      expect(body.size).toBe(
        prepared.binding.localFacts.provider.requestedSize,
      );
      // Native 17x18 ROI starts five pixels into a 27x28 context crop.
      // The 1000-unit viewport bounds are independent of the original 80x60 canvas.
      const coordinates = body.prompt
        .match(/Image 1 <bbox>(\d+) (\d+) (\d+) (\d+)<\/bbox>/)
        ?.slice(1)
        .map(Number);
      expect(coordinates).toHaveLength(4);
      [185, 179, 815, 821].forEach((value, index) =>
        expect(Math.abs(coordinates![index]! - value)).toBeLessThanOrEqual(1),
      );
      expect(body.prompt).toContain("禁止把整幅参考页或缩略图贴进窗口");
      transport = (Array.isArray(body.image) ? body.image : [body.image]).map(
        (image: string) => Buffer.from(image.split(",")[1]!, "base64"),
      );
    }),
    id = randomUUID(),
    result = await reviseSavedLocalImageAsset(db, ctx, input, id, {
      expectedPreview: prepared.previewBinding,
      storage: runtime(),
      fetch: fetch as any,
    });
  expect(fetch).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    kind: "image_revision",
    version: 2,
    mode: "local",
    paidAttempt: { version: 3, ordinal: 3 },
    rawCandidate: { kind: "image_revision_raw", version: 2 },
    providerImageUsage: { inputImages: 3 },
  });
  expect(imageRevisionV2ReceiptSchema.safeParse(result).success).toBe(true);
  expect(result.providerReferenceImageIds).toEqual([
    whole.assetId,
    identity.assetId,
    page(),
  ]);
  expect(result.providerReferences.map((ref: any) => ref.role)).toEqual([
    "base-viewport",
    "identity",
    "original-context",
  ]);
  expect(result.providerReferences.map((ref: any) => ref.sha256)).toEqual(
    transport.map(hash),
  );
  expect(hash(transport[0]!)).toBe(prepared.binding.localFacts.provider.sha256);
  const last = await sharp(transport.at(-1)!).raw().toBuffer(),
    originalPixels = await rgba(originalData);
  for (let i = 0; i < 3; i++)
    expect(Math.abs(last[i]! - originalPixels[i]!)).toBeLessThanOrEqual(3);
  const outputData = (
      await readReferenceImages(db, ctx, [result.assetId], runtime())
    )[0]!.data,
    oldPixels = await rgba(baseData),
    outputPixels = await rgba(outputData),
    r = prepared.binding.localFacts.nativeRect;
  let edited = 0,
    preserved = 0;
  for (let y = 0; y < 60; y++)
    for (let x = 0; x < 80; x++) {
      const start = (y * 80 + x) * 4,
        inside =
          x >= r.left &&
          x < r.left + r.width &&
          y >= r.top &&
          y < r.top + r.height;
      if (inside) {
        expect([...outputPixels.subarray(start, start + 4)]).toEqual([
          17, 204, 119, 255,
        ]);
        edited++;
      } else {
        expect(outputPixels.subarray(start, start + 4)).toEqual(
          oldPixels.subarray(start, start + 4),
        );
        preserved++;
      }
    }
  expect(result.composition.result).toMatchObject({
    editedPixels: edited,
    preservedPixels: preserved,
    sha256: hash(outputData),
  });
  const raw = await readAnyRevisionRawImageCandidateRecord(
    db,
    ctx,
    id,
    rawOptions(),
  );
  expect(raw.data).toEqual(actual);
  expect(raw.candidate).toMatchObject({
    version: 2,
    mode: "local",
    transform: { kind: "saved-local" },
    sha256: hash(actual),
  });
  expect(raw.data).not.toEqual(outputData);
  expect(result.composition.actual.sha256).toBe(hash(actual));
  expect(await calls()).toBe(3);
  expect(await operation(initial.generationOperationId)).toEqual(
    initialOperation,
  );
  expect(batch.delivered[page()]).toBe(whole.assetId);
  expect(batch.reviews[page()]!.passed).toBe(false);
  await verifyImageBatchAttemptScope(db, ctx, batch);
});

it.each([
  "changed-base",
  "changed-current",
  "changed-region",
  "partial-preview",
  "changed-scope",
  "passed",
  "unknown-field",
])("rejects %s before any new provider POST or fee", async (defect) => {
  const { old, input, prepared } = await preparedBase(),
    fetch = provider(await actualFor(prepared.previewBinding)),
    before = await calls(),
    rejectedOperationId = randomUUID();
  let args: any = input,
    expected: any = prepared.previewBinding;
  if (defect === "changed-base") {
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", old.assetId)
      .executeTakeFirstOrThrow();
    await writeFile(join(root, asset.object_key), await png("#aa5533"));
  }
  if (defect === "changed-current") {
    batch.delivered[page()] = randomUUID();
    await persist();
  }
  if (defect === "changed-region")
    args = { ...input, region: { ...selectedRegion, width: 0.25 } };
  if (defect === "partial-preview")
    expected = {
      kind: prepared.previewBinding.kind,
      version: 1,
      bindingDigest: prepared.previewBinding.bindingDigest,
    };
  if (defect === "changed-scope") {
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
  if (defect === "unknown-field")
    args = { ...input, maskReceiptId: randomUUID() };
  await expect(
    reviseSavedLocalImageAsset(db, ctx, args, rejectedOperationId, {
      expectedPreview: expected,
      storage: runtime(),
      fetch: fetch as any,
    }),
  ).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(await calls()).toBe(before);
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("id", "=", rejectedOperationId)
      .executeTakeFirst(),
  ).toBeUndefined();
});

it("retains a confirmed actual raw and ordinal when the current pointer changes after POST, without adopting over that pointer", async () => {
  const { input, prepared } = await preparedBase(),
    actual = await actualFor(prepared.previewBinding),
    id = randomUUID();
  const fetch = provider(actual);
  const replacement = randomUUID();
  fetch.mockImplementationOnce(async () => {
    batch.delivered[page()] = replacement;
    await persist();
    return Response.json({
      data: [{ b64_json: actual.toString("base64") }],
      usage: { input_tokens: 1, output_tokens: 1, input_images: 2 },
    });
  });
  const error = await reviseSavedLocalImageAsset(db, ctx, input, id, {
    expectedPreview: prepared.previewBinding,
    storage: runtime(),
    fetch: fetch as any,
  }).catch((error) => error);
  expect(systemErrorReason(error)?.code).toBe("image_save_failed");
  expect(fetch).toHaveBeenCalledOnce();
  const failed = await operation(id);
  expect(failed).toMatchObject({
    kind: "image_revision",
    version: 2,
    mode: "local",
    state: "save_failed",
    paidAttempt: { version: 3, ordinal: 2 },
    rawCandidate: { version: 2 },
  });
  expect(failed.assetId).toBeUndefined();
  expect(
    (
      await db
        .selectFrom("ai_calls")
        .select("state")
        .where("id", "=", failed.providerCallId)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("confirmed");
  expect(
    (await readAnyRevisionRawImageCandidateRecord(db, ctx, id, rawOptions()))
      .data,
  ).toEqual(actual);
  expect(batch.delivered[page()]).toBe(replacement);
  expect(await calls()).toBe(2);
});

it("preserves returned actual raw and confirmed fee when an invalid native provider aspect blocks local composition", async () => {
  const { old, input, prepared } = await preparedBase(),
    id = randomUUID(),
    actual = await png("#11cc77", { width: 1024, height: 1024 }),
    fetch = provider(actual);
  expect(prepared.binding.localFacts.workspace.width).not.toBe(
    prepared.binding.localFacts.workspace.height,
  );
  await expect(
    reviseSavedLocalImageAsset(db, ctx, input, id, {
      expectedPreview: prepared.previewBinding,
      storage: runtime(),
      fetch: fetch as any,
    }),
  ).rejects.toBeDefined();
  const failed = await operation(id);
  expect(failed).toMatchObject({
    state: "save_failed",
    paidAttempt: { ordinal: 2 },
    rawCandidate: { version: 2 },
  });
  expect(
    (await readAnyRevisionRawImageCandidateRecord(db, ctx, id, rawOptions()))
      .data,
  ).toEqual(actual);
  expect(
    (
      await db
        .selectFrom("ai_calls")
        .select("state")
        .where("id", "=", failed.providerCallId)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("confirmed");
  expect(batch.delivered[page()]).toBe(old.assetId);
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps an unknown paid POST counted, never invents returned raw and never retries it", async () => {
  const { old, input, prepared } = await preparedBase(),
    id = randomUUID(),
    fetch = vi.fn(async () => {
      throw new TypeError("isolated network response lost");
    });
  const error = await reviseSavedLocalImageAsset(db, ctx, input, id, {
    expectedPreview: prepared.previewBinding,
    storage: runtime(),
    fetch: fetch as any,
  }).catch((error) => error);
  expect(systemErrorReason(error)?.code).toBe("image_result_uncertain");
  expect(fetch).toHaveBeenCalledOnce();
  const pending = await operation(id);
  expect(pending).toMatchObject({
    kind: "image_revision",
    version: 2,
    mode: "local",
    state: "generating",
    paidAttempt: { version: 3, ordinal: 2 },
  });
  expect(pending.rawCandidate).toBeUndefined();
  const latest = await db
    .selectFrom("ai_calls")
    .select(["state", "id", "usage"])
    .where("job_id", "=", ctx.jobId!)
    .execute();
  expect(latest).toHaveLength(1);
  // settleCall(null) preserves the existing estimate in the actual pending
  // ledger state; "unknown" is the outcome, not a fabricated ledger enum.
  expect(latest[0]!.state).toBe("pending");
  expect(JSON.parse(latest[0]!.usage)).toMatchObject({
    known: false,
    estimate: { provider: { images: 1 } },
  });
  const nextFetch = provider(await actualFor(prepared.previewBinding)),
    nextId = randomUUID();
  await expect(
    reviseSavedLocalImageAsset(db, ctx, input, nextId, {
      expectedPreview: prepared.previewBinding,
      storage: runtime(),
      fetch: nextFetch as any,
    }),
  ).rejects.toBeDefined();
  expect(nextFetch).not.toHaveBeenCalled();
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("id", "=", nextId)
      .executeTakeFirst(),
  ).toBeUndefined();
  expect(await calls()).toBe(2);
  expect(batch.delivered[page()]).toBe(old.assetId);
});

it("rejects saved-local raw2 through old original raw/mask and whole-only raw1 readers without new writes", async () => {
  const { input, prepared } = await preparedBase(),
    id = randomUUID(),
    result = await reviseSavedLocalImageAsset(db, ctx, input, id, {
      expectedPreview: prepared.previewBinding,
      storage: runtime(),
      fetch: provider(await actualFor(prepared.previewBinding)) as any,
    }),
    before = await calls();
  await expect(
    readRawImageCandidate(db, ctx, id, runtime()),
  ).rejects.toBeDefined();
  await expect(
    readRevisionRawImageCandidateRecord(db, ctx, id, {
      storage: runtime(),
      readReferences: (ids) => readReferenceImages(db, ctx, ids, runtime()),
    }),
  ).rejects.toBeDefined();
  const empty = { proposalIds: [], include: [], exclude: [] },
    maskId = randomUUID();
  await expect(
    prepareImageEditMask(
      db,
      ctx,
      {
        generationOperationId: id,
        referenceImageId: page(),
        sourceTarget: empty,
        generatedTarget: empty,
        protected: empty,
        allowedOcclusion: empty,
        textEdits: empty,
      },
      maskId,
      { storage: runtime() },
    ),
  ).rejects.toBeDefined();
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("id", "=", maskId)
      .executeTakeFirst(),
  ).toBeUndefined();
  expect(await calls()).toBe(before);
  expect((await operation(id)).rawCandidate).toEqual(result.rawCandidate);
});

it("requires explicit upgrade and refuses another live executor without changing canonical scope or history", async () => {
  const old = await base(),
    before = await calls(),
    oldScope = batch.attemptScope,
    scopeRow = await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", oldScope.operationId)
      .executeTakeFirstOrThrow();
  await expect(
    prepareSavedLocalRevision(db, ctx, localInput(old.assetId), runtime()),
  ).rejects.toMatchObject({ status: 409 });
  const originalJob = ctx.jobId!;
  ctx = await newJob();
  await persist();
  await expect(
    upgradeLocalSavedImageBatch(db, ctx, batch, runtime()),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", oldScope.operationId)
      .executeTakeFirstOrThrow(),
  ).toEqual(scopeRow);
  expect(
    await db
      .selectFrom("ai_jobs")
      .select(["status", "cancelled"])
      .where("id", "=", originalJob)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: "running", cancelled: 0 });
  expect(await calls()).toBe(before);
  expect(batch.version).toBe(4);
});
