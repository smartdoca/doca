import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { activeActor } from "./queries.js";
import { authorizeFileFolder } from "./file-access.js";
import { canChangeMemberRole, type Role } from "./roles.js";
import { distributionPolicy } from "../deployment/policies.js";
import { syncTicket } from "../tickets/store.js";
import { expiry } from "./invitations.js";
import { fail } from "../../shared/errors.js";

type FolderRole = "admin" | "reader";
const acl = (role: "owner" | FolderRole | undefined): Role =>
  role === "admin" ? "manager" : (role ?? "none");
async function member(db: DB, folderId: string, userId: string) {
  return db
    .selectFrom("file_folder_shares")
    .selectAll()
    .where("folder_id", "=", folderId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}
async function grant(
  db: DB,
  folderId: string,
  userId: string,
  role: FolderRole,
) {
  const old = await member(db, folderId, userId),
    now = new Date().toISOString();
  await db
    .insertInto("file_folder_shares")
    .values({
      folder_id: folderId,
      user_id: userId,
      role,
      version: (old?.version ?? 0) + 1,
      created_at: old?.created_at ?? now,
      updated_at: now,
    })
    .onConflict((o) =>
      o
        .columns(["folder_id", "user_id"])
        .doUpdateSet({
          role,
          version: (old?.version ?? 0) + 1,
          updated_at: now,
        }),
    )
    .execute();
}
async function syncInvitation(
  db: DB,
  i: Schema["file_folder_invitations"],
  actorId: string,
  message: string,
  grantMode: "direct" | "invite",
) {
  return syncTicket(
    db,
    {
      id: i.id,
      kind: "invitation",
      resource_kind: "folder",
      resource_id: i.folder_id,
      source_key: i.id,
      user_id: i.user_id,
      initiator_id: i.invited_by,
      status: i.state,
      role: acl(i.role),
      message: i.message,
      operation_json: JSON.stringify({
        type: "folder.grant",
        resourceId: i.folder_id,
        userId: i.user_id,
        role: acl(i.role),
        includeDescendants: true,
        grantMode,
      }),
      created_at: i.created_at,
      updated_at: i.updated_at,
    },
    actorId,
    message,
  );
}
/** Cancel a pending invitation while preserving its ticket and decision history. */
export async function cancelFolderInvitation(
  db: DB,
  invitation: Schema["file_folder_invitations"],
  actorId: string,
  now: string,
) {
  const cancelled = { ...invitation, state: "cancelled" as const, updated_at: now };
  await db
    .updateTable("file_folder_invitations")
    .set({ state: cancelled.state, updated_at: now })
    .where("id", "=", invitation.id)
    .where("state", "=", "pending")
    .execute();
  await syncInvitation(db, cancelled, actorId, "", "invite");
}

export function createFolderSharing(db: DB) {
  async function manage(tx: DB, actor: Actor, id: string) {
    await activeActor(tx, actor);
    const access = await authorizeFileFolder(tx, actor, id, 3);
    if (access.folder.parent_id !== "shared")
      fail(400, "只有共享文件夹根目录可以设置共享");
    return access;
  }
  async function linkCount(tx: DB, folderId: string, hash: string) {
    const row = await tx
      .selectFrom("file_folder_link_members as m")
      .innerJoin("file_folder_shares as s", (j) =>
        j
          .onRef("s.folder_id", "=", "m.folder_id")
          .onRef("s.user_id", "=", "m.user_id"),
      )
      .select((eb) => eb.fn.countAll().as("count"))
      .where("m.folder_id", "=", folderId)
      .where("m.token_hash", "=", hash)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
  async function linkInfo(tx: DB, actor: Actor, id: string) {
    const access = await manage(tx, actor, id);
    const row = await tx
      .selectFrom("file_folder_share_links")
      .selectAll()
      .where("folder_id", "=", id)
      .executeTakeFirst();
    return {
      enabled: !!row?.enabled,
      role: row?.role ?? "reader",
      token: row?.enabled ? row.token : null,
      url: row?.enabled ? `#/shared-files/join?token=${row.token}` : null,
      isOwner: access.role === "owner",
      maxMembers: row ? row.max_members : 1,
      memberCount: row ? await linkCount(tx, id, row.token_hash) : 0,
      expiresAt: row?.expires_at ?? null,
      revision: row?.revision ?? null,
    };
  }
  return {
    linkInfo: (actor: Actor, id: string) => linkInfo(db, actor, id),
    invite(
      actor: Actor,
      id: string,
      input: { userId: string; role: FolderRole; message?: string },
    ) {
      return transact(db, async (tx) => {
        const access = await manage(tx, actor, id);
        const target = await tx
          .selectFrom("users")
          .select(["id", "status"])
          .where((eb) =>
            eb.or([
              eb("id", "=", input.userId),
              eb("public_id", "=", input.userId),
            ]),
          )
          .executeTakeFirst();
        if (!target || target.status !== "active")
          fail(404, "用户不存在或已停用");
        if (target.id === access.folder.owner_id)
          fail(400, "所有者不需要额外授权");
        const old = await member(tx, id, target.id);
        if (
          !canChangeMemberRole(
            acl(access.role),
            acl(old?.role),
            acl(input.role),
          )
        )
          fail(403, "只有所有者可以调整管理员权限");
        const pending = await tx
          .selectFrom("file_folder_invitations")
          .select("id")
          .where("folder_id", "=", id)
          .where("user_id", "=", target.id)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (pending) fail(409, "该用户已有待接受邀请，请在工单中处理");
        if (old?.role === input.role) return { ok: true, pending: false };
        const policy = await distributionPolicy(tx);
        const needsAcceptance =
          policy.grantMode === "invite" &&
          (!old || (old.role === "reader" && input.role === "admin"));
        const now = new Date().toISOString();
        const i: Schema["file_folder_invitations"] = {
          id: randomUUID(),
          folder_id: id,
          user_id: target.id,
          role: input.role,
          state: needsAcceptance ? "pending" : "accepted",
          invited_by: actor.id,
          message: input.message ?? "",
          created_at: now,
          updated_at: now,
        };
        if (!needsAcceptance) await grant(tx, id, target.id, input.role);
        await tx.insertInto("file_folder_invitations").values(i).execute();
        await syncInvitation(
          tx,
          i,
          actor.id,
          i.message,
          needsAcceptance ? "invite" : "direct",
        );
        return { ok: true, pending: needsAcceptance, ticketId: i.id };
      });
    },
    remove(actor: Actor, id: string, userId: string) {
      return transact(db, async (tx) => {
        const access = await manage(tx, actor, id),
          old = await member(tx, id, userId);
        if (!canChangeMemberRole(acl(access.role), acl(old?.role), null))
          fail(403, "只有所有者可以调整管理员权限");
        await tx
          .deleteFrom("file_folder_shares")
          .where("folder_id", "=", id)
          .where("user_id", "=", userId)
          .execute();
        await tx
          .deleteFrom("file_folder_link_members")
          .where("folder_id", "=", id)
          .where("user_id", "=", userId)
          .execute();
        return { ok: true };
      });
    },
    act(
      actor: Actor,
      invitationId: string,
      action: "accept" | "reject" | "cancel",
      message = "",
    ) {
      return transact(db, async (tx) => {
        await activeActor(tx, actor);
        const i = await tx
          .selectFrom("file_folder_invitations")
          .selectAll()
          .where("id", "=", invitationId)
          .executeTakeFirst();
        if (!i) fail(404, "邀请不存在");
        const folder = await tx
          .selectFrom("file_folders")
          .selectAll()
          .where("id", "=", i.folder_id)
          .where("deleted_at", "is", null)
          .where("parent_id", "=", "shared")
          .executeTakeFirst();
        if (!folder) fail(404, "共享文件夹不存在");
        if (i.state !== "pending") fail(409, "邀请已处理，请刷新");
        if (action === "cancel") {
          const access = await manage(tx, actor, i.folder_id);
          if (
            access.role !== "owner" &&
            (i.invited_by !== actor.id || i.role === "admin")
          )
            fail(403, "只能撤销自己发出的普通权限邀请");
        } else if (i.user_id !== actor.id) fail(403, "只能处理发给自己的邀请");
        if (action === "accept") {
          const old = await member(tx, i.folder_id, actor.id);
          await grant(
            tx,
            i.folder_id,
            actor.id,
            old?.role === "admin" ? "admin" : i.role,
          );
          await tx
            .insertInto("folder_entries")
            .values({
              folder_id: i.folder_id,
              user_id: actor.id,
              state: "joined",
              updated_at: new Date().toISOString(),
            })
            .onConflict((o) =>
              o
                .columns(["folder_id", "user_id"])
                .doUpdateSet({
                  state: "joined",
                  updated_at: new Date().toISOString(),
                }),
            )
            .execute();
        }
        const state =
            action === "accept"
              ? "accepted"
              : action === "reject"
                ? "rejected"
                : "cancelled",
          now = new Date().toISOString();
        const updated = await tx
          .updateTable("file_folder_invitations")
          .set({ state, updated_at: now })
          .where("id", "=", i.id)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1)
          fail(409, "邀请已处理，请刷新");
        await syncInvitation(
          tx,
          { ...i, state, updated_at: now },
          actor.id,
          message,
          "invite",
        );
        return { ok: true };
      });
    },
    setLink(
      actor: Actor,
      id: string,
      input: {
        enabled: boolean;
        role: FolderRole;
        rotate?: boolean;
        maxMembers?: number | null;
        expiresAt?: string | null;
        revision?: number | null;
      },
    ) {
      return transact(db, async (tx) => {
        const access = await manage(tx, actor, id);
        const old = await tx
          .selectFrom("file_folder_share_links")
          .selectAll()
          .where("folder_id", "=", id)
          .executeTakeFirst();
        if (
          !canChangeMemberRole(
            acl(access.role),
            acl(old?.role),
            acl(input.role),
          )
        )
          fail(403, "只有所有者可以调整管理员分享链接");
        if (
          input.revision !== undefined &&
          input.revision !== (old?.revision ?? null)
        )
          fail(409, "链接已变化，请刷新");
        if (
          input.maxMembers !== undefined &&
          input.maxMembers !== null &&
          (!Number.isInteger(input.maxMembers) || input.maxMembers < 1)
        )
          fail(400, "分享链接人数必须是正整数或无限人数");
        const token =
            !old || input.rotate
              ? randomBytes(32).toString("base64url")
              : old.token,
          now = new Date().toISOString();
        const row: Schema["file_folder_share_links"] = {
          folder_id: id,
          token,
          token_hash: createHash("sha256").update(token).digest("hex"),
          role: input.role,
          enabled: Number(input.enabled),
          created_by: old?.created_by ?? actor.id,
          created_at: old?.created_at ?? now,
          updated_at: now,
          max_members:
            input.maxMembers === undefined
              ? old
                ? old.max_members
                : 1
              : input.maxMembers,
          expires_at:
            input.expiresAt === undefined
              ? (old?.expires_at ?? null)
              : expiry(input.expiresAt),
          revision: (old?.revision ?? 0) + 1,
        };
        await tx
          .insertInto("file_folder_share_links")
          .values(row)
          .onConflict((o) => o.column("folder_id").doUpdateSet(row))
          .execute();
        return linkInfo(tx, actor, id);
      });
    },
    redeem(actor: Actor, token: string, accept = false) {
      return transact(db, async (tx) => {
        await activeActor(tx, actor);
        const hash = createHash("sha256").update(token).digest("hex");
        // Serializes admission against link edits and concurrent redemptions on PostgreSQL too.
        await tx
          .updateTable("file_folder_share_links")
          .set({ revision: sql<number>`revision` })
          .where("token_hash", "=", hash)
          .execute();
        const link = await tx
          .selectFrom("file_folder_share_links")
          .selectAll()
          .where("token_hash", "=", hash)
          .where("enabled", "=", 1)
          .executeTakeFirst();
        if (
          !link ||
          (link.expires_at && link.expires_at <= new Date().toISOString())
        )
          fail(404, "分享链接不存在、已停用或过期");
        const folder = await tx
          .selectFrom("file_folders")
          .selectAll()
          .where("id", "=", link.folder_id)
          .where("parent_id", "=", "shared")
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (!folder) fail(404, "共享文件夹不存在");
        const old = await member(tx, folder.id, actor.id);
        if (
          folder.owner_id === actor.id ||
          old?.role === "admin" ||
          old?.role === link.role
        )
          return { id: folder.id, name: folder.name };
        const admission = await tx
          .selectFrom("file_folder_link_members")
          .select("user_id")
          .where("folder_id", "=", folder.id)
          .where("token_hash", "=", hash)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        if (
          !admission &&
          link.max_members !== null &&
          (await linkCount(tx, folder.id, hash)) >= link.max_members
        )
          fail(403, "分享链接人数已满");
        if ((await distributionPolicy(tx)).grantMode === "invite" && !accept)
          return {
            pending: true as const,
            id: folder.id,
            name: folder.name,
            role: acl(link.role),
          };
        await grant(tx, folder.id, actor.id, link.role);
        await tx
          .insertInto("file_folder_link_members")
          .values({
            folder_id: folder.id,
            token_hash: hash,
            user_id: actor.id,
            created_at: new Date().toISOString(),
          })
          .onConflict((o) =>
            o.columns(["folder_id", "token_hash", "user_id"]).doNothing(),
          )
          .execute();
        await tx
          .insertInto("folder_entries")
          .values({
            folder_id: folder.id,
            user_id: actor.id,
            state: "joined",
            updated_at: new Date().toISOString(),
          })
          .onConflict((o) =>
            o
              .columns(["folder_id", "user_id"])
              .doUpdateSet({
                state: "joined",
                updated_at: new Date().toISOString(),
              }),
          )
          .execute();
        return { id: folder.id, name: folder.name };
      });
    },
  };
}
