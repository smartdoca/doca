import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { readAIDocument } from "@core/workflows/ai-documents.js";
import {
  aiDefaults,
  saveAIConfig,
} from "@core/modules/ai/config.js";
import { createAIRunner } from "../apps/server/src/services/ai/runner.js";
import { completeExchanges } from "../apps/server/src/services/ai/checkpoint.js";
import {
  applyProgressPatch,
  progressPatch,
  type AIProgress,
} from "@core/modules/ai/progress.js";
import { mockAI } from "./ai-mock.js";
it("replays chronological events by offset without duplicating earlier steps", () => {
  const start: AIProgress = {
    phase: "思考",
    text: "",
    reasoning: "分析",
    steps: [],
    sources: [],
    events: [
      {
        id: "1",
        kind: "reasoning",
        at: "2026-09-15",
        text: "分析",
        status: "loading",
      },
    ],
  };
  const next: AIProgress = {
    ...start,
    events: [
      { ...start.events![0]!, status: "success" },
      {
        id: "2",
        kind: "tool",
        at: "2026-09-15",
        text: "读取文档",
        status: "loading",
      },
    ],
  };
  expect(applyProgressPatch(start, progressPatch(start, next))).toEqual(next);
  const final: AIProgress = {
    ...next,
    events: [
      ...next.events!,
      {
        id: "3",
        kind: "text",
        at: "2026-09-15",
        text: "结论",
        status: "success",
      },
    ],
  };
  expect(progressPatch(next, final).eventOffset).toBe(2);
  expect(applyProgressPatch(next, progressPatch(next, final))).toEqual(final);
  expect(applyProgressPatch(final, progressPatch(undefined, next))).toEqual(
    next,
  );
});
it("only checkpoints complete tool exchanges, never partial calls", () => {
  const request = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "document_edit",
        input: {},
      },
    ],
  };
  expect(completeExchanges([request])).toBe(false);
  expect(
    completeExchanges([
      request,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            output: { saved: true },
          },
        ],
      },
    ]),
  ).toBe(true);
  expect(completeExchanges([{ role: "user", content: [] }])).toBe(false);
});
it.each(["shutdown", "expired lease", "repeated shutdown"])(
  "resumes after %s, preserves ordering and never writes the persisted edit twice",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "doca-resume-"));
    let db = await openTestDatabase({
      driver: "sqlite",
      path: join(root, "doca.db"),
    });
    const user = {
      ...(await createUser(
        db,
        {
          login: "resume-test",
          displayName: "恢复测试",
          password: "resume-test-password",
        },
        { bootstrap: true },
      )),
      admin: 1,
    };
    const doc = await createContent(db).create(user, {
      title: "恢复测试",
      kind: "document",
      format: "markdown",
      markdown: "# 恢复测试",
    });
    await saveAIConfig(
      db,
      {
        ...aiDefaults,
        limits: { standard: { day: null, week: null, month: null } },
        vendors: [
          {
            id: "test-vendor",
            name: "测试厂商",
            provider: "compatible",
            baseUrl: "https://example.test/v1",
            apiKey: "fixture",
            enabled: true,
          },
        ],
        models: [
          {
            id: "mock",
            vendorId: "test-vendor",
            model: "mock",
            alias: "测试",
            tools: true,
            enabled: true,
            levels: [],
            inputRate: 1,
            outputRate: 1,
            cacheRate: 1,
            maxInput: 64000,
            maxOutput: 2000,
          },
        ],
      },
      0,
    );
    const sessionId = randomUUID(),
      id = randomUUID(),
      now = new Date().toISOString();
    await db
      .insertInto("ai_sessions")
      .values({
        id: sessionId,
        user_id: user.id,
        title: "恢复测试",
        model_id: "mock",
        resource_ids: JSON.stringify([doc.id]),
        archived: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("ai_jobs")
      .values({
        id,
        session_id: sessionId,
        user_id: user.id,
        model_id: "mock",
        status: "queued",
        input: JSON.stringify({
          text: `添加测试内容 ${doc.id}`,
          references: [{ resourceId: doc.id }],
          scope: "document",
          skillIds: [],
        }),
        digest: "fixture",
        result: "",
        error: "",
        lease: null,
        lease_until: null,
        attempts: mode === "repeated shutdown" ? 3 : 0,
        cancelled: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const memory = { driver: "sqlite" as const, url: join(root, "memory.db") };
    const fixture = mockAI({ reasoning: "我先读取文档，再逐段写入。" });
    let waiting = false;
    let runner = createAIRunner(db, {
      memory,
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.messages.filter((m: any) => m.role === "tool").length >= 2) {
          waiting = true;
          await new Promise((_, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        return fixture(url, init);
      }) as typeof fetch,
    });
    try {
      await runner.pump();
      for (let i = 0; i < 200 && !waiting; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(waiting).toBe(true);
      const job = await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const checkpoint = JSON.parse(job.result).checkpoint;
      expect(
        checkpoint.messages.filter((m: any) => m.role === "tool"),
      ).toHaveLength(2);
      expect(checkpoint.artifacts).toEqual([doc.id]);
      await runner.close();
      await db.destroy();
      db = await openTestDatabase({
        driver: "sqlite",
        path: join(root, "doca.db"),
      });
      expect(
        (
          await db
            .selectFrom("ai_jobs")
            .select("status")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("queued");
      if (mode === "expired lease") {
        // Recreate the persisted state left by a killed process, with its lease expired.
        await db
          .updateTable("ai_jobs")
          .set({
            status: "running",
            lease: "dead-worker",
            lease_until: new Date(Date.now() - 1000).toISOString(),
          })
          .where("id", "=", id)
          .execute();
      }
      const resumed: any[] = [];
      runner = createAIRunner(db, {
        memory,
        fetch: mockAI({
          record: (r) => resumed.push(r),
          reasoning: "继续核对结果。",
        }),
      });
      await runner.pump();
      let final;
      for (let i = 0; i < 200; i++) {
        final = await db
          .selectFrom("ai_jobs")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        if (!["queued", "running"].includes(final.status)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(final?.status, final?.error).toBe("completed");
      expect(
        resumed[0].messages.filter((m: any) => m.role === "tool"),
      ).toHaveLength(2);
      expect(
        await db.selectFrom("ai_operations").selectAll().execute(),
      ).toHaveLength(1);
      const content = JSON.stringify(
        (await readAIDocument(db, { actor: user }, doc.id)).value,
      );
      expect(content.match(/AI 模拟写入/g)).toHaveLength(1);
      const events = JSON.parse(final!.result).progress.events;
      expect(
        events.some(
          (e: any) => e.kind === "status" && e.text.includes("已恢复"),
        ),
      ).toBe(true);
      expect(events.findIndex((e: any) => e.kind === "tool")).toBeLessThan(
        events.findLastIndex((e: any) => e.kind === "text"),
      );
    } finally {
      await runner.close();
      await db.destroy();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
