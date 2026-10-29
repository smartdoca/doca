import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { createContent } from "@core/workflows/resources.js";
import { readAIDocument } from "@core/workflows/ai-documents.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import { aiSessionFolderId } from "../apps/server/src/services/ai/file-locations.js";
import { mockAI, completionResponse } from "./ai-mock.js";

const origin = "http://localhost:39309",
  password = "isolated-ai-folders-password";
let db: Awaited<ReturnType<typeof openTestDatabase>>;
let app: Awaited<ReturnType<typeof createApp>>;
let root: string,
  owner: Actor,
  headers: Record<string, string>,
  other: Record<string, string>;
let toolPlan: Array<{ name: string; args: unknown; copies?: number }>, toolResults: any[];
let modelRequests: any[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-ai-session-folders-"));
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await createUser(
    db,
    { login: "other", displayName: "Other", password },
    { actor: owner },
  );
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      vendors: [
        {
          id: "test",
          name: "Test",
          provider: "compatible",
          baseUrl: "https://mock.invalid/v1",
          apiKey: "test-key",
          enabled: true,
        },
      ],
      models: [
        {
          id: "test",
          vendorId: "test",
          model: "mock",
          alias: "Mock",
          enabled: true,
          maxInput: 64000,
          maxOutput: 1000,
          tools: true,
        },
        {
          id: "image",
          vendorId: "test",
          model: "mock-image",
          alias: "Image",
          enabled: true,
          maxInput: 32000,
          maxOutput: 1000,
          tools: false,
          imageGeneration: true, imageProfile: "gpt-image-2",
        },
      ],
    },
    0,
  );
  toolPlan = [];
  toolResults = [];
  modelRequests = [];
  const fallback = mockAI();
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    search: {
      allowedOrigins: ["http://127.0.0.1:7700"],
      fetch: async (url) => Response.json(String(url).endsWith("/search") ? { hits: [] } : {}),
    },
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        modelRequests.push(body);
        if (
          !toolPlan.length ||
          body.tools?.some(
            (tool: any) => tool.function?.name === "submit_review",
          )
        )
          return fallback(url, init);
        const messages: any[] = body.messages ?? [];
        const lastUser = messages.findLastIndex(
          (message) => message.role === "user",
        );
        const results = messages
          .slice(lastUser + 1)
          .filter((message) => message.role === "tool");
        toolResults = results.map((message) => {
          try { return JSON.parse(message.content); }
          catch { return { error: true, message: String(message.content) }; }
        });
        const planned = toolPlan[results.length];
        const args = typeof planned?.args === "function"
          ? await planned.args(toolResults) : planned?.args;
        return completionResponse(
          {
            id: "session-folder-test",
            object: "chat.completion",
            created: 1,
            model: "mock",
            choices: [
              {
                index: 0,
                finish_reason: planned ? "tool_calls" : "stop",
                message: planned
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: Array.from({ length: planned.copies ?? 1 }, (_, index) => (
                        {
                          id: `folder-test-${results.length}-${index}`,
                          type: "function",
                          function: {
                            name: planned.name,
                            arguments: JSON.stringify(args),
                          },
                        }
                      )),
                    }
                  : { role: "assistant", content: "文件夹已查看。" },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
            },
          },
          !!body.stream,
        );
      }) as typeof fetch,
    },
  });
  const login = async (name: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39309", origin },
      payload: { login: name, password },
    });
    return {
      host: "localhost:39309",
      origin,
      cookie: String(response.headers["set-cookie"]).split(";")[0]!,
    };
  };
  headers = await login("owner");
  other = await login("other");
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});

async function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: any,
  auth = headers,
) {
  return app.inject({ method, url: "/api/v1" + path, headers: auth, payload });
}
async function upload(name: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/assets?purpose=ai_attachment&filename=${encodeURIComponent(name)}`,
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: Buffer.from("Isolated AI folder fixture"),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}
async function session(title = "会话文件夹") {
  const response = await request("POST", "/ai/sessions", {
    modelId: "test",
    resourceIds: [],
  });
  expect(response.statusCode, response.body).toBe(200);
  const id = response.json().id as string;
  await request("PATCH", `/ai/sessions/${id}`, { title });
  return id;
}
async function send(
  sessionId: string,
  attachments: string[],
  extra: Record<string, unknown> = {},
) {
  const response = await request("POST", `/ai/sessions/${sessionId}/messages`, {
    id: randomUUID(),
    text: "查看文件夹资料",
    modelId: "test",
    scope: "all",
    attachments,
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(200);
  await vi.waitFor(
    async () => {
      const job = await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", response.json().id)
        .executeTakeFirstOrThrow();
      expect(job.status, job.error).toBe("completed");
    },
    { timeout: 15000, interval: 25 },
  );
  return response;
}
async function aiPage(id = "ai", auth = headers) {
  return request(
    "GET",
    `/files?parentType=system&parentId=${encodeURIComponent(id)}`,
    undefined,
    auth,
  );
}

it("creates a long report request as one online rich-text document and provides consistent format guidance", async () => {
  const title = "日本校园霸凌调查报告";
  toolPlan = [
    { name: "document_create", args: { title } },
    { name: "document_read", args: (results: any[]) => ({ resourceId: results[0].id }) },
    { name: "rich_text_edit", args: (results: any[]) => ({
      resourceId: results[0].id, seq: results[1].seq, epochId: results[1].epochId,
      operations: [{ type: "append", text: "隔离测试报告正文：现状、成因和治理建议。" }],
    }) },
  ];
  const sent = await send(await session(), [], {
    text: "帮我写一篇关于调研日本校园霸凌的调查文档",
    skipApprovals: { create: true },
  });
  const resources = await db.selectFrom("resources").selectAll()
    .where("title", "=", title).execute();
  expect(resources).toHaveLength(1);
  expect(resources[0]?.format).toBe("rich_text");
  expect(await db.selectFrom("file_items").selectAll().execute()).toHaveLength(0);
  expect(toolResults[2]).toMatchObject({ saved: true });
  const executor = modelRequests.find((body) => body.tools?.some((tool: any) => tool.function?.name === "file_create"));
  const prompt = JSON.stringify(executor);
  expect(prompt).toContain("默认 document_create 创建在线富文本文档");
  expect(prompt).toContain("本轮已自动加载的文档编辑 skill：writing");
  expect(prompt).not.toContain("研究报告或 Word/Excel/PDF/Markdown 文件用 file_create");
  const saved = await readAIDocument(db, { actor: owner }, resources[0]!.id);
  expect(JSON.stringify(saved.value)).toContain("隔离测试报告正文");
  const deliveries = await db.selectFrom("ai_operations").selectAll()
    .where("job_id", "=", sent.json().id).execute();
  expect(deliveries.filter((operation) => JSON.parse(operation.result).id === resources[0]!.id)).toHaveLength(1);
});

it.each([1, 3])("replays approved Word creation %i times with one saved file and durable delivery", async (copies) => {
  const args = { format: "word", name: "隔离调研报告", content: "# 调查报告\n\n隔离测试正文。" };
  toolPlan = copies === 1
    ? Array.from({ length: 3 }, () => ({ name: "file_create", args }))
    : [{ name: "file_create", args, copies }];
  const sessionId = await session();
  const sent = await request("POST", `/ai/sessions/${sessionId}/messages`, {
    id: randomUUID(), text: "帮我写一份 Word 调研报告", modelId: "test", scope: "all",
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const jobId = sent.json().id;
  let approvalId: string;
  await vi.waitFor(async () => {
    const job = await db.selectFrom("ai_jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
    expect(job.status, job.error).toBe("awaiting_approval");
    const approvals = JSON.parse(job.result).progress.approvals;
    expect(approvals).toHaveLength(1);
    approvalId = approvals[0].id;
    expect(await db.selectFrom("file_items").selectAll().execute()).toHaveLength(0);
}, { timeout: 10000, interval: 25 });
  expect((await request("POST", `/ai/jobs/${jobId}/approval`, { approvalId: approvalId!, approved: true })).statusCode).toBe(200);
  await vi.waitFor(async () => {
    const job = await db.selectFrom("ai_jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
    expect(job.status, job.error).toBe("completed");
  }, { timeout: 15000, interval: 25 });
  const files = await db.selectFrom("file_items").selectAll().execute();
  expect(files).toHaveLength(1);
  expect(files[0]?.name).toBe("隔离调研报告.docx");
  expect(toolResults).toHaveLength(3);
  expect(toolResults.every((result) => result.ok && result.file.id === files[0]?.id)).toBe(true);
  const deliveries = await db.selectFrom("ai_operations").selectAll().where("job_id", "=", jobId).execute();
  expect(deliveries).toHaveLength(1);
  expect(JSON.parse(deliveries[0]!.result)).toMatchObject({ kind: "file_item", id: files[0]?.id });
  expect(JSON.stringify(modelRequests)).toContain("仅对尚未执行成功的操作重试原始工具调用");
  expect((await request("GET", `/files/items/${files[0]!.id}/content`)).statusCode).toBe(200);
});

it("does not recreate a deleted export when the same creation is retried", async () => {
  const args = { format: "word", name: "删除后的报告", content: "隔离测试正文" };
  toolPlan = [
    { name: "file_create", args },
    { name: "file_create", args: async (results: any[]) => {
      await db.updateTable("file_items").set({ deleted_at: new Date().toISOString(), delete_batch: randomUUID() })
        .where("id", "=", results[0].file.id).execute();
      return args;
    } },
  ];
  await send(await session(), [], { text: "生成 Word 文件", skipApprovals: { create: true } });
  const files = await db.selectFrom("file_items").selectAll().execute();
  expect(files).toHaveLength(1);
  expect(files[0]?.deleted_at).toBeTruthy();
  expect(toolResults[1]).toMatchObject({ error: true });
});
async function fileForAsset(assetId: string) {
  return db
    .selectFrom("file_items")
    .selectAll()
    .where("owner_id", "=", owner.id)
    .where("parent_type", "=", "system")
    .where("parent_id", "=", "ai")
    .where("metadata", "like", `%"assetId":"${assetId}"%`)
    .executeTakeFirstOrThrow();
}

it("returns the exact file node ID at upload without requiring a folder browse", async () => {
  const response = await app.inject({ method: "POST", url: "/api/v1/assets?purpose=ai_attachment&filename=direct-id.txt",
    headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("exact input") });
  expect(response.statusCode).toBe(201);
  const uploaded = response.json();
  const file = await fileForAsset(uploaded.id);
  expect(uploaded.fileId).toBe(file.id);
  expect(JSON.parse(file.metadata).assetId).toBe(uploaded.id);
  expect(file.name).toBe("direct-id.txt");
});

it("groups only new sent attachments, preserves legacy metadata byte for byte and separates same-title sessions", async () => {
  const one = await session("相同标题"),
    two = await session("相同标题");
  const oldAsset = await upload("旧文件.txt"),
    newAsset = await upload("新文件.txt"),
    pending = await upload("未发送.txt");
  const old = await fileForAsset(oldAsset);
  const oldMetadata = JSON.stringify({ assetId: oldAsset, sessionId: one });
  await db
    .updateTable("file_items")
    .set({ metadata: oldMetadata })
    .where("id", "=", old.id)
    .execute();
  expect((await aiPage()).json().folders).toEqual([]);
  await send(one, [oldAsset, newAsset]);
  const secondAsset = await upload("另一个会话.txt");
  await send(two, [secondAsset]);
  const page = (await aiPage()).json();
  expect(page.folders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: aiSessionFolderId(one),
        name: "相同标题",
        virtual: true,
        locked: true,
        parent_id: "ai",
      }),
      expect.objectContaining({
        id: aiSessionFolderId(two),
        name: "相同标题",
        virtual: true,
      }),
    ]),
  );
  expect(page.folders).toHaveLength(2);
  expect(page.files.map((file: any) => file.name).sort()).toEqual(
    ["旧文件.txt", "未发送.txt"].sort(),
  );
  expect((await aiPage(aiSessionFolderId(one))).json().files).toEqual([
    expect.objectContaining({
      id: (await fileForAsset(newAsset)).id,
      name: "新文件.txt",
      locked: true,
    }),
  ]);
  expect(
    (await aiPage(aiSessionFolderId(two)))
      .json()
      .files.map((file: any) => file.name),
  ).toEqual(["另一个会话.txt"]);
  expect((await fileForAsset(oldAsset)).metadata).toBe(oldMetadata);
  expect(
    JSON.parse((await fileForAsset(pending)).metadata).aiSessionFolder
      .sessionId,
  ).toBeNull();
  expect(
    await db.selectFrom("file_folders").selectAll().execute(),
  ).toHaveLength(0);
  expect((await aiPage(aiSessionFolderId(one), other)).statusCode).toBe(404);
  expect((await aiPage("ai-session:invalid")).statusCode).toBe(400);
  await send(two, [newAsset]);
  expect(
    JSON.parse((await fileForAsset(newAsset)).metadata).aiSessionFolder
      .sessionId,
  ).toBe(one);
});

it("tracks long session titles, retains archived files, and makes search links open the session folder", async () => {
  const id = await session(),
    asset = await upload("归档资料.txt");
  await send(id, [asset]);
  const title =
    "这是一段非常长的会话标题用于验证完整名称保留以及界面省略显示".repeat(2);
  expect(
    (await request("PATCH", `/ai/sessions/${id}`, { title, archived: true }))
      .statusCode,
  ).toBe(200);
  const folder = (await aiPage()).json().folders[0];
  expect(folder.name).toBe(title);
  const file = (await aiPage(folder.id)).json().files[0];
  expect(file.name).toBe("归档资料.txt");
  expect(
    (await request("GET", `/files/items/${file.id}/content`)).statusCode,
  ).toBe(200);
  const scan = await request("POST", "/files/recognize", {
    parentType: "system",
    parentId: folder.id,
  });
  expect(scan.statusCode, scan.body).toBe(200);
  expect(scan.json().count).toBe(1);
  expect(
    (
      await request(
        "POST",
        "/files/recognize",
        { parentType: "system", parentId: folder.id },
        other,
      )
    ).statusCode,
  ).toBe(404);
  const search = (await request("GET", "/files/search?q=归档资料")).json();
  expect(search.items).toHaveLength(1);
  expect(search.items[0].locations[0].navigation).toEqual([
    { type: "system", id: "ai", name: "AI 助手" },
    { type: "system", id: folder.id, name: title },
  ]);
});

it("deletes the session folder and its files while retaining old files, pending uploads, other sessions, and copied references", async () => {
  const id = await session(),
    otherSession = await session("保留的会话");
  const asset = await upload("要删除.txt"),
    oldAsset = await upload("旧文件.txt"),
    pending = await upload("未发送.txt"),
    retainedAsset = await upload("其他会话.txt");
  const old = await fileForAsset(oldAsset);
  const oldMetadata = JSON.stringify({ assetId: oldAsset, sessionId: id });
  await db
    .updateTable("file_items")
    .set({ metadata: oldMetadata })
    .where("id", "=", old.id)
    .execute();
  await send(id, [asset, oldAsset]);
  await send(otherSession, [retainedAsset]);
  const source = await fileForAsset(asset);
  const copy = await request("POST", `/files/items/${source.id}/copy`, {
    parentType: "system",
    parentId: "root",
  });
  expect(copy.statusCode, copy.body).toBe(200);
  const document = await createContent(db).create(owner, {
    title: "独立文档引用",
    kind: "document",
    format: "markdown",
    markdown: "独立引用测试",
  });
  const docAsset = await request("POST", `/files/items/${source.id}/attach`, {
    purpose: "attachment",
    resourceId: document.id,
  });
  expect(docAsset.statusCode, docAsset.body).toBe(200);
  const physical = await db
    .selectFrom("file_storage_objects")
    .selectAll()
    .where("id", "=", source.storage_object_id)
    .executeTakeFirstOrThrow();
  expect(
    (await request("DELETE", `/ai/sessions/${id}`, undefined, other))
      .statusCode,
  ).toBe(404);
  expect((await request("DELETE", `/ai/sessions/${id}`)).statusCode).toBe(200);
  expect((await aiPage(aiSessionFolderId(id))).statusCode).toBe(404);
  expect(
    (await aiPage()).json().folders.map((folder: any) => folder.id),
  ).toEqual([aiSessionFolderId(otherSession)]);
  expect(
    (await request("GET", `/files/items/${source.id}/content`)).statusCode,
  ).toBe(404);
  expect((await request("GET", `/assets/${asset}/content`)).statusCode).toBe(
    404,
  );
  expect(
    (await request("GET", `/files/items/${copy.json().id}/content`)).body,
  ).toBe("Isolated AI folder fixture");
  expect(
    (await request("GET", `/assets/${docAsset.json().id}/content`)).statusCode,
  ).toBe(200);
  expect(
    await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", physical.id)
      .executeTakeFirst(),
  ).toEqual(physical);
  expect((await fileForAsset(oldAsset)).metadata).toBe(oldMetadata);
  expect((await fileForAsset(pending)).deleted_at).toBeNull();
  expect((await fileForAsset(retainedAsset)).deleted_at).toBeNull();
  expect(
    (await request("GET", "/files/search?q=要删除"))
      .json()
      .items[0].locations.every((location: any) => location.id !== source.id),
  ).toBe(true);
});

it("places newly generated images in their job's session and blocks deletion until the job has stopped", async () => {
  const sessionId = await session("生成图会话"),
    jobId = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id: jobId,
      session_id: sessionId,
      user_id: owner.id,
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
  const data = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#4589af" },
  })
    .png()
    .toBuffer();
  const result = await generateImageAsset(
    db,
    { actor: owner, jobId, lease },
    { prompt: "测试生成图片" },
    randomUUID(),
    {
      storage: { ...storageRuntime(), root },
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: data.toString("base64") }],
        })) as typeof fetch,
    },
  );
  const file = await fileForAsset(result.assetId);
  expect((await aiPage()).json().files).toEqual([]);
  expect((await aiPage(aiSessionFolderId(sessionId))).json().files).toEqual([
    expect.objectContaining({ id: file.id, locked: true }),
  ]);
  expect(
    (await request("DELETE", `/ai/sessions/${sessionId}`)).statusCode,
  ).toBe(409);
  expect(
    (await request("GET", `/assets/${result.assetId}/content`)).statusCode,
  ).toBe(200);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null })
    .where("id", "=", jobId)
    .execute();
  expect(
    (await request("DELETE", `/ai/sessions/${sessionId}`)).statusCode,
  ).toBe(200);
  expect(
    (await request("GET", `/files/items/${file.id}/content`)).statusCode,
  ).toBe(404);
});

it("lets the AI browse and search virtual session folders and retain them as the current folder", async () => {
  const id = await session("工具验证会话"),
    asset = await upload("工具资料.txt");
  await send(id, [asset]);
  const file = await fileForAsset(asset),
    folderId = aiSessionFolderId(id);
  toolPlan = [
    { name: "file_browse", args: { folderId: "ai" } },
    { name: "file_browse", args: { folderId } },
    { name: "file_browse", args: { fileId: file.id } },
    { name: "file_search", args: { query: "工具资料", folderId } },
    { name: "file_search", args: { query: "工具火星发射流程", folderId } },
  ];
  await send(id, [], { currentFolder: { type: "system", id: folderId } });
  expect(toolResults).toHaveLength(5);
  expect(toolResults[0].folders).toEqual([
    expect.objectContaining({ id: folderId, name: "工具验证会话" }),
  ]);
  expect(toolResults[0].files).toEqual([]);
  expect(toolResults[1].files).toEqual([
    expect.objectContaining({ id: file.id, movable: false }),
  ]);
  expect(toolResults[2].node.parentId).toBe(folderId);
  expect(toolResults[3].files[0]).toMatchObject({
    id: file.id,
    folderId,
    movable: false,
  });
  expect(decodeURIComponent(toolResults[3].files[0].href)).toContain(folderId);
  expect(toolResults[4].files).toEqual([]);
  await db.updateTable("search_settings").set({
    enabled: 1, endpoint: "http://127.0.0.1:7700", index_name: "doca",
  }).where("id", "=", "system").execute();
  toolPlan = [{ name: "file_search", args: { query: "工具资料", folderId } }];
  await send(id, [], { currentFolder: { type: "system", id: folderId } });
  expect(toolResults).toHaveLength(1);
  expect(toolResults[0].files).toEqual([]);
});
