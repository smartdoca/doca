import { blockedContentDocuments } from "./content-access.js";
import { exportMarkdown } from "@smartdoca/slate/conversion";
import { createHash } from "node:crypto";
import type { DB } from "@db/index.js";
import { restoreDocument } from "../collaboration/documents.js";

export type PublishedDocument = {
  id: string;
  title: string;
  markdown: string;
  seq: number;
  version: number;
};
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function documentRows(db: DB, libraryId: string) {
  const rows = await db
    .selectFrom("resources as r")
    .innerJoin("document_states as d", "d.resource_id", "r.id")
    .select(["r.id", "r.title", "r.format", "r.version", "d.seq", "d.text"])
    .where("r.library_id", "=", libraryId)
    .where("r.deleted_at", "is", null)
    .where("r.kind", "=", "document")
    .orderBy("r.id")
    .execute();
  const directories = new Set(
    (
      await db
        .selectFrom("knowledge_directories")
        .select("resource_id")
        .where("library_id", "=", libraryId)
        .execute()
    ).map((x) => x.resource_id),
  );
  const blocked = await blockedContentDocuments(db, rows.map(row => ({id:row.id,library_id:libraryId})));
  return rows.filter(
    (row) => !blocked.has(row.id) && (!directories.has(row.id) || row.text.trim().length > 100),
  );
}
/** Cheap revision check; canonical editor state is exported only when it changes. */
export async function knowledgeDocumentFingerprint(db: DB, libraryId: string) {
  return fingerprint(
    (await documentRows(db, libraryId)).map(({ id, title, seq, version }) => ({
      id,
      title,
      seq,
      version,
    })),
  );
}
export async function knowledgeDocumentSnapshot(
  db: DB,
  libraryId: string,
): Promise<PublishedDocument[]> {
  const documents: PublishedDocument[] = [];
  for (const row of await documentRows(db, libraryId)) {
    let markdown = row.text;
    if (row.format === "rich_text") {
      const restored = await restoreDocument(db, row.id);
      try {
        markdown = await (
          await exportMarkdown(restored.runtime.getValue())
        ).blob.text();
      } finally {
        restored.destroy();
      }
    }
    documents.push({
      id: row.id,
      title: row.title,
      markdown,
      seq: row.seq,
      version: row.version,
    });
  }
  return documents;
}
