import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@doca/i18n";
import { createAISessionEventStore, type DB, type Schema } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { decodeSystemError } from "@doca/i18n";
import { openTestDatabase } from "./database.js";
import { completionResponse } from "./ai-mock.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { createAIRunner } from "../apps/server/src/services/ai/runner.js";
import { memoryOwner, saveChatMessage } from "../apps/server/src/services/ai/memory.js";
import { writePageState } from "../apps/server/src/services/page-state.js";
import { systemErrorMessage } from "../apps/web/src/shared/system-errors.js";

let db: DB, actor: Actor, root: string;
const password = "error-i18n-test-2026";

beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-error-i18n-"));
  actor = { ...await createUser(db, { login: "error-i18n", displayName: "Error test", password }, { bootstrap: true }), admin: 1 };
  await saveAIConfig(db, {
    ...aiDefaults,
    imageModel: "image",
    vendors: [{ id: "fixture", name: "Fixture", provider: "compatible", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-secret", enabled: true }],
    models: [
      { id: "chat", vendorId: "fixture", model: "fixture-chat", alias: "Chat", enabled: true, tools: true, maxInput: 64000, maxOutput: 2000 },
      { id: "image", vendorId: "fixture", model: "fixture-image", alias: "Image", enabled: true, tools: false, imageGeneration: true, imageProfile: "gpt-image-2", maxInput: 32000, maxOutput: 1000 },
    ],
  }, 0);
});

afterEach(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

it("codes new image failures while preserving saved history, tool feedback and the cached prefix", async () => {
  const now = new Date().toISOString();
  const session: Schema["ai_sessions"] = {
    id: randomUUID(), user_id: actor.id, title: "History fixture", model_id: "chat",
    resource_ids: "[]", archived: 0, revision: 1, created_at: now, updated_at: now,
  };
  await db.insertInto("ai_sessions").values(session).execute();
  const jobRow = (id: string): Schema["ai_jobs"] => ({
    id, session_id: session.id, user_id: actor.id, model_id: "chat", status: "queued",
    input: JSON.stringify({ text: "生成一张简单图片", scope: "all", references: [], attachments: [], files: [], skillIds: [], webSearch: false }),
    digest: id, result: "", error: "", lease: null, lease_until: null,
    attempts: 0, cancelled: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const oldId = randomUUID();
  const oldJob = {
    ...jobRow(oldId), status: "failed" as const,
    error: "图片模型认证失败，请检查厂商密钥",
    result: JSON.stringify({ progress: { phase: "completed", text: "历史回答原文", reasoning: "历史推理原文", sources: [] } }),
  };
  await db.insertInto("ai_jobs").values(oldJob).execute();
  const events = createAISessionEventStore(db);
  await events.append({ sessionId: session.id, id: `${oldId}:attempt`, type: "assistant/attempt", data: { jobId: oldId, error: oldJob.error, status: "failed" } });
  const oldEvent = await db.selectFrom("ai_session_events").selectAll().where("session_id", "=", session.id).executeTakeFirstOrThrow();
  const requests: any[] = [];
  const runner = createAIRunner(db, {
    memory: { driver: "sqlite", url: join(root, "memory.db") },
    imageFetch: (async () => Response.json({ error: { message: "fixture-secret" } }, { status: 401 })) as typeof fetch,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const lastUser = body.messages.findLastIndex((message: any) => message.role === "user");
      const finished = body.messages.slice(lastUser + 1).some((message: any) => message.role === "tool");
      return completionResponse({
        id: randomUUID(), object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: finished ? "stop" : "tool_calls", message: finished
          ? { role: "assistant", content: "图片生成失败，请检查厂商密钥。" }
          : { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name: "image_generate", arguments: JSON.stringify({ prompt: "画一张简单的彩色几何图" }) } }] },
        }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      }, !!body.stream);
    }) as typeof fetch,
  });
  try {
    const memory = await runner.ensureThread(session);
    await saveChatMessage(memory.memory, actor.id, session.id, oldId, "user", "历史用户输入原文", [], [], undefined, "历史上下文原文");
    await saveChatMessage(memory.memory, actor.id, session.id, `${oldId}-answer`, "assistant", "历史模型回答原文", [], [], "历史推理原文");
    const historicalMessages = async () => (await memory.memory.recall({ threadId: session.id, resourceId: memoryOwner(actor.id), perPage: 100 })).messages
      .filter(message => message.id === oldId || message.id === `${oldId}-answer`);
    const beforeHistory = JSON.stringify(await historicalMessages());
    const prefixes: string[] = [], tools: string[] = [];
    for (const [index, locale] of (["zh", "en"] as const).entries()) {
      await writePageState(db, actor.id, "ui.locale", locale, index);
      const id = randomUUID(), start = requests.length;
      await db.insertInto("ai_jobs").values(jobRow(id)).execute();
      await runner.pump();
      let job: Schema["ai_jobs"] | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        job = await db.selectFrom("ai_jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
        if (!["queued", "running"].includes(job.status)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(job?.status, job?.error).toBe("failed");
      expect(decodeSystemError(job!.error)).toEqual({ code: "image_auth_failed" });
      const progress = JSON.parse(job!.result).progress;
      expect(progress.imageGenerationError).toBe(oldJob.error);
      expect(progress.imageGenerationFailure).toEqual({ code: "image_auth_failed" });
      expect(systemErrorMessage(job!.error, createTranslator(locale))).toBe(locale === "zh"
        ? oldJob.error : "Image model authentication failed. Check the provider key.");
      const first = requests[start];
      const oldUserIndex = first.messages.findIndex((message: any) => message.role === "user" && JSON.stringify(message).includes("历史用户输入原文"));
      const oldAnswerIndex = first.messages.findIndex((message: any) => message.role === "assistant" && JSON.stringify(message).includes("历史模型回答原文"));
      expect(oldUserIndex).toBeGreaterThan(0);
      expect(oldAnswerIndex).toBeGreaterThan(oldUserIndex);
      prefixes.push(JSON.stringify(first.messages.slice(0, oldAnswerIndex + 1)));
      tools.push(JSON.stringify(first.tools));
      expect(JSON.stringify(requests.slice(start))).not.toContain("image_auth_failed");
      expect(JSON.stringify(requests.slice(start))).not.toContain("system_error");
      expect(JSON.stringify(await historicalMessages())).toBe(beforeHistory);
      expect(await db.selectFrom("ai_jobs").selectAll().where("id", "=", oldId).executeTakeFirstOrThrow()).toEqual(oldJob);
      expect(await db.selectFrom("ai_session_events").selectAll().where("event_id", "=", oldEvent.event_id).executeTakeFirstOrThrow()).toEqual(oldEvent);
      const attemptEvent = await db.selectFrom("ai_session_events").select("payload").where("session_id", "=", session.id)
        .where("type", "=", "assistant/attempt").where("event_id", "like", `${id}:%`).executeTakeFirstOrThrow();
      expect(decodeSystemError(JSON.parse(attemptEvent.payload).error)).toEqual({ code: "image_auth_failed" });
    }
    expect(prefixes[0]).toBe(prefixes[1]);
    expect(tools[0]).toBe(tools[1]);
  } finally {
    await runner.close();
  }
});

it("returns coded image model probe failures over HTTP without leaking provider secrets", async () => {
  const origin = "http://localhost:39261";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: join(root, "probe-memory.db") },
      fetch: (async () => Response.json({ error: "fixture-secret" }, { status: 401 })) as typeof fetch },
  });
  try {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin, host: "localhost:39261" }, payload: { login: "error-i18n", password } });
    expect(login.statusCode, login.body).toBe(200);
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/ai/models/image/test",
      headers: { origin, host: "localhost:39261", cookie: String(login.headers["set-cookie"]).split(";")[0]! } });
    expect(response.statusCode, response.body).toBe(502);
    expect(decodeSystemError(response.json().message)).toEqual({ code: "image_auth_failed" });
    expect(response.body).not.toContain("fixture-secret");
    expect(systemErrorMessage(response.json().message, createTranslator("en"))).toContain("authentication failed");
  } finally {
    await app.close();
  }
});
