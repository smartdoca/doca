import {
  executeApprovalGrant,
  type ApprovalGrant,
  type GrantOperation,
} from "./operations.js";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { emitIntegrationEvent } from "../automation/events.js";
import type { Actor } from "../identity/passwords.js";
import { isResourceOwnerLike, permission, ranks } from "./policy.js";
import { accessContext, accessibleQuery, activeActor } from "./queries.js";
import {
  requestContext,
  managers,
  managementVisible,
  requestedRoles,
  openness,
} from "./presentation.js";
import { syncAccessTicket } from "../tickets/store.js";
type RequestRole = Schema["access_requests"]["role"];
export function createAccessRequests(db: DB) {
  return {
    preview(actor: Actor | null, id: string) {
      return transact(db, async (tx) => {
        const { r, rank, open, resources, grants } = await requestContext(
          tx,
          actor,
          id,
        );
        const show = await managementVisible(tx, actor, r, resources, grants);
        return {
          id: r.id,
          title: !actor ? "需要登录" : r.title,
          requestable: !!open.requests_enabled,
          loginRequired: !actor && open.visibility === "authenticated",
          requestRoles: requestedRoles(r, resources).filter(
            (role) => ranks[role] > rank,
          ),
          administrators: show ? await managers(tx, r, resources, grants) : [],
        };
      });
    },
    submit(actor: Actor, id: string, role: RequestRole, message = "") {
      return transact(db, async (tx) => {
        const { r, rank, resources, grants } = await requestContext(
          tx,
          actor,
          id,
        );
        if (rank >= ranks[role]) fail(409, "你已拥有此权限");
        if (!requestedRoles(r, resources).includes(role))
          fail(403, "该文档不接受此角色的申请");
        const pending = await tx
          .selectFrom("access_requests")
          .selectAll()
          .where("resource_id", "=", id)
          .where("user_id", "=", actor.id)
          .where("status", "=", "pending")
          .executeTakeFirst();
        if (pending) fail(409, "已有待处理申请，请先撤回再提交");
        if (message.length > 1000) fail(400, "申请说明最多一千字");
        const now = new Date().toISOString(),
          q = {
            id: randomUUID(),
            resource_id: id,
            user_id: actor.id,
            role,
            message: message.trim(),
            status: "pending",
            created_at: now,
            updated_at: now,
            decided_by: null,
          };
        await tx.insertInto("access_requests").values(q).execute();
        await syncAccessTicket(tx, q.id, actor.id);
        await emitIntegrationEvent(tx, "access.requested", {
          requestId: q.id,
          resourceId: id,
          userId: actor.id,
          role,
        });
        return q;
      });
    },
    list(actor: Actor, resourceId?: string) {
      return transact(db, async (tx) => {
        await activeActor(tx, actor);
        if (resourceId) {
          const c = await requestContext(tx, actor, resourceId);
          if (c.rank < 4) fail(403, "需要管理权限");
        }
        const requests = await tx
          .selectFrom("access_requests")
          .selectAll()
          .$if(!!resourceId, (q) => q.where("resource_id", "=", resourceId!))
          .where((eb) =>
            eb.or([
              eb("user_id", "=", actor.id),
              eb.and([
                ...(resourceId ? [] : [eb("status", "=", "pending")]),
                accessibleQuery(
                  sql.ref("access_requests.resource_id"),
                  actor,
                  4,
                ),
                sql<boolean>`(access_requests.role <> 'manager' or exists(select 1 from resources r where r.id=access_requests.resource_id and r.owner_id=${actor.id}))`,
              ]),
            ]),
          )
          .orderBy("created_at", "desc")
          .limit(200)
          .execute();
        const ctx = await accessContext(
          tx,
          actor,
          requests.map((q) => q.resource_id),
        );
        const items = [];
        for (const q of requests) {
          const r = ctx.resources.find((r) => r.id === q.resource_id);
          const live =
            r &&
            !r.deleted_at &&
            !ctx.resources.find((x) => x.id === r.library_id)?.deleted_at;
          const rank = live
            ? permission(r, actor, ctx.resources, ctx.grants)
            : 0;
          const visible =
            !!live &&
            (rank > 0 ||
              openness(r, ctx.resources).visibility === "requestable");
          const show =
            visible &&
            (await managementVisible(tx, actor, r!, ctx.resources, ctx.grants));
          const administrators = show
            ? (await managers(tx, r!, ctx.resources, ctx.grants)).filter(
                (u) => q.role !== "manager" || isResourceOwnerLike(r!, u, ctx.resources),
              )
            : [];
          const { decided_by, ...rest } = q;
          const decider =
            show && decided_by
              ? await tx
                  .selectFrom("users")
                  .select(["id", "display_name", "public_id"])
                  .where("id", "=", decided_by)
                  .executeTakeFirst()
              : undefined;
          items.push({
            ...rest,
            title: visible ? r!.title : "内容已不可访问",
            outgoing: q.user_id === actor.id,
            available: rank > 0,
            canDecide:
              !!live &&
              q.status === "pending" &&
              q.user_id !== actor.id &&
              rank >= 4 &&
              (q.role !== "manager" || isResourceOwnerLike(r!, actor, ctx.resources)),
            administrators,
            ...(decider ? { decider } : {}),
          });
        }
        return { items };
      });
    },
    decide(
      actor: Actor,
      id: string,
      decision: "approved" | "rejected" | "cancelled",
      message = "",
      grant: ApprovalGrant = {},
    ) {
      return transact(db, async (tx) => {
        await activeActor(tx, actor);
        if (message.length > 1000) fail(400, "处理意见最多一千字");
        const q = await tx
          .selectFrom("access_requests")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        if (!q) fail(404, "申请不存在");
        const { resources, grants } = await accessContext(tx, actor, [
          q.resource_id,
        ]);
        const r = resources.find((r) => r.id === q.resource_id);
        if (decision === "cancelled") {
          if (q.user_id !== actor.id) fail(403, "只能撤回自己的申请");
        } else if (
          !r ||
          r.deleted_at ||
          resources.find((x) => x.id === r.library_id)?.deleted_at ||
          q.user_id === actor.id ||
          permission(r, actor, resources, grants) < 4 ||
          (q.role === "manager" && !isResourceOwnerLike(r, actor, resources))
        )
          fail(403, "没有审批权限");
        if (q.status !== "pending") fail(409, "申请已处理或撤回，请刷新");
        let operation: GrantOperation | undefined;
        if (decision === "approved") {
          operation = await executeApprovalGrant(tx, actor, {
            type: "resource.grant",
            resourceId: q.resource_id,
            userId: q.user_id,
            role: grant.role ?? q.role,
            includeDescendants: grant.includeDescendants ?? true,
          });
        }
        await tx
          .updateTable("access_requests")
          .set({
            status: decision,
            operation_json: JSON.stringify(operation ?? {}),
            decision_message: message.trim(),
            decided_by: actor.id,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", id)
          .where("status", "=", "pending")
          .execute();
        await tx
          .deleteFrom("notifications")
          .where("type", "=", "access.requested")
          .where("dedupe_key", "like", id + ":%")
          .execute();
        await emitIntegrationEvent(tx, "access." + decision, {
          requestId: id,
          resourceId: q.resource_id,
          userId: q.user_id,
          actorId: actor.id,
          role: operation?.role ?? q.role,
          includeDescendants: operation?.includeDescendants,
        });
        await syncAccessTicket(tx, id, actor.id);
        return { ok: true };
      });
    },
  };
}
