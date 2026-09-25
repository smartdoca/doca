import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { authorize } from "../access/queries.js";
import { fail } from "../../shared/errors.js";
import { mailKnowledgeIncluded } from "../mail/scope.js";

export type SubscriptionKind = "document" | "file" | "folder" | "mail" | "mailbox" | "url";
export type KnowledgeDocumentCreator = (
  actor: Actor,
  input: {
    title: string;
    kind: "document";
    format: "markdown";
    libraryId: string;
    parentId?: string | null;
    markdown: string;
  },
) => Promise<{ id: string }>;

const kinds = new Set<SubscriptionKind>(["document", "file", "folder", "mail", "mailbox", "url"]);

export function subscriptionKind(value: string): SubscriptionKind {
  if (kinds.has(value as SubscriptionKind)) return value as SubscriptionKind;
  fail(400, "来源类型不正确");
}

export async function listKnowledgeSubscriptions(db: DB, actor: Actor, libraryId: string) {
  await authorize(db, actor, libraryId, 1);
  const library = await db.selectFrom("resources").select(["id", "kind", "ai_curated", "guide_text"]).where("id", "=", libraryId).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const rows = await db.selectFrom("knowledge_subscriptions").selectAll().where("library_id", "=", libraryId).orderBy("created_at", "desc").execute();
  const items = [];
  for (const row of rows) {
    const status = row.status === "pending" ? await pendingStatus(db, row) : await subscriptionStatus(db, row);
    if (status !== row.status) {
      await db.updateTable("knowledge_subscriptions").set({ status }).where("id", "=", row.id).execute();
    }
    const node = row.node_id
      ? await db.selectFrom("resources").select("title").where("id", "=", row.node_id).where("deleted_at", "is", null).executeTakeFirst()
      : undefined;
    items.push({
      id: row.id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      url: row.url,
      nodeId: row.node_id,
      nodeTitle: node?.title ?? "",
      status,
      sourceTitle: await sourceTitle(db, row),
      sourceVersion: row.source_version,
      createdAt: row.created_at,
    });
  }
  const guideText = await libraryGuideText(db, libraryId);
  return {
    aiCurated: Number(library.ai_curated ?? 0) === 1,
    guideText,
    splitMode: guideSplitMode(guideText),
    items,
  };
}

export async function subscribeKnowledgeSource(
  db: DB,
  actor: Actor,
  libraryId: string,
  input: { sourceKind: SubscriptionKind; sourceId?: string; url?: string },
) {
  await authorize(db, actor, libraryId, 4);
  const library = await db.selectFrom("resources").select(["id", "kind"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const source = await readSource(db, actor, libraryId, input);
  const existing = await db.selectFrom("knowledge_subscriptions").selectAll()
    .where("library_id", "=", libraryId)
    .where("source_kind", "=", input.sourceKind)
    .where("source_id", "=", source.sourceId)
    .where("url", "=", source.url)
    .executeTakeFirst();
  if (existing) return { ...(await publicSubscription(db, existing)), included: 0 };
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insertInto("knowledge_subscriptions").values({
    id,
    library_id: libraryId,
    source_kind: input.sourceKind,
    source_id: source.sourceId,
    url: source.url,
    node_id: null,
    source_version: source.version,
    status: "pending",
    created_at: now,
  }).execute();
  return { ...(await publicSubscription(db, {
    id,
    source_kind: input.sourceKind,
    source_id: source.sourceId,
    url: source.url,
    node_id: null,
    source_version: source.version,
    status: "pending",
    created_at: now,
  })), included: 0 };
}

export async function confirmKnowledgeSubscription(db: DB, actor: Actor, libraryId: string, subscriptionId: string, createDocument: KnowledgeDocumentCreator) {
  await authorize(db, actor, libraryId, 4);
  const library = await db.selectFrom("resources").select(["id", "kind", "ai_curated"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (Number(library.ai_curated ?? 0) !== 1) fail(400, "先启用知识体系");
  const pending = await db.selectFrom("knowledge_subscriptions").selectAll().where("id", "=", subscriptionId).where("library_id", "=", libraryId).executeTakeFirst();
  if (!pending) fail(404, "连线不存在");
  if (pending.status !== "pending") return { ...(await publicSubscription(db, pending)), included: 0 };
  const source = await readSource(db, actor, libraryId, { sourceKind: pending.source_kind as SubscriptionKind, sourceId: pending.source_id, url: pending.url });
  const node = await createDocument(actor, {
    title: source.title,
    kind: "document",
    format: "markdown",
    libraryId,
    markdown: source.markdown,
  });
  await db.updateTable("knowledge_subscriptions").set({ node_id: node.id, status: "active", source_version: source.version }).where("id", "=", pending.id).execute();
  const mode = await librarySplitMode(db, libraryId);
  const kind = pending.source_kind as SubscriptionKind;
  let included = 0;
  if (kind === "folder" && mode === "source") {
    const files = await filesUnderFolder(db, source.sourceId);
    for (const file of files) {
      const snapshot = await readSource(db, actor, libraryId, { sourceKind: "file", sourceId: file });
      await ensureSubscription(db, actor, libraryId, "file", snapshot, node.id, createDocument);
      included += 1;
    }
  }
  if (kind === "mailbox" && mode === "source") {
    const messages = await messagesInMailbox(db, source.sourceId);
    for (const messageId of messages) {
      const snapshot = await readSource(db, actor, libraryId, { sourceKind: "mail", sourceId: messageId });
      await ensureSubscription(db, actor, libraryId, "mail", snapshot, node.id, createDocument);
      included += 1;
    }
  }
  if ((kind === "folder" || kind === "mailbox") && mode !== "source") {
    const children = kind === "folder" ? await filesUnderFolder(db, source.sourceId) : await messagesInMailbox(db, source.sourceId);
    for (const child of children) {
      const childKind = kind === "folder" ? "file" as const : "mail" as const;
      const snapshot = await readSource(db, actor, libraryId, { sourceKind: childKind, sourceId: child });
      await ensureLinkedSubscription(db, libraryId, childKind, snapshot, node.id);
      included += 1;
    }
  }
  const saved = await db.selectFrom("knowledge_subscriptions").selectAll().where("id", "=", pending.id).executeTakeFirstOrThrow();
  return { ...(await publicSubscription(db, saved)), included };
}

export async function dismissKnowledgeSubscription(db: DB, actor: Actor, libraryId: string, subscriptionId: string) {
  await authorize(db, actor, libraryId, 4);
  const row = await db.selectFrom("knowledge_subscriptions").select(["id", "status"]).where("id", "=", subscriptionId).where("library_id", "=", libraryId).executeTakeFirst();
  if (!row) fail(404, "连线不存在");
  if (row.status !== "pending") fail(400, "只有等待确认的连线可以不加入");
  await db.deleteFrom("knowledge_subscriptions").where("id", "=", row.id).execute();
  return { ok: true };
}

async function ensureSubscription(
  db: DB,
  actor: Actor,
  libraryId: string,
  sourceKind: SubscriptionKind,
  source: { sourceId: string; url: string; version: string; title: string; markdown: string },
  parentId: string | null,
  createDocument: KnowledgeDocumentCreator,
) {
  const existing = await db.selectFrom("knowledge_subscriptions").selectAll()
    .where("library_id", "=", libraryId)
    .where("source_kind", "=", sourceKind)
    .where("source_id", "=", source.sourceId)
    .where("url", "=", source.url)
    .executeTakeFirst();
  if (existing) return { id: existing.id, nodeId: existing.node_id, createdAt: existing.created_at };
  const node = await createDocument(actor, {
    title: source.title,
    kind: "document",
    format: "markdown",
    libraryId,
    parentId,
    markdown: source.markdown,
  });
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insertInto("knowledge_subscriptions").values({
    id,
    library_id: libraryId,
    source_kind: sourceKind,
    source_id: source.sourceId,
    url: source.url,
    node_id: node.id,
    source_version: source.version,
    status: "active",
    created_at: now,
  }).execute();
  return { id, nodeId: node.id, createdAt: now };
}

async function ensureLinkedSubscription(db: DB, libraryId: string, sourceKind: SubscriptionKind, source: { sourceId: string; url: string; version: string }, nodeId: string) {
  const existing = await db.selectFrom("knowledge_subscriptions").select("id")
    .where("library_id", "=", libraryId)
    .where("source_kind", "=", sourceKind)
    .where("source_id", "=", source.sourceId)
    .where("url", "=", source.url)
    .executeTakeFirst();
  if (existing) return;
  await db.insertInto("knowledge_subscriptions").values({
    id: randomUUID(),
    library_id: libraryId,
    source_kind: sourceKind,
    source_id: source.sourceId,
    url: source.url,
    node_id: nodeId,
    source_version: source.version,
    status: "active",
    created_at: new Date().toISOString(),
  }).execute();
}

const guideTemplate = `# 结构说明

拆分：按来源

这份说明决定知识库的文档树怎么长。助手整理时按这里的层级和拆分方式放节点，不另起一套目录。

可选的拆分写在「拆分：」后面：

- 按来源：一个文件、一封邮件或一条链接各成一个节点。文件夹或邮箱作为上一层。
- 按知识内容：按下面的标题归类。多份来源可以写入同一个节点。
- 按目录：下面的标题就是目录。来源只填进点名的那一节。

## 交易凭证

来源：文件夹
拆分：按来源

这一节收凭证文件夹。按来源时，每个文件是这一节下的一个节点。

## 客户沟通

来源：邮箱
范围：全部邮件
拆分：按知识内容

这一节收某个邮箱里的往来。按知识内容时，按客户或事项写入节点，不给每一封邮件单独开篇。指定的单封邮件仍可以单独成篇。
`;

export async function setLibraryCuration(db: DB, actor: Actor, libraryId: string, enabled: boolean) {
  await authorize(db, actor, libraryId, 4);
  const library = await db.selectFrom("resources").select(["id", "kind", "guide_text"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (enabled && !library.guide_text) {
    await db.updateTable("resources").set({ guide_text: guideTemplate, ai_curated: 1 }).where("id", "=", libraryId).execute();
  } else await db.updateTable("resources").set({ ai_curated: enabled ? 1 : 0 }).where("id", "=", libraryId).execute();
  const guideText = await libraryGuideText(db, libraryId);
  return { aiCurated: enabled, splitMode: guideSplitMode(guideText) };
}

export async function saveLibraryGuide(db: DB, actor: Actor, libraryId: string, markdown: string) {
  await authorize(db, actor, libraryId, 4);
  const library = await db.selectFrom("resources").select(["id", "kind"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const text = markdown.trim() ? markdown : guideTemplate;
  await db.updateTable("resources").set({ guide_text: text }).where("id", "=", libraryId).execute();
  return { splitMode: guideSplitMode(text) };
}

async function libraryGuideText(db: DB, libraryId: string) {
  const library = await db.selectFrom("resources").select(["guide_text", "guide_document_id"]).where("id", "=", libraryId).executeTakeFirst();
  if (library?.guide_text) return library.guide_text;
  if (!library?.guide_document_id) return "";
  const state = await db.selectFrom("document_states").select("text").where("resource_id", "=", library.guide_document_id).executeTakeFirst();
  return state?.text ?? "";
}

async function librarySplitMode(db: DB, libraryId: string) {
  return guideSplitMode(await libraryGuideText(db, libraryId));
}

export function guideSplitMode(markdown: string) {
  const line = markdown.split("\n").map((item) => item.trim()).find((item) => item.startsWith("拆分："));
  if (!line || line.includes("按来源")) return "source" as const;
  if (line.includes("按知识内容")) return "content" as const;
  if (line.includes("按目录")) return "outline" as const;
  return "custom" as const;
}

async function publicSubscription(db: DB, row: {
  id: string;
  source_kind: string;
  source_id: string;
  url: string;
  node_id: string | null;
  source_version: string;
  status: string;
  created_at: string;
}) {
  const node = row.node_id
    ? await db.selectFrom("resources").select("title").where("id", "=", row.node_id).executeTakeFirst()
    : undefined;
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    url: row.url,
    nodeId: row.node_id,
    nodeTitle: node?.title ?? "",
    status: row.status,
    sourceVersion: row.source_version,
    createdAt: row.created_at,
  };
}

async function pendingStatus(db: DB, row: { source_kind: string; source_id: string; url: string; source_version: string; status: string }) {
  return (await subscriptionStatus(db, row)) === "missing" ? "missing" : "pending";
}

async function sourceTitle(db: DB, row: { source_kind: string; source_id: string; url: string }) {
  if (row.url) return row.url;
  if (row.source_kind === "document") {
    const resource = await db.selectFrom("resources").select("title").where("id", "=", row.source_id).executeTakeFirst();
    return resource?.title ?? "";
  }
  if (row.source_kind === "file") {
    const file = await db.selectFrom("file_items").select("name").where("id", "=", row.source_id).executeTakeFirst();
    return file?.name ?? "";
  }
  if (row.source_kind === "folder") {
    const folder = await db.selectFrom("file_folders").select("name").where("id", "=", row.source_id).executeTakeFirst();
    return folder?.name ?? "";
  }
  if (row.source_kind === "mail") {
    const message = await db.selectFrom("mail_messages").select("subject").where("id", "=", row.source_id).executeTakeFirst();
    return message?.subject || "（无主题）";
  }
  const mailbox = await db.selectFrom("mailboxes").select("address").where("id", "=", row.source_id).executeTakeFirst();
  return mailbox?.address ?? "";
}

async function subscriptionStatus(db: DB, row: { source_kind: string; source_id: string; url: string; source_version: string; status: string }) {
  if (row.source_kind === "url") return row.status === "missing" ? "missing" : "active";
  if (row.source_kind === "document") {
    const resource = await db.selectFrom("resources").select(["version", "deleted_at"]).where("id", "=", row.source_id).executeTakeFirst();
    if (!resource || resource.deleted_at) return "missing";
    return String(resource.version) === row.source_version ? "active" : "stale";
  }
  if (row.source_kind === "file") {
    const file = await db.selectFrom("file_items").select(["updated_at", "deleted_at"]).where("id", "=", row.source_id).executeTakeFirst();
    if (!file || file.deleted_at) return "missing";
    return file.updated_at === row.source_version ? "active" : "stale";
  }
  if (row.source_kind === "folder") {
    const folder = await db.selectFrom("file_folders").select(["updated_at", "deleted_at"]).where("id", "=", row.source_id).executeTakeFirst();
    if (!folder || folder.deleted_at) return "missing";
    return folder.updated_at === row.source_version ? "active" : "stale";
  }
  if (row.source_kind === "mail") {
    const message = await db.selectFrom("mail_messages").select("updated_at").where("id", "=", row.source_id).executeTakeFirst();
    if (!message) return "missing";
    return message.updated_at === row.source_version ? "active" : "stale";
  }
  const mailbox = await db.selectFrom("mailboxes").select(["updated_at", "deleted_at"]).where("id", "=", row.source_id).executeTakeFirst();
  if (!mailbox || mailbox.deleted_at) return "missing";
  return mailbox.updated_at === row.source_version ? "active" : "stale";
}

async function readSource(db: DB, actor: Actor, libraryId: string, input: { sourceKind: SubscriptionKind; sourceId?: string; url?: string }) {
  if (input.sourceKind === "url") {
    const url = normalizeSubscriptionUrl(input.url ?? "");
    return { sourceId: "", url, version: "", title: urlHost(url), markdown: nodeMarkdown(urlHost(url), url, `链接：${url}`) };
  }
  const sourceId = input.sourceId ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) fail(400, "来源不存在");
  if (input.sourceKind === "document") {
    const resource = await authorize(db, actor, sourceId, 1);
    if (resource.resource.kind !== "document") fail(400, "只能订阅一篇文档");
    if (resource.resource.library_id === libraryId) fail(400, "这篇已经在这个知识库里");
    const state = await db.selectFrom("document_states").select("text").where("resource_id", "=", sourceId).executeTakeFirst();
    const text = (state?.text ?? "").trim();
    return {
      sourceId,
      url: "",
      version: String(resource.resource.version),
      title: resource.resource.title,
      markdown: nodeMarkdown(resource.resource.title, text || resource.resource.title, `来源文档：${resource.resource.title}`),
    };
  }
  if (input.sourceKind === "file") {
    const file = await db.selectFrom("file_items").select(["id", "owner_id", "name", "ai_description_override", "updated_at", "deleted_at"]).where("id", "=", sourceId).executeTakeFirst();
    if (!file || file.deleted_at || file.owner_id !== actor.id) fail(404, "文件不存在");
    const chunks = await db.selectFrom("knowledge_chunks").select("text").where("source_kind", "=", "file").where("source_id", "=", sourceId).orderBy("ordinal").limit(8).execute();
    const text = [file.ai_description_override, ...chunks.map((chunk) => chunk.text)].filter(Boolean).join("\n\n");
    return { sourceId, url: "", version: file.updated_at, title: file.name, markdown: nodeMarkdown(file.name, text || file.name, `来源文件：${file.name}`) };
  }
  if (input.sourceKind === "folder") {
    const folder = await db.selectFrom("file_folders").select(["id", "owner_id", "name", "updated_at", "deleted_at"]).where("id", "=", sourceId).executeTakeFirst();
    if (!folder || folder.deleted_at || folder.owner_id !== actor.id) fail(404, "文件夹不存在");
    return { sourceId, url: "", version: folder.updated_at, title: folder.name, markdown: nodeMarkdown(folder.name, `文件夹「${folder.name}」里的文件会写进这个知识库的对应节点。`, `来源文件夹：${folder.name}`) };
  }
  if (input.sourceKind === "mail") {
    const message = await db.selectFrom("mail_messages").select(["id", "mailbox_id", "subject", "from_addr", "snippet", "body_text", "updated_at"]).where("id", "=", sourceId).executeTakeFirst();
    const mailbox = message
      ? await db.selectFrom("mailboxes").select(["owner_id", "address", "deleted_at"]).where("id", "=", message.mailbox_id).executeTakeFirst()
      : undefined;
    if (!message || !mailbox || mailbox.deleted_at || mailbox.owner_id !== actor.id) fail(404, "邮件不存在");
    const title = message.subject || "（无主题）";
    const text = [message.from_addr, message.snippet, message.body_text].filter(Boolean).join("\n\n");
    return { sourceId, url: "", version: message.updated_at, title, markdown: nodeMarkdown(title, text || title, `来源邮件：${mailbox.address}`) };
  }
  const mailbox = await db.selectFrom("mailboxes").select(["id", "owner_id", "address", "display_name", "knowledge_scope", "updated_at", "deleted_at"]).where("id", "=", sourceId).executeTakeFirst();
  if (!mailbox || mailbox.deleted_at || mailbox.owner_id !== actor.id) fail(404, "邮箱不存在");
  const title = mailbox.display_name || mailbox.address;
  return {
    sourceId,
    url: "",
    version: mailbox.updated_at,
    title,
    markdown: nodeMarkdown(title, `邮箱 ${mailbox.address} 按「${mailbox.knowledge_scope}」进入这个知识库。`, `来源邮箱：${mailbox.address}`),
  };
}

async function filesUnderFolder(db: DB, folderId: string) {
  const folderIds = [folderId];
  for (let index = 0; index < folderIds.length && folderIds.length < 20; index += 1) {
    const children = await db.selectFrom("file_folders").select("id").where("parent_id", "=", folderIds[index]!).where("deleted_at", "is", null).limit(20).execute();
    for (const child of children) if (!folderIds.includes(child.id)) folderIds.push(child.id);
  }
  const files = await db.selectFrom("file_items").select("id")
    .where("parent_type", "=", "folder")
    .where("parent_id", "in", folderIds)
    .where("deleted_at", "is", null)
    .orderBy("updated_at", "desc")
    .limit(40)
    .execute();
  return files.map((file) => file.id);
}

async function messagesInMailbox(db: DB, mailboxId: string) {
  const mailbox = await db.selectFrom("mailboxes").select("knowledge_scope").where("id", "=", mailboxId).executeTakeFirst();
  const rows = await db.selectFrom("mail_messages").select(["id", "starred"]).where("mailbox_id", "=", mailboxId).orderBy("received_at", "desc").limit(80).execute();
  return rows.filter((row) => mailKnowledgeIncluded(mailbox?.knowledge_scope, row.starred)).slice(0, 40).map((row) => row.id);
}

function nodeMarkdown(title: string, body: string, sourceLine: string) {
  return [`# ${title}`, "", body.trim().slice(0, 8000), "", sourceLine].join("\n");
}

function normalizeSubscriptionUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail(400, "链接需要写成 http 或 https 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(400, "链接需要写成 http 或 https 地址");
  if (!url.hostname || url.username || url.password) fail(400, "链接需要写成 http 或 https 地址");
  return url.toString().slice(0, 500);
}

function urlHost(value: string) {
  try { return new URL(value).hostname; } catch { return value; }
}
