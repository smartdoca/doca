import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiConfig, aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import {
  readRawImageCandidate,
  availableImageReferences,
} from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  rawImageCandidateCanvas,
  rawImageCandidateReceiptId,
  rawImageCandidateSchema,
} from "../apps/server/src/services/ai/image-candidates.js";
import * as storageModule from "../apps/server/src/adapters/storage.js";
import * as storedObjects from "../apps/server/src/services/stored-objects.js";
import * as policy from "@core/modules/access/operation-policy.js";
import * as candidates from "../apps/server/src/services/ai/image-candidates.js";
import * as transactions from "@db/transactions.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  other: Actor,
  ctx: ToolContext,
  session: string;
const prompt = "修改人物，保留未编辑的内容";
const usage = {
  input_tokens: 12,
  output_tokens: 30,
  input_images: 1,
  output_images: 1,
  output_tokens_details: { reasoning_tokens: 4 },
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const runtime = () => ({ ...storageModule.storageRuntime(), root });

beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-image-candidate-"));
  owner = {
    ...(await createUser(
      db,
      { login: "raw-owner", displayName: "Owner", password: "raw-test-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      { login: "raw-other", displayName: "Other", password: "raw-test-2026" },
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
          id: "image-vendor",
          name: "Image",
          provider: "openai",
          baseUrl: "https://images.invalid/v1",
          apiKey: "isolated-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "image",
          vendorId: "image-vendor",
          model: "gpt-image-test",
          alias: "Image",
          enabled: true,
          tools: false,
          maxInput: 32000,
          maxOutput: 1000,
          imageGeneration: true,
          imageProfile: "gpt-image-2",
          imageRate: 250,
        },
      ],
    },
    0,
  );
  session = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id: session,
      user_id: owner.id,
      title: "Raw",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  ctx = await job(session);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

async function job(sessionId: string) {
  const now = new Date().toISOString(),
    id = randomUUID(),
    lease = randomUUID();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      session_id: sessionId,
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
  return { actor: owner, jobId: id, lease } as ToolContext;
}
async function png(width = 80, height = 120, color = "#527923") {
  return sharp({ create: { width, height, channels: 4, background: color } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}
async function reference(input?: Buffer) {
  const data = input ?? (await png());
  const id = randomUUID(),
    profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow();
  const key = objectKey(id, "image/png");
  await storageModule
    .createStorage(runtime())
    .put(
      storageModule.storageConfigForProfile(runtime(), profile),
      key,
      data,
      "image/png",
      "source.png",
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
      filename: "source.png",
      mime: "image/png",
      size: data.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  await db
    .updateTable("ai_jobs")
    .set({ input: JSON.stringify({ attachments: [id] }) })
    .where("id", "=", ctx.jobId!)
    .execute();
  return { id, data, key };
}
function response(data: Buffer, nativeUsage: unknown = usage) {
  return Response.json({
    data: [{ b64_json: data.toString("base64") }],
    ...(nativeUsage === undefined ? {} : { usage: nativeUsage }),
  });
}
async function generation(operationId: string) {
  return JSON.parse(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", operationId)
        .executeTakeFirstOrThrow()
    ).result,
  );
}
async function rawReceipt(operationId: string) {
  return generation(rawImageCandidateReceiptId(operationId));
}
function interceptStorage(
  put: (
    original: ReturnType<typeof storageModule.createStorage>,
    args: Parameters<ReturnType<typeof storageModule.createStorage>["put"]>,
    count: number,
  ) => Promise<void>,
  remove?: () => Promise<void>,
) {
  const original = storageModule.createStorage;
  let count = 0;
  vi.spyOn(storageModule, "createStorage").mockImplementation((value) => {
    const storage = original(value);
    return {
      ...storage,
      put: async (...args) => put(storage, args, ++count),
      ...(remove ? { remove } : {}),
    };
  });
}

function interceptRawCleanupCAS(
  operationId: string,
  execute: (commit: () => Promise<unknown>) => Promise<unknown>,
) {
  const update = db.updateTable.bind(db);
  let intercepted = false;
  function wrap<T extends object>(query: T): T {
    return new Proxy(query, {
      get(target, property) {
        if (property === "executeTakeFirst")
          return async () => {
            const builder = target as unknown as {
              compile(): { parameters: readonly unknown[] };
              executeTakeFirst(): Promise<unknown>;
            };
            const compiled = builder.compile();
            const commit = () => builder.executeTakeFirst();
            if (
              !intercepted &&
              compiled.parameters.includes(
                rawImageCandidateReceiptId(operationId),
              )
            ) {
              intercepted = true;
              return execute(commit);
            }
            return commit();
          };
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...values: unknown[]) => {
          const next = Reflect.apply(value, target, values);
          return next && typeof next === "object" && "executeTakeFirst" in next
            ? wrap(next)
            : next;
        };
      },
    });
  }
  vi.spyOn(db, "updateTable").mockImplementation(((
    ...args: Parameters<typeof update>
  ) =>
    args[0] === "ai_operations"
      ? wrap(update(...args))
      : update(...args)) as typeof db.updateTable);
}

function blockOperationConfirmations() {
  const select = db.selectFrom.bind(db);
  function wrap<T extends object>(query: T): T {
    return new Proxy(query, {
      get(target, property) {
        if (property === "executeTakeFirst")
          return async () => {
            throw Error("Raw confirmation unavailable");
          };
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...values: unknown[]) => {
          const next = Reflect.apply(value, target, values);
          return next && typeof next === "object" && "executeTakeFirst" in next
            ? wrap(next)
            : next;
        };
      },
    });
  }
  vi.spyOn(db, "selectFrom").mockImplementation(((
    ...args: Parameters<typeof select>
  ) =>
    args[0] === "ai_operations"
      ? wrap(select(...args))
      : select(...args)) as typeof db.selectFrom);
}

it.each(["png", "jpeg"] as const)(
  "retains exact provider %s bytes and native usage separately from delivery, and admits raw storage bytes",
  async (format) => {
    const source = await reference();
    const bytes =
      format === "png"
        ? await png(32, 24, "#dd7432")
        : await sharp(await png(32, 24, "#dd7432"))
            .jpeg()
            .toBuffer();
    const admission = vi.spyOn(policy, "checkStorage");
    const id = randomUUID();
    let calls = 0;
    const result = await generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      {
        storage: runtime(),
        fetch: (async () => {
          calls++;
          return response(bytes);
        }) as typeof fetch,
      },
    );
    const saved = await readRawImageCandidate(db, ctx, id, runtime());
    expect(calls).toBe(1);
    expect(saved.data).toEqual(bytes);
    expect(saved.candidate).toMatchObject({
      kind: "image_raw_candidate",
      version: 1,
      origin: "provider",
      state: "saved",
      generationOperationId: id,
      providerCallId: result.providerCallId,
      sha256: sha(bytes),
      dimensions: { width: 32, height: 24 },
      references: [
        {
          referenceImageId: source.id,
          sha256: sha(source.data),
          width: 80,
          height: 120,
        },
      ],
      nativeUsage: { state: "reported", value: usage },
      transform: { kind: "full" },
    });
    expect(rawImageCandidateSchema.safeParse(saved.candidate).success).toBe(
      true,
    );
    expect(result.rawCandidate).toMatchObject({
      version: 1,
      receiptId: saved.receiptId,
      assetId: saved.candidate.assetId,
      sha256: sha(bytes),
    });
    expect(result.assetId).not.toBe(saved.candidate.assetId);
    expect(result.generationOperationId).toBe(id);
    expect(
      (await availableImageReferences(db, ctx)).map((value) => value.id).sort(),
    ).toEqual([source.id, result.assetId].sort());
    expect(
      await db.selectFrom("file_items").select("storage_object_id").execute(),
    ).toEqual([{ storage_object_id: result.assetId }]);
    expect(admission.mock.calls.some((args) => args[2] === bytes.length)).toBe(
      true,
    );
    expect(
      (await usageSummary(db, owner.id)).calls.filter(
        (call) => call.callKind === "image",
      ),
    ).toEqual([
      expect.objectContaining({
        id: result.providerCallId,
        images: 1,
        state: "confirmed",
      }),
    ]);
  },
);

it("records exact viewport and padding and projects the retained candidate without another image call", async () => {
  const source = await reference();
  const pixels = Buffer.alloc(80 * 80 * 4);
  for (let index = 0; index < 80 * 80; index++) {
    pixels[index * 4] = index % 80;
    pixels[index * 4 + 1] = Math.floor(index / 80);
    pixels[index * 4 + 2] = 200;
    pixels[index * 4 + 3] = 255;
  }
  const bytes = await sharp(pixels, {
    raw: { width: 80, height: 80, channels: 4 },
  })
    .png()
    .toBuffer();
  const id = randomUUID();
  await generateImageAsset(
    db,
    ctx,
    {
      prompt,
      referenceImageIds: [source.id],
      editRegions: [
        {
          label: "target",
          points: [
            [0.4, 0.3],
            [0.6, 0.3],
            [0.6, 0.7],
            [0.4, 0.7],
          ],
        },
      ],
    },
    id,
    {
      storage: runtime(),
      fetch: (async () => response(bytes)) as typeof fetch,
    },
  );
  const saved = await readRawImageCandidate(db, ctx, id, runtime());
  expect(saved.candidate.transform).toEqual({
    kind: "viewport",
    rect: { left: 16, top: 20, width: 48, height: 80 },
    workspace: {
      width: 80,
      height: 80,
      left: 16,
      top: 0,
      contentWidth: 48,
      contentHeight: 80,
    },
  });
  expect(saved.candidate.request.transportDimensions).toEqual([
    { width: 80, height: 80 },
  ]);
  const canvas = await rawImageCandidateCanvas(
    saved.candidate,
    saved.data,
    saved.sources[0]!.data,
  );
  const composed = await sharp(canvas).ensureAlpha().raw().toBuffer(),
    original = await sharp(source.data).ensureAlpha().raw().toBuffer();
  expect([
    ...composed.subarray((20 * 80 + 16) * 4, (20 * 80 + 16) * 4 + 4),
  ]).toEqual([16, 0, 200, 255]);
  expect([
    ...composed.subarray((99 * 80 + 63) * 4, (99 * 80 + 63) * 4 + 4),
  ]).toEqual([63, 79, 200, 255]);
  expect(composed.subarray(0, 4)).toEqual(original.subarray(0, 4));
  expect(
    (await usageSummary(db, owner.id)).calls.filter(
      (call) => call.callKind === "image",
    ),
  ).toHaveLength(1);
});

it.each(["rgba", "grayscale"])(
  "projects transparent viewport pixels by replacement on %s sources and preserves original pixels outside",
  async (format) => {
    const sourcePixels = await png();
    const source = await reference(
        format === "grayscale"
          ? await sharp(sourcePixels).toColourspace("b-w").png().toBuffer()
          : sourcePixels,
      ),
      id = randomUUID(),
      bytes = await sharp({
        create: {
          width: 80,
          height: 80,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
    await generateImageAsset(
      db,
      ctx,
      {
        prompt,
        size: "1024x1024",
        referenceImageIds: [source.id],
        editRegions: [
          {
            label: "target",
            points: [
              [0.4, 0.3],
              [0.6, 0.3],
              [0.6, 0.7],
              [0.4, 0.7],
            ],
          },
        ],
      },
      id,
      {
        storage: runtime(),
        fetch: (async () => response(bytes)) as typeof fetch,
      },
    );
    const raw = await readRawImageCandidate(db, ctx, id, runtime());
    const canvas = await rawImageCandidateCanvas(
      raw.candidate,
      raw.data,
      source.data,
    );
    const pixels = await sharp(canvas).ensureAlpha().raw().toBuffer();
    const original = await sharp(source.data)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(pixels.subarray((20 * 80 + 16) * 4, (20 * 80 + 16) * 4 + 4)).toEqual(
      Buffer.from([0, 0, 0, 0]),
    );
    expect(pixels.subarray(0, 16 * 4)).toEqual(original.subarray(0, 16 * 4));
    expect(pixels.subarray(100 * 80 * 4)).toEqual(
      original.subarray(100 * 80 * 4),
    );
    expect((await usageSummary(db, owner.id)).calls).toHaveLength(1);
  },
);

it("keeps a committed raw candidate and its facts when final storage fails, and blocks paid duplicates", async () => {
  const source = await reference(),
    bytes = await png(32, 24),
    id = randomUUID();
  let imageCalls = 0;
  interceptStorage(async (storage, args, count) => {
    if (count === 2) throw Error("Final write failed");
    await storage.put(...args);
  });
  const options = {
    storage: runtime(),
    fetch: (async () => {
      imageCalls++;
      return response(bytes);
    }) as typeof fetch,
  };
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      options,
    ),
  ).rejects.toThrow("图片保存失败");
  const saved = await readRawImageCandidate(db, ctx, id, runtime());
  expect(saved.data).toEqual(bytes);
  expect((await generation(id)).generationOperationId).toBe(id);
  expect(await generation(id)).toMatchObject({
    state: "save_failed",
    rawCandidate: { assetId: saved.candidate.assetId },
    providerCallId: saved.candidate.providerCallId,
  });
  expect(
    await db
      .selectFrom("assets")
      .select("purpose")
      .where("id", "!=", source.id)
      .execute(),
  ).toEqual([{ purpose: "ai_image_candidate" }]);
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      options,
    ),
  ).rejects.toThrow("原始候选已保留");
  const next = await job(session);
  await expect(
    generateImageAsset(
      db,
      next,
      { prompt, referenceImageIds: [source.id] },
      randomUUID(),
      { ...options, relatedJobIds: [ctx.jobId!, next.jobId!] },
    ),
  ).rejects.toThrow("不能重复提交");
  expect(imageCalls).toBe(1);
});

it("preserves a raw pointer committed before its save response is lost", async () => {
  const source = await reference(),
    bytes = await png(32, 24),
    id = randomUUID();
  const save = candidates.saveRawImageCandidate;
  vi.spyOn(candidates, "saveRawImageCandidate").mockImplementation(
    async (...args) => {
      await save(...args);
      throw new Error("Lost raw save confirmation");
    },
  );
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      {
        storage: runtime(),
        fetch: (async () => response(bytes)) as typeof fetch,
      },
    ),
  ).rejects.toThrow(`生成操作 ID：${id}`);
  const recorded = await generation(id),
    raw = await readRawImageCandidate(db, ctx, id, runtime());
  expect(recorded).toMatchObject({
    state: "save_failed",
    generationOperationId: id,
    rawCandidate: {
      version: 1,
      receiptId: raw.receiptId,
      assetId: raw.candidate.assetId,
      sha256: sha(bytes),
    },
  });
  expect(raw.data).toEqual(bytes);
  expect(await db.selectFrom("file_items").select("id").execute()).toEqual([]);
  expect((await usageSummary(db, owner.id)).calls).toEqual([
    expect.objectContaining({ images: 1, state: "confirmed" }),
  ]);
});

it("rolls back only the uncommitted final asset when its transaction fails", async () => {
  const source = await reference(),
    bytes = await png(32, 24),
    id = randomUUID();
  const register = storedObjects.registerStoredObject;
  let count = 0;
  vi.spyOn(storedObjects, "registerStoredObject").mockImplementation(
    async (tx, object) => {
      await register(tx, object);
      if (++count === 2) throw Error("Final transaction failed");
    },
  );
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      {
        storage: runtime(),
        fetch: (async () => response(bytes)) as typeof fetch,
      },
    ),
  ).rejects.toThrow("图片保存失败");
  const saved = await readRawImageCandidate(db, ctx, id, runtime());
  expect(saved.data).toEqual(bytes);
  expect(
    await db.selectFrom("file_storage_objects").select("id").execute(),
  ).toEqual([{ id: saved.candidate.assetId }]);
  expect(await db.selectFrom("file_items").select("id").execute()).toHaveLength(
    0,
  );
  expect((await usageSummary(db, owner.id)).calls[0]).toMatchObject({
    images: 1,
    state: "confirmed",
  });
});

it.each(["removed", "uncertain"] as const)(
  "records raw transaction rollback with %s external cleanup without inventing saved assets",
  async (cleanup) => {
    const source = await reference(),
      bytes = await png(32, 24),
      id = randomUUID();
    const register = storedObjects.registerStoredObject;
    vi.spyOn(storedObjects, "registerStoredObject").mockImplementation(
      async (tx, object) => {
        await register(tx, object);
        throw Error("Raw transaction failed");
      },
    );
    if (cleanup === "uncertain")
      interceptStorage(
        async (storage, args) => storage.put(...args),
        async () => {
          throw Error("Cleanup unavailable");
        },
      );
    await expect(
      generateImageAsset(
        db,
        ctx,
        { prompt, referenceImageIds: [source.id] },
        id,
        {
          storage: runtime(),
          fetch: (async () => response(bytes)) as typeof fetch,
        },
      ),
    ).rejects.toThrow("图片保存失败");
    const failed = await rawReceipt(id);
    expect(failed).toMatchObject({
      state: "save_failed",
      version: 1,
      sha256: sha(bytes),
      nativeUsage: { state: "reported", value: usage },
      failure: { stage: "commit", cleanup },
    });
    expect(await db.selectFrom("assets").select("id").execute()).toEqual([
      { id: source.id },
    ]);
    expect(
      await db.selectFrom("file_storage_objects").select("id").execute(),
    ).toHaveLength(0);
    if (cleanup === "uncertain")
      expect(await readFile(join(root, failed.objectKey))).toEqual(bytes);
    else
      await expect(
        readFile(join(root, failed.objectKey)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readRawImageCandidate(db, ctx, id, runtime())).rejects.toThrow(
      "没有确认保存",
    );
    expect((await usageSummary(db, owner.id)).calls[0]).toMatchObject({
      images: 1,
      state: "confirmed",
    });
  },
);

it.each(["readable", "unavailable"] as const)(
  "never deletes committed raw pixels after a lost commit acknowledgement when confirmation is %s",
  async (confirmation) => {
    const source = await reference(),
      bytes = await png(32, 24),
      id = randomUUID();
    const run = transactions.transact;
    const select = db.selectFrom.bind(db);
    let injected = false,
      calls = 0;
    const remove = vi.fn(async () => {
      throw Error("Committed raw must not be deleted");
    });
    interceptStorage(async (storage, args) => storage.put(...args), remove);
    vi.spyOn(transactions, "transact").mockImplementation((async (
      ...args: Parameters<typeof run>
    ) => {
      const result = await run(...args);
      const row = await select("ai_operations")
        .select("result")
        .where("id", "=", rawImageCandidateReceiptId(id))
        .executeTakeFirst();
      if (!injected && row && JSON.parse(row.result).state === "saved") {
        injected = true;
        if (confirmation === "unavailable") blockOperationConfirmations();
        throw Error("Lost raw commit acknowledgement");
      }
      return result;
    }) as typeof run);
    const options = {
      storage: runtime(),
      fetch: (async () => {
        calls++;
        return response(bytes);
      }) as typeof fetch,
    };
    const request = generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      options,
    );
    if (confirmation === "readable")
      await expect(request).resolves.toMatchObject({ state: "saved" });
    else await expect(request).rejects.toThrow("图片保存失败");
    expect(injected).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const raw = await readRawImageCandidate(db, ctx, id, runtime());
    expect(raw.data).toEqual(bytes);
    expect(await generation(id)).toMatchObject({
      rawCandidate: { assetId: raw.candidate.assetId },
    });
    expect(calls).toBe(1);
    expect((await usageSummary(db, owner.id)).calls).toEqual([
      expect.objectContaining({ images: 1, state: "confirmed" }),
    ]);
  },
);

it("does not delete or overwrite raw committed between failure observation and cleanup CAS", async () => {
  const source = await reference(),
    bytes = await png(32, 24),
    id = randomUUID();
  const register = storedObjects.registerStoredObject;
  let registrations = 0,
    calls = 0;
  vi.spyOn(storedObjects, "registerStoredObject").mockImplementation(
    async (...args) => {
      await register(...args);
      if (++registrations === 1) throw Error("Raw commit response uncertain");
    },
  );
  const remove = vi.fn(async () => {
    throw Error("Committed raw must not be deleted");
  });
  interceptStorage(async (storage, args) => storage.put(...args), remove);
  interceptRawCleanupCAS(id, async (commit) => {
    // Emulate the other writer's coherent commit after our SELECT saw storing.
    const pending = await rawReceipt(id);
    const saved = rawImageCandidateSchema.parse({ ...pending, state: "saved" });
    const now = new Date().toISOString();
    await db
      .insertInto("assets")
      .values({
        id: saved.assetId,
        owner_id: owner.id,
        uploaded_by: owner.id,
        resource_id: null,
        purpose: "ai_image_candidate",
        profile_id: saved.profileId,
        object_key: saved.objectKey,
        filename: `raw-${saved.assetId}.png`,
        mime: saved.mime,
        size: saved.size,
        created_at: now,
        deleted_at: null,
      })
      .execute();
    await register(db, {
      id: saved.assetId,
      profile_id: saved.profileId,
      object_key: saved.objectKey,
      sha256: saved.sha256,
      size: saved.size,
      mime: saved.mime,
      ai_description: "AI 原始候选（非交付结果）",
      ai_status: "skipped",
      ai_model: null,
      ai_generated_at: now,
      created_at: now,
    });
    await db
      .updateTable("ai_operations")
      .set({ result: JSON.stringify(saved) })
      .where("id", "=", rawImageCandidateReceiptId(id))
      .execute();
    const original = await generation(id);
    await db
      .updateTable("ai_operations")
      .set({
        result: JSON.stringify({
          ...original,
          rawCandidate: {
            version: 1,
            receiptId: rawImageCandidateReceiptId(id),
            assetId: saved.assetId,
            sha256: saved.sha256,
          },
        }),
      })
      .where("id", "=", id)
      .execute();
    return commit();
  });
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      {
        storage: runtime(),
        fetch: (async () => {
          calls++;
          return response(bytes);
        }) as typeof fetch,
      },
    ),
  ).resolves.toMatchObject({ state: "saved" });
  expect(remove).not.toHaveBeenCalled();
  expect(await rawReceipt(id)).toMatchObject({
    state: "saved",
    sha256: sha(bytes),
  });
  expect((await readRawImageCandidate(db, ctx, id, runtime())).data).toEqual(
    bytes,
  );
  expect(calls).toBe(1);
});

it.each(["unavailable", "lost-ack"] as const)(
  "retains a credential-free raw locator and pixels when cleanup CAS acknowledgement is %s",
  async (confirmation) => {
    const source = await reference(),
      bytes = await png(32, 24),
      id = randomUUID();
    const register = storedObjects.registerStoredObject;
    vi.spyOn(storedObjects, "registerStoredObject").mockImplementation(
      async (...args) => {
        await register(...args);
        throw Error("Raw transaction rolled back");
      },
    );
    const remove = vi.fn(async () => {
      throw Error("Unconfirmed state must not delete raw");
    });
    interceptStorage(async (storage, args) => storage.put(...args), remove);
    interceptRawCleanupCAS(id, async (commit) => {
      if (confirmation === "lost-ack") await commit();
      throw Error("Cleanup CAS acknowledgement unavailable");
    });
    let calls = 0;
    const input = { prompt, referenceImageIds: [source.id] };
    const options = {
      storage: runtime(),
      fetch: (async () => {
        calls++;
        return response(bytes);
      }) as typeof fetch,
    };
    await expect(
      generateImageAsset(db, ctx, input, id, options),
    ).rejects.toThrow("图片保存失败");
    expect(remove).not.toHaveBeenCalled();
    const retained = await rawReceipt(id);
    expect(retained).toMatchObject({
      state: confirmation === "lost-ack" ? "save_failed" : "storing",
      objectKey: expect.any(String),
      profileId: expect.any(String),
      sha256: sha(bytes),
      ...(confirmation === "lost-ack"
        ? { failure: { stage: "commit", cleanup: "uncertain" } }
        : {}),
    });
    expect(await readFile(join(root, retained.objectKey))).toEqual(bytes);
    const serialized = JSON.stringify(retained);
    for (const secret of ["apiKey", "Authorization", "isolated-only"])
      expect(serialized).not.toContain(secret);
    await expect(
      generateImageAsset(db, ctx, input, id, options),
    ).rejects.toThrow(/重复计费生成/);
    expect(calls).toBe(1);
    expect((await usageSummary(db, owner.id)).calls).toEqual([
      expect.objectContaining({ images: 1, state: "confirmed" }),
    ]);
  },
);

it.each(["before-raw-commit", "after-raw-commit"] as const)(
  "honors cancellation %s without losing confirmed image usage or committed raw",
  async (phase) => {
    const source = await reference(),
      bytes = await png(32, 24),
      id = randomUUID(),
      controller = new AbortController();
    interceptStorage(async (storage, args, count) => {
      await storage.put(...args);
      if (count === (phase === "before-raw-commit" ? 1 : 2)) {
        await db
          .updateTable("ai_jobs")
          .set({ cancelled: 1 })
          .where("id", "=", ctx.jobId!)
          .execute();
        controller.abort();
      }
    });
    await expect(
      generateImageAsset(
        db,
        ctx,
        { prompt, referenceImageIds: [source.id] },
        id,
        {
          storage: runtime(),
          signal: controller.signal,
          fetch: (async () => response(bytes)) as typeof fetch,
        },
      ),
    ).rejects.toThrow();
    const raw = await rawReceipt(id);
    expect(raw.state).toBe(
      phase === "before-raw-commit" ? "save_failed" : "saved",
    );
    expect(
      await db
        .selectFrom("assets")
        .select("purpose")
        .where("id", "!=", source.id)
        .execute(),
    ).toEqual(
      phase === "before-raw-commit" ? [] : [{ purpose: "ai_image_candidate" }],
    );
    if (phase === "after-raw-commit")
      expect(
        (await readRawImageCandidate(db, await job(session), id, runtime()))
          .data,
      ).toEqual(bytes);
    expect((await usageSummary(db, owner.id)).calls[0]).toMatchObject({
      images: 1,
      state: "confirmed",
    });
  },
);

it("rechecks revoked source access at raw commit and never publishes an unauthorized candidate", async () => {
  const source = await reference(),
    bytes = await png(32, 24),
    id = randomUUID();
  interceptStorage(async (storage, args) => {
    await storage.put(...args);
    await db
      .updateTable("assets")
      .set({ deleted_at: new Date().toISOString() })
      .where("id", "=", source.id)
      .execute();
  });
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [source.id] },
      id,
      {
        storage: runtime(),
        fetch: (async () => response(bytes)) as typeof fetch,
      },
    ),
  ).rejects.toThrow("参考图片不存在");
  expect(await db.selectFrom("assets").select("id").execute()).toEqual([
    { id: source.id },
  ]);
  expect(await rawReceipt(id)).toMatchObject({
    state: "save_failed",
    failure: { stage: "commit", cleanup: "removed" },
  });
  expect((await usageSummary(db, owner.id)).calls[0]).toMatchObject({
    images: 1,
    state: "confirmed",
  });
});

it("rejects another owner/session, deleted sources and same-size source-byte replacement on raw reads", async () => {
  const source = await reference(),
    id = randomUUID();
  await generateImageAsset(
    db,
    ctx,
    { prompt, referenceImageIds: [source.id] },
    id,
    {
      storage: runtime(),
      fetch: (async () => response(await png(32, 24))) as typeof fetch,
    },
  );
  await expect(
    readRawImageCandidate(db, { actor: other }, id, runtime()),
  ).rejects.toThrow("没有持久原始候选");
  const otherSession = randomUUID();
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  await expect(
    readRawImageCandidate(db, await job(otherSession), id, runtime()),
  ).rejects.toThrow("不属于当前会话");
  await db
    .updateTable("assets")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", source.id)
    .execute();
  await expect(readRawImageCandidate(db, ctx, id, runtime())).rejects.toThrow(
    "参考图片不存在",
  );
  await db
    .updateTable("assets")
    .set({ deleted_at: null })
    .where("id", "=", source.id)
    .execute();
  const changed = await png(80, 120, "#837354");
  expect(changed.length).toBe(source.data.length);
  await writeFile(join(root, source.key), changed);
  await expect(readRawImageCandidate(db, ctx, id, runtime())).rejects.toThrow(
    "来源字节已改变",
  );
});

it("exports the original without storing raw or an image call", async () => {
  const source = await reference(),
    id = randomUUID();
  const result = await generateImageAsset(
    db,
    ctx,
    { prompt, referenceImageIds: [source.id] },
    id,
    {
      storage: runtime(),
      exportOnly: true,
      fetch: (async () => {
        throw Error("No provider for export");
      }) as typeof fetch,
    },
  );
  expect(result.origin).toBe("reference-export");
  expect(result.rawCandidate).toBeUndefined();
  expect(
    await db
      .selectFrom("assets")
      .select("id")
      .where("purpose", "=", "ai_image_candidate")
      .execute(),
  ).toHaveLength(0);
  expect((await usageSummary(db, owner.id)).calls).toHaveLength(0);
  await expect(readRawImageCandidate(db, ctx, id, runtime())).rejects.toThrow(
    "没有持久原始候选",
  );
});

it("does not convert old failed records or reset them across jobs into another paid generation", async () => {
  const id = randomUUID(),
    input = { prompt },
    old = {
      kind: "image_generation",
      state: "failed",
      generation: { prompt, referenceImageIds: [] },
    };
  await db
    .insertInto("ai_operations")
    .values({
      id,
      user_id: owner.id,
      job_id: ctx.jobId!,
      digest: digest({ ...input, modelId: (await aiConfig(db)).imageModel }),
      result: JSON.stringify(old),
      created_at: new Date().toISOString(),
    })
    .execute();
  const next = await job(session);
  await expect(
    generateImageAsset(db, next, input, id, {
      storage: runtime(),
      fetch: (async () => {
        throw Error("Old failed operation must not bill");
      }) as typeof fetch,
    }),
  ).rejects.toThrow("图片操作标识冲突");
  await expect(readRawImageCandidate(db, next, id, runtime())).rejects.toThrow(
    "没有持久原始候选",
  );
  expect(await generation(id)).toEqual(old);
  expect((await usageSummary(db, owner.id)).calls).toHaveLength(0);
});

it("rejects unsupported raw receipt versions and raw byte tampering without changing provider usage", async () => {
  const source = await reference(),
    id = randomUUID();
  await generateImageAsset(
    db,
    ctx,
    { prompt, referenceImageIds: [source.id] },
    id,
    {
      storage: runtime(),
      fetch: (async () => response(await png(32, 24))) as typeof fetch,
    },
  );
  const candidate = await readRawImageCandidate(db, ctx, id, runtime());
  const unsupported = { ...candidate.candidate, version: 2 };
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(unsupported) })
    .where("id", "=", candidate.receiptId)
    .execute();
  await expect(readRawImageCandidate(db, ctx, id, runtime())).rejects.toThrow(
    "记录格式无效",
  );
  expect(await rawReceipt(id)).toEqual(unsupported);
  await db
    .updateTable("ai_operations")
    .set({ result: JSON.stringify(candidate.candidate) })
    .where("id", "=", candidate.receiptId)
    .execute();
  const changed = await png(32, 24, "#ad6232");
  expect(changed.length).toBe(candidate.data.length);
  await writeFile(join(root, candidate.candidate.objectKey), changed);
  await expect(readRawImageCandidate(db, ctx, id, runtime())).rejects.toThrow(
    "候选内容已改变",
  );
  expect((await usageSummary(db, owner.id)).calls).toEqual([
    expect.objectContaining({ images: 1, state: "confirmed" }),
  ]);
});

it("keeps explicitly unreported native usage and rejects undecodable provider pixels without a raw asset", async () => {
  const validId = randomUUID();
  await generateImageAsset(db, ctx, { prompt }, validId, {
    storage: runtime(),
    fetch: (async () =>
      Response.json({
        data: [{ b64_json: (await png()).toString("base64") }],
      })) as typeof fetch,
  });
  expect(
    (await readRawImageCandidate(db, ctx, validId, runtime())).candidate
      .nativeUsage,
  ).toEqual({ state: "not-reported" });
  const invalidId = randomUUID();
  await expect(
    generateImageAsset(db, ctx, { prompt: "另一幅图片" }, invalidId, {
      storage: runtime(),
      fetch: (async () =>
        response(Buffer.from("not valid image pixels"))) as typeof fetch,
    }),
  ).rejects.toThrow("原始候选无法完整解析");
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("id", "=", rawImageCandidateReceiptId(invalidId))
      .execute(),
  ).toEqual([]);
  expect(await generation(invalidId)).toMatchObject({
    state: "save_failed",
    generationOperationId: invalidId,
  });
  expect((await usageSummary(db, owner.id)).calls).toHaveLength(2);
  expect(
    (await usageSummary(db, owner.id)).calls.every(
      (call) => call.images === 1 && call.state === "confirmed",
    ),
  ).toBe(true);
});

it("counts provider attempts while excluding local recomposition and reference exports", async () => {
  const source = await reference();
  for (const origin of [
    "local-recomposition",
    "local-recomposition",
    "reference-export",
  ]) {
    const id = randomUUID();
    await db
      .insertInto("ai_operations")
      .values({
        id,
        user_id: owner.id,
        job_id: ctx.jobId!,
        digest: id,
        result: JSON.stringify({
          kind: "image_generation",
          state: "saved",
          origin,
          generation: { referenceImageIds: [source.id] },
        }),
        created_at: new Date().toISOString(),
      })
      .execute();
  }
  let calls = 0;
  const options = {
    storage: runtime(),
    fetch: (async () => {
      calls++;
      return response(await png(32, 24));
    }) as typeof fetch,
  };
  for (let index = 0; index < 5; index++) {
    await generateImageAsset(
      db,
      ctx,
      { prompt: `修改人物的第 ${index} 版`, referenceImageIds: [source.id] },
      randomUUID(),
      options,
    );
  }
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt: "第六次付费尝试", referenceImageIds: [source.id] },
      randomUUID(),
      options,
    ),
  ).rejects.toThrow("已提交5次");
  expect(calls).toBe(5);
  expect((await usageSummary(db, owner.id)).calls).toHaveLength(5);
});
