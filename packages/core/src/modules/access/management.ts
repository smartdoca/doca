import {
  effectiveResource,
  policyFields,
  type PolicyField,
} from "./inheritance.js";
import { checkPublication } from "../entitlements/admission.js";
import type { DB, Resource } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { distributionPolicy } from "../deployment/policies.js";
import type { Actor } from "../identity/passwords.js";
import { validateNewMentions } from "../interactions/community.js";
import {
  check,
  createResourceRunner,
  event,
  get,
  update,
  type Context,
} from "../resources/context.js";
import { replaceInvitations, invitationState, touchAccess } from "./invitations.js";
import {
  permission,
  namedPermission,
  ranks,
  label,
  isResourceOwnerLike,
  type Grant,
} from "./policy.js";
type Input = {
  version: number;
  accessMode?: Resource["access_mode"];
  visibility?: Resource["visibility"];
  requestsEnabled?: boolean;
  publicRole?: "reader" | "commenter" | "editor";
  discoverable?: boolean;
  historyReaders?: boolean;
  grants?: {
    userId: string;
    role: Grant["role"];
    includeDescendants?: boolean;
  }[];
  invitationMessage?: string;
  resetFields?: PolicyField[];
  directUserId?: string;
  directUserIds?: string[];
};
export function createAccessManagement(
  db: DB,
  run: ReturnType<typeof createResourceRunner>,
) {
  async function apply(ctx: Context, actor: Actor, id: string, input: Input) {
    const r = get(ctx, id, "manage_sharing");
    check(r, input.version);
    const supportsDescendants = r.kind === "library" || !!r.library_id;
    const actorOwnsResource = isResourceOwnerLike(r, actor, ctx.resources);
    const mode = input.accessMode ?? r.access_mode;
    const fields: Partial<Resource> = {};
    let overrides = r.permission_overrides ?? 0;
    const mapping = {
      visibility: "visibility",
      publicRole: "public_role",
      requestsEnabled: "requests_enabled",
      discoverable: "discoverable",
      historyReaders: "history_readers",
    } as const;
    for (const [key, field] of Object.entries(mapping)) {
      const value = input[key as keyof typeof mapping];
      if (value === undefined) continue;
      Object.assign(fields, {
        [field]:
          typeof value === "boolean"
            ? Number(value)
            : value === "requestable"
              ? "invited"
              : value,
      });
      overrides |= policyFields[field];
    }
    if (
      input.visibility === "requestable" &&
      input.requestsEnabled === undefined
    ) {
      fields.requests_enabled = 1;
      overrides |= policyFields.requests_enabled;
    }
    for (const field of input.resetFields ?? []) {
      if (!(field in policyFields)) fail(400, "未知权限字段");
      overrides &= ~policyFields[field];
      // Clearing an override restores standalone defaults too.
      Object.assign(fields, {
        [field]:
          field === "visibility"
            ? "invited"
            : field === "public_role"
              ? "reader"
              : field === "requests_enabled" || field === "share_links_enabled"
                ? 1
                : 0,
      });
    }
    const before = effectiveResource(r, ctx.resources);
    const after = effectiveResource(
      { ...r, ...fields, access_mode: mode, permission_overrides: overrides },
      ctx.resources,
    );
    if (
      { invited: 0, requestable: 0, authenticated: 1, public: 2 }[
        after.visibility
      ] >
        { invited: 0, requestable: 0, authenticated: 1, public: 2 }[
          before.visibility
        ] ||
      ranks[after.public_role ?? "reader"] >
        ranks[before.public_role ?? "reader"]
    )
      await checkPublication(ctx.tx, actor.id, r.owner_id, after.visibility);
    if (mode === "inherit" && !r.parent_id && !r.library_id)
      fail(400, "根资源不能继承权限");
    const current = await ctx.tx
      .selectFrom("grants")
      .selectAll()
      .where("resource_id", "=", id)
      .where("source_type", "=", "direct")
      .where("source_id", "=", "")
      .where("status", "=", "active")
      .execute();
    const pending = (
      await ctx.tx
        .selectFrom("access_invitations")
        .selectAll()
        .where("resource_id", "=", id)
        .execute()
    ).filter((i) => invitationState(i) === "pending");
    const desired = input.grants?.map((grant) => ({
      ...grant,
      includeDescendants: supportsDescendants
        ? grant.includeDescendants
        : false,
    }));
    if (desired) {
      const ids = desired.map((g) => g.userId);
      if (new Set(ids).size !== ids.length) fail(400, "协作者重复");
      if (ids.includes(r.owner_id)) fail(403, "不能修改所有者权限");
      await validateNewMentions(
        ctx.tx,
        actor,
        new Set(ids),
        new Set([...current, ...pending].map((g) => g.user_id)),
      );
      if (
        ids.length &&
        (
          await ctx.tx
            .selectFrom("users")
            .select("id")
            .where("id", "in", ids)
            .where("status", "=", "active")
            .execute()
        ).length !== ids.length
      )
        fail(400, "协作者不存在或已停用");
      for (const userId of new Set([
        ...ids,
        ...current.map((g) => g.user_id),
        ...pending.map((g) => g.user_id),
      ])) {
        const target = desired.find((g) => g.userId === userId),
          before =
            pending.find((g) => g.user_id === userId)?.role ??
            current.find((g) => g.user_id === userId)?.role;
        if (
          before === target?.role &&
          (current.find((g) => g.user_id === userId)?.include_descendants ??
            1) === Number(target?.includeDescendants ?? true)
        )
          continue;
        const effective = permission(
          r,
          { id: userId, display_name: "", admin: 0 },
          ctx.resources,
          ctx.grants,
        );
        if (
          !actorOwnsResource &&
          (effective >= 4 || before === "manager" || target?.role === "manager")
        )
          fail(403, "只有所有者可以调整管理权限");
      }
    }
    if (!actorOwnsResource && mode !== r.access_mode)
      fail(403, "只有所有者可以切换权限继承，避免改变管理权限");
    if (
      input.publicRole &&
      !["reader", "commenter", "editor"].includes(input.publicRole)
    )
      fail(400, "公开权限不能设置为管理");
    const policy = await distributionPolicy(ctx.tx, r.kind);
    const recipients = desired
      ? await replaceInvitations(
          ctx.tx,
          id,
          desired,
          policy.grantMode,
          actor,
          input.invitationMessage,
          input.directUserId,
          input.directUserIds ?? current.map((g) => g.user_id),
        )
      : { invited: [], direct: [] };
    await update(ctx, r, {
      ...fields,
      access_mode: mode,
      permission_overrides: overrides,
      authz_revision: (r.authz_revision ?? 1) + 1,
    });
    if (recipients.invited.length)
      await event(ctx, r, "resource.invited", recipients.invited);
    if (recipients.direct.length || !recipients.invited.length)
      await event(ctx, r, "resource.permissions_changed", recipients.direct);
    return { ok: true };
  }
  return {
    permissions(actor: Actor, id: string, input: Input) {
      return run(actor, [id], (ctx) => apply(ctx, actor, id, input));
    },
    member(
      actor: Actor,
      id: string,
      userId: string,
      input: {
        revision: number;
        role: Grant["role"] | null;
        message?: string;
        includeDescendants?: boolean;
      },
    ) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "manage_sharing");
        const supportsDescendants = r.kind === "library" || !!r.library_id;
        const actorOwnsResource = isResourceOwnerLike(r, actor, ctx.resources);
        const includeDescendants = supportsDescendants &&
          (input.includeDescendants ?? true);
        if (input.revision !== (r.authz_revision ?? 1))
          fail(409, "权限已变化，请刷新");
        if (userId === r.owner_id) fail(403, "不能修改所有者权限");
        const current = await ctx.tx
          .selectFrom("grants")
          .selectAll()
          .where("resource_id", "=", id)
          .where("source_type", "=", "direct")
          .where("source_id", "=", "")
          .where("status", "=", "active")
          .execute();
        const collaboratorIds = current.map((g) => g.user_id);
        const pending = (
          await ctx.tx
            .selectFrom("access_invitations")
            .selectAll()
            .where("resource_id", "=", id)
            .execute()
        ).filter((i) => invitationState(i) === "pending");
        if (pending.some((i) => i.user_id === userId))
          fail(409, "该用户已有待接受邀请，请在邀请记录中处理");
        const effective = permission(
          r,
          { id: userId, display_name: "", admin: 0 },
          ctx.resources,
          ctx.grants,
        );
        if (
          !actorOwnsResource &&
          (effective >= 4 || input.role === "manager")
        )
          fail(403, "只有所有者可以调整管理权限");
        // Preserve an existing link role while a higher invitation waits for acceptance.
        const links = ctx.grants.filter(
          (g) =>
            g.resource_id === id && g.user_id === userId && g.source === "link",
        );
        const linkRank = Math.max(0, ...links.map((g) => ranks[g.role]));
        if (
          input.role &&
          ranks[input.role] > linkRank &&
          linkRank > 0 &&
          !current.some((g) => g.user_id === userId)
        ) {
          const floor = label(linkRank) as Grant["role"];
          await ctx.tx
            .insertInto("grants")
            .values({
              resource_id: id,
              user_id: userId,
              source_type: "direct",
              source_id: "",
              source_resource_id: null,
              role: floor,
              include_descendants: Number(
                supportsDescendants &&
                  links.some((g) => g.include_descendants !== 0),
              ),
              status: "active",
              created_by: actor.id,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .onConflict((oc) =>
              oc
                .columns(["resource_id", "user_id", "source_type", "source_id"])
                .doUpdateSet({ role: floor, status: "active", updated_at: new Date().toISOString() }),
            )
            .execute();
          current.push({
            resource_id: id,
            user_id: userId,
            role: floor,
            include_descendants: Number(
              supportsDescendants &&
                links.some((g) => g.include_descendants !== 0),
            ),
            source_type: "direct",
            source_id: "",
            source_resource_id: null,
            status: "active",
            created_by: actor.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
        const now = new Date().toISOString();
        const parent = ctx.resources.find(
          (resource) => resource.id === (r.parent_id ?? r.library_id),
        );
        const inheritedRole = parent
          ? namedPermission(parent, { id: userId, display_name: "", admin: 0 }, ctx.resources, ctx.grants, true)
          : 0;
        if (!input.role) {
          await ctx.tx
            .deleteFrom("grants")
            .where("resource_id", "=", id)
            .where("user_id", "=", userId)
            .where("source_type", "in", ["direct", "link"])
            .execute();
          if (parent)
            await ctx.tx
              .insertInto("grants")
              .values({
                resource_id: id,
                user_id: userId,
                source_type: "parent_override",
                source_id: "",
                source_resource_id: parent.id,
                role: "reader",
                include_descendants: 0,
                status: "disabled",
                created_by: actor.id,
                created_at: now,
                updated_at: now,
              })
              .onConflict((oc) =>
                oc
                  .columns(["resource_id", "user_id", "source_type", "source_id"])
                  .doUpdateSet({ status: "disabled", updated_at: now }),
              )
              .execute();
        }
        const desired = new Map(
          current.map((g) => [
            g.user_id,
            {
              userId: g.user_id,
              role: g.role,
              includeDescendants:
                supportsDescendants && g.include_descendants !== 0,
            },
          ]),
        );
        for (const i of pending)
          desired.set(i.user_id, {
            userId: i.user_id,
            role: i.role ?? "reader",
            includeDescendants:
              supportsDescendants && i.include_descendants !== 0,
          });
        if (input.role)
          desired.set(userId, {
            userId,
            role: input.role,
            includeDescendants,
          });
        else desired.delete(userId);
        const result = await apply(ctx, actor, id, {
          version: r.version,
          directUserId:
            input.role &&
            namedPermission(
              r,
              { id: userId, display_name: "", admin: 0 },
              ctx.resources,
              ctx.grants,
            ) >= ranks[input.role]
              ? userId
              : undefined,
          directUserIds: collaboratorIds,
          grants: [...desired.values()],
          invitationMessage: input.message?.trim(),
        });
        const mode = await distributionPolicy(ctx.tx, r.kind);
        const pendingAfter = input.role
          ? await ctx.tx
              .selectFrom("access_invitations")
              .select("state")
              .where("resource_id", "=", id)
              .where("user_id", "=", userId)
              .executeTakeFirst()
          : undefined;
        if (
          input.role &&
          (mode.grantMode === "direct" || pendingAfter?.state !== "pending")
        ) {
          const now = new Date().toISOString();
          const targetRole = input.role;
          await ctx.tx
            .updateTable("grants")
            .set({
              role: targetRole,
              include_descendants: Number(includeDescendants),
              status: "active",
              updated_at: now,
            })
            .where("resource_id", "=", id)
            .where("user_id", "=", userId)
            .where("status", "=", "active")
            .execute();
          if (parent && inheritedRole)
            await ctx.tx
              .insertInto("grants")
              .values({
                resource_id: id,
                user_id: userId,
                source_type: "parent_override",
                source_id: "",
                source_resource_id: parent.id,
                role: targetRole,
                include_descendants: Number(includeDescendants),
                status: "active",
                created_by: actor.id,
                created_at: now,
                updated_at: now,
              })
              .onConflict((oc) =>
                oc
                  .columns(["resource_id", "user_id", "source_type", "source_id"])
                  .doUpdateSet({
                    source_resource_id: parent.id,
                    role: targetRole,
                    include_descendants: Number(includeDescendants),
                    status: "active",
                    updated_at: now,
                  }),
              )
              .execute();
        }
        return result;
      });
    },
    source(
      actor: Actor,
      id: string,
      userId: string,
      input: {
        revision: number;
        sourceType: "direct" | "link" | "parent_override";
        sourceId?: string | null;
        action: "update" | "delete";
        role?: Grant["role"];
        includeDescendants?: boolean;
      },
    ) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "manage_sharing");
        const supportsDescendants = r.kind === "library" || !!r.library_id;
        const actorOwnsResource = isResourceOwnerLike(r, actor, ctx.resources);
        if (input.revision !== (r.authz_revision ?? 1))
          fail(409, "权限已变化，请刷新");
        if (userId === r.owner_id) fail(403, "不能修改所有者权限");
        const targetPermission = permission(
          r,
          { id: userId, display_name: "", admin: 0 },
          ctx.resources,
          ctx.grants,
        );
        if (
          !actorOwnsResource &&
          (targetPermission >= 4 || input.role === "manager")
        )
          fail(403, "只有所有者可以调整管理权限");
        const sourceId = input.sourceType === "link" ? input.sourceId ?? "" : "";
        const record = await ctx.tx
          .selectFrom("grants")
          .selectAll()
          .where("resource_id", "=", id)
          .where("user_id", "=", userId)
          .where("source_type", "=", input.sourceType)
          .where("source_id", "=", sourceId)
          .executeTakeFirst();
        if (!record) fail(404, "授权来源不存在");
        const now = new Date().toISOString();
        if (input.action === "delete") {
          await ctx.tx
            .deleteFrom("grants")
            .where("resource_id", "=", id)
            .where("user_id", "=", userId)
            .where("source_type", "=", input.sourceType)
            .where("source_id", "=", sourceId)
            .execute();
          const parent = r.parent_id ?? r.library_id;
          if (input.sourceType === "direct" && parent)
            await ctx.tx
              .insertInto("grants")
              .values({
                resource_id: id,
                user_id: userId,
                source_type: "parent_override",
                source_id: "",
                source_resource_id: parent,
                role: "reader",
                include_descendants: 0,
                status: "disabled",
                created_by: actor.id,
                created_at: now,
                updated_at: now,
              })
              .onConflict((oc) =>
                oc
                  .columns(["resource_id", "user_id", "source_type", "source_id"])
                  .doUpdateSet({
                    source_resource_id: parent,
                    status: "disabled",
                    updated_at: now,
                  }),
              )
              .execute();
        } else {
          if (!input.role) fail(400, "请提供授权角色");
          await ctx.tx
            .updateTable("grants")
            .set({
              role: input.role,
              include_descendants: Number(
                supportsDescendants &&
                  (input.includeDescendants ?? record.include_descendants !== 0),
              ),
              status: "active",
              updated_at: now,
            })
            .where("resource_id", "=", id)
            .where("user_id", "=", userId)
            .where("source_type", "=", input.sourceType)
            .where("source_id", "=", sourceId)
            .execute();
        }
        await touchAccess(ctx.tx, id);
        await event(ctx, r, "resource.permissions_changed", [userId]);
        return { ok: true };
      });
    },
  };
}
