import type { DB } from "@db/index.js";
import { noteOwner, presentNote } from "@core/modules/quick-notes/service.js";
import { noteText } from "@core/shared/quick-notes.js";
import { fail } from "@core/shared/errors.js";

export async function readQuickNote(db: DB, owner: string, id: string, offset = 0, limit = 6000) {
  const note = await presentNote(db, await noteOwner(db, owner, id));
  const text = noteText(note.content);
  return {
    id: note.id, version: note.version, createdAt: note.created_at,
    label: text.trim().slice(0, 60) || "图片或附件记录",
    text: text.slice(offset, offset + limit), offset, totalLength: text.length,
    nextOffset: offset + limit < text.length ? offset + limit : null,
    attachments: note.assets.map(a => ({id: a.id, filename: a.filename, mime: a.mime, size: a.size})),
  };
}
export async function checkQuickNoteIds(db: DB, owner: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) fail(400, "随手记不能重复选择");
  for (const id of ids) await noteOwner(db, owner, id);
}
export async function quickNoteContext(db: DB, owner: string, ids: string[]) {
  // Bound the first prompt, retaining all source identities and explicit continuation offsets.
  const limit = Math.max(1000, Math.min(6000, Math.floor(40000 / Math.max(1, ids.length))));
  return Promise.all(ids.map(id => readQuickNote(db, owner, id, 0, limit)));
}
