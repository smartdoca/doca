import {
  grantSecurity,
  requireSecurity,
  allowSecurityMethod,
  credentialFingerprint,
} from "@core/modules/identity/security.js";
import { claimFieldSources } from "@core/modules/identity/field-policy.js";
import {
  identityPolicy,
  registrationProfile,
  claimIdentifier,
  setContact,
  applySourceProfile,
  metadata,
  passwordAllowed,
  availableLoginMethods,
} from "@core/modules/identity/accounts.js";
import {
  entitlementConfig,
  applyLevelMapping,
} from "@core/modules/entitlements/service.js";
import { contactProofs } from "@core/modules/identity/verification.js";
import { profileSubmission } from "./accounts.js";
import { accountBinding } from "../app/account-context.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { profilePolicy } from "@core/modules/identity/naming.js";
import {
  hashPassword,
  publicUser,
  tokenHash,
  verifyPassword,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import { provisionSystemMailbox } from "../services/system-mailbox.js";
import { mobileSession, sessionExpiresAt } from "../app/mobile-client.js";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  createIdentityAdapter,
  identityRuntime,
  type Identity,
  type IdentityRuntime,
  type Provider,
} from "../adapters/identity-providers.js";

const object = (p: Parameters<typeof Type.Object>[0]) =>
  Type.Object(p, { additionalProperties: false });
const str = (max = 160) => Type.String({ minLength: 1, maxLength: max });
const mode = Type.Union([
  Type.Literal("closed"),
  Type.Literal("auto"),
  Type.Literal("approval"),
]);
const uuid = Type.String({ format: "uuid" });
const now = () => new Date().toISOString();
const random = () => randomBytes(32).toString("hex");
export function registerIdentity(
  api: FastifyInstance,
  db: DB,
  ctx: {
    origin: URL;
    actor: (r: FastifyRequest) => Actor | null;
    authenticated: (r: FastifyRequest) => Actor;
    admin: (r: FastifyRequest) => Actor;
    sessionToken: (r: FastifyRequest) => string | null;
    cookie: (s: string) => string;
    limit: (key: string, max?: number) => void;
    loginMethodRuntime?: { phoneReady: boolean; emailReady: boolean };
  },
  runtime: IdentityRuntime = identityRuntime(),
) {
  const adapter = createIdentityAdapter(runtime);
  async function mappedProvider(p: Provider) {
    const global = await identityPolicy(db),
      mapping = profilePolicy(p.profile_config);
    for (const key of Object.keys(
      mapping.fields,
    ) as (keyof typeof mapping.fields)[])
      if (
        !global.fields[key].enabled ||
        global.fields[key].source !== `provider:${p.id}`
      )
        mapping.fields[key].source = "";
    return { ...p, profile_config: JSON.stringify(mapping) };
  }
  const hasSecret = (ref: string) =>
    Object.hasOwn(runtime.credentials, ref) &&
    typeof runtime.credentials[ref] === "string" &&
    !!runtime.credentials[ref];
  const ready = (p: Provider) => hasSecret(p.credential_ref);
  const redirect = (id: string) =>
    `${ctx.origin.origin}/api/v1/auth/providers/${id}/callback`;
  const flowCookie = (value: string, age = 600) =>
    `doca_auth_flow=${value}; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=${age}${ctx.origin.protocol === "https:" ? "; Secure" : ""}`;
  const browser = (req: FastifyRequest) => {
    const v = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("doca_auth_flow="))
      ?.slice(15);
    return v && /^[a-f0-9]{64}$/.test(v)
      ? tokenHash(v)
      : fail(400, "登录流程已失效，请重新发起");
  };
  async function recent(req: FastifyRequest, tx = db, consume = false) {
    const a = ctx.authenticated(req);
    await requireSecurity(tx, a.id, tokenHash(ctx.sessionToken(req)!), consume);
    return a;
  }
  const audit = async (tx: DB, userId: string, action: string) => {
    await tx
      .insertInto("audit_events")
      .values({
        id: randomUUID(),
        actor_id: userId,
        resource_id: null,
        action,
        created_at: now(),
      })
      .execute();
  };
  api.get("/api/v1/auth/providers", async () => {
    const rows = await db
      .selectFrom("auth_providers")
      .selectAll()
      .where("enabled", "=", 1)
      .execute();
    return {
      items: rows
        .filter(ready)
        .map((p) => ({ id: p.id, name: p.name, type: p.type })),
    };
  });
  api.get("/api/v1/admin/auth", async (req) => {
    ctx.admin(req);
    const settings = await db
      .selectFrom("settings")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
    const providers = await db
      .selectFrom("auth_providers")
      .selectAll()
      .orderBy("name")
      .execute();
    return {
      revision: settings.revision,
      local: settings.registration
        ? settings.registration_review
          ? "approval"
          : "auto"
        : "closed",
      sso: settings.sso_registration,
      social: settings.social_registration,
      providers: providers.map((p) => ({
        ...p,
        ready: ready(p),
        callbackUrl: redirect(p.id),
      })),
    };
  });
  api.put<{
    Body: { revision: number; local: string; sso: string; social: string };
  }>(
    "/api/v1/admin/auth/policy",
    {
      schema: {
        body: object({
          revision: Type.Integer({ minimum: 1 }),
          local: mode,
          sso: mode,
          social: mode,
        }),
      },
    },
    async (req) => {
      const a = ctx.admin(req),
        b = req.body;
      await transact(db, async (tx) => {
        const changed = await tx
          .updateTable("settings")
          .set({
            registration: b.local === "closed" ? 0 : 1,
            registration_review: b.local === "approval" ? 1 : 0,
            sso_registration: b.sso,
            social_registration: b.social,
            revision: b.revision + 1,
          })
          .where("id", "=", "system")
          .where("revision", "=", b.revision)
          .executeTakeFirst();
        if (!changed.numUpdatedRows) fail(409, "设置已变化，请刷新后重试");
        await audit(tx, a.id, "auth.policy_updated");
      });
      return { ok: true };
    },
  );
  const providerSchema = object({
    type: Type.Union(
      ["oidc", "oauth2", "google", "github", "wechat", "qq"].map((s) =>
        Type.Literal(s),
      ),
    ),
    name: str(),
    issuer: Type.String({ maxLength: 2048 }),
    client_id: str(256),
    protocol_config: Type.Optional(Type.String({ maxLength: 4096 })),
    profile_config: Type.Optional(Type.String({ maxLength: 16384 })),
    credential_ref: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
    enabled: Type.Integer({ minimum: 0, maximum: 1 }),
    version: Type.Integer({ minimum: 0 }),
  });
  async function save(req: FastifyRequest, id?: string) {
    const a = ctx.admin(req),
      b = req.body as Omit<Provider, "id">;
    const p: Provider = {
      ...b,
      id: id ?? randomUUID(),
      name: b.name.trim(),
      issuer: b.type === "oidc" ? b.issuer.trim() : "",
      version: id ? b.version + 1 : 1,
    };
    if (!p.name || !p.client_id.trim()) fail(400, "名称和 Client ID 不能为空");
    const profile = profilePolicy(p.profile_config),
      levels = (await entitlementConfig(db)).levels;
    if (
      profile.levelMapping.field &&
      [
        profile.levelMapping.fallback,
        ...Object.values(profile.levelMapping.rules).map((r) => r.levelId),
      ].some((id) => !levels.some((l) => l.id === id))
    )
      fail(400, "来源映射的等级不存在");
    p.profile_config = JSON.stringify(profile);
    try {
      adapter.validate(p);
    } catch (error) {
      if (error instanceof TypeError) fail(400, "Issuer 地址无效");
      throw error;
    }
    await transact(db, async (tx) => {
      const oldProvider = id
        ? await tx
            .selectFrom("auth_providers")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst()
        : undefined;
      const previousMapping = await tx
        .selectFrom("auth_providers")
        .select("profile_config")
        .where("id", "=", p.id)
        .executeTakeFirst();
      await claimFieldSources(
        tx,
        p.id,
        p.profile_config!,
        previousMapping?.profile_config,
      );
      if (
        !p.enabled &&
        (await identityPolicy(tx)).forcedLoginMethod === `provider:${p.id}`
      )
        fail(409, "请先取消对此身份源的强制补充，再停用身份源");
      if (!p.enabled) {
        const u = await tx
            .selectFrom("users")
            .selectAll()
            .where("id", "=", a.id)
            .executeTakeFirstOrThrow(),
          policy = await identityPolicy(tx),
          m = metadata(u.profile_metadata);
        const local =
          (policy.passwordEnabled && !!u.password_hash) ||
          (policy.smsEnabled &&
            !!(await tx
              .selectFrom("user_contacts")
              .select("value")
              .where("user_id", "=", a.id)
              .where("kind", "=", "phone")
              .executeTakeFirst())) ||
          (policy.emailEnabled &&
            !!(await tx
              .selectFrom("user_contacts")
              .select("value")
              .where("user_id", "=", a.id)
              .where("kind", "=", "email")
              .executeTakeFirst()));
        const others = await tx
          .selectFrom("auth_identities")
          .innerJoin(
            "auth_providers",
            "auth_providers.id",
            "auth_identities.provider_id",
          )
          .select(["enabled", "credential_ref", "auth_providers.id"])
          .where("user_id", "=", a.id)
          .execute();
        if (
          others.some((v) => v.id === p.id) &&
          !local &&
          !others.some(
            (v) => v.id !== p.id && v.enabled && hasSecret(v.credential_ref),
          )
        )
          fail(409, "当前管理员仅能通过此身份源登录，请先绑定其他方式");
      }
      const duplicate = await tx
        .selectFrom("auth_providers")
        .select("id")
        .where("type", "=", p.type)
        .where("issuer", "=", p.issuer)
        .where("client_id", "=", p.client_id)
        .where("id", "!=", p.id)
        .executeTakeFirst();
      if (duplicate) fail(409, "相同身份源已配置，请修改原配置");
      if (id) {
        const old = oldProvider ?? fail(404, "身份源不存在");
        // The provider identifier is a permanent subject namespace. Never repoint it.
        if (
          (old.protocol_config ?? "{}") !== (p.protocol_config ?? "{}") ||
          old.type !== p.type ||
          old.issuer !== p.issuer ||
          old.client_id !== p.client_id
        )
          fail(
            409,
            "身份源类型、Issuer 和 Client ID 创建后不可更改，请新建身份源",
          );
        const result = await tx
          .updateTable("auth_providers")
          .set(p)
          .where("id", "=", id)
          .where("version", "=", b.version)
          .executeTakeFirst();
        if (!result.numUpdatedRows) fail(409, "身份源配置已变化，请刷新重试");
      } else await tx.insertInto("auth_providers").values(p).execute();
      if (
        oldProvider &&
        (oldProvider.enabled !== p.enabled ||
          oldProvider.credential_ref !== p.credential_ref)
      ) {
        const policy = await identityPolicy(tx),
          users = await tx
            .selectFrom("users")
            .select(["id", "public_id"])
            .where("status", "=", "active")
            .execute(),
          missing: string[] = [];
        for (const user of users)
          if (
            !(await availableLoginMethods(tx, user.id, policy, {
              phoneReady: ctx.loginMethodRuntime?.phoneReady ?? false,
              emailReady: ctx.loginMethodRuntime?.emailReady ?? false,
              providerReady: hasSecret,
            })).length
          )
            missing.push(user.public_id ?? user.id);
        if (missing.length)
          fail(
            409,
            `修改身份源后有 ${missing.length} 个账号没有可用登录方式，请先让用户补充：${missing.slice(0, 5).join("、")}`,
          );
      }
      const affected = await tx
        .selectFrom("auth_identities")
        .innerJoin("users", "users.id", "auth_identities.user_id")
        .select([
          "users.id",
          "users.profile_metadata",
          "users.profile_revision",
        ])
        .where("provider_id", "=", p.id)
        .execute();
      for (const u of affected) {
        const m = metadata(u.profile_metadata);
        if (m.providerId !== p.id) continue;
        m.allowLinking = profile.allowLinking;
        await tx
          .updateTable("users")
          .set({
            profile_metadata: JSON.stringify(m),
            profile_revision: (u.profile_revision ?? 1) + 1,
          })
          .where("id", "=", u.id)
          .execute();
      }
      await audit(tx, a.id, "auth.provider_updated");
    });
    return { ...p, ready: ready(p), callbackUrl: redirect(p.id) };
  }
  api.post(
    "/api/v1/admin/auth/providers",
    { schema: { body: providerSchema } },
    (req) => save(req),
  );
  api.put<{ Params: { id: string } }>(
    "/api/v1/admin/auth/providers/:id",
    { schema: { params: object({ id: uuid }), body: providerSchema } },
    (req) => save(req, req.params.id),
  );
  api.get("/api/v1/me/identities", async (req) => {
    const a = ctx.authenticated(req);
    const user = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", a.id)
      .executeTakeFirstOrThrow();
    const items = await db
      .selectFrom("auth_identities")
      .innerJoin(
        "auth_providers",
        "auth_providers.id",
        "auth_identities.provider_id",
      )
      .select([
        "auth_identities.id",
        "auth_identities.provider_id",
        "auth_identities.display_name",
        "auth_identities.created_at",
        "auth_providers.name",
        "auth_providers.type",
        "auth_providers.enabled",
        "auth_providers.credential_ref",
      ])
      .where("user_id", "=", a.id)
      .execute();
    return {
      login: user.login,
      passwordEnabled:
        !!user.password_hash && (await identityPolicy(db)).passwordEnabled,
      passwordAllowed: (await identityPolicy(db)).passwordEnabled,
      linkingAllowed: metadata(user.profile_metadata).allowLinking !== false,
      items: items.map(({ credential_ref, ...row }) => ({
        ...row,
        available: !!row.enabled && hasSecret(credential_ref),
      })),
    };
  });
  api.post<{ Body: { password: string } }>(
    "/api/v1/auth/reauth",
    { schema: { body: object({ password: str(128) }) } },
    async (req) => {
      const a = ctx.authenticated(req);
      ctx.limit(`reauth:${req.ip}`);
      await passwordAllowed(db);
      await allowSecurityMethod(db, "password");
      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", a.id)
        .executeTakeFirstOrThrow();
      if (!(await verifyPassword(req.body.password, user.password_hash)))
        fail(403, "当前密码不正确；无密码账号请通过已绑定方式重新登录");
      await transact(db, async (tx) => {
        const current = await tx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", a.id)
          .executeTakeFirstOrThrow();
        await passwordAllowed(tx);
        if (
          current.status !== "active" ||
          current.password_hash !== user.password_hash
        )
          fail(403, "账号状态已变化");
        await grantSecurity(
          tx,
          a.id,
          tokenHash(ctx.sessionToken(req)!),
          "password",
          tokenHash(user.password_hash),
        );
      });
      return { ok: true };
    },
  );
  api.delete<{ Params: { id: string } }>(
    "/api/v1/me/identities/:id",
    { schema: { params: object({ id: uuid }) } },
    async (req) => {
      await transact(db, async (tx) => {
        const a = await recent(req, tx, true);
        const u = await tx
          .selectFrom("users")
          .select(["password_hash", "profile_metadata"])
          .where("id", "=", a.id)
          .executeTakeFirstOrThrow();
        const identities = await tx
          .selectFrom("auth_identities")
          .innerJoin(
            "auth_providers",
            "auth_providers.id",
            "auth_identities.provider_id",
          )
          .select(["auth_identities.id", "enabled", "credential_ref"])
          .where("user_id", "=", a.id)
          .execute();
        if (!identities.some((i) => i.id === req.params.id))
          fail(404, "绑定不存在");
        if (
          !(u.password_hash && (await identityPolicy(tx)).passwordEnabled) &&
          !(
            (await identityPolicy(tx)).smsEnabled &&
            (await tx
              .selectFrom("user_contacts")
              .select("value")
              .where("user_id", "=", a.id)
              .where("kind", "=", "phone")
              .executeTakeFirst())
          ) &&
          !(
            (await identityPolicy(tx)).emailEnabled &&
            (await tx
              .selectFrom("user_contacts")
              .select("value")
              .where("user_id", "=", a.id)
              .where("kind", "=", "email")
              .executeTakeFirst())
          ) &&
          !identities.some(
            (i) =>
              i.id !== req.params.id &&
              i.enabled &&
              hasSecret(i.credential_ref),
          )
        )
          fail(409, "不能解除最后一种可用登录方式");
        await tx
          .deleteFrom("auth_identities")
          .where("id", "=", req.params.id)
          .where("user_id", "=", a.id)
          .execute();
        await audit(tx, a.id, "auth.identity_unlinked");
      });
      return { ok: true };
    },
  );
  api.post<{ Body: { password: string } }>(
    "/api/v1/auth/password/setup",
    {
      schema: {
        body: object({
          password: Type.String({ minLength: 12, maxLength: 128 }),
        }),
      },
    },
    async (req) => {
      ctx.limit(`setup-password:${req.ip}`, 5);
      await passwordAllowed(db);
      await recent(req);
      const hash = await hashPassword(req.body.password);
      await transact(db, async (tx) => {
        const a = await recent(req, tx, true);
        await passwordAllowed(tx);
        const result = await tx
          .updateTable("users")
          .set({ password_hash: hash })
          .where("id", "=", a.id)
          .where("password_hash", "=", "")
          .executeTakeFirst();
        if (!result.numUpdatedRows) fail(409, "已设置密码，请使用修改密码功能");
        await tx
          .deleteFrom("sessions")
          .where("user_id", "=", a.id)
          .where("id", "!=", tokenHash(ctx.sessionToken(req)!))
          .execute();
        await audit(tx, a.id, "auth.password_initialized");
      });
      return { ok: true };
    },
  );
  api.post<{
    Params: { id: string };
    Body: { intent: "login" | "link" | "security" | "replace" };
  }>(
    "/api/v1/auth/providers/:id/start",
    {
      schema: {
        params: object({ id: uuid }),
        body: object({
          intent: Type.Union([
            Type.Literal("login"),
            Type.Literal("link"),
            Type.Literal("security"),
            Type.Literal("replace"),
          ]),
        }),
      },
    },
    async (req, reply) => {
      ctx.limit(`oauth:${req.ip}`, 20);
      const a =
        req.body.intent === "security"
          ? ctx.authenticated(req)
          : req.body.intent !== "login"
            ? await recent(req)
            : null;
      if (req.body.intent === "security") {
        await allowSecurityMethod(db, `provider:${req.params.id}`);
        if (
          !(await credentialFingerprint(db, a!.id, `provider:${req.params.id}`))
        )
          fail(403, "请使用当前已绑定的身份源验证");
      }
      if (!a && ctx.actor(req))
        fail(409, "当前已有登录账号，请从个人信息页面绑定，或退出后再登录");
      const p =
        (await db
          .selectFrom("auth_providers")
          .selectAll()
          .where("id", "=", req.params.id)
          .where("enabled", "=", 1)
          .executeTakeFirst()) ?? fail(404, "身份源未启用");
      if (!ready(p)) fail(503, "身份源凭据未配置");
      const state = random(),
        flow = random(),
        verifier = random(),
        nonce = random();
      const url = await adapter.authorization(
        await mappedProvider(p),
        redirect(p.id),
        state,
        verifier,
        nonce,
        req.body.intent !== "login",
      );
      await db
        .deleteFrom("auth_flows")
        .where("expires_at", "<=", now())
        .execute();
      await db
        .insertInto("auth_flows")
        .values({
          id: tokenHash(state),
          browser_hash: tokenHash(flow),
          provider_id: p.id,
          intent: req.body.intent,
          provider_version: p.version,
          verifier,
          nonce,
          user_id: a?.id ?? null,
          session_id: a ? tokenHash(ctx.sessionToken(req)!) : null,
          expires_at: new Date(Date.now() + 600000).toISOString(),
          stage: "started",
          identity: null,
        })
        .execute();
      reply.header("Set-Cookie", flowCookie(flow));
      return { url };
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/auth/providers/:id/callback",
    { logLevel: "silent", schema: { params: object({ id: uuid }) } },
    async (req, reply) => {
      // Never log callback URLs, provider tokens, codes, or provider response bodies.
      try {
        ctx.limit(`oauth-callback:${req.ip}`, 30);
        const url = new URL(req.url, ctx.origin),
          state = url.searchParams.get("state") ?? "";
        if (!/^[a-f0-9]{64}$/.test(state)) fail(400, "授权状态无效");
        const flow =
          (await db
            .updateTable("auth_flows")
            .set({ stage: "exchanging" })
            .where("id", "=", tokenHash(state))
            .where("browser_hash", "=", browser(req))
            .where("provider_id", "=", req.params.id)
            .where("stage", "=", "started")
            .where("expires_at", ">", now())
            .returningAll()
            .executeTakeFirst()) ?? fail(400, "登录流程已过期或已使用");
        const p =
          (await db
            .selectFrom("auth_providers")
            .selectAll()
            .where("id", "=", flow.provider_id)
            .where("version", "=", flow.provider_version)
            .where("enabled", "=", 1)
            .executeTakeFirst()) ?? fail(400, "身份源已变更");
        const identity = await adapter.exchange(
          await mappedProvider(p),
          url,
          redirect(p.id),
          state,
          flow.verifier,
          flow.nonce,
        );
        await db
          .updateTable("auth_flows")
          .set({
            stage: "verified",
            identity: JSON.stringify(identity),
            verifier: "",
            nonce: "",
          })
          .where("id", "=", flow.id)
          .execute();
        return reply.redirect(`${ctx.origin.origin}/#/auth/complete`);
      } catch {
        reply.header("Set-Cookie", flowCookie("", 0));
        return reply.redirect(`${ctx.origin.origin}/#/auth/error`);
      }
    },
  );
  api.post<{
    Body:
      | {
          password?: string;
          username?: string;
          displayName?: string;
          email?: string;
          phone?: string;
          avatar?: string;
          proofs?: Partial<Record<"email" | "phone", string>>;
        }
      | undefined;
  }>(
    "/api/v1/auth/complete",
    {
      preValidation: async (req) => {
        req.body ??= {};
      },
      schema: {
        body: Type.Optional(profileSubmission),
      },
    },
    async (req, reply) => {
      const hash = browser(req),
        token = random();
      const result = await transact(db, async (tx) => {
        const flow =
          (await tx
            .selectFrom("auth_flows")
            .selectAll()
            .where("browser_hash", "=", hash)
            .where("stage", "=", "verified")
            .where("expires_at", ">", now())
            .executeTakeFirst()) ??
          fail(400, "登录流程已过期或已完成，请重新发起");
        const p =
          (await tx
            .selectFrom("auth_providers")
            .selectAll()
            .where("id", "=", flow.provider_id)
            .where("version", "=", flow.provider_version)
            .where("enabled", "=", 1)
            .executeTakeFirst()) ?? fail(400, "身份源配置已变更，请重新登录");
        if (!ready(p)) fail(503, "身份源不可用");
        const identity = JSON.parse(flow.identity!) as Identity;
        let linked = await tx
          .selectFrom("auth_identities")
          .selectAll()
          .where("provider_id", "=", p.id)
          .where("subject", "=", identity.subject)
          .executeTakeFirst();
        if (flow.user_id && flow.intent === "security") {
          const a = ctx.authenticated(req);
          if (
            a.id !== flow.user_id ||
            tokenHash(ctx.sessionToken(req)!) !== flow.session_id ||
            linked?.user_id !== a.id
          )
            fail(403, "请使用原来已绑定的账号完成安全验证");
          await grantSecurity(
            tx,
            a.id,
            flow.session_id!,
            `provider:${p.id}`,
            tokenHash(identity.subject),
          );
          await tx.deleteFrom("auth_flows").where("id", "=", flow.id).execute();
          return { status: "security_verified" };
        }
        if (flow.user_id) {
          const a = await recent(req, tx, true);
          await tx
            .updateTable("users")
            .set((eb) => ({ profile_revision: eb("profile_revision", "+", 0) }))
            .where("id", "=", a.id)
            .execute();
          const account = await tx
            .selectFrom("users")
            .select("profile_metadata")
            .where("id", "=", a.id)
            .executeTakeFirstOrThrow();
          if (metadata(account.profile_metadata).allowLinking === false)
            fail(403, "该账号不允许追加其他登录方式");
          if (
            a.id !== flow.user_id ||
            tokenHash(ctx.sessionToken(req)!) !== flow.session_id
          )
            fail(403, "原登录会话已变化，请重新绑定");
          if (linked && linked.user_id !== a.id)
            fail(409, "此身份已绑定其他账号，不能重复绑定");
          const other = await tx
            .selectFrom("auth_identities")
            .select("id")
            .where("user_id", "=", a.id)
            .where("provider_id", "=", p.id)
            .executeTakeFirst();
          if (other && !linked && flow.intent !== "replace")
            fail(409, "此身份源已有绑定，请使用更换绑定");
          if (flow.intent === "replace") {
            if (!other) fail(409, "原绑定已变化，请重新操作");
            if (!linked) {
              await tx
                .updateTable("auth_identities")
                .set({
                  subject: identity.subject,
                  display_name: identity.name,
                  created_at: now(),
                })
                .where("id", "=", other.id)
                .execute();
              linked = {
                ...other,
                user_id: a.id,
                provider_id: p.id,
                subject: identity.subject,
                display_name: identity.name,
                created_at: now(),
              };
              await tx
                .deleteFrom("sessions")
                .where("user_id", "=", a.id)
                .where("id", "!=", flow.session_id!)
                .execute();
            }
          }
          if (!linked)
            await tx
              .insertInto("auth_identities")
              .values({
                id: randomUUID(),
                user_id: a.id,
                provider_id: p.id,
                subject: identity.subject,
                display_name: identity.name,
                created_at: now(),
              })
              .execute();
          await tx.deleteFrom("auth_flows").where("id", "=", flow.id).execute();
          await audit(tx, a.id, "auth.identity_linked");
          return { status: "linked", user: publicUser(a) };
        }
        if (ctx.actor(req)) fail(409, "当前会话已登录，请退出后重试");
        let newlyRegistered = false;
        if (!linked) {
          newlyRegistered = true;
          const settings = await tx
            .selectFrom("settings")
            .selectAll()
            .where("id", "=", "system")
            .executeTakeFirstOrThrow();
          const sourceRule = profilePolicy(p.profile_config).signup;
          const policy =
            sourceRule !== "inherit"
              ? sourceRule
              : ["oidc", "oauth2"].includes(p.type)
                ? settings.sso_registration
                : settings.social_registration;
          if (!policy || policy === "closed")
            fail(
              403,
              "此方式未开放新用户注册。已有账号请先用原方式登录，再在个人信息中绑定",
            );
          const id = randomUUID(),
            mapping = profilePolicy(p.profile_config);
          const proofValues = await contactProofs(
            tx,
            req.body?.proofs,
            accountBinding(req),
            "profile",
          );
          const profile = await registrationProfile(
            tx,
            mapping,
            { displayName: identity.name, ...identity.fields },
            identity.verified ?? {},
            req.body && Object.keys(req.body).length ? req.body : undefined,
            proofValues,
            p.id,
          );
          if (profile.needsPage)
            return {
              status: "needs_profile",
              fields: profile.fields,
              suggestedUsername: profile.values.username ?? "",
            };
          const publicId = profile.values.username!;
          await tx
            .insertInto("users")
            .values({
              id,
              login: publicId,
              public_id: publicId,
              display_name: profile.values.displayName ?? "",
              password_hash: req.body?.password
                ? await hashPassword(req.body.password)
                : "",
              admin: 0,
              status: policy === "approval" ? "pending" : "active",
              created_at: now(),
              base_level: (await entitlementConfig(tx)).defaultLevel,
              profile_metadata: JSON.stringify({
                providerId: p.id,
                avatarUrl: profile.values.avatar,
                overrides: profile.overrides,

                allowLinking: mapping.allowLinking,
              }),
            })
            .execute();
          await claimIdentifier(tx, id, publicId, "username");
          for (const key of ["email", "phone"] as const)
            if (profile.values[key])
              await setContact(
                tx,
                id,
                key,
                profile.values[key]!,
                identity.verified?.[key] ? `provider:${p.id}` : "verification",
              );
          linked = {
            id: randomUUID(),
            user_id: id,
            provider_id: p.id,
            subject: identity.subject,
            display_name: identity.name,
            created_at: now(),
          };
          await tx.insertInto("auth_identities").values(linked).execute();
          await audit(tx, id, "auth.federated_registered");
        }
        const mapping = profilePolicy(p.profile_config);
        if (!newlyRegistered)
          await applySourceProfile(
            tx,
            linked.user_id,
            p.id,
            mapping,
            { displayName: identity.name, ...identity.fields },
            identity.verified ?? {},
          );
        await applyLevelMapping(
          tx,
          linked.user_id,
          p.id,
          mapping,
          identity.levelValue,
        );
        const user = await tx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", linked.user_id)
          .executeTakeFirstOrThrow();
        await tx.deleteFrom("auth_flows").where("id", "=", flow.id).execute();
        if (user.status === "pending") {
          await registrationReview(tx, user.id);
          return { status: "pending", pendingUserId: user.id };
        }
        if (user.status !== "active") fail(403, "账号已被停用，请联系管理员");
        await tx
          .insertInto("sessions")
          .values({
            id: tokenHash(token),
            user_id: user.id,
            expires_at: sessionExpiresAt(req),
          })
          .execute();
        return { status: "active", user: publicUser(user) };
      });
      if (result.status === "needs_profile") return result;
      const provisionedId = result.status === "active" && result.user
        ? result.user.id
        : result.status === "pending" && "pendingUserId" in result
          ? result.pendingUserId
          : "";
      if (provisionedId) {
        await provisionSystemMailbox(db, {
          id: provisionedId,
          displayName:
            result.status === "active" && result.user
              ? result.user.display_name
              : undefined,
        });
      }
      reply.header(
        "Set-Cookie",
        result.status === "active"
          ? [flowCookie("", 0), ctx.cookie(token)]
          : flowCookie("", 0),
      );
      if (result.status === "pending" && "pendingUserId" in result)
        return { status: "pending" };
      return result.status === "active" ? mobileSession(req, token, result) : result;
    },
  );
}
import { registrationReview } from "@core/modules/identity/registration-reviews.js";
