import type { ApprovalGrant } from "../access/operations.js";
import { distributionPolicy } from "../deployment/policies.js";
import { sql } from "kysely";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { fail } from "../../shared/errors.js";
import { accessContext, accessibleQuery } from "../access/queries.js";
import { isResourceOwnerLike, permission } from "../access/policy.js";
import { createAccessRequests } from "../access/requests.js";
import { manageInvitation, respondInvitation } from "../access/invitations.js";
import { processors, ticketNotice, type Ticket } from "./store.js";
export const ticketStatus = (t: Ticket) =>
  t.status === "pending" &&
  t.expires_at &&
  t.expires_at <= new Date().toISOString()
    ? "expired"
    : ["approved", "accepted"].includes(t.status)
      ? "completed"
      : t.status;
const accessPredicate = (actor: Actor) =>
  sql<boolean>`(tickets.user_id = ${actor.id} or tickets.initiator_id = ${actor.id} or ${accessibleQuery(sql.ref("tickets.resource_id"), actor, 1)})`;
export function createTickets(db: DB) {
  async function context(actor: Actor, id: string) {
    const t = await db
      .selectFrom("tickets")
      .selectAll()
      .where("id", "=", id)
      .where(accessPredicate(actor))
      .executeTakeFirst();
    if (!t) fail(404, "工单不存在");
    const c = t.resource_id
      ? await accessContext(db, actor, [t.resource_id])
      : { resources: [], grants: [] };
    const r = c.resources.find((r) => r.id === t.resource_id);
    const live =
      !!r &&
      !r.deleted_at &&
      !c.resources.find((x) => x.id === r.library_id)?.deleted_at;
    const rank = live ? permission(r!, actor, c.resources, c.grants) : 0;
    const manage = rank >= 4;
    const show =
      actor.id !== t.user_id ||
      (t.hidden_for_user_id !== actor.id &&
        (await distributionPolicy(db, r?.kind)).ticketReviewers[t.kind]);

    const pending = ticketStatus(t) === "pending";
    const actions: string[] = [];
    if (pending) {
      if (t.kind === "access") {
        if (t.user_id === actor.id) actions.push("cancel");
        else if (manage && (t.role !== "manager" || isResourceOwnerLike(r!, actor, c.resources)))
          actions.push("approve", "reject");
      } else if (t.kind === "invitation" && live) {
        if (t.user_id === actor.id) actions.push("accept", "reject");
        if (
          manage &&
          (isResourceOwnerLike(r!, actor, c.resources) ||
            (actor.id === t.initiator_id && t.role !== "manager"))
        )
          actions.push("cancel");
      }
      if (
        (t.user_id === actor.id || t.initiator_id === actor.id) &&
        (t.kind === "access" || t.user_id !== actor.id)
      )
        actions.push("remind");
    }
    return { t, r, rank, show, actions, resources: c.resources };
  }
  async function detail(actor: Actor, id: string) {
    const { t, r, rank, show, actions, resources } = await context(actor, id);
    const assigned = show ? await processors(db, t) : [];
    const events = await db
      .selectFrom("ticket_events")
      .selectAll()
      .where("ticket_id", "=", t.id)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const visibleIds = new Set([
      t.user_id,
      ...(show
        ? [
            t.initiator_id,
            ...assigned,
            ...events.map((e) => e.actor_id).filter((x): x is string => !!x),
          ]
        : []),
    ]);
    const users = await db
      .selectFrom("users")
      .select(["id", "display_name", "public_id"])
      .where("id", "in", [...visibleIds])
      .execute();
    const person = (id: string | null) => {
      const u = users.find((u) => u.id === id);
      return u
        ? { ...u, display_name: u.display_name || u.public_id || "" }
        : null;
    };
    return {
      id: t.id,
      kind: t.kind,
      status: ticketStatus(t),
      role: t.role,
      operation: JSON.parse(t.operation_json ?? "{}"),
      approvalRoles: actions.includes("approve") ? ["reader", "commenter", "editor", ...(r && isResourceOwnerLike(r, actor, resources) ? ["manager"] : [])] : [],
      message: t.message,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      expiresAt: t.expires_at,
      processorRule:
        t.kind === "invitation"
          ? "recipient"
          : t.role === "manager"
            ? "resource_owner"
            : "resource_managers",
      resourceKind: t.resource_kind,
      resourceId: t.resource_id,
      resource: r
        ? {
            id: r.id,
            kind: r.kind,
            title:
              rank > 0
                ? r.title
                : t.resource_kind === "library"
                  ? "关联知识库"
                  : "关联文档",
            url: `#/r/${r.id}`,
          }
        : null,
      subject: person(t.user_id),
      initiator: person(t.initiator_id),
      processors: show ? assigned.map(person).filter(Boolean) : [],
      processorsHidden: !show,
      steps:
        t.kind === "invitation"
          ? ["发起邀请", "受邀人确认", "加入协作"]
          : ["发起申请", "管理员审批", "权限生效"],
      events: events.map((e) => ({
        id: e.id,
        status: e.status,
        message: e.message,
        operation: JSON.parse(e.operation_json ?? "{}"),
        createdAt: e.created_at,
        actor: person(e.actor_id),
      })),
      actions,
    };
  }
  return {
    detail,
    async list(
      actor: Actor,
      filter: {
        kind?: string;
        status?: string | string[];
        onlyMine?: boolean;
        resourceId?: string;
        resourceKind?: "document" | "library";
        offset?: number;
      } = {},
    ) {
      let q = db
        .selectFrom("tickets")
        .selectAll()
        .where(accessPredicate(actor));
      if (filter.kind) q = q.where("kind", "=", filter.kind as Ticket["kind"]);
      if (filter.resourceKind)
        q = q.where("resource_kind", "=", filter.resourceKind);
      if (filter.resourceId) q = q.where("resource_id", "=", filter.resourceId);
      const state = sql<string>`case when status='pending' and expires_at is not null and expires_at<=${new Date().toISOString()} then 'expired' when status in ('approved','accepted') then 'completed' else status end`;
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : (filter.status?.split(",").filter(Boolean) ?? []);
      if (statuses.length) q = q.where(state, "in", statuses);
      if (filter.onlyMine) {
        // Match the current approval/acceptance step, not cancellation or reminders.
        q = q.where(state, "=", "pending").where(
          sql<boolean>`exists(select 1 from users u where u.id=${actor.id} and u.status='active') and (
                (tickets.kind='invitation' and tickets.user_id=${actor.id}
                  and exists(select 1 from resources r where r.id=tickets.resource_id and r.deleted_at is null
                    and not exists(select 1 from resources l where l.id=r.library_id and l.deleted_at is not null)))
                or (tickets.kind='access' and tickets.user_id<>${actor.id}
                  and ${accessibleQuery(sql.ref("tickets.resource_id"), actor, 4)}
                  and (tickets.role<>'manager' or exists(select 1 from resources r where r.id=tickets.resource_id and r.owner_id=${actor.id})))
              )`,
        );
      }
      const rows = await q
        .orderBy("created_at", "desc")
        .orderBy("id")
        .offset(filter.offset ?? 0)
        .limit(31)
        .execute();
      const items = [];
      for (const t of rows.slice(0, 30)) items.push(await detail(actor, t.id));
      return {
        items,
        nextOffset: rows.length > 30 ? (filter.offset ?? 0) + 30 : null,
      };
    },
    async act(actor: Actor, id: string, action: string, message = "", grant: ApprovalGrant = {}) {
      return transact(db, async (tx) => {
        const service = createTickets(tx),
          c = await service.detail(actor, id);
        if (!c.actions.includes(action)) fail(403, "当前步骤不可执行此操作");
        const t = await tx
          .selectFrom("tickets")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        if (action === "remind") {
          if (t.reminded_at && Date.parse(t.reminded_at) > Date.now() - 300000)
            fail(429, "已提醒处理人，请五分钟后再试");
          await tx
            .updateTable("tickets")
            .set({ reminded_at: new Date().toISOString() })
            .where("id", "=", id)
            .execute();
          await ticketNotice(
            tx,
            t,
            actor.id,
            await processors(tx, t),
            "ticket.reminded",
          );
        } else if (t.kind === "access")
          await createAccessRequests(tx).decide(
            actor,
            t.source_key,
            action === "cancel"
              ? "cancelled"
              : action === "approve"
                ? "approved"
                : "rejected",
            message,
            grant,
          );
        else if (t.kind === "invitation") {
          const version = Number(t.source_key.split(":").at(-1));
          if (action === "cancel")
            await manageInvitation(tx, actor, t.resource_id!, t.user_id, {
              action: "cancel",
              version,
              message,
            });
          else
            await respondInvitation(
              tx,
              actor,
              t.resource_id!,
              action === "accept",
              version,
              message,
            );
        }
        return service.detail(actor, id);
      });
    },
  };
}
