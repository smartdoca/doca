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
  const similar = related.json().links.find((link: { relation: string; reason: string }) => link.relation === "similar");
  expect(similar?.reason).toContain("共用");

  const missing = await request("POST", "/knowledge/search", { query: "zzzz-missing-topic" });
  expect(missing.json().items).toEqual([]);
  const graph = await request("GET", "/knowledge/graph");
  expect(graph.json().gaps.some((gap: { query: string; status: string }) => gap.query === "zzzz-missing-topic" && gap.status === "open")).toBe(true);
});

it("marks an open gap covered once a local document matches the query", async () => {
  const missing = await request("POST", "/knowledge/search", { query: "星港巡检纪要" });
  expect(missing.json().items).toEqual([]);
  const created = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "星港巡检纪要",
    markdown: "# 星港巡检纪要\n\n星港巡检纪要已经写入本地文档。",
  });
  expect(created.statusCode, created.body).toBe(200);
  await request("POST", "/knowledge/rebuild", { kind: "document", id: created.json().id });
  const graph = await request("GET", "/knowledge/graph");
  expect(graph.json().gaps.some((gap: { query: string; status: string }) => gap.query === "星港巡检纪要" && gap.status === "covered")).toBe(true);
  const found = await request("POST", "/knowledge/search", { query: "星港巡检纪要" });
  expect(found.json().items[0].terms.join("、")).toContain("星港");
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

it("keeps instructions and source confirmation off the knowledge document tree", async () => {
  const library = await request("POST", "/resources", { kind: "library", format: "rich_text", title: "凭证库" });
  expect(library.statusCode, library.body).toBe(200);
  const id = library.json().id;
  const guide = await request("POST", `/knowledge/libraries/${id}/guide`, { markdown: "拆分：按来源\n" });
  expect(guide.statusCode, guide.body).toBe(200);
  expect(guide.json().splitMode).toBe("source");
  const source = await request("POST", "/resources", { kind: "document", format: "markdown", title: "凭证说明", markdown: "# 凭证说明\n\n一张入库单。" });
  expect(source.statusCode, source.body).toBe(200);
  const subscribed = await request("POST", `/knowledge/libraries/${id}/subscriptions`, { sourceKind: "document", sourceId: source.json().id });
  expect(subscribed.statusCode, subscribed.body).toBe(200);
  expect(subscribed.json().status).toBe("pending");
  expect(subscribed.json().nodeId).toBeNull();
  const before = await request("GET", `/resources?scope=all&kind=document&libraryId=${id}`);
  expect(before.json().items).toEqual([]);
  const enabled = await request("POST", `/knowledge/libraries/${id}/curation`, { enabled: true });
  expect(enabled.json().aiCurated).toBe(true);
  const confirmed = await request("POST", `/knowledge/libraries/${id}/subscriptions/${subscribed.json().id}/confirm`, {});
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  expect(confirmed.json().status).toBe("active");
  const after = await request("GET", `/resources?scope=all&kind=document&libraryId=${id}`);
  expect(after.json().items).toEqual([]);
  expect(confirmed.json().nodeId).toBeNull();
  const bob = await login("bob");
  const denied = await request("POST", `/knowledge/libraries/${id}/guide`, { markdown: "拆分：按客户" }, bob);
  expect(denied.statusCode).toBe(404);
});

it("keeps legacy scans readable and searches independently authored knowledge", async () => {
  const library = await request("POST", "/resources", { kind: "library", format: "rich_text", title: "问答库" });
  expect(library.statusCode, library.body).toBe(200);
  const id = library.json().id;
  const early = await request("POST", `/knowledge/libraries/${id}/schedule`, { mode: "daily" });
  expect(early.statusCode, early.body).toBe(400);
  await request("POST", `/knowledge/libraries/${id}/curation`, { enabled: true });
  const schedule = await request("POST", `/knowledge/libraries/${id}/schedule`, { mode: "weekly" });
  expect(schedule.statusCode, schedule.body).toBe(200);
  expect(schedule.json().schedule).toBe("weekly");
  const run = await request("POST", `/knowledge/libraries/${id}/runs`, {});
  expect(run.statusCode, run.body).toBe(200);
  expect(run.json().trigger).toBe("manual");
  expect(run.json().pending).toBe(0);
  const listed = await request("GET", `/knowledge/libraries/${id}/subscriptions`);
  expect(listed.json().schedule).toBe("weekly");
  expect(listed.json().runs).toHaveLength(1);
  const source = await request("POST", "/resources", { kind: "document", format: "markdown", title: "入库单说明", markdown: "# 入库单说明\n\n一张入库单。" });
  const subscribed = await request("POST", `/knowledge/libraries/${id}/subscriptions`, { sourceKind: "document", sourceId: source.json().id });
  const confirmed = await request("POST", `/knowledge/libraries/${id}/subscriptions/${subscribed.json().id}/confirm`, {});
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  await request("POST", "/resources", { kind: "document", format: "markdown", libraryId: id, title: "入库单说明", markdown: "# 入库单说明\n\n独立编写的入库单知识。" });
  const saved = await request("POST", `/knowledge/libraries/${id}/bot`, { title: "凭证问答", published: true });
  expect(saved.json()).toEqual({ title: "凭证问答", published: true });
  const asked = await request("POST", `/knowledge/libraries/${id}/ask`, { query: "入库单" });
  expect(asked.statusCode, asked.body).toBe(200);
  expect(asked.json().items.some((item: { title: string }) => item.title === "入库单说明")).toBe(true);
  const bob = await login("bob");
  const hidden = await request("POST", `/knowledge/libraries/${id}/runs`, {}, bob);
  expect(hidden.statusCode).toBe(404);
});

it("keeps library and source presets until they are saved", async () => {
  const library = await request("POST", "/resources", { kind: "library", format: "rich_text", title: "预设库" });
  expect(library.statusCode, library.body).toBe(200);
  const id = library.json().id;
  const early = await request("POST", `/knowledge/libraries/${id}/preset`, { weight: 8, frequency: "weekly", copyText: false, note: "手写" });
  expect(early.statusCode, early.body).toBe(400);
  await request("POST", `/knowledge/libraries/${id}/curation`, { enabled: true });
  await request("POST", `/knowledge/libraries/${id}/guide`, { markdown: "拆分：按知识内容\n" });
  const drafted = await request("POST", `/knowledge/libraries/${id}/preset/draft`, {});
  expect(drafted.statusCode, drafted.body).toBe(200);
  expect(drafted.json().preset.copyText).toBe(false);
  expect(drafted.json().preset.note).toContain("整库预设");
  const saved = await request("POST", `/knowledge/libraries/${id}/preset`, { weight: 8, frequency: "weekly", copyText: false, note: "手写说明" });
  expect(saved.statusCode, saved.body).toBe(200);
  const again = await request("POST", `/knowledge/libraries/${id}/preset/draft`, {});
  expect(again.json().preset.weight).toBe(5);
  const listed = await request("GET", `/knowledge/libraries/${id}/subscriptions`);
  expect(listed.json().preset).toMatchObject({ weight: 8, frequency: "weekly", copyText: false, note: "手写说明" });
  expect(listed.json().schedule).toBe("weekly");
  const source = await request("POST", "/resources", { kind: "document", format: "markdown", title: "入库单说明", markdown: "# 入库单说明\n\n一张入库单。" });
  const subscribed = await request("POST", `/knowledge/libraries/${id}/subscriptions`, { sourceKind: "document", sourceId: source.json().id });
  const subscriptionId = subscribed.json().id;
  const sourceDraft = await request("POST", `/knowledge/libraries/${id}/subscriptions/${subscriptionId}/preset/draft`, {});
  expect(sourceDraft.statusCode, sourceDraft.body).toBe(200);
  expect(sourceDraft.json().preset.note).toContain("入库单说明");
  const sourceSaved = await request("POST", `/knowledge/libraries/${id}/subscriptions/${subscriptionId}/preset`, {
    weight: 9,
    frequency: "daily",
    copyText: "no",
    note: "来源说明",
  });
  expect(sourceSaved.statusCode, sourceSaved.body).toBe(200);
  await request("POST", `/knowledge/libraries/${id}/subscriptions/${subscriptionId}/preset/draft`, {});
  const afterDraft = await request("GET", `/knowledge/libraries/${id}/subscriptions`);
  expect(afterDraft.json().items[0].preset).toMatchObject({ weight: 9, frequency: "daily", copyText: "no", note: "来源说明" });
  const confirmed = await request("POST", `/knowledge/libraries/${id}/subscriptions/${subscriptionId}/confirm`, {});
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  expect(confirmed.json().nodeId).toBeNull();
  const documents = await request("GET", `/resources?scope=all&kind=document&libraryId=${id}`);
  expect(documents.json().items).toEqual([]);
  const bob = await login("bob");
  const hidden = await request("POST", `/knowledge/libraries/${id}/preset`, { weight: 1, frequency: "off", copyText: true, note: "" }, bob);
  expect(hidden.statusCode).toBe(404);
});

it("serves published knowledge to bot members without granting library content or management access", async () => {
  const library = await request("POST", "/resources", { kind: "library", format: "rich_text", title: "Independent knowledge" });
  expect(library.statusCode, library.body).toBe(200);
  const root = `/knowledge/libraries/${library.json().id}`;
  const draft = await request("POST", `${root}/entries`, { title: "Protocol", markdown: "Protocol is independently maintained.", expectedRevision: 0 });
  expect(draft.statusCode, draft.body).toBe(200);
  const published = await request("POST", `${root}/entries/${draft.json().id}/review`, { expectedRevision: 1, action: "publish" });
  expect(published.statusCode, published.body).toBe(200);
  const bob = await db.selectFrom("users").select("id").where("login", "=", "bob").executeTakeFirstOrThrow();
  const bot = await request("POST", "/knowledge/assistants", { title: "Protocol bot", expectedRevision: 0, libraryIds: [library.json().id], memberIds: [bob.id], enabled: true });
  expect(bot.statusCode, bot.body).toBe(200);
  const bobCookie = await login("bob");
  // Reviewing an entry creates the document; bot retrieval uses an explicitly
  // published snapshot, so scheduler timing must not determine this test.
  const publication = await request("POST", `${root}/publication`, {});
  expect(publication.statusCode, publication.body).toBe(200);
  const search = await request("POST", `/knowledge/assistants/${bot.json().id}/search`, {query: "Protocol"}, bobCookie);
  expect(search.statusCode, search.body).toBe(200);
  expect(search.json().items).toHaveLength(1);
  expect(search.json().items[0].documentUrl).toBeUndefined();
  expect((await request("GET", `${root}/entries/${draft.json().id}`, undefined, bobCookie)).statusCode).toBe(404);
  expect((await request("GET", `${root}/system`, undefined, bobCookie)).statusCode).toBe(404);
  expect((await request("POST", `${root}/curate`, undefined, bobCookie)).statusCode).toBe(404);
  expect((await request("GET", `${root}/entries/${draft.json().id}`)).json().markdown).toContain("independently");
});
