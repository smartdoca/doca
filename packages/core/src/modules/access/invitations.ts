import { requireCapability } from "../entitlements/service.js";
import { checkMemberAdmission } from "../entitlements/admission.js";
import type { Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { setEntry } from "../discovery/entries.js";
import type { Actor } from "../identity/passwords.js";
import { isResourceOwnerLike, ranks, type Grant } from "./policy.js";
import { accessContext, activeActor, authorize } from "./queries.js";
import { emitIntegrationEvent } from "../automation/events.js";
import { notify } from "../interactions/community.js";
import { syncInvitationTicket, syncTicket } from "../tickets/store.js";
export function expiry(value: string | null | undefined) {
  if (!value) return null;
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())
    fail(400, "有效期必须晚于当前时间");
  return new Date(value).toISOString();
}
export function invitationState(i: Schema["access_invitations"]) {
  return i.state === "pending" &&
    i.expires_at &&
    i.expires_at <= new Date().toISOString()
    ? "expired"
    : i.state;
}
export async function archiveInvitation(
  tx: DB,
  i: Schema["access_invitations"],
) {
  await syncTicket(
    tx,
    {
      kind: "invitation",
      source_key: `${i.resource_id}:${i.user_id}:${i.version}`,
      resource_id: i.resource_id,
      user_id: i.user_id,
      initiator_id: i.invited_by ?? i.user_id,
      role: i.role,
      status:
        invitationState(i) === "pending" ? "cancelled" : invitationState(i),
      created_at: i.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: i.expires_at ?? null,
    },
    i.invited_by ?? null,
  );
  await tx
    .insertInto("invitation_history")
    .values({
      ...i,
      state: invitationState(i),
      id: `${i.resource_id}:${i.user_id}:${i.version}`,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}
export async function touchAccess(tx: DB, id: string) {
  await tx
    .updateTable("resources")
    .set((eb) => ({
      version: eb("version", "+", 1),
      authz_revision: eb("authz_revision", "+", 1),
    }))
    .where("id", "=", id)
    .execute();
}
/** Only pending invitations are controlled by their issuer; accepted permissions follow ACL rules. */
export async function replaceInvitations(
  tx: Transaction<Schema>,
  resourceId: string,
  desired: {
    userId: string;
    role: Grant["role"];
    includeDescendants?: boolean;
  }[],
  mode: "direct" | "invite",
  actor: Actor,
  message = "",
  directUserId?: string,
  directUserIds: readonly string[] = [],
) {
  const r = await tx
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", resourceId)
    .executeTakeFirstOrThrow();
  const libraryOwner = r.library_id
    ? await tx
        .selectFrom("resources")
        .select(["kind", "owner_id"])
        .where("id", "=", r.library_id)
        .executeTakeFirst()
    : undefined;
  const actorOwnsResource =
    actor.id === r.owner_id ||
    (libraryOwner?.kind === "library" && libraryOwner.owner_id === actor.id);
  const current = await tx
    .selectFrom("grants")
    .selectAll()
    .where("resource_id", "=", resourceId)
    .where("source_type", "=", "direct")
    .where("source_id", "=", "")
    .where("status", "=", "active")
    .execute();
  const invitations = await tx
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", resourceId)
    .execute();
  const invited: string[] = [],
    direct: string[] = [];
  for (const userId of new Set([
    ...current.map((g) => g.user_id),
    ...invitations
      .filter((i) => invitationState(i) === "pending")
      .map((i) => i.user_id),
    ...desired.map((g) => g.userId),
  ])) {
    const target = desired.find((g) => g.userId === userId),
      existing = current.find((g) => g.user_id === userId),
      old = invitations.find((i) => i.user_id === userId);
    const pending = old && invitationState(old) === "pending";
    if (
      (pending &&
        target?.role === old.role &&
        Number(target?.includeDescendants ?? true) ===
          (old.include_descendants ?? 1)) ||
      (!pending &&
        target?.role === existing?.role &&
        Number(target?.includeDescendants ?? true) ===
          (existing?.include_descendants ?? 1))
    )
      continue;
    if (
      pending &&
      !actorOwnsResource &&
      (old.invited_by !== actor.id || old.role === "manager")
    )
      fail(403, "只能调整自己发出的普通角色邀请");
    if (target && (!existing || ranks[target.role] > ranks[existing.role])) {
      await requireCapability(tx, actor.id, "sharing.invite");
      await requireCapability(tx, r.owner_id, "sharing.invite");
      await checkMemberAdmission(tx, resourceId, userId);
    }
    if (!target) {
      if (existing)
        await tx
          .insertInto("grants")
          .values({
            resource_id: resourceId,
            user_id: userId,
            source_type: "parent_override",
            source_id: "",
            source_resource_id: r.parent_id ?? r.library_id ?? null,
            role: "reader",
            include_descendants: 0,
            status: "disabled",
            created_by: actor.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc
              .columns(["resource_id", "user_id", "source_type", "source_id"])
              .doUpdateSet({
                source_resource_id: r.parent_id ?? r.library_id ?? null,
                status: "disabled",
                updated_at: new Date().toISOString(),
              }),
          )
          .execute();
      await tx
        .deleteFrom("grants")
        .where("resource_id", "=", resourceId)
        .where("user_id", "=", userId)
        .where("source_type", "=", "direct")
        .where("source_id", "=", "")
        .execute();
      if (pending)
        await tx
          .updateTable("access_invitations")
          .set({
            state: "cancelled",
            decided_by: actor.id,
            updated_at: new Date().toISOString(),
          })
          .where("resource_id", "=", resourceId)
          .where("user_id", "=", userId)
          .execute();
      direct.push(userId);
    } else if (
      mode === "invite" &&
      userId !== directUserId &&
      !directUserIds.includes(userId) &&
      (!existing || ranks[target.role] > ranks[existing.role])
    ) {
      invited.push(userId);
      if (old) await archiveInvitation(tx, old);
      const now = new Date().toISOString();
      const row = {
        resource_id: resourceId,
        user_id: userId,
        role: target.role,
        include_descendants: Number(target.includeDescendants ?? true),
        state: "pending",
        version: (r.authz_revision ?? 1) + 1,
        invited_by: pending ? old.invited_by : actor.id,
        created_at: now,
        updated_at: now,
        expires_at: pending ? old.expires_at : null,
        decided_by: null,
      };
      await tx
        .insertInto("access_invitations")
        .values(row)
        .onConflict((oc) =>
          oc.columns(["resource_id", "user_id"]).doUpdateSet(row),
        )
        .execute();
    } else {
      await tx
        .insertInto("grants")
        .values({
          resource_id: resourceId,
          user_id: userId,
          source_type: "direct",
          source_id: "",
          source_resource_id: null,
          role: target.role,
          include_descendants: Number(target.includeDescendants ?? true),
          status: "active",
          created_by: actor.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc
            .columns(["resource_id", "user_id", "source_type", "source_id"])
            .doUpdateSet({
              role: target.role,
              include_descendants: Number(target.includeDescendants ?? true),
              status: "active",
              updated_at: new Date().toISOString(),
            }),
        )
        .execute();
      if (pending)
        await tx
          .updateTable("access_invitations")
          .set({
            state: "cancelled",
            updated_at: new Date().toISOString(),
            decided_by: actor.id,
          })
          .where("resource_id", "=", resourceId)
          .where("user_id", "=", userId)
          .execute();
      direct.push(userId);
    }
    await syncInvitationTicket(tx, resourceId, userId, actor.id, message);
  }
  return { invited, direct };
}
export async function respondInvitation(
  db: DB,
  actor: Actor,
  resourceId: string,
  accept: boolean,
  version: number,
  message = "",
) {
  return transact(db, async (tx) => {
    await activeActor(tx, actor);
    const invitation = await tx
      .selectFrom("access_invitations")
      .selectAll()
      .where("resource_id", "=", resourceId)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    const resource = await tx
      .selectFrom("resources")
      .selectAll()
      .where("id", "=", resourceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!invitation || !resource) fail(404, "邀请不存在");
    if (
      resource.library_id &&
      (
        await tx
          .selectFrom("resources")
          .select("deleted_at")
          .where("id", "=", resource.library_id)
          .executeTakeFirst()
      )?.deleted_at
    )
      fail(404, "文档不存在");
    if (
      invitation.version === version &&
      invitation.state === "accepted" &&
      accept
    )
      return { ok: true };
    if (
      invitation.version !== version ||
      invitationState(invitation) !== "pending"
    )
      fail(409, "邀请已处理、撤销或过期，请刷新");
    if (accept) {
      const current = await tx
        .selectFrom("grants")
        .selectAll()
        .where("resource_id", "=", resourceId)
        .where("user_id", "=", actor.id)
        .where("source_type", "=", "direct")
        .where("source_id", "=", "")
        .executeTakeFirst();
      const role =
        current && ranks[current.role] > ranks[invitation.role ?? "reader"]
          ? current.role
          : (invitation.role ?? "reader");
      const include_descendants =
        role !== invitation.role
          ? (current?.include_descendants ?? 1)
          : (invitation.include_descendants ?? 1);
      await tx
        .insertInto("grants")
        .values({
          resource_id: resourceId,
          user_id: actor.id,
          source_type: "direct",
          source_id: "",
          source_resource_id: null,
          role,
          include_descendants,
          status: "active",
          created_by: actor.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc
            .columns(["resource_id", "user_id", "source_type", "source_id"])
            .doUpdateSet({ role, include_descendants, status: "active", updated_at: new Date().toISOString() }),
        )
        .execute();
      await setEntry(tx, actor, resourceId, "joined", "invitation");
    }
    await tx
      .updateTable("access_invitations")
      .set({
        state: accept ? "accepted" : "rejected",
        decided_by: actor.id,
        updated_at: new Date().toISOString(),
      })
      .where("resource_id", "=", resourceId)
      .where("user_id", "=", actor.id)
      .execute();
    await touchAccess(tx, resourceId);
    await syncInvitationTicket(tx, resourceId, actor.id, actor.id, message);
    const type = accept ? "invitation.accepted" : "invitation.rejected";
    await emitIntegrationEvent(tx, type, { resourceId, userId: actor.id });
    return { ok: true };
  });
}
export async function manageInvitation(
  db: DB,
  actor: Actor,
  resourceId: string,
  userId: string,
  input: {
    version: number;
    action: "cancel" | "resend";
    role?: Grant["role"];
    expiresAt?: string | null;
    message?: string;
  },
) {
  return transact(db, async (tx) => {
    const { resource: r } = await authorize(
      tx,
      actor,
      resourceId,
      "manage_sharing",
    );
    const i = await tx
      .selectFrom("access_invitations")
      .selectAll()
      .where("resource_id", "=", resourceId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!i) fail(404, "邀请不存在");
    if (i.version !== input.version) fail(409, "邀请已变化，请刷新");
    if (
      !isResourceOwnerLike(r, actor, (await accessContext(tx, actor, [r.id])).resources) &&
      (i.invited_by !== actor.id ||
        i.role === "manager" ||
        input.role === "manager")
    )
      fail(403, "只能管理自己发出的普通角色邀请");
    if (i.state === "accepted") fail(409, "邀请已接受，请到成员管理调整权限");
    if (input.action === "cancel") {
      if (invitationState(i) !== "pending") fail(409, "邀请已结束");
      await tx
        .updateTable("access_invitations")
        .set({
          state: "cancelled",
          decided_by: actor.id,
          updated_at: new Date().toISOString(),
        })
        .where("resource_id", "=", resourceId)
        .where("user_id", "=", userId)
        .execute();
    } else {
      const user = await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!user || userId === r.owner_id) fail(409, "该用户不能被邀请");
      await archiveInvitation(tx, i);
      const now = new Date().toISOString();
      await tx
        .updateTable("access_invitations")
        .set({
          role: input.role ?? i.role,
          state: "pending",
          version: (r.authz_revision ?? 1) + 1,
          created_at: now,
          updated_at: now,
          decided_by: null,
          expires_at: expiry(input.expiresAt),
        })
        .where("resource_id", "=", resourceId)
        .where("user_id", "=", userId)
        .execute();
    }
    await touchAccess(tx, resourceId);
    await syncInvitationTicket(tx, resourceId, userId, actor.id, input.message);
    await emitIntegrationEvent(tx, "invitation." + input.action, {
      resourceId,
      userId,
      actorId: actor.id,
    });
    return { ok: true };
  });
}
