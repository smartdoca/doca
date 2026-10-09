import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { systemErrorReason } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import * as storageModule from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import * as automation from "@core/modules/automation/jobs.js";
import * as transactions from "@db/transactions.js";
import * as storedObjects from "../apps/server/src/services/stored-objects.js";
import {
  readRawImageCandidate,
} from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  recomposeImageAsset,
  recomposeImageMaskAsset,
} from "../apps/server/src/services/ai/image-recompose.js";
import {
  prepareImageEditMask,
  readImageEditMask,
  type ImageEditMaskInput,
} from "../apps/server/src/services/ai/image-edit-mask.js";
import {
  editMask,
  type EditRegions,
} from "../apps/server/src/services/ai/image-edit-regions.js";
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
  ctx: ToolContext,
  owner: Actor;
let sourceId: string,
  source: Buffer,
  operationId: string,
  providerCalls: number;
const regions: EditRegions = [
  {
    label: "目标",
    points: [
      [0.2, 0.2],
      [0.6, 0.2],
      [0.6, 0.7],
      [0.2, 0.7],
    ],
  },
];
const runtime = () => ({ ...storageModule.storageRuntime(), root });
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-recompose-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "recompose-owner",
        displayName: "Owner",
        password: "isolated-recompose-2026",
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
          id: "fixture",
          name: "Fixture",
          provider: "openai",
          baseUrl: "https://images.invalid/v1",
          apiKey: "not-real",
          enabled: true,
        },
      ],
      models: [
        {
          id: "image",
          vendorId: "fixture",
          model: "gpt-image-test",
          alias: "Image",
          enabled: true,
          tools: false,
          imageGeneration: true,
          imageProfile: "gpt-image-2",
          maxInput: 32000,
          maxOutput: 1000,
          imageRate: 250,
        },
      ],
    },
    0,
  );
  const session = randomUUID(),
    job = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: session,
      user_id: owner.id,
      title: "Recompose",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  ctx = { actor: owner, jobId: job, lease, writable: true };
  sourceId = randomUUID();
  await db
    .insertInto("ai_jobs")
    .values({
      id: job,
      session_id: session,
      user_id: owner.id,
      model_id: "image",
      status: "running",
      input: JSON.stringify({ attachments: [sourceId] }),
      digest: job,
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
  source = await sharp({
    create: { width: 64, height: 96, channels: 4, background: "#135da8" },
  })
    .png()
    .toBuffer();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const key = objectKey(sourceId, "image/png");
  await storageModule
    .createStorage(runtime())
    .put(
      storageModule.storageConfigForProfile(runtime(), profile),
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
      created_at: now,
      deleted_at: null,
    })
    .execute();
  operationId = randomUUID();
  providerCalls = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

async function generate(
  editRegions?: EditRegions,
  geometry = { width: 64, height: 96, orientation: 1 },
) {
  const data = await sharp({
    create: {
      width: geometry.width,
      height: geometry.height,
      channels: 4,
      background: "#dc6830",
    },
  })
    .withMetadata({ orientation: geometry.orientation })
    .png()
    .toBuffer();
  return generateImageAsset(
    db,
    ctx,
    {
      prompt: "修改目标并保留其他内容",
      referenceImageIds: [sourceId],
      ...(editRegions ? { editRegions } : {}),
    },
    operationId,
    {
      storage: runtime(),
      fetch: (async () => {
        providerCalls++;
        return Response.json({
          data: [{ b64_json: data.toString("base64") }],
          usage: { input_images: 1, generated_images: 1 },
        });
      }) as typeof fetch,
    },
  );
}
const input = (editRegions = regions) => ({
  generationOperationId: operationId,
  referenceImageId: sourceId,
  editRegions,
  filename: "recomposed.png",
});
async function assetBytes(id: string) {
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return readFile(join(root, asset.object_key));
}

function makeConfirmationUnavailable() {
  const select = db.selectFrom.bind(db);
  function unavailable<T extends object>(query: T): T {
    return new Proxy(query, {
      get(target, property) {
        if (property === "executeTakeFirst")
          return async () => {
            throw Error("Confirmation unavailable");
          };
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...values: unknown[]) => {
          const next = Reflect.apply(value, target, values);
          return next && typeof next === "object" && "executeTakeFirst" in next
            ? unavailable(next)
            : next;
        };
      },
    });
  }
  vi.spyOn(db, "selectFrom").mockImplementation(((
    ...queryArgs: Parameters<typeof select>
  ) => {
    const query = select(...queryArgs);
    return queryArgs[0] === "ai_operations" ? unavailable(query) : query;
  }) as typeof db.selectFrom);
}

it("reuses raw pixels with exact protected RGBA and idempotent receipts, without another paid call or raw mutation", async () => {
  await generate();
  const rawBefore = await readRawImageCandidate(
    db,
    ctx,
    operationId,
    runtime(),
  );
  const usageBefore = await usageSummary(db, owner.id),
    id = randomUUID();
  const result = await recomposeImageAsset(db, ctx, input(), id, {
    storage: runtime(),
  });
  const repeated = await recomposeImageAsset(db, ctx, input(), id, {
    storage: runtime(),
  });
  expect(repeated.assetId).toBe(result.assetId);
  expect(providerCalls).toBe(1);
  expect(await usageSummary(db, owner.id)).toEqual(usageBefore);
  expect(result).toMatchObject({
    origin: "local-recomposition",
    generationOperationId: operationId,
    providerImageUsage: { inputImages: 1 },
    preservation: { protectedPixelsChanged: 0 },
  });
  const actual = await sharp(await assetBytes(result.assetId))
    .ensureAlpha()
    .raw()
    .toBuffer();
  const original = await sharp(source).ensureAlpha().raw().toBuffer();
  const mask = await sharp(await editMask(source, regions))
    .ensureAlpha()
    .raw()
    .toBuffer();
  let changed = 0;
  for (let p = 0; p < 64 * 96; p++) {
    const editable = mask[p * 4 + 3] === 0;
    if (!editable)
      expect(actual.subarray(p * 4, p * 4 + 4)).toEqual(
        original.subarray(p * 4, p * 4 + 4),
      );
    else if (
      !actual
        .subarray(p * 4, p * 4 + 4)
        .equals(original.subarray(p * 4, p * 4 + 4))
    )
      changed++;
  }
  expect(changed).toBeGreaterThan(500);
  expect(
    (await readRawImageCandidate(db, ctx, operationId, runtime())).data,
  ).toEqual(rawBefore.data);
  expect(
    await db
      .selectFrom("file_items")
      .select("id")
      .where("storage_object_id", "=", rawBefore.candidate.assetId)
      .execute(),
  ).toEqual([]);
});

it.each([
  { width: 64, height: 64, orientation: 1 },
  { width: 203, height: 300, orientation: 1 },
])(
  "rejects whole-page raw deformation ($width x $height), preserving raw, lease, receipts and usage without new storage",
  async (geometry) => {
    await generate(undefined, geometry);
    const before = {
      raw: await readRawImageCandidate(db, ctx, operationId, runtime()),
      assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
      operations: await db
        .selectFrom("ai_operations")
        .selectAll()
        .orderBy("id")
        .execute(),
      job: await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", ctx.jobId!)
        .executeTakeFirstOrThrow(),
      usage: await usageSummary(db, owner.id),
    };
    expect(before.raw.candidate.transform.kind).toBe("full");
    expect(before.raw.candidate.dimensions).toEqual({
      width: geometry.width,
      height: geometry.height,
    });
    const storage = storageModule.createStorage(runtime());
    const put = vi.spyOn(storage, "put");
    vi.spyOn(storageModule, "createStorage").mockReturnValue(storage);
    const composeId = randomUUID();
    const error = await recomposeImageAsset(db, ctx, input(), composeId, {
      storage: runtime(),
    }).catch((error) => error);
    expect(error).toMatchObject({ status: 409 });
    expect(systemErrorReason(error)).toEqual({
      code: "image_recompose_aspect_mismatch",
    });
    expect(put).not.toHaveBeenCalled();
    expect(
      await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    ).toEqual(before.assets);
    expect(
      await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
    ).toEqual(before.operations);
    expect(
      await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", ctx.jobId!)
        .executeTakeFirstOrThrow(),
    ).toEqual(before.job);
    const afterRaw = await readRawImageCandidate(
      db,
      ctx,
      operationId,
      runtime(),
    );
    expect(afterRaw.candidate).toEqual(before.raw.candidate);
    expect(afterRaw.data).toEqual(before.raw.data);
    expect(providerCalls).toBe(1);
    expect(await usageSummary(db, owner.id)).toEqual(before.usage);
  },
);

it.each([
  { width: 67, height: 100, orientation: 1 },
  { width: 100, height: 67, orientation: 6 },
  { width: 202, height: 300, orientation: 1 },
])(
  "allows a legal rounded whole-page display ratio to recompose for free ($width x $height, orientation $orientation)",
  async (geometry) => {
    await generate(undefined, geometry);
    const before = await usageSummary(db, owner.id);
    const rawBefore = await readRawImageCandidate(
      db,
      ctx,
      operationId,
      runtime(),
    );
    expect(rawBefore.candidate.transform.kind).toBe("full");
    expect(rawBefore.candidate.dimensions).toEqual(
      geometry.orientation === 6
        ? { width: geometry.height, height: geometry.width }
        : { width: geometry.width, height: geometry.height },
    );
    const result = await recomposeImageAsset(db, ctx, input(), randomUUID(), {
      storage: runtime(),
    });
    expect(result).toMatchObject({
      state: "saved",
      origin: "local-recomposition",
      width: 64,
      height: 96,
      preservation: { protectedPixelsChanged: 0 },
    });
    expect(
      await sharp(await assetBytes(result.assetId)).metadata(),
    ).toMatchObject({ format: "png", width: 64, height: 96 });
    expect(
      (await readRawImageCandidate(db, ctx, operationId, runtime())).data,
    ).toEqual(rawBefore.data);
    expect(providerCalls).toBe(1);
    expect(await usageSummary(db, owner.id)).toEqual(before);
  },
);

it("rejects old records without raw and mismatched source before reserving or writing a replacement", async () => {
  const composeId = randomUUID();
  await expect(
    recomposeImageAsset(db, ctx, input(), composeId, { storage: runtime() }),
  ).rejects.toThrow("没有持久原始候选");
  expect(await db.selectFrom("ai_operations").select("id").execute()).toEqual(
    [],
  );
  await generate();
  await expect(
    recomposeImageAsset(
      db,
      ctx,
      { ...input(), referenceImageId: randomUUID() },
      composeId,
      { storage: runtime() },
    ),
  ).rejects.toThrow("第一张原页");
  expect(providerCalls).toBe(1);
});

it("rejects a mask beyond a generated window instead of pretending unchanged source pixels were generated", async () => {
  await generate([
    {
      label: "小目标",
      points: [
        [0.4, 0.4],
        [0.5, 0.4],
        [0.5, 0.5],
        [0.4, 0.5],
      ],
    },
  ]);
  const outside: EditRegions = [
    {
      label: "超出",
      points: [
        [0, 0],
        [0.2, 0],
        [0.2, 0.2],
        [0, 0.2],
      ],
    },
  ];
  await expect(
    recomposeImageAsset(db, ctx, input(outside), randomUUID(), {
      storage: runtime(),
    }),
  ).rejects.toThrow("实际生成窗口");
  expect(providerCalls).toBe(1);
});

it.each(["write-failure", "cancel", "account-disabled"])(
  "keeps raw and its actual charge when local %s prevents final commit",
  async (mode) => {
    await generate();
    const raw = await readRawImageCandidate(db, ctx, operationId, runtime());
    const usageBefore = await usageSummary(db, owner.id),
      controller = new AbortController();
    const originalStorage = storageModule.createStorage;
    vi.spyOn(storageModule, "createStorage").mockImplementation((value) => {
      const store = originalStorage(value);
      return {
        ...store,
        put: async (...args) => {
          if (mode === "write-failure")
            throw Error(`EACCES private credential-like locator ${root}/secret-object`);
          await store.put(...args);
          if (mode === "cancel") controller.abort();
          else
            await db
              .updateTable("users")
              .set({ status: "disabled" })
              .where("id", "=", owner.id)
              .execute();
        },
      };
    });
    const id = randomUUID();
    const failure = await recomposeImageAsset(db, ctx, input(), id, {
        storage: runtime(),
        signal: controller.signal,
      }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    if (mode === "write-failure") {
      expect(systemErrorReason(failure)).toEqual({ code: "image_recompose_io_failed" });
      expect(failure.message).not.toContain(root);
      expect(failure.message).not.toContain("credential-like");
      expect(failure.message).not.toContain("EACCES");
    } else if (mode === "cancel") expect(failure.name).toBe("AbortError");
    expect(providerCalls).toBe(1);
    expect(await usageSummary(db, owner.id)).toEqual(usageBefore);
    expect(await assetBytes(raw.candidate.assetId)).toEqual(raw.data);
    const outputs = await db
      .selectFrom("ai_operations")
      .select("result")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(outputs.result)).toMatchObject({
      state: "save_failed",
      origin: "local-recomposition",
      rawCandidate: { assetId: raw.candidate.assetId },
    });
  },
);

it("rejects a readonly context before reserving an operation or writing objects", async () => {
  await generate();
  const before = await db.selectFrom("assets").select("id").execute();
  const id = randomUUID();
  await expect(
    recomposeImageAsset(db, { ...ctx, writable: false }, input(), id, {
      storage: runtime(),
    }),
  ).rejects.toThrow("只允许读取");
  expect(await db.selectFrom("assets").select("id").execute()).toEqual(before);
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("id", "=", id)
      .execute(),
  ).toEqual([]);
  expect(providerCalls).toBe(1);
});

it("rolls back final rows if cancellation arrives after projection is enqueued inside the transaction", async () => {
  await generate();
  const before = await db.selectFrom("assets").select("id").execute();
  const controller = new AbortController();
  const enqueue = automation.enqueueProjection;
  vi.spyOn(automation, "enqueueProjection").mockImplementation(
    async (...args) => {
      await enqueue(...args);
      controller.abort();
    },
  );
  const id = randomUUID();
  await expect(
    recomposeImageAsset(db, ctx, input(), id, {
      storage: runtime(),
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(await db.selectFrom("assets").select("id").execute()).toEqual(before);
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(row.result)).toMatchObject({
    state: "save_failed",
    localStorage: { cleanup: "removed" },
  });
  expect(providerCalls).toBe(1);
});

it.each(["readable", "unavailable"] as const)(
  "retains a committed final object after lost transaction acknowledgement when confirmation is %s",
  async (confirmation) => {
    await generate();
    const run = transactions.transact;
    let count = 0;
    vi.spyOn(transactions, "transact").mockImplementation((async (
      ...args: Parameters<typeof run>
    ) => {
      const result = await run(...args);
      if (++count === 3) {
        if (confirmation === "unavailable") {
          makeConfirmationUnavailable();
        }
        throw Error("Lost final commit acknowledgement");
      }
      return result;
    }) as typeof run);
    const id = randomUUID();
    if (confirmation === "readable") {
      const result = await recomposeImageAsset(db, ctx, input(), id, {
        storage: runtime(),
      });
      expect(result).toMatchObject({
        state: "saved",
        origin: "local-recomposition",
      });
    } else {
      await expect(
        recomposeImageAsset(db, ctx, input(), id, { storage: runtime() }),
      ).rejects.toMatchObject({ status: 503, message: "图片合成资料或保存暂时不可用，原记录保留；本次没有调用图片服务" });
    }
    vi.restoreAllMocks();
    const saved = await db
      .selectFrom("ai_operations")
      .select("result")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const receipt = JSON.parse(saved.result);
    expect(receipt).toMatchObject({
      state: "saved",
      origin: "local-recomposition",
    });
    expect((await assetBytes(receipt.assetId)).length).toBeGreaterThan(0);
    expect(
      (await readRawImageCandidate(db, ctx, operationId, runtime())).data
        .length,
    ).toBeGreaterThan(0);
    expect(providerCalls).toBe(1);
  },
);

it("retains a credential-free object locator when rollback state cannot be confirmed", async () => {
  await generate();
  const register = storedObjects.registerStoredObject;
  vi.spyOn(storedObjects, "registerStoredObject").mockImplementation(
    async (...args) => {
      await register(...args);
      makeConfirmationUnavailable();
      throw Error("Final database failure");
    },
  );
  const id = randomUUID();
  await expect(
    recomposeImageAsset(db, ctx, input(), id, { storage: runtime() }),
  ).rejects.toMatchObject({ status: 503, message: "图片合成资料或保存暂时不可用，原记录保留；本次没有调用图片服务" });
  vi.restoreAllMocks();
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const receipt = JSON.parse(row.result);
  expect(receipt).toMatchObject({
    state: "composing",
    localStorage: { state: "planned" },
  });
  expect(Object.keys(receipt.localStorage).sort()).toEqual([
    "assetId",
    "objectKey",
    "profileId",
    "state",
  ]);
  expect(
    (await readFile(join(root, receipt.localStorage.objectKey))).length,
  ).toBeGreaterThan(0);
  expect(
    await db
      .selectFrom("assets")
      .select("id")
      .where("id", "=", receipt.localStorage.assetId)
      .execute(),
  ).toEqual([]);
  expect(
    (await readRawImageCandidate(db, ctx, operationId, runtime())).data.length,
  ).toBeGreaterThan(0);
  expect(providerCalls).toBe(1);
});

const maskRect = (
  left: number,
  top: number,
  right: number,
  bottom: number,
) => ({
  label: "isolated mask fixture",
  points: [
    [left / 64, top / 96],
    [right / 64, top / 96],
    [right / 64, bottom / 96],
    [left / 64, bottom / 96],
  ] as [number, number][],
});
function maskInput(): ImageEditMaskInput {
  const hole = maskRect(22, 22, 26, 26);
  return {
    generationOperationId: operationId,
    referenceImageId: sourceId,
    sourceTarget: {
      proposalIds: [],
      include: [maskRect(10, 10, 35, 55), maskRect(5, 4, 8, 8)],
      exclude: [hole],
    },
    generatedTarget: {
      proposalIds: [],
      include: [maskRect(20, 8, 47, 58), maskRect(55, 4, 60, 8)],
      exclude: [hole, maskRect(43, 20, 45, 32), maskRect(40, 25, 43, 32)],
    },
    protected: {
      proposalIds: [],
      include: [maskRect(40, 20, 45, 32)],
      exclude: [],
    },
    allowedOcclusion: {
      proposalIds: [],
      include: [maskRect(40, 20, 43, 25)],
      exclude: [],
    },
    textEdits: {
      proposalIds: [],
      include: [maskRect(5, 82, 30, 88)],
      exclude: [],
    },
  };
}
async function prepareMask(value = maskInput()) {
  return prepareImageEditMask(db, ctx, value, randomUUID(), {
    storage: runtime(),
  });
}
const maskComposeInput = (maskReceiptId: string) => ({
  maskReceiptId,
  generationOperationId: operationId,
  referenceImageId: sourceId,
  filename: "mask-composed.png",
});
async function compositionState() {
  return {
    assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    operations: await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute(),
    files: await db
      .selectFrom("file_items")
      .selectAll()
      .orderBy("id")
      .execute(),
    objects: await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .orderBy("id")
      .execute(),
    usage: await usageSummary(db, owner.id),
  };
}
async function useVariableAlphaSource() {
  const pixels = Buffer.alloc(64 * 96 * 4);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 64; x++) {
      const p = (y * 64 + x) * 4;
      pixels[p] = (x * 3 + y) % 256;
      pixels[p + 1] = (y * 2 + x) % 256;
      pixels[p + 2] = (x + y * 3) % 256;
      pixels[p + 3] = 64 + ((x + y) % 192);
    }
  }
  source = await sharp(pixels, { raw: { width: 64, height: 96, channels: 4 } })
    .png()
    .toBuffer();
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", sourceId)
    .executeTakeFirstOrThrow();
  await writeFile(join(root, asset.object_key), source);
  await db
    .updateTable("assets")
    .set({ size: source.length })
    .where("id", "=", sourceId)
    .execute();
}

it("saves an exact mask with holes and disconnected targets, keeping every exterior/protected RGBA while preserving the entire allowed hand occlusion for free", async () => {
  await useVariableAlphaSource();
  const oldRegions = [maskRect(0, 0, 64, 96)];
  await generate(oldRegions);
  const receipt = await prepareMask(),
    mask = await readImageEditMask(db, ctx, receipt.receiptId, {
      storage: runtime(),
    }),
    before = await compositionState(),
    rawBefore = await readRawImageCandidate(db, ctx, operationId, runtime()),
    id = randomUUID();
  expect(receipt.diagnostics).toMatchObject({
    safeToCompose: true,
    semanticCoverage: "unverified",
  });
  expect(receipt.coverage).toMatchObject({
    allowedOcclusionPixels: 15,
    remainingProtectionPixels: 45,
  });
  const result = await recomposeImageMaskAsset(
    db,
    ctx,
    maskComposeInput(receipt.receiptId),
    id,
    { storage: runtime() },
  );
  const actual = await sharp(await assetBytes(result.assetId))
      .ensureAlpha()
      .raw()
      .toBuffer(),
    original = await sharp(source).ensureAlpha().raw().toBuffer(),
    generated = await sharp(mask.generatedCanvas)
      .ensureAlpha()
      .raw()
      .toBuffer(),
    editable = await sharp(mask.maskPNG).toColourspace("b-w").raw().toBuffer(),
    protectedPixels = await sharp(mask.protectionPNG!)
      .toColourspace("b-w")
      .raw()
      .toBuffer();
  let exteriorChanges = 0,
    protectedChanges = 0,
    changed = 0;
  for (let p = 0; p < 64 * 96; p++) {
    const originalPixel = original.subarray(p * 4, p * 4 + 4),
      actualPixel = actual.subarray(p * 4, p * 4 + 4);
    if (!actualPixel.equals(originalPixel)) changed++;
    if (editable[p] === 0 && !actualPixel.equals(originalPixel))
      exteriorChanges++;
    if (protectedPixels[p] === 255 && !actualPixel.equals(originalPixel))
      protectedChanges++;
    if (editable[p] === 255)
      expect(actualPixel).toEqual(generated.subarray(p * 4, p * 4 + 4));
  }
  expect({ exteriorChanges, protectedChanges }).toEqual({
    exteriorChanges: 0,
    protectedChanges: 0,
  });
  expect(changed).toBe(receipt.coverage.editablePixels);
  const pixel = (x: number, y: number) => (y * 64 + x) * 4;
  for (const [x, y] of [
    [23, 23],
    [44, 22],
    [41, 30],
  ] as const)
    expect(actual.subarray(pixel(x, y), pixel(x, y) + 4)).toEqual(
      original.subarray(pixel(x, y), pixel(x, y) + 4),
    );
  for (const [x, y] of [
    [6, 5],
    [57, 5],
    [46, 56],
    [10, 85],
  ] as const)
    expect(actual.subarray(pixel(x, y), pixel(x, y) + 4)).toEqual(
      generated.subarray(pixel(x, y), pixel(x, y) + 4),
    );
  // All 15 explicitly permitted hand/prop intersection pixels remain present.
  for (let y = 20; y < 25; y++)
    for (let x = 40; x < 43; x++)
      expect(actual.subarray(pixel(x, y), pixel(x, y) + 4)).toEqual(
        generated.subarray(pixel(x, y), pixel(x, y) + 4),
      );
  expect(result).toMatchObject({
    origin: "local-recomposition",
    generationOperationId: operationId,
    editMask: {
      version: 2,
      receiptId: receipt.receiptId,
      digest: receipt.digest,
      maskDigest: receipt.maskDigest,
    },
    preservation: { protectedPixelsChanged: 0 },
  });
  expect(result.generation).not.toHaveProperty("editRegions");
  const repeated = await recomposeImageMaskAsset(
    db,
    ctx,
    maskComposeInput(receipt.receiptId),
    id,
    { storage: runtime() },
  );
  expect(repeated.assetId).toBe(result.assetId);
  const after = await compositionState();
  expect(after.usage).toEqual(before.usage);
  expect(after.assets).toHaveLength(before.assets.length + 1);
  expect(after.operations).toHaveLength(before.operations.length + 1);
  for (const old of before.operations)
    expect(after.operations.find((row) => row.id === old.id)).toEqual(old);
  expect(
    JSON.parse(before.operations.find((row) => row.id === operationId)!.result)
      .generation.editRegions,
  ).toEqual(oldRegions);
  const rawAfter = await readRawImageCandidate(db, ctx, operationId, runtime());
  expect(rawAfter.data).toEqual(rawBefore.data);
  expect(rawAfter.candidate).toEqual(rawBefore.candidate);
  expect(providerCalls).toBe(1);
});

it("rejects a mask/protected-object conflict without silently clipping the new hand, reserving an operation, writing assets, or charging", async () => {
  await generate();
  const value = maskInput();
  value.generatedTarget.exclude = [maskRect(22, 22, 26, 26)];
  const receipt = await prepareMask(value);
  expect(receipt.diagnostics).toMatchObject({
    safeToCompose: false,
    protectionConflictPixels: 45,
  });
  const before = await compositionState(),
    store = storageModule.createStorage(runtime()),
    put = vi.spyOn(store, "put");
  vi.spyOn(storageModule, "createStorage").mockReturnValue(store);
  await expect(
    recomposeImageMaskAsset(
      db,
      ctx,
      maskComposeInput(receipt.receiptId),
      randomUUID(),
      { storage: runtime() },
    ),
  ).rejects.toThrow("保护区域");
  expect(put).not.toHaveBeenCalled();
  expect(await compositionState()).toEqual(before);
  expect(providerCalls).toBe(1);
});

it.each([
  "source-id",
  "generation-id",
  "receipt-id",
  "receipt-digest",
  "source-bytes",
  "raw-bytes",
] as const)(
  "rejects a mask with changed %s before saving or charging, keeping existing records",
  async (mode) => {
    await generate();
    const receipt = await prepareMask(),
      originalOperationId = operationId,
      value = maskComposeInput(receipt.receiptId);
    if (mode === "source-id") value.referenceImageId = randomUUID();
    if (mode === "generation-id") {
      operationId = randomUUID();
      await generate();
      value.generationOperationId = operationId;
    }
    if (mode === "receipt-id") value.maskReceiptId = randomUUID();
    if (mode === "receipt-digest") {
      await db
        .updateTable("ai_operations")
        .set({
          result: JSON.stringify({ ...receipt, maskDigest: "f".repeat(64) }),
        })
        .where("id", "=", receipt.receiptId)
        .execute();
    }
    if (mode === "source-bytes" || mode === "raw-bytes") {
      const raw = await readRawImageCandidate(
          db,
          ctx,
          originalOperationId,
          runtime(),
        ),
        id = mode === "source-bytes" ? sourceId : raw.candidate.assetId,
        asset = await db
          .selectFrom("assets")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
      const changed = await sharp({
        create: { width: 64, height: 96, channels: 4, background: "#3377aa" },
      })
        .png()
        .toBuffer();
      await writeFile(join(root, asset.object_key), changed);
    }
    const before = await compositionState(),
      store = storageModule.createStorage(runtime()),
      put = vi.spyOn(store, "put");
    vi.spyOn(storageModule, "createStorage").mockReturnValue(store);
    await expect(
      recomposeImageMaskAsset(db, ctx, value, randomUUID(), {
        storage: runtime(),
      }),
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
    expect(await compositionState()).toEqual(before);
    expect(providerCalls).toBe(mode === "generation-id" ? 2 : 1);
  },
);

it.each(["cancel", "lease-revoked"] as const)(
  "rolls back a free mask save when %s arrives after object write, preserving raw, mask receipt, and original charge",
  async (mode) => {
    await generate();
    const receipt = await prepareMask(),
      before = await compositionState(),
      raw = await readRawImageCandidate(db, ctx, operationId, runtime()),
      controller = new AbortController(),
      originalStorage = storageModule.createStorage;
    let writtenKey: string | undefined;
    vi.spyOn(storageModule, "createStorage").mockImplementation((value) => {
      const store = originalStorage(value);
      return {
        ...store,
        put: async (...args) => {
          await store.put(...args);
          writtenKey = args[1];
          if (mode === "cancel") controller.abort();
          else
            await db
              .updateTable("ai_jobs")
              .set({ lease: randomUUID() })
              .where("id", "=", ctx.jobId!)
              .execute();
        },
      };
    });
    const id = randomUUID();
    await expect(
      recomposeImageMaskAsset(
        db,
        ctx,
        maskComposeInput(receipt.receiptId),
        id,
        { storage: runtime(), signal: controller.signal },
      ),
    ).rejects.toThrow();
    const after = await compositionState();
    expect(after.assets).toEqual(before.assets);
    expect(after.files).toEqual(before.files);
    expect(after.objects).toEqual(before.objects);
    expect(after.usage).toEqual(before.usage);
    for (const old of before.operations)
      expect(after.operations.find((row) => row.id === old.id)).toEqual(old);
    const failed = JSON.parse(
      after.operations.find((row) => row.id === id)!.result,
    );
    expect(failed).toMatchObject({
      state: "save_failed",
      editMask: { receiptId: receipt.receiptId, digest: receipt.digest },
      localStorage: { cleanup: "removed" },
    });
    expect(writtenKey).toBeTypeOf("string");
    await expect(readFile(join(root, writtenKey!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await assetBytes(raw.candidate.assetId)).toEqual(raw.data);
    expect(providerCalls).toBe(1);
  },
);

it("rolls back a mask result when cancellation follows its final projection enqueue", async () => {
  await generate();
  const receipt = await prepareMask(),
    before = await compositionState(),
    controller = new AbortController(),
    enqueue = automation.enqueueProjection;
  vi.spyOn(automation, "enqueueProjection").mockImplementation(
    async (...args) => {
      await enqueue(...args);
      controller.abort();
    },
  );
  const id = randomUUID();
  await expect(
    recomposeImageMaskAsset(db, ctx, maskComposeInput(receipt.receiptId), id, {
      storage: runtime(),
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  const after = await compositionState();
  expect(after.assets).toEqual(before.assets);
  expect(after.files).toEqual(before.files);
  expect(after.objects).toEqual(before.objects);
  expect(after.usage).toEqual(before.usage);
  expect(
    JSON.parse(after.operations.find((row) => row.id === id)!.result),
  ).toMatchObject({
    state: "save_failed",
    localStorage: { cleanup: "removed" },
  });
  expect(providerCalls).toBe(1);
});

it("composes five real signed binary proposals with exact holes, independent components and complete authorized hand occlusion, then rejects revoked proposal bytes even on idempotent replay", async () => {
  await useVariableAlphaSource();
  await generate([maskRect(0, 0, 64, 96)]);
  const profile = await fixtureSegmentationProfile(root),
    binary = () => Buffer.alloc(64 * 96),
    s = binary(),
    g = binary(),
    p = binary(),
    o = binary(),
    t = binary();
  const fill = (
    target: Buffer,
    l: number,
    top: number,
    r: number,
    b: number,
    value = 255,
  ) => {
    for (let y = top; y < b; y++)
      for (let x = l; x < r; x++) target[y * 64 + x] = value;
  };
  fill(s, 10, 10, 35, 55);
  fill(s, 5, 4, 8, 8);
  fill(s, 22, 22, 26, 26, 0);
  fill(g, 20, 8, 47, 58);
  fill(g, 55, 4, 60, 8);
  fill(g, 22, 22, 26, 26, 0);
  fill(g, 43, 20, 45, 32, 0);
  fill(g, 40, 25, 43, 32, 0);
  fill(p, 40, 20, 45, 32);
  fill(o, 40, 20, 43, 25);
  fill(t, 5, 82, 30, 88);
  const propose = async (
    source: ImageMaskSegmentInput["source"],
    pixels: Buffer,
    positive: [number, number],
  ) =>
    prepareImageMaskSegment(
      db,
      ctx,
      {
        source,
        targets: [
          {
            label: "binary target",
            box: [0, 0, 1, 1],
            positivePoints: [positive],
            negativePoints: [[0, 0]],
          },
        ],
        exclusions: [],
      },
      randomUUID(),
      {
        storage: runtime(),
        profile,
        worker: fixtureSegmentationWorker(pixels),
      },
    );
  const sourceProposal = await propose(
      { kind: "reference", referenceImageId: sourceId },
      s,
      [11 / 64, 11 / 96],
    ),
    generatedProposal = await propose(
      { kind: "raw", generationOperationId: operationId },
      g,
      [21 / 64, 11 / 96],
    ),
    protectionProposal = await propose(
      { kind: "reference", referenceImageId: sourceId },
      p,
      [41 / 64, 21 / 96],
    ),
    occlusionProposal = await propose(
      { kind: "raw", generationOperationId: operationId },
      o,
      [41 / 64, 21 / 96],
    ),
    textProposal = await propose(
      { kind: "reference", referenceImageId: sourceId },
      t,
      [6 / 64, 83 / 96],
    );
  for (const proposal of [
    sourceProposal,
    generatedProposal,
    protectionProposal,
    occlusionProposal,
    textProposal,
  ])
    expect(proposal.usable).toBe(true);
  const value: ImageEditMaskInput = {
    generationOperationId: operationId,
    referenceImageId: sourceId,
    sourceTarget: {
      proposalIds: [sourceProposal.receiptId],
      include: [],
      exclude: [],
    },
    generatedTarget: {
      proposalIds: [generatedProposal.receiptId],
      include: [],
      exclude: [],
    },
    protected: {
      proposalIds: [protectionProposal.receiptId],
      include: [],
      exclude: [],
    },
    allowedOcclusion: {
      proposalIds: [occlusionProposal.receiptId],
      include: [],
      exclude: [],
    },
    textEdits: {
      proposalIds: [textProposal.receiptId],
      include: [],
      exclude: [],
    },
  };
  const mask = await prepareMask(value),
    before = await compositionState(),
    localId = randomUUID(),
    loaded = await readImageEditMask(db, ctx, mask.receiptId, {
      storage: runtime(),
    }),
    result = await recomposeImageMaskAsset(
      db,
      ctx,
      maskComposeInput(mask.receiptId),
      localId,
      { storage: runtime() },
    );
  expect(mask.version).toBe(2);
  expect(mask.proposalBindings).toHaveLength(5);
  expect(mask.coverage).toMatchObject({
    allowedOcclusionPixels: 15,
    remainingProtectionPixels: 45,
  });
  const original = await sharp(source).ensureAlpha().raw().toBuffer(),
    actual = await sharp(await assetBytes(result.assetId))
      .ensureAlpha()
      .raw()
      .toBuffer(),
    generated = await sharp(loaded.generatedCanvas)
      .ensureAlpha()
      .raw()
      .toBuffer();
  let outsideChanges = 0,
    protectedChanges = 0,
    missingOcclusion = 0;
  for (let i = 0; i < s.length; i++) {
    const editable = s[i] === 255 || g[i] === 255 || t[i] === 255,
      remaining = p[i] === 255 && o[i] === 0,
      actualPixel = actual.subarray(i * 4, i * 4 + 4),
      originalPixel = original.subarray(i * 4, i * 4 + 4);
    if (!editable && !actualPixel.equals(originalPixel)) outsideChanges++;
    if (remaining && !actualPixel.equals(originalPixel)) protectedChanges++;
    if (editable)
      expect(actualPixel).toEqual(generated.subarray(i * 4, i * 4 + 4));
    if (
      o[i] === 255 &&
      !actualPixel.equals(generated.subarray(i * 4, i * 4 + 4))
    )
      missingOcclusion++;
  }
  expect({ outsideChanges, protectedChanges, missingOcclusion }).toEqual({
    outsideChanges: 0,
    protectedChanges: 0,
    missingOcclusion: 0,
  });
  expect(actual.subarray((23 * 64 + 23) * 4, (23 * 64 + 23) * 4 + 4)).toEqual(
    original.subarray((23 * 64 + 23) * 4, (23 * 64 + 23) * 4 + 4),
  );
  expect(actual.subarray((5 * 64 + 6) * 4, (5 * 64 + 6) * 4 + 4)).toEqual(
    generated.subarray((5 * 64 + 6) * 4, (5 * 64 + 6) * 4 + 4),
  );
  const repeated = await recomposeImageMaskAsset(
    db,
    ctx,
    maskComposeInput(mask.receiptId),
    localId,
    { storage: runtime() },
  );
  expect(repeated.assetId).toBe(result.assetId);
  expect((await compositionState()).usage).toEqual(before.usage);
  expect(providerCalls).toBe(1);
  const artifact = sourceProposal.artifacts.find(
    (a) => a.role === "selection",
  )!;
  await db
    .updateTable("assets")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", artifact.assetId)
    .execute();
  const revoked = await compositionState();
  await expect(
    recomposeImageMaskAsset(
      db,
      ctx,
      maskComposeInput(mask.receiptId),
      localId,
      { storage: runtime() },
    ),
  ).rejects.toThrow();
  expect(await compositionState()).toEqual(revoked);
});
