import { projectExlsxPlainText, projectExlsxWorkbook } from "@online-office/univer-sheet/model";
import { readDocument } from "@eppt/editor/core";
import { CanvasModel } from "aidcanvas/model";
import type { DB } from "../../../../db/src/index.js";
import * as Y from "yjs";
import { restoreDocument } from "../collaboration/documents.js";
import { restoreSurface } from "./codecs/surfaces.js";

export type ContentStats = { words: number; images: number; attachments: number };

const TEXT_KEYS = new Set([
  "text",
  "caption",
  "code",
  "source",
  "value",
  "content",
  "topic",
  "label",
  "v",
  "markdown",
  "plainText",
]);
const IMAGE_TYPES = new Set(["image", "image-asset", "inline-image", "floating-image"]);
const FILE_TYPES = new Set(["attachment", "file", "inline-attachment"]);
const empty = (): ContentStats => ({ words: 0, images: 0, attachments: 0 });

/** Visible characters. A Chinese character and a Latin letter each count as one 字. */
export function characterCount(text: string) {
  return [...text.replace(/\s/g, "")].length;
}

function markdownImages(text: string) {
  return [...text.matchAll(/!\[[^\]]*\]\([^)\s]+\)/g)].length;
}

function markdownAttachments(text: string) {
  let count = 0;
  for (const match of text.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|mp3|wav)(?:$|[?#])/i.test(`${match[1]} ${match[2]}`))
      count++;
  }
  return count;
}

/** Count document text, images and file attachments from an editor projection. */
export function countContentStats(value: unknown): ContentStats {
  const stats = empty();
  const seen = new Set<object>();
  const visit = (node: unknown, key?: string) => {
    if (typeof node === "string") {
      if (key && TEXT_KEYS.has(key)) stats.words += characterCount(node);
      if (key === "text" || key === "markdown" || key === "content") stats.images += markdownImages(node);
      return;
    }
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child));
      return;
    }
    const record = node as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : typeof record.kind === "string" ? record.kind : "";
    if (IMAGE_TYPES.has(type)) stats.images++;
    else if (FILE_TYPES.has(type)) stats.attachments++;
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(value);
  return stats;
}

function countMedia(value: unknown) {
  const { images, attachments } = countContentStats(value);
  return { images, attachments };
}

export async function documentContentStats(
  db: DB,
  documentId: string,
  format: string,
): Promise<ContentStats> {
  try {
    if (format === "markdown") {
      const state = await db
        .selectFrom("document_states")
        .select("text")
        .where("resource_id", "=", documentId)
        .executeTakeFirst();
      const text = state?.text ?? "";
      return {
        words: characterCount(text.replace(/!\[[^\]]*\]\([^)\s]+\)/g, "")),
        images: markdownImages(text),
        attachments: markdownAttachments(text),
      };
    }
    if (format === "rich_text") {
      const loaded = await restoreDocument(db, documentId);
      try {
        if (!loaded.state) return empty();
        return countContentStats(loaded.runtime.getValue());
      } finally {
        loaded.destroy();
      }
    }
    if (!["spreadsheet", "canvas", "presentation"].includes(format)) return empty();
    const loaded = await restoreSurface(db, documentId, format);
    if (format === "canvas") {
      const model = CanvasModel.restore({
        codec: "aidcanvas-yjs",
        schemaVersion: 1,
        epochId: loaded.epochId,
        update: loaded.update,
      });
      try {
        return countContentStats(model.getValue());
      } finally {
        model.dispose();
      }
    }
    if (format === "presentation") {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.update);
      try {
        return countContentStats(readDocument(doc));
      } finally {
        doc.destroy();
      }
    }
    if (!loaded.baseline) return empty();
    const bundle = {
      baseline: loaded.baseline,
      update: loaded.update,
      checkpointSeq: loaded.state.checkpoint_seq,
    };
    const [text, workbook] = await Promise.all([
      projectExlsxPlainText(bundle),
      projectExlsxWorkbook(bundle),
    ]);
    return { words: characterCount(text), ...countMedia(workbook) };
  } catch {
    return empty();
  }
}
