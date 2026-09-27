import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  knowledgeInstructions,
  saveKnowledgeSettings,
  saveHumanKnowledge,
  reviewKnowledgeEntry,
  saveKnowledgeAssistant,
} from "@core/modules/knowledge/system.js";
import {
  createKnowledgeConversation,
  sendKnowledgeMessage,
} from "@core/modules/knowledge/conversations.js";
import { publishKnowledgeDocuments } from "@core/modules/knowledge/publications.js";
import {
  createKnowledgeStudio,
  runSourceAction,
} from "../apps/server/src/services/ai/knowledge-studio.js";
import { retryKnowledgeTask } from "@core/modules/knowledge/recovery.js";
import { subscribeKnowledgeSource } from "@core/modules/knowledge/subscriptions.js";
const model = vi.hoisted(() => ({ doStream: vi.fn() }));
vi.mock("../apps/server/src/services/ai/model.js", () => ({
  meteredModel: async () => model,
}));
vi.mock("@core/modules/ai/config.js", () => ({
  aiConfig: async () => ({ defaultModel: "test", webSearch: {} }),
}));
let db: DB, actor: Actor, library: string;
const output = (content: any[]) => ({
  stream: new ReadableStream({
    start(c) {
      for (const part of content) c.enqueue(part);
      c.enqueue({ type: "finish", finishReason: { unified: "stop" } });
      c.close();
    },
  }),
});
const text = (value: string) => output([{ type: "text-delta", delta: value }]);
const tool = (name: string, input: unknown, id = randomUUID()) =>
  output([
    {
      type: "tool-call",
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(input),
    },
  ]);
beforeEach(async () => {
  model.doStream.mockReset();
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  actor = { id: randomUUID(), display_name: "Manager", admin: 0 };
  await db
    .insertInto("users")
    .values({
      ...actor,
      login: "manager",
      password_hash: "unused",
      status: "active",
      created_at: new Date().toISOString(),
    })
    .execute();
  library = (
    await createContent(db).create(actor, {
      kind: "library",
      format: "markdown",
      title: "Studio",
    })
  ).id;
});
afterEach(() => db.destroy());
async function task(content = "Build guide", trigger = "manual") {
  const conversation = await createKnowledgeConversation(
      db,
      actor,
      library,
      "curation",
      "Curation",
    ),
    id = randomUUID();
  await sendKnowledgeMessage(db, actor, conversation.id, content, id, trigger);
  return { id, conversation };
}
it("enforces internal-only scope in web tools, recommendations and direct subscription", async () => {
  const bundle = await knowledgeInstructions(db, actor, library);
  await saveKnowledgeSettings(db, actor, library, bundle.settingsRevision, {
    ...bundle.settings,
    sourceScope: "internal",
  });
  const studio = createKnowledgeStudio(db);
  await expect(
    studio.executeTool(actor, library, "search_sources", { query: "DNS" }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    studio.executeTool(actor, library, "read_web", {
      url: "https://example.com",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    runSourceAction(db, actor, library, {
      sourceKey: "https://example.com",
      action: "recommend",
      reason: "quality",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    subscribeKnowledgeSource(db, actor, library, {
      sourceKind: "url",
      url: "https://example.com",
    }),
  ).rejects.toMatchObject({ status: 403 });
});
it("persists explicit human source intent before any agent action and retains it for scheduled sessions", async () => {
  const first = await task("只从内部项目文档获取，不要网络来源");
  model.doStream
    .mockResolvedValueOnce(
      text(JSON.stringify({ mode: "internal", quote: "只从内部项目文档获取" })),
    )
    .mockResolvedValueOnce(text("已确认资料范围"));
  await createKnowledgeStudio(db).process(first.id);
  expect(
    (await knowledgeInstructions(db, actor, library)).settings.sourceScope,
  ).toBe("internal");
  const scheduled = await task("整理并检查来源", "schedule");
  model.doStream.mockResolvedValueOnce(text("现有内部资料未发生变化"));
  await createKnowledgeStudio(db).process(scheduled.id);
  expect(
    (await knowledgeInstructions(db, actor, library)).settings.sourceScope,
  ).toBe("internal");
  expect(model.doStream).toHaveBeenCalledTimes(3);
  const third = await task("现在明确允许新增网络来源");
  model.doStream
    .mockResolvedValueOnce(
      text(JSON.stringify({ mode: "web", quote: "明确允许新增网络来源" })),
    )
    .mockResolvedValueOnce(text("已允许"));
  await createKnowledgeStudio(db).process(third.id);
  expect(
    (await knowledgeInstructions(db, actor, library)).settings.sourceScope,
  ).toBe("web");
});
it("keeps tool results and authored drafts in a recoverable journal", async () => {
  const job = await task("Write a draft", "schedule");
  model.doStream
    .mockResolvedValueOnce(
      tool("draft", {
        expectedRevision: 0,
        title: "DNS",
        path: [],
        markdown: "A detailed DNS explanation",
      }),
    )
    .mockResolvedValueOnce(text("完成"));
  await createKnowledgeStudio(db).process(job.id);
  const entries = await db
    .selectFrom("knowledge_entries")
    .selectAll()
    .execute();
  expect(
    entries,
    JSON.stringify(
      await db.selectFrom("knowledge_messages").selectAll().execute(),
    ),
  ).toHaveLength(1);
  expect(entries[0]?.origin).toBe("ai_synthesized");
  expect(JSON.parse(entries[0]!.review_state).humanChange).toBeUndefined();
  const checkpoint = await db
    .selectFrom("knowledge_checkpoints")
    .selectAll()
    .where("task_id", "=", job.id)
    .executeTakeFirstOrThrow();
  expect(checkpoint.detail).toContain(entries[0]!.id);
  await db
    .updateTable("knowledge_tasks")
    .set({ status: "queued" })
    .where("id", "=", job.id)
    .execute();
  model.doStream.mockResolvedValueOnce(text("完成"));
  await createKnowledgeStudio(db).process(job.id);
  expect(
    await db.selectFrom("knowledge_entries").selectAll().execute(),
  ).toHaveLength(1);
});
it("automatically continues pending plan work instead of accepting a progress-only answer", async () => {
  const job = await task("Build", "schedule");
  model.doStream
    .mockResolvedValueOnce(
      tool("work_plan", {
        items: [{ id: "dns", title: "DNS", status: "pending" }],
      }),
    )
    .mockResolvedValueOnce(text("准备继续"))
    .mockResolvedValueOnce(
      tool("work_plan", {
        items: [{ id: "dns", title: "DNS", status: "completed" }],
      }),
    )
    .mockResolvedValueOnce(text("完成"));
  await createKnowledgeStudio(db).process(job.id);
  expect(
    (
      await db
        .selectFrom("knowledge_tasks")
        .select("status")
        .where("id", "=", job.id)
        .executeTakeFirst()
    )?.status,
  ).toBe("completed");
  expect(model.doStream).toHaveBeenCalledTimes(4);
});
it("retries transient failures with bounded backoff but does not retry permission errors", async () => {
  const job = await task("Build", "schedule");
  model.doStream.mockRejectedValueOnce(new Error("network timeout"));
  await createKnowledgeStudio(db).process(job.id);
  const checkpoint = await db
    .selectFrom("knowledge_checkpoints")
    .selectAll()
    .where("task_id", "=", job.id)
    .executeTakeFirstOrThrow();
  expect(checkpoint.attempts).toBe(1);
  expect(Date.parse(checkpoint.available_at)).toBeGreaterThan(Date.now());
  expect(await retryKnowledgeTask(db, job.id, { status: 403 })).toBe(false);
  expect(
    await retryKnowledgeTask(db, job.id, new Error("network timeout")),
  ).toBe(true);
  expect(
    await retryKnowledgeTask(db, job.id, new Error("network timeout")),
  ).toBe(true);
  expect(
    await retryKnowledgeTask(db, job.id, new Error("network timeout")),
  ).toBe(false);
});
it.each([true, false])(
  "keeps cited answers and withdraws unsupported answers (cited=%s)",
  async (cited) => {
    const draft = await saveHumanKnowledge(db, actor, library, {
      title: "DNS",
      markdown: "DNS negative TTL is the minimum of SOA TTL and MINIMUM.",
      expectedRevision: 0,
    });
    await reviewKnowledgeEntry(
      db,
      actor,
      library,
      draft.id,
      draft.revision,
      "publish",
    );
    await publishKnowledgeDocuments(db, actor, library);
    const bot = await saveKnowledgeAssistant(db, actor, {
      title: "DNS",
      libraryIds: [library],
      memberIds: [],
      enabled: true,
      expectedRevision: 0,
    });
    const conversation = await createKnowledgeConversation(
        db,
        actor,
        bot.id,
        "answer",
        "DNS",
      ),
      id = randomUUID();
    await sendKnowledgeMessage(
      db,
      actor,
      conversation.id,
      "DNS negative TTL",
      id,
    );
    model.doStream.mockResolvedValueOnce(
      text(cited ? "Use the smaller value.[1]" : "An unsupported statement."),
    );
    if (!cited)
      model.doStream.mockResolvedValueOnce(text("Still unsupported."));
    await createKnowledgeStudio(db).process(id);
    const message = await db
      .selectFrom("knowledge_messages")
      .selectAll()
      .where("conversation_id", "=", conversation.id)
      .where("role", "=", "assistant")
      .executeTakeFirstOrThrow();
    if (cited) expect(message.content).toContain("[1]");
    else {
      expect(message.content).not.toContain("An unsupported statement");
      expect(JSON.parse(message.detail).evidenceStatus).toBe("insufficient");
    }
    expect(JSON.parse(message.detail).citations.length).toBeGreaterThan(0);
    expect(await db.selectFrom("ai_sessions").selectAll().execute()).toEqual(
      [],
    );
  },
);
