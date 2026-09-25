import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { authorize } from "../access/queries.js";
import { fail } from "../../shared/errors.js";
import { mailKnowledgeIncluded } from "../plugins/policies.js";

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
  const library = await db.selectFrom("resources").select(["id", "kind", "ai_curated", "guide_text", "knowledge_schedule", "knowledge_preset"]).where("id", "=", libraryId).executeTakeFirst();
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
      preset: parseSourcePreset(row.preset),
    });
  }
  const guideText = await libraryGuideText(db, libraryId);
  const runs = await db.selectFrom("knowledge_runs").selectAll().where("library_id", "=", libraryId).orderBy("created_at", "desc").limit(8).execute();
  return {
    aiCurated: Number(library.ai_curated ?? 0) === 1,
    guideText,
    splitMode: guideSplitMode(guideText),
    schedule: knowledgeSchedule(library.knowledge_schedule || "off"),
    preset: parseLibraryPreset(library.knowledge_preset, knowledgeSchedule(library.knowledge_schedule || "off")),
    runs: runs.map((run) => ({
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      detail: run.detail,
      createdAt: run.created_at,
    })),
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
  const library = await db.selectFrom("resources").select(["id", "kind", "ai_curated", "knowledge_schedule", "knowledge_preset"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (Number(library.ai_curated ?? 0) !== 1) fail(400, "先启用知识体系");
  const pending = await db.selectFrom("knowledge_subscriptions").selectAll().where("id", "=", subscriptionId).where("library_id", "=", libraryId).executeTakeFirst();
  if (!pending) fail(404, "连线不存在");
  if (pending.status !== "pending") return { ...(await publicSubscription(db, pending)), included: 0 };
  const source = await readSource(db, actor, libraryId, { sourceKind: pending.source_kind as SubscriptionKind, sourceId: pending.source_id, url: pending.url });
  const libraryPreset = parseLibraryPreset(library.knowledge_preset, knowledgeSchedule(library.knowledge_schedule || "off"));
  const copyText = presetCopiesText(libraryPreset, parseSourcePreset(pending.preset));
  const node = await createDocument(actor, {
    title: source.title,
    kind: "document",
    format: "markdown",
    libraryId,
    markdown: markdownForPreset(source.markdown, copyText),
  });
  await db.updateTable("knowledge_subscriptions").set({ node_id: node.id, status: "active", source_version: source.version }).where("id", "=", pending.id).execute();
  const mode = await librarySplitMode(db, libraryId);
  const kind = pending.source_kind as SubscriptionKind;
  let included = 0;
  if (kind === "folder" && mode === "source") {
    const files = await filesUnderFolder(db, source.sourceId);
    for (const file of files) {
      const snapshot = await readSource(db, actor, libraryId, { sourceKind: "file", sourceId: file });
      snapshot.markdown = markdownForPreset(snapshot.markdown, libraryPreset.copyText);
      await ensureSubscription(db, actor, libraryId, "file", snapshot, node.id, createDocument);
      included += 1;
    }
  }
  if (kind === "mailbox" && mode === "source") {
    const messages = await messagesInMailbox(db, source.sourceId);
    for (const messageId of messages) {
      const snapshot = await readSource(db, actor, libraryId, { sourceKind: "mail", sourceId: messageId });
      snapshot.markdown = markdownForPreset(snapshot.markdown, libraryPreset.copyText);
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

export type KnowledgeSchedule = "off" | "daily" | "weekly";

export function knowledgeSchedule(value: string): KnowledgeSchedule {
  if (value === "daily" || value === "weekly" || value === "off") return value;
  return "off";
}

export type LibraryPreset = {
  weight: number;
  frequency: KnowledgeSchedule;
  copyText: boolean;
  note: string;
};

export type SourcePreset = {
  weight: number | null;
  frequency: "inherit" | KnowledgeSchedule;
  copyText: "inherit" | "yes" | "no";
  note: string;
};

function clampWeight(value: unknown, fallback: number) {
  const weight = Number(value);
  if (!Number.isInteger(weight) || weight < 1 || weight > 10) return fallback;
  return weight;
}

export function parseLibraryPreset(raw: string | null | undefined, frequency: KnowledgeSchedule): LibraryPreset {
  const fallback: LibraryPreset = { weight: 5, frequency, copyText: true, note: "" };
  if (!raw?.trim()) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<LibraryPreset>;
    return {
      weight: clampWeight(value.weight, 5),
      frequency: value.frequency === "daily" || value.frequency === "weekly" || value.frequency === "off" ? value.frequency : frequency,
      copyText: value.copyText !== false,
      note: typeof value.note === "string" ? value.note.slice(0, 20000) : "",
    };
  } catch {
    return fallback;
  }
}

export function parseSourcePreset(raw: string | null | undefined): SourcePreset {
  const fallback: SourcePreset = { weight: null, frequency: "inherit", copyText: "inherit", note: "" };
  if (!raw?.trim()) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<SourcePreset>;
    const frequency = value.frequency === "off" || value.frequency === "daily" || value.frequency === "weekly" || value.frequency === "inherit" ? value.frequency : "inherit";
    const copyText = value.copyText === "yes" || value.copyText === "no" || value.copyText === "inherit" ? value.copyText : "inherit";
    return {
      weight: value.weight == null ? null : clampWeight(value.weight, 5),
      frequency,
      copyText,
      note: typeof value.note === "string" ? value.note.slice(0, 20000) : "",
    };
  } catch {
    return fallback;
  }
}

export function draftLibraryPreset(guideText: string, frequency: KnowledgeSchedule): LibraryPreset {
  const splitMode = guideSplitMode(guideText);
  const copyText = splitMode !== "content";
  const weight = splitMode === "custom" ? 7 : 5;
  const cadence = frequency === "off" ? "weekly" : frequency;
  const splitLabel = splitMode === "content" ? "按知识内容" : splitMode === "outline" ? "按目录" : splitMode === "custom" ? "按说明里的规则" : "按来源";
  return {
    weight,
    frequency: cadence,
    copyText,
    note: [
      "# 整库预设",
      "",
      `权重 ${weight}。频率${cadence === "daily" ? "每天" : "每周"}。${copyText ? "写入节点时复制来源正文。" : "节点只记下位置，正文留在来源。"}`,
      "",
      `结构说明的拆分是「${splitLabel}」。这份说明可以改，保存之后才当作这套知识库的预设。`,
    ].join("\n"),
  };
}

export function draftSourcePreset(input: { title: string; sourceKind: string }, library: LibraryPreset): SourcePreset {
  const broad = input.sourceKind === "folder" || input.sourceKind === "mailbox";
  const copyText = input.sourceKind === "url" ? "no" : "inherit";
  const weight = broad ? Math.min(10, library.weight + 2) : null;
  return {
    weight,
    frequency: "inherit",
    copyText,
    note: [
      `# ${input.title || input.sourceKind}`,
      "",
      `频率沿用整库。${copyText === "no" ? "这条来源不复制正文。" : "是否复制正文沿用整库。"}${weight == null ? "" : ` 权重 ${weight}。`}`,
      "",
      "生成后可以直接改。保存之后，确认加入才按这份预设写入节点。",
    ].join("\n"),
  };
}

function presetCopiesText(library: LibraryPreset, source: SourcePreset) {
  if (source.copyText === "yes") return true;
  if (source.copyText === "no") return false;
  return library.copyText;
}

function markdownForPreset(markdown: string, copyText: boolean) {
  if (copyText) return markdown;
  const lines = markdown.split("\n");
  const title = lines[0] ?? "";
  const sourceLine = [...lines].reverse().find((line) => line.startsWith("来源")) ?? "";
  return [title, "", "正文留在来源，这里只记下位置。", "", sourceLine].filter((line) => line !== undefined).join("\n");
}

export async function setKnowledgeSchedule(db: DB, actor: Actor, libraryId: string, mode: KnowledgeSchedule) {
  await authorize(db, actor, libraryId, 4);
  const library = await db.selectFrom("resources").select(["id", "kind", "ai_curated", "knowledge_preset"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (mode !== "off" && Number(library.ai_curated ?? 0) !== 1) fail(400, "先打开知识关系");
  const preset = parseLibraryPreset(library.knowledge_preset, mode);
  preset.frequency = mode;
  await db.updateTable("resources").set({ knowledge_schedule: mode, knowledge_preset: JSON.stringify(preset) }).where("id", "=", libraryId).execute();
  return { schedule: mode, preset };
}

async function requireCuratedLibrary(db: DB, actor: Actor, libraryId: string) {
  await authorize(db, actor, libraryId, 4);
  const library = await db.selectFrom("resources").select(["id", "kind", "ai_curated", "guide_text", "knowledge_schedule", "knowledge_preset"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (Number(library.ai_curated ?? 0) !== 1) fail(400, "先打开知识关系");
  return library;
}

export async function saveLibraryPreset(db: DB, actor: Actor, libraryId: string, input: LibraryPreset) {
  const library = await requireCuratedLibrary(db, actor, libraryId);
  const preset = parseLibraryPreset(JSON.stringify(input), knowledgeSchedule(library.knowledge_schedule || "off"));
  await db.updateTable("resources").set({
    knowledge_preset: JSON.stringify(preset),
    knowledge_schedule: preset.frequency,
  }).where("id", "=", libraryId).execute();
  return { preset, schedule: preset.frequency };
}

export async function draftLibraryPresetForActor(db: DB, actor: Actor, libraryId: string) {
  const library = await requireCuratedLibrary(db, actor, libraryId);
  const guideText = await libraryGuideText(db, libraryId);
  return { preset: draftLibraryPreset(guideText, knowledgeSchedule(library.knowledge_schedule || "off")) };
}

export async function saveSourcePreset(db: DB, actor: Actor, libraryId: string, subscriptionId: string, input: SourcePreset) {
  await requireCuratedLibrary(db, actor, libraryId);
  const row = await db.selectFrom("knowledge_subscriptions").select("id").where("id", "=", subscriptionId).where("library_id", "=", libraryId).executeTakeFirst();
  if (!row) fail(404, "连线不存在");
  const preset = parseSourcePreset(JSON.stringify(input));
  await db.updateTable("knowledge_subscriptions").set({ preset: JSON.stringify(preset) }).where("id", "=", subscriptionId).execute();
  return { preset };
}

export async function draftSourcePresetForActor(db: DB, actor: Actor, libraryId: string, subscriptionId: string) {
  const library = await requireCuratedLibrary(db, actor, libraryId);
  const row = await db.selectFrom("knowledge_subscriptions").selectAll().where("id", "=", subscriptionId).where("library_id", "=", libraryId).executeTakeFirst();
  if (!row) fail(404, "连线不存在");
  const libraryPreset = parseLibraryPreset(library.knowledge_preset, knowledgeSchedule(library.knowledge_schedule || "off"));
  return { preset: draftSourcePreset({ title: await sourceTitle(db, row), sourceKind: row.source_kind }, libraryPreset) };
}

export async function runKnowledgeLibrary(db: DB, actor: Actor, libraryId: string, trigger: "manual" | "schedule") {
  await authorize(db, actor, libraryId, 4);
  const listed = await listKnowledgeSubscriptions(db, actor, libraryId);
  if (!listed.aiCurated) fail(400, "先打开知识关系");
  const counts = { pending: 0, stale: 0, active: 0, missing: 0 };
  for (const item of listed.items) {
    if (item.status === "pending") counts.pending += 1;
    else if (item.status === "stale") counts.stale += 1;
    else if (item.status === "missing") counts.missing += 1;
    else counts.active += 1;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const detail = JSON.stringify(counts);
  await db.insertInto("knowledge_runs").values({
    id,
    library_id: libraryId,
    trigger,
    status: "done",
    detail,
    created_at: now,
  }).execute();
  return { id, trigger, status: "done", createdAt: now, ...counts };
}

export async function sweepKnowledgeSchedules(db: DB) {
  const libraries = await db.selectFrom("resources")
    .select(["id", "owner_id", "knowledge_schedule"])
    .where("kind", "=", "library")
    .where("deleted_at", "is", null)
    .where("ai_curated", "=", 1)
    .where("knowledge_schedule", "in", ["daily", "weekly"])
    .execute();
  for (const library of libraries) {
    try {
      const last = await db.selectFrom("knowledge_runs").select("created_at").where("library_id", "=", library.id).orderBy("created_at", "desc").executeTakeFirst();
      const wait = library.knowledge_schedule === "weekly" ? 6 * 24 * 60 * 60 * 1000 : 20 * 60 * 60 * 1000;
      if (last && Date.now() - Date.parse(last.created_at) < wait) continue;
      const owner = await db.selectFrom("users").select(["id", "display_name", "admin"]).where("id", "=", library.owner_id).executeTakeFirst();
      if (!owner) continue;
      await runKnowledgeLibrary(db, owner, library.id, "schedule");
    } catch {
      continue;
    }
  }
}

export async function getKnowledgeBot(db: DB, actor: Actor, libraryId: string) {
  await authorize(db, actor, libraryId, 1);
  const library = await db.selectFrom("resources").select(["id", "kind", "title"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const bot = await db.selectFrom("knowledge_bots").selectAll().where("library_id", "=", libraryId).executeTakeFirst();
  return {
    title: bot?.title || library.title,
    published: Number(bot?.published ?? 0) === 1,
  };
}

export async function saveKnowledgeBot(db: DB, actor: Actor, libraryId: string, input: { title: string; published: boolean }) {
  await authorize(db, actor, libraryId, 4);
  const library = await db.selectFrom("resources").select(["id", "kind", "title"]).where("id", "=", libraryId).where("deleted_at", "is", null).executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const title = input.title.trim() || library.title;
  const now = new Date().toISOString();
  const existing = await db.selectFrom("knowledge_bots").select("library_id").where("library_id", "=", libraryId).executeTakeFirst();
  if (existing) {
    await db.updateTable("knowledge_bots").set({ title, published: input.published ? 1 : 0, updated_at: now }).where("library_id", "=", libraryId).execute();
  } else {
    await db.insertInto("knowledge_bots").values({ library_id: libraryId, title, published: input.published ? 1 : 0, updated_at: now }).execute();
  }
  return { title, published: input.published };
}

export async function askKnowledgeLibrary(db: DB, actor: Actor, libraryId: string, query: string) {
  const bot = await getKnowledgeBot(db, actor, libraryId);
  await authorize(db, actor, libraryId, bot.published ? 1 : 4);
  const phrase = query.trim().toLowerCase();
  const terms = [...new Set([phrase, ...phrase.split(/\s+/)].filter((term) => term.length >= 2))].slice(0, 8);
  const libraryRow = await db.selectFrom("resources").select(["knowledge_preset", "knowledge_schedule"]).where("id", "=", libraryId).executeTakeFirst();
  const libraryPreset = parseLibraryPreset(libraryRow?.knowledge_preset, knowledgeSchedule(libraryRow?.knowledge_schedule || "off"));
  const rows = await db.selectFrom("knowledge_subscriptions").select(["node_id", "preset"]).where("library_id", "=", libraryId).where("status", "=", "active").where("node_id", "is not", null).execute();
  const items = [];
  for (const row of rows) {
    if (!row.node_id) continue;
    const node = await db.selectFrom("resources").select(["id", "title"]).where("id", "=", row.node_id).where("deleted_at", "is", null).executeTakeFirst();
    if (!node) continue;
    const state = await db.selectFrom("document_states").select("text").where("resource_id", "=", node.id).executeTakeFirst();
    const text = state?.text ?? "";
    const haystack = `${node.title}\n${text}`.toLowerCase();
    const matched = terms.filter((term) => haystack.includes(term)).length;
    if (!matched) continue;
    const sourcePreset = parseSourcePreset(row.preset);
    const weight = sourcePreset.weight ?? libraryPreset.weight;
    const score = matched + weight / 10;
    const inText = terms.map((term) => text.toLowerCase().indexOf(term)).find((index) => index >= 0);
    const start = Math.max(0, (inText ?? 0) - 40);
    const excerpt = (inText == null ? text : text.slice(start, start + 160)).trim();
    items.push({ nodeId: node.id, title: node.title, excerpt, score });
  }
  items.sort((left, right) => right.score - left.score);
  return {
    title: bot.title,
    items: items.slice(0, 5).map((item) => ({ nodeId: item.nodeId, title: item.title, excerpt: item.excerpt })),
  };
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
  preset?: string | null;
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
    preset: parseSourcePreset(row.preset),
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
