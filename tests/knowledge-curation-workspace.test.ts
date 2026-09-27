import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import Fastify, {type FastifyRequest,type FastifyReply} from "fastify";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { authorizeFileFolder } from "@core/modules/access/file-access.js";
import { authorize } from "@core/modules/access/queries.js";
import {
  subscribeKnowledgeSource,
  listKnowledgeSubscriptions,
} from "@core/modules/knowledge/subscriptions.js";
import { createKnowledgeConversation } from "@core/modules/knowledge/conversations.js";
import {
  upsertHumanTask,
  reconcileHumanTasks,
  closeHumanTask,
} from "@core/modules/knowledge/human-tasks.js";
import {
  knowledgeInstructions,
  saveKnowledgeSettings,
} from "@core/modules/knowledge/system.js";
import {
  createKnowledgeStudio,
  runSourceAction,
} from "../apps/server/src/services/ai/knowledge-studio.js";
import { registerCurationWorkspace } from "../apps/server/src/routes/knowledge-curation-workspace.js";
let db: DB,
  alice: Actor,
  bob: Actor,
  actor: Actor,
  library: string,
  app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const users = ["alice", "bob"].map((login) => ({
    id: randomUUID(),
    login,
    display_name: login,
    admin: 0,
    status: "active",
    password_hash: "unused",
    created_at: new Date().toISOString(),
  }));
  await db.insertInto("users").values(users).execute();
  alice = users[0]!;
  bob = users[1]!;
  actor = alice;
  library = (
    await createContent(db).create(alice, {
      kind: "library",
      format: "markdown",
      title: "Curation",
    })
  ).id;
  await db
    .insertInto("grants")
    .values({
      resource_id: library,
      user_id: bob.id,
      role: "manager",
      status: "active",
      source_type: "direct",
      source_id: bob.id,
      include_descendants: 1,
    })
    .execute();
  app = Fastify();
  app.setErrorHandler((e: any, _req:FastifyRequest, reply:FastifyReply) =>
    reply.code(e.status ?? 400).send({ message: e.message }),
  );
  registerCurationWorkspace(app, db, () => actor);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await db.destroy();
});
it("delegates source reads inside curation without original access or upload permission", async () => {
  const document = (
    await createContent(db).create(alice, {
      kind: "document",
      format: "markdown",
      title: "Private source",
    })
  ).id;
  const source = await subscribeKnowledgeSource(db, alice, library, {
    sourceKind: "document",
    sourceId: document,
    title: "Team source",
  });
  const studio = createKnowledgeStudio(db);
  await expect(
    studio.executeTool(bob, library, "read_source", { sourceId: source.id }),
  ).resolves.toBeDefined();
  await expect(authorize(db, bob, document, 1)).rejects.toBeDefined();
  const folder = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("file_folders")
    .values({
      id: folder,
      owner_id: alice.id,
      parent_id: null,
      name: "Private folder",
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  await subscribeKnowledgeSource(db, alice, library, {
    sourceKind: "folder",
    sourceId: folder,
  });
  expect(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/libraries/${library}/upload-targets`,
      })
    ).json().items,
  ).toHaveLength(1);
  actor = bob;
  expect(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/libraries/${library}/upload-targets`,
      })
    ).json().items,
  ).toHaveLength(0);
  await expect(authorizeFileFolder(db, bob, folder, 3)).rejects.toBeDefined();
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/v1/knowledge/libraries/${library}/subscriptions/${source.id}/name`,
    payload: { name: "Shared source title" },
  });
  expect(renamed.statusCode).toBe(200);
  expect(
    (await listKnowledgeSubscriptions(db, bob, library)).items.find(
      (x) => x.id === source.id,
    )?.name,
  ).toBe("Shared source title");
  await runSourceAction(db, bob, library, {
    sourceKey: source.id,
    action: "pause",
    reason: "Off",
  });
  await expect(
    studio.executeTool(bob, library, "read_source", { sourceId: source.id }),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await studio.executeTool(bob, library, "scan_sources", {})) as any,
  ).toBeDefined();
  await runSourceAction(db, bob, library, {
    sourceKey: source.id,
    action: "resume",
    reason: "On",
  });
  await expect(
    studio.executeTool(bob, library, "read_source", { sourceId: source.id }),
  ).resolves.toBeDefined();
});
it("keeps tasks nonblocking, scoped and current, with optimistic decisions and durable audit", async () => {
  const conversation = await createKnowledgeConversation(
    db,
    alice,
    library,
    "curation",
    "First",
  );
  const input = {
    key: "source:needed",
    kind: "source" as const,
    title: "Need source",
    detail: {
      reason: "Missing evidence",
      sourceKey: "https://example.com/guide",
    },
  };
  const task = await upsertHumanTask(
    db,
    alice,
    library,
    conversation.id,
    input,
  );
  expect(
    (
      await db
        .selectFrom("knowledge_conversations")
        .select("state")
        .where("id", "=", conversation.id)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("idle");
  await subscribeKnowledgeSource(db, alice, library, {
    sourceKind: "url",
    url: input.detail.sourceKey,
  });
  expect(await reconcileHumanTasks(db, bob, library)).toHaveLength(0);
  expect(
    (
      await db
        .selectFrom("knowledge_human_tasks")
        .selectAll()
        .where("id", "=", task.id)
        .executeTakeFirstOrThrow()
    ).resolution,
  ).toBe("source_added");
  const decision = await upsertHumanTask(db, alice, library, conversation.id, {
    key: "decision",
    kind: "decision",
    title: "Choose",
    detail: { reason: "A or B" },
  });
  await expect(
    closeHumanTask(db, bob, library, decision.id, 99, "stale"),
  ).rejects.toMatchObject({ status: 409 });
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/knowledge/libraries/${library}/human-tasks/${decision.id}/resolve`,
    payload: { revision: decision.revision, action: "resolve", reason: "A" },
  });
  expect(response.statusCode).toBe(200);
  expect(
    (
      await db
        .selectFrom("knowledge_messages")
        .selectAll()
        .where("conversation_id", "=", conversation.id)
        .execute()
    ).some((x) => x.author_id === alice.id && x.content.includes("A")),
  ).toBe(true);
  const replay = await upsertHumanTask(db, alice, library, conversation.id, {
    key: "decision",
    kind: "decision",
    title: "Choose",
    detail: { reason: "A or B" },
  });
  expect(replay.status).toBe("resolved");
  const other = (
    await createContent(db).create(alice, {
      kind: "library",
      format: "markdown",
      title: "Other",
    })
  ).id;
  await expect(
    upsertHumanTask(db, alice, other, conversation.id, input),
  ).rejects.toMatchObject({ status: 403 });
});
it("stores feedback schedules independently of source schedules", async () => {
  const result = await app.inject({
    method: "POST",
    url: `/api/v1/knowledge/libraries/${library}/feedback-schedule`,
    payload: { schedule: "weekly" },
  });
  expect(result.statusCode).toBe(200);
  expect(
    (await knowledgeInstructions(db, alice, library)).settings.feedbackSchedule,
  ).toBe("weekly");
  expect(
    (
      await db
        .selectFrom("resources")
        .select("knowledge_schedule")
        .where("id", "=", library)
        .executeTakeFirstOrThrow()
    ).knowledge_schedule,
  ).toBe("off");
});

it("creates a fresh timestamped feedback conversation only when enabled and due",async()=>{
 const {saveKnowledgeAssistant}=await import('@core/modules/knowledge/system.js');
 const {sweepKnowledgeFeedbackSchedules}=await import('@core/modules/knowledge/feedback-schedule.js');
 await db.updateTable('resources').set({ai_curated:1}).where('id','=',library).execute();
 const bot=await saveKnowledgeAssistant(db,alice,{title:'Feedback bot',libraryIds:[library],expectedRevision:0,enabled:true,memberIds:[]});
 const conversation=await createKnowledgeConversation(db,alice,bot.id,'answer','Snapshot');
 const message=randomUUID();await db.insertInto('knowledge_messages').values({id:message,conversation_id:conversation.id,role:'assistant',author_id:null,trigger:'assistant',content:'Fixture answer',detail:'{}',created_at:new Date().toISOString()}).execute();
 await db.insertInto('knowledge_cases').values({id:randomUUID(),bot_id:bot.id,message_id:message,user_id:alice.id,judgment:'unhelpful',reason:'Fixture',snapshot:'{}',status:'open',created_at:new Date().toISOString()}).execute();
 const count=()=>db.selectFrom('knowledge_messages').selectAll().where('trigger','=','feedback_schedule').execute();
 await sweepKnowledgeFeedbackSchedules(db);expect(await count()).toHaveLength(0);
 const bundle=await knowledgeInstructions(db,alice,library);await saveKnowledgeSettings(db,alice,library,bundle.settingsRevision,{...bundle.settings,feedbackSchedule:'daily'});
 await sweepKnowledgeFeedbackSchedules(db);expect(await count()).toHaveLength(1);
 await sweepKnowledgeFeedbackSchedules(db);expect(await count()).toHaveLength(1);
 const scheduled=(await count())[0]!;expect(scheduled.author_id).toBe(alice.id);
 const thread=await db.selectFrom('knowledge_conversations').selectAll().where('id','=',scheduled.conversation_id).executeTakeFirstOrThrow();expect(thread.title).toMatch(/^\d{4}-\d{2}-\d{2} /);expect(thread.id).not.toBe(conversation.id);
});

it("reconciles existing drafts and loads their full content only on demand",async()=>{
 const {saveHumanKnowledge,reviewKnowledgeEntry}=await import('@core/modules/knowledge/system.js');
 await createKnowledgeConversation(db,alice,library,'curation','Draft review');
 const entry=await saveHumanKnowledge(db,alice,library,{title:'Draft',markdown:'Detailed fixture content',expectedRevision:0},'ai');
 const root=`/api/v1/knowledge/libraries/${library}/human-tasks`;
 const items=(await app.inject({method:'GET',url:root})).json().items;expect(items).toHaveLength(1);expect(items[0].entry).toBeUndefined();
 const detail=(await app.inject({method:'GET',url:`${root}/${items[0].id}`})).json();expect(detail.entry.markdown).toBe('Detailed fixture content');
 await reviewKnowledgeEntry(db,alice,library,entry.id,entry.revision,'publish');
 expect((await app.inject({method:'GET',url:root})).json().items).toHaveLength(0);
});
it("lets the AI create and close tasks only inside the current curation library",async()=>{
 const conversation=await createKnowledgeConversation(db,alice,library,'curation','Tool test');
 const studio=createKnowledgeStudio(db);
 const task:any=await studio.executeTool(alice,library,'human_task',{key:'reader',title:'Choose audience',reason:'Choose the level',options:['Student','Engineer']},db,false,conversation.id);
 expect(task.status).toBe('open');
 await studio.executeTool(alice,library,'resolve_human_task',{id:task.id,revision:task.revision,reason:'Scope clarified'},db,false,conversation.id);
 expect(await reconcileHumanTasks(db,alice,library)).toHaveLength(0);
});
