import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { generateTestImageAsset } from "./fixtures/ai-image-operation.js";
import { readRawImageCandidate } from "../apps/server/src/services/ai/images.js";
import {
  prepareImageEditMask,
  previewImageEditMask,
  type ImageEditMaskReceipt,
} from "../apps/server/src/services/ai/image-edit-mask.js";
import { prepareImageMaskSegment } from "../apps/server/src/services/ai/image-mask-segment.js";
import { modelImage } from "../apps/server/src/services/ai/model-image.js";
import {
  imageMaskViewInputSchema,
  imageMaskViewOutputSchema,
  imageMaskViewModelOutput,
  viewImageMask,
} from "../apps/server/src/services/ai/image-mask-view.js";
import {
  fixtureSegmentationProfile,
  fixtureSegmentationWorker,
} from "./fixtures/ai-mask-segment-fixture.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  other: Actor,
  ctx: ToolContext,
  sessionId: string,
  sourceId: string,
  generationId: string,
  receipt: ImageEditMaskReceipt;
let network: ReturnType<typeof vi.fn>;
const runtime = () => ({ ...storage.storageRuntime(), root });
const options = () => ({ storage: runtime(), vision: true });
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const width = 80,
  height = 60;
const region = (left: number, top: number, right: number, bottom: number) => ({
  label: "isolated exact selection",
  points: [
    [left / width, top / height],
    [right / width, top / height],
    [right / width, bottom / height],
    [left / width, bottom / height],
  ] as [number, number][],
});
const empty = () => ({ proposalIds: [], include: [], exclude: [] });
const png = (color: string) =>
  sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();
async function session(actor = owner) {
  const id = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: actor.id,
      title: "Readonly mask view fixture",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}
async function job(actor = owner, targetSession = sessionId) {
  const id = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      user_id: actor.id,
      session_id: targetSession,
      model_id: "image",
      status: "running",
      input: JSON.stringify({ attachments: sourceId ? [sourceId] : [] }),
      result: "",
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
  return { actor, jobId: id, lease } as ToolContext;
}
async function snapshot() {
  return {
    operations: await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute(),
    assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    objects: await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .orderBy("id")
      .execute(),
    files: await db
      .selectFrom("file_items")
      .selectAll()
      .orderBy("id")
      .execute(),
    calls: await db.selectFrom("ai_calls").selectAll().orderBy("id").execute(),
    usage: await usageSummary(db, owner.id),
  };
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-mask-view-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "view-owner",
        displayName: "Owner",
        password: "isolated-mask-view-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "view-other",
        displayName: "Other",
        password: "isolated-mask-view-2026",
      },
      { actor: owner },
    )),
    admin: 0,
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
          baseUrl: "https://mock.invalid/v1",
          apiKey: "isolated-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "image",
          vendorId: "mock",
          model: "gpt-image-test",
          alias: "Image",
          enabled: true,
          tools: false,
          imageGeneration: true,
          imageProfile: "gpt-image-2",
          maxInput: 32000,
          maxOutput: 1000,
          imageRate: 1,
        },
      ],
    },
    0,
  );
  sourceId = randomUUID();
  sessionId = await session();
  ctx = await job();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const source = await png("#1452a1"),
    key = objectKey(sourceId, "image/png");
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), profile),
      key,
      source,
      "image/png",
      "source.png",
    );
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
      filename: "source.png",
      mime: "image/png",
      size: source.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  generationId = randomUUID();
  const raw = await png("#d22814");
  await generateTestImageAsset(
    db,
    ctx,
    { prompt: "isolated local fixture", referenceImageIds: [sourceId] },
    generationId,
    {
      storage: runtime(),
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: raw.toString("base64") }],
          usage: { input_images: 1 },
        })) as typeof fetch,
    },
  );
  const pixels = Buffer.alloc(width * height);
  for (let y = 10; y < 45; y++)
    for (let x = 10; x < 35; x++) pixels[y * width + x] = 255;
  for (let y = 22; y < 26; y++)
    for (let x = 22; x < 26; x++) pixels[y * width + x] = 0;
  for (let y = 4; y < 8; y++)
    for (let x = 5; x < 8; x++) pixels[y * width + x] = 255;
  const proposal = await prepareImageMaskSegment(
    db,
    ctx,
    {
      source: { kind: "reference", referenceImageId: sourceId },
      targets: [
        {
          label: "exact old person",
          box: [0, 0, 1, 1],
          positivePoints: [[11 / width, 11 / height]],
          negativePoints: [[0, 0]],
        },
      ],
      exclusions: [],
    },
    randomUUID(),
    {
      storage: runtime(),
      profile: await fixtureSegmentationProfile(root),
      worker: fixtureSegmentationWorker(pixels),
    },
  );
  expect(proposal.usable).toBe(true);
  receipt = await prepareImageEditMask(
    db,
    ctx,
    {
      generationOperationId: generationId,
      referenceImageId: sourceId,
      sourceTarget: {
        proposalIds: [proposal.receiptId],
        include: [],
        exclude: [],
      },
      generatedTarget: {
        proposalIds: [],
        include: [region(20, 8, 47, 48)],
        exclude: [region(22, 22, 26, 26)],
      },
      protected: {
        proposalIds: [],
        include: [region(40, 20, 45, 32)],
        exclude: [],
      },
      allowedOcclusion: empty(),
      textEdits: empty(),
    },
    randomUUID(),
    { storage: runtime() },
  );
  network = vi.fn(() => {
    throw new Error("No external request allowed");
  });
  vi.stubGlobal("fetch", network);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

it("replays an existing unsafe v2 mask across a readonly same-session job as exactly two actual bounded frames without any writes or usage", async () => {
  const resumed = { ...(await job()), writable: false },
    before = await snapshot();
  const input = { maskReceiptId: receipt.receiptId };
  const facts = await viewImageMask(db, resumed, input, options());
  expect(facts).toMatchObject({
    kind: "image_edit_mask",
    version: 2,
    state: "diagnostic-only",
    readonly: true,
    maskReceiptId: receipt.receiptId,
    digest: receipt.digest,
    referenceImageId: sourceId,
    generationOperationId: generationId,
    diagnostics: {
      semanticCoverage: "unverified",
      safeToCompose: false,
      generatedConflictPixels: 60,
    },
    binding: {
      scope: receipt.scope,
      raw: receipt.raw,
      transform: receipt.transform,
      proposalBindings: receipt.proposalBindings,
      maskDigest: receipt.maskDigest,
      protectionDigest: receipt.protectionDigest,
    },
  });
  const output = await imageMaskViewModelOutput(
    db,
    resumed,
    input,
    facts,
    options(),
  );
  expect(output.type).toBe("content");
  const images = output.value.filter((part) => part.type === "media"),
    labels = output.value
      .filter((part) => part.type === "text")
      .map((part) => JSON.parse(part.text));
  expect(images).toHaveLength(2);
  expect(labels[0]).toEqual(facts);
  expect(labels.slice(1).map((part) => part.view)).toEqual([
    "source-full",
    "generated-local",
  ]);
  const preview = await previewImageEditMask(db, resumed, receipt.receiptId, {
    storage: runtime(),
  });
  for (const [index, frame] of [preview.full, preview.local].entries()) {
    const expected = await modelImage(frame.data),
      actual = Buffer.from(images[index]!.data, "base64");
    expect(sha(actual)).toBe(sha(expected.data));
    const meta = await sharp(actual).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
    expect(labels[index + 1]).toMatchObject({
      maskReceiptId: receipt.receiptId,
      digest: receipt.digest,
      sourceRect: frame.sourceRect,
      contentRect: frame.contentRect,
      width: frame.width,
      height: frame.height,
    });
  }
  expect(JSON.stringify(facts)).not.toMatch(
    /objectKey|artifacts|checkpointPath|stdout|stderr|profile_id/,
  );
  expect(await snapshot()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("accepts only a uuid mask pointer and strict safe facts, never caller paths or alternate bindings", async () => {
  for (const value of [
    { maskReceiptId: "not-a-uuid" },
    { maskReceiptId: receipt.receiptId, sourcePath: "/tmp/private" },
    { maskReceiptId: receipt.receiptId, generationOperationId: generationId },
  ]) {
    expect(imageMaskViewInputSchema.safeParse(value).success).toBe(false);
    await expect(
      viewImageMask(db, ctx, value as never, options()),
    ).rejects.toThrow();
  }
  const facts = await viewImageMask(
    db,
    ctx,
    { maskReceiptId: receipt.receiptId },
    options(),
  );
  expect(
    imageMaskViewOutputSchema.safeParse({ ...facts, artifacts: [] }).success,
  ).toBe(false);
  const before = await snapshot();
  await expect(
    imageMaskViewModelOutput(
      db,
      ctx,
      { maskReceiptId: receipt.receiptId },
      { ...facts, source: { ...facts.source, sha256: "f".repeat(64) } },
      options(),
    ),
  ).rejects.toThrow("绑定或诊断事实已改变");
  await expect(
    imageMaskViewModelOutput(
      db,
      ctx,
      { maskReceiptId: randomUUID() },
      facts,
      options(),
    ),
  ).rejects.toThrow("回执与本次输出不一致");
  expect(await snapshot()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("refuses foreign owner/session, nonvision, cancelled or aborted reads and preserves all records", async () => {
  const input = { maskReceiptId: receipt.receiptId };
  const foreign = await job(other, await session(other)),
    another = await job(owner, await session());
  const before = await snapshot();
  await expect(viewImageMask(db, foreign, input, options())).rejects.toThrow();
  await expect(viewImageMask(db, another, input, options())).rejects.toThrow(
    "作用域",
  );
  await expect(
    viewImageMask(db, ctx, input, { ...options(), vision: false }),
  ).rejects.toThrow("视觉模型");
  const controller = new AbortController();
  controller.abort();
  await expect(
    viewImageMask(db, ctx, input, { ...options(), signal: controller.signal }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  await db
    .updateTable("ai_jobs")
    .set({ cancelled: 1 })
    .where("id", "=", ctx.jobId!)
    .execute();
  const cancelled = await snapshot();
  await expect(viewImageMask(db, ctx, input, options())).rejects.toThrow();
  expect(await snapshot()).toEqual(cancelled);
  expect(network).not.toHaveBeenCalled();
});

it("rechecks source authorization after rendering and publishes no media if it was revoked", async () => {
  const input = { maskReceiptId: receipt.receiptId },
    facts = await viewImageMask(db, ctx, input, options());
  const raw = await readRawImageCandidate(db, ctx, generationId, runtime()),
    original = storage.createStorage;
  let reads = 0;
  vi.spyOn(storage, "createStorage").mockImplementation((value) => {
    const adapter = original(value);
    return {
      ...adapter,
      read: async (...args) => {
        const data = await adapter.read(...args);
        if (args[1] === raw.candidate.objectKey && ++reads === 4)
          await db
            .updateTable("assets")
            .set({ deleted_at: new Date().toISOString() })
            .where("id", "=", sourceId)
            .execute();
        return data;
      },
    };
  });
  await expect(
    imageMaskViewModelOutput(db, ctx, input, facts, options()),
  ).rejects.toThrow();
  expect(reads).toBe(4);
  expect(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", receipt.receiptId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(JSON.stringify(receipt));
  expect(network).not.toHaveBeenCalled();
});

it.each(["old-v1", "mask-digest", "proposal-digest", "raw-bytes"] as const)(
  "rejects retained %s changes without converting, rewriting or deleting the original record",
  async (kind) => {
    if (kind === "raw-bytes") {
      const raw = await readRawImageCandidate(db, ctx, generationId, runtime());
      await writeFile(
        join(root, raw.candidate.objectKey),
        await png("#123a20"),
      );
    } else {
      const id =
        kind === "proposal-digest"
          ? receipt.proposalBindings[0]!.receiptId
          : receipt.receiptId;
      const row = await db
          .selectFrom("ai_operations")
          .select("result")
          .where("id", "=", id)
          .executeTakeFirstOrThrow(),
        value = JSON.parse(row.result);
      if (kind === "old-v1") value.version = 1;
      else if (kind === "mask-digest") value.maskDigest = "f".repeat(64);
      else value.digest = "f".repeat(64);
      await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(value) })
        .where("id", "=", id)
        .execute();
    }
    const before = await snapshot();
    await expect(
      viewImageMask(db, ctx, { maskReceiptId: receipt.receiptId }, options()),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  },
);
