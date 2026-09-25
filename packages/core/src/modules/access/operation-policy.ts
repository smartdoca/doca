import type { DB, Resource } from "../../../../db/src/index.js";
import { checkOperation } from "../../shared/plugin-services.js";
import { fail } from "../../shared/errors.js";

/** Business admission is extensible; it never replaces resource authorization. */
export async function requireCapability(db: DB, userId: string, action: string) {
  const user = await db.selectFrom("users").select("status").where("id", "=", userId).executeTakeFirst();
  if (user?.status !== "active") fail(401, "登录已失效");
  await checkOperation(db, userId, action);
}
export async function checkCreation(db: DB, userId: string, kind: string, format: string, count = 1) {
  await requireCapability(db, userId, kind === "library" ? "libraries.create" : "documents.create");
  await checkOperation(db, userId, "resources.create", { kind, format, count });
}
export async function checkStorage(db: DB, userId: string, additional: number) {
  await checkOperation(db, userId, "storage.allocate", { additional });
}
export async function checkDocumentSize(db: DB, id: string, next: number) {
  const resource = await db.selectFrom("resources").select(["owner_id", "content_bytes"]).where("id", "=", id).executeTakeFirstOrThrow();
  await checkOperation(db, resource.owner_id, "documents.resize", { id, previous: Number(resource.content_bytes ?? 0), next });
  await db.updateTable("resources").set({ content_bytes: next }).where("id", "=", id).execute();
}
export async function checkPublication(db: DB, actorId: string, ownerId: string, visibility: string) {
  await checkOperation(db, actorId, "resources.publish", { ownerId, visibility });
}
export async function checkMemberAdmission(db: DB, id: string, userId: string) {
  const resource = await db.selectFrom("resources").select("owner_id").where("id", "=", id).executeTakeFirstOrThrow();
  await checkOperation(db, resource.owner_id, "resources.invite", { id, userId });
}
export async function checkTransfer(db: DB, resource: Resource, userId: string) {
  await requireCapability(db, userId, "resources.receive");
  await checkOperation(db, userId, "resources.transfer", { id: resource.id, kind: resource.kind, previousOwnerId: resource.owner_id, contentBytes: Number(resource.content_bytes ?? 0) });
}
