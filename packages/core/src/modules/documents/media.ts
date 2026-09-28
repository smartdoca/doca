import type { Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import { enqueueProjection } from "../automation/jobs.js";
import { enqueueKnowledge } from "../knowledge/service.js";

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function collectUuids(value: string, ids: Set<string>) {
  for (const match of value.matchAll(uuidPattern)) ids.add(match[0].toLowerCase());
}

export function textMediaIds(value: string) {
  const ids = new Set<string>();
  collectUuids(value, ids);
  return ids;
}

export function documentMediaIds(value: unknown) {
  const ids = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of ["path", "assetId", "src", "url", "resourcePath"]) {
      if (typeof record[key] === "string") collectUuids(record[key], ids);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return ids;
}

/** Explicit file attachments stay linked to the document. Inline images return their asset id. */
export function inlineAssetId(metadata: string, storageObjectId: string) {
  try {
    const parsed = JSON.parse(metadata) as { assetId?: unknown; copiedFrom?: unknown };
    if (typeof parsed.copiedFrom === "string" && parsed.copiedFrom) return null;
    if (typeof parsed.assetId === "string" && parsed.assetId) return parsed.assetId.toLowerCase();
  } catch {
    /* metadata is not JSON */
  }
  return storageObjectId.toLowerCase();
}

export async function detachUnreferencedDocumentFiles(
  db: DB | Transaction<Schema>,
  documentId: string,
  referenced: Set<string>,
) {
  const rows = await db
    .selectFrom("file_items")
    .select(["id", "storage_object_id", "metadata", "created_at"])
    .where("parent_type", "=", "document")
    .where("parent_id", "=", documentId)
    .where("deleted_at", "is", null)
    .execute();
  const now = new Date().toISOString();
  for (const row of rows) {
    const asset = inlineAssetId(row.metadata, row.storage_object_id);
    if (!asset || referenced.has(asset)) continue;
    if (Date.now() - Date.parse(row.created_at) < 120000) continue;
    await db.updateTable("file_items").set({ deleted_at: now }).where("id", "=", row.id).where("deleted_at", "is", null).execute();
    await enqueueProjection(db, "search-file", row.id, { fileId: row.id });
    await enqueueKnowledge(db, "file", row.id);
  }
}
