import { createHistory } from "@core/modules/history/service.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { aiDefaults, aiConfig, saveAIConfig } from "@core/modules/ai/config.js";
import {
  quotaSummary,
  reserveCall,
  settleCall,
} from "@core/modules/ai/quota.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  generateImageAsset,
  testAIImageModel,
} from "../apps/server/src/services/ai/images.js";
import {
  insertGeneratedImage,
  generatedImageStatus,
  showGeneratedImage,
  imageInsertSchema,
  spreadsheetImagePlacement,
} from "../apps/server/src/services/ai/image-insert.js";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
import {
  editAIDocument,
  readAIDocument,
} from "@core/workflows/ai-documents.js";
let db: DB, user: Actor, other: Actor, root: string, doc: string;
const prompt = "为测试文档画一株竹子";
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  user = {
    ...(await createUser(
      db,
      {
        login: "image-owner",
        displayName: "图片测试",
        password: "image-test-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "image-other",
        displayName: "其他用户",
        password: "image-test-2026",
      },
      { actor: user },
    )),
    admin: 0,
  };
  root = await mkdtemp(join(tmpdir(), "doca-image-test-"));
  doc = (
    await createContent(db).create(user, {
      title: "图片测试",
      kind: "document",
      format: "markdown",
      markdown: "# 图片测试",
    })
  ).id;
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      limits: { standard: { day: null, week: null, month: null } },
      vendors: [
        {
          id: "image-vendor",
          name: "图片厂商",
          provider: "openai",
          baseUrl: "https://images.example.test/v1",
          apiKey: "test-secret",
          enabled: true,
        },
      ],
      models: [
        {
          id: "image",
          vendorId: "image-vendor",
          model: "gpt-image-test",
          alias: "生图",
          enabled: true,
          levels: [],
          tools: false,
          inputRate: 0,
          outputRate: 4.5,
          cacheRate: 0,
          maxInput: 32000,
          maxOutput: 1000,
          imageGeneration: true,
        },
      ],
    },
    0,
  );
});
afterEach(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
const imageResponse = async () =>
  Response.json({
    data: [
      {
        b64_json: (
          await sharp({
            create: {
              width: 32,
              height: 24,
              channels: 3,
              background: "#248a66",
            },
          })
            .png()
            .toBuffer()
        ).toString("base64"),
      },
    ],
    usage: { input_tokens: 12, output_tokens: 30 },
  });
const args = () => ({ resourceId: doc, prompt, size: "1024x1024" as const });
it.each([
  ["1:1", "2048x2048"],
  ["16:9", "2560x1440"],
  ["9:16", "1440x2560"],
  ["4:3", "2304x1728"],
  ["3:4", "1728x2304"],
  ["3:2", "2496x1664"],
  ["2:3", "1664x2496"],
] as const)(
  "uses a supported Seedream size for aspect ratio %s",
  async (aspectRatio, size) => {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      {
        ...config,
        models: config.models.map((model) => ({
          ...model,
          model: "doubao-seedream-4-5",
        })),
      },
      revision,
    );
    const result = await generateImageAsset(
      db,
      { actor: user },
      { prompt, aspectRatio },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async (_url, init) => {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            size,
            response_format: "b64_json",
          });
          return imageResponse();
        }) as typeof fetch,
      },
    );
    expect(result.state).toBe("saved");
  },
);

it("preserves the configured Seedream default and rejects explicit unsupported sizes before billing", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...config,
      models: config.models.map((model) => ({
        ...model,
        model: "doubao-seedream-4-5",
        imageSize: "4096x4096",
      })),
    },
    revision,
  );
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root },
    fetch: (async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init?.body)).size).toBe("4096x4096");
      return imageResponse();
    }) as typeof fetch,
  };
  await expect(
    generateImageAsset(
      db,
      { actor: user },
      { prompt, size: "1024x1024" },
      randomUUID(),
      options,
    ),
  ).rejects.toThrow("不支持此小尺寸");
  expect(calls).toBe(0);
  expect((await quotaSummary(db, user.id)).calls).toHaveLength(0);
  await generateImageAsset(
    db,
    { actor: user },
    { prompt },
    randomUUID(),
    options,
  );
  expect(calls).toBe(1);
});

it("reports a local save failure separately from uncertain provider usage and prevents duplicate billing", async () => {
  const { ctx, sessionId } = await imageJob();
  const invalidRoot = join(root, "not-a-directory");
  await writeFile(invalidRoot, "occupied");
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root: invalidRoot },
    fetch: (async () => {
      calls++;
      return imageResponse();
    }) as typeof fetch,
  };
  const operation = randomUUID();
  await expect(
    generateImageAsset(db, ctx, { prompt }, operation, options),
  ).rejects.toThrow("图片保存失败");
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", operation)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(row.result).state).toBe("save_failed");
  expect((await quotaSummary(db, user.id)).calls[0]).toMatchObject({
    images: 1,
    state: "confirmed",
  });
  await expect(
    generateImageAsset(db, ctx, { prompt }, operation, options),
  ).rejects.toThrow("已生成但保存失败");
  const retry = await imageJob(sessionId);
  await expect(
    generateImageAsset(db, retry.ctx, { prompt }, randomUUID(), {
      ...options,
      relatedJobIds: [ctx.jobId, retry.ctx.jobId],
    }),
  ).rejects.toThrow("不能重复提交");
  expect(calls).toBe(1);
  expect(await db.selectFrom("assets").selectAll().execute()).toHaveLength(0);
});

async function imageJob(sessionId?: string) {
  const now = new Date().toISOString();
  if (!sessionId) {
    sessionId = randomUUID();
    await db
      .insertInto("ai_sessions")
      .values({
        id: sessionId,
        user_id: user.id,
        title: "图片请求测试",
        model_id: "image",
        resource_ids: "[]",
        archived: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  const jobId = randomUUID(),
    lease = randomUUID();
  await db
    .insertInto("ai_jobs")
    .values({
      id: jobId,
      session_id: sessionId,
      user_id: user.id,
      model_id: "image",
      status: "running",
      input: "{}",
      digest: jobId,
      result: "",
      error: "",
      lease,
      lease_until: new Date(Date.now() + 60000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { ctx: { actor: user, jobId, lease }, sessionId };
}

it.each(["chat", "document"] as const)(
  "generates distinct %s images concurrently while blocking duplicate requests",
  async (target) => {
    const { ctx } = await imageJob();
    const input = target === "chat" ? { prompt } : args();
    let markStarted!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const options = {
      storage: { ...storageRuntime(), root },
      fetch: (async () => {
        calls++;
        if (calls === 1) {
          markStarted();
          await released;
        }
        return imageResponse();
      }) as typeof fetch,
    };
    const operation = randomUUID();
    const first = generateImageAsset(db, ctx, input, operation, options);
    try {
      await started;
      await expect(
        generateImageAsset(db, ctx, input, operation, options),
      ).rejects.toThrow("请勿重复生成");
      await expect(
        generateImageAsset(db, ctx, input, randomUUID(), options),
      ).rejects.toThrow("不能重复提交");
      const second = await generateImageAsset(
        db,
        ctx,
        { ...input, prompt: "画一朵红色的花" },
        randomUUID(),
        options,
      );
      expect(second.state).toBe("saved");
      expect(calls).toBe(2);
    } finally {
      release();
      await first;
    }
    expect(await db.selectFrom("assets").select("id").execute()).toHaveLength(
      2,
    );
    expect((await quotaSummary(db, user.id)).calls).toHaveLength(2);
  },
);

it("keeps uncertain requests protected across retries without blocking different images or new requests", async () => {
  const { ctx, sessionId } = await imageJob();
  const input = { prompt };
  await expect(
    generateImageAsset(db, ctx, input, randomUUID(), {
      fetch: (async () => {
        throw new Error("Connection lost");
      }) as typeof fetch,
    }),
  ).rejects.toThrow("结果和费用待核对");
  await db
    .updateTable("ai_jobs")
    .set({ status: "failed" })
    .where("id", "=", ctx.jobId)
    .execute();
  const retry = await imageJob(sessionId);
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root },
    relatedJobIds: [retry.ctx.jobId, ctx.jobId],
    fetch: (async () => {
      calls++;
      return imageResponse();
    }) as typeof fetch,
  };
  await expect(
    generateImageAsset(db, retry.ctx, input, randomUUID(), options),
  ).rejects.toThrow("不能重复提交");
  expect(calls).toBe(0);
  const different = await generateImageAsset(
    db,
    retry.ctx,
    { prompt: "画一朵红色的花" },
    randomUUID(),
    options,
  );
  expect(different.state).toBe("saved");
  const fresh = await imageJob(sessionId);
  const requested = await generateImageAsset(
    db,
    fresh.ctx,
    input,
    randomUUID(),
    {
      ...options,
      relatedJobIds: undefined,
    },
  );
  expect(requested.state).toBe("saved");
  expect(calls).toBe(2);
  expect(
    (await quotaSummary(db, user.id)).calls.filter(
      (c) => c.state === "pending",
    ),
  ).toHaveLength(1);
});

it("tests the configured image endpoint with a real minimal generation request", async () => {
  let requestBody: any;
  const result = await testAIImageModel(
    {
      id: "image",
      vendorId: "image-vendor",
      provider: "openai",
      baseUrl: "https://images.example.test/v1",
      apiKey: "test-secret",
      model: "gpt-image-test",
      alias: "生图",
      enabled: true,
      levels: [],
      tools: false,
      inputRate: 0,
      outputRate: 4.5,
      cacheRate: 0,
      maxInput: 32000,
      maxOutput: 1000,
      imageGeneration: true,
    },
    (async (url, init) => {
      expect(String(url)).toBe(
        "https://images.example.test/v1/images/generations",
      );
      requestBody = JSON.parse(String(init?.body));
      return imageResponse();
    }) as typeof fetch,
  );
  expect(requestBody).toMatchObject({
    model: "gpt-image-test",
    n: 1,
    size: "1024x1024",
  });
  expect(result.usage.inputTokens.total).toBe(12);
  expect(result.usage.outputTokens.total).toBe(30);
});
it("generates a private chat image without a document and inserts into five native formats without regenerating or duplicating", async () => {
  const runtime = { ...storageRuntime(), root };
  const image = await generateImageAsset(
    db,
    { actor: user },
    { prompt },
    randomUUID(),
    { storage: runtime, fetch: imageResponse as typeof fetch },
  );
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", image.assetId)
    .executeTakeFirstOrThrow();
  expect(asset).toMatchObject({
    resource_id: null,
    purpose: "ai_attachment",
    owner_id: user.id,
  });
  for (const format of [
    "markdown",
    "rich_text",
    "canvas",
    "presentation",
    "spreadsheet",
  ] as const) {
    const target = await createContent(db).create(user, {
      kind: "document",
      format,
      title: `插入测试 ${format}`,
    });
    const requestId = randomUUID();
    const input = { assetId: image.assetId, resourceId: target.id };
    const saved = await insertGeneratedImage(
      db,
      { actor: user },
      input,
      requestId,
      runtime,
    );
    expect(
      await insertGeneratedImage(
        db,
        { actor: user },
        input,
        requestId,
        runtime,
      ),
    ).toEqual(saved);
    const history = await createHistory(db).versions(user, target.id);
    expect(history.items.some((v) => v.is_ai)).toBe(true);
    const result = await readAIDocument(db, { actor: user }, target.id);
    expect(JSON.stringify(result.value)).toContain(saved.assetId);
    expect(
      await db
        .selectFrom("assets")
        .select("id")
        .where("resource_id", "=", target.id)
        .execute(),
    ).toHaveLength(1);
    if (format === "canvas") {
      const element = (result.value as any).scene.children[0];
      expect(element.id).toBeTruthy();
      expect(element).toMatchObject({
        tag: "Image",
        name: "image",
        lockRatio: true,
        data: {
          resourcePath: saved.assetId,
          naturalWidth: 32,
          naturalHeight: 24,
        },
      });
      await editAIDocument(
        db,
        { actor: user },
        target.id,
        { seq: result.seq, epochId: result.epochId! },
        [
          {
            type: "patch",
            id: element.id,
            patch: { opacity: 0.5, width: 300 },
          },
        ],
        randomUUID(),
      );
      const restored = await readAIDocument(db, { actor: user }, target.id);
      expect((restored.value as any).scene.children[0]).toMatchObject({
        id: element.id,
        name: "image",
        opacity: 0.5,
        width: 300,
        data: { resourcePath: saved.assetId },
      });
    }
    if (format === "presentation")
      expect((result.value as any).slideOrder).toHaveLength(2);
    if (format === "spreadsheet") {
      const raw = (result.value as any).resources?.find(
        (r: any) => r.name === "EXLSX_FLOATING_OBJECTS",
      )?.data;
      const floating = typeof raw === "string" ? JSON.parse(raw) : raw ?? [];
      expect(
        JSON.stringify(floating),
      ).toContain(saved.assetId);
    }
  }
  const physicalObjects = await db
    .selectFrom("file_storage_objects")
    .select(["id", "object_key"])
    .execute();
  expect(physicalObjects).toEqual([
    { id: image.assetId, object_key: asset.object_key },
  ]);
  const locations = await db
    .selectFrom("file_items")
    .select(["parent_type", "parent_id", "storage_object_id"])
    .where("storage_object_id", "=", image.assetId)
    .execute();
  expect(locations).toHaveLength(6);
  expect(
    locations.filter((item) => item.parent_type === "system"),
  ).toHaveLength(1);
  expect(
    locations.filter((item) => item.parent_type === "document"),
  ).toHaveLength(5);
  expect(
    new Set(
      (await db.selectFrom("assets").select("object_key").execute()).map(
        (row) => row.object_key,
      ),
    ),
  ).toEqual(new Set([asset.object_key]));
  expect((await quotaSummary(db, user.id)).calls).toHaveLength(1);
  expect(
    await generatedImageStatus(db, { actor: user }, image.assetId),
  ).toEqual({ ready: true, pending: false });
  await db
    .updateTable("assets")
    .set({ moderation_status: "pending" })
    .where("id", "=", image.assetId)
    .execute();
  expect(
    await generatedImageStatus(db, { actor: user }, image.assetId),
  ).toEqual({ ready: false, pending: true });
  await expect(
    insertGeneratedImage(
      db,
      { actor: user },
      { assetId: image.assetId, resourceId: doc },
      randomUUID(),
      runtime,
    ),
  ).rejects.toThrow("审核中");
  await db
    .updateTable("assets")
    .set({ moderation_status: "pass" })
    .where("id", "=", image.assetId)
    .execute();
  const otherDoc = await createContent(db).create(other, {
    kind: "document",
    format: "markdown",
    title: "他人的文档",
  });
  await expect(
    insertGeneratedImage(
      db,
      { actor: other },
      { assetId: image.assetId, resourceId: otherDoc.id },
      randomUUID(),
      runtime,
    ),
  ).rejects.toThrow("自己生成");
  await expect(
    insertGeneratedImage(
      db,
      { actor: user },
      { assetId: image.assetId, resourceId: otherDoc.id },
      randomUUID(),
      runtime,
    ),
  ).rejects.toThrow();
});
it("requires an image count for pending image reconciliation and charges the configured per-image price once", async () => {
  const app = await createApp(db, {
    origin: "http://localhost:39249",
    storage: { ...storageRuntime(), root },
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:39249", host: "localhost:39249" },
      payload: { login: "image-owner", password: "image-test-2026" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const call = await reserveCall(db, user.id, "image", null, 0, 0, 1);
    await settleCall(db, call.id, null);
    const reconcile = (payload: object) =>
      app.inject({
        method: "POST",
        url: `/api/v1/admin/ai/calls/${call.id}/reconcile`,
        headers: {
          origin: "http://localhost:39249",
          host: "localhost:39249",
          cookie,
        },
        payload,
      });
    expect((await reconcile({ input: 0, output: 0 })).statusCode).toBe(400);
    expect(
      (await reconcile({ input: 12, output: 30, images: 1 })).statusCode,
    ).toBe(200);
    expect(
      (await reconcile({ input: 12, output: 30, images: 1 })).statusCode,
    ).toBe(409);
    const usage = (await quotaSummary(db, user.id)).calls.find(
      (c) => c.id === call.id,
    )!;
    expect(usage).toMatchObject({
      callKind: "image",
      images: 1,
      points: 4.5,
      input: 12,
      output: 30,
      state: "reconciled",
    });
  } finally {
    await app.close();
  }
});
it("bills configured image size tiers and falls back to the flat per-image rate", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...config,
      models: config.models.map((m) => ({
        ...m,
        imageRate: 4.5,
        imageSizeRates: { "1024x1024": 8 },
      })),
    },
    revision,
  );
  const tiered = await reserveCall(
    db,
    user.id,
    "image",
    null,
    0,
    0,
    1,
    "1024x1024",
  );
  expect(tiered.maximum).toBe(8000);
  await settleCall(db, tiered.id, { input: 0, output: 0, images: 1 });
  const flat = await reserveCall(
    db,
    user.id,
    "image",
    null,
    0,
    0,
    1,
    "2048x2048",
  );
  expect(flat.maximum).toBe(4500);
  await settleCall(db, flat.id, { input: 0, output: 0, images: 1 });
  const calls = (await quotaSummary(db, user.id)).calls;
  expect(calls.find((c) => c.id === tiered.id)?.points).toBe(8);
  expect(calls.find((c) => c.id === flat.id)?.points).toBe(4.5);
});
it("stores an owned asset, inserts through native document tools, and bills once per image with real tokens separate", async () => {
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root },
    fetch: (async (url, init) => {
      calls++;
      expect(String(url)).toBe(
        "https://images.example.test/v1/images/generations",
      );
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toMatchObject({ n: 1, prompt });
      return imageResponse();
    }) as typeof fetch,
  };
  const operation = randomUUID();
  const result = await generateImageAsset(
    db,
    { actor: user },
    args(),
    operation,
    options,
  );
  expect(result).toMatchObject({
    width: 32,
    height: 24,
    ready: true,
    resourceId: doc,
  });
  const reused = await generateImageAsset(
    db,
    { actor: user },
    args(),
    operation,
    options,
  );
  expect(reused.assetId).toBe(result.assetId);
  expect(calls).toBe(1);
  const row = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", result.assetId)
    .executeTakeFirstOrThrow();
  expect(row.owner_id).toBe(user.id);
  expect(row.resource_id).toBeNull();
  expect(row.purpose).toBe("ai_attachment");
  expect(
    await db
      .selectFrom("file_items")
      .selectAll()
      .where("storage_object_id", "=", row.id)
      .execute(),
  ).toEqual([
    expect.objectContaining({ parent_type: "system", parent_id: "ai" }),
  ]);
  expect(
    (await sharp(await readFile(join(root, row.object_key))).metadata()).format,
  ).toBe("webp");
  const before = await readAIDocument(db, { actor: user }, doc);
  await editAIDocument(
    db,
    { actor: user },
    doc,
    { seq: before.seq, epochId: before.epochId! },
    [{ type: "append", text: `\n\n![竹子](${result.url})` }],
    randomUUID(),
  );
  expect(
    JSON.stringify((await readAIDocument(db, { actor: user }, doc)).value),
  ).toContain(result.assetId);
  const usage = await quotaSummary(db, user.id);
  expect(usage.used.day).toBe(4.5);
  expect(usage.calls[0]).toMatchObject({
    points: 4.5,
    input: 12,
    output: 30,
    images: 1,
    state: "confirmed",
  });
  await expect(
    generateImageAsset(db, { actor: other }, args(), operation, options),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it("rejects exhausted membership credits before requesting images", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(
    db,
    { ...config, limits: { standard: { day: 0, week: 0, month: 0 } } },
    revision,
  );
  let called = false;
  await expect(
    generateImageAsset(db, { actor: user }, args(), randomUUID(), {
      fetch: (async () => {
        called = true;
        return imageResponse();
      }) as typeof fetch,
    }),
  ).rejects.toThrow("积分不足");
  expect(called).toBe(false);
  expect(
    await db.selectFrom("ai_operations").selectAll().execute(),
  ).toHaveLength(0);
});
it("does not fetch provider-supplied URLs or repeat an uncertain generation", async () => {
  let calls = 0;
  const operation = randomUUID();
  const options = {
    fetch: (async () => {
      calls++;
      return Response.json({ data: [{ url: "http://127.0.0.1/private" }] });
    }) as typeof fetch,
  };
  await expect(
    generateImageAsset(db, { actor: user }, args(), operation, options),
  ).rejects.toThrow("base64");
  await expect(
    generateImageAsset(db, { actor: user }, args(), operation, options),
  ).rejects.toThrow("请勿重复生成");
  expect(calls).toBe(1);
  expect((await quotaSummary(db, user.id)).calls[0]?.state).toBe("pending");
});
it("releases credit reservation on definitive authentication rejection and redacts secrets", async () => {
  await expect(
    generateImageAsset(db, { actor: user }, args(), randomUUID(), {
      fetch: (async () =>
        Response.json(
          { error: "test-secret" },
          { status: 401 },
        )) as typeof fetch,
    }),
  ).rejects.toThrow("图片模型认证失败");
  const quota = await quotaSummary(db, user.id);
  expect(quota.used.day).toBe(0);
  expect(quota.calls[0]).toMatchObject({ images: 0, state: "failed" });
});
it("rechecks revoked account access after provider returns and never persists the image", async () => {
  await expect(
    generateImageAsset(db, { actor: user }, args(), randomUUID(), {
      storage: { ...storageRuntime(), root },
      fetch: (async () => {
        await db
          .updateTable("users")
          .set({ status: "disabled" })
          .where("id", "=", user.id)
          .execute();
        return imageResponse();
      }) as typeof fetch,
    }),
  ).rejects.toThrow();
  expect(await db.selectFrom("assets").selectAll().execute()).toHaveLength(0);
});

it("does not invent image results or expose another conversation's images", async () => {
  await expect(
    showGeneratedImage(db, { actor: user }, randomUUID()),
  ).rejects.toThrow("没有这张图片");
});

it("keeps flattened spreadsheet placement on image_insert", () => {
  const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const advertised = z.toJSONSchema(imageInsertSchema, {
    unrepresentable: "any",
    io: "input",
  }) as { required?: string[]; properties?: Record<string, unknown> };
  expect(advertised.required).toEqual([
    "assetId",
    "resourceId",
    "sheetId",
    "row",
    "column",
  ]);
  expect(advertised.properties).not.toHaveProperty("spreadsheet");
  expect(
    spreadsheetImagePlacement(
      imageInsertSchema.parse({
        assetId: uuid,
        resourceId: uuid,
        sheetId: "sheet-1",
        row: "2",
        column: "3",
      }),
    ),
  ).toEqual({ sheetId: "sheet-1", row: 2, column: 3 });
  expect(
    spreadsheetImagePlacement(
      imageInsertSchema.parse({
        assetId: uuid,
        resourceId: uuid,
        spreadsheet: { sheetId: "sheet-2", row: 4, column: 1 },
      }),
    ),
  ).toEqual({ sheetId: "sheet-2", row: 4, column: 1 });
  expect(
    spreadsheetImagePlacement(
      imageInsertSchema.parse({ assetId: uuid, resourceId: uuid }),
    ),
  ).toBeUndefined();
});

it("inserts a spreadsheet image at flattened sheetId/row/column", async () => {
  const runtime = { ...storageRuntime(), root };
  const image = await generateImageAsset(
    db,
    { actor: user },
    { prompt },
    randomUUID(),
    { storage: runtime, fetch: imageResponse as typeof fetch },
  );
  const target = await createContent(db).create(user, {
    kind: "document",
    format: "spreadsheet",
    title: "定位插图",
  });
  const before = await readAIDocument(db, { actor: user }, target.id);
  const sheetId = (before.value as any).sheetOrder[0];
  const saved = await insertGeneratedImage(
    db,
    { actor: user },
    {
      assetId: image.assetId,
      resourceId: target.id,
      sheetId,
      row: 2,
      column: 3,
    },
    randomUUID(),
    runtime,
  );
  const after = await readAIDocument(db, { actor: user }, target.id);
  const raw = (after.value as any).resources?.find(
    (r: any) => r.name === "EXLSX_FLOATING_OBJECTS",
  )?.data;
  const floating = typeof raw === "string" ? JSON.parse(raw) : raw ?? [];
  expect(JSON.stringify(floating)).toContain(saved.assetId);
  expect(JSON.stringify(floating)).toMatch(/"startRow":2/);
  expect(JSON.stringify(floating)).toMatch(/"startColumn":3/);
});
