import type { DB } from "../../../../db/src/index.js";
import { readSnapshot } from "../../../../db/src/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { accessContext, authorize } from "./queries.js";
import { managers, managementVisible } from "./presentation.js";
import { invitationState } from "./invitations.js";
import { isResourceOwnerLike, permission } from "./policy.js";
export async function listInvitations(
  db: DB,
  actor: Actor,
  resourceId?: string,
) {
  return readSnapshot(db, async (tx) => {
    if (resourceId) await authorize(tx, actor, resourceId, "manage_sharing");
    const current = await tx
      .selectFrom("access_invitations")
      .selectAll()
      .$if(!!resourceId, (q) => q.where("resource_id", "=", resourceId!))
      .$if(!resourceId, (q) =>
        q.where((eb) =>
          eb.or([
            eb("user_id", "=", actor.id),
            eb("invited_by", "=", actor.id),
          ]),
        ),
      )
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    const history = await tx
      .selectFrom("invitation_history")
      .selectAll()
      .$if(!!resourceId, (q) => q.where("resource_id", "=", resourceId!))
      .$if(!resourceId, (q) => q.where("invited_by", "=", actor.id))
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    const ctx = await accessContext(
      tx,
      actor,
      [...current, ...history].map((i) => i.resource_id),
    );
    const rows = [
      ...current.map((i) => ({ ...i, historical: false })),
      ...history.map(({ id, ...i }) => ({ ...i, historical: true })),
    ].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    const items = [];
    for (const i of rows.slice(0, 200)) {
      const r = ctx.resources.find((r) => r.id === i.resource_id);
      if (
        !r ||
        r.deleted_at ||
        ctx.resources.find((x) => x.id === r.library_id)?.deleted_at
      )
        continue;
      const rank = permission(r, actor, ctx.resources, ctx.grants),
        state = invitationState(i),
        incoming = i.user_id === actor.id;
      if (!resourceId && incoming && state !== "pending") continue;
      if (!incoming && rank < 1) continue;
      const show = await managementVisible(
        tx,
        actor,
        r,
        ctx.resources,
        ctx.grants,
      );
      const user = await tx
        .selectFrom("users")
        .select(["id", "display_name", "public_id"])
        .where("id", "=", i.user_id)
        .executeTakeFirst();
      const canManage =
        rank >= 4 &&
        (isResourceOwnerLike(r, actor, ctx.resources) ||
          (i.invited_by === actor.id && i.role !== "manager"));
      const { invited_by, decided_by, ...safe } = i;
      const inviter =
        show && invited_by
          ? await tx
              .selectFrom("users")
              .select(["id", "display_name", "public_id"])
              .where("id", "=", invited_by)
              .executeTakeFirst()
          : undefined;
      const decider =
        show && decided_by
          ? await tx
              .selectFrom("users")
              .select(["id", "display_name", "public_id"])
              .where("id", "=", decided_by)
              .executeTakeFirst()
          : undefined;
      items.push({
        ...safe,
        version: i.version ?? 1,
        id: i.resource_id,
        key: `${i.resource_id}:${i.user_id}:${i.version}`,
        title: r.title,
        state,
        incoming,
        outgoing: i.invited_by === actor.id,
        user,
        canCancel: !i.historical && state === "pending" && canManage,
        canResend: !i.historical && state !== "accepted" && canManage,
        ...(inviter ? { inviter } : {}),
        ...(decider ? { decider } : {}),
        administrators: show
          ? await managers(tx, r, ctx.resources, ctx.grants)
          : [],
      });
    }
    return { items };
  });
}
