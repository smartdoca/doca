import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
import {
  createAIMemory,
  memoryOwner,
  messageText,
} from "../apps/server/src/services/ai/memory.js";

it("retains one complete current user message before failed compaction so session reload and an explicit same-session retry use the real failed job", async () => {
  const root = await mkdtemp(join(tmpdir(), "doca-history-flow-"));
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const password = "isolated-history-flow-2026",
    origin = "http://localhost:39343";
  const actor = await createUser(
    db,
    { login: "history-flow", displayName: "History flow", password },
    { bootstrap: true },
  );
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      defaultModel: "chat",
      vendors: [
        {
          id: "fixture",
          name: "Fixture",
          provider: "compatible",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "fixture",
          enabled: true,
        },
      ],
      models: [
        {
          id: "chat",
          vendorId: "fixture",
          model: "fixture-chat",
          alias: "Chat",
          enabled: true,
          tools: true,
          maxInput: 64000,
          maxOutput: 4000,
        },
      ],
      historyRounds: 2,
    },
    0,
  );
  let observerRequests = 0,
    executorRequests = 0,
    imageRequests = 0;
  const app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: {
      memory: { driver: "sqlite", url: join(root, "memory.sqlite") },
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.tools?.length) executorRequests++;
        else observerRequests++;
        return Response.json(
          { error: { message: "Fixture summary authentication failure" } },
          { status: 401 },
        );
      }) as typeof fetch,
      imageFetch: (async () => {
        imageRequests++;
        throw Error("History cannot generate images");
      }) as typeof fetch,
    },
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, host: "localhost:39343" },
      payload: { login: "history-flow", password },
    });
    expect(login.statusCode).toBe(200);
    const headers = {
      origin,
      host: "localhost:39343",
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/ai/sessions",
      headers,
      payload: { modelId: "chat" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const sid = created.json().id;
    const memory = await createAIMemory({
      driver: "sqlite",
      url: join(root, "memory.sqlite"),
    });
    const historical = Array.from({ length: 16 }, (_, index) => ({
      id: `history-${index}`,
      threadId: sid,
      resourceId: memoryOwner(actor.id),
      role: "user" as const,
      createdAt: new Date(Date.UTC(2026, 8, 15, 0, 0, index)),
      content: {
        format: 2 as const,
        parts: [
          {
            type: "text" as const,
            text: `原正式任务不准降低质量；妈妈REF_MOM，爸爸REF_DAD，孩子Zeze。${"Historical task details preserve references and all original delivery requirements. ".repeat(1000)}`,
          },
        ],
      },
    }));
    await memory.memory.saveMessages({ messages: historical });
    const before = (
      await memory.memory.recall({
        threadId: sid,
        resourceId: memoryOwner(actor.id),
        perPage: false,
      })
    ).messages;
    await memory.close();
    const currentText =
      "当前完整正式任务：继续原范围，保留全部人物身份与原始标准；不能因为压缩故障删除原历史。";
    const current = randomUUID();
    async function submit(id: string, retryOf?: string) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/ai/sessions/${sid}/messages`,
        headers,
        payload: {
          id,
          modelId: "chat",
          scope: "all",
          text: currentText,
          webSearch: false,
          ...(retryOf ? { retryOf } : {}),
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      for (let attempt = 0; attempt < 300; attempt++) {
        const session = (
          await app.inject({ url: `/api/v1/ai/sessions/${sid}`, headers })
        ).json();
        const job = session.jobs.find((item: any) => item.id === id);
        if (job && !["queued", "running"].includes(job.status)) {
          expect(job.status, job.error).toBe("failed");
          expect(
            session.messages.filter((message: any) => message.id === id),
          ).toMatchObject([{ id, role: "user", text: currentText }]);
          return session;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw Error("Isolated history job did not finish");
    }
    await submit(current);
    const originalJob = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", current)
      .executeTakeFirstOrThrow();
    expect(
      JSON.parse(originalJob.result).progress.events.some(
        (event: any) => event.code === "history_compression_failed",
      ),
    ).toBe(true);
    const retry = randomUUID();
    await submit(retry, current);
    expect(
      JSON.parse(
        (
          await db
            .selectFrom("ai_jobs")
            .select("input")
            .where("id", "=", retry)
            .executeTakeFirstOrThrow()
        ).input,
      ).retryOf,
    ).toBe(current);
    expect(
      await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", current)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalJob);
    const reopened = await createAIMemory({
      driver: "sqlite",
      url: join(root, "memory.sqlite"),
    });
    try {
      const rows = (
        await reopened.memory.recall({
          threadId: sid,
          resourceId: memoryOwner(actor.id),
          perPage: false,
        })
      ).messages;
      expect(rows).toHaveLength(historical.length + 2);
      for (const message of before)
        expect(messageText(rows.find((row) => row.id === message.id))).toBe(
          messageText(message),
        );
      for (const id of [current, retry]) {
        const row = rows.find((row) => row.id === id)!;
        expect(messageText(row)).toBe(currentText);
        expect(row.content.metadata?.promptContext).toContain(
          "会话附件清单（持久 ID",
        );
        expect(row.content.metadata?.promptContext).toContain(
          "本轮未开启联网搜索",
        );
        const events = await db
          .selectFrom("ai_session_events")
          .select("event_id")
          .where("session_id", "=", sid)
          .where("type", "=", "user/message")
          .where("payload", "like", `%${id}%`)
          .execute();
        expect(events).toHaveLength(1);
      }
    } finally {
      await reopened.close();
    }
    expect(observerRequests).toBe(2);
    expect(executorRequests).toBe(0);
    expect(imageRequests).toBe(0);
    expect(
      await db.selectFrom("ai_operations").select("id").execute(),
    ).toHaveLength(0);
  } finally {
    await app.close();
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
