import { pluginNotificationVisible } from "./plugin-notifications.js";
import { managementVisible } from "../access/presentation.js";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import type { DB, Resource } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { permission } from "../access/policy.js";
import { accessContext, accessibleQuery } from "../access/queries.js";
import { emitIntegrationEvent } from "../automation/events.js";
import { queueMobilePush } from "../mobile/push.js";
import { directoryIds } from "../discovery/directory.js";
import type { Actor } from "../identity/passwords.js";

export { directoryIds, type DirectoryMode } from "../discovery/directory.js";
export type CommentInline =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string; publicId?: string };
export type CommentBody = {
  version: 1;
  blocks: (
    | { type: "paragraph"; children: CommentInline[] }
    | { type: "image"; assetId: string; alt: string }
  )[];
};
function mentionedUser(v: any): string | undefined {
  if (v.type === "custom:user-mention" && typeof v.userId === "string")
    return v.userId;
  if (v.type === "mention" && typeof v.userId === "string") return v.userId;
  if (v.type === "link" && typeof v.url === "string")
    return /^#\/u\/([a-f0-9-]{36})$/i.exec(v.url)?.[1];
  if (typeof v.text === "string" && typeof v._mention?.userId === "string")
    return v._mention.userId;
}
export function mentionIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  function visit(v: any, depth = 0) {
    if (!v || typeof v !== "object" || depth > 45) return;
    const id = mentionedUser(v);
    if (id) ids.add(id);
    if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else
      for (const k of ["children", "blocks"]) if (v[k]) visit(v[k], depth + 1);
  }
  visit(value);
  return ids;
}
/** Match stable mention-node IDs so a second mention of the same person is a new event. */
export function documentMentions(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  function walk(v: any, path = "", depth = 0) {
    if (!v || typeof v !== "object" || depth > 45) return;
    const id = mentionedUser(v);
    if (id)
      result.set(
        v._mention?.id ?? (typeof v.id === "string" ? v.id : path),
        id,
      );
    if (Array.isArray(v))
      v.forEach((n, i) => walk(n, path + "/" + i, depth + 1));
    else if (v.children) walk(v.children, path + "/children", depth + 1);
  }
  walk(value);
  return result;
}
export async function visibleUsers(db: DB, actor: Actor, q: string) {
  const allowed = await directoryIds(db, actor);
  if (allowed && !allowed.size) return [];
  let query = db
    .selectFrom("users")
    .leftJoin("user_preferences", "user_preferences.user_id", "users.id")
    .select([
      "users.id",
      "users.display_name",
      "users.public_id",
      "user_preferences.avatar",
      "user_preferences.avatar_asset_id",
    ])
    .where("users.status", "=", "active");
  if (allowed) query = query.where("users.id", "in", [...allowed]);
  const text = q
    .trim()
    .toLowerCase()
    .replaceAll("!", "!!")
    .replaceAll("%", "!%")
    .replaceAll("_", "!_");
  if (text)
    query = query.where((eb) =>
      eb.or([
        sql<boolean>`lower(users.public_id) like ${text + "%"} escape '!'`,
        sql<boolean>`lower(users.display_name) like ${"%" + text + "%"} escape '!'`,
      ]),
    );
  const rows = await query
    .orderBy("users.display_name")
    .orderBy("users.id")
    .limit(20)
    .execute();
  return rows.map((u) => ({
    ...u,
    display_name: u.display_name?.trim() || u.public_id || u.id,
  }));
}
export async function validateNewMentions(
  db: DB,
  actor: Actor,
  next: Set<string>,
  old = new Set<string>(),
) {
  const added = [...next].filter((id) => !old.has(id));
  if (!added.length) return;
  if (added.length > 100) fail(400, "一次最多提及 100 位用户");
  const allowed = await directoryIds(db, actor);
  const users = await db
    .selectFrom("users")
    .select("id")
    .where("id", "in", added)
    .where("status", "=", "active")
    .execute();
  if (
    users.length !== added.length ||
    (allowed && added.some((id) => !allowed.has(id)))
  )
    fail(403, "包含当前不可选择的用户");
}
export async function normalizeComment(
  db: DB,
  actor: Actor,
  resourceId: string,
  input: unknown,
  fallback: string,
  old?: string | null,
) {
  const value: any = input ?? {
    version: 1,
    blocks: [
      { type: "paragraph", children: [{ type: "text", text: fallback }] },
    ],
  };
  if (
    value?.version !== 1 ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > 50
  )
    fail(400, "评论结构无效");
  let length = 0,
    images = 0;
  const body: CommentBody = { version: 1, blocks: [] };
  for (const block of value.blocks) {
    if (
      block?.type === "paragraph" &&
      Array.isArray(block.children) &&
      block.children.length <= 200
    ) {
      const children: CommentInline[] = [];
      for (const n of block.children) {
        if (n?.type === "text" && typeof n.text === "string") {
          length += n.text.length;
          children.push({ type: "text", text: n.text });
        } else if (n?.type === "mention" && typeof n.userId === "string") {
          const u = await db
            .selectFrom("users")
            .select(["display_name", "id", "public_id"])
            .where("id", "=", n.userId)
            .executeTakeFirst();
          if (!u) fail(400, "提及用户不存在");
          const label = u.display_name?.trim() || u.public_id || u.id;
          length += label.length;
          children.push({
            type: "mention",
            userId: u.id,
            label,
            publicId: u.public_id ?? u.id,
          });
        } else fail(400, "评论节点无效");
      }
      body.blocks.push({ type: "paragraph", children });
    } else if (block?.type === "image" && typeof block.assetId === "string") {
      if (++images > 9) fail(400, "每条评论最多 9 张图片");
      const asset = await db
        .selectFrom("assets")
        .selectAll()
        .where("id", "=", block.assetId)
        .where("resource_id", "=", resourceId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (
        !asset ||
        !asset.mime.startsWith("image/") ||
        !["comment_image", "attachment"].includes(asset.purpose)
      )
        fail(400, "评论图片无效");
      body.blocks.push({
        type: "image",
        assetId: asset.id,
        alt: asset.filename,
      });
    } else fail(400, "不支持的评论内容");
  }
  if (length > 5000 || JSON.stringify(body).length > 50000)
    fail(400, "评论内容过长");
  const text = body.blocks
    .map((b) =>
      b.type === "image"
        ? "[图片]"
        : b.children
            .map((n) => (n.type === "text" ? n.text : `@${n.label}`))
            .join(""),
    )
    .join("\n")
    .trim();
  if (!text) fail(400, "评论不能为空");
  let previous = new Set<string>();
  try {
    previous = mentionIds(JSON.parse(old ?? "null"));
  } catch {}
  const mentions = mentionIds(body);
  await validateNewMentions(db, actor, mentions, previous);
  return {
    body,
    text,
    mentions: [...mentions].filter((id) => !previous.has(id)),
  };
}
export async function notify(
  db: DB,
  actor: Actor,
  r: Resource,
  type: string,
  recipients: string[],
  commentId?: string,
  eventKey?: string,
) {
  const ids = [...new Set(recipients)].filter((id) => id !== actor.id);
  if (type === "resource.invited") return; // Ticket transitions deliver invitation notifications.
  if (!ids.length) return;
  const { resources, grants } = await accessContext(db, null, [r.id]);
  if (!resources.some((x) => x.id === r.id)) return;
  const invitees =
    type === "resource.invited"
      ? new Set(
          (
            await db
              .selectFrom("access_invitations")
              .select("user_id")
              .where("resource_id", "=", r.id)
              .where("state", "=", "pending")
              .execute()
          ).map((x) => x.user_id),
        )
      : new Set<string>();
  const users = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "in", ids)
    .where("status", "=", "active")
    .execute();
  for (const u of users)
    if (permission(r, u, resources, grants) >= 1 || invitees.has(u.id)) {
      const notificationId = randomUUID();
      const inserted = await db
        .insertInto("notifications")
        .values({
          id: notificationId,
          user_id: u.id,
          actor_id: actor.id,
          resource_id: r.id,
          comment_id: commentId ?? null,
          type,
          read_at: null,
          created_at: new Date().toISOString(),
          dedupe_key: eventKey ? `${eventKey}:${type}:${u.id}` : null,
        })
        .onConflict((oc) => oc.column("dedupe_key").doNothing())
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows) {
        const path =
          type === "resource.invited"
            ? "#/todos"
            : `#/r/${r.id}${commentId ? `?comment=${commentId}` : ""}`;
        await emitIntegrationEvent(db, "notification.created", {
          notificationId,
          userId: u.id,
          actorId: actor.id,
          resourceId: r.id,
          type,
          path,
        });
        if (type === "comment.created" || type === "comment.mentioned")
          queueMobilePush({
            userId: u.id,
            title: type === "comment.mentioned" ? "有人在评论中提到你" : "新评论",
            body: r.title,
            path,
          });
      }
    }
}
export async function notificationPage(db: DB, actor: Actor, offset: number) {
  const canRead = accessibleQuery(sql.ref("notifications.resource_id"), actor);
  const base = db
    .selectFrom("notifications")
    .where("notifications.user_id", "=", actor.id)
    .where(
      sql<boolean>`(notifications.ticket_id is not null or notifications.type <> 'access.requested' or exists(select 1 from access_requests q join resources r on r.id=q.resource_id where q.resource_id=notifications.resource_id and q.status='pending' and notifications.dedupe_key = q.id || ':' || ${actor.id} and (q.role <> 'manager' or r.owner_id=${actor.id})))`,
    ).where(sql<boolean>`(${canRead}
      or notifications.type = 'plugin.notification'
      or exists(select 1 from tickets t where t.id=notifications.ticket_id and (t.user_id=${actor.id} or t.initiator_id=${actor.id}))
      or (notifications.type = 'resource.invited' and exists(select 1 from access_invitations i join resources r on r.id = i.resource_id where i.resource_id = notifications.resource_id and i.user_id = ${actor.id} and i.state = 'pending' and r.deleted_at is null))
      or (notifications.type in ('access.approved', 'access.rejected') and exists(select 1 from access_requests q where q.resource_id = notifications.resource_id and q.user_id = ${actor.id})))`);
  const items = await base
    .leftJoin("users", "users.id", "notifications.actor_id")
    .leftJoin("resources", "resources.id", "notifications.resource_id")
    .selectAll("notifications")
    .select(canRead.as("canRead"))
    .select(["users.display_name as actorName", "resources.title as title"])
    .orderBy("notifications.created_at", "desc")
    .orderBy("notifications.id")
    .offset(offset)
    .limit(51)
    .execute();
  const count = await base
    .select((eb) => eb.fn.countAll().as("count"))
    .where("read_at", "is", null)
    .where("notifications.type", "!=", "plugin.notification")
    .executeTakeFirstOrThrow();
  const ctx = await accessContext(
    db,
    actor,
    items.map((n) => n.resource_id),
  );
  const projected = [];
  const pluginRows = await db.selectFrom("plugin_notifications as p").innerJoin("notifications as n", "n.id", "p.notification_id").selectAll("p").select(["n.read_at", "n.id"]).where("n.user_id", "=", actor.id).where("p.withdrawn_at", "is", null).execute();
  const visiblePluginRows = new Map<string, typeof pluginRows[number]>();
  // Permissions are live, including when calculating unread counts. Fail closed.
  for (let start = 0; start < pluginRows.length; start += 50) {
    await Promise.all(pluginRows.slice(start, start + 50).map(async row => {
      if (await pluginNotificationVisible(db, actor.id, row)) visiblePluginRows.set(row.id, row);
    }));
  }
  for (const { canRead, ...n } of items.slice(0, 50)) {
    if (n.type === "plugin.notification") {
      const detail = visiblePluginRows.get(n.id);
      if (detail) projected.push({ ...n, title: detail.title, description: detail.body, pluginId: detail.plugin_id, href: `/api/v1/notifications/${n.id}/open` });
      continue;
    }
    const r = ctx.resources.find((r) => r.id === n.resource_id);
    let grantedPermission: { role?: string; includeDescendants?: boolean } | undefined;
    let show =
      r && (await managementVisible(db, actor, r, ctx.resources, ctx.grants));
    if (n.ticket_id) {
      const ticket = await db
        .selectFrom("tickets")
        .select(["user_id", "hidden_for_user_id", "kind", "operation_json"])
        .where("id", "=", n.ticket_id)
        .executeTakeFirst();
      if (ticket && ["access.approved", "invitation.accepted"].includes(n.type)) {
        const operation = JSON.parse(ticket.operation_json ?? "{}");
        grantedPermission = { role: operation.role, includeDescendants: operation.includeDescendants };
      }
      if (ticket)
        show =
          actor.id !== ticket.user_id ||
          (ticket.hidden_for_user_id !== actor.id &&
            (await distributionPolicy(db,r?.kind)).ticketReviewers[ticket.kind]);
    }
    const sensitive =
      n.type.startsWith("access.") ||
      n.type.startsWith("invitation.") ||
      n.type.startsWith("resource.");
    projected.push({
      ...n,
      grantedPermission,
      ...(!show && (sensitive || n.ticket_id)
        ? { actor_id: null, actorName: null }
        : {}),
      title:
        n.ticket_id && !canRead
          ? "工单"
          : n.type.startsWith("access.") && !canRead
            ? "权限申请"
            : n.title,
    });
  }
  return {
    items: projected,
    unread: Number(count.count) + [...visiblePluginRows.values()].filter(row => !row.read_at).length,
    nextOffset: items.length > 50 ? offset + 50 : null,
  };
}
import { distributionPolicy } from "../deployment/policies.js";
