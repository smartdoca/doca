import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  createKnowledgeConversation,
  sendKnowledgeMessage,
  conversationAccess,
  listKnowledgeConversations,
} from "@core/modules/knowledge/conversations.js";
import {
  saveHumanKnowledge,
  reviewKnowledgeEntry,
  saveKnowledgeAssistant,
  knowledgeInstructions,
  saveKnowledgeSettings,
} from "@core/modules/knowledge/system.js";
import {
  answerChunks,
  publishKnowledgeDocuments,
  publishedChunks,
  publicationStatus,
} from "@core/modules/knowledge/publications.js";
import {
  createDocuments,
  restoreDocument,
  b64,
} from "@core/modules/collaboration/documents.js";
import * as Y from "yjs";
let db: DB, alice: Actor, bob: Actor, library: string;
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
  library = (
    await createContent(db).create(alice, {
      kind: "library",
      format: "markdown",
      title: "Network",
    })
  ).id;
});
afterEach(() => db.destroy());
const manager = () =>
  db
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
async function document(markdown = "# DNS\n\nOriginal TTL 300") {
  const draft = await saveHumanKnowledge(db, alice, library, {
    title: "DNS",
    markdown,
    path: ["Application"],
    expectedRevision: 0,
  });
  return reviewKnowledgeEntry(
    db,
    alice,
    library,
    draft.id,
    draft.revision,
    "publish",
  );
}
async function edit(nodeId: string) {
  const baseline = await createDocuments(db).exchange(alice, nodeId, {
    protocolVersion: 1,
    codec: "slate-kit",
    schemaVersion: 3,
  });
  const loaded = await restoreDocument(db, nodeId);
  const vector = Y.encodeStateVector(loaded.doc);
  const last = loaded.runtime.getValue().at(-1)! as any;
  loaded.runtime.editText(last.id, 0, 0, "Human amendment. ");
  const update = b64(Y.encodeStateAsUpdate(loaded.doc, vector));
  loaded.destroy();
  return createDocuments(db).exchange(alice, nodeId, {
    protocolVersion: 1,
    codec: "slate-kit",
    schemaVersion: 3,
    epochId: baseline.epochId,
    update,
    messageId: randomUUID(),
  });
}
it("shares curation threads across managers and retains individual authors and schedule triggers", async () => {
  await manager();
  const thread = await createKnowledgeConversation(
    db,
    alice,
    library,
    "curation",
    "Build guide",
  );
  await sendKnowledgeMessage(db, alice, thread.id, "DNS", randomUUID());
  await sendKnowledgeMessage(db, bob, thread.id, "TCP", randomUUID());
  await sendKnowledgeMessage(
    db,
    alice,
    thread.id,
    "Update sources",
    randomUUID(),
    "schedule",
  );
  expect(
    (await listKnowledgeConversations(db, bob, library, "curation"))[0]?.id,
  ).toBe(thread.id);
  const rows = await db
    .selectFrom("knowledge_messages")
    .selectAll()
    .where("conversation_id", "=", thread.id)
    .execute();
  expect(rows.map((x) => x.role)).toEqual(["user", "user", "user"]);
  expect(new Set(rows.map((x) => x.author_id)).size).toBe(2);
  expect(rows.some((x) => x.trigger === "schedule")).toBe(true);
  expect(await db.selectFrom("ai_sessions").selectAll().execute()).toEqual([]);
});
it("rejects readers from shared management conversations", async () => {
  const thread = await createKnowledgeConversation(
    db,
    alice,
    library,
    "curation",
    "Private",
  );
  await expect(conversationAccess(db, bob, thread.id)).rejects.toBeDefined();
});
it("makes message submission idempotent and rejects reused ids with different content", async () => {
  const thread = await createKnowledgeConversation(
      db,
      alice,
      library,
      "curation",
      "Test",
    ),
    id = randomUUID();
  await sendKnowledgeMessage(db, alice, thread.id, "one", id);
  await sendKnowledgeMessage(db, alice, thread.id, "one", id);
  expect(
    await db.selectFrom("knowledge_tasks").selectAll().execute(),
  ).toHaveLength(1);
  await expect(
    sendKnowledgeMessage(db, alice, thread.id, "two", id),
  ).rejects.toMatchObject({ status: 409 });
});
it("keeps answer histories separate even when users share the same bot", async () => {
  const bot = await saveKnowledgeAssistant(db, alice, {
    title: "Network",
    libraryIds: [library],
    memberIds: [bob.id],
    enabled: true,
    expectedRevision: 0,
  });
  const thread = await createKnowledgeConversation(
    db,
    alice,
    bot.id,
    "answer",
    "Question",
  );
  await expect(conversationAccess(db, bob, thread.id)).rejects.toMatchObject({
    status: 404,
  });
});
it("keeps a published snapshot stable until the next successful publication", async () => {
  const entry = await document();
  await publishKnowledgeDocuments(db, alice, library);
  const old = await publishedChunks(db, [library]);
  await edit(entry.reviewState.nodeId as string);
  expect(await publishedChunks(db, [library])).toEqual(old);
  expect((await publicationStatus(db, library)).dirty).toBe(true);
  const prepare = vi.fn().mockRejectedValue(new Error("embedding unavailable"));
  await expect(
    publishKnowledgeDocuments(db, alice, library, {
      prepare,
      search: async () => [],
    }),
  ).rejects.toThrow("embedding unavailable");
  expect(await publishedChunks(db, [library])).toEqual(old);
  await publishKnowledgeDocuments(db, alice, library);
  expect(
    (await publishedChunks(db, [library])).map((x) => x.text).join(" "),
  ).toContain("Human amendment");
  expect((await publicationStatus(db, library)).revision).toBe(2);
});
it("rejects AI proposals that would overwrite intervening human edits", async () => {
  const entry = await document();
  const draft = await saveHumanKnowledge(db, alice, library, {
    id: entry.id,
    expectedRevision: entry.revision,
    title: entry.title,
    markdown: "Updated TTL 600",
  });
  await edit(entry.reviewState.nodeId as string);
  await expect(
    reviewKnowledgeEntry(
      db,
      alice,
      library,
      draft.id,
      draft.revision,
      "publish",
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("preserves editor lineage, tables and code when publishing a revision", async () => {
  const entry = await document(
    "# DNS\n\n|Name|Value|\n|---|---|\n|TTL|300|\n\n```sh\ndig example.com\n```",
  );
  const nodeId = entry.reviewState.nodeId as string;
  const initial = await createDocuments(db).exchange(alice, nodeId, {
    protocolVersion: 1,
    codec: "slate-kit",
    schemaVersion: 3,
  });
  const draft = await saveHumanKnowledge(db, alice, library, {
    id: entry.id,
    expectedRevision: entry.revision,
    title: entry.title,
    markdown:
      "# DNS\n\n|Name|Value|\n|---|---|\n|TTL|600|\n\n```sh\ndig example.com\n```",
  });
  await reviewKnowledgeEntry(
    db,
    alice,
    library,
    draft.id,
    draft.revision,
    "publish",
  );
  const after = await createDocuments(db).exchange(alice, nodeId, {
    protocolVersion: 1,
    codec: "slate-kit",
    schemaVersion: 3,
  });
  expect(after.epochId).toBe(initial.epochId);
  expect(after.seq).toBeGreaterThan(initial.seq);
  await publishKnowledgeDocuments(db, alice, library);
  const text = (await publishedChunks(db, [library]))
    .map((x) => x.text)
    .join("\n");
  expect(text).toContain("600");
  expect(text).toContain("```sh");
});
it("does not truncate the tail of long technical paragraphs", () => {
  const text = "x".repeat(14000) + "TAIL-MARKER";
  const chunks = answerChunks([
    { id: randomUUID(), title: "TCP", markdown: text, seq: 1, version: 1 },
  ]);
  expect(chunks.at(-1)?.text).toContain("TAIL-MARKER");
});
it("applies tightened masking and deletion to an old publication immediately", async () => {
  const entry = await document("Sensitive code PRIVATE-123");
  await publishKnowledgeDocuments(db, alice, library);
  const bundle = await knowledgeInstructions(db, alice, library);
  await saveKnowledgeSettings(db, alice, library, bundle.settingsRevision, {
    ...bundle.settings,
    redactedTerms: ["PRIVATE-123"],
  });
  expect(JSON.stringify(await publishedChunks(db, [library]))).not.toContain(
    "PRIVATE-123",
  );
  await db
    .updateTable("resources")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", entry.reviewState.nodeId as string)
    .execute();
  expect(await publishedChunks(db, [library])).toEqual([]);
});
it("writes useful parent guides without renaming the category and rejects stale child snapshots", async () => {
  const { knowledgeOverviewContext, saveKnowledgeOverview } =
    await import("@core/modules/knowledge/overview.js");
  const entry = await document(),
    directory = await db
      .selectFrom("knowledge_directories")
      .selectAll()
      .where("library_id", "=", library)
      .executeTakeFirstOrThrow();
  const context = await knowledgeOverviewContext(
    db,
    alice,
    library,
    directory.resource_id,
  );
  await saveKnowledgeOverview(db, alice, library, {
    ...context,
    markdown:
      "# A different generated heading\n\n" +
      "Understand how DNS relates to applications, then follow the child chapter for TTL examples and operational boundaries. ".repeat(
        2,
      ) +
      `\n\n[DNS](#/r/${entry.reviewState.nodeId})`,
  });
  expect(
    (
      await db
        .selectFrom("resources")
        .select("title")
        .where("id", "=", directory.resource_id)
        .executeTakeFirst()
    )?.title,
  ).toBe(context.title);
  const stale = await knowledgeOverviewContext(
    db,
    alice,
    library,
    directory.resource_id,
  );
  await edit(entry.reviewState.nodeId as string);
  await expect(
    saveKnowledgeOverview(db, alice, library, {
      ...stale,
      markdown: "Overview ".repeat(30),
    }),
  ).rejects.toMatchObject({ status: 409 });
});
