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

it("exposes whether saved documents are actually available to answers", async () => {
  const studio=createKnowledgeStudio(db);
  expect(await studio.executeTool(actor,library,"inspect",{})).toMatchObject({answerPublication:{status:"pending",dirty:true}});
  await publishKnowledgeDocuments(db,actor,library);
  expect(await studio.executeTool(actor,library,"inspect",{})).toMatchObject({answerPublication:{status:"ready",dirty:false}});
  await createContent(db).create(actor,{kind:"document",format:"markdown",libraryId:library,title:"New unpublished facts",markdown:"Port 8097"});
  expect(await studio.executeTool(actor,library,"inspect",{})).toMatchObject({answerPublication:{status:"ready",dirty:true}});
});

it("exposes empty parent directories so curation can fill their overviews", async () => {
 const entry=await saveHumanKnowledge(db,actor,library,{expectedRevision:0,title:"Connection",path:["Operations"],markdown:"# Connection\n\nUse port 8097. The idle timeout is 73 seconds. Retry at most four times."});
 await reviewKnowledgeEntry(db,actor,library,entry.id,entry.revision,"publish");
 const studio=createKnowledgeStudio(db);const inspected=await studio.executeTool(actor,library,"inspect",{}) as any;
 expect(inspected.directories).toEqual([expect.objectContaining({title:"Operations",documentId:expect.any(String)})]);
 const context=await studio.executeTool(actor,library,"overview_context",{documentId:inspected.directories[0].documentId}) as any;
 expect(context.children).toEqual([expect.objectContaining({title:"Connection",link:expect.stringContaining("#/r/")})]);
});
it("keeps the policy and executes status requests when the intent quote is invalid", async () => {
  const bundle = await knowledgeInstructions(db, actor, library);
  await saveKnowledgeSettings(db, actor, library, bundle.settingsRevision, {...bundle.settings, sourceScope: "internal"});
  const run = await task("检查当前开启的数据源，不要重新开启关闭的来源");
  model.doStream
    .mockResolvedValueOnce(text(JSON.stringify({mode:"web",quote:"允许网络来源"})))
    .mockResolvedValueOnce(tool("inspect", {}))
    .mockResolvedValueOnce(text("已检查，未修改来源"));
  await createKnowledgeStudio(db).process(run.id);
  expect((await knowledgeInstructions(db, actor, library)).settings.sourceScope).toBe("internal");
  const rows = await db.selectFrom("knowledge_messages").selectAll().where("conversation_id","=",run.conversation.id).where("role","=","tool").execute();
  expect(rows.some(row => JSON.parse(row.detail).name === "inspect")).toBe(true);
  expect((await db.selectFrom("knowledge_tasks").selectAll().where("id","=",run.id).executeTakeFirstOrThrow()).status).toBe("completed");
});
it("completes failed read events instead of leaving a running tool in the UI", async () => {
  const run = await task("检查来源");
  model.doStream
    .mockResolvedValueOnce(text(JSON.stringify({mode:"unchanged",quote:""})))
    .mockResolvedValueOnce(tool("read_source", {sourceId:randomUUID()}))
    .mockResolvedValueOnce(text("来源不可用，未修改内容"));
  await createKnowledgeStudio(db).process(run.id);
  const rows=await db.selectFrom("knowledge_messages").selectAll().where("conversation_id","=",run.conversation.id).where("role","=","tool").execute();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!.detail)).toMatchObject({status:"completed",result:{error:expect.any(String)}});
});
it("returns fresh overview context after a conflict and never overwrites it", async () => {
  const entry=await saveHumanKnowledge(db,actor,library,{expectedRevision:0,title:"Connection",path:["Operations"],markdown:"Use port 8097 and retry four times."});
  await reviewKnowledgeEntry(db,actor,library,entry.id,entry.revision,"publish");
  const studio=createKnowledgeStudio(db);
  const info=await studio.executeTool(actor,library,"inspect",{}) as any;
  const context=await studio.executeTool(actor,library,"overview_context",{documentId:info.directories[0].documentId}) as any;
  const input={documentId:context.documentId,expectedSeq:context.expectedSeq,childFingerprint:context.childFingerprint,markdown:"This guide covers the connection chapter. Start by reading Connection for the listening port and retry count. Follow the chapter link for exact operational parameters, and do not infer undocumented retention policies."};
  const saved=await studio.executeTool(actor,library,"overview",input) as any;
  expect(saved.context.expectedSeq).toBeGreaterThan(context.expectedSeq);
  const conflict=await studio.executeTool(actor,library,"overview",{...input,markdown:"Different contents. ".repeat(12)}) as any;
  expect(conflict.error).toBeTruthy();
  expect(conflict.context.markdown).toContain("This guide covers");
  expect(conflict.context.expectedSeq).toBe(saved.context.expectedSeq);
});
it("does not classify an unpublished answer failure as missing knowledge", async () => {
  const bot=await saveKnowledgeAssistant(db,actor,{expectedRevision:0,title:"QA",libraryIds:[library],enabled:true,visibility:"invited",memberIds:[],managerIds:[],channels:["web"]});
  const caseId=randomUUID();
  await db.insertInto("knowledge_cases").values({id:caseId,bot_id:bot.id,message_id:randomUUID(),user_id:actor.id,judgment:"unhelpful",reason:"No evidence",snapshot:JSON.stringify({messages:[{role:"user",content:"What port?"}]}),status:"open",created_at:new Date().toISOString()}).execute();
  const studio=createKnowledgeStudio(db);
  await expect(studio.executeTool(actor,library,"classify_feedback",{caseId,category:"missing",reason:"No evidence",status:"reviewed"})).rejects.toThrow("问答发布尚未同步");
  await expect(studio.executeTool(actor,library,"classify_feedback",{caseId,category:"retrieval",reason:"Publication pending",status:"reviewed"})).resolves.toMatchObject({ok:true});
});
it("binds overview writes to read context and applies identical writes only once per task", async () => {
  const entry=await saveHumanKnowledge(db,actor,library,{expectedRevision:0,title:"Connection",path:["Operations"],markdown:"Use port 8097 and retry four times."});
  await reviewKnowledgeEntry(db,actor,library,entry.id,entry.revision,"publish");
  const studio=createKnowledgeStudio(db);
  const info=await studio.executeTool(actor,library,"inspect",{}) as any;
  const documentId=info.directories[0].documentId;
  const before=await studio.executeTool(actor,library,"overview_context",{documentId}) as any;
  const run=await task("Update the overview");
  const args={documentId,markdown:"This overview introduces Connection, covering the port and retry settings. Read the linked Connection chapter for the supported operational facts. Retention policy is not documented and must not be inferred from this guide."};
  model.doStream
    .mockResolvedValueOnce(text(JSON.stringify({mode:"unchanged",quote:""})))
    .mockResolvedValueOnce(tool("overview_context",{documentId}))
    .mockResolvedValueOnce(tool("overview",args))
    .mockResolvedValueOnce(tool("overview",args))
    .mockResolvedValueOnce(text("Saved"));
  await studio.process(run.id);
  const after=await studio.executeTool(actor,library,"overview_context",{documentId}) as any;
  expect(after.expectedSeq).toBe(before.expectedSeq+1);
  expect(after.markdown).toContain("This overview introduces");
});
it("keeps a missing-information task open when evidence only acknowledges the unknown", async () => {
  const run=await task("补充边界说明");
  const studio=createKnowledgeStudio(db);
  const pending:any=await studio.executeTool(actor,library,"human_task",{key:"retention",title:"补充保留期限",reason:"客户数据保留期限未定",options:[]},db,false,run.conversation.id);
  const document=await createContent(db).create(actor,{kind:"document",format:"markdown",title:"Policy",markdown:"客户数据保留期限尚未确定，请不要根据本指南推断。"});
  const source=await subscribeKnowledgeSource(db,actor,library,{sourceKind:"document",sourceId:document.id,title:"Policy"});
  model.doStream.mockResolvedValueOnce(text('{"satisfied":false}'));
  await expect(studio.executeTool(actor,library,"resolve_human_task",{id:pending.id,revision:pending.revision,reason:"已写明未知",evidence:{sourceId:source.id,quote:"客户数据保留期限尚未确定"}},db,false,run.conversation.id)).rejects.toThrow("不能证明待办已经解决");
  expect((await db.selectFrom("knowledge_human_tasks").select("status").where("id","=",pending.id).executeTakeFirstOrThrow()).status).toBe("open");
});
it("renders feedback completion from saved classifications instead of contradictory model prose", async () => {
  const bot=await saveKnowledgeAssistant(db,actor,{expectedRevision:0,title:"QA",libraryIds:[library],enabled:true,visibility:"invited",memberIds:[],managerIds:[],channels:["web"]});
  const caseId=randomUUID();
  await db.insertInto("knowledge_cases").values({id:caseId,bot_id:bot.id,message_id:randomUUID(),user_id:actor.id,judgment:"unhelpful",reason:"",snapshot:JSON.stringify({messages:[{role:"user",content:"What port?"}],evidence:{citations:[]}}),status:"open",created_at:new Date().toISOString()}).execute();
  const run=await task("处理反馈");
  model.doStream.mockResolvedValueOnce(text('{"mode":"unchanged","quote":""}'))
    .mockResolvedValueOnce(tool("classify_feedback",{caseId,category:"answer",reason:"Model extraction failure",status:"reviewed"}))
    .mockResolvedValueOnce(text("已修复知识缺失并关闭所有待办"));
  await createKnowledgeStudio(db).process(run.id);
  const answer=await db.selectFrom("knowledge_messages").select("content").where("conversation_id","=",run.conversation.id).where("role","=","assistant").executeTakeFirstOrThrow();
  expect(answer.content).toContain("检索或发布问题");
  expect(answer.content).toContain("仍待处理");
  expect(answer.content).not.toContain("关闭所有待办");
});
