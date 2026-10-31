import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { sql } from "kysely";
import type { DB } from "@db/index.js";
import type { GroupRole } from "@db/groups-types.js";
import { transact } from "@db/transactions.js";
import { fail } from "../../shared/errors.js";
import type { Actor } from "../identity/passwords.js";
import { tokenHash } from "../identity/passwords.js";
import { securityAudit } from "../identity/accounts.js";
import { activeActor } from "../access/queries.js";
import { touchAccess } from "../access/invitations.js";
import { checkMemberAdmission } from "../access/operation-policy.js";
import { createUserDirectory } from "../discovery/users.js";
import { emitIntegrationEvent } from "../automation/events.js";
import { enqueueProjection } from "../automation/jobs.js";
import { enqueueKnowledge } from "../knowledge/service.js";

export const groupError = (
  status: number,
  code:
    | "invalid"
    | "unavailable"
    | "forbidden"
    | "conflict"
    | "owner"
    | "directory"
    | "scope",
): never => fail(status, `group_${code}`, { code: `group_${code}` });
const now = () => new Date().toISOString();
const expiry = () => new Date(Date.now() + 7 * 86400000).toISOString();

export async function requireGroup(
  db: DB,
  actor: Actor,
  id: string,
  manage = false,
) {
  await activeActor(db, actor);
  const group = await db
    .selectFrom("user_groups as g")
    .innerJoin("user_group_members as m", "m.group_id", "g.id")
    .selectAll("g")
    .select("m.role")
    .where("g.id", "=", id)
    .where("m.user_id", "=", actor.id)
    .where("g.dissolved_at", "is", null)
    .executeTakeFirst();
  if (!group) return groupError(404, "unavailable");
  if (manage && group.role === "member") return groupError(403, "forbidden");
  return group;
}
export async function touchGroup(db: DB, id: string, revision: number) {
  const result = await db
    .updateTable("user_groups")
    .set({ revision: revision + 1, updated_at: now() })
    .where("id", "=", id)
    .where("revision", "=", revision)
    .where("dissolved_at", "is", null)
    .executeTakeFirst();
  if (!result.numUpdatedRows) groupError(409, "conflict");
}
async function issuerAllowed(db: DB, id: string, userId: string) {
  return !!(await db
    .selectFrom("user_group_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select("m.user_id")
    .where("m.group_id", "=", id)
    .where("m.user_id", "=", userId)
    .where("m.role", "in", ["owner", "admin"])
    .where("u.status", "=", "active")
    .executeTakeFirst());
}

/** Membership updates invalidate every affected projection without copying ACL rows. */
export async function groupChanged(
  db: DB,
  groupId: string,
  actor: Actor,
  action: string,
  details: {
    resourceId?: string;
    folderId?: string;
    userId?: string;
    role?: string | null;
  } = {},
) {
  const resources = await sql<{ id: string }>`with recursive affected as (
    select r.id from resources r where r.id=${details.resourceId ?? ""} or exists(select 1 from resource_group_grants gg where gg.resource_id=r.id and gg.group_id=${groupId})
    union select r.id from resources r join affected a on r.parent_id=a.id or r.library_id=a.id
  ) select id from affected`.execute(db);
  for (const { id } of resources.rows) {
    await touchAccess(db, id);
    await emitIntegrationEvent(db, "resource.permissions_changed", {
      resourceId: id,
      groupId,
      actorId: actor.id,
    });
  }
  const files = await sql<{ id: string }>`with recursive affected as (
    select f.id from file_folders f where f.id=${details.folderId ?? ""} or exists(select 1 from file_folder_group_grants gg where gg.folder_id=f.id and gg.group_id=${groupId})
    union select f.id from file_folders f join affected a on f.parent_id=a.id
  ) select f.id from file_items f join affected a on f.parent_type='folder' and f.parent_id=a.id`.execute(
    db,
  );
  for (const { id } of files.rows) {
    await enqueueProjection(db, "search-file", id, { fileId: id });
    await enqueueKnowledge(db, "file", id);
  }
  await emitIntegrationEvent(db, "group.changed", {
    groupId,
    action,
    actorId: actor.id,
  });
  const folders = await db
    .selectFrom("file_folder_group_grants")
    .select("folder_id")
    .where("group_id", "=", groupId)
    .execute();
  const folderIds = [
    ...new Set([
      ...folders.map((f) => f.folder_id),
      ...(details.folderId ? [details.folderId] : []),
    ]),
  ];
  if (folderIds.length)
    await db
      .updateTable("file_folders")
      .set((eb) => ({ version: eb("version", "+", 1), updated_at: now() }))
      .where("id", "in", folderIds)
      .execute();
  await securityAudit(db, actor.id, null, `group.${action}`, {
    groupId,
    ...details,
  });
}
async function admit(db: DB, groupId: string, userId: string) {
  const grants = await db
    .selectFrom("resource_group_grants")
    .select("resource_id")
    .where("group_id", "=", groupId)
    .where("status", "=", "active")
    .execute();
  for (const grant of grants)
    await checkMemberAdmission(db, grant.resource_id, userId);
}
async function metadata(name: string, avatar: string | null) {
  name = name.trim();
  if (!name || name.length > 80) return groupError(400, "invalid");
  if (avatar !== null) {
    const encoded = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      avatar,
    )?.[1];
    if (!encoded || encoded.length > 400000) return groupError(400, "invalid");
    try {
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded)
        return groupError(400, "invalid");
      const image = sharp(bytes, {
        limitInputPixels: 256 * 256,
        failOn: "warning",
      });
      const meta = await image.metadata();
      if (meta.format !== "png" || (meta.pages ?? 1) !== 1)
        return groupError(400, "invalid");
      const png = await image.png().toBuffer();
      avatar = `data:image/png;base64,${png.toString("base64")}`;
    } catch {
      return groupError(400, "invalid");
    }
  }
  return { name, avatar };
}
async function projection(
  db: DB,
  group: {
    id: string;
    owner_id: string;
    name: string;
    avatar: string | null;
    revision: number;
  },
  role: GroupRole,
) {
  const owner = await db
    .selectFrom("users")
    .select(["id", "display_name", "public_id"])
    .where("id", "=", group.owner_id)
    .executeTakeFirstOrThrow();
  const count = await db
    .selectFrom("user_group_members")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("group_id", "=", group.id)
    .executeTakeFirstOrThrow();
  return {
    id: group.id,
    name: group.name,
    avatar: group.avatar,
    revision: group.revision,
    role,
    owner,
    memberCount: Number(count.n),
  };
}

export function createGroups(db: DB) {
  return {
    async list(actor: Actor) {
      await activeActor(db, actor);
      const rows = await db
        .selectFrom("user_groups as g")
        .innerJoin("user_group_members as m", "m.group_id", "g.id")
        .selectAll("g")
        .select("m.role")
        .where("m.user_id", "=", actor.id)
        .where("g.dissolved_at", "is", null)
        .orderBy("g.created_at", "desc")
        .orderBy("g.id")
        .execute();
      const invitations = await db
        .selectFrom("user_group_invitations as i")
        .innerJoin("user_groups as g", "g.id", "i.group_id")
        .innerJoin("users as u", "u.id", "i.invited_by")
        .select([
          "i.id",
          "i.group_id",
          "g.name",
          "g.avatar",
          "u.display_name as inviter_name",
        ])
        .where("i.user_id", "=", actor.id)
        .where("i.state", "=", "pending")
        .where("i.expires_at", ">", now())
        .where("g.dissolved_at", "is", null)
        .execute();
      return {
        items: await Promise.all(rows.map((g) => projection(db, g, g.role))),
        invitations,
      };
    },
    async detail(actor: Actor, id: string) {
      const group = await requireGroup(db, actor, id);
      const members = await db
        .selectFrom("user_group_members as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .leftJoin("user_preferences as p", "p.user_id", "u.id")
        .select([
          "u.id",
          "u.display_name",
          "u.public_id",
          "m.role",
          "p.avatar",
          "p.avatar_asset_id",
        ])
        .where("m.group_id", "=", id)
        .orderBy("m.joined_at")
        .orderBy("u.id")
        .execute();
      const invitations =
        group.role === "member"
          ? []
          : await db
              .selectFrom("user_group_invitations as i")
              .innerJoin("users as u", "u.id", "i.user_id")
              .select([
                "u.id",
                "u.display_name",
                "u.public_id",
                "i.id as invitation_id",
              ])
              .where("i.group_id", "=", id)
              .where("i.state", "=", "pending")
              .where("i.expires_at", ">", now())
              .execute();
      const resourceInvitations =
        group.role === "member"
          ? []
          : await db
              .selectFrom("group_resource_invitations as i")
              .leftJoin("resources as r", "r.id", "i.resource_id")
              .leftJoin("file_folders as f", "f.id", "i.folder_id")
              .select([
                "i.id",
                "i.role",
                sql<string>`coalesce(r.title,f.name)`.as("title"),
              ])
              .where("i.group_id", "=", id)
              .where("i.state", "=", "pending")
              .where("i.expires_at", ">", now())
              .where((eb) =>
                eb.or([
                  eb.and([
                    eb("r.id", "is not", null),
                    eb("r.deleted_at", "is", null),
                  ]),
                  eb.and([
                    eb("f.id", "is not", null),
                    eb("f.deleted_at", "is", null),
                  ]),
                ]),
              )
              .execute();
      const storedLink =
        group.role === "member"
          ? undefined
          : await db
              .selectFrom("user_group_invite_links")
              .select(["expires_at", "invited_by"])
              .where("group_id", "=", id)
              .where("expires_at", ">", now())
              .executeTakeFirst();
      const inviteLink =
        storedLink && (await issuerAllowed(db, id, storedLink.invited_by))
          ? { expiresAt: storedLink.expires_at }
          : null;
      return {
        ...(await projection(db, group, group.role)),
        members,
        invitations,
        resourceInvitations,
        inviteLink,
      };
    },
    async create(actor: Actor, input: { name: string; avatar: string | null }) {
      const data = await metadata(input.name, input.avatar);
      return transact(db, async (tx) => {
        await activeActor(tx, actor);
        const id = randomUUID(),
          time = now();
        await tx
          .insertInto("user_groups")
          .values({
            id,
            owner_id: actor.id,
            ...data,
            revision: 1,
            dissolved_at: null,
            cleaned_at: null,
            created_at: time,
            updated_at: time,
          })
          .execute();
        await tx
          .insertInto("user_group_members")
          .values({
            group_id: id,
            user_id: actor.id,
            role: "owner",
            joined_at: time,
          })
          .execute();
        await groupChanged(tx, id, actor, "created");
        return { id };
      });
    },
    async update(
      actor: Actor,
      id: string,
      input: { revision: number; name: string; avatar: string | null },
    ) {
      const data = await metadata(input.name, input.avatar);
      return transact(db, async (tx) => {
        await requireGroup(tx, actor, id, true);
        await touchGroup(tx, id, input.revision);
        await tx
          .updateTable("user_groups")
          .set(data)
          .where("id", "=", id)
          .execute();
        await groupChanged(tx, id, actor, "updated");
        return { ok: true };
      });
    },
    invite(actor: Actor, id: string, userId: string, revision: number) {
      return transact(db, async (tx) => {
        await requireGroup(tx, actor, id, true);
        await touchGroup(tx, id, revision);
        try {
          await createUserDirectory(tx).validate(actor, { ids: [userId] });
        } catch {
          return groupError(403, "directory");
        }
        if (
          await tx
            .selectFrom("user_group_members")
            .select("user_id")
            .where("group_id", "=", id)
            .where("user_id", "=", userId)
            .executeTakeFirst()
        )
          return groupError(409, "conflict");
        await tx
          .updateTable("user_group_invitations")
          .set({ state: "cancelled", updated_at: now() })
          .where("group_id", "=", id)
          .where("user_id", "=", userId)
          .where("state", "=", "pending")
          .execute();
        const invitationId = randomUUID();
        await tx
          .insertInto("user_group_invitations")
          .values({
            id: invitationId,
            group_id: id,
            user_id: userId,
            invited_by: actor.id,
            state: "pending",
            expires_at: expiry(),
            created_at: now(),
            updated_at: now(),
          })
          .execute();
        await groupChanged(tx, id, actor, "invited", { userId });
        return { id: invitationId };
      });
    },
    respond(actor: Actor, invitationId: string, accept: boolean) {
      return transact(db, async (tx) => {
        await activeActor(tx, actor);
        const invite = await tx
          .selectFrom("user_group_invitations")
          .selectAll()
          .where("id", "=", invitationId)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        if (
          !invite ||
          invite.state !== "pending" ||
          invite.expires_at <= now() ||
          !(await issuerAllowed(tx, invite.group_id, invite.invited_by))
        )
          return groupError(404, "unavailable");
        const group = await tx
          .selectFrom("user_groups")
          .selectAll()
          .where("id", "=", invite.group_id)
          .where("dissolved_at", "is", null)
          .executeTakeFirst();
        if (!group) return groupError(404, "unavailable");
        await touchGroup(tx, group.id, group.revision);
        if (accept) {
          await admit(tx, group.id, actor.id);
          await tx
            .insertInto("user_group_members")
            .values({
              group_id: group.id,
              user_id: actor.id,
              role: "member",
              joined_at: now(),
            })
            .onConflict((oc) => oc.columns(["group_id", "user_id"]).doNothing())
            .execute();
        }
        await tx
          .updateTable("user_group_invitations")
          .set({ state: accept ? "accepted" : "rejected", updated_at: now() })
          .where("id", "=", invitationId)
          .where("state", "=", "pending")
          .execute();
        await groupChanged(tx, group.id, actor, accept ? "joined" : "declined");
        return { id: group.id };
      });
    },
    cancelInvite(
      actor: Actor,
      id: string,
      invitationId: string,
      revision: number,
    ) {
      return transact(db, async (tx) => {
        await requireGroup(tx, actor, id, true);
        await touchGroup(tx, id, revision);
        await tx
          .updateTable("user_group_invitations")
          .set({ state: "cancelled", updated_at: now() })
          .where("id", "=", invitationId)
          .where("group_id", "=", id)
          .where("state", "=", "pending")
          .execute();
        await groupChanged(tx, id, actor, "invitation_cancelled");
        return { ok: true };
      });
    },
    link(actor: Actor, id: string, revision: number, revoke = false) {
      return transact(db, async (tx) => {
        await requireGroup(tx, actor, id, true);
        await touchGroup(tx, id, revision);
        await tx
          .deleteFrom("user_group_invite_links")
          .where("group_id", "=", id)
          .execute();
        const token = randomBytes(32).toString("base64url"),
          expiresAt = expiry();
        if (!revoke)
          await tx
            .insertInto("user_group_invite_links")
            .values({
              group_id: id,
              token_hash: tokenHash(token),
              invited_by: actor.id,
              expires_at: expiresAt,
            })
            .execute();
        await groupChanged(
          tx,
          id,
          actor,
          revoke ? "link_revoked" : "link_created",
        );
        return { url: `/#/groups/join?token=${token}`, expiresAt };
      });
    },
    async previewLink(actor: Actor, token: string) {
      await activeActor(db, actor);
      const row = await db
        .selectFrom("user_group_invite_links as link")
        .innerJoin("user_groups as g", "g.id", "link.group_id")
        .selectAll("g")
        .select(["link.invited_by", "link.expires_at"])
        .where("link.token_hash", "=", tokenHash(token))
        .where("link.expires_at", ">", now())
        .where("g.dissolved_at", "is", null)
        .executeTakeFirst();
      if (!row || !(await issuerAllowed(db, row.id, row.invited_by)))
        return groupError(404, "unavailable");
      const count = await db
        .selectFrom("user_group_members")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("group_id", "=", row.id)
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        memberCount: Number(count.n),
      };
    },
    join(actor: Actor, token: string) {
      return transact(db, async (tx) => {
        const service = createGroups(tx);
        const preview = await service.previewLink(actor, token);
        const group = await tx
          .selectFrom("user_groups")
          .selectAll()
          .where("id", "=", preview.id)
          .executeTakeFirstOrThrow();
        await touchGroup(tx, group.id, group.revision);
        const existing = await tx
          .selectFrom("user_group_members")
          .select("user_id")
          .where("group_id", "=", group.id)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        if (!existing) {
          await admit(tx, group.id, actor.id);
          await tx
            .insertInto("user_group_members")
            .values({
              group_id: group.id,
              user_id: actor.id,
              role: "member",
              joined_at: now(),
            })
            .execute();
        }
        await tx
          .updateTable("user_group_invitations")
          .set({ state: "accepted", updated_at: now() })
          .where("group_id", "=", group.id)
          .where("user_id", "=", actor.id)
          .where("state", "=", "pending")
          .execute();
        await groupChanged(tx, group.id, actor, "joined");
        return { id: group.id };
      });
    },
    member(
      actor: Actor,
      id: string,
      userId: string,
      revision: number,
      role: "admin" | "member" | null,
    ) {
      return transact(db, async (tx) => {
        const group = await requireGroup(tx, actor, id, true);
        await touchGroup(tx, id, revision);
        const target = await tx
          .selectFrom("user_group_members")
          .selectAll()
          .where("group_id", "=", id)
          .where("user_id", "=", userId)
          .executeTakeFirst();
        if (
          !target ||
          target.role === "owner" ||
          actor.id === userId ||
          (group.role !== "owner" &&
            (target.role !== "member" || role !== null))
        )
          return groupError(403, "forbidden");
        if (role)
          await tx
            .updateTable("user_group_members")
            .set({ role })
            .where("group_id", "=", id)
            .where("user_id", "=", userId)
            .execute();
        else
          await tx
            .deleteFrom("user_group_members")
            .where("group_id", "=", id)
            .where("user_id", "=", userId)
            .execute();
        await groupChanged(
          tx,
          id,
          actor,
          role ? "role_changed" : "member_removed",
          { userId, role },
        );
        return { ok: true };
      });
    },
    leave(actor: Actor, id: string, revision: number) {
      return transact(db, async (tx) => {
        const group = await requireGroup(tx, actor, id);
        if (group.role === "owner") return groupError(409, "owner");
        await touchGroup(tx, id, revision);
        await tx
          .deleteFrom("user_group_members")
          .where("group_id", "=", id)
          .where("user_id", "=", actor.id)
          .execute();
        await groupChanged(tx, id, actor, "left");
        return { ok: true };
      });
    },
    transfer(actor: Actor, id: string, userId: string, revision: number) {
      return transact(db, async (tx) => {
        const group = await requireGroup(tx, actor, id);
        if (group.role !== "owner" || userId === actor.id)
          return groupError(403, "forbidden");
        await touchGroup(tx, id, revision);
        const target = await tx
          .selectFrom("user_group_members as m")
          .innerJoin("users as u", "u.id", "m.user_id")
          .select("m.user_id")
          .where("m.group_id", "=", id)
          .where("m.user_id", "=", userId)
          .where("u.status", "=", "active")
          .executeTakeFirst();
        if (!target) return groupError(400, "invalid");
        await tx
          .updateTable("user_group_members")
          .set({ role: "member" })
          .where("group_id", "=", id)
          .where("user_id", "=", actor.id)
          .execute();
        await tx
          .updateTable("user_group_members")
          .set({ role: "owner" })
          .where("group_id", "=", id)
          .where("user_id", "=", userId)
          .execute();
        await tx
          .updateTable("user_groups")
          .set({ owner_id: userId })
          .where("id", "=", id)
          .execute();
        await groupChanged(tx, id, actor, "transferred", { userId });
        return { ok: true };
      });
    },
    dissolve(actor: Actor, id: string, revision: number) {
      return transact(db, async (tx) => {
        const group = await requireGroup(tx, actor, id);
        if (group.role !== "owner") return groupError(403, "forbidden");
        await touchGroup(tx, id, revision);
        await tx
          .updateTable("user_groups")
          .set({ dissolved_at: now() })
          .where("id", "=", id)
          .execute();
        await groupChanged(tx, id, actor, "dissolved");
        return { ok: true };
      });
    },
  };
}

/** Hourly/startup cleanup after a 24-hour retention window; tombstones and security audit stay. */
export async function cleanupDissolvedGroups(
  db: DB,
  cutoff = new Date(Date.now() - 86400000).toISOString(),
) {
  return transact(db, async (tx) => {
    const groups = await tx
      .selectFrom("user_groups")
      .select("id")
      .where("dissolved_at", "<=", cutoff)
      .where("cleaned_at", "is", null)
      .orderBy("dissolved_at")
      .limit(100)
      .execute();
    for (const { id } of groups) {
      for (const table of [
        "resource_group_grants",
        "file_folder_group_grants",
        "group_resource_invitations",
        "user_group_invitations",
        "user_group_invite_links",
        "user_group_members",
      ] as const)
        await tx.deleteFrom(table).where("group_id", "=", id).execute();
      await tx
        .updateTable("user_groups")
        .set({ cleaned_at: now() })
        .where("id", "=", id)
        .execute();
    }
    return groups.length;
  });
}
