import { createHash, randomUUID } from "node:crypto";
import { enqueueProjection } from "../automation/jobs.js";
import { mailKnowledgeIncluded } from "../mail/scope.js";
import type { DB } from "../../../../db/src/index.js";

export type KnowledgeKind = "document" | "file" | "mail" | "folder" | "library";
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stopWords = new Set([
  "文件", "文档", "内容", "这个", "我们", "可以", "一个", "以及", "the", "and", "with",
]);

export type KnowledgeIndexer = {
  replace(
    removed: string[],
    docs: Array<{ id: string; title: string; text: string; readerIds: string[] }>,
  ): Promise<void>;
  search(
    tokens: string[],
    query: string,
  ): Promise<Array<{ id: string; score: number }> | null>;
};

export function enqueueKnowledge(db: DB, kind: KnowledgeKind, id: string) {
  return enqueueProjection(db, "knowledge", `${kind}:${id}`, { kind, id });
}

export function splitKnowledgeText(title: string, body: string) {
  const source = (body || title).replace(/\r\n/g, "\n").trim();
  if (!source) return [];
  const headed = source.split(/\n(?=#{1,3} )/u).map((part) => part.trim()).filter(Boolean);
  const parts = headed.length > 1
    ? headed
    : source.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const chunks: Array<{ ordinal: number; text: string; anchor: string }> = [];
  let buffer = "";
  let heading = title.slice(0, 80);
  const flush = () => {
    const text = buffer.trim().slice(0, 3500);
    if (!text) return;
    chunks.push({
      ordinal: chunks.length,
      text,
      anchor: JSON.stringify({ heading, ordinal: chunks.length }),
    });
    buffer = "";
  };
  for (const part of parts.length ? parts : [source]) {
    const mark = /^(#{1,3})\s+(.+)/u.exec(part);
    if (mark) heading = mark[2]!.trim().slice(0, 80);
    if (buffer && buffer.length + part.length > 1100) flush();
    buffer = buffer ? `${buffer}\n${part}` : part;
    if (buffer.length >= 700) flush();
  }
  flush();
  return chunks.slice(0, 40);
}

export function knowledgeTerms(value: string) {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  const terms = new Set<string>();
  for (const part of segmenter.segment(normalized)) {
    const term = part.segment.trim();
    if (part.isWordLike && term.length >= 2 && term.length <= 18 && !stopWords.has(term))
      terms.add(term);
  }
  // Repeated or unsplittable words such as 猫猫 stay one character each, so keep the short phrase itself.
  for (const token of normalized.split(/\s+/))
    if (/^[\p{Script=Han}]{2,8}$/u.test(token) && !stopWords.has(token)) terms.add(token);
  return [...terms].slice(0, 24);
}

function chunkKey(kind: string, sourceId: string, ordinal: number) {
  return `kc_${createHash("sha256").update(`${kind}:${sourceId}:${ordinal}`).digest("hex").slice(0, 32)}`;
}

function visibilityTokens(visibility: string | null | undefined) {
  if (visibility === "public") return ["visibility:public", "visibility:authenticated"];
  if (visibility === "authenticated") return ["visibility:authenticated"];
  return [];
}

export function readerTokensFor(userId: string) {
  return [userId, "visibility:authenticated", "visibility:public"];
}

export function canReadChunk(readerIds: string[], userId: string) {
  const tokens = new Set(readerTokensFor(userId));
  return readerIds.some((id) => tokens.has(id));
}

async function documentReaders(db: DB, id: string) {
  const resource = await db.selectFrom("resources").selectAll().where("id", "=", id).executeTakeFirst();
  if (!resource) return { alive: false, title: "", text: "", readers: [] as string[], libraryId: null as string | null };
  const ids = [resource.id, resource.library_id].filter((value): value is string => !!value);
  const readers = new Set<string>([resource.owner_id, ...visibilityTokens(resource.visibility)]);
  if (resource.library_id) {
    const library = await db.selectFrom("resources").select(["owner_id", "visibility"]).where("id", "=", resource.library_id).executeTakeFirst();
    if (library) {
      readers.add(library.owner_id);
      for (const token of visibilityTokens(library.visibility)) readers.add(token);
    }
  }
  if (ids.length) {
    const grants = await db.selectFrom("grants").select("user_id").where("resource_id", "in", ids).where("status", "=", "active").execute();
    for (const grant of grants) readers.add(grant.user_id);
    const invitations = await db.selectFrom("access_invitations").select("user_id").where("resource_id", "in", ids).where("state", "=", "accepted").execute();
    for (const invitation of invitations) readers.add(invitation.user_id);
  }
  const state = await db.selectFrom("document_states").select("text").where("resource_id", "=", id).executeTakeFirst();
  return {
    alive: resource.kind === "document" && !resource.deleted_at,
    title: resource.title,
    text: state?.text ?? "",
    readers: [...readers],
    libraryId: resource.library_id,
  };
}

async function folderReaders(db: DB, folderId: string) {
  const readers = new Set<string>();
  let current: string | null = folderId;
  for (let depth = 0; current && depth < 12; depth += 1) {
    const folder: { owner_id: string; parent_id: string | null } | undefined = await db.selectFrom("file_folders").select(["owner_id", "parent_id"]).where("id", "=", current).where("deleted_at", "is", null).executeTakeFirst();
    if (!folder) break;
    readers.add(folder.owner_id);
    const shares: Array<{ user_id: string }> = await db.selectFrom("file_folder_shares").select("user_id").where("folder_id", "=", current).execute();
    for (const share of shares) readers.add(share.user_id);
    current = folder.parent_id && folder.parent_id !== "shared" ? folder.parent_id : null;
  }
  return [...readers];
}

async function fileRecord(db: DB, id: string) {
  const item = await db
    .selectFrom("file_items as f")
    .innerJoin("file_storage_objects as o", "o.id", "f.storage_object_id")
    .leftJoin("file_extracts as e", "e.storage_object_id", "o.id")
    .select([
      "f.id", "f.name", "f.owner_id", "f.parent_type", "f.parent_id", "f.deleted_at",
      "f.ai_description_override", "o.ai_description", "e.result as extract", "e.status as extract_status",
    ])
    .where("f.id", "=", id)
    .executeTakeFirst();
  if (!item || item.deleted_at) return { alive: false, title: "", text: "", readers: [] as string[] };
  const readers = new Set<string>([item.owner_id]);
  if (item.parent_type === "document") {
    for (const reader of (await documentReaders(db, item.parent_id)).readers) readers.add(reader);
  } else if (item.parent_type === "folder") {
    for (const reader of await folderReaders(db, item.parent_id)) readers.add(reader);
  }
  const description = item.ai_description_override || item.ai_description || "";
  const extract = item.extract_status === "ready" ? extractMarkdown(item.extract) : "";
  return {
    alive: true,
    title: item.name,
    text: [item.name, description, extract].filter(Boolean).join("\n"),
    readers: [...readers],
  };
}

async function mailRecord(db: DB, id: string) {
  const message = await db
    .selectFrom("mail_messages as m")
    .innerJoin("mailboxes as b", "b.id", "m.mailbox_id")
    .select(["m.id", "m.subject", "m.from_addr", "m.snippet", "m.body_text", "m.starred", "m.ai_tags", "b.owner_id", "b.id as mailbox_id", "b.deleted_at", "b.knowledge_scope"])
    .where("m.id", "=", id)
    .executeTakeFirst();
  if (!message || message.deleted_at || !mailKnowledgeIncluded(message.knowledge_scope, message.starred))
    return { alive: false, title: "", text: "", readers: [] as string[] };
  const readers = new Set<string>([message.owner_id]);
  const shares = await db.selectFrom("mailbox_shares").select("user_id").where("mailbox_id", "=", message.mailbox_id).execute();
  for (const share of shares) readers.add(share.user_id);
  return {
    alive: true,
    title: message.subject || "（无主题）",
    text: [message.subject, message.from_addr, message.ai_tags, message.snippet, message.body_text].filter(Boolean).join("\n"),
    readers: [...readers],
  };
}

async function clearSource(db: DB, kind: string, id: string) {
  const existing = await db.selectFrom("knowledge_chunks").select("id").where("source_kind", "=", kind).where("source_id", "=", id).execute();
  await db.deleteFrom("knowledge_chunks").where("source_kind", "=", kind).where("source_id", "=", id).execute();
  await db.deleteFrom("knowledge_links").where("from_kind", "=", kind).where("from_id", "=", id).where("relation", "=", "similar").execute();
  return existing.map((row) => row.id);
}

async function rememberSimilar(db: DB, kind: string, id: string, title: string, text: string, readers: string[]) {
  const terms = knowledgeTerms(`${title}\n${text}`);
  if (terms.length < 2) return;
  const rows = await db.selectFrom("knowledge_chunks").select(["source_kind", "source_id", "title", "text", "reader_ids"]).orderBy("updated_at", "desc").limit(300).execute();
  const seen = new Set<string>();
  const matches: Array<{ kind: string; id: string; score: number; title: string }> = [];
  for (const row of rows) {
    if (row.source_kind === kind && row.source_id === id) continue;
    const key = `${row.source_kind}:${row.source_id}`;
    if (seen.has(key)) continue;
    const theirReaders = JSON.parse(row.reader_ids) as string[];
    if (!readers.some((reader) => theirReaders.includes(reader) || reader.startsWith("visibility:"))) continue;
    seen.add(key);
    const theirs = new Set(knowledgeTerms(`${row.title}\n${row.text}`));
    const shared = terms.filter((term) => theirs.has(term));
    const score = shared.length / terms.length;
    if (shared.length >= 2 && score >= 0.34)
      matches.push({ kind: row.source_kind, id: row.source_id, score, title: row.title });
  }
  const now = new Date().toISOString();
  for (const match of matches.sort((a, b) => b.score - a.score).slice(0, 6)) {
    await db
      .insertInto("knowledge_links")
      .values({
        id: randomUUID(),
        from_kind: kind,
        from_id: id,
        to_kind: match.kind,
        to_id: match.id,
        relation: "similar",
        score: Number(match.score.toFixed(3)),
        reason: `与「${match.title.slice(0, 40)}」用词接近`,
        created_at: now,
      })
      .onConflict((oc) => oc.columns(["from_kind", "from_id", "to_kind", "to_id", "relation"]).doUpdateSet({
        score: Number(match.score.toFixed(3)),
        reason: `与「${match.title.slice(0, 40)}」用词接近`,
      }))
      .execute();
  }
}

export async function rebuildKnowledge(
  db: DB,
  kind: string,
  id: string,
  indexer?: KnowledgeIndexer,
) {
  const record = kind === "document"
    ? await documentReaders(db, id)
    : kind === "file"
      ? await fileRecord(db, id)
      : kind === "mail"
        ? await mailRecord(db, id)
        : { alive: false, title: "", text: "", readers: [] as string[] };
  const existing = await db.selectFrom("knowledge_chunks").select("id").where("source_kind", "=", kind).where("source_id", "=", id).execute();
  const pieces = record.alive ? splitKnowledgeText(record.title, record.text) : [];
  const now = new Date().toISOString();
  const docs = pieces.map((piece, ordinal) => {
    const chunkId = chunkKey(kind, id, ordinal);
    return {
      id: chunkId,
      ordinal,
      title: record.title.slice(0, 200),
      text: piece.text,
      anchor: piece.anchor,
      readerIds: record.readers,
      hash: createHash("sha256").update(piece.text).digest("hex"),
    };
  });
  if (!docs.length) {
    const removed = await clearSource(db, kind, id);
    await indexer?.replace(removed, []);
    return { chunks: 0 };
  }
  const kept = new Set(docs.map((doc) => doc.id));
  const removed = existing.map((row) => row.id).filter((chunkId) => !kept.has(chunkId));
  await db.insertInto("knowledge_chunks").values(docs.map((doc) => ({
    id: doc.id,
    source_kind: kind,
    source_id: id,
    ordinal: doc.ordinal,
    title: doc.title,
    text: doc.text,
    anchor: doc.anchor,
    content_hash: doc.hash,
    reader_ids: JSON.stringify(doc.readerIds),
    updated_at: now,
  }))).onConflict((oc) => oc.column("id").doUpdateSet((eb) => ({
    title: eb.ref("excluded.title"),
    text: eb.ref("excluded.text"),
    anchor: eb.ref("excluded.anchor"),
    content_hash: eb.ref("excluded.content_hash"),
    reader_ids: eb.ref("excluded.reader_ids"),
    updated_at: eb.ref("excluded.updated_at"),
  }))).execute();
  if (removed.length) await db.deleteFrom("knowledge_chunks").where("id", "in", removed).execute();
  await db.deleteFrom("knowledge_links").where("from_kind", "=", kind).where("from_id", "=", id).where("relation", "=", "similar").execute();
  await rememberSimilar(db, kind, id, record.title, docs.map((doc) => doc.text).join("\n"), record.readers);
  await indexer?.replace(removed, docs.map((doc) => ({
    id: doc.id,
    title: doc.title,
    text: doc.text,
    readerIds: doc.readerIds,
  })));
  return { chunks: docs.length };
}

function adjusted(score: number, judgment?: string) {
  if (judgment === "useful") return score + 0.25;
  if (judgment === "irrelevant") return score - 0.4;
  return score;
}

type KnowledgeHit = { id: string; title: string; text: string; anchor: string; sourceKind: string; sourceId: string; score: number };

async function lexicalHits(db: DB, userId: string, query: string, feedback: Map<string, string>) {
  const terms = knowledgeTerms(query);
  const pattern = readerTokensFor(userId).map((token) => `%"${token}"%`);
  const rows = await db.selectFrom("knowledge_chunks").selectAll().where((eb) => eb.or(pattern.map((value) => eb("reader_ids", "like", value)))).limit(400).execute();
  return rows.flatMap((row) => {
    if (!canReadChunk(JSON.parse(row.reader_ids), userId)) return [];
    const haystack = `${row.title}\n${row.text}`.toLocaleLowerCase();
    const covered = terms.filter((term) => haystack.includes(term)).length;
    const score = adjusted(terms.length ? covered / terms.length : 0, feedback.get(row.id));
    if (score <= 0) return [];
    return [{ id: row.id, title: row.title, text: row.text, anchor: row.anchor, sourceKind: row.source_kind, sourceId: row.source_id, score }];
  });
}

function covers(terms: string[], value: string) {
  const haystack = value.toLocaleLowerCase();
  return terms.some((term) => haystack.includes(term));
}

async function materializeKnowledgeMatches(db: DB, userId: string, query: string, indexer?: KnowledgeIndexer) {
  const terms = knowledgeTerms(query);
  if (!terms.length) return false;
  let rebuilt = 0;
  const documents = await db
    .selectFrom("resources as r")
    .leftJoin("document_states as s", "s.resource_id", "r.id")
    .select(["r.id", "r.title", "s.text"])
    .where("r.kind", "=", "document")
    .where("r.deleted_at", "is", null)
    .orderBy("r.updated_at", "desc")
    .limit(80)
    .execute();
  for (const document of documents) {
    if (rebuilt >= 8) break;
    if (!covers(terms, `${document.title}\n${document.text ?? ""}`)) continue;
    const existing = await db.selectFrom("knowledge_chunks").select(["title", "text"]).where("source_kind", "=", "document").where("source_id", "=", document.id).execute();
    if (existing.some((row) => covers(terms, `${row.title}\n${row.text}`))) continue;
    const record = await documentReaders(db, document.id);
    if (!record.alive || !canReadChunk(record.readers, userId)) continue;
    await rebuildKnowledge(db, "document", document.id, indexer);
    rebuilt += 1;
  }
  const files = await db
    .selectFrom("file_items as f")
    .leftJoin("file_storage_objects as o", "o.id", "f.storage_object_id")
    .select(["f.id", "f.name", "f.ai_description_override", "o.ai_description"])
    .where("f.deleted_at", "is", null)
    .where("f.parent_type", "!=", "document")
    .orderBy("f.updated_at", "desc")
    .limit(40)
    .execute();
  for (const file of files) {
    if (rebuilt >= 8) break;
    if (!covers(terms, `${file.name}\n${file.ai_description_override ?? ""}\n${file.ai_description ?? ""}`)) continue;
    const existing = await db.selectFrom("knowledge_chunks").select(["title", "text"]).where("source_kind", "=", "file").where("source_id", "=", file.id).execute();
    if (existing.some((row) => covers(terms, `${row.title}\n${row.text}`))) continue;
    const record = await fileRecord(db, file.id);
    if (!record.alive || !canReadChunk(record.readers, userId)) continue;
    await rebuildKnowledge(db, "file", file.id, indexer);
    rebuilt += 1;
  }
  const messages = await db
    .selectFrom("mail_messages as m")
    .innerJoin("mailboxes as b", "b.id", "m.mailbox_id")
    .select(["m.id", "m.subject", "m.snippet", "m.body_text", "m.starred", "m.ai_tags", "b.knowledge_scope", "b.deleted_at"])
    .where("b.deleted_at", "is", null)
    .orderBy("m.received_at", "desc")
    .limit(40)
    .execute();
  for (const message of messages) {
    if (rebuilt >= 8) break;
    if (!mailKnowledgeIncluded(message.knowledge_scope, message.starred)) continue;
    if (!covers(terms, `${message.subject ?? ""}\n${message.ai_tags ?? ""}\n${message.snippet ?? ""}\n${message.body_text ?? ""}`)) continue;
    const existing = await db.selectFrom("knowledge_chunks").select(["title", "text"]).where("source_kind", "=", "mail").where("source_id", "=", message.id).execute();
    if (existing.some((row) => covers(terms, `${row.title}\n${row.text}`))) continue;
    const record = await mailRecord(db, message.id);
    if (!record.alive || !canReadChunk(record.readers, userId)) continue;
    await rebuildKnowledge(db, "mail", message.id, indexer);
    rebuilt += 1;
  }
  return rebuilt > 0;
}

export async function enqueueMissingKnowledge(db: DB) {
  const present = new Set(
    (await db.selectFrom("knowledge_chunks").select(["source_kind", "source_id"]).execute()).map((row) => `${row.source_kind}:${row.source_id}`),
  );
  let queued = 0;
  const documents = await db.selectFrom("resources").select("id").where("kind", "=", "document").where("deleted_at", "is", null).execute();
  for (const document of documents) {
    if (present.has(`document:${document.id}`)) continue;
    await enqueueKnowledge(db, "document", document.id);
    queued += 1;
  }
  const files = await db.selectFrom("file_items").select("id").where("deleted_at", "is", null).where("parent_type", "!=", "document").execute();
  for (const file of files) {
    if (present.has(`file:${file.id}`)) continue;
    await enqueueKnowledge(db, "file", file.id);
    queued += 1;
  }
  const messages = await db
    .selectFrom("mail_messages as m")
    .innerJoin("mailboxes as b", "b.id", "m.mailbox_id")
    .select(["m.id", "m.starred", "b.knowledge_scope", "b.deleted_at"])
    .execute();
  for (const message of messages) {
    const included = !message.deleted_at && mailKnowledgeIncluded(message.knowledge_scope, message.starred);
    const has = present.has(`mail:${message.id}`);
    if (included === has) continue;
    await enqueueKnowledge(db, "mail", message.id);
    queued += 1;
  }
  return queued;
}

export async function searchKnowledgeChunks(
  db: DB,
  userId: string,
  query: string,
  indexer?: KnowledgeIndexer,
) {
  const tokens = readerTokensFor(userId);
  const remote = await indexer?.search(tokens, query).catch(() => null);
  const feedbackRows = await db.selectFrom("knowledge_feedback").select(["chunk_id", "judgment", "created_at"]).where("user_id", "=", userId).orderBy("created_at", "desc").limit(500).execute();
  const feedback = new Map<string, string>();
  for (const row of feedbackRows) if (!feedback.has(row.chunk_id)) feedback.set(row.chunk_id, row.judgment);
  let hits: KnowledgeHit[] = [];
  if (remote?.length) {
    const rows = await db.selectFrom("knowledge_chunks").selectAll().where("id", "in", remote.map((hit) => hit.id)).execute();
    const rank = new Map(remote.map((hit) => [hit.id, hit.score]));
    const terms = knowledgeTerms(query);
    hits = rows.filter((row) => canReadChunk(JSON.parse(row.reader_ids), userId)).map((row) => ({
      id: row.id,
      title: row.title,
      text: row.text,
      anchor: row.anchor,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      score: adjusted(rank.get(row.id) ?? 0, feedback.get(row.id)),
    })).filter((hit) => !terms.length || covers(terms, `${hit.title}\n${hit.text}`));
  }
  if (!hits.length) hits = await lexicalHits(db, userId, query, feedback);
  if (!hits.length && await materializeKnowledgeMatches(db, userId, query, indexer))
    hits = await lexicalHits(db, userId, query, feedback);
  hits.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  hits = hits.filter((hit) => {
    const key = `${hit.sourceKind}:${hit.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const items = hits.slice(0, 12);
  if (query.trim().length >= 2 && !items.length) {
    await db.insertInto("knowledge_gaps").values({
      id: randomUUID(),
      user_id: userId,
      query: query.trim().slice(0, 300),
      status: "open",
      detail: "",
      created_at: new Date().toISOString(),
    }).execute();
  }
  return items;
}

export async function recordKnowledgeFeedback(
  db: DB,
  userId: string,
  chunkId: string,
  judgment: "useful" | "irrelevant",
  query = "",
) {
  const chunk = await db.selectFrom("knowledge_chunks").select(["id", "reader_ids"]).where("id", "=", chunkId).executeTakeFirst();
  if (!chunk || !canReadChunk(JSON.parse(chunk.reader_ids), userId)) return false;
  await db.insertInto("knowledge_feedback").values({
    id: randomUUID(),
    user_id: userId,
    chunk_id: chunkId,
    judgment,
    query: query.slice(0, 300),
    created_at: new Date().toISOString(),
  }).execute();
  return true;
}

async function sourceLabel(db: DB, kind: string, id: string) {
  if (kind === "document" || kind === "library") {
    const row = await db.selectFrom("resources").select("title").where("id", "=", id).executeTakeFirst();
    return row?.title ?? "";
  }
  if (kind === "file") {
    const row = await db.selectFrom("file_items").select("name").where("id", "=", id).executeTakeFirst();
    return row?.name ?? "";
  }
  if (kind === "mail") {
    const row = await db.selectFrom("mail_messages").select("subject").where("id", "=", id).executeTakeFirst();
    return row?.subject || "（无主题）";
  }
  if (kind === "folder") {
    const row = await db.selectFrom("file_folders").select("name").where("id", "=", id).executeTakeFirst();
    return row?.name ?? "";
  }
  return "";
}

export async function knowledgeGraph(db: DB, userId: string) {
  const tokens = readerTokensFor(userId);
  const rows = await db.selectFrom("knowledge_chunks").selectAll().where((eb) => eb.or(tokens.map((token) => eb("reader_ids", "like", `%"${token}"%`)))).orderBy("updated_at", "desc").limit(500).execute();
  const visible = rows.filter((row) => canReadChunk(JSON.parse(row.reader_ids), userId));
  const sources = new Map<string, { kind: string; id: string; title: string; chunks: number }>();
  for (const row of visible) {
    const key = `${row.source_kind}:${row.source_id}`;
    const current = sources.get(key);
    if (current) current.chunks += 1;
    else sources.set(key, { kind: row.source_kind, id: row.source_id, title: row.title, chunks: 1 });
  }
  const links = await db.selectFrom("knowledge_links").selectAll().orderBy("score", "desc").limit(200).execute();
  const hidden = new Set((await db.selectFrom("knowledge_link_hides").select("link_id").where("user_id", "=", userId).execute()).map((row) => row.link_id));
  const visibleLinks = [];
  for (const link of links) {
    if (hidden.has(link.id)) continue;
    const fromVisible = sources.has(`${link.from_kind}:${link.from_id}`) || await endpointVisible(db, userId, link.from_kind, link.from_id);
    const toVisible = sources.has(`${link.to_kind}:${link.to_id}`) || await endpointVisible(db, userId, link.to_kind, link.to_id);
    if (!fromVisible || !toVisible) continue;
    visibleLinks.push({
      ...link,
      fromTitle: sources.get(`${link.from_kind}:${link.from_id}`)?.title || await sourceLabel(db, link.from_kind, link.from_id),
      toTitle: sources.get(`${link.to_kind}:${link.to_id}`)?.title || await sourceLabel(db, link.to_kind, link.to_id),
    });
  }
  const gaps = await db.selectFrom("knowledge_gaps").selectAll().where("user_id", "=", userId).orderBy("created_at", "desc").limit(20).execute();
  return {
    sources: [...sources.values()],
    links: visibleLinks.slice(0, 40),
    gaps,
  };
}

async function endpointVisible(db: DB, userId: string, kind: string, id: string) {
  if (kind === "folder") return (await folderReaders(db, id)).includes(userId);
  if (kind === "library" || kind === "document") return (await documentReaders(db, id)).readers.some((reader) => readerTokensFor(userId).includes(reader));
  if (kind === "file") return (await fileRecord(db, id)).readers.some((reader) => readerTokensFor(userId).includes(reader));
  if (kind === "mail") return (await mailRecord(db, id)).readers.some((reader) => readerTokensFor(userId).includes(reader));
  return false;
}

export async function hideKnowledgeLink(db: DB, userId: string, linkId: string) {
  await db.insertInto("knowledge_link_hides").values({
    user_id: userId,
    link_id: linkId,
    created_at: new Date().toISOString(),
  }).onConflict((oc) => oc.columns(["user_id", "link_id"]).doNothing()).execute();
}

async function upsertOrganizeLink(db: DB, fromKind: string, fromId: string, toKind: string, toId: string, score: number, reason: string) {
  await db.insertInto("knowledge_links").values({
    id: randomUUID(),
    from_kind: fromKind,
    from_id: fromId,
    to_kind: toKind,
    to_id: toId,
    relation: "organize",
    score,
    reason: reason.slice(0, 300),
    created_at: new Date().toISOString(),
  }).onConflict((oc) => oc.columns(["from_kind", "from_id", "to_kind", "to_id", "relation"]).doUpdateSet({
    score,
    reason: reason.slice(0, 300),
  })).execute();
}

export async function suggestFolder(db: DB, userId: string, folderId: string) {
  if (!(await folderReaders(db, folderId)).includes(userId)) return [];
  const files = await db.selectFrom("file_items").select(["id", "name"]).where("parent_type", "=", "folder").where("parent_id", "=", folderId).where("deleted_at", "is", null).limit(40).execute();
  const documents = await db.selectFrom("knowledge_chunks").select(["source_id", "title", "text", "reader_ids"]).where("source_kind", "=", "document").limit(200).execute();
  const created = [];
  for (const file of files) {
    const terms = knowledgeTerms(file.name.replace(/\.[a-z0-9]{1,8}$/i, ""));
    if (!terms.length) continue;
    for (const document of documents) {
      if (!canReadChunk(JSON.parse(document.reader_ids), userId)) continue;
      const shared = terms.filter((term) => `${document.title}\n${document.text}`.toLocaleLowerCase().includes(term));
      if (shared.length < 1 || shared.length / terms.length < 0.5) continue;
      const reason = `文件夹中的「${file.name}」与文档「${document.title}」接近，建议归入同一主题`;
      await upsertOrganizeLink(db, "folder", folderId, "document", document.source_id, shared.length / terms.length, reason);
      created.push(reason);
      break;
    }
  }
  return created;
}

export async function suggestLibrary(db: DB, userId: string, libraryId: string) {
  const library = await documentReaders(db, libraryId);
  if (!library.readers.some((reader) => readerTokensFor(userId).includes(reader))) return [];
  const docs = await db.selectFrom("resources").select(["id", "title"]).where("library_id", "=", libraryId).where("kind", "=", "document").where("deleted_at", "is", null).limit(80).execute();
  const created = [];
  for (let i = 0; i < docs.length; i += 1) {
    for (const other of docs.slice(i + 1)) {
      const left = knowledgeTerms(docs[i]!.title);
      const right = knowledgeTerms(other.title);
      const shared = left.filter((term) => right.includes(term));
      if (shared.length < 1) continue;
      const reason = `知识库中「${docs[i]!.title}」和「${other.title}」主题接近，可以放在相邻目录`;
      await upsertOrganizeLink(db, "library", libraryId, "document", other.id, 0.5, reason);
      created.push(reason);
      break;
    }
  }
  return created.slice(0, 12);
}

function extractMarkdown(result: string | null | undefined) {
  if (!result) return "";
  try {
    const parts = JSON.parse(result).parts as Array<{ type?: string; text?: string }>;
    if (!Array.isArray(parts)) return "";
    return parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n").trim();
  } catch {
    return "";
  }
}

export function extractPlainFileText(filename: string, body: Buffer) {
  const pdf = filename.toLowerCase().endsWith(".pdf") || body.subarray(0, 5).toString() === "%PDF-";
  if (!pdf) return "";
  const raw = body.toString("latin1");
  const parts: string[] = [];
  for (const match of raw.matchAll(/\((?:\\.|[^\\)]){2,200}\)/g)) {
    const text = match[0].slice(1, -1).replace(/\\n/g, "\n").replace(/\\([()\\])/g, "$1");
    if (/[\p{L}\p{N}]/u.test(text)) parts.push(text);
    if (parts.join("").length > 20000) break;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 20000);
}
