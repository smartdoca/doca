import { createContent } from "@core/workflows/resources.js";
import { randomUUID } from "node:crypto";
import { searchKnowledge } from "../apps/server/src/services/ai/knowledge-search.js";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { AppError, fail } from "@core/shared/errors.js";
import { registerSearch } from "../apps/server/src/routes/search.js";
import { documentSearchSource } from "../apps/server/src/services/search/sources.js";
import { embeddingFailureNotice } from "../apps/server/src/routes/search-embeddings.js";
import { aiConfig, aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import type { DB } from "@db/index.js";

let db: DB, actor: Actor, app: Awaited<ReturnType<typeof setup>>;
let remote: Record<string, any>,
  remoteStatus: string,
  broken: boolean,
  brokenSemantic: boolean,
  brokenEmbedderRead: boolean,
  ambiguous: boolean;
let searchService: Awaited<ReturnType<typeof registerSearch>>;
let hits: { id: string; [key: string]: unknown }[];
let calls: { method: string; path: string; body: any }[];
let taskStatuses: string[], batchDiagnostic: string, taskError: string;
let historicalBatchDiagnostic: string, onTaskPoll: (() => void) | undefined;
const root = "/api/v1/admin/search/embeddings";
const headers = { "x-test-admin": "yes" };
const body = () => ({
  generation: 1,
  name: "knowledge_v1",
  modelId: "embedding-openai",
  aiRevision: 1,
  documentTemplate: "{{doc.title}}\n{{doc.text}}",
  documentTemplateMaxBytes: 8000,
});
async function setup() {
  const server = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
  });
  server.setErrorHandler((error, _req, reply) => {
    reply
      .code(
        error instanceof AppError
          ? error.status
          : ((error as any).statusCode ?? 500),
      )
      .send({ message: (error as Error).message });
  });
  searchService = await registerSearch(
    server,
    db,
    (req) => {
      if (req.headers["x-test-admin"] !== "yes") fail(403, "仅管理员可访问");
      return actor;
    },
    {
      allowedOrigins: ["http://127.0.0.1:7700"],
      apiKey: "meili-private-key",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname,
          method = init?.method ?? "GET";
        const value = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body: value });
        if (broken) return new Response("model-private-key", { status: 503 });
        if (path.endsWith("/settings/embedders")) {
          if (method === "PATCH") {
            if (ambiguous) throw new Error("model-private-key");
            for (const [name, fields] of Object.entries(value)) {
              if (fields == null) delete remote[name];
              else remote[name] = { ...remote[name], ...(fields as object) };
            }
            return Response.json({ taskUid: 42 });
          }
          if (brokenEmbedderRead) return new Response("down", { status: 503 });
          return Response.json(remote);
        }
        if (path.startsWith("/tasks/")) {
          onTaskPoll?.();
          return Response.json({
            status: taskStatuses.shift() ?? remoteStatus,
            batchUid: batchDiagnostic ? 7 : null,
            error: { message: taskError, code: "bad_api_key" },
          });
        }
        if (path === "/batches")
          return Response.json({
            results: [{ stats: { embedderRequests: { lastError: historicalBatchDiagnostic } } }],
          });
        if (path.startsWith("/batches/"))
          return Response.json({
            stats: { embedderRequests: { lastError: batchDiagnostic } },
          });
        if (path.endsWith("/search") && value?.hybrid && brokenSemantic)
          return Response.json(
            { message: "AccountQuotaExceeded" },
            { status: 429 },
          );
        if (path.endsWith("/search"))
          return Response.json({
            hits: hits.map((h) => ({ _rankingScore: 0.8, ...h })),
          });
        if (path.endsWith("/documents") && method === "POST")
          return Response.json({ taskUid: 43 });
        if (path.endsWith("/documents"))
          return Response.json({ results: [], total: 0 });
        return Response.json({ status: "available", taskUid: 43 });
      },
    },
  );
  server.get("/test-search", (req) =>
    searchService.search(actor, req.query as any),
  );
  return server;
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  actor = {
    ...(await createUser(
      db,
      {
        login: "admin",
        displayName: "Admin",
        password: "search-config-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await db
    .updateTable("search_settings")
    .set({
      enabled: 1,
      generation: 1,
      endpoint: "http://127.0.0.1:7700",
      index_name: "doca",
    })
    .where("id", "=", "system")
    .execute();
  const common = {
    alias: "向量模型",
    enabled: true,
    embedding: true,
    tools: false,
    maxInput: 8000,
    maxOutput: 32,
  };
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      display: "real",
      vendors: [
        {
          id: "openai-vendor",
          name: "OpenAI",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "model-private-key",
          enabled: true,
        },
        {
          id: "ollama-vendor",
          name: "Ollama",
          provider: "ollama",
          baseUrl: "http://localhost:11434/v1",
          apiKey: "",
          enabled: true,
        },
      ],
      models: [
        {
          ...common,
          id: "embedding-openai",
          vendorId: "openai-vendor",
          model: "text-embedding-3-small",
        },
        {
          ...common,
          id: "embedding-local",
          vendorId: "ollama-vendor",
          model: "local-embedding-model",
          embeddingDimensions: 1024,
        },
        {
          ...common,
          id: "chat",
          vendorId: "openai-vendor",
          model: "chat-model",
          embedding: false,
          tools: true,
        },
        {
          ...common,
          id: "disabled",
          vendorId: "openai-vendor",
          model: "disabled-model",
          enabled: false,
        },
      ],
    },
    0,
  );
  remote = {};
  hits = [];
  remoteStatus = "processing";
  broken = false;
  brokenSemantic = false;
  brokenEmbedderRead = false;
  ambiguous = false;
  calls = [];
  taskStatuses = [];
  batchDiagnostic = "";
  taskError = "model-private-key";
  historicalBatchDiagnostic = "";
  onTaskPoll = undefined;
  app = await setup();
});
afterEach(async () => {
  await app.close();
  await db.destroy();
});
const get = (url = root) => app.inject({ url, headers });
const save = (overrides = {}) =>
  app.inject({
    url: root,
    method: "PUT",
    headers,
    payload: { ...body(), ...overrides },
  });
const remove = (overrides: Record<string, unknown> = {}) =>
  app.inject({
    url: root,
    method: "DELETE",
    headers,
    payload: { generation: 1, name: "knowledge_v1", ...overrides },
  });
const writes = () =>
  calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/embedders"));

it("waits for the accepted indexing task when an embedder attempt fails during processing", async () => {
  taskStatuses = ["processing", "processing", "succeeded"];
  batchDiagnostic = "embedding server replied with 429 TooManyRequests";
  await expect(
    searchService.searchHost.upsertProjections({
      source: documentSearchSource,
      projections: [{ id: "transient-error", text: "Searchable content" }],
    }),
  ).resolves.toBeUndefined();
  expect(calls.filter((call) => call.path === "/batches/7")).toHaveLength(1);
  expect(calls.filter((call) => call.path === "/tasks/43")).toHaveLength(3);
  expect(
    calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/documents"),
    ),
  ).toHaveLength(1);
});

it("fails indexing only after the remote task reports a terminal failure", async () => {
  taskStatuses = ["processing", "failed"];
  batchDiagnostic = "temporary embedder request error";
  await expect(
    searchService.searchHost.upsertProjections({
      source: documentSearchSource,
      projections: [{ id: "terminal-error", text: "Searchable content" }],
    }),
  ).rejects.toThrow("搜索索引任务失败：model-private-key");
  expect(calls.filter((call) => call.path === "/tasks/43")).toHaveLength(2);
});

it("continues waiting for the same accepted indexing task beyond five minutes", async () => {
  taskStatuses = ["enqueued", "processing", "succeeded"];
  const clock = vi.spyOn(Date, "now");
  const later = Date.now() + 600000;
  onTaskPoll = () => clock.mockReturnValue(later);
  try {
    await expect(
      searchService.searchHost.upsertProjections({
        source: documentSearchSource,
        projections: [{ id: "slow-task", text: "Searchable content" }],
      }),
    ).resolves.toBeUndefined();
    expect(calls.filter((call) => call.path === "/tasks/43")).toHaveLength(3);
    expect(
      calls.filter((call) => call.method === "POST" && call.path.endsWith("/documents")),
    ).toHaveLength(1);
  } finally {
    clock.mockRestore();
    onTaskPoll = undefined;
  }
});

it("does not attribute historical batch errors to a newly queued embedding task", async () => {
  remoteStatus = "enqueued";
  taskError = "";
  historicalBatchDiagnostic = "AccountQuotaExceeded from an older task";
  expect((await save()).statusCode).toBe(202);
  const status = (await get("/api/v1/admin/search")).json();
  expect(status.embedding).toMatchObject({ status: "enqueued", taskUid: 42, error: null });
  expect(status.syncDiagnostic).toBeNull();
  expect(calls.some((call) => call.path === "/batches")).toBe(false);
});

it("reports the active embedding task's own batch diagnostic", async () => {
  remoteStatus = "processing";
  taskError = "";
  batchDiagnostic = "current embedding server returned 429";
  historicalBatchDiagnostic = "unrelated historical quota error";
  await save();
  const status = (await get("/api/v1/admin/search")).json();
  expect(status.embedding.error).toBe(batchDiagnostic);
  expect(status.syncDiagnostic).toContain(batchDiagnostic);
  expect(status.syncDiagnostic).not.toContain(historicalBatchDiagnostic);
});

it("reports each failed rebuild source and its redacted cause", async () => {
  remoteStatus = "failed";
  taskError =
    'AccountQuotaExceeded; {"apiKey":"hidden-json-key"}; Bearer hidden-bearer';
  await app.inject({
    method: "POST",
    url: "/api/v1/admin/search/reindex",
    headers,
  });
  let status: any;
  for (let i = 0; i < 100; i++) {
    status = (await get("/api/v1/admin/search")).json();
    if (!status.indexing) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(status.indexing).toBe(false);
  expect(status.lastError).toContain("3 个搜索来源重建失败");
  for (const source of [
    "doca.documents/documents",
    "doca.files/files",
    "doca.documents/knowledge-chunks",
  ])
    expect(status.lastError).toContain(
      `${source}：搜索索引任务失败：AccountQuotaExceeded`,
    );
  expect(status.lastError).not.toContain("hidden-json-key");
  expect(status.lastError).not.toContain("hidden-bearer");
});

it("recovers all rebuild sources after binding an existing remote embedder to its host model", async () => {
  remoteStatus = "succeeded";
  remote = {
    knowledge_v1: {
      source: "openAi",
      model: "text-embedding-3-small",
      url: "https://api.openai.com/v1/embeddings",
      apiKey: "***",
      documentTemplate: "{{doc.title}}\n{{doc.text}}",
      documentTemplateMaxBytes: 8000,
    },
  };
  const document = await createContent(db).create(actor, {
    kind: "document",
    format: "markdown",
    title: "问题",
  });
  async function rebuild() {
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/search/reindex",
      headers,
    });
    let status: any;
    for (let i = 0; i < 100; i++) {
      status = (await get("/api/v1/admin/search")).json();
      if (!status.indexing) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status.indexing).toBe(false);
    return status;
  }
  const failed = await rebuild();
  for (const source of [
    "doca.documents/documents",
    "doca.files/files",
    "doca.documents/knowledge-chunks",
  ])
    expect(failed.lastError).toContain(
      `${source}：独立索引需要在 Doca 中绑定对应向量模型`,
    );
  expect(
    calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/documents"),
    ),
  ).toHaveLength(0);

  expect((await save()).statusCode).toBe(202);
  expect((await get(root + "/status")).json().status).toBe("succeeded");
  calls = [];
  expect((await rebuild()).lastError).toBe("");
  expect(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.path.endsWith("/documents") &&
        call.body.some(
          (indexed: any) => indexed.id === document.id && indexed.title === "问题",
        ),
    ),
  ).toBe(true);
  expect(
    writes().every(
      (call) => call.body.knowledge_v1.apiKey === "model-private-key",
    ),
  ).toBe(true);
});

it.each(["query", "settings"])(
  "keeps Meilisearch keyword search available when vector %s fails",
  async (failure) => {
    const document = await createContent(db).create(actor, {
      kind: "document",
      format: "markdown",
      title: "关键词可用",
    });
    hits = [{ id: document.id }];
    await save();
    remoteStatus = "succeeded";
    await get(root + "/status");
    brokenSemantic = failure === "query";
    brokenEmbedderRead = failure === "settings";
    calls = [];
    const result = await get("/test-search?q=关键词&mode=auto");
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      engine: "meilisearch", mode: "keyword", total: 1,
    });
    expect(result.json().items[0].id).toBe(document.id);
    expect(result.json().notice).toContain("关键词搜索");
    const searches = calls.filter((call) => call.path.endsWith("/search"));
    expect(searches).toHaveLength(failure === "query" ? 2 : 1);
    expect(searches.at(-1)?.body.hybrid).toBeUndefined();
    expect(writes()).toHaveLength(0);
    expect((await get("/test-search?q=关键词&mode=ai")).statusCode).toBe(503);
  },
);

it("queries the active keyword index during a rebuild", async () => {
  const document = await createContent(db).create(actor, {
    kind: "document",
    format: "markdown",
    title: "关键词可用",
  });
  hits = [{ id: document.id }];
  await app.inject({
    method: "POST", url: "/api/v1/admin/search/reindex", headers,
  });
  try {
    expect((await get("/api/v1/admin/search")).json().indexing).toBe(true);
    const result = await get("/test-search?q=关键词&mode=keyword");
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      engine: "meilisearch", mode: "keyword", total: 1,
    });
    expect(
      calls.filter((call) => call.path.endsWith("/search")).at(-1)?.body.hybrid,
    ).toBeUndefined();
  } finally {
    remoteStatus = "succeeded";
  }
});

it("searches physical file content once while scoping location aliases before retrieval", async () => {
  const profile = await db
    .selectFrom("storage_profiles")
    .select("id")
    .executeTakeFirstOrThrow();
  const objectId = randomUUID();
  const firstId = randomUUID();
  const secondId = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profile.id,
      object_key: `objects/${objectId}`,
      sha256: "a".repeat(64),
      size: 10,
      mime: "image/webp",
      category: "image",
      ai_description: "一只晒太阳的橘色猫",
      ai_status: "ready",
      ai_model: "vision",
      ai_generated_at: now,
      created_at: now,
    })
    .execute();
  await db
    .insertInto("file_items")
    .values([
      {
        id: firstId,
        owner_id: actor.id,
        parent_type: "system",
        parent_id: "ai",
        storage_object_id: objectId,
        name: "AI 生成图片.webp",
        mime: "image/webp",
        size: 10,
        metadata: "{}",
        ai_description_override: null,
        locked: 0,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      },
      {
        id: secondId,
        owner_id: actor.id,
        parent_type: "system",
        parent_id: "root",
        storage_object_id: objectId,
        name: "我的猫.webp",
        mime: "image/webp",
        size: 10,
        metadata: "{}",
        ai_description_override: "家庭相册里的宠物",
        locked: 0,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      },
    ])
    .execute();
  remoteStatus = "succeeded";
  hits = [
    { id: `file_object_${objectId.replaceAll("-", "_")}` },
    { id: `file_item_${secondId.replaceAll("-", "_")}` },
  ];
  const result = await searchService.searchFiles(
    "猫",
    [firstId, secondId],
    "keyword",
  );
  expect(result).toHaveLength(2);
  expect(result).toEqual(expect.arrayContaining([firstId, secondId]));
  const request = calls.filter((call) => call.path.endsWith("/search")).at(-1)!;
  expect(request.body.filter).toContain(
    `file_object_${objectId.replaceAll("-", "_")}`,
  );
  expect(request.body.filter).toContain(
    `file_item_${firstId.replaceAll("-", "_")}`,
  );
  expect(request.body.filter).toContain(
    `file_item_${secondId.replaceAll("-", "_")}`,
  );

  hits = [{ id: `file_item_${secondId.replaceAll("-", "_")}` }];
  expect(
    await searchService.searchFiles("家庭相册", [firstId], "keyword"),
  ).toEqual([]);
  expect(
    calls.filter((call) => call.path.endsWith("/search")).at(-1)!.body.filter,
  ).not.toContain(`file_item_${secondId.replaceAll("-", "_")}`);

  await save();
  remoteStatus = "succeeded";
  hits = [
    { id: `file_object_${objectId.replaceAll("-", "_")}`, _rankingScore: 0.99 },
  ];
  expect(
    await searchService.searchFiles(
      "火星火箭发射流程",
      [firstId, secondId],
      "ai",
    ),
  ).toEqual([]);
  expect(
    await searchService.searchFiles("猫", [firstId, secondId], "ai"),
  ).toHaveLength(2);
  await db
    .updateTable("file_storage_objects")
    .set({ ai_description: "当前内容已变成绘本项目 DOCA" })
    .where("id", "=", objectId)
    .execute();
  expect(
    await searchService.searchFiles("doca问题记录", [firstId, secondId], "ai"),
  ).toEqual([]);
});

it("explains Meilisearch Cloud rejected embedding URIs", () => {
  expect(embeddingFailureNotice("Rejected URI")).toContain("云端 Meilisearch");
});

it("requires admin, forwards configuration to Meilisearch, and never returns or stores model credentials", async () => {
  for (const [method, url] of [
    ["GET", root],
    ["GET", root + "/status"],
    ["PUT", root],
    ["DELETE", root],
  ] as const) {
    expect(
      (
        await app.inject({
          method,
          url,
          ...(method === "PUT" || method === "DELETE"
            ? {
                payload:
                  method === "DELETE"
                    ? { generation: 1, name: "knowledge_v1" }
                    : body(),
              }
            : {}),
        })
      ).statusCode,
    ).toBe(403);
  }
  expect((await save()).statusCode).toBe(202);
  expect(writes()[0]?.body).toEqual({
    knowledge_v1: {
      source: "openAi",
      model: "text-embedding-3-small",
      url: "https://api.openai.com/v1/embeddings",
      apiKey: "model-private-key",
      dimensions: null,
      documentTemplate: "{{doc.title}}\n{{doc.text}}",
      documentTemplateMaxBytes: 8000,
    },
  });
  const read = await get();
  expect(read.json().embedders[0]).toMatchObject({
    name: "knowledge_v1",
    credentialConfigured: true,
    supported: true,
  });
  expect(read.body).not.toContain("model-private-key");
  expect(read.body).not.toContain("meili-private-key");
  expect(
    JSON.stringify(
      await db.selectFrom("search_embedding_task").selectAll().execute(),
    ),
  ).not.toContain("private-key");
  expect(
    JSON.stringify(await db.selectFrom("audit_events").selectAll().execute()),
  ).not.toContain("private-key");
});

it("persists task IDs across app restarts and blocks competing writes until the task finishes", async () => {
  await save();
  expect((await save()).statusCode).toBe(409);
  const connection = {
    enabled: true,
    endpoint: "http://127.0.0.1:7700",
    indexName: "another",
    imageRecognitionEnabled: false,
    reconcileIntervalHours: 6,
  };
  expect(
    (
      await app.inject({
        url: "/api/v1/admin/search",
        method: "PUT",
        headers,
        payload: connection,
      })
    ).statusCode,
  ).toBe(409);
  await app.close();
  app = await setup();
  expect((await get(root + "/status")).json()).toMatchObject({
    taskUid: 42,
    status: "processing",
  });
  broken = true;
  expect((await get(root + "/status")).json()).toMatchObject({
    taskUid: 42,
    status: "processing",
  });
  broken = false;
  remoteStatus = "succeeded";
  expect((await get(root + "/status")).json().status).toBe("succeeded");
  expect(writes()).toHaveLength(1);
  expect((await get()).json().embedders[0]).toMatchObject({
    modelId: "embedding-openai",
    needsApply: false,
  });
  const update = await save();
  expect(update.statusCode).toBe(202);
  expect(writes()[1]?.body.knowledge_v1.apiKey).toBe("model-private-key");
  expect(remote.knowledge_v1.apiKey).toBe("model-private-key");
});

it("accepts only enabled AI vector models and rejects stale or independent credential input", async () => {
  for (const overrides of [
    { generation: 0 },
    { aiRevision: 0 },
    { modelId: "chat" },
    { modelId: "disabled" },
    { modelId: "missing" },
    { dimensions: 0 },
    { url: "https://other.test/embeddings" },
    { apiKey: "override-private-key" },
  ])
    expect((await save(overrides)).statusCode).toBeGreaterThanOrEqual(400);
  expect(writes()).toHaveLength(0);
  const { revision, ...current } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...current,
      vendors: current.vendors.map((v) => ({ ...v, enabled: false })),
    },
    revision,
  );
  expect((await save({ aiRevision: 2 })).statusCode).toBe(400);
  expect(writes()).toHaveLength(0);
});

it("marks changed vendor credentials as needing application and resolves the latest settings", async () => {
  await save();
  remoteStatus = "succeeded";
  expect((await get()).json().embedders[0].needsApply).toBe(false);
  const { revision, ...current } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...current,
      vendors: current.vendors.map((v) =>
        v.provider === "openai"
          ? {
              ...v,
              baseUrl: "https://gateway.test/v1",
              apiKey: "rotated-private-key",
            }
          : v,
      ),
    },
    revision,
  );
  const changed = await get();
  expect(changed.json().embedders[0].needsApply).toBe(true);
  expect(changed.body).not.toContain("rotated-private-key");
  expect((await save()).statusCode).toBe(409);
  expect((await save({ aiRevision: 2 })).statusCode).toBe(202);
  expect(writes()[1]?.body.knowledge_v1).toMatchObject({
    url: "https://gateway.test/v1/embeddings",
    apiKey: "rotated-private-key",
  });
  expect((await get()).json().embedders[0].needsApply).toBe(false);
});

it("supports compatible embedding APIs without replacing other named embedders", async () => {
  remote.existing = {
    source: "openAi",
    model: "text-embedding-3-small",
    apiKey: "old-private-key",
  };
  const saved = await save({
    modelId: "embedding-local",
    name: "knowledge_v2",
  });
  expect(saved.statusCode).toBe(202);
  expect(Object.keys(writes()[0]!.body)).toEqual(["knowledge_v2"]);
  expect(writes()[0]!.body.knowledge_v2).toMatchObject({
    source: "rest",
    dimensions: 1024,
    apiKey: null,
    request: {
      model: "local-embedding-model",
      input: ["{{text}}", "{{..}}"],
      encoding_format: "float",
    },
    response: { data: [{ embedding: "{{embedding}}" }, "{{..}}"] },
  });
  const configs = (await get()).json().embedders;
  expect(configs).toHaveLength(2);
  expect(configs.find((e: any) => e.name === "knowledge_v2")).toMatchObject({
    supported: true,
    model: "local-embedding-model",
    dimensions: 1024,
  });
  remoteStatus = "succeeded";
  remote.knowledge_v2.apiKey = "old-private-key";
  await save({ modelId: "embedding-local", name: "knowledge_v2" });
  expect(remote.knowledge_v2.apiKey).toBeNull();
});

it("reports failed or uncertain tasks without exposing provider errors or automatically resubmitting", async () => {
  await save();
  remoteStatus = "failed";
  const failed = await get(root + "/status");
  expect(failed.json().status).toBe("failed");
  expect(failed.body).not.toContain("model-private-key");
  ambiguous = true;
  const result = await save();
  expect(result.statusCode).toBe(502);
  expect(result.body).not.toContain("model-private-key");
  expect((await get(root + "/status")).json().status).toBe("unknown");
  await app.close();
  app = await setup();
  await get();
  await get(root + "/status");
  expect(writes()).toHaveLength(2);
});

it("does not expose or overwrite unsupported custom embedder payloads", async () => {
  remote.custom = {
    source: "rest",
    url: "https://custom.test/embed",
    apiKey: "model-private-key",
    request: { secret: "payload-private-key", text: "{{text}}" },
    headers: { Authorization: "header-private-key" },
  };
  const read = await get();
  expect(read.json().embedders[0].supported).toBe(false);
  expect(read.body).not.toContain("private-key");
  expect((await save({ name: "custom" })).statusCode).toBe(400);
  expect(writes()).toHaveLength(0);
});

it("deletes named Meilisearch embedders including unsupported leftovers", async () => {
  expect((await remove({ name: "missing" })).statusCode).toBe(404);
  expect((await save()).statusCode).toBe(202);
  expect((await remove()).statusCode).toBe(409);
  remoteStatus = "succeeded";
  expect((await get(root + "/status")).json()).toMatchObject({
    status: "succeeded",
    action: "apply",
  });
  const deleting = await remove();
  expect(deleting.statusCode).toBe(202);
  expect(deleting.json()).toMatchObject({
    action: "delete",
    name: "knowledge_v1",
  });
  expect(writes().at(-1)?.body).toEqual({ knowledge_v1: null });
  expect(remote.knowledge_v1).toBeUndefined();
  expect((await get(root + "/status")).json()).toMatchObject({
    status: "succeeded",
    action: "delete",
  });
  expect((await get()).json().embedders).toEqual([]);
  expect(
    await db.selectFrom("search_embedding_models").selectAll().execute(),
  ).toEqual([]);

  remote.custom = {
    source: "rest",
    url: "https://custom.test/embed",
    apiKey: "model-private-key",
    request: { secret: "payload-private-key", text: "{{text}}" },
    headers: { Authorization: "header-private-key" },
  };
  const leftover = await remove({ name: "custom" });
  expect(leftover.statusCode).toBe(202);
  expect(leftover.body).not.toContain("private-key");
  expect(writes().at(-1)?.body).toEqual({ custom: null });
  await get(root + "/status");
  expect((await get()).json().embedders).toEqual([]);

  expect((await save()).statusCode).toBe(202);
  await get(root + "/status");
  remote = {};
  const count = writes().length;
  const localOnly = await remove();
  expect(localOnly.statusCode).toBe(200);
  expect(localOnly.json()).toMatchObject({
    action: "delete",
    status: "succeeded",
  });
  expect(writes()).toHaveLength(count);
  expect((await get()).json().embedders).toEqual([]);
  expect((await get("/test-search?q=出差&mode=ai")).statusCode).toBe(503);
});

it("serializes simultaneous configuration submissions", async () => {
  const results = await Promise.all([save(), save({ name: "knowledge_v2" })]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
  expect(writes()).toHaveLength(1);
});

it("recovers an interrupted submission as unknown without automatically applying a model", async () => {
  await db
    .updateTable("search_embedding_task")
    .set({
      operation_id: "interrupted",
      endpoint: "http://127.0.0.1:7700",
      index_name: "doca",
      embedder_name: "knowledge_v1",
      task_uid: null,
      status: "submitting",
      updated_at: "2020-01-01T00:00:00.000Z",
    })
    .where("id", "=", "system")
    .execute();
  expect((await get(root + "/status")).json().status).toBe("unknown");
  expect(writes()).toHaveLength(0);
  await save();
  remoteStatus = "succeeded";
  expect((await get()).json().embedders[0]).toMatchObject({
    modelId: "embedding-openai",
    needsApply: false,
  });
});

it("uses the multimodal request shape for Doubao and reads the same binding back", async () => {
  const { revision, ...config } = await aiConfig(db);
  const selected = config.models.find((m) => m.id === "embedding-openai")!;
  await saveAIConfig(
    db,
    {
      ...config,
      models: config.models.map((m) =>
        m.id === selected.id
          ? {
              ...m,
              embeddingApi: "doubao-multimodal",
              embeddingDimensions: 2048,
            }
          : m,
      ),
    },
    revision,
  );
  expect((await save({ aiRevision: revision + 1 })).statusCode).toBe(202);
  expect(writes()[0]?.body.knowledge_v1).toMatchObject({
    source: "rest",
    url: "https://api.openai.com/v1/embeddings/multimodal",
    dimensions: 2048,
    request: {
      model: selected.model,
      input: [{ type: "text", text: "{{text}}" }],
    },
    response: { data: { embedding: "{{embedding}}" } },
  });
  // Meilisearch may serialize object keys in a different order.
  remote.knowledge_v1.request.input = [{ text: "{{text}}", type: "text" }];
  expect((await get()).json().embedders[0]).toMatchObject({
    supported: true,
    modelId: selected.id,
  });
});

it("retains the saved model and content settings before application, after failure and after restart", async () => {
  const draft = {
    documentTemplate: "标题：{{doc.title}} 正文：{{doc.text}}",
    documentTemplateMaxBytes: 1234,
  };
  expect((await save(draft)).statusCode).toBe(202);
  // Real Meilisearch does not expose settings until the asynchronous task succeeds.
  remote = {};
  await app.close();
  app = await setup();
  expect((await get()).json().embedders[0]).toMatchObject({
    ...draft,
    modelId: "embedding-openai",
    remotePresent: false,
    needsApply: true,
  });
  remoteStatus = "failed";
  const failed = (await get()).json();
  expect(failed.task.status).toBe("failed");
  expect(failed.embedders[0]).toMatchObject({
    ...draft,
    modelId: "embedding-openai",
    needsApply: true,
  });
  broken = true;
  const disconnected = (await get()).json();
  expect(disconnected.notice).toBeTruthy();
  expect(disconnected.embedders[0]).toMatchObject({
    ...draft,
    modelId: "embedding-openai",
  });
  expect(writes()).toHaveLength(1);
});

it("excludes shared-brand neighbours for platform and assistant search", async () => {
  const content = createContent(db);
  const target = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "🎯 doca问题记录2.0",
  });
  const neighbour = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "绘本项目说明 DOCA",
  });
  const outside = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "doca问题记录（范围外）",
  });
  hits = [
    { id: neighbour.id, _rankingScore: 0.98 },
    { id: target.id, _rankingScore: 0.71 },
    { id: outside.id, _rankingScore: 0.99 },
  ];
  await save();
  remoteStatus = "succeeded";
  const query = "帮我找一下doca问题记录文档";
  const scope = {
    actor,
    allowedResources: [target.id, neighbour.id],
    exactResources: true,
  };
  const result = await searchKnowledge(
    db,
    scope,
    { query },
    searchService.search,
  );
  expect(result.items.map((r) => r.id)).toEqual([target.id]);
  expect(calls.filter((c) => c.path.endsWith("/search")).at(-1)?.body.q).toBe(
    "doca问题记录",
  );
  const platform = await searchService.search(actor, {
    q: query,
    mode: "ai",
    matchedIds: [target.id, neighbour.id],
  });
  expect(platform.items.map((r) => r.id)).toEqual([target.id]);
  expect(platform).toMatchObject({ total: 1, nextOffset: null });
  broken = true;
  const fallback = await searchKnowledge(
    db,
    scope,
    { query },
    searchService.search,
  );
  expect(fallback.items.map((r) => r.id)).toContain(target.id);
  expect(fallback.items[0]?.id).toBe(target.id);
  const withoutSearchService = await searchKnowledge(db, scope, { query });
  expect(withoutSearchService.items.map((r) => r.id)).toEqual([target.id]);
});

it("returns a successful empty result when high-score candidates have no relevant current source", async () => {
  const content = createContent(db);
  const unrelated = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "绘本项目说明 DOCA",
  });
  // Stale remote titles/snippets and high scores are not evidence of relevance.
  hits = [
    {
      id: unrelated.id,
      _rankingScore: 0.99,
      title: "doca问题记录",
      summary: "doca问题记录",
    },
  ];
  await save();
  remoteStatus = "succeeded";
  const query = "帮我找一下 doca 问题记录文档";
  const ctx = { actor, allowedResources: [unrelated.id], exactResources: true };
  for (const mode of ["ai", "auto", "keyword"] as const) {
    for (const offset of [0, 100]) {
      const page = await searchService.search(actor, {
        q: query,
        mode,
        offset,
      });
      expect(page).toMatchObject({
        items: [],
        total: 0,
        nextOffset: null,
        engine: "meilisearch",
      });
    }
    expect(
      await searchKnowledge(db, ctx, { query, mode }, searchService.search),
    ).toMatchObject({ items: [], nextOffset: null });
  }
  broken = true;
  expect(
    await searchService.search(actor, { q: query, mode: "auto" }),
  ).toMatchObject({ items: [], total: 0, engine: "database" });
  expect(
    (await searchKnowledge(db, ctx, { query }, searchService.search)).items,
  ).toEqual([]);
  expect((await searchKnowledge(db, ctx, { query })).items).toEqual([]);
});

it("checks the full current body and filters before counting and pagination", async () => {
  const content = createContent(db);
  const unrelated = [];
  for (let i = 0; i < 101; i++) {
    unrelated.push(
      await content.create(actor, {
        kind: "document",
        format: "markdown",
        title: `DOCA 绘本方案 ${i}`,
      }),
    );
  }
  const target = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "doca问题记录",
  });
  const bodyHit = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "处理日志",
  });
  await db
    .insertInto("document_states")
    .values({
      resource_id: bodyHit.id,
      codec: "test",
      checkpoint: "",
      checkpoint_seq: 0,
      seq: 0,
      text: [
        "DOCA 使用说明。" + "前言。".repeat(100),
        "问题分类。" + "说明。".repeat(100),
        "记录处理结果。",
      ].join("\n"),
      updated_at: new Date().toISOString(),
    })
    .execute();
  hits = [
    ...unrelated.map((item) => ({ id: item.id, _rankingScore: 0.99 })),
    { id: target.id, _rankingScore: 0.8 },
    { id: bodyHit.id, _rankingScore: 0.8 },
  ];
  await save();
  remoteStatus = "succeeded";
  const page = await searchService.search(actor, {
    q: "doca问题记录",
    mode: "ai",
  });
  expect(page.items.map((item) => item.id)).toEqual([target.id, bodyHit.id]);
  expect(page).toMatchObject({ total: 2, nextOffset: null });
  const bodyResult = page.items[1]!;
  const excerpt = "summary" in bodyResult ? bodyResult.summary : "";
  expect(
    ["doca", "问题", "记录"].every((term) =>
      excerpt.toLowerCase().includes(term),
    ),
  ).toBe(false);
  expect(page.items[1]).not.toHaveProperty("searchRelevant");
  expect(page.items[1]).not.toHaveProperty("searchCoverage");
  const second = await searchService.search(actor, {
    q: "doca问题记录",
    mode: "ai",
    offset: 1,
  });
  expect(second.items.map((item) => item.id)).toEqual([bodyHit.id]);
  expect(second).toMatchObject({ total: 2, nextOffset: null });
  await db
    .updateTable("document_states")
    .set({ text: "已改为与查询无关的介绍。" })
    .where("resource_id", "=", bodyHit.id)
    .execute();
  const updated = await searchService.search(actor, {
    q: "doca问题记录",
    mode: "ai",
  });
  expect(updated.items.map((item) => item.id)).toEqual([target.id]);
  expect(updated.total).toBe(1);
});

it("uses native Meilisearch vectors only in AI mode, preserves ranking, and returns current authorized summaries", async () => {
  const content = createContent(db);
  const first = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "出差制度",
  });
  const second = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "财务指引",
  });
  await db
    .insertInto("document_states")
    .values({
      resource_id: first.id,
      codec: "test",
      checkpoint: "",
      checkpoint_seq: 0,
      seq: 0,
      text: "员工出差的交通和住宿费用，可以提交票据申请报销。",
      updated_at: new Date().toISOString(),
    })
    .execute();
  await db
    .insertInto("document_states")
    .values({
      resource_id: second.id,
      codec: "test",
      checkpoint: "",
      checkpoint_seq: 0,
      seq: 0,
      text: "财务审批时间为每周五。",
      updated_at: new Date().toISOString(),
    })
    .execute();
  await db
    .updateTable("resources")
    .set({ updated_at: "2020-01-01T00:00:00Z" })
    .where("id", "=", first.id)
    .execute();
  hits = [
    { id: first.id, summary: "DO NOT TRUST REMOTE TEXT" },
    { id: second.id },
    { id: "outside-scope" },
    { id: first.id },
  ];
  expect((await get("/test-search?q=出差&mode=ai")).statusCode).toBe(503);
  await save();
  remoteStatus = "succeeded";
  const result = await get("/test-search?q=如何报销交通费&mode=ai");
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    mode: "ai",
    engine: "meilisearch",
    total: 1,
  });
  expect(result.json().items.map((r: any) => r.id)).toEqual([first.id]);
  expect(result.json().items[0].summary).toContain("票据申请报销");
  expect(result.body).not.toContain("DO NOT TRUST");
  expect(
    calls.filter((c) => c.path.endsWith("/search")).at(-1)?.body.hybrid,
  ).toEqual({ embedder: "knowledge_v1", semanticRatio: 0.8 });
  await get("/test-search?q=出差");
  expect(
    calls.filter((c) => c.path.endsWith("/search")).at(-1)?.body.hybrid,
  ).toBeUndefined();
  broken = true;
  expect((await get("/test-search?q=出差&mode=ai")).statusCode).toBe(503);
  const fallback = await get("/test-search?q=出差");
  expect(fallback.json()).toMatchObject({
    mode: "keyword",
    engine: "database",
    total: 1,
  });
  expect(fallback.json().items[0].summary).toContain("票据申请报销");
});

it("scopes Agent and MCP search before retrieval and pagination, with source snippets and explicit fallback", async () => {
  const content = createContent(db);
  const allowed = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "授权文档",
  });
  const unrelated = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "范围外文档",
  });
  await db
    .insertInto("document_states")
    .values({
      resource_id: allowed.id,
      codec: "test",
      checkpoint: "",
      checkpoint_seq: 0,
      seq: 0,
      text: "用户授权的知识内容。",
      updated_at: new Date().toISOString(),
    })
    .execute();
  hits = [{ id: unrelated.id }, { id: allowed.id }];
  await save();
  remoteStatus = "succeeded";
  const ctx = { actor, allowedResources: [allowed.id], exactResources: true };
  const result = await searchKnowledge(
    db,
    ctx,
    { query: "知识内容" },
    searchService.search,
  );
  expect(result.mode).toBe("ai");
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    id: allowed.id,
    snippet: "用户授权的知识内容。",
    url: `#/r/${allowed.id}`,
  });
  const request = calls.filter((c) => c.path.endsWith("/search")).at(-1)!;
  expect(request.body.filter).toContain(allowed.id);
  expect(request.body.filter).not.toContain(unrelated.id);
  broken = true;
  const fallback = await searchKnowledge(
    db,
    ctx,
    { query: "文档" },
    searchService.search,
  );
  expect(fallback).toMatchObject({ mode: "keyword", engine: "database" });
  expect(fallback.notice).toBeTruthy();
  expect(fallback.items.map((r) => r.id)).toEqual([allowed.id]);
});

it("filters low semantic scores, reranks close matches using source terms, and changes the threshold without re-embedding", async () => {
  const content = createContent(db);
  const editor = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "Slate 富文本编辑器",
  });
  const sheet = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "在线电子表格",
  });
  for (const [doc, text] of [
    [editor, "支持多人一起修改文字、插入表格、列表和协作编辑。"],
    [sheet, "单元格公式、筛选和图表数据分析。"],
  ] as const)
    await db
      .insertInto("document_states")
      .values({
        resource_id: doc.id,
        codec: "test",
        checkpoint: "",
        checkpoint_seq: 0,
        seq: 0,
        text,
        updated_at: new Date().toISOString(),
      })
      .execute();
  hits = [
    { id: sheet.id, _rankingScore: 0.7862 },
    { id: editor.id, _rankingScore: 0.7775 },
    { id: "irrelevant", _rankingScore: 0.66 },
  ];
  await save();
  remoteStatus = "succeeded";
  const result = await get(
    "/test-search?mode=ai&q=" +
      encodeURIComponent("支持多人一起修改文字并插入表格的编辑工具"),
  );
  expect(result.json().items.map((r: any) => r.id)).toEqual([editor.id]);
  expect(
    calls.filter((c) => c.path.endsWith("/search")).at(-1)?.body
      .rankingScoreThreshold,
  ).toBe(0.7);
  const count = writes().length;
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/search/relevance",
        payload: { minScore: 0.85 },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/search/relevance",
        headers,
        payload: { minScore: 1.1 },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/search/relevance",
        headers,
        payload: { minScore: 0.85 },
      })
    ).statusCode,
  ).toBe(200);
  expect((await get()).json().minScore).toBe(0.85);
  expect((await get("/test-search?mode=ai&q=编辑器")).json().total).toBe(0);
  expect(writes()).toHaveLength(count);
});
