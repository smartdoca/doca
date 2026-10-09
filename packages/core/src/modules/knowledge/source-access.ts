import type { DB, Schema } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { activeActor, authorize } from "../access/queries.js";
import { authorizeFileFolder, authorizeFileItem } from "../access/file-access.js";
import { contentSubscriptionInventory } from "./content-subscriptions.js";
import { fail, AppError } from "../../shared/errors.js";

export async function maintainKnowledgeSource(db: DB, actor: Actor, libraryId: string, id: string) {
  await activeActor(db, actor);
  const access = await authorize(db, actor, libraryId, 4);
  if (access.resource.kind !== "library") fail(400, "A library is required");
  const row = await db.selectFrom("knowledge_subscriptions").selectAll().where("id", "=", id).where("library_id", "=", libraryId).executeTakeFirst();
  if (!row) fail(404, "Source not found");
  return row;
}
export async function sourceActor(db: DB, source: Schema["knowledge_subscriptions"]) {
  if (!source.creator_id) return null;
  const actor = await db.selectFrom("users").select(["id", "display_name", "admin"]).where("id", "=", source.creator_id).where("status", "=", "active").executeTakeFirst();
  if (!actor) return null;
  try { await authorize(db, actor, source.library_id, 4); return actor; }
  catch (error) { if (error instanceof AppError && [401, 403, 404].includes(error.status)) return null; throw error; }
}
export async function sourceAvailable(db: DB, actor: Actor, source: Schema["knowledge_subscriptions"]) {
  if (source.status === "detached") return false;
  try {
    if (source.source_kind === "content") { await contentSubscriptionInventory(db, actor, source); return true; }
    if (source.source_kind === "url") { const url = new URL(source.url); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
    if (source.source_kind === "document" || source.source_kind === "library") { await authorize(db, actor, source.source_id, 1); return true; }
    if (source.source_kind === "file") { await authorizeFileItem(db, actor, source.source_id); return true; }
    if (source.source_kind === "folder") { await authorizeFileFolder(db, actor, source.source_id); return true; }
  } catch (error) { if (source.source_kind === "content" || (error instanceof AppError && [403, 404].includes(error.status))) return false; throw error; }
  return false;
}
export async function knowledgeSourceLinkVisible(db: DB, actor: Actor, source: Schema["knowledge_subscriptions"], _managing = false) {
  return sourceAvailable(db, actor, source);
}
export async function detachKnowledgeSource(db: DB, actor: Actor, libraryId: string, id: string) {
  await maintainKnowledgeSource(db, actor, libraryId, id);
  await db.updateTable("knowledge_subscriptions").set({ status: "detached" }).where("id", "=", id).execute();
  return { ok: true };
}
