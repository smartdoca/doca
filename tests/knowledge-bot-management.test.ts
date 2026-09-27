import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  saveKnowledgeAssistant,
  listKnowledgeAssistants,
  effectiveKnowledgeBotLibraries,
} from "@core/modules/knowledge/system.js";
import {
  knowledgeBot,
  visibleKnowledgeAnswers,
  conversationAccess,
} from "@core/modules/knowledge/conversations.js";
import { registerKnowledgeStudio } from "../apps/server/src/routes/knowledge-studio.js";
let db: DB,
  alice: Actor,
  bob: Actor,
  actor: Actor,
  library: string,
  bot: any,
  app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const users = ["alice", "bob"].map((login) => ({
    id: randomUUID(),
    login,
    display_name: login,
    password_hash: "unused",
    admin: 0,
    status: "active",
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
      title: "Primary",
    })
  ).id;
  bot = await saveKnowledgeAssistant(db, alice, {
    title: "Network",
    libraryIds: [library],
    memberIds: [],
    managerIds: [],
    enabled: true,
    expectedRevision: 0,
    channels: ["web", "api", "mcp", "embed"],
  });
  app = Fastify();
  app.setErrorHandler((error: any, _req: FastifyRequest, reply: FastifyReply) =>
    reply.code(error.status ?? 400).send({ message: error.message }),
  );
  registerKnowledgeStudio(app, db, () => actor);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await db.destroy();
});
const root = () => `/api/v1/knowledge/assistants/${bot.id}`;
async function key(channel = "api") {
  const response = await app.inject({
    method: "POST",
    url: root() + "/keys",
    payload: { name: "Website", channel },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function ask(token: string) {
  return app.inject({
    method: "POST",
    url: root() + "/api/ask",
    headers: { authorization: `Bearer ${token}` },
    payload: { query: "DNS?" },
  });
}
it("supports unbound bots and shared managers without transferring ownership", async () => {
  const empty = await saveKnowledgeAssistant(db, alice, {
    title: "Unbound",
    libraryIds: [],
    memberIds: [],
    managerIds: [bob.id],
    enabled: true,
    expectedRevision: 0,
  });
  expect(
    JSON.parse((await knowledgeBot(db, alice, empty.id)).library_ids),
  ).toEqual([]);
  const shared = (await listKnowledgeAssistants(db, bob)).find(
    (x) => x.id === empty.id,
  )!;
  expect(shared.canManage).toBe(true);
  await saveKnowledgeAssistant(db, bob, {
    id: empty.id,
    expectedRevision: empty.revision,
    title: "Renamed",
    libraryIds: [],
    memberIds: [],
    managerIds: [bob.id],
    enabled: true,
  });
  expect(
    (
      await db
        .selectFrom("knowledge_assistants")
        .selectAll()
        .where("id", "=", empty.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
  ).toBe(alice.id);
});
it("excludes only revoked libraries and withdraws historical evidence from them", async () => {
  const secondary = (
    await createContent(db).create(bob, {
      kind: "library",
      format: "markdown",
      title: "Secondary",
    })
  ).id;
  await db
    .insertInto("grants")
    .values({ resource_id: secondary, user_id: alice.id, role: "manager" })
    .execute();
  bot = await saveKnowledgeAssistant(db, alice, {
    id: bot.id,
    expectedRevision: bot.revision,
    title: "Network",
    libraryIds: [library, secondary],
    memberIds: [],
    enabled: true,
  });
  expect(await effectiveKnowledgeBotLibraries(db, bot)).toEqual([
    library,
    secondary,
  ]);
  await db.deleteFrom("grants").where("resource_id", "=", secondary).execute();
  expect(
    JSON.parse((await knowledgeBot(db, alice, bot.id)).library_ids),
  ).toEqual([library]);
  const history = await visibleKnowledgeAnswers(db, alice, bot.id, [
    {
      role: "assistant",
      content: "Secondary secret",
      detail: JSON.stringify({ citations: [{ documentId: randomUUID() }] }),
    },
  ]);
  expect(history[0]?.content).toBe("");
  await expect(
    saveKnowledgeAssistant(db, alice, {
      id: bot.id,
      expectedRevision: bot.revision,
      title: "Renamed",
      libraryIds: [library, secondary],
      memberIds: [],
      enabled: true,
    }),
  ).resolves.toBeDefined();
  const listed = await listKnowledgeAssistants(db, bob, secondary);
  expect(listed[0]?.creator.id).toBe(alice.id);
  expect(listed[0]?.canManage).toBe(false);
  expect(listed[0]?.accessible).toBe(false);
});
it("isolates API sessions by key and revokes them immediately", async () => {
  const first = await key(),
    second = await key();
  const result = await ask(first.token);
  expect(result.statusCode).toBe(200);
  const conversation = result.json().conversationId;
  const url = root() + `/api/conversations/${conversation}`;
  expect(
    (
      await app.inject({
        url,
        headers: { authorization: `Bearer ${first.token}` },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url,
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).statusCode,
  ).toBe(403);
  const listed = await app.inject({ url: root() + "/keys" });
  expect(listed.body).not.toContain(first.token);
  expect(listed.body).not.toContain("token_hash");
  await app.inject({ method: "DELETE", url: root() + `/keys/${first.id}` });
  expect(
    (
      await app.inject({
        url,
        headers: { authorization: `Bearer ${first.token}` },
      })
    ).statusCode,
  ).toBe(403);
  await expect(
    conversationAccess(db, alice, conversation),
  ).rejects.toMatchObject({ status: 403 });
});
it("enforces key channel and bot scope", async () => {
  const mcp = await key("mcp");
  expect((await ask(mcp.token)).statusCode).toBe(403);
  const apiKey = await key();
  const another = await saveKnowledgeAssistant(db, alice, {
    title: "Other",
    libraryIds: [library],
    memberIds: [],
    enabled: true,
    expectedRevision: 0,
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/knowledge/assistants/${another.id}/api/ask`,
        headers: { authorization: `Bearer ${apiKey.token}` },
        payload: { query: "DNS" },
      })
    ).statusCode,
  ).toBe(403);
  await db
    .updateTable("knowledge_assistants")
    .set({
      config: JSON.stringify({ channels: ["web"], attachmentsEnabled: false }),
    })
    .where("id", "=", bot.id)
    .execute();
  expect((await ask(apiKey.token)).statusCode).toBe(403);
});
it("issues isolated public sessions only while the bot is public", async () => {
  expect(
    (
      await app.inject({
        method: "POST",
        url: root() + "/public-session",
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  await db
    .updateTable("knowledge_assistants")
    .set({ visibility: "public" })
    .where("id", "=", bot.id)
    .execute();
  const first = (
    await app.inject({
      method: "POST",
      url: root() + "/public-session",
      payload: {},
    })
  ).json();
  const second = (
    await app.inject({
      method: "POST",
      url: root() + "/public-session",
      payload: {},
    })
  ).json();
  const result = await ask(first.token);
  expect(result.statusCode).toBe(200);
  const url = root() + `/api/conversations/${result.json().conversationId}`;
  expect(
    (
      await app.inject({
        url,
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).statusCode,
  ).toBe(403);
  await db
    .updateTable("knowledge_assistants")
    .set({ visibility: "invited" })
    .where("id", "=", bot.id)
    .execute();
  expect((await ask(first.token)).statusCode).toBe(403);
});
it("does not let ordinary members manage keys", async () => {
  actor = bob;
  expect(
    (
      await app.inject({
        method: "POST",
        url: root() + "/keys",
        payload: { name: "forbidden", channel: "api" },
      })
    ).statusCode,
  ).toBe(403);
});

it("enforces attachment settings and ownership at the message endpoint", async () => {
  const { createKnowledgeConversation } =
    await import("@core/modules/knowledge/conversations.js");
  const conversation = await createKnowledgeConversation(
    db,
    alice,
    bot.id,
    "answer",
    "Attachment check",
  );
  const url = `/api/v1/knowledge/conversations/${conversation.id}/messages`;
  const payload = {
    content: "Explain attachment",
    requestId: randomUUID(),
    attachments: [randomUUID()],
  };
  const disabled = await app.inject({ method: "POST", url, payload });
  expect(disabled.statusCode).toBe(403);
  expect(disabled.json().message).toContain("附件");
  await db
    .updateTable("knowledge_assistants")
    .set({
      config: JSON.stringify({ attachmentsEnabled: true, channels: ["web"] }),
    })
    .where("id", "=", bot.id)
    .execute();
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(
    404,
  );
  await db
    .updateTable("knowledge_assistants")
    .set({
      config: JSON.stringify({ attachmentsEnabled: true, channels: ["mcp"] }),
    })
    .where("id", "=", bot.id)
    .execute();
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        payload: { ...payload, attachments: [] },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: root() + "/ask",
        payload: { query: "DNS" },
      })
    ).statusCode,
  ).toBe(403);
});

it("revokes a manager's keys when their robot management is removed", async () => {
  bot = await saveKnowledgeAssistant(db, alice, {
    id: bot.id,
    expectedRevision: bot.revision,
    title: bot.title,
    libraryIds: [library],
    memberIds: [bob.id],
    managerIds: [bob.id],
    enabled: true,
  });
  actor = bob;
  const issued = await key();
  expect((await ask(issued.token)).statusCode).toBe(200);
  actor = alice;
  await saveKnowledgeAssistant(db, alice, {
    id: bot.id,
    expectedRevision: bot.revision,
    title: bot.title,
    libraryIds: [library],
    memberIds: [bob.id],
    managerIds: [],
    enabled: true,
  });
  expect((await ask(issued.token)).statusCode).toBe(403);
});

it("exposes scoped MCP tools with a channel-specific credential", async () => {
  const issued = await key("mcp");
  const response = await app.inject({
    method: "POST",
    url: root() + "/mcp",
    headers: {
      authorization: `Bearer ${issued.token}`,
      accept: "application/json, text/event-stream",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("knowledge_search");
  expect(response.body).toContain("knowledge_ask");
  expect(response.body).toContain("knowledge_answer");
});

it("opens an authenticated share link even when discovery does not list it", async () => {
  await db
    .updateTable("knowledge_assistants")
    .set({ visibility: "authenticated" })
    .where("id", "=", bot.id)
    .execute();
  actor = bob;
  expect(
    (await listKnowledgeAssistants(db, bob)).some((item) => item.id === bot.id),
  ).toBe(false);
  const response = await app.inject({ url: root() });
  expect(response.statusCode).toBe(200);
  expect(response.json().canManage).toBe(false);
  expect(response.json().libraryIds).toBeUndefined();
});

it("persists feedback switching and withdrawal without retaining withdrawn optimization cases", async () => {
  const { createKnowledgeConversation } = await import("@core/modules/knowledge/conversations.js");
  const { libraryCases } = await import("../apps/server/src/services/ai/knowledge-studio.js");
  const conversation = await createKnowledgeConversation(db, alice, bot.id, "answer", "Feedback check");
  const messageId = randomUUID();
  await db.insertInto("knowledge_messages").values({id:messageId,conversation_id:conversation.id,role:"assistant",author_id:null,trigger:"system",content:"Example answer",detail:JSON.stringify({status:"completed",citations:[]}),created_at:new Date().toISOString()}).execute();
  const url = `/api/v1/knowledge/messages/${messageId}/feedback`;
  const read = async () => (await app.inject({method:"GET",url:`/api/v1/knowledge/conversations/${conversation.id}`})).json().messages.find((m:any)=>m.id===messageId).feedback;
  for (const judgment of ["useful", "unhelpful", null, "useful"] as const) {
    const result = await app.inject({method:"POST",url,payload:{judgment}});
    expect(result.statusCode).toBe(200);
    expect(await read()).toBe(judgment);
    const cases = await libraryCases(db,alice,library);
    expect(cases).toHaveLength(judgment === null ? 0 : 1);
    if (judgment) expect(cases[0]?.judgment).toBe(judgment);
  }
  expect(await db.selectFrom("knowledge_cases").selectAll().execute()).toHaveLength(1);
  actor = bob;
  expect((await app.inject({method:"POST",url,payload:{judgment:null}})).statusCode).toBe(404);
  actor = alice;
  expect(await read()).toBe("useful");
});
