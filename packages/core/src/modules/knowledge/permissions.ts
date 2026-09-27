import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { activeActor } from "../access/queries.js";
import { requireCapability } from "../access/operation-policy.js";
import { fail } from "../../shared/errors.js";
import {
  canManageKnowledgeBot,
  knowledgeAssistantAccess,
  knowledgeBotConfig,
  saveKnowledgeAssistant,
  effectiveKnowledgeBotLibraries,
  maintainKnowledge,
} from "./system.js";
import { knowledgeLinkMemberships } from "./link-access.js";

async function botFor(db: DB, actor: Actor, id: string, manage = true) {
  await activeActor(db, actor);
  const bot = await db
    .selectFrom("knowledge_assistants")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!bot) fail(404, "机器人不存在");
  if (
    manage
      ? !canManageKnowledgeBot(bot, actor.id)
      : !canManageKnowledgeBot(bot, actor.id) &&
        !(await knowledgeAssistantAccess(db, actor, bot)).accessible
  )
    fail(403, "无权访问此机器人");
  return bot;
}
async function save(
  db: DB,
  actor: Actor,
  bot: Schema["knowledge_assistants"],
  patch: Record<string, unknown>,
) {
  return saveKnowledgeAssistant(db, actor, {
    id: bot.id,
    expectedRevision: bot.revision,
    title: bot.title,
    libraryIds: JSON.parse(bot.library_ids),
    memberIds: JSON.parse(bot.member_ids),
    managerIds: JSON.parse(bot.manager_ids ?? "[]"),
    visibility: (bot.visibility ?? "invited") as "invited",
    enabled: !!bot.enabled,
    ...knowledgeBotConfig(bot),
    channels: knowledgeBotConfig(bot).channels as (
      "web" | "embed" | "api" | "mcp"
    )[],
    ...patch,
  });
}
export async function knowledgePermissionOverview(
  db: DB,
  actor: Actor,
  id: string,
) {
  const bot = await botFor(db, actor, id, false),
    canManage = canManageKnowledgeBot(bot, actor.id),
    isOwner = bot.owner_id === actor.id;
  const links = canManage ? await knowledgeLinkMemberships(db, id) : [];
  const direct: string[] = JSON.parse(bot.member_ids),
    managers: string[] = JSON.parse(bot.manager_ids ?? "[]");
  const ids = canManage
    ? [
        ...new Set([
          bot.owner_id,
          ...direct,
          ...managers,
          ...links.map((l) => l.user_id),
        ]),
      ]
    : [actor.id];
  const people = await db
    .selectFrom("users")
    .select(["id", "display_name", "public_id"])
    .where("id", "in", ids)
    .execute();
  const current = await db
    .selectFrom("users")
    .select(["id", "display_name", "public_id"])
    .where("id", "=", actor.id)
    .executeTakeFirst();
  const sharing = await db
    .selectFrom("knowledge_bot_sharing")
    .selectAll()
    .where("bot_id", "=", id)
    .executeTakeFirst();
  return {
    rank: isOwner ? 5 : canManage ? 4 : 1,
    currentUser: current,
    role: isOwner ? "owner" : canManage ? "manager" : "reader",
    version: bot.revision,
    authzRevision: bot.revision,
    accessMode: "custom",
    hasParent: false,
    supportsDescendants: false,
    inheritedFields: [],
    visibility: bot.visibility,
    effectiveVisibility: bot.visibility,
    publicRole: "reader",
    requestsEnabled: false,
    effectiveRequestsEnabled: false,
    historyReaders: false,
    sharingEnabled: !!sharing?.enabled,
    discoverable: false,
    canManage,
    isOwner,
    administrators: [],
    members: people.map((p) => {
      const owner = p.id === bot.owner_id,
        role = owner ? "owner" : managers.includes(p.id) ? "manager" : "reader";
      const directRole =
        owner || managers.includes(p.id) || direct.includes(p.id) ? role : null;
      return {
        ...p,
        role,
        directRole,
        sources: directRole ? ["direct"] : ["link"],
        canAdjust: canManage && !owner,
        includeDescendants: false,
        sourceDetails: [
          ...(directRole
            ? [
                {
                  type: "direct",
                  sourceType: "direct",
                  id: null,
                  sourceResourceId: id,
                  role,
                  includeDescendants: false,
                  status: "active",
                },
              ]
            : []),
          ...links
            .filter((l) => l.user_id === p.id)
            .map((l) => ({
              type: "link",
              sourceType: "link",
              id: l.link_id,
              sourceResourceId: id,
              role: "reader",
              includeDescendants: false,
              status: "active",
            })),
        ],
      };
    }),
  };
}
export async function updateKnowledgePermission(
  db: DB,
  actor: Actor,
  id: string,
  raw: unknown,
) {
  const input = z
    .object({
      version: z.number().int(),
      visibility: z.enum(["invited", "authenticated", "public"]).optional(),
      publicRole: z.literal("reader").optional(),
    })
    .strict()
    .parse(raw);
  return transact(db, async (tx) => {
    const bot = await botFor(tx, actor, id);
    if (input.version !== bot.revision) fail(409, "权限已修改，请刷新");
    return save(tx, actor, bot, {
      visibility: input.visibility ?? bot.visibility,
    });
  });
}
export async function updateKnowledgeMember(
  db: DB,
  actor: Actor,
  id: string,
  userId: string,
  raw: unknown,
) {
  const input = z
    .object({
      revision: z.number().int(),
      role: z.enum(["reader", "manager"]).nullable(),
      includeDescendants: z.boolean().optional(),
      message: z.string().max(1000).optional(),
    })
    .strict()
    .parse(raw);
  return transact(db, async (tx) => {
    const bot = await botFor(tx, actor, id);
    if (input.revision !== bot.revision) fail(409, "权限已修改，请刷新");
    if (userId === bot.owner_id) fail(400, "不能修改所有者权限");
    const members: string[] = JSON.parse(bot.member_ids),
      managers: string[] = JSON.parse(bot.manager_ids ?? "[]");
    const result = await save(tx, actor, bot, {
      memberIds: input.role
        ? [...new Set([...members, userId])]
        : members.filter((x) => x !== userId),
      managerIds:
        input.role === "manager"
          ? [...new Set([...managers, userId])]
          : managers.filter((x) => x !== userId),
    });
    if (!input.role) {
      const links = await knowledgeLinkMemberships(tx, id, userId);
      for (const l of links)
        await tx
          .deleteFrom("knowledge_bot_link_members")
          .where("link_id", "=", l.link_id)
          .where("user_id", "=", userId)
          .execute();
    }
    return result;
  });
}
export async function updateKnowledgePermissionSource(
  db: DB,
  actor: Actor,
  id: string,
  userId: string,
  raw: unknown,
) {
  const input = z
    .object({
      revision: z.number().int(),
      sourceType: z.enum(["direct", "link"]),
      sourceId: z.string().nullable().optional(),
      action: z.enum(["update", "delete"]),
      role: z.enum(["reader", "manager"]).optional(),
      includeDescendants: z.boolean().optional(),
    })
    .strict()
    .parse(raw);
  if (input.sourceType === "direct") {
    if (input.action === "update")
      return updateKnowledgeMember(db, actor, id, userId, {
        revision: input.revision,
        role: input.role ?? "reader",
      });
    return transact(db, async (tx) => {
      const bot = await botFor(tx, actor, id);
      if (bot.revision !== input.revision) fail(409, "权限已修改，请刷新");
      if (userId === bot.owner_id) fail(400, "不能修改所有者权限");
      return save(tx, actor, bot, {
        memberIds: JSON.parse(bot.member_ids).filter(
          (x: string) => x !== userId,
        ),
        managerIds: JSON.parse(bot.manager_ids ?? "[]").filter(
          (x: string) => x !== userId,
        ),
      });
    });
  }
  return transact(db, async (tx) => {
    const bot = await botFor(tx, actor, id);
    if (bot.revision !== input.revision) fail(409, "权限已修改，请刷新");
    if (input.action !== "delete") fail(400, "链接成员仅支持移除");
    const link = await tx
      .selectFrom("knowledge_bot_share_links")
      .select("id")
      .where("bot_id", "=", id)
      .where("id", "=", input.sourceId ?? "")
      .executeTakeFirst();
    if (!link) fail(404, "分享链接不存在");
    await tx
      .deleteFrom("knowledge_bot_link_members")
      .where("link_id", "=", link.id)
      .where("user_id", "=", userId)
      .execute();
    return save(tx, actor, bot, {});
  });
}
async function presentLink(db: DB, l: Schema["knowledge_bot_share_links"]) {
  const members = await db
    .selectFrom("knowledge_bot_link_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["u.id", "u.display_name", "u.public_id"])
    .where("m.link_id", "=", l.id)
    .execute();
  return {
    id: l.id,
    enabled: !!l.enabled,
    role: "reader",
    includeDescendants: false,
    maxMembers: l.max_members,
    memberCount: members.length,
    members,
    revoked: !!l.revoked_at,
    revokedAt: l.revoked_at,
    version: l.version,
    token: l.revoked_at ? null : l.token,
    expiresAt: l.expires_at,
    expired: !!l.expires_at && Date.parse(l.expires_at) <= Date.now(),
  };
}
export async function knowledgeShareLinks(db: DB, actor: Actor, id: string) {
  await botFor(db, actor, id);
  const state = await db
    .selectFrom("knowledge_bot_sharing")
    .selectAll()
    .where("bot_id", "=", id)
    .executeTakeFirst();
  const rows = await db
    .selectFrom("knowledge_bot_share_links")
    .selectAll()
    .where("bot_id", "=", id)
    .orderBy("created_at", "desc")
    .execute();
  const links = await Promise.all(rows.map((l) => presentLink(db, l)));
  return {
    sharingEnabled: !!state?.enabled,
    supportsDescendants: false,
    items: links.filter((l) => !l.revoked),
    revokedItems: links.filter((l) => l.revoked),
  };
}
export async function enableKnowledgeSharing(
  db: DB,
  actor: Actor,
  id: string,
  enabled: boolean,
) {
  return transact(db, async (tx) => {
    await botFor(tx, actor, id);
    await requireCapability(tx, actor.id, "sharing.invite");
    await tx
      .insertInto("knowledge_bot_sharing")
      .values({ bot_id: id, enabled: enabled ? 1 : 0 })
      .onConflict((oc) =>
        oc.column("bot_id").doUpdateSet({ enabled: enabled ? 1 : 0 }),
      )
      .execute();
    return { enabled };
  });
}
export async function saveKnowledgeShareLink(
  db: DB,
  actor: Actor,
  id: string,
  raw: unknown,
) {
  const input = z
    .object({
      version: z.string().uuid().nullable(),
      enabled: z.boolean(),
      role: z.literal("reader"),
      includeDescendants: z.literal(false).optional(),
      maxMembers: z.number().int().min(1).nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
    })
    .strict()
    .parse(raw);
  return transact(db, async (tx) => {
    const bot = await botFor(tx, actor, id);
    await requireCapability(tx, actor.id, "sharing.invite");
    if (
      (await effectiveKnowledgeBotLibraries(tx, bot)).length !==
      JSON.parse(bot.library_ids).length
    )
      fail(403, "创建者已失去部分知识库管理权限");
    // Validate the acting administrator can expose every bound library too.
    for (const libraryId of JSON.parse(bot.library_ids) as string[])
      await maintainKnowledge(tx, actor, libraryId);
    const state = await tx
      .selectFrom("knowledge_bot_sharing")
      .selectAll()
      .where("bot_id", "=", id)
      .executeTakeFirst();
    if (!state?.enabled) fail(409, "链接分享未开启");
    const old = input.version
      ? await tx
          .selectFrom("knowledge_bot_share_links")
          .selectAll()
          .where("bot_id", "=", id)
          .where("version", "=", input.version)
          .executeTakeFirst()
      : null;
    if (input.version && (!old || old.revoked_at))
      fail(409, "链接已修改，请刷新");
    const expires =
      input.expiresAt === undefined
        ? (old?.expires_at ?? null)
        : input.expiresAt;
    if (expires && Date.parse(expires) <= Date.now() && input.enabled)
      fail(400, "有效期必须晚于当前时间");
    const row = {
      id: old?.id ?? randomUUID(),
      bot_id: id,
      token: old?.token ?? randomBytes(32).toString("base64url"),
      enabled: input.enabled ? 1 : 0,
      revoked_at: null,
      expires_at: expires,
      max_members:
        input.maxMembers === undefined
          ? (old?.max_members ?? null)
          : input.maxMembers,
      version: randomUUID(),
      created_at: old?.created_at ?? new Date().toISOString(),
    };
    if (old) {
      const result = await tx
        .updateTable("knowledge_bot_share_links")
        .set(row)
        .where("id", "=", old.id)
        .where("version", "=", input.version!)
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows)) fail(409, "链接已修改，请刷新");
    } else
      await tx.insertInto("knowledge_bot_share_links").values(row).execute();
    return presentLink(tx, row);
  });
}
export async function revokeKnowledgeShareLink(
  db: DB,
  actor: Actor,
  id: string,
  linkId: string,
  version: string,
) {
  return transact(db, async (tx) => {
    await botFor(tx, actor, id);
    const result = await tx
      .updateTable("knowledge_bot_share_links")
      .set({
        revoked_at: new Date().toISOString(),
        enabled: 0,
        version: randomUUID(),
      })
      .where("bot_id", "=", id)
      .where("id", "=", linkId)
      .where("version", "=", version)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!Number(result.numUpdatedRows)) fail(409, "链接已修改，请刷新");
    return { ok: true };
  });
}
export async function redeemKnowledgeShare(
  db: DB,
  actor: Actor,
  token: string,
  accept: boolean,
) {
  return transact(db, async (tx) => {
    await activeActor(tx, actor);
    const link = await tx
      .selectFrom("knowledge_bot_share_links")
      .selectAll()
      .where("token", "=", token)
      .executeTakeFirst();
    if (!link) return null;
    const bot = await tx
      .selectFrom("knowledge_assistants")
      .selectAll()
      .where("id", "=", link.bot_id)
      .executeTakeFirst();
    const state = await tx
      .selectFrom("knowledge_bot_sharing")
      .selectAll()
      .where("bot_id", "=", link.bot_id)
      .executeTakeFirst();
    if (
      !bot?.enabled ||
      !state?.enabled ||
      !link.enabled ||
      link.revoked_at ||
      (link.expires_at && Date.parse(link.expires_at) <= Date.now())
    )
      fail(410, "分享链接已失效");
    const existing = await tx
      .selectFrom("knowledge_bot_link_members")
      .select("user_id")
      .where("link_id", "=", link.id)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    if (existing || canManageKnowledgeBot(bot, actor.id))
      return { id: bot.id, kind: "assistant" as const };
    const count = await tx
      .selectFrom("knowledge_bot_link_members")
      .select(tx.fn.countAll<number>().as("n"))
      .where("link_id", "=", link.id)
      .executeTakeFirstOrThrow();
    if (link.max_members !== null && Number(count.n) >= link.max_members)
      fail(409, "分享链接人数已满");
    if (!accept)
      return {
        pending: true as const,
        id: bot.id,
        title: bot.title,
        kind: "assistant" as const,
        role: "reader",
      };
    // Optimistic lock serializes concurrent claims of the last available seat.
    const claimed = await tx
      .updateTable("knowledge_bot_share_links")
      .set({ version: randomUUID() })
      .where("id", "=", link.id)
      .where("version", "=", link.version)
      .executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) fail(409, "链接已更新，请重试");
    await tx
      .insertInto("knowledge_bot_link_members")
      .values({
        link_id: link.id,
        user_id: actor.id,
        created_at: new Date().toISOString(),
      })
      .execute();
    return { id: bot.id, kind: "assistant" as const };
  });
}
