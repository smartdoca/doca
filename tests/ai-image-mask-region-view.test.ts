import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  type ImageEditMaskInput,
  type ImageEditMaskReceipt,
} from "../apps/server/src/services/ai/image-edit-mask.js";
import {
  imageMaskRegionNativeRect,
  imageMaskRegionViewInputSchema,
  imageMaskRegionViewOutputSchema,
  imageMaskRegionViewModelOutput,
  previewImageMaskRegion,
  viewImageMaskRegion,
  type ImageMaskRegionViewInput,
} from "../apps/server/src/services/ai/image-mask-region-view.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  other: Actor,
  ctx: ToolContext;
let sourceId: string,
  sessionId: string,
  generationId: string,
  receipt: ImageEditMaskReceipt;
let sourcePixels: Buffer, rawPixels: Buffer, sourcePNG: Buffer, rawPNG: Buffer;
let network: ReturnType<typeof vi.fn>;
const width = 80,
  height = 60;
const runtime = () => ({ ...storage.storageRuntime(), root });
const options = () => ({ storage: runtime(), vision: true });
const polygon = (left: number, top: number, right: number, bottom: number) => ({
  label: "isolated selection",
  points: [
    [left / width, top / height],
    [right / width, top / height],
    [right / width, bottom / height],
    [left / width, bottom / height],
  ] as [number, number][],
});
const empty = () => ({ proposalIds: [], include: [], exclude: [] });
function maskInput(): ImageEditMaskInput {
  const hole = polygon(22, 22, 26, 26);
  return {
    generationOperationId: generationId,
    referenceImageId: sourceId,
    sourceTarget: {
      proposalIds: [],
      include: [polygon(10, 10, 35, 45), polygon(5, 4, 8, 8)],
      exclude: [hole],
    },
    generatedTarget: {
      proposalIds: [],
      include: [polygon(20, 8, 47, 48), polygon(55, 4, 60, 8)],
      exclude: [hole, polygon(43, 20, 45, 32), polygon(40, 25, 43, 32)],
    },
    protected: {
      proposalIds: [],
      include: [polygon(40, 20, 45, 32)],
      exclude: [],
    },
    allowedOcclusion: {
      proposalIds: [],
      include: [polygon(40, 20, 43, 25)],
      exclude: [],
    },
    textEdits: {
      proposalIds: [],
      include: [polygon(5, 52, 30, 58)],
      exclude: [],
    },
  };
}
async function session(actor = owner) {
  const id = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: actor.id,
      title: "Isolated region view",
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
async function job(actor = owner, target = sessionId) {
  const id = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      user_id: actor.id,
      session_id: target,
      model_id: "image",
      status: "running",
      input: JSON.stringify({ attachments: [sourceId] }),
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
  return { actor, jobId: id, lease, writable: false } as ToolContext;
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
    calls: await db.selectFrom("ai_calls").selectAll().orderBy("id").execute(),
    usage: await usageSummary(db, owner.id),
  };
}
function patternedPixels(raw: boolean) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data.set(
        raw
          ? [50 + x * 2, 80 + y * 2, 210 - y, x % 5 ? 255 : 90]
          : [x * 3, y * 4, x + y, x % 3 ? 255 : 127],
        offset,
      );
    }
  return data;
}
const encode = (pixels: Buffer) =>
  sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
const pixelRGBA = (data: Buffer, x: number, y: number) => [
  ...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];
function input(): ImageMaskRegionViewInput {
  return {
    maskReceiptId: receipt.receiptId,
    region: {
      left: 9.25 / width,
      top: 7.5 / height,
      width: 40.25 / width,
      height: 49 / height,
    },
    points: [
      [15 / width, 15 / height],
      [25 / width, 15 / height],
      [23 / width, 23 / height],
      [41 / width, 22 / height],
      [44 / width, 22 / height],
      [10 / width, 54 / height],
      [42 / width, 10 / height],
    ],
  };
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-mask-region-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "region-owner",
        displayName: "Owner",
        password: "isolated-region-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "region-other",
        displayName: "Other",
        password: "isolated-region-2026",
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
  ctx = { ...(await job()), writable: true };
  sourcePixels = patternedPixels(false);
  rawPixels = patternedPixels(true);
  sourcePNG = await encode(sourcePixels);
  rawPNG = await encode(rawPixels);
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const key = objectKey(sourceId, "image/png");
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), profile),
      key,
      sourcePNG,
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
      size: sourcePNG.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  generationId = randomUUID();
  await generateTestImageAsset(
    db,
    ctx,
    { prompt: "Isolated image fixture", referenceImageIds: [sourceId] },
    generationId,
    {
      storage: runtime(),
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: rawPNG.toString("base64") }],
          usage: { input_images: 1 },
        })) as typeof fetch,
    },
  );
  receipt = await prepareImageEditMask(db, ctx, maskInput(), randomUUID(), {
    storage: runtime(),
  });
  ctx = { ...ctx, writable: false };
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

it("reads exact oriented RGBA and S/G/P/O/T membership at native coordinates, emits three matching lossless crops and writes nothing", async () => {
  const before = await snapshot(),
    args = input(),
    facts = await viewImageMaskRegion(db, ctx, args, options());
  expect(facts).toMatchObject({
    kind: "image_mask_region_view",
    readonly: true,
    state: "diagnostic-only",
    maskReceiptId: receipt.receiptId,
    digest: receipt.digest,
    maskDigest: receipt.maskDigest,
    protectionDigest: receipt.protectionDigest,
    nativeRect: { left: 9, top: 7, width: 41, height: 50 },
    coverage: {
      totalPixels: 2050,
      conflictPixels: 0,
      generatedPixels: 2050,
      ungeneratedPixels: 0,
    },
  });
  const expected = [
    { S: 255, G: 0, P: 0, O: 0, T: 0, selected: 255, remainingProtection: 0 },
    { S: 255, G: 255, P: 0, O: 0, T: 0, selected: 255, remainingProtection: 0 },
    { S: 0, G: 0, P: 0, O: 0, T: 0, selected: 0, remainingProtection: 0 },
    {
      S: 0,
      G: 255,
      P: 255,
      O: 255,
      T: 0,
      selected: 255,
      remainingProtection: 0,
    },
    { S: 0, G: 0, P: 255, O: 0, T: 0, selected: 0, remainingProtection: 255 },
    { S: 0, G: 0, P: 0, O: 0, T: 255, selected: 255, remainingProtection: 0 },
    { S: 0, G: 255, P: 0, O: 0, T: 0, selected: 255, remainingProtection: 0 },
  ];
  for (const [index, point] of facts.points.entries()) {
    expect(point).toMatchObject({
      ...expected[index],
      conflict: 0,
      generated: true,
      rawOrigin: "generated-candidate",
    });
    expect(point.sourceRGBA).toEqual(
      pixelRGBA(sourcePixels, point.pixel.x, point.pixel.y),
    );
    expect(point.rawRGBA).toEqual(
      pixelRGBA(rawPixels, point.pixel.x, point.pixel.y),
    );
  }
  const result = await imageMaskRegionViewModelOutput(
    db,
    ctx,
    args,
    facts,
    options(),
  );
  const images = result.value.filter((part) => part.type === "media"),
    labels = result.value
      .filter((part) => part.type === "text")
      .map((part) => JSON.parse(part.text));
  expect(images).toHaveLength(3);
  expect(labels[0]).toEqual(facts);
  expect(labels.slice(1).map((label) => label.view)).toEqual([
    "source-region",
    "raw-region",
    "mask-region-overlay",
  ]);
  for (const [index, image] of images.entries()) {
    const decoded = await sharp(Buffer.from(image.data, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(
      await sharp(Buffer.from(image.data, "base64")).metadata(),
    ).toMatchObject({ format: "png", width: 41, height: 50 });
    expect(labels[index + 1]).toMatchObject({
      sourceRect: facts.nativeRect,
      contentRect: { left: 0, top: 0, width: 41, height: 50 },
      width: 41,
      height: 50,
      coordinateSpace: "source",
    });
    if (index >= 2) continue;
    const original = index === 0 ? sourcePixels : rawPixels;
    for (let y = 0; y < 50; y++)
      for (let x = 0; x < 41; x++)
        expect([
          ...decoded.data.subarray((y * 41 + x) * 4, (y * 41 + x) * 4 + 4),
        ]).toEqual(pixelRGBA(original, x + 9, y + 7));
  }
  expect(JSON.stringify(facts)).not.toMatch(
    /objectKey|nativeUsage|base64|profileId|providerCall|assetId|url|secret/,
  );
  expect(await snapshot()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("accepts a one-pixel edge crop and explicitly maps endpoint 1 to the last native pixel without resizing", async () => {
  const args: ImageMaskRegionViewInput = {
    maskReceiptId: receipt.receiptId,
    region: {
      left: 79 / width,
      top: 59 / height,
      width: 1 / width,
      height: 1 / height,
    },
    points: [[1, 1]],
  };
  const before = await snapshot(),
    preview = await previewImageMaskRegion(db, ctx, args, options());
  expect(preview.facts.nativeRect).toEqual({
    left: 79,
    top: 59,
    width: 1,
    height: 1,
  });
  expect(preview.facts.points[0]).toMatchObject({
    pixel: { x: 79, y: 59 },
    sourceRGBA: pixelRGBA(sourcePixels, 79, 59),
    rawRGBA: pixelRGBA(rawPixels, 79, 59),
  });
  for (const frame of preview.frames)
    expect(await sharp(frame.data).metadata()).toMatchObject({
      format: "png",
      width: 1,
      height: 1,
    });
  expect(await snapshot()).toEqual(before);
});

it("rejects oversized native requests rather than clipping, resampling or fitting them", () => {
  expect(
    imageMaskRegionNativeRect(
      { left: 0, top: 0, width: 0.5, height: 0.5 },
      2000,
      2000,
    ),
  ).toEqual({ left: 0, top: 0, width: 1000, height: 1000 });
  expect(() =>
    imageMaskRegionNativeRect(
      { left: 0, top: 0, width: 1025 / 2000, height: 1 / 2000 },
      2000,
      2000,
    ),
  ).toThrow("1024");
  expect(() =>
    imageMaskRegionNativeRect(
      { left: 0, top: 0, width: 1024 / 2000, height: 1000 / 2000 },
      2000,
      2000,
    ),
  ).toThrow("100万");
  expect(() =>
    imageMaskRegionNativeRect(
      { left: 0.9, top: 0, width: 0.2, height: 0.1 },
      2000,
      2000,
    ),
  ).toThrow();
  expect(() =>
    imageMaskRegionNativeRect(
      {
        left: 0.5,
        top: 0.5,
        width: Number.MIN_VALUE,
        height: Number.MIN_VALUE,
      },
      2000,
      2000,
    ),
  ).toThrow("完整表达");
});

it("requires an explicit strict region and points, rejects caller paths and out-of-crop points before returning any facts", async () => {
  const before = await snapshot(),
    args = input();
  for (const value of [
    { maskReceiptId: receipt.receiptId },
    { ...args, points: undefined },
    { ...args, region: { ...args.region, path: "/tmp/secret" } },
    { ...args, points: Array.from({ length: 17 }, () => [0.3, 0.3]) },
    { ...args, sourcePath: "/tmp/private.png" },
    { ...args, points: [[NaN, 0.3]] },
  ]) {
    expect(imageMaskRegionViewInputSchema.safeParse(value).success).toBe(false);
    await expect(
      viewImageMaskRegion(db, ctx, value as never, options()),
    ).rejects.toThrow();
  }
  await expect(
    viewImageMaskRegion(db, ctx, { ...args, points: [[0, 0]] }, options()),
  ).rejects.toThrow("小框内");
  const noPoints = await viewImageMaskRegion(
    db,
    ctx,
    { ...args, points: [] },
    options(),
  );
  expect(noPoints.points).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("marks source-projected pixels outside a real generated viewport as ungenerated and leaves mask authority unchanged", async () => {
  const viewportId = randomUUID(),
    writable = { ...ctx, writable: true };
  await generateTestImageAsset(
    db,
    writable,
    {
      prompt: "Isolated viewport fixture",
      referenceImageIds: [sourceId],
      editRegions: [polygon(20, 20, 30, 30)],
    },
    viewportId,
    {
      storage: runtime(),
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: rawPNG.toString("base64") }],
          usage: { input_images: 1 },
        })) as typeof fetch,
    },
  );
  const viewportMask = await prepareImageEditMask(
    db,
    writable,
    {
      generationOperationId: viewportId,
      referenceImageId: sourceId,
      sourceTarget: {
        proposalIds: [],
        include: [polygon(20, 20, 30, 30)],
        exclude: [],
      },
      generatedTarget: {
        proposalIds: [],
        include: [polygon(21, 21, 29, 29)],
        exclude: [],
      },
      protected: empty(),
      allowedOcclusion: empty(),
      textEdits: empty(),
    },
    randomUUID(),
    { storage: runtime() },
  );
  const before = await snapshot(),
    args: ImageMaskRegionViewInput = {
      maskReceiptId: viewportMask.receiptId,
      region: { left: 0, top: 0, width: 1, height: 1 },
      points: [
        [0, 0],
        [25 / width, 25 / height],
      ],
    };
  const preview = await previewImageMaskRegion(db, ctx, args, options());
  expect(preview.facts.coverage.generatedPixels).toBeGreaterThan(0);
  expect(preview.facts.coverage.ungeneratedPixels).toBeGreaterThan(0);
  expect(
    preview.facts.coverage.generatedPixels +
      preview.facts.coverage.ungeneratedPixels,
  ).toBe(width * height);
  expect(preview.facts.points[0]).toMatchObject({
    generated: false,
    rawOrigin: "source-outside-generation-window",
    selected: 0,
  });
  expect(preview.facts.points[0]!.rawRGBA).toEqual(
    preview.facts.points[0]!.sourceRGBA,
  );
  expect(preview.facts.points[1]).toMatchObject({
    generated: true,
    rawOrigin: "generated-candidate",
    S: 255,
    G: 255,
  });
  const emitted = await imageMaskRegionViewModelOutput(
    db,
    ctx,
    args,
    preview.facts,
    options(),
  );
  expect(
    emitted.value
      .filter((part) => part.type === "text")
      .map((part) => JSON.parse(part.text))
      .slice(1),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        view: "raw-region",
        ungeneratedPixels: preview.facts.coverage.ungeneratedPixels,
        generatedWindow: viewportMask.generatedWindow,
      }),
    ]),
  );
  expect(await snapshot()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("rejects foreign accounts/sessions, nonvision and cancelled or aborted reads without usage or object changes", async () => {
  const foreign = await job(other, await session(other)),
    another = await job(owner, await session()),
    before = await snapshot(),
    args = input();
  await expect(
    viewImageMaskRegion(db, foreign, args, options()),
  ).rejects.toThrow();
  await expect(
    viewImageMaskRegion(db, another, args, options()),
  ).rejects.toThrow();
  await expect(
    viewImageMaskRegion(db, ctx, args, { ...options(), vision: false }),
  ).rejects.toThrow("视觉模型");
  const controller = new AbortController();
  controller.abort();
  await expect(
    previewImageMaskRegion(db, ctx, args, {
      ...options(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await snapshot()).toEqual(before);
  await db
    .updateTable("ai_jobs")
    .set({ cancelled: 1 })
    .where("id", "=", ctx.jobId!)
    .execute();
  const cancelled = await snapshot();
  await expect(
    previewImageMaskRegion(db, ctx, args, options()),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(cancelled);
  expect(network).not.toHaveBeenCalled();
});

it("binds emitted pixels to the exact requested region and point facts, not forged textual output", async () => {
  const args = input(),
    facts = await viewImageMaskRegion(db, ctx, args, options()),
    before = await snapshot();
  expect(
    imageMaskRegionViewOutputSchema.safeParse({
      ...facts,
      objectKey: "private",
    }).success,
  ).toBe(false);
  const forged = {
    ...facts,
    points: facts.points.map((point, index) =>
      index
        ? point
        : {
            ...point,
            sourceRGBA: [1, 2, 3, 4] as [number, number, number, number],
          },
    ),
  };
  await expect(
    imageMaskRegionViewModelOutput(db, ctx, args, forged, options()),
  ).rejects.toThrow("像素事实已改变");
  await expect(
    imageMaskRegionViewModelOutput(
      db,
      ctx,
      { ...args, region: { left: 0, top: 0, width: 1, height: 1 } },
      facts,
      options(),
    ),
  ).rejects.toThrow("范围或像素事实");
  expect(await snapshot()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("rechecks authorization after rendering and publishes no crop if source access is revoked", async () => {
  const args = input(),
    facts = await viewImageMaskRegion(db, ctx, args, options());
  const raw = await readRawImageCandidate(db, ctx, generationId, runtime()),
    original = storage.createStorage;
  const before = await snapshot();
  let reads = 0;
  vi.spyOn(storage, "createStorage").mockImplementation((value) => {
    const adapter = original(value);
    return {
      ...adapter,
      read: async (...parameters) => {
        const data = await adapter.read(...parameters);
        if (parameters[1] === raw.candidate.objectKey && ++reads === 3)
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
    imageMaskRegionViewModelOutput(db, ctx, args, facts, options()),
  ).rejects.toThrow();
  expect(reads).toBe(3);
  const after = await snapshot();
  expect(after.operations).toEqual(before.operations);
  expect(after.objects).toEqual(before.objects);
  expect(after.calls).toEqual(before.calls);
  expect(after.usage).toEqual(before.usage);
  expect(network).not.toHaveBeenCalled();
});

it("rejects a retained unsupported mask version without adding, repairing or converting records", async () => {
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", receipt.receiptId)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify({ ...JSON.parse(row.result), version: 1 }) })
    .where("id", "=", receipt.receiptId)
    .execute();
  const before = await snapshot();
  await expect(
    viewImageMaskRegion(db, ctx, input(), options()),
  ).rejects.toThrow("version:2");
  expect(await snapshot()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});
