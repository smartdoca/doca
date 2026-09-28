import {
  knowledgeDocumentSnapshot,
  knowledgeDocumentFingerprint,
  fingerprint,
  type PublishedDocument,
} from "./document-snapshot.js";
export {
  knowledgeDocumentSnapshot,
  fingerprint,
  type PublishedDocument,
} from "./document-snapshot.js";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import {
  maintainKnowledge,
  knowledgeSettingsSchema,
  sanitizeKnowledge,
  effectiveKnowledgeSettings,
} from "./system.js";
import { fail } from "../../shared/errors.js";

export type KnowledgeChunk = {
  id: string;
  documentId: string;
  title: string;
  text: string;
  heading: string;
  version: number;
};
export type AnswerIndex = {
  mode?(): Promise<"keyword" | "hybrid">;
  prepare(chunks: KnowledgeChunk[]): Promise<void>;
  search(
    ids: string[],
    query: string,
  ): Promise<{ id: string; score: number }[] | null>;
};

/** Lossless text windows: long paragraphs must not silently lose their tail. */
export function answerChunks(documents: PublishedDocument[]): KnowledgeChunk[] {
  return documents.flatMap((doc) => {
    const sections = doc.markdown.split(/\n(?=#{1,6} )/);
    let ordinal = 0;
    return sections.flatMap((section) => {
      const heading = /^#{1,6}\s+(.+)/.exec(section)?.[1] ?? doc.title;
      const chunks: KnowledgeChunk[] = [];
      for (let start = 0; start < section.length; start += 1800) {
        const text = section.slice(start, start + 2200);
        chunks.push({
          id: `qa_${fingerprint([doc.id, doc.seq, doc.version, ordinal++, text]).slice(0, 40)}`,
          documentId: doc.id,
          title: doc.title,
          heading,
          text,
          version: doc.version,
        });
      }
      return chunks;
    });
  });
}
export async function publishKnowledgeDocuments(
  db: DB,
  actor: Actor,
  libraryId: string,
  index?: AnswerIndex,
) {
  await maintainKnowledge(db, actor, libraryId);
  const hash = await knowledgeDocumentFingerprint(db, libraryId);
  const previous = await db
    .selectFrom("knowledge_publications")
    .selectAll()
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (previous?.fingerprint === hash && previous.status === "ready")
    return previous;
  try {
    const documents = await knowledgeDocumentSnapshot(db, libraryId);
    await index?.prepare(answerChunks(documents));
    await maintainKnowledge(db, actor, libraryId);
    if ((await knowledgeDocumentFingerprint(db, libraryId)) !== hash)
      fail(409, "文档仍在编辑，将在下一次同步更新问答");
    const values = {
      revision: (previous?.revision ?? 0) + 1,
      fingerprint: hash,
      documents: JSON.stringify(documents),
      status: "ready",
      error: "",
      updated_at: new Date().toISOString(),
    };
    if (previous) {
      const saved = await db
        .updateTable("knowledge_publications")
        .set(values)
        .where("library_id", "=", libraryId)
        .where("revision", "=", previous.revision)
        .executeTakeFirst();
      if (!Number(saved.numUpdatedRows)) fail(409, "发布版本已变化，请重试");
    } else
      await db
        .insertInto("knowledge_publications")
        .values({ library_id: libraryId, ...values })
        .execute();
    return { library_id: libraryId, ...values };
  } catch (error) {
    if (previous)
      await db
        .updateTable("knowledge_publications")
        .set({
          status: "failed",
          error: String((error as Error).message).slice(0, 300),
        })
        .where("library_id", "=", libraryId)
        .where("revision", "=", previous.revision)
        .execute();
    else
      await db
        .insertInto("knowledge_publications")
        .values({
          library_id: libraryId,
          revision: 0,
          fingerprint: "",
          documents: "[]",
          status: "failed",
          error: String((error as Error).message).slice(0, 300),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column("library_id").doNothing())
        .execute();
    throw error;
  }
}
export async function publicationStatus(db: DB, libraryId: string) {
  const current = await db
    .selectFrom("knowledge_publications")
    .selectAll()
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  return {
    revision: current?.revision ?? 0,
    status: current?.status ?? "pending",
    error: current?.error ?? "",
    updatedAt: current?.updated_at,
    dirty:
      current?.fingerprint !==
      (await knowledgeDocumentFingerprint(db, libraryId)),
  };
}
export async function publishedChunks(db: DB, libraryIds: string[]) {
  const chunks: (KnowledgeChunk & {
    libraryId: string;
    publication: number;
  })[] = [];
  for (const libraryId of libraryIds) {
    const lib = await db
      .selectFrom("resources")
      .select("id")
      .where("id", "=", libraryId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!lib) continue;
    const publication = await db
      .selectFrom("knowledge_publications")
      .selectAll()
      .where("library_id", "=", libraryId)
      .executeTakeFirst();
    if (!publication) continue;
    const row = await db
      .selectFrom("knowledge_settings")
      .select("config")
      .where("library_id", "=", libraryId)
      .executeTakeFirst();
    const config = knowledgeSettingsSchema.parse(
      row ? JSON.parse(row.config) : {},
    );
    const settings = effectiveKnowledgeSettings(
      config,
      Object.keys(config.sourcePolicies),
    );
    const liveIds = new Set(
      (
        await db
          .selectFrom("resources")
          .select("id")
          .where("library_id", "=", libraryId)
          .where("deleted_at", "is", null)
          .execute()
      ).map((x) => x.id),
    );
    const docs = (
      JSON.parse(publication.documents) as PublishedDocument[]
    ).filter((x) => liveIds.has(x.id));
    // Apply current masking before indexing results enter the model, even for old releases.
    for (const chunk of answerChunks(docs))
      chunks.push({
        ...chunk,
        heading: sanitizeKnowledge(chunk.heading, settings),
        title: sanitizeKnowledge(chunk.title, settings),
        text: sanitizeKnowledge(chunk.text, settings),
        libraryId,
        publication: publication.revision,
      });
  }
  return chunks;
}
