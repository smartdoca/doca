import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { AppError, systemErrorReason } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import {
  readRawImageCandidate,
} from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  prepareImageEditMask,
  readImageEditMask,
  previewImageEditMask,
  imageEditMaskInputSchema,
  type ImageEditMaskInput,
} from "../apps/server/src/services/ai/image-edit-mask.js";
import { preserveOutsideBitmap } from "../apps/server/src/services/ai/image-edit-bitmap.js";
import { rawImageCandidateReceiptId } from "../apps/server/src/services/ai/image-candidates.js";
import {
  prepareImageMaskSegment,
  type ImageMaskSegmentInput,
} from "../apps/server/src/services/ai/image-mask-segment.js";
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
  sourceKey: string,
  generationId: string;
let network: ReturnType<typeof vi.fn>;
const runtime = () => ({ ...storage.storageRuntime(), root });
const options = () => ({ storage: runtime() });
const png = (width = 80, height = 60, color = "#426683") =>
  sharp({ create: { width, height, channels: 4, background: color } })
    .png({ compressionLevel: 0 })
    .toBuffer();
const region = (left: number, top: number, right: number, bottom: number) => ({
  label: "fixture selection",
  points: [
    [left / 80, top / 60],
    [right / 80, top / 60],
    [right / 80, bottom / 60],
    [left / 80, bottom / 60],
  ] as [number, number][],
});
const empty = () => ({ proposalIds: [], include: [], exclude: [] });
function input(): ImageEditMaskInput {
  const hole = region(22, 22, 26, 26);
  return {
    generationOperationId: generationId,
    referenceImageId: sourceId,
    sourceTarget: {
      proposalIds: [],
      include: [region(10, 10, 35, 45), region(5, 4, 8, 8)],
      exclude: [hole],
    },
    generatedTarget: {
      proposalIds: [],
      include: [region(20, 8, 47, 48), region(55, 4, 60, 8)],
      exclude: [hole, region(43, 20, 45, 32), region(40, 25, 43, 32)],
    },
    protected: {
      proposalIds: [],
      include: [region(40, 20, 45, 32)],
      exclude: [],
    },
    allowedOcclusion: {
      proposalIds: [],
      include: [region(40, 20, 43, 25)],
      exclude: [],
    },
    textEdits: {
      proposalIds: [],
      include: [region(5, 52, 30, 58)],
      exclude: [],
    },
  };
}
async function job(actor = owner, session = sessionId) {
  const id = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      user_id: actor.id,
      session_id: session,
      model_id: "image",
      status: "running",
      input: "{}",
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
async function session(actor = owner) {
  const id = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: actor.id,
      title: "Mask fixture",
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
async function generate(id: string, extra: object = {}, pixels?: Buffer) {
  return generateImageAsset(
    db,
    ctx,
    {
      prompt: "Change the requested person",
      referenceImageIds: [sourceId],
      ...extra,
    },
    id,
    {
      ...options(),
      fetch: (async () =>
        Response.json({
          data: [
            {
              b64_json: (pixels ?? (await png(80, 60, "#c97643"))).toString(
                "base64",
              ),
            },
          ],
          usage: { input_images: 1, input_tokens: 10, output_tokens: 20 },
        })) as typeof fetch,
    },
  );
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-image-mask-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "mask-owner",
        displayName: "Owner",
        password: "mask-fixture-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "mask-other",
        displayName: "Other",
        password: "mask-fixture-2026",
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
          apiKey: "not-real",
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
  sessionId = await session();
  ctx = await job();
  sourceId = randomUUID();
  sourceKey = objectKey(sourceId, "image/png");
  const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow(),
    data = await png();
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), profile),
      sourceKey,
      data,
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
      object_key: sourceKey,
      filename: "source.png",
      mime: "image/png",
      size: data.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  await db
    .updateTable("ai_jobs")
    .set({ input: JSON.stringify({ attachments: [sourceId] }) })
    .where("id", "=", ctx.jobId!)
    .execute();
  generationId = randomUUID();
  await generate(generationId);
  network = vi.fn(() => {
    throw new Error("No network allowed in local mask work");
  });
  vi.stubGlobal("fetch", network);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

it("retains exact holes, separate components, new-outline growth and authorized occlusion while unchanged visible props remain original", async () => {
  const id = randomUUID(),
    receipt = await prepareImageEditMask(db, ctx, input(), id, options());
  expect(receipt).toMatchObject({
    kind: "image_edit_mask",
    version: 2,
    state: "diagnostic-only",
    diagnostics: {
      semanticCoverage: "unverified",
      safeToCompose: true,
      protectionConflictPixels: 0,
    },
    coverage: { allowedOcclusionPixels: 15, remainingProtectionPixels: 45 },
  });
  expect(receipt.coverage.expandedPixels).toBeGreaterThan(0);
  const loaded = await readImageEditMask(db, ctx, id, options()),
    mask = await sharp(loaded.maskPNG).toColourspace("b-w").raw().toBuffer(),
    protection = await sharp(loaded.protectionPNG!)
      .toColourspace("b-w")
      .raw()
      .toBuffer();
  const index = (x: number, y: number) => y * 80 + x;
  expect(mask[index(23, 23)]).toBe(0); // Shared hole is not filled by union.
  expect(mask[index(6, 5)]).toBe(255);
  expect(mask[index(57, 5)]).toBe(255); // Disconnected components.
  expect(mask[index(46, 46)]).toBe(255); // Complete new shoulder outside old outline.
  expect(mask[index(41, 22)]).toBe(255);
  expect(protection[index(41, 22)]).toBe(0); // Explicit hand occlusion.
  expect(mask[index(44, 28)]).toBe(0);
  expect(protection[index(44, 28)]).toBe(255); // Still-visible prop.
  const composed = await preserveOutsideBitmap(
    loaded.sourceData,
    loaded.generatedCanvas,
    loaded.maskPNG,
    loaded.protectionPNG,
  );
  const original = await sharp(loaded.sourceData)
      .ensureAlpha()
      .raw()
      .toBuffer(),
    actual = await sharp(composed.data).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < mask.length; i++)
    if (mask[i] === 0)
      expect(actual.subarray(i * 4, i * 4 + 4)).toEqual(
        original.subarray(i * 4, i * 4 + 4),
      );
  expect(composed.preservation.protectedPixelsChanged).toBe(0);
  expect(network).not.toHaveBeenCalled();
});

it("preserves conflicts for explicit correction rather than trimming the new hand or claiming semantic coverage", async () => {
  const args = input();
  args.generatedTarget.exclude = [region(22, 22, 26, 26)];
  const id = randomUUID(),
    receipt = await prepareImageEditMask(db, ctx, args, id, options());
  expect(receipt.diagnostics).toMatchObject({
    safeToCompose: false,
    semanticCoverage: "unverified",
    protectionConflictPixels: 45,
    generatedConflictPixels: 45,
  });
  expect(receipt.diagnostics.sourceExcludedPixels).toBe(16);
  const loaded = await readImageEditMask(db, ctx, id, options()),
    pixels = await sharp(loaded.maskPNG).toColourspace("b-w").raw().toBuffer();
  expect(pixels[28 * 80 + 44]).toBe(255); // Conflict retained; no silent P subtraction.
  await expect(
    preserveOutsideBitmap(
      loaded.sourceData,
      loaded.generatedCanvas,
      loaded.maskPNG,
      loaded.protectionPNG,
    ),
  ).rejects.toMatchObject({ code: "protection_conflict" });
  const preview = await previewImageEditMask(db, ctx, id, options());
  expect(preview.full.view).toBe("source-full");
  expect(preview.local.view).toBe("generated-local");
  for (const frame of [preview.full, preview.local]) {
    expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(1600);
    expect(frame.contentRect.top).toBe(80);
    expect(frame.sourceRect.width).toBeGreaterThan(0);
    expect((await sharp(frame.data).metadata()).format).toBe("png");
  }
  expect(receipt.instruction).toContain("不是人物");
});

it.each(["outside-intersection", "text"])(
  "rejects invalid occlusion %s without storing a receipt",
  async (kind) => {
    const args = input(),
      id = randomUUID();
    if (kind === "outside-intersection")
      args.allowedOcclusion = {
        proposalIds: [],
        include: [region(2, 2, 4, 4)],
        exclude: [],
      };
    else
      args.textEdits = {
        proposalIds: [],
        include: [region(40, 20, 42, 22)],
        exclude: [],
      };
    await expect(
      prepareImageEditMask(db, ctx, args, id, options()),
    ).rejects.toThrow("允许遮挡必须完全位于新人物与保护对象交集");
    expect(
      await db
        .selectFrom("ai_operations")
        .select("id")
        .where("id", "=", id)
        .execute(),
    ).toEqual([]);
  },
);

it("requires explicit empty fields, supports independent text-only editing and rejects an empty final operation", async () => {
  const args = input();
  args.sourceTarget = empty();
  args.generatedTarget = empty();
  args.protected = empty();
  args.allowedOcclusion = empty();
  const receipt = await prepareImageEditMask(
    db,
    ctx,
    args,
    randomUUID(),
    options(),
  );
  expect(receipt.coverage).toMatchObject({
    sourceTargetPixels: 0,
    generatedTargetPixels: 0,
    textPixels: 150,
    editablePixels: 150,
  });
  const { textEdits: _text, ...missing } = args;
  expect(imageEditMaskInputSchema.safeParse(missing).success).toBe(false);
  args.textEdits = empty();
  await expect(
    prepareImageEditMask(db, ctx, args, randomUUID(), options()),
  ).rejects.toThrow("没有任何可编辑像素");
});

it("replays an immutable receipt across a same-session job and refuses conflicting parameters without new assets or image usage", async () => {
  const beforeAssets = await db
      .selectFrom("assets")
      .selectAll()
      .orderBy("id")
      .execute(),
    beforeUsage = await usageSummary(db, owner.id),
    id = randomUUID();
  const receipt = await prepareImageEditMask(db, ctx, input(), id, options());
  const next = await job();
  expect(await prepareImageEditMask(db, next, input(), id, options())).toEqual(
    receipt,
  );
  const changed = input();
  changed.generatedTarget.include = [region(20, 8, 46, 48)];
  await expect(
    prepareImageEditMask(db, ctx, changed, id, options()),
  ).rejects.toThrow("不同参数");
  expect((await readImageEditMask(db, ctx, id, options())).receipt).toEqual(
    receipt,
  );
  expect(
    await db.selectFrom("assets").selectAll().orderBy("id").execute(),
  ).toEqual(beforeAssets);
  expect(await usageSummary(db, owner.id)).toEqual(beforeUsage);
  expect(network).not.toHaveBeenCalled();
});

it("rechecks source ACL, foreign account and session, cancelled job and readonly preparation", async () => {
  const id = randomUUID();
  await prepareImageEditMask(db, ctx, input(), id, options());
  const foreign = await job(other, await session(other));
  await expect(readImageEditMask(db, foreign, id, options())).rejects.toThrow();
  const another = await job(owner, await session());
  await expect(readImageEditMask(db, another, id, options())).rejects.toThrow(
    "作用域",
  );
  await expect(
    prepareImageEditMask(
      db,
      { ...ctx, writable: false },
      input(),
      randomUUID(),
      options(),
    ),
  ).rejects.toThrow("仅允许读取");
  await db
    .updateTable("assets")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", sourceId)
    .execute();
  await expect(readImageEditMask(db, ctx, id, options())).rejects.toThrow();
  await db
    .updateTable("assets")
    .set({ deleted_at: null })
    .where("id", "=", sourceId)
    .execute();
  await db
    .updateTable("ai_jobs")
    .set({ cancelled: 1 })
    .where("id", "=", ctx.jobId!)
    .execute();
  await expect(previewImageEditMask(db, ctx, id, options())).rejects.toThrow();
});

it.each(["source-dimensions", "raw-bytes"])(
  "rejects changed retained %s and preserves the mask record",
  async (kind) => {
    const id = randomUUID(),
      receipt = await prepareImageEditMask(db, ctx, input(), id, options());
    if (kind === "source-dimensions")
      await writeFile(join(root, sourceKey), await png(80, 61));
    else {
      const raw = await readRawImageCandidate(db, ctx, generationId, runtime());
      await writeFile(
        join(root, raw.candidate.objectKey),
        await png(80, 60, "#124222"),
      );
    }
    await expect(readImageEditMask(db, ctx, id, options())).rejects.toThrow();
    expect(
      JSON.parse(
        (
          await db
            .selectFrom("ai_operations")
            .select("result")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
        ).result,
      ),
    ).toEqual(receipt);
  },
);

it("rejects a viewport expansion outside generated pixels and a distorted full raw before writing a mask", async () => {
  const viewportId = randomUUID();
  await generate(viewportId, { editRegions: [region(20, 20, 30, 30)] });
  const args = input();
  args.generationOperationId = viewportId;
  await expect(
    prepareImageEditMask(db, ctx, args, randomUUID(), options()),
  ).rejects.toThrow("超出原始候选实际生成窗口");
  const square = randomUUID();
  await generate(square, {}, await png(80, 80));
  args.generationOperationId = square;
  await expect(
    prepareImageEditMask(db, ctx, args, randomUUID(), options()),
  ).rejects.toThrow("比例偏差超过 1%");
});

it("rejects a changed raw coordinate transform instead of moving the retained mask to it", async () => {
  const id = randomUUID();
  const receipt = await prepareImageEditMask(db, ctx, input(), id, options());
  const rawId = rawImageCandidateReceiptId(generationId);
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", rawId)
    .executeTakeFirstOrThrow();
  const candidate = JSON.parse(row.result);
  candidate.transform = {
    kind: "viewport",
    rect: { left: 0, top: 0, width: 80, height: 60 },
    workspace: null,
  };
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(candidate) })
    .where("id", "=", rawId)
    .execute();
  await expect(readImageEditMask(db, ctx, id, options())).rejects.toThrow(
    "坐标映射已变化",
  );
  expect(
    JSON.parse(
      (
        await db
          .selectFrom("ai_operations")
          .select("result")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).result,
    ),
  ).toEqual(receipt);
});

it("does not publish preview pixels if source permission is revoked during the final recheck", async () => {
  const id = randomUUID();
  await prepareImageEditMask(db, ctx, input(), id, options());
  const raw = await readRawImageCandidate(db, ctx, generationId, runtime());
  const original = storage.createStorage;
  let rawReads = 0;
  vi.spyOn(storage, "createStorage").mockImplementation((value) => {
    const adapter = original(value);
    return {
      ...adapter,
      read: async (...args) => {
        const data = await adapter.read(...args);
        if (args[1] === raw.candidate.objectKey && ++rawReads === 3)
          await db
            .updateTable("assets")
            .set({ deleted_at: new Date().toISOString() })
            .where("id", "=", sourceId)
            .execute();
        return data;
      },
    };
  });
  await expect(previewImageEditMask(db, ctx, id, options())).rejects.toThrow();
  expect(rawReads).toBe(3);
  expect(network).not.toHaveBeenCalled();
});

it("rejects tampered or old mask formats and unavailable old raw without conversion or deletion", async () => {
  const id = randomUUID();
  await prepareImageEditMask(db, ctx, input(), id, options());
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const tampered = JSON.parse(row.result);
  tampered.coverage.editablePixels++;
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(tampered) })
    .where("id", "=", id)
    .execute();
  await expect(readImageEditMask(db, ctx, id, options())).rejects.toThrow(
    "摘要不一致",
  );
  tampered.version = 1;
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(tampered) })
    .where("id", "=", id)
    .execute();
  await expect(readImageEditMask(db, ctx, id, options())).rejects.toThrow(
    "完整 version:2",
  );
  expect(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(JSON.stringify(tampered));
  const old = input();
  old.generationOperationId = randomUUID();
  await expect(
    prepareImageEditMask(db, ctx, old, randomUUID(), options()),
  ).rejects.toThrow("没有持久原始候选");
});

it("an already aborted preparation has no mask receipt or supplier call", async () => {
  const id = randomUUID(),
    controller = new AbortController();
  controller.abort();
  await expect(
    prepareImageEditMask(db, ctx, input(), id, {
      ...options(),
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("id", "=", id)
      .execute(),
  ).toEqual([]);
  expect(network).not.toHaveBeenCalled();
});

const exactSelection = () => {
  const pixels = Buffer.alloc(80 * 60);
  for (let y = 10; y < 45; y++)
    for (let x = 10; x < 35; x++) pixels[y * 80 + x] = 255;
  for (let y = 22; y < 26; y++)
    for (let x = 22; x < 26; x++) pixels[y * 80 + x] = 0;
  for (let y = 4; y < 8; y++)
    for (let x = 5; x < 8; x++) pixels[y * 80 + x] = 255;
  return pixels;
};
async function proposal(
  source: ImageMaskSegmentInput["source"],
  pixels = exactSelection(),
  positive: [number, number] = [11 / 80, 11 / 60],
) {
  const receipt = await prepareImageMaskSegment(
    db,
    ctx,
    {
      source,
      targets: [
        {
          label: "exact target",
          box: [0, 0, 1, 1],
          positivePoints: [positive],
          negativePoints: [[0, 0]],
        },
      ],
      exclusions: [],
    },
    randomUUID(),
    {
      ...options(),
      profile: await fixtureSegmentationProfile(root),
      worker: fixtureSegmentationWorker(pixels),
    },
  );
  return receipt;
}
const exactInput = (): ImageEditMaskInput => ({
  generationOperationId: generationId,
  referenceImageId: sourceId,
  sourceTarget: empty(),
  generatedTarget: empty(),
  protected: empty(),
  allowedOcclusion: empty(),
  textEdits: empty(),
});
async function maskState() {
  return {
    operations: await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute(),
    assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    usage: await usageSummary(db, owner.id),
  };
}
it("unions real signed exact proposals before polygon additions and exclusions without contour reduction, filling holes, losing components or paying again", async () => {
  const sourceProposal = await proposal({
      kind: "reference",
      referenceImageId: sourceId,
    }),
    rawProposal = await proposal({
      kind: "raw",
      generationOperationId: generationId,
    });
  expect(sourceProposal.usable).toBe(true);
  expect(rawProposal.usable).toBe(true);
  const value = exactInput();
  value.sourceTarget = {
    proposalIds: [sourceProposal.receiptId],
    include: [region(38, 10, 42, 14)],
    exclude: [region(10, 10, 12, 14)],
  };
  value.generatedTarget = {
    proposalIds: [rawProposal.receiptId],
    include: [],
    exclude: [region(10, 10, 12, 14)],
  };
  // The same exact binary may legitimately serve text only when explicitly declared.
  value.textEdits = {
    proposalIds: [sourceProposal.receiptId],
    include: [],
    exclude: [region(10, 10, 12, 14)],
  };
  const before = await usageSummary(db, owner.id),
    id = randomUUID(),
    receipt = await prepareImageEditMask(db, ctx, value, id, options());
  expect(receipt.version).toBe(2);
  expect(receipt.proposalBindings).toEqual(
    [sourceProposal, rawProposal]
      .map((p) => ({
        receiptId: p.receiptId,
        digest: p.digest,
        selectionSha256: p.selectionSha256,
      }))
      .sort((a, b) => a.receiptId.localeCompare(b.receiptId)),
  );
  const loaded = await readImageEditMask(db, ctx, id, options()),
    pixels = await sharp(loaded.maskPNG).toColourspace("b-w").raw().toBuffer();
  expect(pixels[23 * 80 + 23]).toBe(0);
  expect(pixels[5 * 80 + 6]).toBe(255);
  expect(pixels[11 * 80 + 11]).toBe(0);
  expect(pixels[11 * 80 + 39]).toBe(255);
  expect(pixels[44 * 80 + 34]).toBe(255);
  expect(pixels[45 * 80 + 34]).toBe(0);
  expect(loaded.computed.s.pixels.filter((p) => p === 255).length).toBe(
    exactSelection().filter((p) => p === 255).length + 16 - 8,
  );
  expect(await usageSummary(db, owner.id)).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it.each([
  "sourceTarget",
  "protected",
  "generatedTarget",
  "allowedOcclusion",
] as const)(
  "rejects the wrong proposal origin for %s before recording any mask",
  async (name) => {
    const source =
      name === "sourceTarget" || name === "protected"
        ? { kind: "raw" as const, generationOperationId: generationId }
        : { kind: "reference" as const, referenceImageId: sourceId };
    const receipt = await proposal(source),
      value = exactInput();
    value[name].proposalIds = [receipt.receiptId];
    const before = await maskState();
    await expect(
      prepareImageEditMask(db, ctx, value, randomUUID(), options()),
    ).rejects.toThrow("只能使用");
    expect(await maskState()).toEqual(before);
  },
);

it("rejects proposals from a distinct same-byte page and from another same-byte raw operation, preserving original proposal facts", async () => {
  const alternate = randomUUID(),
    data = await png(),
    active = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow(),
    key = objectKey(alternate, "image/png");
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), active),
      key,
      data,
      "image/png",
      "same.png",
    );
  await db
    .insertInto("assets")
    .values({
      id: alternate,
      owner_id: owner.id,
      uploaded_by: owner.id,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: active.id,
      object_key: key,
      filename: "same.png",
      mime: "image/png",
      size: data.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  await db
    .updateTable("ai_jobs")
    .set({ input: JSON.stringify({ attachments: [sourceId, alternate] }) })
    .where("id", "=", ctx.jobId!)
    .execute();
  const alternateSource = await proposal({
      kind: "reference",
      referenceImageId: alternate,
    }),
    alternateRawId = randomUUID();
  await generate(alternateRawId);
  const alternateRaw = await proposal({
      kind: "raw",
      generationOperationId: alternateRawId,
    }),
    before = await maskState();
  for (const [name, receipt] of [
    ["sourceTarget", alternateSource],
    ["generatedTarget", alternateRaw],
  ] as const) {
    const value = exactInput();
    value[name].proposalIds = [receipt.receiptId];
    await expect(
      prepareImageEditMask(db, ctx, value, randomUUID(), options()),
    ).rejects.toThrow("不一致");
  }
  expect(await maskState()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it("rejects a real diagnostic-only failed proposal instead of turning its retained pixels into an editable selection", async () => {
  const failed = await proposal(
    { kind: "reference", referenceImageId: sourceId },
    exactSelection(),
    [23 / 80, 23 / 60],
  );
  expect(failed.usable).toBe(false);
  const value = exactInput();
  value.sourceTarget.proposalIds = [failed.receiptId];
  const before = await maskState();
  await expect(
    prepareImageEditMask(db, ctx, value, randomUUID(), options()),
  ).rejects.toThrow("仅可诊断");
  expect(await maskState()).toEqual(before);
});

it("verifies frozen proposal digest even when an intact final mask digest and all coverage facts remain unchanged", async () => {
  const signed = await proposal({
      kind: "reference",
      referenceImageId: sourceId,
    }),
    value = exactInput();
  value.sourceTarget.proposalIds = [signed.receiptId];
  const id = randomUUID(),
    receipt = await prepareImageEditMask(db, ctx, value, id, options());
  const mutated = {
    ...receipt,
    proposalBindings: [
      { ...receipt.proposalBindings[0]!, digest: "0".repeat(64) },
    ],
  };
  const { digest: _ignored, ...base } = mutated;
  mutated.digest = createHash("sha256")
    .update("doca-image-edit-mask-v2\0" + JSON.stringify(base))
    .digest("hex");
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(mutated), digest: mutated.digest })
    .where("id", "=", id)
    .execute();
  const before = await maskState();
  await expect(readImageEditMask(db, ctx, id, options())).rejects.toThrow(
    "全部分割回执摘要",
  );
  expect(await maskState()).toEqual(before);
  expect(mutated.maskDigest).toBe(receipt.maskDigest);
});

it.each(["artifact", "receipt", "cancelled"] as const)(
  "rechecks %s in an actual proposal after preparation and refuses stale mask reads without mutating retained evidence",
  async (mode) => {
    const signed = await proposal({
        kind: "reference",
        referenceImageId: sourceId,
      }),
      value = exactInput();
    value.sourceTarget.proposalIds = [signed.receiptId];
    const id = randomUUID();
    await prepareImageEditMask(db, ctx, value, id, options());
    if (mode === "artifact")
      await writeFile(
        join(
          root,
          signed.artifacts.find((a) => a.role === "selection")!.objectKey,
        ),
        await png(),
      );
    else if (mode === "receipt")
      await db
        .updateTable("ai_operations")
        .set({
          result: JSON.stringify({
            ...signed,
            selectionSha256: "0".repeat(64),
          }),
        })
        .where("id", "=", signed.receiptId)
        .execute();
    else
      await db
        .updateTable("ai_jobs")
        .set({ cancelled: 1 })
        .where("id", "=", ctx.jobId!)
        .execute();
    const before = await maskState();
    await expect(readImageEditMask(db, ctx, id, options())).rejects.toThrow();
    expect(await maskState()).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  },
);

it("rejects an exact source proposal extending beyond the actual raw viewport without clipping its preserved components", async () => {
  const viewport = randomUUID();
  await generate(viewport, { editRegions: [region(20, 20, 30, 30)] });
  const pixels = exactSelection();
  pixels[5 * 80 + 55] = 255;
  const signed = await proposal(
      { kind: "reference", referenceImageId: sourceId },
      pixels,
    ),
    value = exactInput();
  value.generationOperationId = viewport;
  value.sourceTarget.proposalIds = [signed.receiptId];
  const before = await maskState();
  await expect(
    prepareImageEditMask(db, ctx, value, randomUUID(), options()),
  ).rejects.toThrow("超出原始候选实际生成窗口");
  expect(await maskState()).toEqual(before);
});

it.each(["source", "raw"] as const)(
  "keeps a missing retained %s file private at every public mask boundary without new writes or supplier fees",
  async (kind) => {
    const receipt = await prepareImageEditMask(
        db,
        ctx,
        input(),
        randomUUID(),
        options(),
      ),
      raw = await readRawImageCandidate(db, ctx, generationId, runtime());
    await rm(
      join(root, kind === "source" ? sourceKey : raw.candidate.objectKey),
    );
    const before = await maskState();
    for (const operation of [
      () => prepareImageEditMask(db, ctx, input(), randomUUID(), options()),
      () =>
        prepareImageEditMask(db, ctx, input(), receipt.receiptId, options()),
      () => readImageEditMask(db, ctx, receipt.receiptId, options()),
      () => previewImageEditMask(db, ctx, receipt.receiptId, options()),
    ]) {
      const error = await operation().catch((value) => value);
      expect(error).toBeInstanceOf(AppError);
      expect(error.status).toBe(503);
      expect(systemErrorReason(error)).toEqual({
        code: "image_mask_io_failed",
      });
      expect(error.message).toBe(
        "蒙版资料或图像处理暂时不可用，原记录保留；本次没有调用图片服务",
      );
      expect(error).not.toHaveProperty("cause");
      expect(
        JSON.stringify({
          message: error.message,
          stack: error.stack,
          ...error,
        }),
      ).not.toContain(root);
    }
    expect(await maskState()).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  },
);

it("keeps a private cancellation reason out of every mask public entry while retaining AbortError semantics and all records", async () => {
  const receipt = await prepareImageEditMask(
      db,
      ctx,
      input(),
      randomUUID(),
      options(),
    ),
    controller = new AbortController();
  controller.abort(
    new Error("PRIVATE_MASK_REASON " + root, {
      cause: new Error("PRIVATE_MASK_CAUSE"),
    }),
  );
  const common = { ...options(), signal: controller.signal },
    before = await maskState();
  for (const operation of [
    () => prepareImageEditMask(db, ctx, input(), randomUUID(), common),
    () => readImageEditMask(db, ctx, receipt.receiptId, common),
    () => previewImageEditMask(db, ctx, receipt.receiptId, common),
  ]) {
    const error = await operation().catch((value) => value);
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("蒙版操作已取消或任务授权已撤回");
    expect(error).not.toHaveProperty("cause");
    expect(error.stack).not.toContain(root);
    expect(error.stack).not.toContain("PRIVATE_MASK_REASON");
  }
  expect(await maskState()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
});

it.each(["prepare", "read", "preview"] as const)(
  "sanitizes a raw object disappearing after the first authorized read during %s and commits no new mask facts",
  async (kind) => {
    const receipt = await prepareImageEditMask(
        db,
        ctx,
        input(),
        randomUUID(),
        options(),
      ),
      raw = await readRawImageCandidate(db, ctx, generationId, runtime()),
      original = storage.createStorage;
    let attemptedRawReads = 0;
    vi.spyOn(storage, "createStorage").mockImplementation((value) => {
      const result = original(value);
      return {
        ...result,
        read: async (...args) => {
          const isRaw = args[1] === raw.candidate.objectKey;
          if (isRaw) attemptedRawReads++;
          const data = await result.read(...args);
          if (isRaw && attemptedRawReads === 1) await rm(join(root, args[1]));
          return data;
        },
      };
    });
    const before = await maskState(),
      operation =
        kind === "prepare"
          ? prepareImageEditMask(db, ctx, input(), randomUUID(), options())
          : kind === "read"
            ? readImageEditMask(db, ctx, receipt.receiptId, options())
            : previewImageEditMask(db, ctx, receipt.receiptId, options());
    const error = await operation.catch((value) => value);
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(503);
    expect(systemErrorReason(error)).toEqual({ code: "image_mask_io_failed" });
    expect(error.message).not.toContain(root);
    expect(error).not.toHaveProperty("cause");
    expect(attemptedRawReads).toBe(2);
    expect(await maskState()).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  },
);
