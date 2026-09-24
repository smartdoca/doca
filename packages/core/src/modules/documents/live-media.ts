import { projectExlsxWorkbook } from "@online-office/univer-sheet/model";
import { readDocument } from "@eppt/editor/core";
import { CanvasModel } from "aidcanvas/model";
import type { Transaction } from "kysely";
import * as Y from "yjs";
import type { DB, Schema } from "../../../../db/src/index.js";
import { restoreDocument } from "../collaboration/documents.js";
import { documentMediaIds, inlineAssetId, textMediaIds, detachUnreferencedDocumentFiles } from "./media.js";
import { restoreSurface } from "./codecs/surfaces.js";

type MediaState = { ids: Set<string> | null; updatedAt: string };

export async function referencedDocumentMedia(
  db: DB | Transaction<Schema>,
  documentId: string,
): Promise<MediaState> {
  const resource = await db
    .selectFrom("resources")
    .select(["format", "updated_at", "deleted_at"])
    .where("id", "=", documentId)
    .executeTakeFirst();
  if (!resource || resource.deleted_at) return { ids: new Set(), updatedAt: "" };
  try {
    if (resource.format === "markdown") {
      const state = await db.selectFrom("document_states").select("text").where("resource_id", "=", documentId).executeTakeFirst();
      return { ids: textMediaIds(state?.text ?? ""), updatedAt: resource.updated_at };
    }
    if (resource.format === "rich_text") {
      const loaded = await restoreDocument(db, documentId);
      try {
        return { ids: documentMediaIds(loaded.runtime.getValue()), updatedAt: resource.updated_at };
      } finally {
        loaded.destroy();
      }
    }
    if (!["spreadsheet", "canvas", "presentation"].includes(resource.format))
      return { ids: null, updatedAt: resource.updated_at };
    const loaded = await restoreSurface(db, documentId, resource.format);
    if (resource.format === "canvas") {
      const model = CanvasModel.restore({
        codec: "aidcanvas-yjs",
        schemaVersion: 1,
        epochId: loaded.epochId,
        update: loaded.update,
      });
      try {
        return { ids: textMediaIds(JSON.stringify(model.getValue())), updatedAt: resource.updated_at };
      } finally {
        model.dispose();
      }
    }
    if (resource.format === "presentation") {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.update);
      try {
        return { ids: textMediaIds(JSON.stringify(readDocument(doc))), updatedAt: resource.updated_at };
      } finally {
        doc.destroy();
      }
    }
    if (!loaded.baseline) return { ids: null, updatedAt: resource.updated_at };
    const workbook = await projectExlsxWorkbook({
      baseline: loaded.baseline,
      update: loaded.update,
      checkpointSeq: loaded.state.checkpoint_seq,
    });
    return { ids: textMediaIds(JSON.stringify(workbook)), updatedAt: resource.updated_at };
  } catch {
    return { ids: null, updatedAt: resource.updated_at };
  }
}

export async function releaseDocumentFileIfUnused(
  db: DB | Transaction<Schema>,
  fileId: string,
  cache: Map<string, Promise<MediaState>>,
) {
  try {
    const row = await db
      .selectFrom("file_items")
      .select(["id", "parent_type", "parent_id", "storage_object_id", "metadata", "created_at", "deleted_at"])
      .where("id", "=", fileId)
      .executeTakeFirst();
    if (!row || row.parent_type !== "document") return true;
    if (row.deleted_at) return false;
    if (!inlineAssetId(row.metadata, row.storage_object_id)) return true;
    let pending = cache.get(row.parent_id);
    if (!pending) {
      pending = referencedDocumentMedia(db, row.parent_id);
      cache.set(row.parent_id, pending);
    }
    const media = await pending;
    if (media.ids === null) return true;
    if (Date.now() - Date.parse(row.created_at) < 120000) return true;
    if (row.created_at > media.updatedAt) return true;
    const asset = inlineAssetId(row.metadata, row.storage_object_id);
    if (asset && media.ids.has(asset)) return true;
    await detachUnreferencedDocumentFiles(db, row.parent_id, media.ids);
    const current = await db.selectFrom("file_items").select("deleted_at").where("id", "=", fileId).executeTakeFirst();
    return !current?.deleted_at;
  } catch {
    return true;
  }
}
