import { randomUUID } from "node:crypto";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { authorize, accessContext, activeActor } from "../access/queries.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "../../shared/cursor.js";
import { authorizeFileFolder } from "../access/file-access.js";
import {
  ranks,
  label,
  isResourceOwnerLike,
  groupPermission,
} from "../access/policy.js";
import {
  checkMemberAdmission,
  requireCapability,
} from "../access/operation-policy.js";
import { distributionPolicy } from "../deployment/policies.js";
import {
  groupError,
  groupChanged,
  requireGroup,
  touchGroup,
} from "./service.js";
import { groupMemberIds } from "./access.js";
import { validateGroupSelection } from "./directory.js";

type ResourceRole = Schema["resource_group_grants"]["role"];
type GroupGrantRole = ResourceRole | "admin";
const rank = (role: GroupGrantRole) => (role === "admin" ? 4 : ranks[role]);
async function targetAccess(db: DB, actor: Actor, id: string, folder: boolean) {
  if (folder) {
    const access = await authorizeFileFolder(db, actor, id, 3);
    if (access.folder.parent_id !== "shared") return groupError(400, "invalid");
    return {
      owner: access.role === "owner",
      ownerId: access.folder.owner_id,
      revision: access.folder.version,
      kind: undefined,
      supportsDescendants: true,
    };
  }
  const access = await authorize(db, actor, id, "manage_sharing");
  return {
    owner: isResourceOwnerLike(access.resource, actor, access.resources),
    ownerId: access.resource.owner_id,
    revision: access.resource.authz_revision ?? 1,
    kind: access.resource.kind,
    supportsDescendants:
      access.resource.kind === "library" || !!access.resource.library_id,
  };
}
async function lockTarget(
  db: DB,
  id: string,
  folder: boolean,
  revision: number,
) {
  const result = folder
    ? await db
        .updateTable("file_folders")
        .set({ version: revision + 1 })
        .where("id", "=", id)
        .where("version", "=", revision)
        .executeTakeFirst()
    : await db
        .updateTable("resources")
        .set((eb) => ({
          authz_revision: revision + 1,
          version: eb("version", "+", 1),
        }))
        .where("id", "=", id)
        .where("authz_revision", "=", revision)
        .executeTakeFirst();
  if (!result.numUpdatedRows) groupError(409, "conflict");
}
async function currentGrant(
  db: DB,
  actor: Actor,
  id: string,
  groupId: string,
  folder: boolean,
) {
  if (folder) {
    const row = await db
      .selectFrom("file_folder_group_grants")
      .selectAll()
      .where("folder_id", "=", id)
      .where("group_id", "=", groupId)
      .executeTakeFirst();
    return { rank: row ? rank(row.role) : 0, descendants: true };
  }
  const ctx = await accessContext(db, actor, [id]);
  const resource = ctx.resources.find((r) => r.id === id)!;
  return {
    rank: groupPermission(resource, groupId, ctx.resources, ctx.grants),
    descendants:
      groupPermission(resource, groupId, ctx.resources, ctx.grants, true) > 0,
  };
}
async function writeGrant(
  db: DB,
  actor: Actor,
  id: string,
  groupId: string,
  folder: boolean,
  role: GroupGrantRole | null,
  descendants: boolean,
) {
  const time = new Date().toISOString();
  if (folder) {
    if (!role)
      await db
        .deleteFrom("file_folder_group_grants")
        .where("folder_id", "=", id)
        .where("group_id", "=", groupId)
        .execute();
    else {
      const row = {
        folder_id: id,
        group_id: groupId,
        role: role as "reader" | "admin",
        created_by: actor.id,
        created_at: time,
        updated_at: time,
      };
      await db
        .insertInto("file_folder_group_grants")
        .values(row)
        .onConflict((oc) =>
          oc
            .columns(["folder_id", "group_id"])
            .doUpdateSet({ role: row.role, updated_at: time }),
        )
        .execute();
    }
  } else {
    const row = {
      resource_id: id,
      group_id: groupId,
      role: (role ?? "reader") as ResourceRole,
      include_descendants: role ? Number(descendants) : 0,
      status: role ? ("active" as const) : ("disabled" as const),
      created_by: actor.id,
      created_at: time,
      updated_at: time,
    };
    await db
      .insertInto("resource_group_grants")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["resource_id", "group_id"]).doUpdateSet({
          role: row.role,
          include_descendants: row.include_descendants,
          status: row.status,
          updated_at: time,
        }),
      )
      .execute();
  }
}

export function createGroupGrants(db: DB) {
  return {
    async members(
      actor: Actor,
      id: string,
      groupId: string,
      folder: boolean,
      input: { cursor?: string; limit?: number } = {},
    ) {
      await activeActor(db, actor);
      await targetAccess(db, actor, id, folder);
      const group = await db
        .selectFrom("user_groups")
        .select("id")
        .where("id", "=", groupId)
        .where("dissolved_at", "is", null)
        .executeTakeFirst();
      if (!group || !(await currentGrant(db, actor, id, groupId, folder)).rank)
        return groupError(404, "unavailable");
      const limit = input.limit ?? 20;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (input.cursor?.length ?? 0) > 2048
      )
        return groupError(400, "invalid");
      const fingerprint = cursorFingerprint({
        groupGrantMembers: 1,
        actor: actor.id,
        id,
        groupId,
        folder,
      });
      const cursor = input.cursor
        ? decodePageCursor(input.cursor, fingerprint)
        : null;
      const base = db
        .selectFrom("user_group_members as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .where("m.group_id", "=", groupId)
        .where("u.status", "=", "active");
      const count = await base
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .executeTakeFirstOrThrow();
      let query = base
        .leftJoin("user_preferences as p", "p.user_id", "u.id")
        .select([
          "u.id",
          "u.display_name",
          "u.public_id",
          "p.avatar",
          "p.avatar_asset_id",
          "m.joined_at",
        ]);
      if (cursor)
        query = query.where((eb) =>
          eb.or([
            eb("m.joined_at", ">", cursor.value),
            eb.and([
              eb("m.joined_at", "=", cursor.value),
              eb("u.id", ">", cursor.id),
            ]),
          ]),
        );
      const rows = await query
          .orderBy("m.joined_at")
          .orderBy("u.id")
          .limit(limit + 1)
          .execute(),
        last = rows[limit - 1];
      return {
        items: rows.slice(0, limit).map(({ joined_at, ...member }) => member),
        total: Number(count.total),
        nextCursor:
          rows.length > limit && last
            ? encodePageCursor(fingerprint, last.joined_at, last.id)
            : null,
      };
    },
    async list(actor: Actor, id: string, folder: boolean) {
      const access = await targetAccess(db, actor, id, folder);
      const items: {
        groupId: string;
        name: string;
        avatar: string | null;
        role: string;
        status: string;
        includeDescendants: boolean;
        inherited: boolean;
      }[] = [];
      const libraryManagers = new Set<string>();
      if (folder) {
        const rows = await db
          .selectFrom("file_folder_group_grants as grant")
          .innerJoin("user_groups as g", "g.id", "grant.group_id")
          .select(["g.id", "g.name", "g.avatar", "grant.role"])
          .where("grant.folder_id", "=", id)
          .where("g.dissolved_at", "is", null)
          .execute();
        items.push(
          ...rows.map((g) => ({
            groupId: g.id,
            name: g.name,
            avatar: g.avatar,
            role: g.role,
            status: "active",
            includeDescendants: true,
            inherited: false,
          })),
        );
      } else {
        const ctx = await accessContext(db, actor, [id]);
        const resource = ctx.resources.find((r) => r.id === id)!;
        for (const groupId of new Set(
          ctx.grants.filter((g) => g.groupId).map((g) => g.groupId!),
        )) {
          const level = groupPermission(
            resource,
            groupId,
            ctx.resources,
            ctx.grants,
          );
          if (!level) continue;
          const libraryManager =
            resource.library_id &&
            ctx.grants.find(
              (g) =>
                g.groupId === groupId &&
                g.resource_id === resource.library_id &&
                g.role === "manager" &&
                !g.blocked,
            );
          if (libraryManager) libraryManagers.add(groupId);
          const grant =
            (libraryManager ||
              ctx.grants.find(
                (g) => g.groupId === groupId && g.resource_id === id,
              )) ??
            ctx.grants.find((g) => g.groupId === groupId)!;
          items.push({
            groupId,
            name: grant.groupName!,
            avatar: grant.groupAvatar!,
            role: label(level),
            status: "active",
            includeDescendants:
              groupPermission(
                resource,
                groupId,
                ctx.resources,
                ctx.grants,
                true,
              ) > 0,
            inherited: grant.resource_id !== id,
          });
        }
      }
      const pending = await db
        .selectFrom("group_resource_invitations as i")
        .innerJoin("user_groups as g", "g.id", "i.group_id")
        .select([
          "g.id",
          "g.name",
          "g.avatar",
          "i.role",
          "i.include_descendants",
        ])
        .where(folder ? "i.folder_id" : "i.resource_id", "=", id)
        .where("i.state", "=", "pending")
        .where("i.expires_at", ">", new Date().toISOString())
        .where("g.dissolved_at", "is", null)
        .execute();
      items.push(
        ...pending.map((g) => ({
          groupId: g.id,
          name: g.name,
          avatar: g.avatar,
          role: g.role,
          status: "pending",
          includeDescendants: !!g.include_descendants,
          inherited: false,
        })),
      );
      return {
        items: items.map((item) => ({
          ...item,
          canAdjust:
            !libraryManagers.has(item.groupId) &&
            (access.owner ||
              !items.some(
                (other) =>
                  other.groupId === item.groupId &&
                  ["manager", "admin"].includes(other.role),
              )),
        })),
        revision: access.revision,
      };
    },
    set(
      actor: Actor,
      id: string,
      groupId: string,
      folder: boolean,
      input: {
        revision: number;
        role: GroupGrantRole | null;
        includeDescendants: boolean;
      },
    ) {
      return transact(db, async (tx) => {
        const access = await targetAccess(tx, actor, id, folder);
        const includeDescendants =
          access.supportsDescendants && input.includeDescendants;
        if (access.revision !== input.revision)
          return groupError(409, "conflict");
        if (
          input.role &&
          !(
            folder
              ? ["reader", "admin"]
              : ["reader", "commenter", "editor", "manager"]
          ).includes(input.role)
        )
          return groupError(400, "invalid");
        const current = await currentGrant(tx, actor, id, groupId, folder);
        const pending = await tx
          .selectFrom("group_resource_invitations")
          .selectAll()
          .where("group_id", "=", groupId)
          .where(folder ? "folder_id" : "resource_id", "=", id)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (
          !access.owner &&
          (current.rank >= 4 ||
            (input.role && rank(input.role) >= 4) ||
            (pending && rank(pending.role) >= 4))
        )
          return groupError(403, "forbidden");
        const group = await tx
          .selectFrom("user_groups")
          .selectAll()
          .where("id", "=", groupId)
          .where("dissolved_at", "is", null)
          .executeTakeFirst();
        if (!group) return groupError(404, "unavailable");
        if (!current.rank && (input.role || !pending))
          await validateGroupSelection(tx, actor, groupId);
        await lockTarget(tx, id, folder, input.revision);
        await touchGroup(tx, groupId, group.revision);
        await tx
          .updateTable("group_resource_invitations")
          .set({ state: "cancelled", updated_at: new Date().toISOString() })
          .where("group_id", "=", groupId)
          .where(folder ? "folder_id" : "resource_id", "=", id)
          .where("state", "=", "pending")
          .execute();
        const policy = await distributionPolicy(tx, access.kind);
        const requiresAcceptance =
          input.role &&
          policy.grantMode === "invite" &&
          (rank(input.role) > current.rank ||
            (includeDescendants && !current.descendants));
        if (input.role) {
          await requireCapability(tx, actor.id, "sharing.invite");
          await requireCapability(tx, access.ownerId, "sharing.invite");
          if (!folder)
            for (const userId of await groupMemberIds(tx, groupId))
              await checkMemberAdmission(tx, id, userId);
        }
        if (requiresAcceptance) {
          const time = new Date().toISOString();
          await tx
            .insertInto("group_resource_invitations")
            .values({
              id: randomUUID(),
              group_id: groupId,
              resource_id: folder ? null : id,
              folder_id: folder ? id : null,
              role: input.role!,
              include_descendants: Number(includeDescendants),
              invited_by: actor.id,
              state: "pending",
              expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
              created_at: time,
              updated_at: time,
            })
            .execute();
        } else
          await writeGrant(
            tx,
            actor,
            id,
            groupId,
            folder,
            input.role,
            includeDescendants,
          );
        await groupChanged(tx, groupId, actor, "grant_changed", {
          ...(folder ? { folderId: id } : { resourceId: id }),
          role: input.role,
        });
        return { ok: true, pending: !!requiresAcceptance };
      });
    },
    respond(
      actor: Actor,
      groupId: string,
      invitationId: string,
      accept: boolean,
    ) {
      return transact(db, async (tx) => {
        const group = await requireGroup(tx, actor, groupId, true);
        const invitation = await tx
          .selectFrom("group_resource_invitations")
          .selectAll()
          .where("id", "=", invitationId)
          .where("group_id", "=", groupId)
          .executeTakeFirst();
        if (
          !invitation ||
          invitation.state !== "pending" ||
          invitation.expires_at <= new Date().toISOString()
        )
          return groupError(404, "unavailable");
        await touchGroup(tx, groupId, group.revision);
        if (accept) {
          const issuer = await tx
            .selectFrom("users")
            .select(["id", "display_name", "admin"])
            .where("id", "=", invitation.invited_by)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (!issuer) return groupError(404, "unavailable");
          const folder = !!invitation.folder_id,
            id = invitation.folder_id ?? invitation.resource_id!;
          const access = await targetAccess(tx, issuer, id, folder),
            current = await currentGrant(tx, issuer, id, groupId, folder);
          if (
            !access.owner &&
            (rank(invitation.role) >= 4 || current.rank >= 4)
          )
            return groupError(403, "forbidden");
          await lockTarget(tx, id, folder, access.revision);
          await requireCapability(tx, issuer.id, "sharing.invite");
          await requireCapability(tx, access.ownerId, "sharing.invite");
          if (!folder)
            for (const userId of await groupMemberIds(tx, groupId))
              await checkMemberAdmission(tx, id, userId);
          await writeGrant(
            tx,
            issuer,
            id,
            groupId,
            folder,
            invitation.role,
            !!invitation.include_descendants,
          );
        }
        await tx
          .updateTable("group_resource_invitations")
          .set({
            state: accept ? "accepted" : "rejected",
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", invitationId)
          .where("state", "=", "pending")
          .execute();
        await groupChanged(
          tx,
          groupId,
          actor,
          accept
            ? "resource_invitation_accepted"
            : "resource_invitation_rejected",
        );
        return { ok: true };
      });
    },
  };
}
