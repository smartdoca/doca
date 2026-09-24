import { profilePolicy } from "@core/modules/identity/naming.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "@core/shared/errors.js";
import { securityAudit } from "@core/modules/identity/accounts.js";
import { tokenHash } from "@core/modules/identity/passwords.js";
import {
  capabilityCatalog,
  quotaCatalog,
  entitlementConfig,
  validateEntitlements,
  publicEntitlements,
  entitlements,
  writeTimedMembership,
} from "@core/modules/entitlements/service.js";
import type { AccountContext } from "../app/account-context.js";
const object = (p: Parameters<typeof Type.Object>[0]) =>
  Type.Object(p, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 64 }),
  date = Type.String({ format: "date-time" });
export function registerEntitlements(
  api: FastifyInstance,
  db: DB,
  ctx: AccountContext,
  secret = "",
) {
  api.get('/api/v1/admin/entitlements/sources',async req=>{ctx.admin(req);return {items:(await db.selectFrom('auth_providers').select(['id','name','version','profile_config']).execute()).map(p=>({id:p.id,name:p.name,version:p.version,levelMapping:profilePolicy(p.profile_config).levelMapping}))};});
  api.put<{Params:{id:string};Body:{version:number;levelMapping:any}}>('/api/v1/admin/entitlements/sources/:id',{schema:{params:object({id:Type.String({format:'uuid'})}),body:object({version:Type.Integer({minimum:1}),levelMapping:Type.Any()})}},async req=>{
    const actor=ctx.admin(req);
    await transact(db,async tx=>{
      const p=await tx.selectFrom('auth_providers').selectAll().where('id','=',req.params.id).executeTakeFirstOrThrow();
      const mapping=profilePolicy(JSON.stringify({levelMapping:req.body.levelMapping})).levelMapping,c=await entitlementConfig(tx);
      if(mapping.field&&[mapping.fallback,...Object.values(mapping.rules).map(r=>r.levelId)].some(id=>!c.levels.some(l=>l.id===id)))fail(400,'来源映射的等级不存在');
      const result=await tx.updateTable('auth_providers').set({profile_config:JSON.stringify({...JSON.parse(p.profile_config||'{}'),levelMapping:mapping}),version:p.version+1}).where('id','=',p.id).where('version','=',req.body.version).executeTakeFirst();
      if(!result.numUpdatedRows)fail(409,'身份源已变化，请刷新');
      await securityAudit(tx,actor.id,null,'level.source_updated',{providerId:p.id,levelMapping:mapping});
    });return {ok:true};
  });
  const secretHash = async () => {
    const row = await db
      .selectFrom("account_settings")
      .select("config")
      .where("id", "=", "membership-secret")
      .executeTakeFirst();
    return row
      ? (JSON.parse(row.config).hash as string)
      : secret
        ? tokenHash(secret)
        : "";
  };
  const external = async (req: any) => {
    const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const expected = await secretHash();
    if (
      !expected ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(tokenHash(supplied)))
    )
      fail(401, "会员服务认证失败");
  };
  api.post<{ Body: { secret?: string; generate?: boolean } }>(
    "/api/v1/admin/entitlements/secret",
    {
      schema: {
        body: object({
          secret: Type.Optional(Type.String({ minLength: 32, maxLength: 256 })),
          generate: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const actor = ctx.admin(req);
      const value = req.body.generate
        ? randomBytes(32).toString("hex")
        : req.body.secret;
      if (!value || !value.trim()) fail(400, "请填写密钥或选择生成");
      await transact(db, async (tx) => {
        await tx
          .insertInto("account_settings")
          .values({
            id: "membership-secret",
            config: JSON.stringify({ hash: tokenHash(value) }),
            revision: 1,
          })
          .onConflict((oc) =>
            oc.column("id").doUpdateSet((eb) => ({
              config: JSON.stringify({ hash: tokenHash(value) }),
              revision: eb("account_settings.revision", "+", 1),
            })),
          )
          .execute();
        await securityAudit(
          tx,
          actor.id,
          null,
          "membership.secret_rotated",
          {},
        );
      });
      return {
        configured: true,
        ...(req.body.generate ? { secret: value } : {}),
      };
    },
  );
  api.get("/api/v1/admin/entitlements", async (req) => {
    ctx.admin(req);
    return {
      ...(await entitlementConfig(db)),
      capabilities: capabilityCatalog,
      quotas: quotaCatalog,
      membershipReady: !!(await secretHash()),
    };
  });
  api.put<{ Body: Record<string, any> }>(
    "/api/v1/admin/entitlements",
    {
      schema: {
        body: object({
          revision: Type.Integer({ minimum: 1 }),
          config: Type.Any(),
        }),
      },
    },
    async (req) => {
      const a = ctx.admin(req),
        config = validateEntitlements(req.body.config);
      await transact(db, async (tx) => {
        const old = await entitlementConfig(tx);
        if (old.timezone !== config.timezone) {
          const usage = await tx
            .selectFrom("quota_usage")
            .select("user_id")
            .limit(1)
            .executeTakeFirst();
          if (usage) fail(409, "已有周期用量，不能直接更换计量时区");
        }
        const removed = old.levels.filter(
          (l) => !config.levels.some((v) => v.id === l.id),
        );
        for (const l of removed) {
          const u = await tx
              .selectFrom("users")
              .select("id")
              .where((eb) =>
                eb.or([
                  eb("base_level", "=", l.id),
                  eb("timed_level", "=", l.id),
                ]),
              )
              .executeTakeFirst(),
            g = await tx
              .selectFrom("membership_grants")
              .select("id")
              .where("level_id", "=", l.id)
              .executeTakeFirst();
          const sources = await tx
            .selectFrom("auth_providers")
            .select("profile_config")
            .execute();
          const referenced = sources.some((s) => {
            const m = profilePolicy(s.profile_config).levelMapping;
            return (
              m.field &&
              (m.fallback === l.id ||
                Object.values(m.rules).some((r) => r.levelId === l.id))
            );
          });
          if (u || g || referenced)
            fail(409, "等级仍被账号、来源映射或授予记录引用，不能删除");
        }
        const result = await tx
          .updateTable("account_settings")
          .set({
            config: JSON.stringify(config),
            revision: req.body.revision + 1,
          })
          .where("id", "=", "entitlements")
          .where("revision", "=", req.body.revision)
          .executeTakeFirst();
        if (!result.numUpdatedRows) fail(409, "等级配置已变化");
        await securityAudit(tx, a.id, null, "entitlements.updated", config);
      });
      return { ok: true };
    },
  );
  api.get("/api/v1/me/entitlements", (req) =>
    publicEntitlements(db, ctx.authenticated(req).id),
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id/entitlements",
    async (req) => {
      ctx.admin(req);
      const e = await entitlements(db, req.params.id);
      return {
        baseLevel: e.base.id,
        baseLevelName: e.base.name,
        expiresAt: e.expiresAt,
        timedLevel: e.user.timed_level,
        timedExpiresAt: e.user.timed_level_expires_at
          ? Number(e.user.timed_level_expires_at)
          : null,
        identityClass: e.user.identity_class,
        source: e.user.level_source,
        override: !!e.user.level_override,
        revision: e.user.level_revision ?? 1,
        effectiveLevel: e.level,
        grants: await db
          .selectFrom("membership_grants")
          .selectAll()
          .where("user_id", "=", req.params.id)
          .execute(),
      };
    },
  );
  api.post<{
    Body: {
      users: { id: string; revision: number }[];
      levelId: string;
      identityClass: string;
      restoreSource: boolean;
      reason: string;
    };
  }>(
    "/api/v1/admin/entitlements/assign",
    {
      schema: {
        body: object({
          users: Type.Array(
            object({
              id: Type.String({ format: "uuid" }),
              revision: Type.Integer({ minimum: 1 }),
            }),
            { minItems: 1, maxItems: 200 },
          ),
          levelId: id,
          identityClass: Type.String({ maxLength: 64 }),
          restoreSource: Type.Boolean(),
          reason: Type.String({ minLength: 1, maxLength: 500 }),
        }),
      },
    },
    async (req) => {
      const a = ctx.admin(req);
      await transact(db, async (tx) => {
        const c = await entitlementConfig(tx);
        if (
          !c.levels.some((l) => l.id === req.body.levelId) ||
          !req.body.reason.trim()
        )
          fail(400, "等级或原因无效");
        if (
          new Set(req.body.users.map((u) => u.id)).size !==
          req.body.users.length
        )
          fail(400, "账号不能重复");
        for (const target of req.body.users) {
          const u =
            (await tx
              .selectFrom("users")
              .selectAll()
              .where("id", "=", target.id)
              .executeTakeFirst()) ?? fail(404, "用户不存在");
          if ((u.level_revision ?? 1) !== target.revision)
            fail(409, "用户等级已变化，请刷新");
          await tx
            .updateTable("users")
            .set(
              req.body.restoreSource
                ? { level_override: 0, level_revision: target.revision + 1 }
                : {
                    base_level: req.body.levelId,
                    identity_class: req.body.identityClass,
                    level_override: 1,
                    level_revision: target.revision + 1,
                  },
            )
            .where("id", "=", u.id)
            .execute();
          await securityAudit(tx, a.id, u.id, "level.corrected", {
            before: { level: u.base_level, identityClass: u.identity_class },
            ...req.body,
            users: undefined,
          });
        }
      });
      return { ok: true };
    },
  );
  api.post<{
    Params: { id: string };
    Body: {
      grantId?: string;
      version: number;
      levelId: string;
      startsAt: string;
      expiresAt: string | null;
      status: "active" | "revoked";
      reason: string;
    };
  }>(
    "/api/v1/admin/users/:id/membership",
    {
      schema: {
        body: object({
          grantId: Type.Optional(Type.String({ maxLength: 160 })),
          version: Type.Integer({ minimum: 0 }),
          levelId: id,
          startsAt: date,
          expiresAt: Type.Union([date, Type.Null()]),
          status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
          reason: Type.String({ minLength: 1, maxLength: 500 }),
        }),
      },
    },
    async (req) => {
      const a = ctx.admin(req);
      await transact(db, async (tx) => {
        await tx
          .updateTable("users")
          .set((eb) => ({ level_revision: eb("level_revision", "+", 0) }))
          .where("id", "=", req.params.id)
          .execute();
        const c = await entitlementConfig(tx);
        if (!req.body.reason.trim()) fail(400, "请填写调整原因");
        if (
          !(await tx
            .selectFrom("users")
            .select("id")
            .where("id", "=", req.params.id)
            .executeTakeFirst())
        )
          fail(404, "用户不存在");
        if (!c.levels.some((l) => l.id === req.body.levelId))
          fail(400, "等级不存在");
        const key = req.body.grantId ?? "admin:" + randomUUID(),
          old = await tx
            .selectFrom("membership_grants")
            .selectAll()
            .where("id", "=", key)
            .executeTakeFirst();
        if (old && (old.user_id !== req.params.id || old.source !== "admin"))
          fail(403, "不能修改其他来源的授予");
        if ((old?.version ?? 0) !== req.body.version)
          fail(409, "授予记录已变化");
        const start = new Date(req.body.startsAt).toISOString(),
          end = req.body.expiresAt
            ? new Date(req.body.expiresAt).toISOString()
            : null;
        if (end && end <= start) fail(400, "到期时间需晚于生效时间");
        const row = {
          id: key,
          user_id: req.params.id,
          source: "admin",
          level_id: req.body.levelId,
          starts_at: start,
          expires_at: end,
          status: req.body.status,
          version: req.body.version + 1,
        };
        await tx
          .insertInto("membership_grants")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(row))
          .execute();
        await writeTimedMembership(tx, row);
        await securityAudit(
          tx,
          a.id,
          req.params.id,
          "membership.admin_updated",
          { ...row, reason: req.body.reason },
        );
      });
      return { ok: true };
    },
  );
  api.post("/api/v1/me/membership-link", async (req) => {
    ctx.authenticated(req);
    const c = await entitlementConfig(db);
    if (!c.showVip || !c.vipUrl) fail(403, "会员入口未启用");
    return { url: c.vipUrl };
  });
  api.post<{
    Body: {
      eventId: string;
      subscriptionId: string;
      instance: string;
      userId: string;
      planId: string;
      startsAt: string;
      expiresAt: string | null;
      status: "active" | "revoked";
      version: number;
    };
  }>(
    "/api/v1/integrations/membership/events",
    {
      schema: {
        body: object({
          eventId: id,
          subscriptionId: id,
          instance: Type.String({ maxLength: 2048 }),
          userId: Type.String({ format: "uuid" }),
          planId: id,
          startsAt: date,
          expiresAt: Type.Union([date, Type.Null()]),
          status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
          version: Type.Integer({ minimum: 1 }),
        }),
      },
    },
    async (req) => {
      await external(req);
      const b = req.body;
      if (b.instance !== ctx.origin.origin) fail(403, "目标实例不匹配");
      return transact(db, async (tx) => {
        await tx
          .updateTable("users")
          .set((eb) => ({ level_revision: eb("level_revision", "+", 0) }))
          .where("id", "=", b.userId)
          .execute();
        const digest = tokenHash(
            JSON.stringify(
              Object.fromEntries(
                Object.entries(b).sort(([a], [b]) => a.localeCompare(b)),
              ),
            ),
          ),
          event = await tx
            .selectFrom("membership_events")
            .selectAll()
            .where("id", "=", b.eventId)
            .executeTakeFirst();
        if (event) {
          if (event.digest !== digest) fail(409, "事件 ID 已用于不同内容");
          return { ok: true, duplicate: true };
        }
        const c = await entitlementConfig(tx),
          level = Object.hasOwn(c.externalPlans, b.planId)
            ? c.externalPlans[b.planId]
            : undefined;
        if (!level) fail(400, "套餐未配置等级映射");
        if (!b.expiresAt)
          fail(400, "定时会员必须有到期时间，永久等级由管理员或身份源设置");
        const start = new Date(b.startsAt).toISOString(),
          end = b.expiresAt ? new Date(b.expiresAt).toISOString() : null;
        if (end && end <= start) fail(400, "有效期无效");
        const key = "vip:" + b.subscriptionId,
          old = await tx
            .selectFrom("membership_grants")
            .selectAll()
            .where("id", "=", key)
            .executeTakeFirst();
        if (old && old.user_id !== b.userId) fail(409, "订阅归属不能变更");
        if (old && old.version >= b.version) fail(409, "会员事件版本已过期");
        const u = await tx
          .selectFrom("users")
          .select("id")
          .where("id", "=", b.userId)
          .executeTakeFirst();
        if (!u) fail(404, "用户不存在");
        const row = {
          id: key,
          user_id: b.userId,
          source: "vip",
          level_id: level,
          starts_at: start,
          expires_at: end,
          status: b.status,
          version: b.version,
        };
        await tx
          .insertInto("membership_grants")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(row))
          .execute();
        await writeTimedMembership(tx, row);
        await tx
          .insertInto("membership_events")
          .values({
            id: b.eventId,
            digest,
            created_at: new Date().toISOString(),
          })
          .execute();
        await securityAudit(tx, null, b.userId, "membership.external_updated", {
          eventId: b.eventId,
          ...row,
        });
        return { ok: true };
      });
    },
  );
}
