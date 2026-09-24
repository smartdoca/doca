import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import {
  aiDefaults,
  saveAIConfig,
  aiConfig,
  availableModels,
} from "@core/modules/ai/config.js";
import {
  aiPeriods,
  reserveCall,
  settleCall,
  quotaSummary,
} from "@core/modules/ai/quota.js";
import {
  createAIDocument,
  editAIDocument,
  readAIDocument,
  previewAIDocument,
} from "@core/workflows/ai-documents.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  createAIMemory,
  memoryOwner,
  saveChatMessage,
} from "../apps/server/src/services/ai/memory.js";
import { mockAI, completionResponse } from "./ai-mock.js";
import {
  surfaceCodec,
  DEFAULT_SPREADSHEET_SCHEMA,
} from "@core/modules/documents/codecs/surfaces.js";
import { PPT_SCHEMA } from "@core/modules/documents/codecs/presentation.js";
import type { WebSocket } from "ws";
let db: DB, owner: Actor, other: Actor;
const password = "test-ai-password-2026";
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      { login: "other", displayName: "Other", password },
      { actor: owner },
    )),
    admin: 0,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
});
async function configured() {
  const c = {
    ...aiDefaults,
    defaultModel: "test",
    memoryEnabled: true,
    limits: { standard: { day: 1000, week: 3000, month: 10000 } },
    vendors: [
      {
        id: "test-vendor",
        name: "测试厂商",
        provider: "compatible",
        baseUrl: "https://model.example.test/v1",
        apiKey: "private-key-test",
        enabled: true,
      },
    ],
    models: [
      {
        id: "test",
        vendorId: "test-vendor",
        model: "private-real-model",
        alias: "创作助手",
        enabled: true,
        levels: [],
        inputRate: 1,
        outputRate: 2,
        cacheRate: 0.5,
        maxInput: 32000,
        maxOutput: 1000,
        tools: true,
      },
    ],
  };
  await saveAIConfig(db, c, 0);
  return c;
}
it("uses natural calendar weeks across months and years", () => {
  expect(aiPeriods("Asia/Shanghai", new Date("2025-12-31T17:00:00Z"))).toEqual({
    day: "2026-01-01",
    week: "2025-12-29",
    month: "2026-01",
  });
});
it("retries failed tasks with original inputs, rejects foreign retries, and exposes associated documents", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    {
      ...c,
      limits: { standard: { day: null, week: null, month: null } },
      webSearch: { provider: "tavily", apiKey: "private-search-key" },
    },
    1,
  );
  const doc = await createContent(db).create(owner, {
    title: "关联测试",
    kind: "document",
    format: "markdown",
    markdown: "# 关联测试\n\n验收内容",
  });
  let failOnce = true;
  const fallback = mockAI({ chunkDelay: 5 });
  const origin = "http://localhost:39135";
  const app = await createApp(db, {
    origin,
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: async (...args) => {
        if (failOnce) {
          failOnce = false;
          return Response.json(
            { error: { message: "transient failure", type: "server_error" } },
            { status: 500 },
          );
        }
        return fallback(...args);
      },
    },
  });
  const request = (method: any, path: string, cookie: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39135", origin, cookie },
      payload,
    });
  try {
    const login = async (name: string) =>
      String(
        (await request("POST", "/auth/login", "", { login: name, password }))
          .headers["set-cookie"],
      ).split(";")[0]!;
    const a = await login("owner"),
      b = await login("other");
    const adminBody = (await request("GET", "/admin/ai", a)).json();
    expect(JSON.stringify(adminBody)).not.toContain("private-search-key");
    expect(adminBody.config.webSearch.hasKey).toBe(true);
    const sid = (
      await request("POST", "/ai/sessions", a, {
        modelId: "test",
        resourceIds: [doc.id],
      })
    ).json().id;
    const first = randomUUID();
    await request("POST", `/ai/sessions/${sid}/messages`, a, {
      id: first,
      text: "总结这份文档",
      modelId: "test",
      scope: "document",
      references: [{ resourceId: doc.id }],
    });
    const wait = async (jobId: string) => {
      for (let i = 0; i < 160; i++) {
        const result = (await request("GET", `/ai/sessions/${sid}`, a)).json();
        const job = result.jobs.find((j: any) => j.id === jobId);
        if (job && !["queued", "running"].includes(job.status)) return result;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw Error("job timeout");
    };
    expect((await wait(first)).jobs[0].status).toBe("failed");
    const retryPayload = {
      id: randomUUID(),
      retryOf: first,
      modelId: "test",
      text: "不能覆盖原要求",
      scope: "all",
    };
    expect(
      (await request("POST", `/ai/sessions/${sid}/messages`, b, retryPayload))
        .statusCode,
    ).toBe(404);
    const retry = await request(
      "POST",
      `/ai/sessions/${sid}/messages`,
      a,
      retryPayload,
    );
    expect(retry.statusCode, retry.body).toBe(200);
    const result = await wait(retry.json().id);
    expect(result.jobs.find((j: any) => j.id === retry.json().id).status).toBe(
      "completed",
    );
    expect(
      result.messages.find((m: any) => m.id === retry.json().id).text,
    ).toBe("总结这份文档");
    expect(result.resources).toEqual([
      { id: doc.id, title: "关联测试", format: "markdown", kind: "document" },
    ]);
    const repeated = await request("POST", `/ai/sessions/${sid}/messages`, a, {
      ...retryPayload,
      id: randomUUID(),
    });
    expect(repeated.json().id).toBe(retry.json().id);
    const sessions = (
      await request("GET", `/ai/sessions?resourceId=${doc.id}`, a)
    ).json();
    expect(sessions[0]).toMatchObject({ id: sid, running: false });
    expect(
      (await request("GET", `/ai/sessions?resourceId=${doc.id}`, b)).json(),
    ).toEqual([]);
  } finally {
    await app.close();
  }
}, 30000);
it("reserves across base and bonus, settles once and preserves historical rates", async () => {
  await configured();
  await db
    .insertInto("ai_grants")
    .values({
      id: randomUUID(),
      user_id: owner.id,
      amount: 500000,
      remaining: 500000,
      expires_at: null,
      reason: "test",
      actor_id: owner.id,
      created_at: new Date().toISOString(),
    })
    .execute();
  const a = await reserveCall(db, owner.id, "test", null, 900_000_000, 200_000_000);
  expect((await quotaSummary(db, owner.id)).bonus).toBe(200);
  await expect(
    reserveCall(db, owner.id, "test", null, 300_000_000, 1_000_000),
  ).rejects.toThrow("积分不足");
  const c = await aiConfig(db);
  const { revision, ...body } = c;
  body.models[0]!.inputRate = 3;
  await saveAIConfig(db, body, revision);
  const usage = { input: 800_000_000, output: 150_000_000, cached: 200_000_000 };
  await settleCall(db, a.id, usage);
  await settleCall(db, a.id, usage);
  const summary = await quotaSummary(db, owner.id);
  expect(summary.used).toEqual({ day: 1000, week: 1000, month: 1000 });
  expect(summary.bonus).toBe(500);
  expect(summary.calls[0]!.points).toBe(1000);
  expect(summary.calls[0]!.input).toBe(800_000_000);
});
it("keeps unknown usage reserved until reconciliation, without treating failures as free", async () => {
  await configured();
  const c = await reserveCall(db, owner.id, "test", null, 800_000_000, 50_000_000);
  await settleCall(db, c.id, null);
  const q = await quotaSummary(db, owner.id);
  expect(q.used.day).toBe(900);
  expect(q.calls[0]?.state).toBe("pending");
});
it("serializes concurrent reservations and excludes expired credit grants", async () => {
  await configured();
  await db
    .insertInto("ai_grants")
    .values({
      id: randomUUID(),
      user_id: owner.id,
      amount: 1000000,
      remaining: 1000000,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      reason: "expired",
      actor_id: owner.id,
      created_at: new Date().toISOString(),
    })
    .execute();
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      reserveCall(db, owner.id, "test", null, 600_000_000, 0),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const q = await quotaSummary(db, owner.id);
  expect(q.used.day).toBe(600);
  expect(q.bonus).toBe(0);
});
it("rejects canvas arrow values that would crash the renderer atomically", async () => {
  const resource = await createContent(db).create(owner, {
    kind: "document",
    format: "canvas",
    title: "Invalid arrow batch",
  });
  const before = await readAIDocument(db, { actor: owner }, resource.id);
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      resource.id,
      { seq: before.seq, epochId: before.epochId! },
      [
        { type: "add", element: { tag: "Rect", width: 100, height: 60 } },
        {
          type: "add",
          element: { tag: "Line", points: [0, 0, 100, 0], endArrow: "arrow" },
        },
      ],
      randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  const after = await readAIDocument(db, { actor: owner }, resource.id);
  expect(after.seq).toBe(before.seq);
  expect(after.value).toEqual(before.value);
  await editAIDocument(
    db,
    { actor: owner },
    resource.id,
    { seq: before.seq, epochId: before.epochId! },
    [
      {
        type: "add",
        element: { tag: "Line", points: [0, 0, 100, 0], endArrow: "angle" },
      },
    ],
    randomUUID(),
  );
  expect(
    JSON.stringify(
      (await readAIDocument(db, { actor: owner }, resource.id)).value,
    ),
  ).toContain("angle");
});

it.each([
  "rich_text",
  "markdown",
  "canvas",
  "presentation",
  "spreadsheet",
] as const)(
  "edits %s through native collaboration and rejects stale/repeated conflicting changes",
  async (format) => {
    const r = await createContent(db).create(owner, {
      kind: "document",
      format,
      title: "AI test",
    });
    const before = await readAIDocument(db, { actor: owner }, r.id),
      value = before.value as any;
    const operations =
      format === "rich_text" || format === "markdown"
        ? [{ type: "append", text: "AI 保存测试" }]
        : format === "canvas"
          ? [
              {
                type: "add",
                element: {
                  id: "ai-node",
                  tag: "Rect",
                  x: 20,
                  y: 20,
                  width: 120,
                  height: 80,
                  fill: "#ffeecc",
                },
              },
            ]
          : format === "presentation"
            ? [{ type: "addSlide" }]
            : [
                {
                  type: "cells",
                  sheetId: value.sheetOrder[0],
                  cells: {
                    0: { 0: { v: 10, f: null }, 1: { v: null, f: "=A1*2" } },
                  },
                },
              ];
    const oid = randomUUID();
    const result = await editAIDocument(
      db,
      { actor: owner },
      r.id,
      { seq: before.seq, epochId: before.epochId! },
      operations,
      oid,
    );
    expect(result.saved).toBe(true);
    expect(result.seq).toBeGreaterThan(before.seq);
    const duplicate = await editAIDocument(
      db,
      { actor: owner },
      r.id,
      { seq: before.seq, epochId: before.epochId! },
      operations,
      oid,
    );
    expect(duplicate.seq).toBe(result.seq);
    await expect(
      editAIDocument(
        db,
        { actor: owner },
        r.id,
        { seq: before.seq, epochId: before.epochId! },
        operations,
        randomUUID(),
      ),
    ).rejects.toThrow("文档已被编辑");
    await expect(readAIDocument(db, { actor: other }, r.id)).rejects.toThrow();
    const after = await readAIDocument(db, { actor: owner }, r.id);
    if (format === "spreadsheet") {
      expect(
        (after.value as any).sheets[value.sheetOrder[0]].cellData[0][1].f,
      ).toBe("=A1*2");
      expect(result.formulaCalculation).toBe("not_verified");
    }
    if (format === "rich_text" || format === "markdown")
      expect(JSON.stringify(after.value)).toContain("AI 保存测试");
  },
);
it("accepts spreadsheet first-call mistakes like Sheet1 and A1 keys", async () => {
  const r = await createContent(db).create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "Sheet first call",
  });
  const before = await readAIDocument(db, { actor: owner }, r.id);
  await editAIDocument(
    db,
    { actor: owner },
    r.id,
    { seq: before.seq, epochId: before.epochId! },
    [
      {
        type: "setCells",
        sheetId: "Sheet1",
        cells: { A1: "销量", B1: 10, C1: "=B1*2" },
      },
    ],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, r.id);
  const sheetId = (before.value as any).sheetOrder[0];
  expect((after.value as any).sheets[sheetId].cellData[0][0].v).toBe("销量");
  expect((after.value as any).sheets[sheetId].cellData[0][2].f).toBe("=B1*2");
});
it("creates exactly one document per idempotent operation and constrains external scopes", async () => {
  const library = await createContent(db).create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Library",
  });
  const ctx = { actor: owner, allowedResources: [library.id], writable: true };
  const oid = randomUUID();
  const input = {
    kind: "document" as const,
    format: "markdown" as const,
    title: "Experience",
    markdown: "# Result",
    libraryId: library.id,
  };
  const a = await createAIDocument(db, ctx, input, oid),
    b = await createAIDocument(db, ctx, input, oid);
  expect(a.id).toBe(b.id);
  await expect(
    createAIDocument(db, ctx, { ...input, libraryId: null }, randomUUID()),
  ).rejects.toThrow("授权知识库");
});
it("stores Mastra threads and per-user working memory without cross-user reads", async () => {
  const m = await createAIMemory({ driver: "sqlite", url: ":memory:" });
  try {
    const threadId = randomUUID();
    await m.memory.createThread({
      threadId,
      resourceId: memoryOwner(owner.id),
      title: "Test",
    });
    await saveChatMessage(m.memory, owner.id, threadId, "m1", "user", "hello");
    await saveChatMessage(m.memory, owner.id, threadId, "m1", "user", "hello");
    expect(
      (
        await m.memory.recall({
          threadId,
          resourceId: memoryOwner(owner.id),
          perPage: 20,
        })
      ).messages,
    ).toHaveLength(1);
    await expect(
      m.memory.recall({ threadId, resourceId: memoryOwner(other.id) }),
    ).rejects.toThrow();
    await m.memory.updateWorkingMemory({
      threadId,
      resourceId: memoryOwner(owner.id),
      workingMemory: "先说结论",
      memoryConfig: { workingMemory: { enabled: true, scope: "resource" } },
    });
    expect(
      await m.memory.getWorkingMemory({
        threadId,
        resourceId: memoryOwner(owner.id),
        memoryConfig: { workingMemory: { enabled: true, scope: "resource" } },
      }),
    ).toBe("先说结论");
    await m.memory.deleteThread(threadId);
    expect(await m.memory.getThreadById({ threadId })).toBeNull();
  } finally {
    await m.close();
  }
});
it("protects admin settings, hides real models and keys, and runs a detached Mastra task", async () => {
  const config = await configured();
  config.limits.standard = { day: 1000000, week: 1000000, month: 1000000 };
  config.models[0]!.maxOutput = 1_000_000;
  await saveAIConfig(db, config, 1);
  const mocked = vi.fn(async (_url: unknown, init?: RequestInit) =>
    completionResponse(
      {
        id: "fake-completion",
        object: "chat.completion",
        created: 1,
        model: "private-real-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "这是隔离模型返回的结果",
              reasoning_content: "模型返回的可展示思考",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 300_000,
          completion_tokens: 200_000,
          total_tokens: 500_000,
        },
      },
      !!JSON.parse(String(init?.body)).stream,
      60,
    ),
  );
  const origin = "http://localhost:39131",
    app = await createApp(db, {
      origin,
      ai: {
        memory: { driver: "sqlite", url: ":memory:" },
        fetch: mocked as unknown as typeof fetch,
      },
    });
  const request = (method: any, path: string, cookie: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39131", origin, cookie },
      payload,
    });
  try {
    const login = async (name: string) =>
      String(
        (await request("POST", "/auth/login", "", { login: name, password }))
          .headers["set-cookie"],
      ).split(";")[0]!;
    const a = await login("owner"),
      b = await login("other");
    expect((await request("GET", "/admin/ai", b)).statusCode).toBe(403);
    const options = await request("GET", "/ai/options", a);
    expect(options.statusCode, options.body).toBe(200);
    expect(options.body).not.toContain("private-real");
    expect(options.body).not.toContain("private-key");
    expect((await request("GET", "/admin/ai", a)).body).not.toContain(
      "private-key",
    );
    const s = await request("POST", "/ai/sessions", a, {
      modelId: "test",
      resourceIds: [],
    });
    expect(s.statusCode, s.body).toBe(200);
    const sid = s.json().id;
    expect((await request("GET", `/ai/sessions/${sid}`, b)).statusCode).toBe(
      404,
    );
    expect(
      (await request("GET", `/ai/sessions/${sid}/stream`, b)).statusCode,
    ).toBe(404);
    const payload = {
      id: randomUUID(),
      text: "你好",
      modelId: "test",
      scope: "all",
      references: [],
      skillIds: [],
    };
    const sent = await request(
      "POST",
      `/ai/sessions/${sid}/messages`,
      a,
      payload,
    );
    expect(sent.statusCode, sent.body).toBe(200);
    expect(
      (await request("POST", `/ai/sessions/${sid}/messages`, a, payload)).json()
        .id,
    ).toBe(payload.id);
    let result: any;
    let observedPartial = false;
    for (let i = 0; i < 100; i++) {
      result = (await request("GET", `/ai/sessions/${sid}`, a)).json();
      if (
        result.jobs[0]?.status === "running" &&
        result.jobs[0].progress?.reasoning &&
        !result.messages.some((m: any) => m.role === "assistant")
      )
        observedPartial = true;
      if (
        result.jobs[0] &&
        !["queued", "running"].includes(result.jobs[0].status)
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(result.jobs[0].status, JSON.stringify(result)).toBe("completed");
    expect(observedPartial).toBe(true);
    expect(JSON.parse(String(mocked.mock.calls[0]?.[1]?.body)).stream).toBe(
      true,
    );
    expect(result.messages.some((m: any) => m.text.includes("隔离模型"))).toBe(
      true,
    );
    expect(
      result.messages.find((m: any) => m.role === "assistant").reasoning,
    ).toBe("模型返回的可展示思考");
    expect(
      result.messages
        .filter((m: any) => m.role !== "assistant")
        .every((m: any) => m.reasoning === ""),
    ).toBe(true);
    expect(mocked).toHaveBeenCalledTimes(1);
    const calls = await db
      .selectFrom("ai_calls")
      .selectAll()
      .where("user_id", "=", owner.id)
      .execute();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input_tokens).toBe(300_000);
    expect(calls[0]?.points).toBe(700);
  } finally {
    await app.close();
  }
}, 30000);
it("displays reasoning from the OpenAI Responses API without any interface setting", async () => {
  const config = await configured();
  config.limits.standard = { day: 1000000, week: 1000000, month: 1000000 };
  config.vendors[0]!.provider = "openai";
  config.models[0] = {
    ...config.models[0]!,
    model: "gpt-5-mini-reasoning-e2e",
  } as (typeof config.models)[number];
  await saveAIConfig(db, config, 1);
  const requests: any[] = [];
  const origin = "http://localhost:39133",
    app = await createApp(db, {
      origin,
      ai: {
        memory: { driver: "sqlite", url: ":memory:" },
        fetch: mockAI({
          reasoning: "先理解问题，再给出回答。",
          chunkDelay: 20,
          record: (body) => requests.push(body),
        }),
      },
    });
  const request = (method: any, path: string, cookie: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39133", origin, cookie },
      payload,
    });
  try {
    const login = String(
      (await request("POST", "/auth/login", "", { login: "owner", password }))
        .headers["set-cookie"],
    ).split(";")[0]!;
    const s = await request("POST", "/ai/sessions", login, {
      modelId: "test",
      resourceIds: [],
    });
    expect(s.statusCode, s.body).toBe(200);
    const sid = s.json().id;
    const sent = await request("POST", `/ai/sessions/${sid}/messages`, login, {
      id: randomUUID(),
      text: "你好",
      modelId: "test",
      scope: "all",
      references: [],
      skillIds: [],
    });
    expect(sent.statusCode, sent.body).toBe(200);
    let result: any;
    let observedThinking = false;
    for (let i = 0; i < 100; i++) {
      result = (await request("GET", `/ai/sessions/${sid}`, login)).json();
      if (result.jobs[0]?.status === "running" && result.jobs[0].progress?.reasoning)
        observedThinking = true;
      if (
        result.jobs[0] &&
        !["queued", "running"].includes(result.jobs[0].status)
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(result.jobs[0].status, JSON.stringify(result)).toBe("completed");
    // Auto adaptation: Responses API is used and the request opts into reasoning.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].reasoning).toEqual({ summary: "auto" });
    expect(observedThinking).toBe(true);
    const answer = result.messages.find((m: any) => m.role === "assistant");
    expect(answer.reasoning).toBe("先理解问题，再给出回答。");
    expect(answer.text).toContain("模拟 AI 的回答");
  } finally {
    await app.close();
  }
}, 30000);
it("runs model tool loops for all five native formats and blocks revoked conversation sources", async () => {
  const c = await configured();
  c.limits.standard = { day: 1000000, week: 1000000, month: 1000000 };
  c.models[0]!.maxOutput = 100_000;
  await saveAIConfig(db, c, 1);
  const calls: any[] = [],
    origin = "http://localhost:39132";
  const sockets: WebSocket[] = [];
  const app = await createApp(db, {
    origin,
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: mockAI({ record: (b) => calls.push(b) }),
    },
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39132", origin },
      payload: { login: "owner", password },
    });
    const headers = {
      host: "localhost:39132",
      origin,
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    };
    for (const format of [
      "rich_text",
      "markdown",
      "spreadsheet",
      "canvas",
      "presentation",
    ] as const) {
      const r = await createContent(db).create(owner, {
        kind: "document",
        format,
        title: format,
      });
      const socket = await app.injectWS("/api/v1/ws", {
        headers,
        rawHeaders: Object.entries(headers).flat(),
      });
      sockets.push(socket);
      const received: any[] = [];
      socket.on("message", (bytes) => received.push(JSON.parse(String(bytes))));
      socket.send(
        JSON.stringify({
          type: "join",
          id: randomUUID(),
          room: r.id,
          protocolVersion: 1,
          codec:
            format === "rich_text"
              ? "slate-kit"
              : format === "markdown"
                ? "markdown-ytext"
                : surfaceCodec(format),
          schemaVersion:
            format === "rich_text"
              ? 3
              : format === "presentation"
                ? PPT_SCHEMA
                : format === "spreadsheet"
                  ? DEFAULT_SPREADSHEET_SCHEMA
                  : 1,
        }),
      );
      for (
        let i = 0;
        i < 50 && !received.some((m) => m.type === "sync-response");
        i++
      )
        await new Promise((r) => setTimeout(r, 10));
      expect(received.some((m) => m.type === "sync-response")).toBe(true);
      const s = (
        await app.inject({
          method: "POST",
          url: "/api/v1/ai/sessions",
          headers,
          payload: { modelId: "test", resourceIds: [r.id] },
        })
      ).json();
      const sent = await app.inject({
        method: "POST",
        url: `/api/v1/ai/sessions/${s.id}/messages`,
        headers,
        payload: {
          id: randomUUID(),
          text: `添加测试内容 ${r.id}`,
          modelId: "test",
          scope: "document",
          references: [{ resourceId: r.id }],
          skillIds: [],
        },
      });
      expect(sent.statusCode, sent.body).toBe(200);
      let result: any;
      for (let i = 0; i < 100; i++) {
        result = (
          await app.inject({ url: `/api/v1/ai/sessions/${s.id}`, headers })
        ).json();
        if (
          result.jobs[0] &&
          !["queued", "running"].includes(result.jobs[0].status)
        )
          break;
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(result.jobs[0].status, JSON.stringify({ result, calls })).toBe(
        "completed",
      );
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].result.saved).toBe(true);
      expect(result.messages.map((m: any) => m.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(
        received.some((m) => m.type === "sync-response" && m.seq > 0),
        format,
      ).toBe(true);
      expect(
        received.some((m) => m.type === "document.changed"),
        format,
      ).toBe(true);
      socket.close();
      await db
        .updateTable("resources")
        .set({ deleted_at: new Date().toISOString() })
        .where("id", "=", r.id)
        .execute();
      expect(
        (await app.inject({ url: `/api/v1/ai/sessions/${s.id}`, headers }))
          .statusCode,
      ).toBe(403);
    }
    expect(calls).toHaveLength(30);
    const audits = calls.filter((c) =>
      c.tools.some((t: any) => t.function.name === "submit_review"),
    );
    expect(audits).toHaveLength(15);
    expect(
      audits.every((c) =>
        c.tools.every((t: any) =>
          ["document_read", "submit_review", "web_fetch", "web_search"].includes(
            t.function.name,
          ),
        ),
      ),
    ).toBe(true);
    const ledgers = await db.selectFrom("ai_calls").selectAll().execute();
    expect(
      ledgers.every(
        (c) => c.cached_tokens === 20_000 && c.points > 0 && c.points <= 170,
      ),
    ).toBe(true);
    expect(ledgers.filter((c) => c.points === 170)).toHaveLength(15);
  } finally {
    for (const socket of sockets) socket.close();
    await app.close();
  }
}, 30000);
it("formats rich text and edits native table structure while retaining block identities", async () => {
  const r = await createContent(db).create(owner, {
    kind: "document",
    format: "rich_text",
    title: "稳定文字",
  });
  const before = await readAIDocument(db, { actor: owner }, r.id),
    block = (before.value as any[])[0];
  await editAIDocument(
    db,
    { actor: owner },
    r.id,
    { seq: before.seq, epochId: before.epochId! },
    [
      {
        type: "formatText",
        blockId: block.id,
        index: 0,
        length: 2,
        style: { bold: true },
      },
      { type: "insertTable", rows: 2, columns: 2, afterId: block.id },
    ],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, r.id),
    value = after.value as any[];
  expect(value[0].id).toBe(block.id);
  expect(value[0].children[0]).toMatchObject({ text: "稳定", bold: true });
  const table = value.find((n) => n.type === "table");
  expect(table).toBeTruthy();
  await editAIDocument(
    db,
    { actor: owner },
    r.id,
    { seq: after.seq, epochId: after.epochId! },
    [{ type: "insertRows", tableId: table.id, count: 1 }],
    randomUUID(),
  );
  const final = await readAIDocument(db, { actor: owner }, r.id);
  expect(
    (final.value as any[]).find((n) => n.id === table.id).children.length,
  ).toBe(3);
});
it("exposes scoped MCP tools, uses Meilisearch without trusting its ACL, and revokes keys immediately", async () => {
  const library = await createContent(db).create(owner, {
    kind: "library",
    format: "rich_text",
    title: "经验库",
  });
  const own = await createContent(db).create(owner, {
    kind: "document",
    format: "markdown",
    title: "经验总结",
    libraryId: library.id,
    markdown: "部署经验：先检查再发布",
  });
  const secret = await createContent(db).create(other, {
    kind: "document",
    format: "markdown",
    title: "私密经验",
    markdown: "DO_NOT_LEAK",
  });
  const searches: any[] = [],
    origin = "http://localhost:39133";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" } },
    search: {
      allowedOrigins: ["http://127.0.0.1:7700"],
      fetch: (async (url, init) => {
        if (String(url).endsWith("/search")) {
          searches.push(JSON.parse(String(init?.body)));
          return Response.json({
            hits: [{ id: own.id }, { id: secret.id, text: "DO_NOT_LEAK" }],
          });
        }
        return Response.json({
          status: "succeeded",
          taskUid: 1,
          results: [],
          total: 0,
        });
      }) as typeof fetch,
    },
  });
  try {
    await db
      .updateTable("search_settings")
      .set({ enabled: 1 })
      .where("id", "=", "system")
      .execute();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39133", origin },
      payload: { login: "owner", password },
    });
    const headers = {
      host: "localhost:39133",
      origin,
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    };
    const keyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/ai/mcp-keys",
      headers,
      payload: {
        name: "external",
        resourceIds: [library.id],
        writable: true,
        days: 30,
      },
    });
    expect(keyResponse.statusCode, keyResponse.body).toBe(200);
    const key = keyResponse.json();
    const rpc = (method: string, params: any) =>
      app.inject({
        method: "POST",
        url: "/api/v1/mcp",
        headers: {
          host: "localhost:39133",
          authorization: `Bearer ${key.token}`,
          accept: "application/json, text/event-stream",
        },
        payload: { jsonrpc: "2.0", id: 1, method, params },
      });
    expect(
      (
        await rpc("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "isolated-test", version: "1" },
        })
      ).json().result.serverInfo.name,
    ).toBe("doca");
    const tools = await rpc("tools/list", {});
    expect(tools.json().result.tools).toHaveLength(4);
    const found = await rpc("tools/call", {
      name: "knowledge_search",
      arguments: { query: "经验" },
    });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.body).toContain("meilisearch");
    expect(found.body).toContain("先检查再发布");
    expect(found.body).not.toContain(secret.id);
    expect(found.body).not.toContain("DO_NOT_LEAK");
    expect(searches).toHaveLength(1);
    expect(searches[0].filter).not.toContain(secret.id);
    const denied = await rpc("tools/call", {
      name: "document_get",
      arguments: { resourceId: secret.id },
    });
    expect(denied.json().result.isError).toBe(true);
    const args = {
      requestId: randomUUID(),
      libraryId: library.id,
      title: "Agent 的经验",
      body: "# 经验\n经过验证再总结",
    };
    const created = (
      await rpc("tools/call", { name: "document_create", arguments: args })
    ).json();
    expect(created.result.isError, JSON.stringify(created)).not.toBe(true);
    const id = JSON.parse(created.result.content[0].text).id;
    expect(
      JSON.parse(
        (
          await rpc("tools/call", { name: "document_create", arguments: args })
        ).json().result.content[0].text,
      ).id,
    ).toBe(id);
    const read = JSON.parse(
      (
        await rpc("tools/call", {
          name: "document_get",
          arguments: { resourceId: id },
        })
      ).json().result.content[0].text,
    );
    const appendArgs = {
      requestId: randomUUID(),
      resourceId: id,
      seq: read.seq,
      epochId: read.epochId,
      text: "\n追加经验",
    };
    const appended = (
      await rpc("tools/call", {
        name: "document_append",
        arguments: appendArgs,
      })
    ).json();
    expect(appended.result.isError, JSON.stringify(appended)).not.toBe(true);
    expect(
      (
        await rpc("tools/call", {
          name: "document_append",
          arguments: appendArgs,
        })
      ).json().result,
    ).toEqual(appended.result);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/ai/mcp-keys/${key.id}`,
      headers,
    });
    expect((await rpc("tools/list", {})).statusCode).toBe(401);
  } finally {
    await app.close();
  }
}, 30000);
it("isolates personal skills and memory, validates model tools, and reconciles credit exactly once", async () => {
  await configured();
  const origin = "http://localhost:39134";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: mockAI() },
  });
  const request = (method: any, path: string, cookie: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39134", origin, cookie },
      payload,
    });
  try {
    const login = async (name: string) =>
      String(
        (await request("POST", "/auth/login", "", { login: name, password }))
          .headers["set-cookie"],
      ).split(";")[0]!;
    const a = await login("owner"),
      b = await login("other");
    const test = await request("POST", "/admin/ai/models/test/test", a);
    expect(test.statusCode, test.body).toBe(200);
    expect((await quotaSummary(db, owner.id)).used.day).toBe(0);
    expect(
      (
        await request("PUT", "/ai/memory", a, {
          text: "用中文简洁回答",
          revision: 0,
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", "/ai/memory", a)).json().text).toContain(
      "用中文简洁回答",
    );
    expect((await request("GET", "/ai/memory", b)).json().text).toBe("");
    expect(
      (await request("PUT", "/ai/memory", a, { text: "过期版本", revision: 0 }))
        .statusCode,
    ).toBe(409);
    expect(
      (await request("PUT", "/ai/memory", a, { text: "", revision: 1 }))
        .statusCode,
    ).toBe(200);
    expect((await request("GET", "/ai/memory", a)).json().text).toBe("");
    const sid = randomUUID(),
      skill = {
        name: "中文周报",
        description: "生成中文周报",
        content: "使用目标、进度和下周计划三个段落。",
        formats: ["markdown"],
        enabled: true,
        revision: 0,
      };
    expect(
      (await request("PUT", `/ai/skills/${sid}`, a, skill)).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/ai/skills", b)).json().personal,
    ).toHaveLength(0);
    expect(
      (await request("PUT", `/ai/skills/${sid}`, b, skill)).statusCode,
    ).toBe(409);
    await request("DELETE", `/ai/skills/${sid}`, b);
    expect(
      (await request("GET", "/ai/skills", a)).json().personal,
    ).toHaveLength(1);
    await request("DELETE", `/ai/skills/${sid}`, a);
    expect(
      (await request("GET", "/ai/skills", a)).json().personal,
    ).toHaveLength(0);
    const grant = {
      id: randomUUID(),
      userId: owner.id,
      amount: 500,
      reason: "验收发放",
      expiresAt: null,
    };
    expect(
      (await request("POST", "/admin/ai/grants", b, grant)).statusCode,
    ).toBe(403);
    expect(
      (await request("POST", "/admin/ai/grants", a, grant)).statusCode,
    ).toBe(200);
    expect(
      (await request("POST", "/admin/ai/grants", a, grant)).statusCode,
    ).toBe(200);
    expect((await quotaSummary(db, owner.id)).bonus).toBe(500);
    const call = await reserveCall(db, owner.id, "test", null, 800_000_000, 50_000_000);
    await settleCall(db, call.id, null);
    expect(
      (
        await request("POST", `/admin/ai/calls/${call.id}/reconcile`, a, {
          input: 100_000_000,
          output: 20_000_000,
          cached: 101_000_000,
        })
      ).statusCode,
    ).toBe(400);
    const results = await Promise.all(
      [1, 2].map(() =>
        request("POST", `/admin/ai/calls/${call.id}/reconcile`, a, {
          input: 100_000_000,
          output: 20_000_000,
          cached: 20_000_000,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await quotaSummary(db, owner.id)).used.day).toBe(130);
    const conversation = (
      await request("POST", "/ai/sessions", a, {
        modelId: "test",
        resourceIds: [],
      })
    ).json();
    expect(
      (
        await request("PATCH", `/ai/sessions/${conversation.id}`, a, {
          title: "归档测试",
          archived: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/ai/sessions?archived=true", a))
        .json()
        .some((s: any) => s.id === conversation.id && s.title === "归档测试"),
    ).toBe(true);
    expect(
      (
        await request("POST", `/ai/sessions/${conversation.id}/messages`, a, {
          id: randomUUID(),
          text: "不应执行",
          modelId: "test",
          scope: "all",
          references: [],
          skillIds: [],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request("DELETE", `/ai/sessions/${conversation.id}`, b))
        .statusCode,
    ).toBe(404);
    expect(
      (await request("DELETE", `/ai/sessions/${conversation.id}`, a))
        .statusCode,
    ).toBe(200);
    expect(
      (await request("GET", `/ai/sessions/${conversation.id}`, a)).statusCode,
    ).toBe(404);
    expect((await quotaSummary(db, owner.id)).used.day).toBe(130);
  } finally {
    await app.close();
  }
}, 30000);
it("surfaces the real vendor error in the admin connection test without leaking keys", async () => {
  await configured();
  const origin = "http://localhost:39137";
  const app = await createApp(db, {
    origin,
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: (async () =>
        Response.json(
          {
            error: {
              message:
                "The parameter `tool_choice` is invalid for kimi-k3. Authorization: Bearer private-key-test",
            },
          },
          { status: 400 },
        )) as typeof fetch,
    },
  });
  const request = (method: any, path: string, cookie: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39137", origin, cookie },
      payload,
    });
  try {
    const a = String(
      (await request("POST", "/auth/login", "", { login: "owner", password }))
        .headers["set-cookie"],
    ).split(";")[0]!;
    const test = await request("POST", "/admin/ai/models/test/test", a);
    expect(test.statusCode).toBe(502);
    expect(test.body).toContain("tool_choice");
    expect(test.body).toContain("kimi-k3");
    expect(test.body).not.toContain("private-key-test");
  } finally {
    await app.close();
  }
}, 30000);
it("batch archives and restores only the current user's sessions", async () => {
  const origin = "http://localhost:39139";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" } },
  });
  const request = (method: any, path: string, cookie: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39139", origin, cookie },
      payload,
    });
  try {
    const login = async (name: string) =>
      String(
        (await request("POST", "/auth/login", "", { login: name, password }))
          .headers["set-cookie"],
      ).split(";")[0]!;
    const a = await login("owner"),
      b = await login("other");
    const create = (cookie: string, title: string) =>
      request("POST", "/ai/sessions", cookie, { title, resourceIds: [] }).then(
        (r) => r.json().id as string,
      );
    const mine = [await create(a, "批一"), await create(a, "批二")];
    const foreign = await create(b, "他人的会话");
    expect(
      (await request("POST", "/ai/sessions/batch", a, { ids: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await request("POST", "/ai/sessions/batch", a, {
          ids: mine,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("POST", "/ai/sessions/batch", a, {
          ids: ["not-a-uuid"],
          archived: true,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("POST", "/ai/sessions/batch", a, {
          ids: Array.from({ length: 201 }, () => randomUUID()),
          archived: true,
        })
      ).statusCode,
    ).toBe(400);
    const archived = await request("POST", "/ai/sessions/batch", a, {
      ids: [...mine, foreign],
      archived: true,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toEqual({ updated: 2 });
    const active = (await request("GET", "/ai/sessions", a)).json();
    const hidden = (await request("GET", "/ai/sessions?archived=true", a))
      .json();
    expect(active.some((s: any) => mine.includes(s.id))).toBe(false);
    expect(mine.every((id) => hidden.some((s: any) => s.id === id))).toBe(true);
    expect(
      (await request("GET", "/ai/sessions", b)).json().some(
        (s: any) => s.id === foreign,
      ),
    ).toBe(true);
    const restored = await request("POST", "/ai/sessions/batch", a, {
      ids: mine,
      archived: false,
    });
    expect(restored.json()).toEqual({ updated: 2 });
    expect(
      (await request("GET", "/ai/sessions", a))
        .json()
        .filter((s: any) => mine.includes(s.id)),
    ).toHaveLength(2);
    const row = await db
      .selectFrom("ai_sessions")
      .select(["revision", "archived"])
      .where("id", "=", mine[0]!)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ revision: 3, archived: 0 });
  } finally {
    await app.close();
  }
}, 30000);
it("stops a queued or running job and prevents model follow-ups after source revocation", async () => {
  const c = await configured();
  c.limits.standard = { day: 1000000, week: 1000000, month: 1000000 };
  await saveAIConfig(db, c, 1);
  const origin = "http://localhost:39135";
  let revoke: string | undefined;
  const recorded: any[] = [];
  const provider = mockAI({ delay: 100, record: (b) => recorded.push(b) });
  const app = await createApp(db, {
    origin,
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: async (...args) => {
        const result = await provider(...args);
        if (revoke) {
          await db
            .updateTable("resources")
            .set({ deleted_at: new Date().toISOString() })
            .where("id", "=", revoke)
            .execute();
          revoke = undefined;
        }
        return result;
      },
    },
  });
  try {
    const l = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39135", origin },
      payload: { login: "owner", password },
    });
    const headers = {
      host: "localhost:39135",
      origin,
      cookie: String(l.headers["set-cookie"]).split(";")[0]!,
    };
    const make = async (resourceIds: string[]) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/ai/sessions",
          headers,
          payload: { modelId: "test", resourceIds },
        })
      ).json();
    const s = await make([]),
      jobId = randomUUID();
    await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${s.id}/messages`,
      headers,
      payload: {
        id: jobId,
        text: "你好",
        modelId: "test",
        scope: "all",
        references: [],
        skillIds: [],
      },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/ai/jobs/${jobId}/cancel`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    for (let i = 0; i < 100; i++) {
      const j = await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
      if (!["queued", "running"].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(
      (
        await db
          .selectFrom("ai_jobs")
          .selectAll()
          .where("id", "=", jobId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("cancelled");
    const doc = await createContent(db).create(owner, {
      kind: "document",
      format: "markdown",
      title: "私密参考",
    });
    const t = await make([doc.id]),
      jid = randomUUID(),
      count = recorded.length;
    revoke = doc.id;
    await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${t.id}/messages`,
      headers,
      payload: {
        id: jid,
        text: "总结文档",
        modelId: "test",
        scope: "document",
        references: [{ resourceId: doc.id }],
        skillIds: [],
      },
    });
    let job: any;
    for (let i = 0; i < 150; i++) {
      job = await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", jid)
        .executeTakeFirstOrThrow();
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(job.status).toBe("failed");
    expect(recorded.length - count).toBe(1);
    expect(
      (await app.inject({ url: `/api/v1/ai/sessions/${t.id}`, headers }))
        .statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
}, 30000);

it("separates admin credit settings from model management, masks keys and rejects stale or unauthorized writes", async () => {
  await configured();
  const origin = "http://localhost:39138";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: mockAI() },
  });
  const request = (method: any, path: string, cookie: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39138", origin, cookie },
      payload,
    });
  try {
    const login = async (name: string) =>
      String(
        (await request("POST", "/auth/login", "", { login: name, password }))
          .headers["set-cookie"],
      ).split(";")[0]!;
    const a = await login("owner"),
      b = await login("other");
    expect((await request("GET", "/admin/ai/credits", b)).statusCode).toBe(403);
    expect((await request("PUT", "/admin/ai/credits", b, {})).statusCode).toBe(
      403,
    );
    expect(
      (await request("PUT", "/admin/ai/management", b, {})).statusCode,
    ).toBe(403);
    const get = await request("GET", "/admin/ai", a);
    expect(get.body).not.toContain("private-key-test");
    const { revision, limits, taskBudget, ...management } = get.json().config;
    expect(management.models[0]).not.toHaveProperty("apiKey");
    expect(management.vendors[0]).toMatchObject({ apiKey: null, hasKey: true });
    management.vendors = management.vendors.map(({ hasKey, ...v }: any) => v);
    const vendorId = management.vendors[0].id;
    expect(
      (await request("GET", `/admin/ai/vendors/${vendorId}/catalog`, b))
        .statusCode,
    ).toBe(403);
    expect(
      (await request("GET", `/admin/ai/vendors/${vendorId}/catalog`, a))
        .statusCode,
    ).toBe(200);
    management.models[0].alias = "新展示名";
    management.models[0].inputRate = 999; // This page cannot change billing.
    const updated = await request("PUT", "/admin/ai/management", a, {
      revision,
      config: management,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect((await aiConfig(db)).models[0]!.apiKey).toBe("private-key-test");
    expect((await aiConfig(db)).models[0]!.inputRate).toBe(1);
    const credits = (await request("GET", "/admin/ai/credits", a)).json();
    expect(JSON.stringify(credits)).not.toContain("apiKey");
    expect(JSON.stringify(credits)).not.toContain("example.test");
    const body = {
      revision: credits.revision,
      limits: { standard: { day: 2500, week: 5000, month: 25000 } },
      taskBudget: 80000,
      models: [{ id: "test", inputRate: 1.125, outputRate: 3, cacheRate: 0.5 }],
    };
    expect(
      (await request("PUT", "/admin/ai/credits", a, { ...body, vendors: [] }))
        .statusCode,
    ).toBe(400);
    const changed = await request("PUT", "/admin/ai/credits", a, body);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      (
        await request("PUT", "/admin/ai/management", a, {
          revision: credits.revision,
          config: management,
        })
      ).statusCode,
    ).toBe(409);
    const final = await aiConfig(db);
    expect(final.models[0]).toMatchObject({
      alias: "新展示名",
      inputRate: 1.125,
      outputRate: 3,
      apiKey: "private-key-test",
    });
    expect(final.limits.standard?.day).toBe(2500);
    expect(final.taskBudget).toBe(80000);
  } finally {
    await app.close();
  }
});

it.each(["markdown", "rich_text"] as const)(
  "rejects malformed %s text batches before writing",
  async (format) => {
    const resource = await createContent(db).create(owner, {
      kind: "document",
      format,
      title: "Invalid text batch",
    });
    const before = await readAIDocument(db, { actor: owner }, resource.id);
    await expect(
      editAIDocument(
        db,
        { actor: owner },
        resource.id,
        { seq: before.seq, epochId: before.epochId! },
        [
          { type: "append", text: "must not be saved" },
          { type: "append", content: "wrong field" },
        ],
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const after = await readAIDocument(db, { actor: owner }, resource.id);
    expect(after.seq).toBe(before.seq);
    expect(after.value).toEqual(before.value);
  },
);

it.each([
  "rich_text",
  "markdown",
  "spreadsheet",
  "canvas",
  "presentation",
] as const)(
  "previews %s with native readonly data and current permissions",
  async (format) => {
    const resource = await createContent(db).create(owner, {
      kind: "document",
      format,
      title: "Preview permissions",
    });
    const before = await readAIDocument(db, { actor: owner }, resource.id);
    const preview = await previewAIDocument(db, owner, resource.id);
    expect(preview.resource.title).toBe(resource.title);
    if (format === "markdown") expect(preview.markdown).toBe(before.value);
    else if (format === "rich_text")
      expect(preview.value).toEqual(before.value);
    else expect(preview.surface?.update).toBeTruthy();
    await expect(
      previewAIDocument(db, other, resource.id),
    ).rejects.toMatchObject({ status: 404 });
    expect((await readAIDocument(db, { actor: owner }, resource.id)).seq).toBe(
      before.seq,
    );
  },
);

it("honors unlimited membership credits and optional task budget without hidden caps", async () => {
  const initial = await configured();
  const unlimited = {
    ...initial,
    taskBudget: null,
    limits: { standard: { day: null, week: null, month: null } },
  };
  await saveAIConfig(db, unlimited, 1);
  const now = new Date().toISOString(),
    sessionId = randomUUID(),
    jobId = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: owner.id,
      title: "Unlimited credits",
      model_id: "test",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("ai_jobs")
    .values({
      id: jobId,
      session_id: sessionId,
      user_id: owner.id,
      model_id: "test",
      status: "running",
      input: "{}",
      digest: "test",
      result: "",
      error: "",
      lease: "test",
      lease_until: null,
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const call = await reserveCall(db, owner.id, "test", jobId, 250_000_000, 32_000_000);
  await settleCall(db, call.id, {
    input: 200_000_000,
    output: 1_000_000,
    cached: 0,
  });
  const summary = await quotaSummary(db, owner.id);
  expect(summary.limits).toEqual({ day: null, week: null, month: null });
  expect(summary.used.day).toBe(202);
  await saveAIConfig(db, { ...unlimited, taskBudget: 100 }, 2);
  console.log("DEBUG_TASKBUDGET", (await aiConfig(db)).taskBudget,
    await db.selectFrom("ai_calls").select(["job_id", "points", "state"]).execute());
  await expect(
    reserveCall(db, owner.id, "test", jobId, 10, 10),
  ).rejects.toMatchObject({ status: 402 });
  await saveAIConfig(
    db,
    {
      ...unlimited,
      limits: { standard: { day: 100, week: null, month: null } },
    },
    3,
  );
  await expect(
    reserveCall(db, owner.id, "test", jobId, 10, 10),
  ).rejects.toMatchObject({ status: 402 });
});

it("preserves the system and previous user prefix across turns with changed references", async () => {
  const config = await configured();
  await saveAIConfig(
    db,
    { ...config, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  const requests: any[] = [];
  const origin = "http://localhost:39135";
  const app = await createApp(db, {
    origin,
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: mockAI({ record: (body) => requests.push(body) }),
    },
  });
  let cookie = "";
  const request = (method: any, path: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39135", origin, cookie },
      payload,
    });
  try {
    cookie = String(
      (await request("POST", "/auth/login", { login: "owner", password }))
        .headers["set-cookie"],
    ).split(";")[0]!;
    const sid = (
      await request("POST", "/ai/sessions", { modelId: "test" })
    ).json().id;
    const doc = await createContent(db).create(owner, {
      title: "缓存上下文样本",
      kind: "document",
      format: "markdown",
      markdown: "isolated",
    });
    for (const references of [
      [],
      [{ resourceId: doc.id, label: "缓存上下文样本" }],
    ]) {
      const id = randomUUID();
      expect(
        (
          await request("POST", `/ai/sessions/${sid}/messages`, {
            id,
            text: "你好",
            modelId: "test",
            scope: "all",
            references,
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(
        async () => {
          const result = (await request("GET", `/ai/sessions/${sid}`)).json();
          expect(
            result.jobs.find((j: any) => j.id === id)?.status,
            JSON.stringify(result.jobs),
          ).toBe("completed");
          expect(result.messages.find((m: any) => m.id === id)?.text).toBe(
            "你好",
          );
          expect(JSON.stringify(result.messages)).not.toContain(
            "【本轮上下文】",
          );
        },
        { timeout: 10000, interval: 40 },
      );
    }
    const turns = requests.filter((r) => r.messages.at(-1)?.role === "user");
    expect(turns).toHaveLength(2);
    const first = turns[0],
      second = turns[1];
    expect(second.tools).toEqual(first.tools);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(
      JSON.stringify(second.messages.filter((m: any) => m.role === "system")),
    ).not.toContain(doc.id);
    expect(JSON.stringify(second.messages.at(-1))).toContain(doc.id);
    const usage = (await request("GET", "/ai/usage")).json();
    expect(usage.calls).toHaveLength(requests.length);
  } finally {
    await app.close();
  }
}, 30000);

it("requires exact creation approval, rejects other users, and resumes without creating twice", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  const origin = "http://localhost:39135";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: mockAI() },
  });
  let cookie = "";
  const req = (method: any, path: string, payload?: any, override?: string) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39135", origin, cookie: override ?? cookie },
      payload,
    });
  try {
    cookie = String(
      (await req("POST", "/auth/login", { login: "owner", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0]!;
    const otherCookie = String(
      (await req("POST", "/auth/login", { login: "other", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0]!;
    const sid = (await req("POST", "/ai/sessions", { modelId: "test" })).json()
      .id;
    const jid = randomUUID();
    await req("POST", `/ai/sessions/${sid}/messages`, {
      id: jid,
      modelId: "test",
      scope: "document",
      text: "创建项目计划",
    });
    let approval: any;
    await vi.waitFor(
      async () => {
        const result = (await req("GET", `/ai/sessions/${sid}`)).json();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "awaiting_approval",
        );
        approval = result.jobs[0].progress.approvals[0];
        expect(result.operations).toHaveLength(0);
      },
      { timeout: 10000 },
    );
    const decision = { approvalId: approval.id, approved: true };
    expect(
      (await req("POST", `/ai/jobs/${jid}/approval`, decision, otherCookie))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await req("POST", `/ai/jobs/${jid}/approval`, {
          ...decision,
          title: "篡改目标",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await req("POST", `/ai/jobs/${jid}/approval`, decision)).statusCode,
    ).toBe(200);
    await vi.waitFor(
      async () => {
        const result = (await req("GET", `/ai/sessions/${sid}`)).json();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "completed",
        );
        expect(result.operations).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    expect(
      (await req("POST", `/ai/jobs/${jid}/approval`, decision)).statusCode,
    ).toBe(200);
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("job_id", "=", jid)
        .execute(),
    ).toHaveLength(1);
  } finally {
    await app.close();
  }
}, 30000);

it("limits document-scope edits to the current document and historical user mentions", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  const docs = await Promise.all(
    ["当前文档", "引用文档", "仅被检索过"].map((title) =>
      createContent(db).create(owner, {
        title,
        kind: "document",
        format: "markdown",
      }),
    ),
  );
  const [current, mentioned, discovered] = docs;
  const origin = "http://localhost:39135";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: mockAI() },
  });
  let cookie = "";
  const req = (method: any, path: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39135", origin, cookie },
      payload,
    });
  try {
    cookie = String(
      (await req("POST", "/auth/login", { login: "owner", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0]!;
    const sid = (
      await req("POST", "/ai/sessions", {
        modelId: "test",
        resourceIds: [current!.id, discovered!.id],
      })
    ).json().id;
    for (const [index, target] of [
      mentioned!,
      mentioned!,
      current!,
      discovered!,
    ].entries()) {
      const jid = randomUUID();
      expect(
        (
          await req("POST", `/ai/sessions/${sid}/messages`, {
            id: jid,
            modelId: "test",
            scope: "document",
            currentResourceId: current!.id,
            references: index === 0 ? [{ resourceId: mentioned!.id }] : [],
            text: `添加测试内容 ${target.id}`,
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(
        async () => {
          const result = (await req("GET", `/ai/sessions/${sid}`)).json();
          expect(result.jobs.find((j: any) => j.id === jid)?.status).toBe(
            "completed",
          );
          expect(
            result.operations.filter((o: any) => o.job_id === jid),
          ).toHaveLength(index === 3 ? 0 : 1);
        },
        { timeout: 10000 },
      );
    }
    const unchanged = await readAIDocument(
      db,
      { actor: owner },
      discovered!.id,
    );
    expect(String(unchanged.value)).not.toContain("模拟");
  } finally {
    await app.close();
  }
}, 30000);

it("writes editable rich-text flowcharts and mind maps through supported native commands", async () => {
  const { documentCapabilities } =
    await import("@core/modules/ai/capabilities.js");
  const r = await createContent(db).create(owner, {
    title: "原生图验收",
    kind: "document",
    format: "rich_text",
  });
  let before = await readAIDocument(db, { actor: owner }, r.id);
  const diagramId = randomUUID();
  await editAIDocument(
    db,
    { actor: owner },
    r.id,
    { seq: before.seq, epochId: before.epochId! },
    [
      {
        type: "insertBlock",
        afterId: (before.value as any[]).at(-1).id,
        block: {
          id: diagramId,
          type: "flowchart",
          width: 600,
          children: [{ text: "" }],
          nodes: [
            {
              id: "start",
              label: "开始",
              shape: "terminator",
              x: 40,
              y: 40,
              width: 120,
              height: 56,
            },
            {
              id: "review",
              label: "评审",
              shape: "process",
              x: 240,
              y: 40,
              width: 120,
              height: 56,
            },
          ],
          edges: [
            {
              id: "edge-1",
              source: "start",
              target: "review",
              arrow: "end",
              lineType: "smoothstep",
            },
          ],
        },
      },
    ],
    randomUUID(),
  );
  before = await readAIDocument(db, { actor: owner }, r.id);
  const diagram = (before.value as any[]).find((n) => n.id === diagramId);
  expect(diagram.nodes).toHaveLength(2);
  expect(diagram.edges[0].source).toBe("start");
  await editAIDocument(
    db,
    { actor: owner },
    r.id,
    { seq: before.seq, epochId: before.epochId! },
    [
      {
        type: "setBlock",
        blockId: diagramId,
        properties: {
          nodes: [
            ...diagram.nodes,
            {
              id: "end",
              label: "完成",
              shape: "terminator",
              x: 440,
              y: 40,
              width: 120,
              height: 56,
            },
          ],
          edges: [
            ...diagram.edges,
            { id: "edge-2", source: "review", target: "end", arrow: "end" },
          ],
        },
      },
      {
        type: "insertBlock",
        afterId: diagramId,
        block: {
          id: randomUUID(),
          type: "mindmap",
          children: [{ text: "" }],
          mindData: {
            nodeData: {
              id: "root",
              topic: "验收目标",
              children: [{ id: "child", topic: "保留可编辑结构" }],
            },
            direction: 1,
          },
        },
      },
    ],
    randomUUID(),
  );
  const restored = await previewAIDocument(db, owner, r.id);
  expect(
    (restored.value as any[]).find((n) => n.id === diagramId).nodes,
  ).toHaveLength(3);
  expect(
    (restored.value as any[]).find((n) => n.type === "mindmap").mindData
      .nodeData.topic,
  ).toBe("验收目标");
  expect(documentCapabilities("rich_text").nativeDiagrams).toEqual([
    "flowchart",
    "mindmap",
  ]);
  expect(documentCapabilities("rich_text").editingGuide).toContain(
    'type:"flowchart"',
  );
});

it("requests session document scope, waits for approval, and preserves the grant across turns", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  const doc = await createContent(db).create(owner, {
    title: "需要会话授权",
    kind: "document",
    format: "markdown",
  });
  const origin = "http://localhost:39135";
  let readCount = 0;
  const provider = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    const last = body.messages.at(-1);
    let result: any;
    if (last.role === "tool") {
      try {
        result = JSON.parse(last.content);
      } catch {}
    }
    const tool = (name: string, args: any) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    let message: any;
    if (result?.resource) {
      readCount++;
      message = { role: "assistant", content: "已读取授权文档。" };
    } else if (result?.status === "granted")
      message = tool("document_read", { resourceId: doc.id });
    else
      message = tool("document_request_access", {
        resourceId: doc.id,
        role: "reader",
        reason: "读取用户指定文档",
      });
    return completionResponse(
      {
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [
          {
            index: 0,
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      !!body.stream,
    );
  }) as typeof fetch;
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: provider },
  });
  let cookie = "";
  const req = (method: any, path: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39135", origin, cookie },
      payload,
    });
  try {
    cookie = String(
      (await req("POST", "/auth/login", { login: "owner", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0]!;
    const sid = (await req("POST", "/ai/sessions", { modelId: "test" })).json()
      .id;
    let jobId = randomUUID();
    await req("POST", `/ai/sessions/${sid}/messages`, {
      id: jobId,
      modelId: "test",
      scope: "document",
      text: `请读取 ${doc.id}`,
    });
    let approval: any;
    await vi.waitFor(
      async () => {
        const result = (await req("GET", `/ai/sessions/${sid}`)).json();
        expect(result.jobs[0].status).toBe("awaiting_approval");
        approval = result.jobs[0].progress.approvals[0];
      },
      { timeout: 10000 },
    );
    expect(approval.action).toBe("access");
    expect(readCount).toBe(0);
    expect(
      (
        await req("POST", `/ai/jobs/${jobId}/approval`, {
          approvalId: approval.id,
          approved: true,
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(
      async () => {
        const result = (await req("GET", `/ai/sessions/${sid}`)).json();
        expect(result.jobs.find((j: any) => j.id === jobId).status).toBe(
          "completed",
        );
      },
      { timeout: 10000 },
    );
    expect(readCount).toBe(1);
    const row = await db
      .selectFrom("ai_sessions")
      .selectAll()
      .where("id", "=", sid)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.approved_resource_ids!)).toEqual([doc.id]);
    expect(JSON.parse(row.mentioned_resource_ids!)).toEqual([]);
    jobId = randomUUID();
    await req("POST", `/ai/sessions/${sid}/messages`, {
      id: jobId,
      modelId: "test",
      scope: "document",
      text: "再读取一次",
    });
    await vi.waitFor(
      async () => {
        const result = (await req("GET", `/ai/sessions/${sid}`)).json();
        expect(result.jobs.find((j: any) => j.id === jobId).status).toBe(
          "completed",
        );
      },
      { timeout: 10000 },
    );
    expect(readCount).toBe(2);
  } finally {
    await app.close();
  }
}, 30000);

it("submits platform permission requests only after confirmation and never self-grants document access", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  const content = createContent(db);
  const doc = await content.create(owner, {
    title: "管理员审批文档",
    kind: "document",
    format: "markdown",
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: true,
    grants: [],
  });
  const origin = "http://localhost:39135";
  const provider = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    const last = body.messages.at(-1);
    let result: any;
    if (last.role === "tool") {
      try {
        result = JSON.parse(last.content);
      } catch {}
    }
    const message =
      result?.status === "pending_document_owner"
        ? { role: "assistant", content: "申请已提交，等待文档管理员批准。" }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: randomUUID(),
                type: "function",
                function: {
                  name: "document_request_access",
                  arguments: JSON.stringify({
                    resourceId: doc.id,
                    role: "editor",
                    reason: "完成用户指定的文档编辑",
                  }),
                },
              },
            ],
          };
    return completionResponse(
      {
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [
          {
            index: 0,
            message,
            finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      !!body.stream,
    );
  }) as typeof fetch;
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: provider },
  });
  let cookie = "";
  const req = (method: any, path: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39135", origin, cookie },
      payload,
    });
  try {
    cookie = String(
      (await req("POST", "/auth/login", { login: "other", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0]!;
    const sid = (await req("POST", "/ai/sessions", { modelId: "test" })).json()
      .id;
    const jobId = randomUUID();
    await req("POST", `/ai/sessions/${sid}/messages`, {
      id: jobId,
      modelId: "test",
      scope: "document",
      text: `申请编辑文档 ${doc.id}`,
    });
    let approval: any;
    await vi.waitFor(
      async () => {
        const result = (await req("GET", `/ai/sessions/${sid}`)).json();
        expect(result.jobs[0]?.status).toBe("awaiting_approval");
        approval = result.jobs[0].progress.approvals[0];
      },
      { timeout: 10000 },
    );
    expect(approval.action).toBe("permission_request");
    expect(
      await db.selectFrom("access_requests").selectAll().execute(),
    ).toHaveLength(0);
    expect(
      (
        await req("POST", `/ai/jobs/${jobId}/approval`, {
          approvalId: approval.id,
          approved: true,
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(
      async () => {
        expect(
          (await req("GET", `/ai/sessions/${sid}`)).json().jobs[0].status,
        ).toBe("completed");
      },
      { timeout: 10000 },
    );
    const requests = await db
      .selectFrom("access_requests")
      .selectAll()
      .execute();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      user_id: other.id,
      role: "editor",
      status: "pending",
    });
    await expect(
      readAIDocument(db, { actor: other }, doc.id),
    ).rejects.toMatchObject({ status: 404 });
    const row = await db
      .selectFrom("ai_sessions")
      .selectAll()
      .where("id", "=", sid)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.approved_resource_ids!)).toEqual([]);
    expect(JSON.parse(row.resource_ids)).toEqual([]);
  } finally {
    await app.close();
  }
}, 30000);

it("keeps review pages on one snapshot while collaborators keep editing", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  const doc = await createContent(db).create(owner, {
    kind: "document",
    format: "markdown",
    title: "并发验收",
  });
  const { restoreMarkdown } =
    await import("@core/modules/documents/codecs/markdown.js");
  const { createDocuments } =
    await import("@core/modules/collaboration/documents.js");
  const Y = await import("yjs");
  const mock = mockAI();
  let changes = 0;
  const app = await createApp(db, {
    origin: "http://localhost:39135",
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (
          body.tools?.some((t: any) => t.function.name === "submit_review") &&
          body.messages.some((m: any) => m.role === "tool")
        ) {
          const loaded = await restoreMarkdown(db, doc.id);
          try {
            const vector = Y.encodeStateVector(loaded.doc);
            loaded.doc
              .getText("markdown")
              .insert(0, `协作者补充 ${++changes}\n`);
            await createDocuments(db).exchange(owner, doc.id, {
              protocolVersion: 1,
              codec: "markdown-ytext",
              schemaVersion: 1,
              epochId: loaded.epochId,
              update: Buffer.from(
                Y.encodeStateAsUpdate(loaded.doc, vector),
              ).toString("base64"),
              messageId: randomUUID(),
            });
          } finally {
            loaded.destroy();
          }
        }
        return mock(url, init);
      }) as typeof fetch,
    },
  });
  const headers: any = {
    host: "localhost:39135",
    origin: "http://localhost:39135",
  };
  const req = (method: any, path: string, payload?: any) =>
    app.inject({ method, url: "/api/v1" + path, headers, payload });
  try {
    headers.cookie = String(
      (await req("POST", "/auth/login", { login: "owner", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0];
    const sid = (await req("POST", "/ai/sessions", { modelId: "test" })).json()
      .id;
    const sent = await req("POST", `/ai/sessions/${sid}/messages`, {
      id: randomUUID(),
      modelId: "test",
      scope: "document",
      references: [{ resourceId: doc.id }],
      text: `添加测试内容 ${doc.id}`,
    });
    expect(sent.statusCode).toBe(200);
    await vi.waitFor(
      async () => {
        const job = (await req("GET", `/ai/sessions/${sid}`)).json().jobs[0];
        expect(job?.status, job?.error).toBe("completed");
        expect(job.progress.review.verdict).toBe("pass");
        expect(job.progress.review.snapshots[0].seq).toBeLessThan(
          (await readAIDocument(db, { actor: owner }, doc.id)).seq,
        );
      },
      { timeout: 10000 },
    );
    expect(changes).toBeGreaterThan(0);
    expect(
      String((await readAIDocument(db, { actor: owner }, doc.id)).value),
    ).toContain("协作者补充");
  } finally {
    await app.close();
  }
}, 20000);

it("persists structured choices, stops after asking and accepts the next free-text turn", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  let calls = 0;
  const app = await createApp(db, {
    origin: "http://localhost:39135",
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const message =
          ++calls === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "choose-audience",
                    type: "function",
                    function: {
                      name: "ask_user",
                      arguments: JSON.stringify({
                        title: "报告面向谁？",
                        options: ["管理层", "开发团队"],
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "已记录：使用自定义受众。" };
        return completionResponse(
          {
            id: randomUUID(),
            object: "chat.completion",
            created: 1,
            model: "mock",
            choices: [
              {
                index: 0,
                message,
                finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          },
          !!body.stream,
        );
      }) as typeof fetch,
    },
  });
  const headers: any = {
    host: "localhost:39135",
    origin: "http://localhost:39135",
  };
  const req = (method: any, path: string, payload?: any) =>
    app.inject({ method, url: "/api/v1" + path, headers, payload });
  try {
    headers.cookie = String(
      (await req("POST", "/auth/login", { login: "owner", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0];
    const sid = (await req("POST", "/ai/sessions", { modelId: "test" })).json()
      .id;
    await req("POST", `/ai/sessions/${sid}/messages`, {
      id: randomUUID(),
      modelId: "test",
      scope: "all",
      text: "帮我确定报告受众",
    });
    await vi.waitFor(
      async () => {
        const job = (await req("GET", `/ai/sessions/${sid}`)).json().jobs[0];
        expect(job?.status).toBe("completed");
        expect(job.progress.phase).toBe("等待用户选择");
        expect(job.progress.questions[0].options).toEqual([
          "管理层",
          "开发团队",
        ]);
      },
      { timeout: 10000 },
    );
    expect(calls).toBe(1);
    await req("POST", `/ai/sessions/${sid}/messages`, {
      id: randomUUID(),
      modelId: "test",
      scope: "all",
      text: "报告面向谁？\n我的选择：合作伙伴",
    });
    await vi.waitFor(
      async () => {
        expect(
          (await req("GET", `/ai/sessions/${sid}`))
            .json()
            .messages.some((m: any) =>
              m.text.includes("已记录：使用自定义受众"),
            ),
        ).toBe(true);
      },
      { timeout: 10000 },
    );
  } finally {
    await app.close();
  }
}, 20000);

it("starts three different sessions concurrently instead of a global two-task queue", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  let inFlight = 0,
    peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = mockAI();
  const app = await createApp(db, {
    origin: "http://localhost:39135",
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: (async (url, init) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        try {
          return await mock(url, init);
        } finally {
          inFlight--;
        }
      }) as typeof fetch,
    },
  });
  const headers: any = {
    host: "localhost:39135",
    origin: "http://localhost:39135",
  };
  const req = (method: any, path: string, payload?: any) =>
    app.inject({ method, url: "/api/v1" + path, headers, payload });
  try {
    headers.cookie = String(
      (await req("POST", "/auth/login", { login: "owner", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0];
    for (let i = 0; i < 3; i++) {
      const sid = (
        await req("POST", "/ai/sessions", { modelId: "test" })
      ).json().id;
      const sent = await req("POST", `/ai/sessions/${sid}/messages`, {
        id: randomUUID(),
        modelId: "test",
        scope: "all",
        text: "你好",
      });
      expect(sent.statusCode).toBe(200);
    }
    await vi.waitFor(() => expect(peak).toBe(3), { timeout: 5000 });
  } finally {
    release();
    await app.close();
  }
}, 15000);

it("never completes a fabricated image delivery even when the model skips all tools and planning", async () => {
  const c = await configured();
  await saveAIConfig(
    db,
    { ...c, limits: { standard: { day: null, week: null, month: null } } },
    1,
  );
  let calls = 0;
  const app = await createApp(db, {
    origin: "http://localhost:39135",
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: (async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        return completionResponse(
          {
            id: randomUUID(),
            object: "chat.completion",
            created: 1,
            model: "mock",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "图片已生成，您应该能看到。",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          },
          !!body.stream,
        );
      }) as typeof fetch,
    },
  });
  const headers: any = {
    host: "localhost:39135",
    origin: "http://localhost:39135",
  };
  const req = (method: any, path: string, payload?: any) =>
    app.inject({ method, url: "/api/v1" + path, headers, payload });
  try {
    headers.cookie = String(
      (await req("POST", "/auth/login", { login: "owner", password })).headers[
        "set-cookie"
      ],
    ).split(";")[0];
    const sid = (await req("POST", "/ai/sessions", { modelId: "test" })).json()
      .id;
    const sent = await req("POST", `/ai/sessions/${sid}/messages`, {
      id: randomUUID(),
      modelId: "test",
      scope: "all",
      text: "生成一张小猫的照片",
    });
    expect(sent.statusCode).toBe(200);
    await vi.waitFor(
      async () => {
        const job = await db
          .selectFrom("ai_jobs")
          .selectAll()
          .where("id", "=", sent.json().id)
          .executeTakeFirstOrThrow();
        expect(job.status).toBe("failed");
        expect(job.result).toContain("图片交付未通过");
      },
      { timeout: 10000 },
    );
    expect(calls).toBe(3);
    expect(
      await db.selectFrom("ai_operations").selectAll().execute(),
    ).toHaveLength(0);
  } finally {
    await app.close();
  }
}, 15000);

it("rejects invalid native elements atomically and stores actual code blocks with stable IDs", async () => {
  const resource = await createContent(db).create(owner, {
    kind: "document",
    format: "rich_text",
    title: "代码结构验收",
  });
  const before = await readAIDocument(db, { actor: owner }, resource.id);
  const version = { seq: before.seq, epochId: before.epochId! };
  for (const block of [
    { id: "bad", type: "codeBlock", children: [{ text: "package main" }] },
    { id: "bad", type: "code-block", children: [{ text: "package main" }] },
    {
      id: "bad",
      type: "paragraph",
      children: [
        { id: "nested", type: "unknown", children: [{ text: "oops" }] },
      ],
    },
  ]) {
    await expect(
      editAIDocument(
        db,
        { actor: owner },
        resource.id,
        version,
        [
          { type: "append", text: "不应保存" },
          { type: "insertBlock", block },
        ],
        randomUUID(),
      ),
    ).rejects.toThrow();
    const after = await readAIDocument(db, { actor: owner }, resource.id);
    expect(after.seq).toBe(before.seq);
    expect(after.value).toEqual(before.value);
  }
  await editAIDocument(
    db,
    { actor: owner },
    resource.id,
    version,
    [
      {
        type: "insertBlock",
        block: {
          id: "valid-code",
          type: "code-block",
          language: "go",
          code: "package main\n\nfunc main() {}",
          children: [{ text: "" }],
        },
      },
    ],
    randomUUID(),
  );
  const read = await readAIDocument(db, { actor: owner }, resource.id);
  expect(
    (read.value as any[]).find((n) => n.id === "valid-code"),
  ).toMatchObject({
    type: "code-block",
    language: "go",
    code: "package main\n\nfunc main() {}",
  });
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      resource.id,
      { seq: read.seq, epochId: read.epochId! },
      [
        {
          type: "setBlock",
          blockId: "valid-code",
          properties: { type: "codeBlock" },
        },
      ],
      randomUUID(),
    ),
  ).rejects.toThrow("不支持富文本类型");
  expect(
    (await readAIDocument(db, { actor: owner }, resource.id)).value,
  ).toEqual(read.value);
});

it.each(["canvas", "presentation", "spreadsheet", "markdown"] as const)(
  "rejects foreign/unknown %s commands before persistence",
  async (format) => {
    const resource = await createContent(db).create(owner, {
      kind: "document",
      format,
      title: "参数校验",
    });
    const before = await readAIDocument(db, { actor: owner }, resource.id),
      value = before.value as any;
    const operation =
      format === "canvas"
        ? { type: "add", element: { tag: "Unknown", id: "bad" } }
        : format === "presentation"
          ? { type: "add", slideId: value.slideOrder[0], kind: "unknown" }
          : format === "spreadsheet"
            ? { type: "putFloatingObject", input: { kind: "unknown" } }
            : { type: "insertBlock", block: { type: "paragraph" } };
    await expect(
      editAIDocument(
        db,
        { actor: owner },
        resource.id,
        { seq: before.seq, epochId: before.epochId! },
        [operation],
        randomUUID(),
      ),
    ).rejects.toThrow();
    const after = await readAIDocument(db, { actor: owner }, resource.id);
    expect(after.seq).toBe(before.seq);
    expect(after.value).toEqual(before.value);
    await expect(
      editAIDocument(
        db,
        { actor: owner },
        resource.id,
        { seq: before.seq, epochId: before.epochId!, format: "rich_text" },
        [operation],
        randomUUID(),
      ),
    ).rejects.toThrow(`请使用 ${format}_edit`);
  },
);

it("detects embedding dimensions from a saved vendor before model creation, without accepting credentials or changing settings", async () => {
  await configured();
  const config = await aiConfig(db);
  const vendor = config.vendors[0]!;
  let calls = 0;
  const origin = "http://localhost:39135";
  const app = await createApp(db, {
    origin,
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe(vendor.baseUrl + "/embeddings");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "new-embedding",
          input: ["Doca 向量连接测试"],
        });
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] });
      },
    },
  });
  const headers: any = { host: "localhost:39135", origin };
  const request = (method: any, path: string, payload?: any) =>
    app.inject({ method, url: "/api/v1" + path, headers, payload });
  try {
    const payload = { vendorId: vendor.id, model: "new-embedding" };
    expect(
      (await request("POST", "/admin/ai/embeddings/detect", payload))
        .statusCode,
    ).toBe(401);
    headers.cookie = String(
      (await request("POST", "/auth/login", { login: "other", password }))
        .headers["set-cookie"],
    ).split(";")[0];
    expect(
      (await request("POST", "/admin/ai/embeddings/detect", payload))
        .statusCode,
    ).toBe(403);
    headers.cookie = String(
      (await request("POST", "/auth/login", { login: "owner", password }))
        .headers["set-cookie"],
    ).split(";")[0];
    const res = await request("POST", "/admin/ai/embeddings/detect", payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dimensions: 4 });
    expect(
      (
        await request("POST", "/admin/ai/embeddings/detect", {
          ...payload,
          apiKey: "foreign",
          baseUrl: "http://internal",
        })
      ).statusCode,
    ).toBe(400);
    expect(calls).toBe(1);
    expect(await aiConfig(db)).toEqual(config);
  } finally {
    await app.close();
  }
});

it.each(["no-tool", "read-only", "truncated"])(
  "rejects fabricated repairs and preserves actual tool history during revision (read first: %s)",
  async (mode) => {
    const readFirst = mode === "read-only";
    const c = await configured();
    await saveAIConfig(
      db,
      { ...c, limits: { standard: { day: null, week: null, month: null } } },
      1,
    );
    const doc = await createContent(db).create(owner, {
      kind: "document",
      format: "markdown",
      title: "隔离返工测试",
      markdown: "# 不应被虚假修复覆盖",
    });
    let calls = 0;
    const bodies: any[] = [];
    const app = await createApp(db, {
      origin: "http://localhost:39135",
      ai: {
        memory: { driver: "sqlite", url: ":memory:" },
        fetch: (async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          bodies.push(body);
          return completionResponse(
            {
              id: randomUUID(),
              object: "chat.completion",
              created: 1,
              model: "mock",
              choices: [
                {
                  index: 0,
                  message:
                    readFirst && calls === 1
                      ? {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              id: "repair-read",
                              type: "function",
                              function: {
                                name: "document_read",
                                arguments: JSON.stringify({
                                  resourceId: doc.id,
                                  offset: 0,
                                  limit: 16000,
                                }),
                              },
                            },
                          ],
                        }
                      : {
                          role: "assistant",
                          content: "文档中的代码块已修复并确认保存成功。",
                        },
                  finish_reason:
                    readFirst && calls === 1
                      ? "tool_calls"
                      : mode === "truncated"
                        ? "length"
                        : "stop",
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
              },
            },
            !!body.stream,
          );
        }) as typeof fetch,
      },
    });
    const headers: any = {
      host: "localhost:39135",
      origin: "http://localhost:39135",
    };
    const req = (method: any, path: string, payload?: any) =>
      app.inject({ method, url: "/api/v1" + path, headers, payload });
    try {
      headers.cookie = String(
        (await req("POST", "/auth/login", { login: "owner", password }))
          .headers["set-cookie"],
      ).split(";")[0];
      const sid = (
        await req("POST", "/ai/sessions", { modelId: "test" })
      ).json().id;
      const sent = await req("POST", `/ai/sessions/${sid}/messages`, {
        id: randomUUID(),
        modelId: "test",
        scope: "all",
        text: "请修复文档里的代码块",
      });
      expect(sent.statusCode).toBe(200);
      await vi.waitFor(
        async () => {
          const job = await db
            .selectFrom("ai_jobs")
            .selectAll()
            .where("id", "=", sent.json().id)
            .executeTakeFirstOrThrow();
          expect(job.status).toBe("failed");
          expect(job.result).toContain(
            mode === "truncated" ? "上次输出达到上限" : "文档交付未通过",
          );
        },
        { timeout: 10000 },
      );
      expect(calls).toBe(readFirst ? 4 : 3);
      if (readFirst) {
        for (const body of bodies.slice(2)) {
          const tool = body.messages.find(
            (m: any) => m.role === "tool" && m.tool_call_id === "repair-read",
          );
          expect(tool?.content).toContain("不应被虚假修复覆盖");
          expect(
            body.messages.filter(
              (m: any) => m.role === "tool" && m.tool_call_id === "repair-read",
            ),
          ).toHaveLength(1);
        }
      }
      expect(
        await db.selectFrom("ai_operations").selectAll().execute(),
      ).toHaveLength(0);
    } finally {
      await app.close();
    }
  },
  15000,
);
