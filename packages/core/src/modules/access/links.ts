import { effectiveResource } from "./inheritance.js";
import { distributionPolicy } from "../deployment/policies.js";
import { sql, type Transaction } from "kysely";
import { requireCapability } from "../access/operation-policy.js";
import { checkMemberAdmission } from "../access/operation-policy.js";
import { isResourceOwnerLike, label, namedPermission, permission, ranks } from "./policy.js";
import { canChangeMemberRole } from "./roles.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { recordAudit } from "../audit/events.js";
import { setEntry } from "../discovery/entries.js";
import { tokenHash, type Actor } from "../identity/passwords.js";
import { activeActor, authorize, loadResources } from "./queries.js";
import { effectiveGrants } from "./grants.js";
import { expiry, touchAccess } from "./invitations.js";
import { emitIntegrationEvent } from "../automation/events.js";
type LinkRole = Schema["grants"]["role"];
export function createShareLinks(db: DB) {
  async function memberCount(
    tx: DB | Transaction<Schema>,
    resourceId: string,
    generation: string,
  ) {
    const row = await tx
      .selectFrom("grants")
      .select(sql<number>`count(*)`.as("member_count"))
      .where("resource_id", "=", resourceId)
      .where("source_type", "=", "link")
      .where("source_id", "=", generation)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    return Number(row.member_count);
  }

  return {
    async share(actor: Actor, id: string) {
      const ctx = await authorize(db, actor, id, "manage_sharing");
      const resource = effectiveResource(ctx.resource, ctx.resources);
      const supportsDescendants =
        resource.kind === "library" || !!resource.library_id;
      const links = await db
        .selectFrom("share_links")
        .selectAll()
        .where("resource_id", "=", id)
        .orderBy("created_at", "desc")
        .execute();
      const items = await Promise.all(
        links.map(async (l) => {
          let memberIds: string[] = [];
          if (l.revoked) {
            const revoked = await db
              .selectFrom("share_link_revocations")
              .select("revoked_user_ids")
              .where("resource_id", "=", id)
              .where("share_id", "=", l.generation)
              .executeTakeFirst();
            try {
              const parsed = revoked ? JSON.parse(revoked.revoked_user_ids) : [];
              memberIds = Array.isArray(parsed)
                ? parsed.filter((value): value is string => typeof value === "string")
                : [];
            } catch {
              memberIds = [];
            }
          } else {
            memberIds = (
              await db
                .selectFrom("grants")
                .select("user_id")
                .where("resource_id", "=", id)
                .where("source_type", "=", "link")
                .where("source_id", "=", l.generation)
                .where("status", "=", "active")
                .execute()
            ).map((member) => member.user_id);
          }
          const members = memberIds.length
            ? await db
                .selectFrom("users")
                .select(["id", "display_name", "public_id"])
                .where("id", "in", memberIds)
                .orderBy("display_name", "asc")
                .execute()
            : [];
          return {
            id: l.generation,
            enabled: !!l.enabled,
            role: l.role,
            includeDescendants:
              supportsDescendants && l.include_descendants !== 0,
            maxMembers: l.max_members ?? null,
            memberCount: members.length,
            members,
            revoked: !!l.revoked,
            revokedAt: l.revoked_at ?? null,
            version: l.revision,
            token: l.enabled ? l.token : null,
            expiresAt: l.expires_at ?? null,
            createdBy: l.created_by,
            expired: !!l.expires_at && l.expires_at <= new Date().toISOString(),
          };
        }),
      );
      const activeItems = items.filter((item) => !item.revoked);
      const revokedItems = items.filter((item) => item.revoked);
      return {
        ...(activeItems[0] ?? {
          enabled: false,
          role: "reader",
          version: null,
          token: null,
          maxMembers: 1,
          memberCount: 0,
          members: [],
          revoked: false,
          revokedAt: null,
        }),
        items: activeItems,
        revokedItems,
        sharingEnabled: !!resource.share_links_enabled,
        supportsDescendants,
      };
    },
    setShareEnabled(actor: Actor, id: string, enabled: boolean) {
      return transact(db, async (tx) => {
        await authorize(tx, actor, id, "manage_sharing");
        if (enabled) {
          const resource = await tx
            .selectFrom("resources")
            .select("owner_id")
            .where("id", "=", id)
            .executeTakeFirstOrThrow();
          await requireCapability(tx, actor.id, "sharing.links");
          await requireCapability(
            tx,
            resource.owner_id,
            "sharing.links",
          );

        }
        await tx
          .updateTable("resources")
          .set({
            share_links_enabled: Number(enabled),
            permission_overrides: sql<number>`permission_overrides | 32`,
          })
          .where("id", "=", id)
          .execute();
        await touchAccess(tx, id);
        await recordAudit(
          tx,
          actor,
          id,
          enabled
            ? "resource.link_sharing_enabled"
            : "resource.link_sharing_disabled",
        );
        await emitIntegrationEvent(tx, "resource.link_changed", {
          resourceId: id,
          actorId: actor.id,
        });
        return { sharingEnabled: enabled };
      });
    },
    setShare(
      actor: Actor,
      id: string,
      input: {
        enabled: boolean;
        role: LinkRole;
        version: string | null;
        expiresAt?: string | null;
        includeDescendants?: boolean;
        maxMembers?: number | null;
      },
    ) {
      return transact(db, async (tx) => {
        const ctx = await authorize(tx, actor, id, "manage_sharing");
        if (!["reader", "commenter", "editor", "manager"].includes(input.role))
          fail(400, "链接角色无效");
        if (
          input.maxMembers !== undefined &&
          input.maxMembers !== null &&
          (!Number.isInteger(input.maxMembers) || input.maxMembers < 1)
        )
          fail(400, "分享链接人数必须是正整数或无限人数");
        const resource = await tx
          .selectFrom("resources")
          .select(["owner_id", "share_links_enabled", "kind", "library_id"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        const old = input.version
          ? await tx
              .selectFrom("share_links")
              .selectAll()
              .where("resource_id", "=", id)
              .where("revision", "=", input.version)
              .executeTakeFirst()
          : null;
        if (input.version && !old) fail(409, "链接已变化，请刷新");
        if (!canChangeMemberRole(
          isResourceOwnerLike(ctx.resource, actor, ctx.resources) ? "owner" : label(ctx.rank),
          old?.role ?? null,
          input.role,
        ))
          fail(403, "只有所有者可以调整管理权限链接");
        if (old?.revoked) fail(409, "链接已撤销，不能重新启用");
        if (!old && !input.enabled) fail(400, "请选择要停用的链接");
        const supportsDescendants =
          resource.kind === "library" || !!resource.library_id;
        const maxMembers =
          input.maxMembers === undefined
            ? old
              ? old.max_members
              : 1
            : input.maxMembers;
        if (
          input.enabled &&
          (!resource.share_links_enabled ||
            !old?.enabled ||
            ranks[input.role] > ranks[old.role] ||
            (input.expiresAt === null && !!old.expires_at) ||
            (input.expiresAt &&
              old.expires_at &&
              input.expiresAt > old.expires_at))
        ) {
          await requireCapability(tx, actor.id, "sharing.links");
          await requireCapability(
            tx,
            resource.owner_id,
            "sharing.links",
          );

        }
        const token = old?.token ?? randomBytes(32).toString("base64url");
        const row = {
          resource_id: id,
          token,
          token_hash: tokenHash(token),
          generation: old?.generation ?? randomUUID(),
          revision: randomUUID(),
          role: input.role,
          include_descendants: Number(
            supportsDescendants &&
              (input.includeDescendants ?? old?.include_descendants !== 0),
          ),
          max_members: maxMembers,
          enabled: Number(input.enabled),
          expires_at:
            input.expiresAt === undefined
              ? (old?.expires_at ?? null)
              : expiry(input.expiresAt),
          created_by: old?.created_by ?? actor.id,
          created_at: old?.created_at ?? new Date().toISOString(),
        };
        await tx
          .insertInto("share_links")
          .values(row)
          .onConflict((oc) => oc.column("generation").doUpdateSet(row))
          .execute();
        if (input.enabled)
          await tx
            .updateTable("resources")
            .set({
              share_links_enabled: 1,
              permission_overrides: sql<number>`permission_overrides | 32`,
            })
            .where("id", "=", id)
            .execute();
        await touchAccess(tx, id);
        await recordAudit(
          tx,
          actor,
          id,
          input.enabled ? "resource.link_enabled" : "resource.link_disabled",
        );
        await emitIntegrationEvent(tx, "resource.link_changed", {
          resourceId: id,
          actorId: actor.id,
        });
        return {
          id: row.generation,
          enabled: input.enabled,
          role: row.role,
          includeDescendants:
            supportsDescendants && row.include_descendants !== 0,
          maxMembers: row.max_members ?? null,
          memberCount: await memberCount(tx, id, row.generation),
          members: [],
          revoked: false,
          revokedAt: null,
          version: row.revision,
          token: input.enabled ? token : null,
          expiresAt: row.expires_at,
        };
      });
    },
    revokeShare(actor: Actor, id: string, linkId: string, version: string) {
      return transact(db, async (tx) => {
        const ctx = await authorize(tx, actor, id, "manage_sharing");
        const link = await tx
          .selectFrom("share_links")
          .selectAll()
          .where("resource_id", "=", id)
          .where("generation", "=", linkId)
          .executeTakeFirst();
        if (!link) fail(404, "链接不存在");
        if (!canChangeMemberRole(
          isResourceOwnerLike(ctx.resource, actor, ctx.resources) ? "owner" : label(ctx.rank),
          link.role,
          null,
        ))
          fail(403, "只有所有者可以撤销管理权限链接");
        if (link.revision !== version) fail(409, "链接已变化，请刷新");
        const members = await tx
          .selectFrom("grants")
          .select(["user_id", "role"])
          .where("resource_id", "=", id)
          .where("source_type", "=", "link")
          .where("source_id", "=", linkId)
          .where("status", "=", "active")
          .execute();
        if (members.some((member) => !canChangeMemberRole(
          isResourceOwnerLike(ctx.resource, actor, ctx.resources) ? "owner" : label(ctx.rank),
          member.role,
          null,
        )))
          fail(403, "只有所有者可以撤销管理权限来源");
        const revokedAt = new Date().toISOString();
        await tx
          .insertInto("share_link_revocations")
          .values({
            resource_id: id,
            share_id: linkId,
            revoked_by: actor.id,
            revoked_at: revokedAt,
            revoked_user_ids: JSON.stringify(members.map((member) => member.user_id)),
          })
          .onConflict((oc) => oc.columns(["resource_id", "share_id"]).doUpdateSet({
            revoked_by: actor.id,
            revoked_at: revokedAt,
            revoked_user_ids: JSON.stringify(members.map((member) => member.user_id)),
          }))
          .execute();
        await tx
          .deleteFrom("grants")
          .where("resource_id", "=", id)
          .where("source_type", "=", "link")
          .where("source_id", "=", linkId)
          .execute();
        await tx
          .updateTable("share_links")
          .set({
            enabled: 0,
            revoked: 1,
            revoked_at: revokedAt,
            revision: randomUUID(),
          })
          .where("generation", "=", linkId)
          .execute();
        await touchAccess(tx, id);
        await recordAudit(tx, actor, id, "resource.link_members_revoked");
        await emitIntegrationEvent(tx, "resource.permissions_changed", {
          resourceId: id,
          actorId: actor.id,
        });
        return { ok: true };
      });
    },
    redeem(actor: Actor, token: string, accept = true, consume = true) {
      return transact(db, async (tx) => {
        await activeActor(tx, actor);
        const link = await tx
          .selectFrom("share_links")
          .selectAll()
          .where("token_hash", "=", tokenHash(token))
          .where("enabled", "=", 1)
          .executeTakeFirst();
        if (
          !link ||
          (link.expires_at && link.expires_at <= new Date().toISOString())
        )
          fail(404, "邀请链接已关闭或过期");
        const revoked = await tx
          .selectFrom("share_link_revocations")
          .select("share_id")
          .where("resource_id", "=", link.resource_id)
          .where("share_id", "=", link.generation)
          .executeTakeFirst();
        if (link.revoked || revoked) fail(404, "邀请链接已撤销");
        const r = await tx
          .selectFrom("resources")
          .selectAll()
          .where("id", "=", link.resource_id)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
        if (
          !r ||
                !effectiveResource(r, await loadResources(tx, [r.id]))
            .share_links_enabled ||
          (r.library_id &&
            (
              await tx
                .selectFrom("resources")
                .select("deleted_at")
                .where("id", "=", r.library_id)
                .executeTakeFirst()
            )?.deleted_at)
        )
          fail(404, "文档不存在");
        if (!["reader", "commenter", "editor", "manager"].includes(link.role))
          fail(403, "链接角色无效");
        const policy = await distributionPolicy(tx, r.kind);
        const existing = await tx
          .selectFrom("grants")
          .selectAll()
          .where("resource_id", "=", r.id)
          .where("user_id", "=", actor.id)
          .where("source_type", "=", "link")
          .where("source_id", "=", link.generation)
          .where("status", "=", "active")
          .executeTakeFirst();
        const resources = await loadResources(tx, [r.id]);
        const grants = await effectiveGrants(
          tx,
          resources.map((resource) => resource.id),
        );
        const currentRole = permission(r, actor, resources, grants);
        const currentDescendantRole = namedPermission(
          r,
          actor,
          resources,
          grants,
          true,
        );
        const linkRole = ranks[link.role];
        const linkDescendantRole = link.include_descendants === 0 ? 0 : linkRole;
        const alreadyCovered =
          currentRole >= linkRole && currentDescendantRole >= linkDescendantRole;
        if (!existing && alreadyCovered && !consume)
          return {
            alreadyHasAccess: true as const,
            id: r.id,
            role: label(currentRole),
            linkRole: link.role,
            includeDescendants: link.include_descendants !== 0,
          };
        const currentMembers = await memberCount(tx, r.id, link.generation);
        if (
          !existing &&
          link.max_members !== null &&
          currentMembers >= (link.max_members ?? 1)
        )
          fail(403, "分享链接人数已满");
        if (policy.grantMode === "invite" && !existing && !accept)
          return {
            pending: true as const,
            id: r.id,
            title: r.title,
            kind: r.kind,
            role: link.role,
          };
        await checkMemberAdmission(tx, r.id, actor.id);
        await tx
          .insertInto("grants")
          .values({
            resource_id: r.id,
            user_id: actor.id,
            source_type: "link",
            source_id: link.generation,
            source_resource_id: null,
            role: link.role,
            include_descendants: link.include_descendants ?? 1,
            status: "active",
            created_by: link.created_by ?? null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.columns(["resource_id", "user_id", "source_type", "source_id"]).doNothing(),
          )
          .execute();
        await setEntry(tx, actor, r.id, "joined", "link");
        await touchAccess(tx, r.id);
        await emitIntegrationEvent(tx, "resource.link_joined", {
          resourceId: r.id,
          userId: actor.id,
        });
        return { id: r.id };
      });
    },
  };
}
