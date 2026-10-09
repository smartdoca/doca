import type { DB, Schema } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { fail } from "../../shared/errors.js";

/** Storage tombstones only: retired bindings are rejected, never converted or released. */
export function isRetiredKnowledgeSessionFile(metadata: string) {
  return Object.hasOwn(JSON.parse(metadata), "knowledgeSessionFolder");
}
export function readKnowledgeSessionFolder(metadata: string): { kind: string; scopeId: string; conversationId: string } | null {
  if (isRetiredKnowledgeSessionFile(metadata)) fail(404, "fileManager.sessionFolderMissing");
  return null;
}
export function knowledgeFolderKind(id: string) {
  if (id.startsWith("knowledge-assistant:") || id.startsWith("knowledge-session:")) fail(404, "fileManager.sessionFolderMissing");
  return null;
}
export const knowledgeAssistantFolderId = (id: string) => `knowledge-assistant:${id}`;
export async function authorizeKnowledgeFile(_db: DB, _actor: Actor, file: Pick<Schema["file_items"], "parent_type" | "parent_id" | "metadata">): Promise<{ id: string; archived: number } | null> {
  if (isRetiredKnowledgeSessionFile(file.metadata)) fail(404, "fileManager.sessionFolderMissing");
  return null;
}
export async function authorizeKnowledgeAsset(db: DB, actor: Actor, assetId: string) {
  const rows = await db.selectFrom("file_items").select(["parent_type", "parent_id", "metadata"]).where("storage_object_id", "=", assetId).where("deleted_at", "is", null).execute();
  for (const row of rows) await authorizeKnowledgeFile(db, actor, row);
}
export async function requireKnowledgeFolder(_db: DB, _actor: Actor, _id: string): Promise<{ id: string; parent_id: string; name: string; type: "system"; virtual: boolean; locked: boolean; version: number; updated_at: string }> { fail(404, "fileManager.sessionFolderMissing"); }
export async function knowledgeFolderLocation(_db: DB, _actor: Actor, _id: string): Promise<{ parentType: "system"; parentId: string; parent_id: string; name: string; folderName: string; navigation: Array<{ type: "system"; id: string; name: string }>; href: string; path: string; location: string; inMyFilesRoot: boolean; writable: boolean; copyOnly: boolean }> { fail(404, "fileManager.sessionFolderMissing"); }
export async function knowledgeFileLocation(db: DB, actor: Actor, file: Pick<Schema["file_items"], "parent_type" | "parent_id" | "metadata">) { await authorizeKnowledgeFile(db, actor, file); return null as Awaited<ReturnType<typeof knowledgeFolderLocation>> | null; }
export async function projectKnowledgeSessionFiles<T extends { metadata: string }>(_db: DB, _actor: Actor, _files: T[], _folderId: string): Promise<{ files: T[]; folders: Awaited<ReturnType<typeof requireKnowledgeFolder>>[] }> { fail(404, "fileManager.sessionFolderMissing"); }
