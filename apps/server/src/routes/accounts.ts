import { emitIntegrationEvent } from "@core/modules/automation/events.js";
import {
  requireSecurity,
  grantSecurity,
  allowSecurityMethod,
  credentialFingerprint,
} from "@core/modules/identity/security.js";
import { validateFieldSources } from "@core/modules/identity/field-policy.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "@core/shared/errors.js";
import { mobileSession, sessionExpiresAt } from "../app/mobile-client.js";
import {
  createUser,
  hashPassword,
  recordLogin,
  tokenHash,
  publicUser,
} from "@core/modules/identity/passwords.js";
import {
  type ProfileValues,
  normalizeContact,
  identityPolicy,
  profileRequirements,
  parseIdentityPolicy,
  securityAudit,
  setContact,
  claimIdentifier,
  metadata,
  profileEditable,
  registrationProfile,
  renameAccount,
  passwordAllowed,
  availableLoginMethods,
} from "@core/modules/identity/accounts.js";
import { profilePolicy } from "@core/modules/identity/naming.js";
import {
  createVerification,
  flowToken,
  contactProofs,
} from "@core/modules/identity/verification.js";
import {
  accountBinding,
  accountCookie,
  readCookie,
  recentAccount,
  type AccountContext,
} from "../app/account-context.js";
import {
  messagingRuntime,
  type MessagingRuntime,
} from "../adapters/messaging.js";
const object = (p: Parameters<typeof Type.Object>[0]) =>
  Type.Object(p, { additionalProperties: false });
export const profileSubmission = object({
  password: Type.Optional(Type.String({ minLength: 12, maxLength: 128 })),
  username: Type.Optional(Type.String({ maxLength: 160 })),
  displayName: Type.Optional(Type.String({ maxLength: 160 })),
  email: Type.Optional(Type.String({ maxLength: 254 })),
  phone: Type.Optional(Type.String({ maxLength: 32 })),
  avatar: Type.Optional(Type.String({ maxLength: 2048 })),
  proofs: Type.Optional(
    object({
      email: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      phone: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    }),
  ),
});
export function registerAccounts(
  api: FastifyInstance,
  db: DB,
  ctx: AccountContext,
  runtime: MessagingRuntime = messagingRuntime(),
) {
  const verification = createVerification(db, () => runtime.secret);
  const loginRuntime = {
    phoneReady: runtime.phoneReady,
    emailReady: runtime.emailReady,
    providerReady: ctx.providerReady,
  };
  api.post<{ Body: { proofs?: { email?: string; phone?: string } } }>(
    "/api/v1/me/onboarding",
    {
      schema: {
        body: object({
          proofs: Type.Optional(
            object({
              email: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
              phone: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
            }),
          ),
        }),
      },
    },
    async (req) => {
      const a = ctx.authenticated(req);
      await transact(db, async (tx) => {
        await tx
          .updateTable("users")
          .set((eb) => ({ profile_revision: eb("profile_revision", "+", 0) }))
          .where("id", "=", a.id)
          .execute();
        const u = await tx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", a.id)
          .executeTakeFirstOrThrow();
        const values = await contactProofs(
          tx,
          req.body.proofs,
          accountBinding(req),
          "profile",
          a.id,
        );
        for (const kind of ["email", "phone"] as const)
          if (values[kind]) {
            if (!(await profileEditable(tx, a.id, kind)))
              fail(
                403,
                "必填项由认证源管理，请重新通过该身份源登录或联系管理员",
              );
            const old = await tx
              .selectFrom("user_contacts")
              .select("value")
              .where("user_id", "=", a.id)
              .where("kind", "=", kind)
              .executeTakeFirst();
            if (old && old.value !== values[kind])
              fail(403, "已有联系方式请在账号安全中修改");
            await setContact(tx, a.id, kind, values[kind]!, "verification");
          }
        if (await profileRequirements(tx, a.id))
          fail(400, "请补全所有必填联系方式");
        const policy = await identityPolicy(tx);
        if (
          policy.forcedLoginMethod &&
          ["phone", "email"].includes(policy.forcedLoginMethod) &&
          !(
            await availableLoginMethods(tx, a.id, policy, loginRuntime)
          ).includes(policy.forcedLoginMethod)
        )
          fail(400, "请先完成指定登录方式的验证");
        await securityAudit(tx, a.id, a.id, "profile.completed", {});
      });
      return { ok: true };
    },
  );

  api.get("/api/v1/auth/options", async () => ({
    ...(await identityPolicy(db)),
    phoneReady: runtime.phoneReady,
    emailReady: runtime.emailReady,
  }));
  api.get("/api/v1/admin/accounts/policy", async (req) => {
    ctx.admin(req);
    return {
      ...(await identityPolicy(db)),
      phoneReady: runtime.phoneReady,
      emailReady: runtime.emailReady,
    };
  });
  api.put<{ Body: Record<string, any> }>(
    "/api/v1/admin/accounts/policy",
    {
      schema: {
        body: Type.Object(
          {
            fields: Type.Optional(Type.Any()),
            passwordIdentifiers: Type.Optional(Type.Array(Type.String())),
            securityMethods: Type.Optional(Type.Array(Type.String())),
            forcedLoginMethod: Type.Optional(
              Type.Union([
                Type.Null(),
                Type.String({
                  pattern: "^(password|phone|email|provider:[a-f0-9-]{36})$",
                }),
              ]),
            ),
            emailEnabled: Type.Optional(Type.Boolean()),
            emailRegistration: Type.Optional(Type.String()),
            revision: Type.Integer({ minimum: 1 }),
            smsRegistration: Type.Optional(
              Type.Union(
                ["closed", "auto", "approval"].map((v) => Type.Literal(v)),
              ),
            ),
            passwordEnabled: Type.Boolean(),
            smsEnabled: Type.Boolean(),
            recoveryEnabled: Type.Boolean(),
            qrLoginEnabled: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const a = ctx.admin(req),
        current = await identityPolicy(db),
        p = parseIdentityPolicy(req.body);
      if (p.emailEnabled && !runtime.emailReady)
        fail(400, "请先配置邮件发送服务");
      if (
        (p.smsEnabled && !p.fields.phone.enabled) ||
        (p.emailEnabled && !p.fields.email.enabled)
      )
        fail(400, "登录所依赖的联系方式必须启用");
      if (p.smsEnabled && !runtime.phoneReady)
        fail(400, "请先配置短信发送服务");
      for (const kind of ["email", "phone"] as const) {
        if (
          !(p.fields[kind].required || p.fields.username.source === kind) ||
          (kind === "email" ? runtime.emailReady : runtime.phoneReady)
        )
          continue;
        const provider = p.fields[kind].source.startsWith("provider:")
          ? await db
              .selectFrom("auth_providers")
              .selectAll()
              .where("id", "=", p.fields[kind].source.slice(9))
              .where("enabled", "=", 1)
              .executeTakeFirst()
          : undefined;
        const field =
          provider && profilePolicy(provider.profile_config).fields[kind];
        if (
          !field?.source ||
          !field.verifiedField ||
          !ctx.providerReady?.(provider!.credential_ref)
        )
          fail(400, "必填联系方式需要验证服务或已启用的可信来源映射");
      }
      await transact(db, async (tx) => {
        await validateFieldSources(tx, p.fields);
        if (p.forcedLoginMethod?.startsWith("provider:")) {
          const provider = await tx
            .selectFrom("auth_providers")
            .select(["enabled", "credential_ref"])
            .where("id", "=", p.forcedLoginMethod.slice(9))
            .executeTakeFirst();
          if (
            !provider?.enabled ||
            !ctx.providerReady?.(provider.credential_ref)
          )
            fail(400, "强制补充的身份源必须已启用且配置凭据");
        } else if (
          p.forcedLoginMethod === "phone" &&
          (!p.smsEnabled || !p.fields.phone.enabled || !runtime.phoneReady)
        )
          fail(400, "强制补充的手机号登录必须已启用且配置短信服务");
        else if (
          p.forcedLoginMethod === "email" &&
          (!p.emailEnabled || !p.fields.email.enabled || !runtime.emailReady)
        )
          fail(400, "强制补充的邮箱登录必须已启用且配置邮件服务");
        else if (p.forcedLoginMethod === "password" && !p.passwordEnabled)
          fail(400, "强制补充的账号密码登录必须已启用");

        const loginPolicyChanged =
          p.passwordEnabled !== current.passwordEnabled ||
          p.smsEnabled !== current.smsEnabled ||
          p.emailEnabled !== current.emailEnabled ||
          JSON.stringify(p.passwordIdentifiers) !==
            JSON.stringify(current.passwordIdentifiers) ||
          p.fields.phone.enabled !== current.fields.phone.enabled ||
          p.fields.email.enabled !== current.fields.email.enabled;
        if (loginPolicyChanged) {
          const users = await tx
            .selectFrom("users")
            .select(["id", "public_id"])
            .where("status", "=", "active")
            .execute();
          const missing: string[] = [];
          for (const user of users) {
            if (
              !(await availableLoginMethods(tx, user.id, p, loginRuntime))
                .length
            )
              missing.push(user.public_id ?? user.id);
          }
          if (missing.length)
            fail(
              409,
              `修改后有 ${missing.length} 个账号没有可用登录方式，请先让用户补充登录方式：${missing.slice(0, 5).join("、")}`,
            );
        }
        const r = await tx
          .updateTable("account_settings")
          .set({ config: JSON.stringify(p), revision: req.body.revision + 1 })
          .where("id", "=", "identity")
          .where("revision", "=", req.body.revision)
          .executeTakeFirst();
        if (!r.numUpdatedRows) fail(409, "配置已变化，请刷新");
        await securityAudit(tx, a.id, null, "account.policy_updated", p);
      });
      return { ok: true };
    },
  );
  api.get("/api/v1/me/security", async (req) => {
    const a = ctx.authenticated(req),
      p = await identityPolicy(db);
    const methods = [];
    for (const method of p.securityMethods) {
      let available = !!(await credentialFingerprint(db, a.id, method)),
        label = (
          {
            password: "当前密码",
            phone: "已绑定手机号",
            email: "已绑定邮箱",
          } as Record<string, string>
        )[method];
      let value = "";
      if (method === "password") available = available && p.passwordEnabled;
      if (method === "phone" || method === "email") {
        available =
          available &&
          p.fields[method].enabled &&
          (method === "phone" ? runtime.phoneReady : runtime.emailReady);
        value =
          (
            await db
              .selectFrom("user_contacts")
              .select("value")
              .where("user_id", "=", a.id)
              .where("kind", "=", method)
              .executeTakeFirst()
          )?.value ?? "";
      }
      if (method.startsWith("provider:")) {
        const provider = await db
          .selectFrom("auth_providers")
          .selectAll()
          .where("id", "=", method.slice(9))
          .executeTakeFirst();
        label = provider?.name ?? "SSO";
        available =
          available &&
          !!provider?.enabled &&
          !!ctx.providerReady?.(provider.credential_ref);
      }
      if (available) methods.push({ id: method, label, value });
    }
    let verified = false;
    try {
      await requireSecurity(db, a.id, tokenHash(ctx.sessionToken(req)!));
      verified = true;
    } catch {}
    return { methods, verified };
  });
  api.post<{ Body: { kind: "phone" | "email"; proof: string } }>(
    "/api/v1/auth/security/contact",
    {
      schema: {
        body: object({
          kind: Type.Union([Type.Literal("phone"), Type.Literal("email")]),
          proof: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        }),
      },
    },
    async (req) => {
      const a = ctx.authenticated(req);
      await transact(db, async (tx) => {
        const values = await contactProofs(
          tx,
          { [req.body.kind]: req.body.proof },
          accountBinding(req),
          "security",
          a.id,
        );
        await grantSecurity(
          tx,
          a.id,
          tokenHash(ctx.sessionToken(req)!),
          req.body.kind,
          tokenHash(values[req.body.kind]!),
        );
      });
      return { ok: true };
    },
  );
  api.post<{
    Body: {
      kind: "email" | "phone";
      value: string;
      purpose: "login" | "profile" | "contact" | "recovery" | "security";
    };
  }>(
    "/api/v1/auth/challenges",
    {
      schema: {
        body: object({
          kind: Type.Union([Type.Literal("email"), Type.Literal("phone")]),
          value: Type.String({ maxLength: 254 }),
          purpose: Type.Union(
            ["login", "profile", "contact", "recovery", "security"].map((v) =>
              Type.Literal(v),
            ),
          ),
        }),
      },
    },
    async (req, reply) => {
      const p = await identityPolicy(db);
      if (!p.fields[req.body.kind].enabled) fail(403, "此字段已禁用");
      if (
        !runtime.send ||
        !(req.body.kind === "phone" ? runtime.phoneReady : runtime.emailReady)
      )
        fail(503, "该验证码服务尚未配置");
      if (
        req.body.purpose === "login" &&
        !(req.body.kind === "phone" ? p.smsEnabled : p.emailEnabled)
      )
        fail(403, "短信登录未启用");
      if (
        req.body.purpose === "recovery" &&
        (!p.recoveryEnabled ||
          !p.passwordEnabled ||
          !p.securityMethods.includes(req.body.kind))
      )
        fail(403, "账号恢复未开启");
      const a =
        req.body.purpose === "contact"
          ? await recentAccount(db, ctx, req)
          : req.body.purpose === "security"
            ? ctx.authenticated(req)
            : req.body.purpose === "profile"
              ? ctx.actor(req)
              : null;
      if (a && req.body.purpose === "contact") {
        const u = await db
          .selectFrom("users")
          .select("profile_metadata")
          .where("id", "=", a.id)
          .executeTakeFirstOrThrow();
        if (!(await profileEditable(db, a.id, req.body.kind)))
          fail(403, "此资料由认证源管理，不能自行修改");
      }
      if (req.body.purpose === "security") {
        await allowSecurityMethod(db, req.body.kind);
        const old = await db
          .selectFrom("user_contacts")
          .select("value")
          .where("user_id", "=", a!.id)
          .where("kind", "=", req.body.kind)
          .executeTakeFirst();
        if (
          !old ||
          old.value !== normalizeContact(req.body.kind, req.body.value)
        )
          fail(403, "只能使用当前已绑定的联系方式验证身份");
      }
      let token = readCookie(req, "doca_account_flow");
      if (!token) {
        token = flowToken();
        reply.header(
          "Set-Cookie",
          accountCookie(ctx, "doca_account_flow", token),
        );
      }
      const started = await verification.start(
        {
          ...req.body,
          binding: tokenHash(token),
          userId: a?.id ?? null,
          ip: req.ip,
        },
        (code, destination) =>
          runtime.send!({
            kind: req.body.kind,
            destination,
            code,
            purpose: req.body.purpose,
            expiresInSeconds: 300,
          }),
      );
      // React Native hides Set-Cookie, so the mobile client echoes this token as a Cookie header.
      return req.headers["x-doca-client"] === "mobile"
        ? { ...started, flow: token }
        : started;
    },
  );
  api.post<{ Body: { challengeId: string; code: string } }>(
    "/api/v1/auth/challenges/verify",
    {
      schema: {
        body: object({
          challengeId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          code: Type.String({ maxLength: 12 }),
        }),
      },
    },
    (req) =>
      verification.verify(
        req.body.challengeId,
        req.body.code,
        accountBinding(req),
      ),
  );
  for (const loginKind of ["phone", "email"] as const)
    api.post<{ Body: { proof: string } }>(
      loginKind === "phone" ? "/api/v1/auth/sms" : "/api/v1/auth/email",
      {
        schema: {
          body: object({ proof: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
        },
      },
      async (req, reply) => {
        if (
          !(await identityPolicy(db))[
            loginKind === "phone" ? "smsEnabled" : "emailEnabled"
          ]
        )
          fail(403, "此验证码登录未开启");
        if (ctx.actor(req)) fail(409, "请在账号设置中绑定新的登录方式");
        const token = flowToken();
        const result = await transact(db, async (tx) => {
          const proof = await contactProofs(
            tx,
            { [loginKind]: req.body.proof },
            accountBinding(req),
            "login",
          );
          const linked = await tx
            .selectFrom("login_identifiers")
            .select("user_id")
            .where("value", "=", proof[loginKind]!)
            .where("active", "=", 1)
            .executeTakeFirst();
          if (linked) {
            const contact = await tx
              .selectFrom("user_contacts")
              .select("value")
              .where("user_id", "=", linked.user_id)
              .where("kind", "=", loginKind)
              .where("value", "=", proof[loginKind]!)
              .executeTakeFirst();
            if (!contact) fail(409, "请使用原账号登录后绑定手机号");
            const u = await tx
              .selectFrom("users")
              .selectAll()
              .where("id", "=", linked.user_id)
              .executeTakeFirstOrThrow();
            if (u.status === "pending")
              return { status: "pending", pendingUserId: u.id };
            if (u.status !== "active")
              fail(
                403,
                u.status === "pending"
                  ? "注册申请等待管理员审核"
                  : "账号已停用",
              );

            await tx
              .insertInto("sessions")
              .values({
                id: tokenHash(token),
                user_id: u.id,
                expires_at: sessionExpiresAt(req),
              })
              .execute();
            await recordLogin(tx, u.id);
            return { status: "active", user: publicUser(u) };
          }
          const signup = (await identityPolicy(tx))[
            loginKind === "phone" ? "smsRegistration" : "emailRegistration"
          ];
          if (signup === "closed") fail(403, "短信登录未开放新用户注册");
          await tx
            .insertInto("account_flows")
            .values({
              id: tokenHash(token),
              kind: "code-enrollment",
              user_id: null,
              data: JSON.stringify({
                kind: loginKind,
                value: proof[loginKind],
              }),
              expires_at: new Date(Date.now() + 600000).toISOString(),
            })
            .execute();
          return { status: "needs_profile" };
        });
        reply.header(
          "Set-Cookie",
          result.status === "active"
            ? ctx.cookie(token)
            : accountCookie(ctx, "doca_enrollment", token),
        );
        if (result.status === "pending" && "pendingUserId" in result)
          return { status: "pending" };
        return result.status === "active"
          ? mobileSession(req, token, result)
          : result;
      },
    );
  for (const loginKind of ["phone", "email"] as const)
    api.post<{ Body: Record<string, any> }>(
      loginKind === "phone"
        ? "/api/v1/auth/sms/complete"
        : "/api/v1/auth/email/complete",
      {
        schema: { body: Type.Optional(profileSubmission) },
        preValidation: async (req) => {
          req.body ??= {};
        },
      },
      async (req, reply) => {
        const token =
            readCookie(req, "doca_enrollment") ?? fail(400, "注册流程已过期"),
          session = flowToken();
        const result = await transact(db, async (tx) => {
          if (
            !(await identityPolicy(tx))[
              loginKind === "phone" ? "smsEnabled" : "emailEnabled"
            ]
          )
            fail(403, "此验证码登录已关闭");
          const flow =
            (await tx
              .selectFrom("account_flows")
              .selectAll()
              .where("id", "=", tokenHash(token))
              .where("kind", "=", "code-enrollment")
              .where("expires_at", ">", new Date().toISOString())
              .executeTakeFirst()) ?? fail(400, "注册流程已过期");
          const settings = await tx
            .selectFrom("settings")
            .selectAll()
            .where("id", "=", "system")
            .executeTakeFirstOrThrow();
          const signup = (await identityPolicy(tx))[
            loginKind === "phone" ? "smsRegistration" : "emailRegistration"
          ];
          if (signup === "closed") fail(403, "短信登录未开放注册");
          const enrollment = JSON.parse(flow.data);
          if (enrollment.kind !== loginKind) fail(400, "注册入口不匹配");
          const value = enrollment.value;
          const policy = profilePolicy();
          const proofs = await contactProofs(
            tx,
            req.body.proofs,
            accountBinding(req),
            "profile",
          );
          const p = await registrationProfile(
            tx,
            policy,
            { [loginKind]: value },
            { [loginKind]: true },
            Object.keys(req.body).length ? req.body : undefined,
            proofs,
          );
          if (p.needsPage) return { status: "needs_profile", ...p };
          const id = randomUUID(),
            now = new Date().toISOString();
          await tx
            .insertInto("users")
            .values({
              id,
              login: p.values.username!,
              public_id: p.values.username!,
              display_name: p.values.displayName ?? "",
              password_hash: req.body.password
                ? await hashPassword(req.body.password)
                : "",
              profile_metadata: JSON.stringify({ avatarUrl: p.values.avatar }),
              admin: 0,
              status: signup === "approval" ? "pending" : "active",
              created_at: now,
            })
            .execute();
          await emitIntegrationEvent(tx, "user.created", { userId: id });
          await claimIdentifier(tx, id, p.values.username!, "username");
          for (const key of ["phone", "email"] as const)
            if (p.values[key])
              await setContact(
                tx,
                id,
                key,
                p.values[key]!,
                key === loginKind ? "code-login" : "verification",
              );
          await tx
            .deleteFrom("account_flows")
            .where("id", "=", flow.id)
            .execute();
          if (signup === "approval") {
            await registrationReview(tx, id);
            return { status: "pending", pendingUserId: id };
          }
          await tx
            .insertInto("sessions")
            .values({
              id: tokenHash(session),
              user_id: id,
              expires_at: sessionExpiresAt(req),
            })
            .execute();
          await recordLogin(tx, id);
          return { status: "active" };
        });
        if (result.status !== "needs_profile")
          reply.header("Set-Cookie", [
            accountCookie(ctx, "doca_enrollment", "", 0),
            ...(result.status === "active" ? [ctx.cookie(session)] : []),
          ]);
        if (result.status === "pending" && "pendingUserId" in result)
          return { status: "pending" };
        return result.status === "active"
          ? mobileSession(req, session, result)
          : result;
      },
    );
  api.get("/api/v1/me/account", async (req) => {
    const a = ctx.authenticated(req),
      u = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", a.id)
        .executeTakeFirstOrThrow();
    const accountPolicy = await identityPolicy(db);
    return {
      username: u.public_id,
      revision: u.profile_revision ?? 1,
      editable: Object.fromEntries(
        await Promise.all(
          ["username", "displayName", "avatar", "email", "phone"].map(
            async (k) => [k, await profileEditable(db, a.id, k as any)],
          ),
        ),
      ),
      fields: (await identityPolicy(db)).fields,
      contacts: (
        await db
          .selectFrom("user_contacts")
          .select(["kind", "value", "verified_at"])
          .where("user_id", "=", a.id)
          .execute()
      ).filter(
        (c) => accountPolicy.fields[c.kind as "phone" | "email"].enabled,
      ),
      policy: await identityPolicy(db),
    };
  });
  api.put<{ Body: { kind: "email" | "phone"; proof: string } }>(
    "/api/v1/me/contacts",
    {
      schema: {
        body: object({
          kind: Type.Union([Type.Literal("email"), Type.Literal("phone")]),
          proof: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        }),
      },
    },
    async (req) => {
      const a = await recentAccount(db, ctx, req);
      await transact(db, async (tx) => {
        await tx
          .updateTable("users")
          .set((eb) => ({ profile_revision: eb("profile_revision", "+", 0) }))
          .where("id", "=", a.id)
          .execute();
        const u = await tx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", a.id)
          .executeTakeFirstOrThrow();
        await tx
          .updateTable("users")
          .set((eb) => ({ profile_revision: eb("profile_revision", "+", 0) }))
          .where("id", "=", a.id)
          .execute();
        await requireSecurity(
          tx,
          a.id,
          tokenHash(ctx.sessionToken(req)!),
          true,
        );
        if (!(await profileEditable(tx, a.id, req.body.kind)))
          fail(403, "该字段不可修改");
        const values = await contactProofs(
          tx,
          { [req.body.kind]: req.body.proof },
          accountBinding(req),
          "contact",
          a.id,
        );
        await setContact(
          tx,
          a.id,
          req.body.kind,
          values[req.body.kind]!,
          "verification",
        );
        const m = metadata(u.profile_metadata);
        m.overrides = { ...m.overrides, [req.body.kind]: false };
        await tx
          .updateTable("users")
          .set({
            profile_metadata: JSON.stringify(m),
            profile_revision: (u.profile_revision ?? 1) + 1,
          })
          .where("id", "=", a.id)
          .execute();
        await securityAudit(tx, a.id, a.id, "contact.updated", {
          kind: req.body.kind,
        });
      });
      return { ok: true };
    },
  );
  api.post<{
    Body: { kind: "email" | "phone"; proof: string; password: string };
  }>(
    "/api/v1/auth/recover",
    {
      schema: {
        body: object({
          kind: Type.Union([Type.Literal("email"), Type.Literal("phone")]),
          proof: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          password: Type.String({ minLength: 12, maxLength: 128 }),
        }),
      },
    },
    async (req) => {
      const p = await identityPolicy(db);
      if (!p.recoveryEnabled) fail(403, "未启用账号恢复");
      await allowSecurityMethod(db, req.body.kind);
      const hash = await hashPassword(req.body.password);
      await transact(db, async (tx) => {
        const values = await contactProofs(
          tx,
          { [req.body.kind]: req.body.proof },
          accountBinding(req),
          "recovery",
        );
        const c = await tx
          .selectFrom("user_contacts")
          .select("user_id")
          .where("kind", "=", req.body.kind)
          .where("value", "=", values[req.body.kind]!)
          .executeTakeFirst();
        if (!c) fail(400, "无法通过此方式恢复账号");
        await passwordAllowed(tx);
        const u = await tx
          .selectFrom("users")
          .select("status")
          .where("id", "=", c.user_id)
          .executeTakeFirstOrThrow();
        if (u.status !== "active") fail(403, "账号不可恢复");
        await tx
          .updateTable("users")
          .set({ password_hash: hash })
          .where("id", "=", c.user_id)
          .execute();
        await tx
          .deleteFrom("sessions")
          .where("user_id", "=", c.user_id)
          .execute();
        await securityAudit(tx, null, c.user_id, "password.recovered", {});
      });
      return { ok: true };
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id/account",
    async (req) => {
      ctx.admin(req);
      const u =
        (await db
          .selectFrom("users")
          .selectAll()
          .where("id", "=", req.params.id)
          .executeTakeFirst()) ?? fail(404, "用户不存在");
      return {
        id: u.id,
        username: u.public_id,
        displayName: u.display_name,
        revision: u.profile_revision ?? 1,
        admin: !!u.admin,
        policy: await identityPolicy(db),
        metadata: metadata(u.profile_metadata),
        contacts: await db
          .selectFrom("user_contacts")
          .selectAll()
          .where("user_id", "=", u.id)
          .execute(),
        audit: await db
          .selectFrom("security_audit")
          .selectAll()
          .where("user_id", "=", u.id)
          .orderBy("created_at", "desc")
          .limit(50)
          .execute(),
      };
    },
  );
  api.put<{
    Params: { id: string };
    Body: {
      revision: number;
      username?: string;
      displayName?: string;
      avatar?: string;
      email?: string;
      phone?: string;
      admin?: boolean;
      proofs?: { email?: string; phone?: string };
      restoreFields?: string[];
      reason: string;
    };
  }>(
    "/api/v1/admin/users/:id/account",
    {
      schema: {
        body: object({
          revision: Type.Integer({ minimum: 1 }),
          username: Type.Optional(Type.String({ maxLength: 160 })),
          displayName: Type.Optional(
            Type.String({ minLength: 1, maxLength: 160 }),
          ),
          avatar: Type.Optional(Type.String({ maxLength: 2048 })),
          email: Type.Optional(Type.String({ maxLength: 254 })),
          phone: Type.Optional(Type.String({ maxLength: 32 })),
          admin: Type.Optional(Type.Boolean()),
          proofs: Type.Optional(
            object({
              email: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
              phone: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
            }),
          ),
          restoreFields: Type.Optional(
            Type.Array(
              Type.Union(
                ["displayName", "email", "phone", "avatar"].map((v) =>
                  Type.Literal(v),
                ),
              ),
            ),
          ),
          reason: Type.String({ minLength: 1, maxLength: 500 }),
        }),
      },
    },
    async (req) => {
      const a = ctx.admin(req);
      await transact(db, async (tx) => {
        // Serialize role changes so concurrent demotions cannot remove all administrators.
        if (req.body.admin !== undefined)
          await tx
            .updateTable("settings")
            .set((eb) => ({ revision: eb("revision", "+", 0) }))
            .where("id", "=", "system")
            .execute();
        const u =
          (await tx
            .selectFrom("users")
            .selectAll()
            .where("id", "=", req.params.id)
            .executeTakeFirst()) ?? fail(404, "用户不存在");
        if ((u.profile_revision ?? 1) !== req.body.revision)
          fail(409, "用户资料已变化");
        if (!req.body.reason.trim()) fail(400, "请填写纠错原因");
        if (
          req.body.admin !== undefined &&
          Number(req.body.admin) !== u.admin
        ) {
          if (req.body.admin && u.status !== "active")
            fail(400, "只有正常账号可以设为管理员");
          const admins = await tx
            .selectFrom("users")
            .select("id")
            .where("admin", "=", 1)
            .where("status", "=", "active")
            .execute();
          if (!req.body.admin && u.status === "active" && admins.length <= 1)
            fail(409, "至少保留一名正常的系统管理员");
          await tx
            .updateTable("users")
            .set({ admin: Number(req.body.admin) })
            .where("id", "=", u.id)
            .execute();
        }
        const m = metadata(u.profile_metadata);
        m.overrides ??= {};
        const beforeContacts = await tx
          .selectFrom("user_contacts")
          .select(["kind", "value"])
          .where("user_id", "=", u.id)
          .execute();
        const proofValues = await contactProofs(
          tx,
          req.body.proofs,
          accountBinding(req),
          "contact",
          a.id,
        );
        const correctedContacts: Record<string, string> = {};
        for (const kind of ["email", "phone"] as const) {
          const value = req.body[kind] ?? proofValues[kind];
          if (
            value === undefined ||
            value === beforeContacts.find((c) => c.kind === kind)?.value
          )
            continue;
          if (value.trim()) {
            await setContact(tx, u.id, kind, value, `admin:${a.id}`);
          } else {
            const old = beforeContacts.find((c) => c.kind === kind);
            await tx
              .deleteFrom("user_contacts")
              .where("user_id", "=", u.id)
              .where("kind", "=", kind)
              .execute();
            if (old)
              await tx
                .deleteFrom("login_identifiers")
                .where("user_id", "=", u.id)
                .where("value", "=", old.value)
                .where("kind", "!=", "username")
                .execute();
          }
          correctedContacts[kind] = value;
          m.overrides[kind] = true;
        }
        if (await profileRequirements(tx, u.id))
          fail(400, "请保留注册策略要求的手机号或邮箱");
        if (req.body.avatar !== undefined) {
          if (req.body.avatar) {
            let url: URL;
            try {
              url = new URL(req.body.avatar);
            } catch {
              fail(400, "头像地址无效");
            }
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
              fail(400, "头像需为 HTTP(S) 地址");
          }
          m.avatarUrl = req.body.avatar;
          m.overrides.avatar = true;
        }
        if (req.body.username !== undefined) {
          await renameAccount(tx, u.id, req.body.username);
          m.overrides.username = true;
        }
        if (req.body.displayName !== undefined) {
          if (!req.body.displayName.trim()) fail(400, "昵称不能为空");
          await tx
            .updateTable("users")
            .set({ display_name: req.body.displayName.trim() })
            .where("id", "=", u.id)
            .execute();
          m.overrides.displayName = true;
        }
        for (const k of req.body.restoreFields ?? [])
          delete m.overrides[k as keyof ProfileValues];
        await tx
          .updateTable("users")
          .set({
            profile_metadata: JSON.stringify(m),
            profile_revision: req.body.revision + 1,
          })
          .where("id", "=", u.id)
          .execute();
        await securityAudit(tx, a.id, u.id, "profile.corrected", {
          before: {
            admin: !!u.admin,
            username: u.public_id,
            displayName: u.display_name,
            contacts: beforeContacts,
            avatar: metadata(u.profile_metadata).avatarUrl,
          },
          after: {
            ...req.body,
            proofs: undefined,
            contacts: correctedContacts,
          },
          reason: req.body.reason,
        });
      });
      return { ok: true };
    },
  );
}
import { registrationReview } from "@core/modules/identity/registration-reviews.js";
