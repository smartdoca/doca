import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";
import Fastify from "fastify";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { registerSearch } from "../apps/server/src/routes/search.js";
import { openTestDatabase } from "./database.js";

let db: DB;
let app: ReturnType<typeof Fastify>;
const posts: unknown[] = [];

beforeEach(async () => {
  posts.length = 0;
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const actor = {
    ...(await createUser(db, { login: "admin", displayName: "Admin", password: "mail-search-scope-password" }, { bootstrap: true })),
    admin: 1,
  } as Actor;
  await db.updateTable("search_settings").set({
    enabled: 1,
    generation: 1,
    endpoint: "http://127.0.0.1:7700",
    index_name: "doca",
  }).where("id", "=", "system").execute();
  app = Fastify();
  await registerSearch(app, db, () => actor, {
    allowedOrigins: ["http://127.0.0.1:7700"],
    apiKey: "test-key",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "POST" && path.endsWith("/documents")) posts.push(body);
      if (path.startsWith("/tasks/")) return Response.json({ status: "succeeded" });
      if (path.endsWith("/documents") && method === "GET") return Response.json({ results: [], total: 0 });
      return Response.json({ status: "available", taskUid: 7 });
    },
  });
});

afterEach(async () => {
  await app.close();
  await db.destroy();
});

it("does not add an unstarred mail attachment to Meilisearch", async () => {
  const alice = await db.selectFrom("users").select("id").where("login", "=", "admin").executeTakeFirstOrThrow();
  const now = new Date().toISOString();
  const mailboxId = randomUUID();
  const messageId = randomUUID();
  const objectId = randomUUID();
  const fileId = randomUUID();
  const profile = await db.selectFrom("storage_profiles").select("id").executeTakeFirstOrThrow();
  await sql`insert into mailboxes (id, owner_id, address, local_part, display_name, kind, locked, secret, source, provider, version, created_at, updated_at) values (${mailboxId}, ${alice.id}, ${"scope@example.com"}, ${"scope"}, ${"Scope"}, ${"personal"}, ${0}, ${"secret"}, ${"internal"}, ${""}, ${1}, ${now}, ${now})`.execute(db);
  await db.insertInto("mail_messages").values({
    id: messageId,
    mailbox_id: mailboxId,
    remote_id: "remote-plain",
    folder: "inbox",
    folder_id: "inbox",
    subject: "普通邮件",
    from_addr: "a@b.c",
    to_addrs: "[]",
    cc_addrs: "[]",
    bcc_addrs: "[]",
    snippet: "普通邮件",
    body_text: "普通邮件正文",
    body_html: "",
    body_ready: 1,
    unread: 0,
    starred: 0,
    has_attachments: 1,
    sent_at: null,
    received_at: now,
    ai_tags: "",
    updated_at: now,
  }).execute();
  await db.insertInto("file_storage_objects").values({
    id: objectId,
    profile_id: profile.id,
    object_key: `objects/${objectId}`,
    sha256: "b".repeat(64),
    size: 12,
    mime: "text/plain",
    category: "text",
    ai_description: "普通附件正文",
    ai_status: "ready",
    ai_model: null,
    ai_generated_at: now,
    created_at: now,
  }).execute();
  await db.insertInto("file_items").values({
    id: fileId,
    owner_id: alice.id,
    parent_type: "system",
    parent_id: `mail:${mailboxId}`,
    storage_object_id: objectId,
    name: "普通附件.txt",
    mime: "text/plain",
    size: 12,
    metadata: JSON.stringify({ mailboxId, messageId: "remote-plain", attachmentId: "a1" }),
    ai_description_override: null,
    locked: 1,
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    delete_batch: null,
  }).execute();
  await enqueueProjection(db, "search-file", fileId, { fileId });
  await enqueueProjection(db, "search-mail", messageId, { messageId });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const pending = await db.selectFrom("projection_jobs").select("id").where("id", "in", [`search-file:${fileId}`, `search-mail:${messageId}`]).execute();
    if (!pending.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const pending = await db.selectFrom("projection_jobs").select(["id", "last_error"]).execute();
  expect(pending).toEqual([]);
  const posted = JSON.stringify(posts);
  expect(posted).not.toContain("普通附件");
  expect(posted).not.toContain("普通邮件");
  expect(posted).not.toContain(`file_item_${fileId.replaceAll("-", "_")}`);
  expect(posted).not.toContain(`mail_message_${messageId.replaceAll("-", "_")}`);
});
