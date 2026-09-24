import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { sql } from "kysely";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";

const origin = "http://localhost:39131";
const password = "test-only-password-2026";
let db: DB;
let app: Awaited<ReturnType<typeof createApp>>;
let directory = "";
let cookie = "";

async function request(method: "GET" | "POST", path: string, payload?: unknown, auth = cookie, contentType = "application/json") {
  return (app.inject as any)({
    method,
    url: "/api/v1" + path,
    headers: {
      host: "localhost:39131",
      origin,
      cookie: auth,
      ...(payload === undefined ? {} : { "content-type": contentType }),
    },
    ...(payload === undefined ? {} : { payload }),
  }) as Promise<any>;
}

async function login(loginName: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "localhost:39131", origin },
    payload: { login: loginName, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return String(response.headers["set-cookie"]).split(";")[0]!;
}

beforeEach(async () => {
  directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "doca-knowledge-test-"));
  db = await openTestDatabase({ driver: "sqlite", path: join(directory, "test.db") });
  const admin = await createUser(db, { login: "admin", displayName: "管理员", password }, { bootstrap: true });
  await createUser(db, { login: "alice", displayName: "Alice", password }, { actor: { ...admin, admin: 1 } as Actor });
  await createUser(db, { login: "bob", displayName: "Bob", password }, { actor: { ...admin, admin: 1 } as Actor });
  app = await createApp(db, {
    origin,
    storage: {
      root: join(directory, "uploads"),
      credentials: {},
      endpointHosts: [],
      cdnKeyPairId: undefined,
      cdnPrivateKey: undefined,
    },
  });
  cookie = await login("alice");
});

afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("chunks a document, hides it from other people, and reranks from feedback", async () => {
  const created = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "Nebula Roadmap",
    markdown: "# Nebula Roadmap\n\nNebula roadmap calibration notes for the mission archive.",
  });
  expect(created.statusCode, created.body).toBe(200);
  const other = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "Nebula Archive",
    markdown: "# Nebula Archive\n\nNebula roadmap calibration archive for the same mission.",
  });
  expect(other.statusCode, other.body).toBe(200);
  const first = await request("POST", "/knowledge/rebuild", { kind: "document", id: created.json().id });
  const second = await request("POST", "/knowledge/rebuild", { kind: "document", id: other.json().id });
  expect(first.json().chunks).toBeGreaterThan(0);
  expect(second.json().chunks).toBeGreaterThan(0);

  const found = await request("POST", "/knowledge/search", { query: "nebula roadmap calibration" });
  expect(found.statusCode, found.body).toBe(200);
  const items = found.json().items as Array<{ id: string; sourceId: string; score: number }>;
  expect(items.length).toBeGreaterThan(1);
  const marked = items[0]!;
  const feedback = await request("POST", "/knowledge/feedback", { chunkId: marked.id, judgment: "irrelevant", query: "nebula roadmap calibration" });
  expect(feedback.statusCode, feedback.body).toBe(200);
  const reranked = await request("POST", "/knowledge/search", { query: "nebula roadmap calibration" });
  expect(reranked.json().items[0].id).not.toBe(marked.id);

  const bob = await login("bob");
  const hidden = await request("POST", "/knowledge/search", { query: "nebula roadmap calibration" }, bob);
  expect(hidden.json().items).toEqual([]);
  const graph = await request("GET", "/knowledge/graph", undefined, bob);
  expect(graph.json().sources).toEqual([]);
});

it("lists similar candidates and records a gap when nothing matches", async () => {
  const created = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "Nebula Roadmap",
    markdown: "# Nebula Roadmap\n\nNebula roadmap calibration notes for the mission archive.",
  });
  const other = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "Nebula Archive",
    markdown: "# Nebula Archive\n\nNebula roadmap calibration archive for the same mission.",
  });
  await request("POST", "/knowledge/rebuild", { kind: "document", id: created.json().id });
  await request("POST", "/knowledge/rebuild", { kind: "document", id: other.json().id });
  const related = await request("POST", "/knowledge/related", { kind: "document", id: other.json().id });
  expect(related.statusCode, related.body).toBe(200);
  expect(related.json().links.some((link: { relation: string }) => link.relation === "similar")).toBe(true);

  const missing = await request("POST", "/knowledge/search", { query: "zzzz-missing-topic" });
  expect(missing.json().items).toEqual([]);
  const graph = await request("GET", "/knowledge/graph");
  expect(graph.json().gaps.some((gap: { query: string; status: string }) => gap.query === "zzzz-missing-topic" && gap.status === "open")).toBe(true);
});

it("suggests folder and library organization without moving files", async () => {
  const library = await request("POST", "/resources", { kind: "library", format: "rich_text", title: "Mission Library" });
  expect(library.statusCode, library.body).toBe(200);
  const alpha = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "Nebula Alpha",
    markdown: "# Nebula Alpha\n\nNebula notes.",
    libraryId: library.json().id,
  });
  const beta = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "Nebula Beta",
    markdown: "# Nebula Beta\n\nMore nebula notes.",
    libraryId: library.json().id,
  });
  expect(alpha.statusCode, alpha.body).toBe(200);
  expect(beta.statusCode, beta.body).toBe(200);
  const libraryLinks = await request("POST", "/knowledge/related", { kind: "library", id: library.json().id });
  expect(libraryLinks.json().links.some((link: { relation: string }) => link.relation === "organize")).toBe(true);

  const folder = await request("POST", "/files/folders", { name: "任务资料", parentId: null });
  expect(folder.statusCode, folder.body).toBe(200);
  const upload = await request(
    "POST",
    `/files/items?parentType=folder&parentId=${folder.json().id}&filename=Nebula.txt`,
    Buffer.from("nebula file"),
    cookie,
    "application/octet-stream",
  );
  expect(upload.statusCode, upload.body).toBe(200);
  const document = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "Nebula Guide",
    markdown: "# Nebula Guide\n\nA nebula guide.",
  });
  await request("POST", "/knowledge/rebuild", { kind: "document", id: document.json().id });
  const before = await db.selectFrom("file_items").select("parent_id").where("name", "=", "Nebula.txt").executeTakeFirst();
  const suggestion = await request("POST", "/knowledge/related", { kind: "folder", id: folder.json().id });
  expect(suggestion.json().links.some((link: { relation: string }) => link.relation === "organize")).toBe(true);
  const after = await db.selectFrom("file_items").select("parent_id").where("name", "=", "Nebula.txt").executeTakeFirst();
  expect(after?.parent_id).toBe(before?.parent_id);
});

it("keeps file extract text in a chunk without rewriting the extract record", async () => {
  const upload = await request(
    "POST",
    "/files/items?filename=calibration.txt",
    Buffer.from("plain"),
    cookie,
    "application/octet-stream",
  );
  expect(upload.statusCode, upload.body).toBe(200);
  const item = upload.json();
  const result = JSON.stringify({ parts: [{ type: "text", text: "轨道校准手册正文" }] });
  await db.insertInto("file_extracts").values({
    storage_object_id: item.storage_object_id,
    status: "ready",
    result,
    error: null,
    updated_at: new Date().toISOString(),
  }).onConflict((oc) => oc.column("storage_object_id").doUpdateSet({ status: "ready", result, error: null })).execute();
  const rebuilt = await request("POST", "/knowledge/rebuild", { kind: "file", id: item.id });
  expect(rebuilt.json().chunks).toBeGreaterThan(0);
  const chunk = await db.selectFrom("knowledge_chunks").select("text").where("source_id", "=", item.id).executeTakeFirstOrThrow();
  expect(chunk.text).toContain("轨道校准手册正文");
  const stored = await db.selectFrom("file_extracts").select("result").where("storage_object_id", "=", item.storage_object_id).executeTakeFirstOrThrow();
  expect(stored.result).toBe(result);
  const found = await request("POST", "/knowledge/search", { query: "轨道校准" });
  expect(found.json().items.some((hit: { sourceKind: string }) => hit.sourceKind === "file")).toBe(true);
});

it("keeps mailbox search on starred mail unless the mailbox opts in fully", async () => {
  const alice = await db.selectFrom("users").select("id").where("login", "=", "alice").executeTakeFirstOrThrow();
  const now = new Date().toISOString();
  const mailboxId = randomUUID();
  await sql`insert into mailboxes (id, owner_id, address, local_part, display_name, kind, locked, secret, source, provider, version, created_at, updated_at) values (${mailboxId}, ${alice.id}, ${"alice-knowledge@example.com"}, ${"alice-knowledge"}, ${"Alice"}, ${"personal"}, ${0}, ${"secret"}, ${"internal"}, ${""}, ${1}, ${now}, ${now})`.execute(db);
  const created = await db.selectFrom("mailboxes").select("knowledge_scope").where("id", "=", mailboxId).executeTakeFirstOrThrow();
  expect(created.knowledge_scope).toBe("starred");
  const message = (id: string, subject: string, starred: number) => ({
    id,
    mailbox_id: mailboxId,
    remote_id: id,
    folder: "inbox",
    folder_id: "inbox",
    subject,
    from_addr: "a@b.c",
    to_addrs: "[]",
    cc_addrs: "[]",
    bcc_addrs: "[]",
    snippet: subject,
    body_text: subject,
    body_html: "",
    body_ready: 1,
    unread: 0,
    starred,
    has_attachments: 0,
    sent_at: null,
    received_at: now,
    ai_tags: "",
    updated_at: now,
  });
  const starred = randomUUID();
  const plain = randomUUID();
  await db.insertInto("mail_messages").values([
    message(starred, "星标园区巡检纪要", 1),
    message(plain, "普通闲聊不进搜索", 0),
  ]).execute();
  const kept = await request("POST", "/knowledge/rebuild", { kind: "mail", id: starred });
  const dropped = await request("POST", "/knowledge/rebuild", { kind: "mail", id: plain });
  expect(kept.json().chunks).toBeGreaterThan(0);
  expect(dropped.json().chunks).toBe(0);
  const found = await request("POST", "/knowledge/search", { query: "园区巡检" });
  expect(found.json().items.some((hit: { sourceId: string }) => hit.sourceId === starred)).toBe(true);
  const hidden = await request("POST", "/knowledge/search", { query: "普通闲聊" });
  expect(hidden.json().items).toEqual([]);

  await db.updateTable("mailboxes").set({ knowledge_scope: "all" }).where("id", "=", mailboxId).execute();
  const all = await request("POST", "/knowledge/rebuild", { kind: "mail", id: plain });
  expect(all.json().chunks).toBeGreaterThan(0);

  await db.updateTable("mailboxes").set({ knowledge_scope: "off" }).where("id", "=", mailboxId).execute();
  const off = await request("POST", "/knowledge/rebuild", { kind: "mail", id: starred });
  expect(off.json().chunks).toBe(0);
  const gone = await request("POST", "/knowledge/search", { query: "园区巡检" });
  expect(gone.json().items).toEqual([]);
});
