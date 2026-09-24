import { distributionPolicy } from "../deployment/policies.js";
import { randomUUID } from "node:crypto";
import type { DB, Schema } from "../../../../db/src/index.js";
import { accessContext } from "../access/queries.js";
import { managers } from "../access/presentation.js";
import { isResourceOwnerLike } from "../access/policy.js";
import { emitIntegrationEvent } from "../automation/events.js";
import { queueMobilePush } from "../mobile/push.js";
export type Ticket = Schema["tickets"];
export async function processors(db: DB, t: Ticket) {
  if (t.kind === "invitation") return [t.user_id];
  const c = await accessContext(db, null, [t.resource_id!]);
  const r = c.resources.find((r) => r.id === t.resource_id);
  if (
    !r ||
    r.deleted_at ||
    c.resources.find((x) => x.id === r.library_id)?.deleted_at
  )
    return [];
  return (await managers(db, r, c.resources, c.grants))
    .filter((u) => t.role !== "manager" || isResourceOwnerLike(r, u, c.resources))
    .map((u) => u.id);
}
export async function ticketNotice(
  db: DB,
  t: Ticket,
  actorId: string | null,
  recipients: string[],
  type = "ticket.updated",
) {
  for (const userId of new Set(recipients)) {
    if (userId === actorId) continue;
    const id = randomUUID();
    await db
      .insertInto("notifications")
      .values({
        id,
        user_id: userId,
        actor_id: actorId,
        resource_id: t.resource_id,
        ticket_id: t.id,
        type,
        read_at: null,
        created_at: new Date().toISOString(),
      })
      .execute();
    await emitIntegrationEvent(db, "notification.created", {
      notificationId: id,
      userId,
      resourceId: t.resource_id,
      ticketId: t.id,
      path: `#/tickets/${t.id}`,
    });
    if (type === "access.requested" || type === "access.approved" || type === "access.rejected")
      queueMobilePush({
        userId,
        title: type === "access.requested" ? "新的访问申请" : "访问申请已更新",
        body: type === "access.requested" ? "有人申请访问你的文档" : "你的访问申请有了结果",
        path: `#/tickets/${t.id}`,
      });
  }
  await emitIntegrationEvent(db, "ticket.changed", {
    ticketId: t.id,
    resourceId: t.resource_id,
  });
}
export async function syncTicket(
  db: DB,
  input: Pick<
    Ticket,
    | "kind"
    | "source_key"
    | "resource_id"
    | "user_id"
    | "initiator_id"
    | "status"
  > &
    Partial<Ticket>,
  actorId: string | null,
  message = "",
) {
  const old = await db
    .selectFrom("tickets")
    .selectAll()
    .where("kind", "=", input.kind)
    .where("source_key", "=", input.source_key)
    .executeTakeFirst();
  const now = new Date().toISOString();
  const resourceKind = input.resource_id
    ? (
        await db
          .selectFrom("resources")
          .select("kind")
          .where("id", "=", input.resource_id)
          .executeTakeFirst()
      )?.kind
    : undefined;
  const hidden_for_user_id = old
    ? old.hidden_for_user_id
    : (await distributionPolicy(db, resourceKind)).ticketReviewers[input.kind]
      ? null
      : input.user_id;
  const t: Ticket = {
    hidden_for_user_id,
    resource_kind: resourceKind ?? "document",
    id: old?.id ?? input.id ?? randomUUID(),
    role: null,
    message: "",
    created_at: now,
    expires_at: null,
    reminded_at: null,
    ...old,
    ...input,
    updated_at:
      input.updated_at ?? (old?.status === input.status ? old.updated_at : now),
  };
  const changed = !old || old.status !== t.status;
  await db
    .insertInto("tickets")
    .values(t)
    .onConflict((o) => o.columns(["kind", "source_key"]).doUpdateSet(t))
    .execute();
  const assigned = await processors(db, t);
  if (changed) {
    if (old)
      await db
        .updateTable("notifications")
        .set({ read_at: now })
        .where("ticket_id", "=", t.id)
        .where("read_at", "is", null)
        .execute();
    await db
      .insertInto("ticket_events")
      .values({
        id: randomUUID(),
        ticket_id: t.id,
        actor_id: actorId,
        status: t.status,
        message,
        operation_json: t.operation_json ?? "{}",
        created_at: t.updated_at,
      })
      .execute();
    await ticketNotice(
      db,
      t,
      actorId,
      t.status === "pending"
        ? assigned
        : [t.user_id, t.initiator_id, ...assigned],
      t.kind === "access"
        ? "access." + (t.status === "pending" ? "requested" : t.status)
        : t.kind === "invitation"
          ? t.status === "pending"
            ? "resource.invited"
            : "invitation." + t.status
          : "ticket.updated",
    );
  }
  return t;
}
export async function syncAccessTicket(db: DB, id: string, actorId: string) {
  const q = await db
    .selectFrom("access_requests")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return syncTicket(
    db,
    {
      id: q.id,
      kind: "access",
      source_key: q.id,
      resource_id: q.resource_id,
      user_id: q.user_id,
      initiator_id: q.user_id,
      status: q.status,
      role: q.role,
      operation_json: q.operation_json ?? "{}",
      message: q.message ?? "",
      created_at: q.created_at,
      updated_at: q.updated_at,
    },
    actorId,
    q.status === "pending" ? (q.message ?? "") : (q.decision_message ?? ""),
  );
}
export async function syncInvitationTicket(
  db: DB,
  resourceId: string,
  userId: string,
  actorId: string,
  message = "",
) {
  const i = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", resourceId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!i) return;
  return syncTicket(
    db,
    {
      kind: "invitation",
      source_key: `${resourceId}:${userId}:${i.version}`,
      resource_id: resourceId,
      user_id: userId,
      initiator_id: i.invited_by ?? actorId,
      status: i.state,
      role: i.role,
      operation_json: JSON.stringify({ type: "resource.grant", resourceId, userId, role: i.role, includeDescendants: i.include_descendants !== 0 }),
      created_at: i.created_at ?? new Date().toISOString(),
      updated_at: i.updated_at ?? new Date().toISOString(),
      expires_at: i.expires_at ?? null,
      ...(i.state === "pending" ? { message } : {}),
    },
    actorId,
    message,
  );
}
