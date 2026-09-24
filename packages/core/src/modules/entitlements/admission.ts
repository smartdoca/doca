import type { DB, Resource } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { entitlements, requireCapability, checkStorage } from "./service.js";

export async function checkPublication(
  db: DB,
  actorId: string,
  ownerId: string,
  visibility: string,
) {
  const cap =
    visibility === "public"
      ? "sharing.public"
      : visibility === "authenticated"
        ? "sharing.site"
        : null;
  if (cap) {
    await requireCapability(db, actorId, cap);
    if (ownerId !== actorId) await requireCapability(db, ownerId, cap);
  }
}
/** Pending invitations reserve a seat; accepting the same seat never charges twice. */
export async function checkMemberAdmission(db: DB, id: string, userId: string) {
  const r = await db
    .selectFrom("resources")
    .select("owner_id")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  if (r.owner_id === userId) return;
  const e = await entitlements(db, r.owner_id),
    limit = e.level.limits["sharing.members"];
  if (limit === null) return;
  const now = new Date().toISOString();
  const explicit = await db
    .selectFrom("grants")
    .select("user_id")
    .where("resource_id", "=", id)
    .where("status", "=", "active")
    .execute();
  const invitations = await db
    .selectFrom("access_invitations")
    .select("user_id")
    .where("resource_id", "=", id)
    .where("state", "=", "pending")
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]),
    )
    .execute();
  const users = new Set(
    [...explicit, ...invitations].map((x) => x.user_id),
  );
  users.delete(r.owner_id);
  if (!users.has(userId) && users.size >= limit)
    fail(409, "已达到此文档的协作者数量上限");
}
/** Transfer is ownership admission, not another creation event. */
export async function checkTransfer(db: DB, r: Resource, userId: string) {
  const e = await entitlements(db, userId),
    key = r.kind === "library" ? "libraries.total" : "documents.total",
    limit = e.level.limits[key];
  const total = await db
    .selectFrom("resources")
    .select(db.fn.countAll<number>().as("n"))
    .where("owner_id", "=", userId)
    .where("kind", "=", r.kind)
    .executeTakeFirstOrThrow();
  if (limit !== null && Number(total.n) + 1 > limit)
    fail(409, "接收人的持有数量额度不足");
  if (
    r.kind === "document" &&
    e.level.limits["document.bytes"] !== null &&
    Number(r.content_bytes ?? 0) > e.level.limits["document.bytes"]!
  )
    fail(413, "文档超过接收人的大小上限");
  const assets = await db
    .selectFrom("assets")
    .select(db.fn.sum<number>("size").as("n"))
    .where("resource_id", "=", r.id)
    .where("deleted_at", "is", null)
    .where("owner_id", "!=", userId)
    .executeTakeFirst();
  await checkStorage(
    db,
    userId,
    Number(r.content_bytes ?? 0) + Number(assets?.n ?? 0),
    e,
  );
  await checkPublication(db, userId, userId, r.visibility);
}
