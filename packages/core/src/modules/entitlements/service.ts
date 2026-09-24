import { membershipIcons } from "./icons.js";
import { randomUUID } from "node:crypto";
import type { DB, Schema } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { securityAudit } from "../identity/accounts.js";
import type { ProfilePolicy } from "../identity/naming.js";
export const capabilityCatalog = [
  ["documents.create", "文档与知识库", "创建文档", true],
  ["libraries.create", "文档与知识库", "创建知识库", true],
  ["documents.import", "文档与知识库", "导入文档", true],
  ["documents.copy", "文档与知识库", "复制文档", true],
  ["format.rich_text", "文档与知识库", "富文本文档", true],
  ["format.markdown", "文档与知识库", "Markdown", true],
  ["format.spreadsheet", "文档与知识库", "表格", true],
  ["format.canvas", "文档与知识库", "画板", true],
  ["format.presentation", "文档与知识库", "演示文稿", true],
  ["assets.upload", "存储与历史", "上传附件", true],
  ["history.create", "存储与历史", "保存历史版本", true],
  ["sharing.invite", "分享与协作", "邀请协作", true],
  ["sharing.links", "分享与协作", "生成分享链接", true],
  ["sharing.site", "分享与协作", "站内公开", true],
  ["sharing.public", "分享与协作", "全网公开", true],
  ["backup.upload", "云备份", "云备份", false],
  ["ai.create", "AI", "AI 辅助创作", true],
  ["ai.rag", "AI", "知识库 RAG", true],
  ["mcp.write", "API 与自动化", "MCP 写入", true],
  ["automation.run", "API 与自动化", "自动化任务", false],
] as const;
export const quotaCatalog = [
  ["documents.day", "文档与知识库", "每日创建文档数"],
  ["documents.month", "文档与知识库", "每月创建文档数"],
  ["documents.total", "文档与知识库", "持有文档总数"],
  ["libraries.total", "文档与知识库", "知识库总数"],
  ["document.bytes", "存储与历史", "单篇正文大小（字节）"],
  ["asset.bytes", "存储与历史", "单附件大小（字节）"],
  ["storage.bytes", "存储与历史", "正文及附件总容量（字节）"],
  ["sharing.links", "分享与协作", "每篇有效分享链接数"],
  ["sharing.members", "分享与协作", "每篇显式协作者数"],
  ["history.versions", "存储与历史", "每篇历史版本数"],
] as const;
export type Capability = (typeof capabilityCatalog)[number][0];
export type Quota = (typeof quotaCatalog)[number][0];
export type Level = {
  icon?: string;
  color?: string;
  id: string;
  name: string;
  rank: number;
  limits: Record<Quota, number | null>;
};
export type Rule = { enabled: boolean; minLevel: string; classes: string[] };
export type EntitlementConfig = {
  levels: Level[];
  rules: Record<Capability, Rule>;
  defaultLevel: string;
  timezone: string;
  showLevel: boolean;
  showExpiry: boolean;
  showVip: boolean;
  vipUrl: string;
  vipLabel: string;
  vipIcon: string;
  externalPlans: Record<string, string>;
};
const limits = () =>
  Object.fromEntries(quotaCatalog.map(([id]) => [id, null])) as Level["limits"];
export function entitlementDefaults(): EntitlementConfig {
  return {
    levels: [{ id: "standard", name: "标准用户", rank: 0, limits: limits() }],
    rules: Object.fromEntries(
      capabilityCatalog.map(([id, , , ready]) => [
        id,
        { enabled: ready, minLevel: "standard", classes: [] },
      ]),
    ) as unknown as EntitlementConfig["rules"],
    defaultLevel: "standard",
    timezone: "Asia/Shanghai",
    showLevel: false,
    showExpiry: false,
    showVip: false,
    vipUrl: "",
    vipLabel: "会员中心",
    vipIcon: "vip",
    externalPlans: {},
  };
}
export async function entitlementConfig(db: DB) {
  const r = await db
    .selectFrom("account_settings")
    .selectAll()
    .where("id", "=", "entitlements")
    .executeTakeFirstOrThrow();
  const d = entitlementDefaults(),
    p = JSON.parse(r.config);
  return {
    ...d,
    ...p,
    rules: { ...d.rules, ...p.rules },
    revision: r.revision,
  } as EntitlementConfig & { revision: number };
}
export function validateEntitlements(input: any): EntitlementConfig {
  const c = input as EntitlementConfig;
  if (
    !c ||
    !Array.isArray(c.levels) ||
    !c.levels.length ||
    c.levels.length > 30
  )
    fail(400, "至少保留一个等级，最多30个");
  const ids = new Set<string>(),
    ranks = new Set<number>();
  for (const l of c.levels) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(l.id) ||
      ids.has(l.id) ||
      !l.name?.trim() ||
      l.name.length > 64 ||
      !Number.isSafeInteger(l.rank) ||
      l.rank < 0 ||
      ranks.has(l.rank)
    )
      fail(400, "等级 ID、名称或顺序无效");
    if (
      l.icon !== undefined &&
      l.icon !== "" &&
      !membershipIcons.some((i) => i.id === l.icon)
    )
      fail(400, "请选择平台内置的等级图标");
    if (
      l.color !== undefined &&
      l.color !== "" &&
      (typeof l.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(l.color))
    )
      fail(400, "等级名称颜色必须是六位十六进制颜色");
    ids.add(l.id);
    ranks.add(l.rank);
    for (const [k] of quotaCatalog)
      if (
        l.limits?.[k] !== null &&
        (!Number.isSafeInteger(l.limits?.[k]) || l.limits[k]! < 0)
      )
        fail(400, "额度必须为非负整数，无上限请明确设置");
  }
  if (!ids.has(c.defaultLevel)) fail(400, "默认等级不存在");
  const sorted = [...c.levels].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < sorted.length; i++)
    for (const [k] of quotaCatalog)
      if (
        (sorted[i]!.limits[k] ?? Infinity) <
        (sorted[i - 1]!.limits[k] ?? Infinity)
      )
        fail(400, "高等级额度不能少于低等级");
  for (const [id, , , ready] of capabilityCatalog) {
    const r = c.rules?.[id];
    if (
      !r ||
      typeof r.enabled !== "boolean" ||
      !ids.has(r.minLevel) ||
      !Array.isArray(r.classes) ||
      r.classes.some((v) => typeof v !== "string" || v.length > 64) ||
      r.classes.length > 30
    )
      fail(400, "功能规则无效");
    if (!ready && r.enabled) fail(400, "该功能尚未就绪，暂不能启用");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: c.timezone }).format();
  } catch {
    fail(400, "时区无效");
  }
  for (const k of ["showLevel", "showExpiry", "showVip"] as const)
    if (typeof c[k] !== "boolean") fail(400, "等级展示配置无效");
  c.vipLabel ??= "会员中心";
  c.vipIcon ??= "vip";
  if (
    typeof c.vipLabel !== "string" ||
    !c.vipLabel.trim() ||
    c.vipLabel.trim().length > 24
  )
    fail(400, "会员入口文字需为 1 至 24 个字符");
  c.vipLabel = c.vipLabel.trim();
  if (c.vipIcon !== "" && !membershipIcons.some((i) => i.id === c.vipIcon))
    fail(400, "请选择平台内置的会员入口图标");
  if (c.vipUrl) {
    let u: URL;
    try {
      u = new URL(c.vipUrl);
    } catch {
      fail(400, "VIP 页面地址无效");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.hash)
      fail(400, "VIP 页面需为 HTTPS 地址且不包含凭据或片段");
  }
  if (c.showVip && !c.vipUrl) fail(400, "请填写 VIP 页面地址");
  if (
    !c.externalPlans ||
    typeof c.externalPlans !== "object" ||
    Array.isArray(c.externalPlans) ||
    Object.keys(c.externalPlans).length > 100 ||
    Object.values(c.externalPlans).some((v) => !ids.has(v))
  )
    fail(400, "会员套餐映射无效");
  return { ...c, levels: sorted };
}
/** Effective membership is resolved from one user row; expiry requires no background job. */
export function resolveMembership(
  c: EntitlementConfig,
  u: Pick<
    Schema["users"],
    "base_level" | "timed_level" | "timed_level_expires_at"
  >,
  at = new Date(),
) {
  const base =
    c.levels.find((l) => l.id === u.base_level) ??
    c.levels.find((l) => l.id === c.defaultLevel)!;
  const until = Number(u.timed_level_expires_at);
  const timed =
    Number.isFinite(until) && until > at.getTime()
      ? c.levels.find((l) => l.id === u.timed_level)
      : undefined;
  const level = timed && timed.rank > base.rank ? timed : base;
  return {
    base,
    level,
    timedLevel: timed ?? null,
    expiresAt: level !== base ? new Date(until).toISOString() : null,
  };
}
export async function writeTimedMembership(
  db: DB,
  grant: Schema["membership_grants"],
) {
  if (grant.status === "active") {
    if (!grant.expires_at || Date.parse(grant.expires_at) <= Date.now())
      fail(400, "定时会员必须设置未来的到期时间；永久等级请调整基础等级");
    if (Date.parse(grant.starts_at) > Date.now() + 5000)
      fail(400, "定时会员从授予时生效，不支持预约开始时间");
    await db
      .updateTable("membership_grants")
      .set({ status: "superseded" })
      .where("user_id", "=", grant.user_id)
      .where("id", "!=", grant.id)
      .where("status", "=", "active")
      .execute();
    await db
      .updateTable("users")
      .set((eb) => ({
        timed_level: grant.level_id,
        timed_level_expires_at: Date.parse(grant.expires_at!),
        level_revision: eb("level_revision", "+", 1),
      }))
      .where("id", "=", grant.user_id)
      .execute();
  } else {
    // Revocation of an old subscription must not remove a newer membership.
    const other = await db
      .selectFrom("membership_grants")
      .select("id")
      .where("user_id", "=", grant.user_id)
      .where("id", "!=", grant.id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!other)
      await db
        .updateTable("users")
        .set((eb) => ({
          timed_level: null,
          timed_level_expires_at: null,
          level_revision: eb("level_revision", "+", 1),
        }))
        .where("id", "=", grant.user_id)
        .execute();
  }
}
export async function entitlements(db: DB, userId: string, at = new Date()) {
  const c = await entitlementConfig(db),
    u = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
  const { base, level, expiresAt } = resolveMembership(c, u, at);
  const can = Object.fromEntries(
    capabilityCatalog.map(([id, , , ready]) => {
      const r = c.rules[id];
      return [
        id,
        u.status === "active" &&
          ready &&
          r.enabled &&
          level.rank >=
            (c.levels.find((l) => l.id === r.minLevel)?.rank ?? Infinity) &&
          (!r.classes.length || r.classes.includes(u.identity_class ?? "")),
      ];
    }),
  ) as Record<Capability, boolean>;
  return { config: c, user: u, level, base, can, expiresAt };
}
export async function requireCapability(
  db: DB,
  userId: string,
  capability: Capability,
) {
  const e = await entitlements(db, userId);
  if (!e.can[capability]) fail(403, "当前账号不支持此操作");
  return e;
}
export async function publicEntitlements(db: DB, userId: string) {
  const e = await entitlements(db, userId);
  const used = await db
    .selectFrom("quota_usage")
    .selectAll()
    .where("user_id", "=", userId)
    .where("period", "in", Object.values(periods(e.config.timezone)))
    .execute();
  return {
    can: e.can,
    limits: e.level.limits,
    usage: used.map(({ user_id, ...r }) => r),
    ...(e.config.showLevel
      ? {
          level: {
            id: e.level.id,
            name: e.level.name,
            ...(e.level.icon ? { icon: e.level.icon } : {}),
            ...(e.level.color ? { color: e.level.color } : {}),
          },
        }
      : {}),
    ...(e.config.showLevel && e.config.showExpiry
      ? { expiresAt: e.expiresAt }
      : {}),
    vip: e.config.showVip
      ? { enabled: true, label: e.config.vipLabel, icon: e.config.vipIcon }
      : null,
    revision: e.config.revision,
  };
}
export function periods(timezone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    month: `${get("year")}-${get("month")}`,
  };
}
export async function consumeQuota(
  db: DB,
  userId: string,
  metric: Quota,
  period: string,
  amount: number,
  limit: number | null,
) {
  if (!Number.isSafeInteger(amount) || amount < 0) fail(400, "用量无效");
  const row = await db
    .selectFrom("quota_usage")
    .select("used")
    .where("user_id", "=", userId)
    .where("metric", "=", metric)
    .where("period", "=", period)
    .executeTakeFirst();
  const next = Number(row?.used ?? 0) + amount;
  if (limit !== null && next > limit) fail(409, "当前周期额度已用尽");
  await db
    .insertInto("quota_usage")
    .values({ user_id: userId, metric, period, used: next })
    .onConflict((oc) =>
      oc.columns(["user_id", "metric", "period"]).doUpdateSet({ used: next }),
    )
    .execute();
}
export async function checkCreation(
  db: DB,
  userId: string,
  kind: string,
  format: string,
  count = 1,
) {
  const e = await requireCapability(
    db,
    userId,
    kind === "library" ? "libraries.create" : "documents.create",
  );
  if (kind === "document")
    await requireCapability(db, userId, `format.${format}` as Capability);
  const totalKey = kind === "library" ? "libraries.total" : "documents.total",
    limit = e.level.limits[totalKey];
  if (limit !== null) {
    const n = await db
      .selectFrom("resources")
      .select(db.fn.countAll<number>().as("n"))
      .where("owner_id", "=", userId)
      .where("kind", "=", kind as "library" | "document")
      .executeTakeFirstOrThrow();
    if (Number(n.n) + count > limit) fail(409, "已达到持有数量上限");
  }
  if (kind === "document") {
    const p = periods(e.config.timezone);
    for (const suffix of ["day", "month"] as const)
      await consumeQuota(
        db,
        userId,
        `documents.${suffix}`,
        p[suffix],
        count,
        e.level.limits[`documents.${suffix}`],
      );
  }
}
export async function checkDocumentSize(db: DB, id: string, next: number) {
  const r = await db
      .selectFrom("resources")
      .select(["owner_id", "content_bytes"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
    e = await entitlements(db, r.owner_id),
    old = Number(r.content_bytes ?? 0);
  if (next > old) {
    if (
      e.level.limits["document.bytes"] !== null &&
      next > e.level.limits["document.bytes"]!
    )
      fail(413, "文档超过当前等级大小上限");
    await checkStorage(db, r.owner_id, next - old, e);
  }
  await db
    .updateTable("resources")
    .set({ content_bytes: next })
    .where("id", "=", id)
    .execute();
}
export async function checkStorage(
  db: DB,
  userId: string,
  additional: number,
  e?: Awaited<ReturnType<typeof entitlements>>,
) {
  e ??= await entitlements(db, userId);
  const limit = e.level.limits["storage.bytes"];
  if (limit === null || additional <= 0) return;
  const doc = await db
    .selectFrom("resources")
    .select(db.fn.sum<number>("content_bytes").as("n"))
    .where("owner_id", "=", userId)
    .executeTakeFirst();
  const assets = await db
    .selectFrom("assets")
    .select(db.fn.sum<number>("size").as("n"))
    .where("owner_id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const files = await db
    .selectFrom("file_items as f")
    .innerJoin("file_storage_objects as o", "o.id", "f.storage_object_id")
    .select(eb => eb.fn.sum<number>("f.size").as("n"))
    .where("f.owner_id", "=", userId)
    .where("f.deleted_at", "is", null)
    .where(eb => eb.not(eb.exists(
      eb.selectFrom("assets as a").select("a.id")
        .where("a.owner_id", "=", userId).where("a.deleted_at", "is", null)
        .whereRef("a.object_key", "=", "o.object_key"),
    )))
    .executeTakeFirst();
  if (Number(doc?.n ?? 0) + Number(assets?.n ?? 0) + Number(files?.n ?? 0) + additional > limit)
    fail(413, "已达到账号存储容量上限");
}
export async function applyLevelMapping(
  db: DB,
  userId: string,
  providerId: string,
  policy: ProfilePolicy,
  value: string | undefined,
) {
  const mapping = policy.levelMapping;
  if (!mapping.field) return;
  const u = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  if (
    u.level_override ||
    !["default", `provider:${providerId}`].includes(
      u.level_source ?? "default",
    ) ||
    (!mapping.sync && u.level_source !== "default")
  )
    return;
  const match =
    value !== undefined && Object.hasOwn(mapping.rules, value)
      ? mapping.rules[value]
      : undefined;
  const levelId = match?.levelId ?? mapping.fallback,
    identityClass = match?.identityClass ?? "";
  if (!(await entitlementConfig(db)).levels.some((l) => l.id === levelId))
    fail(403, "认证源的等级映射不可用，请联系管理员");
  await db
    .updateTable("users")
    .set({
      base_level: levelId,
      identity_class: identityClass,
      level_source: `provider:${providerId}`,
      level_revision: (u.level_revision ?? 1) + 1,
    })
    .where("id", "=", userId)
    .execute();
  if (u.base_level !== levelId || u.identity_class !== identityClass)
    await securityAudit(db, null, userId, "level.source_updated", {
      providerId,
      levelId,
      identityClass,
    });
}
