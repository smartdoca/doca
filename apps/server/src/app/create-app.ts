import { createUserDirectory } from "@core/modules/discovery/users.js";
import { HOST_VERSION } from "./version.js";
import { sessionDurations } from "./session-policy.js";
import { imagePageAttemptLimit } from "../services/ai/image-attempt-policy.js";
import { pluginMobileActor } from "../plugins/mobile-session.js";
import { emitIntegrationEvent } from "@core/modules/automation/events.js";
import {
  bearerSession,
  mobileSession,
  registerMobileClient,
  renewMobileSession,
  sessionExpiresAt,
  startMobilePush,
} from "./mobile-client.js";
import { registerRuntimeSettings } from "../routes/runtime-settings.js";
import type { registerAI } from "../routes/ai.js";
import { passwordIdentity } from "@core/modules/identity/accounts.js";
import { registrationProfile } from "@core/modules/identity/accounts.js";
import { profilePolicy } from "@core/modules/identity/naming.js";
import { requireSecurity } from "@core/modules/identity/security.js";
import {
  adminUserDetails,
  createAdminUser,
  resetUserPassword,
} from "../routes/admin-users.js";
import { registerAccounts } from "../routes/accounts.js";
import { type MessagingRuntime } from "../adapters/messaging.js";
import {
  passwordAllowed,
  identityPolicy,
  profileRequirements,
  missingForcedLoginMethod,
} from "@core/modules/identity/accounts.js";
import { contactProofs } from "@core/modules/identity/verification.js";
import { accountBinding, readCookie } from "./account-context.js";
import swagger from "@fastify/swagger";
import { Type, type TSchema } from "@sinclair/typebox";
import Fastify, { type FastifyRequest, type HTTPMethods } from "fastify";
import { sql } from "kysely";
import { randomBytes, randomUUID } from "node:crypto";
import { authorize } from "@core/modules/access/queries.js";
import {
  createUser,
  hashPassword,
  publicUser,
  recordLogin,
  tokenHash,
  verifyPassword,
  type Actor,
} from "@core/modules/identity/passwords.js";
import {
  notificationPage,
  visibleUsers,
} from "@core/modules/interactions/community.js";
import { createVisitBuffer } from "@core/modules/interactions/visits.js";
import { AppError, fail, systemErrorText } from "@core/shared/errors.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "@core/shared/cursor.js";
import { createContent } from "@core/workflows/resources.js";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { IdentityRuntime } from "../adapters/identity-providers.js";
import { type StorageRuntime } from "../adapters/storage.js";
import { registerAssets } from "../routes/assets.js";
import { registerPageState } from "../routes/page-state.js";
import { registerDocumentPdf } from "../routes/document-pdf.js";
import { registerExperience } from "../routes/experience.js";
import { registerIdentity } from "../routes/identity.js";
import { registerRegistrationReviews } from "../routes/registration-reviews.js";
import type { SearchRuntime } from "../routes/search.js";
import { registerWorkspace } from "../routes/workspace.js";
import { registerWebhooks } from "../routes/webhooks.js";
import { dispatchWebhooks } from "../services/webhooks/dispatch.js";
import type { WebhookPost, WebhookResolve } from "../services/webhooks/http.js";
import { openWebhookDatabase, type WebhookDB } from "@db/webhook-database.js";
import { registerProfiles } from "../routes/profiles.js";
import { registerStaticRoutes } from "../routes/static.js";
import { registerTickets } from "../routes/tickets.js";
import { registerRealtime } from "../services/realtime/gateway.js";
import { createRealtimeCluster } from "../services/realtime/cluster.js";
import { composeServerPlugins } from "../plugins/composition.js";

export interface CreateAppOptions {
  origin: string;
  staticDirectory?: string;
  assetBase?: string;
  logging?: boolean;
  storage?: StorageRuntime;
  search?: SearchRuntime;
  identity?: IdentityRuntime;
  messaging?: MessagingRuntime;
  ai?: Parameters<typeof registerAI>[4];
  pluginDirectory?: string;
  plugins?: Readonly<Record<string, boolean | undefined>>;
  redisUrl?: string;
  redisPrefix?: string;
  instanceId?: string;
  trustProxy?: string[];
  webhookDatabase?: WebhookDB;
  webhookDispatch?: boolean;
  webhookResolve?: WebhookResolve;
  webhookPost?: WebhookPost;
}

export async function createApp(db: DB, options: CreateAppOptions) {
  imagePageAttemptLimit();
  sessionDurations();
  const origin = new URL(options.origin),
    api = Fastify({
      logger: options.logging
        ? {
            serializers: {
              req: (req: any) => ({
                method: req.method,
                url: String(req.url ?? "").split("?")[0],
                hostname: req.hostname,
                remoteAddress: req.ip,
              }),
            },
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              "res.headers.set-cookie",
            ],
          }
        : false,
      bodyLimit: 65536,
      trustProxy: options.trustProxy?.length ? options.trustProxy : false,
      ajv: { customOptions: { removeAdditional: false } },
    });
  await api.register(swagger, {
    openapi: {
      info: {
        title: "Doca Cloud API",
        version: HOST_VERSION,
        description:
          "No spaces or organizations. Browser writes require the configured Origin and a host-only session cookie. Mobile clients send Authorization: Bearer with the same session token. Rich text uses the authenticated /api/v1/ws Yjs channel.",
      },
      servers: [{ url: origin.origin }],
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "doca_session" },
          bearer: { type: "http", scheme: "bearer" },
        },
      },
    },
  });
  const realtimeCluster = await createRealtimeCluster({
    redisUrl: options.redisUrl,
    prefix: options.redisPrefix,
    instanceId: options.instanceId,
  });
  const actors = new WeakMap<FastifyRequest, Actor | null>(),
    library = createContent(db);
  const visits = createVisitBuffer((actor, id, stamp) =>
    library.visit(actor, id, stamp),
  );
  api.addHook("preClose", async () => {
    await visits.close();
  });
  api.addHook("preHandler", async (req) => {
    const actor = actors.get(req);
    if (req.method === "GET" && actor) await visits.flush(actor.id);
  });
  async function limit(key: string, max = 15) {
    if (!(await realtimeCluster.consumeRateLimit(key, max, 600_000)))
      fail(429, "请求过于频繁，请稍后再试");
  }
  function cookie(token: string, maxAge = sessionDurations().browserSeconds) {
    return `doca_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.protocol === "https:" ? "; Secure" : ""}`;
  }
  const scopedPlugins = new WeakMap<FastifyRequest,string>();
  const sessionTokens = new WeakMap<FastifyRequest, string | null>();
  function cookieToken(req: FastifyRequest) {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("doca_session="))
      ?.slice(13);
    return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
  }
  async function sessionUser(token: string) {
    return (
      (await db
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .select([
          "users.id",
          "users.public_id",
          "users.display_name",
          "users.admin",
        ])
        .where("sessions.id", "=", tokenHash(token))
        .where("sessions.expires_at", ">", new Date().toISOString())
        .where("users.status", "=", "active")
        .executeTakeFirst()) ?? null
    );
  }
  function sessionToken(req: FastifyRequest) {
    if (sessionTokens.has(req)) return sessionTokens.get(req) ?? null;
    return cookieToken(req);
  }
  api.addHook("onRequest", async (req, reply) => {
    if (req.url === "/api/v1/auth/logout") {
      reply.header("Set-Cookie", cookie("", 0));
    }
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (
      req.raw.rawHeaders
        .filter((_, i) => i % 2 === 0)
        .filter((h) => h.toLowerCase() === "host").length !== 1 ||
      req.headers.host?.toLowerCase() !== origin.host.toLowerCase()
    )
      fail(421, "访问地址与服务配置不符");
    const presentedCookie = cookieToken(req);
    const presentedBearer = bearerSession(req.headers.authorization);
    const bearerUser = presentedBearer
      ? await sessionUser(presentedBearer)
      : null;
    if (bearerUser && presentedBearer)
      await renewMobileSession(db, presentedBearer);
    const path = req.url.split("?")[0]!;
    const mobileCredential =
      req.headers["x-doca-client"] === "mobile" &&
      [
        "/api/v1/auth/login",
        "/api/v1/auth/register",
        "/api/v1/auth/sms",
        "/api/v1/auth/email",
        "/api/v1/auth/sms/complete",
        "/api/v1/auth/email/complete",
      ].includes(path);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !(
        req.url === "/api/v1/mcp" &&
        /^Bearer doca_mcp_[a-f0-9]{64}$/.test(req.headers.authorization ?? "")
      ) &&
      !(req.routeOptions.config as { docaPluginExternal?: boolean })
        .docaPluginExternal &&
      !bearerUser &&
      !mobileCredential &&
      req.headers.origin !== origin.origin
    )
      fail(403, "来源校验失败");
    const token = bearerUser ? presentedBearer : presentedCookie;
    const externalPlugin = (
      req.routeOptions.config as { docaPluginExternal?: boolean }
    ).docaPluginExternal;
    let user = externalPlugin
      ? null
      : (bearerUser ?? (token ? await sessionUser(token) : null));
    const scopedToken = /(?:^|;\s*)doca_plugin_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
    if(scopedToken && path.startsWith("/api/") && path!=="/api/v1/plugins-mobile/redeem") {
      const scoped=await pluginMobileActor(db,scopedToken,pluginComposition.plugins.map(p=>p.id));
      if (!(req.method==="GET" && (path==="/api/v1/bootstrap" || path.startsWith(`/api/v1/plugin-assets/${scoped.plugin_id}/`))) && !path.startsWith(`/api/v1/plugins/${scoped.plugin_id}/`) && !(req.method === "POST" && path.startsWith(`/api/v1/plugin-platform/${scoped.plugin_id}/`))) fail(403,"Plugin session scope denied");
      scopedPlugins.set(req,scoped.plugin_id);user={id:scoped.id,display_name:scoped.display_name,admin:scoped.admin,public_id:undefined};
    }
    sessionTokens.set(req, user && token ? token : null);
    if (path.startsWith("/api/v1/plugin-platform/")) {
      const pluginId = path.split("/")[4];
      if (!pluginComposition.plugins.some(plugin => plugin.id === pluginId)) fail(404, "Plugin unavailable");
    }
    actors.set(req, user ?? null);
    const accountPath = req.url.split("?")[0]!;
    const forcedLoginMethod = user
      ? await missingForcedLoginMethod(db, user.id, await identityPolicy(db), {
          phoneReady: runtime.messaging.phoneReady,
          emailReady: runtime.messaging.emailReady,
          providerReady: (ref) =>
            Object.hasOwn(runtime.identity.credentials, ref) &&
            typeof runtime.identity.credentials[ref] === "string" &&
            !!runtime.identity.credentials[ref],
        })
      : null;
    if (
      user &&
      accountPath.startsWith("/api/v1/") &&
      ((await profileRequirements(db, user.id)) || !!forcedLoginMethod) &&
      !accountPath.startsWith("/api/v1/auth/") &&
      ![
        "/api/v1/me",
        "/api/v1/me/account",
        "/api/v1/me/security",
        "/api/v1/me/contacts",
        "/api/v1/me/onboarding",
        "/api/v1/me/profile",
        "/api/v1/me/identities",
        "/api/v1/bootstrap",
      ].includes(accountPath) &&
      !accountPath.startsWith("/api/v1/me/identities/") &&
      !(
        user.admin &&
        accountPath.startsWith("/api/v1/admin/") &&
        !forcedLoginMethod
      )
    ) {
      reply.header("X-Doca-Profile-Required", "1");
      fail(
        403,
        forcedLoginMethod
          ? "请先到账号资料页面补充指定登录方式"
          : "请先到账号资料页面补全必填联系方式",
      );
    }
  });
  api.setErrorHandler((error, req, reply) => {
    const conflict = [
      "23505",
      "40001",
      "40P01",
      "SQLITE_CONSTRAINT_UNIQUE",
      "SQLITE_CONSTRAINT_PRIMARYKEY",
      "SQLITE_BUSY",
      "SQLITE_BUSY_SNAPSHOT",
    ].includes((error as { code?: string }).code ?? "");
    const frameworkStatus =
      error && typeof error === "object" && "statusCode" in error
        ? Number(error.statusCode)
        : 0;
    const status =
      error instanceof AppError
        ? error.status
        : error && typeof error === "object" && "validation" in error
          ? 400
          : [400, 413, 415, 429].includes(frameworkStatus)
            ? frameworkStatus
            : conflict
              ? 409
              : 500;
    if (status === 500) req.log.error({ err: error }, "Request failed");
    reply.code(status).send({
      message:
        error instanceof AppError
          ? systemErrorText(error)
          : status === 400
            ? "请求参数无效"
            : status === 409
              ? "操作发生冲突，请刷新或更换用户名后重试"
              : "服务暂时不可用",
      requestId: req.id,
    });
  });
  const actor = (req: FastifyRequest) => actors.get(req) ?? null;
  const authenticated = (req: FastifyRequest) =>
    actor(req) ?? fail(401, "请先登录");
  const admin = (req: FastifyRequest) => {
    const a = authenticated(req);
    if (!a.admin) fail(403, "需要系统管理员权限");
    return a;
  };
  const runtime = await registerRuntimeSettings(api, db, admin, options);
  registerRegistrationReviews(api, db, { admin });
  registerTickets(api, db, {
    origin,
    actor,
    authenticated,
    admin,
    sessionToken,
    cookie,
    limit,
  });
  registerAccounts(
    api,
    db,
    {
      origin,
      actor,
      authenticated,
      admin,
      sessionToken,
      cookie,
      limit,
      providerReady: (ref) =>
        Object.hasOwn(runtime.identity.credentials, ref) &&
        typeof runtime.identity.credentials[ref] === "string" &&
        !!runtime.identity.credentials[ref],
    },
    runtime.messaging,
  );
  const stopMobilePush = startMobilePush(db);
  api.addHook("preClose", async () => {
    await stopMobilePush();
  });
  registerMobileClient(api, db, authenticated, cookie, limit);
  registerIdentity(
    api,
    db,
    {
      origin,
      actor,
      authenticated,
      admin,
      sessionToken,
      cookie,
      limit,
      loginMethodRuntime: {
        phoneReady: runtime.messaging.phoneReady,
        emailReady: runtime.messaging.emailReady,
      },
    },
    runtime.identity,
  );
  const realtime = await registerRealtime(
    api,
    db,
    origin.origin,
    async (req) => {
      const token = sessionToken(req);
      if (!token) return null;
      const session = await db
        .selectFrom("sessions")
        .select("user_id")
        .where("id", "=", tokenHash(token))
        .executeTakeFirst();
      if (session && (await profileRequirements(db, session.user_id)))
        return null;
      return (
        (await db
          .selectFrom("sessions")
          .innerJoin("users", "users.id", "sessions.user_id")
          .select([
            "users.id",
            "users.public_id",
            "users.display_name",
            "users.admin",
          ])
          .where("sessions.id", "=", tokenHash(token))
          .where("sessions.expires_at", ">", new Date().toISOString())
          .where("users.status", "=", "active")
          .executeTakeFirst()) ?? null
      );
    },
    realtimeCluster,
  );
  api.addHook("preClose", async () => realtimeCluster.close());
  registerWorkspace(api, db, authenticated, admin, realtime.onlineUsers);
  const webhookDb =
    options.webhookDatabase ??
    (await openWebhookDatabase({ driver: "sqlite", path: ":memory:" }));
  const ownsWebhookDatabase = !options.webhookDatabase;
  registerWebhooks(api, db, webhookDb, admin, options.webhookResolve);
  let webhookDispatching: Promise<unknown> | undefined;
  const webhookTimer = options.webhookDispatch
    ? setInterval(() => {
        if (webhookDispatching) return;
        webhookDispatching = dispatchWebhooks(db, webhookDb, {
          post: options.webhookPost,
          resolve: options.webhookResolve,
        })
          .catch((error) => {
            api.log.error({ err: error }, "Webhook dispatch failed");
          })
          .finally(() => {
            webhookDispatching = undefined;
          });
      }, 1000)
    : undefined;
  api.addHook("preClose", async () => {
    if (webhookTimer) clearInterval(webhookTimer);
    await webhookDispatching;
    if (ownsWebhookDatabase) await webhookDb.destroy();
  });
  registerPageState(api, db, authenticated);
  registerDocumentPdf(api, db, actor);
  const pluginComposition = await composeServerPlugins({
    api,
    db,
    auth: authenticated,
    admin,
    origin,
    runtime,
    options,
    realtime,
    consumeRateLimit: (key, max, windowMs) =>
      realtimeCluster.consumeRateLimit(key, max, windowMs),
  }).catch(async (error) => {
    // Failed composition must release already-created connections and workers.
    try {
      await api.close();
    } finally {
      throw error;
    }
  });
  // Fastify routes are immutable after mounting, so the host is intentionally
  // disposed only from application close (or startup rollback below).
  api.addHook("preClose", async () => pluginComposition.host.dispose());
  const search = pluginComposition.search;
  registerProfiles(api, db, authenticated);
  registerAssets(api, db, authenticated, actor, admin, runtime.storage, limit);
  const id = Type.String({ format: "uuid" }),
    nullableId = Type.Union([id, Type.Null()]),
    version = Type.Integer({ minimum: 1 }),
    name = Type.String({ minLength: 1, maxLength: 160, pattern: "\\S" }),
    password = Type.String({ minLength: 12, maxLength: 128 });
  const object = (properties: Record<string, TSchema>) =>
    Type.Object(properties, { additionalProperties: false });
  const optional = <T extends TSchema>(schema: T) => Type.Optional(schema);
  registerExperience(api, db, actor, authenticated);
  const role = Type.Union(
    ["reader", "commenter", "editor", "manager"].map((x) => Type.Literal(x)),
  );
  function route<B = unknown>(
    method: HTTPMethods,
    path: string,
    summary: string,
    body: TSchema | undefined,
    handler: (
      req: FastifyRequest<{ Body: B; Params: Record<string, string> }>,
      a: Actor,
    ) => Promise<unknown>,
  ) {
    const params = Object.fromEntries(
      [...path.matchAll(/:([a-zA-Z]+)/g)].map((m) => [m[1]!, id]),
    );
    api.route<{ Body: B; Params: Record<string, string> }>({
      method,
      url: "/api/v1" + path,
      bodyLimit:
        method === "POST" &&
        [
          "/resources",
          "/resources/:id/import-initial",
          "/resources/:id/import-markdown-initial",
        ].includes(path)
          ? 4 * 1024 * 1024
          : 65536,
      schema: {
        summary,
        tags: ["Content"],
        security: [{ session: [] }],
        ...(body ? { body } : {}),
        ...(Object.keys(params).length ? { params: object(params) } : {}),
      },
      handler: (req) => handler(req, authenticated(req)),
    });
  }
  api.get(
    "/api/v1/bootstrap",
    { schema: { summary: "公开站点配置及当前会话", tags: ["Authentication"] } },
    async (req) => {
      const settings = await db
        .selectFrom("settings")
        .selectAll()
        .where("id", "=", "system")
        .executeTakeFirstOrThrow();
      const initialized = !!(await db
        .selectFrom("users")
        .select("id")
        .where("admin", "=", 1)
        .executeTakeFirst());
      const missingLoginMethod = actor(req)
        ? await missingForcedLoginMethod(
            db,
            actor(req)!.id,
            await identityPolicy(db),
            {
              phoneReady: runtime.messaging.phoneReady,
              emailReady: runtime.messaging.emailReady,
              providerReady: (ref) =>
                Object.hasOwn(runtime.identity.credentials, ref) &&
                typeof runtime.identity.credentials[ref] === "string" &&
                !!runtime.identity.credentials[ref],
            },
          )
        : null;
      return {
        siteName: settings.site_name,
        defaultLocale: settings.default_locale ?? "zh",
        defaultTimezone: settings.default_timezone ?? "Asia/Shanghai",
        registrationEnabled: !!settings.registration,
        authOptions: await identityPolicy(db),
        needsProfile: actor(req)
          ? !!(
              (await profileRequirements(db, actor(req)!.id)) ||
              missingLoginMethod
            )
          : false,
        forcedLoginMethod: missingLoginMethod,
        initialized,
        user: actor(req) ? publicUser(actor(req)!) : null,
        capabilities: {
          editing: true,
          realtime: true,
          oidcClient: true,
          oidcProvider: false,
          hooks: true,
          integrationEventStream: true,
        },
        plugins: scopedPlugins.has(req) ? pluginComposition.plugins.filter(p=>p.id===scopedPlugins.get(req)) : pluginComposition.plugins,
      };
    },
  );
  api.post<{ Body: { login: string; password: string } }>(
    "/api/v1/auth/login",
    {
      schema: {
        summary: "账号密码登录",
        tags: ["Authentication"],
        body: object({
          login: name,
          password: Type.String({ minLength: 1, maxLength: 128 }),
        }),
      },
    },
    async (req, reply) => {
      await limit(`login:${req.ip}`);
      await passwordAllowed(db);
      const identifier = await passwordIdentity(db, req.body.login);
      const user = identifier
        ? await db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", identifier.user_id)
            .executeTakeFirst()
        : undefined;
      if (
        !(await verifyPassword(req.body.password, user?.password_hash ?? "")) ||
        !user
      )
        fail(401, "账号或密码错误");
      await passwordAllowed(db);
      if (user.status === "pending") return { status: "pending" };
      if (user.status !== "active") fail(401, "账号或密码错误");
      const token = randomBytes(32).toString("hex");
      await transact(db, async (tx) => {
        await passwordAllowed(tx);
        if ((await passwordIdentity(tx, req.body.login))?.user_id !== user.id)
          fail(401, "账号或密码错误");
        const current = await tx
          .selectFrom("users")
          .select(["status", "password_hash"])
          .where("id", "=", user.id)
          .executeTakeFirstOrThrow();
        if (
          current.status !== "active" ||
          current.password_hash !== user.password_hash
        )
          fail(401, "账号状态已变化，请重新登录");
        await tx
          .deleteFrom("sessions")
          .where("expires_at", "<=", new Date().toISOString())
          .execute();
        await tx
          .insertInto("sessions")
          .values({
            id: tokenHash(token),
            user_id: user.id,
            expires_at: sessionExpiresAt(req),
          })
          .execute();
        await recordLogin(tx, user.id);
      });
      reply.header("Set-Cookie", cookie(token));
      return mobileSession(req, token, { user: publicUser(user) });
    },
  );
  api.post<{
    Body: {
      login: string;
      password: string;
      displayName?: string;
      avatar?: string;
      email?: string;
      phone?: string;
      publicId?: string;
      proofs?: Partial<Record<"email" | "phone", string>>;
    };
  }>(
    "/api/v1/auth/register",
    {
      schema: {
        summary: "公开注册（需管理员开启）",
        tags: ["Authentication"],
        body: object({
          login: name,
          password,
          displayName: optional(Type.String({ maxLength: 160 })),
          avatar: optional(Type.String({ maxLength: 2048 })),
          email: optional(Type.String({ maxLength: 254 })),
          phone: optional(Type.String({ maxLength: 32 })),
          publicId: optional(name),
          proofs: optional(
            object({ email: optional(name), phone: optional(name) }),
          ),
        }),
      },
    },
    async (req, reply) => {
      await limit(`register:${req.ip}`, 5);
      const result = await transact(db, async (tx) => {
        const proofs = await contactProofs(
          tx,
          req.body.proofs,
          accountBinding(req),
          "profile",
        );
        const fields = await registrationProfile(
          tx,
          profilePolicy(),
          {},
          {},
          {
            ...req.body,
            username: req.body.publicId ?? req.body.login,
            email: proofs.email ?? req.body.email,
            phone: proofs.phone ?? req.body.phone,
          },
          proofs,
        );
        const u = await createUser(
          tx,
          {
            ...req.body,
            login: fields.values.username!,
            publicId: fields.values.username!,
            displayName: fields.values.displayName ?? "",
          },
          { registration: true, verifiedContacts: proofs },
        );
        if (fields.values.avatar)
          await tx
            .updateTable("users")
            .set({
              profile_metadata: JSON.stringify({
                avatarUrl: fields.values.avatar,
              }),
            })
            .where("id", "=", u.id)
            .execute();
        if (u.status === "active") {
          const session = randomBytes(32).toString("hex");
          await tx
            .insertInto("sessions")
            .values({
              id: tokenHash(session),
              user_id: u.id,
              expires_at: sessionExpiresAt(req),
            })
            .execute();
          await recordLogin(tx, u.id);
          return { ...u, session };
        }
        return { ...u, session: undefined };
      });
      if (result.session) reply.header("Set-Cookie", cookie(result.session));
      if (result.status === "pending") return { status: "pending" };
      const { session, ...publicResult } = result;
      return mobileSession(req, session, publicResult);
    },
  );
  route("POST", "/auth/logout", "退出当前会话", undefined, async (req) => {
    const token = sessionToken(req);
    if (token)
      await db
        .deleteFrom("sessions")
        .where("id", "=", tokenHash(token))
        .execute();
    return { ok: true };
  });
  route<{ newPassword: string }>(
    "POST",
    "/auth/password",
    "修改密码并撤销全部会话",
    object({
      newPassword: password,
    }),
    async (req, a) => {
      await limit(`password:${a.id}`, 5);
      await passwordAllowed(db);
      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", a.id)
        .executeTakeFirstOrThrow();
      await requireSecurity(db, a.id, tokenHash(sessionToken(req)!));
      const hash = await hashPassword(req.body.newPassword);
      await transact(db, async (tx) => {
        await passwordAllowed(tx);
        await requireSecurity(tx, a.id, tokenHash(sessionToken(req)!), true);
        const changed = await tx
          .updateTable("users")
          .set({ password_hash: hash })
          .where("id", "=", a.id)
          .where("password_hash", "=", user.password_hash)
          .executeTakeFirst();
        if (!changed.numUpdatedRows) fail(409, "密码已变更，请重新登录");
        await tx.deleteFrom("sessions").where("user_id", "=", a.id).execute();
      });
      return { ok: true };
    },
  );
  const userDirectory = createUserDirectory(db);
  api.get<{ Querystring: { query?: string; cursor?: string; limit?: number } }>(
    "/api/v1/users/directory", {
      schema: { querystring: object({ query: optional(Type.String({ maxLength: 160 })), cursor: optional(Type.String({ maxLength: 2048 })), limit: optional(Type.Integer({ minimum: 1, maximum: 100 })) }) },
    }, async req => userDirectory.search(authenticated(req), { ...req.query, query: req.query.query ?? "" }),
  );
  for (const action of ["resolve", "validate"] as const)
    api.post<{ Body: { ids: string[] } }>(`/api/v1/users/directory/${action}`, {
      schema: { body: object({ ids: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 }) }) },
    }, async req => {
      const actor = authenticated(req);
      if (action === "resolve") return { items: await userDirectory.resolve(actor, req.body) };
      await userDirectory.validate(actor, req.body);
      return { valid: true };
    });
  api.get<{ Querystring: { q: string } }>(
    "/api/v1/users/lookup",
    {
      schema: {
        summary: "协作者选择（按名称/精确账号搜索）",
        tags: ["Users"],
        querystring: object({
          q: Type.String({ maxLength: 160 }),
        }),
      },
    },
    async (req) => {
      return { items: await visibleUsers(db, authenticated(req), req.query.q) };
    },
  );
  api.get<{
    Querystring: {
      cursor?: string;
      q?: string;
      status?: string;
    };
  }>(
    "/api/v1/admin/users",
    {
      schema: {
        summary: "分页用户管理",
        tags: ["Administration"],
        querystring: object({
          cursor: optional(Type.String({ maxLength: 2048 })),
          parentId: optional(id),
          q: optional(name),
          status: optional(
            Type.Union([
              Type.Literal("active"),
              Type.Literal("pending"),
              Type.Literal("disabled"),
            ]),
          ),
        }),
      },
    },
    async (req) => {
      admin(req);
      let query = db
        .selectFrom("users")
        .select([
          "id",
          "login",
          "display_name",
          "admin",
          "status",
          "created_at",
          "last_login_at",
          "public_id",
          "directory_mode",
        ]);
      if (req.query.status)
        query = query.where("status", "=", req.query.status);
      if (req.query.q)
        query = query.where((eb) =>
          eb.or([
            eb("display_name", "like", `%${req.query.q}%`),
            eb("login", "like", `%${req.query.q}%`),
            eb("public_id", "like", `%${req.query.q}%`),
          ]),
        );
      const fingerprint = cursorFingerprint({
        kind: "admin-users",
        q: req.query.q ?? "",
        status: req.query.status ?? "",
      });
      if (req.query.cursor) {
        const cursor = decodePageCursor(req.query.cursor, fingerprint);
        query = query.where(
          sql<boolean>`(created_at < ${cursor.value} or (created_at = ${cursor.value} and id > ${cursor.id}))`,
        );
      }
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(101)
        .execute();
      const items = rows.slice(0, 100);
      const last = items.at(-1);
      return {
        items: await adminUserDetails(db, items),
        nextCursor:
          rows.length > 100 && last
            ? encodePageCursor(fingerprint, last.created_at, last.id)
            : null,
      };
    },
  );
  route<{
    login: string;
    password?: string;
    displayName: string;
    email?: string;
    phone?: string;
    avatar?: string;
  }>(
    "POST",
    "/admin/users",
    "管理员创建用户",
    object({
      login: name,
      password: optional(password),
      displayName: Type.String({ maxLength: 160 }),
      email: optional(Type.String({ maxLength: 254 })),
      phone: optional(Type.String({ maxLength: 32 })),
      avatar: optional(Type.String({ maxLength: 2048 })),
    }),
    async (req) => {
      const a = admin(req);
      await limit(`create:${a.id}`, 20);
      const user = await createAdminUser(db, a, req.body);
      return user;
    },
  );
  route<{ status: "active" | "disabled" }>(
    "PATCH",
    "/admin/users/:id",
    "启用或停用普通用户",
    object({
      status: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
    }),
    async (req) => {
      const a = admin(req);
      if (a.id === req.params.id) fail(400, "不能停用自己");
      await transact(db, async (tx) => {
        const user = await tx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", req.params.id!)
          .executeTakeFirst();
        if (!user) fail(404, "用户不存在");
        if (user.admin) fail(403, "不能在此修改其他管理员");
        if (user.status === "pending") fail(409, "请在注册审核页面处理此申请");
        await tx
          .updateTable("users")
          .set({ status: req.body.status })
          .where("id", "=", user.id)
          .execute();
        if (user.status !== req.body.status)
          await emitIntegrationEvent(tx, "user.status.changed", {
            userId: user.id,
            status: req.body.status,
            previousStatus: user.status,
          });
        if (req.body.status === "disabled")
          await tx
            .deleteFrom("sessions")
            .where("user_id", "=", user.id)
            .execute();
        await tx
          .insertInto("audit_events")
          .values({
            id: randomUUID(),
            actor_id: a.id,
            resource_id: null,
            action: "user.status_changed",
            created_at: new Date().toISOString(),
          })
          .execute();
      });
      return { ok: true };
    },
  );
  route<{ password: string }>(
    "POST",
    "/admin/users/:id/password",
    "管理员重置用户密码",
    object({ password }),
    async (req) => {
      const a = admin(req);
      await limit(`password-reset:${a.id}`, 20);
      await resetUserPassword(db, a, req.params.id!, req.body.password);
      return { ok: true };
    },
  );
  api.get(
    "/api/v1/admin/settings",
    { schema: { summary: "读取系统设置", tags: ["Administration"] } },
    async (req) => {
      admin(req);
      return db
        .selectFrom("settings")
        .selectAll()
        .where("id", "=", "system")
        .executeTakeFirstOrThrow();
    },
  );
  route<{
    revision: number;
    siteName: string;
    registrationEnabled: boolean;
    defaultLocale: string;
    defaultTimezone: string;
  }>(
    "PUT",
    "/admin/settings",
    "修改站点信息和通用默认配置",
    object({
      revision: version,
      siteName: name,
      defaultLocale: Type.Union([Type.Literal("zh"), Type.Literal("en")]),
      defaultTimezone: Type.String({ minLength: 1, maxLength: 100 }),
      registrationEnabled: Type.Boolean(),
    }),
    async (req) => {
      admin(req);
      try {
        new Intl.DateTimeFormat("en", { timeZone: req.body.defaultTimezone });
      } catch {
        fail(400, "时区无效，请选择有效的 IANA 时区");
      }
      const changed = await db
        .updateTable("settings")
        .set({
          site_name: req.body.siteName.trim(),
          default_locale: req.body.defaultLocale,
          default_timezone: req.body.defaultTimezone,
          registration: Number(req.body.registrationEnabled),
          revision: req.body.revision + 1,
        })
        .where("id", "=", "system")
        .where("revision", "=", req.body.revision)
        .executeTakeFirst();
      if (!changed.numUpdatedRows) fail(409, "设置已被修改，请刷新");
      return { ok: true };
    },
  );
  api.get<{
    Querystring: {
      q?: string;
      mode?: "keyword" | "ai";
      scope?: string;
      location?: "personal" | "library";
      libraryIds?: string[];
      ownerIds?: string[];
      visitedWithinDays?: number;
      likedOnly?: boolean;
      favoritesOnly?: boolean;
      format?: string;
      cursor?: string;
      offset?: number;
    };
  }>(
    "/api/v1/search/documents",
    {
      schema: {
        tags: ["Content"],
        summary:
          "只搜索文档；知识库为筛选条件，多个知识库取并集，其余条件取交集",
        security: [{ session: [] }],
        querystring: object({
          q: optional(Type.String({ maxLength: 500 })),
          mode: optional(
            Type.Union([Type.Literal("keyword"), Type.Literal("ai")]),
          ),
          scope: optional(
            Type.Union(
              ["all", "owned", "shared", "favorites", "recent", "discover"].map(
                (x) => Type.Literal(x),
              ),
            ),
          ),
          location: optional(
            Type.Union([Type.Literal("personal"), Type.Literal("library")]),
          ),
          libraryIds: optional(
            Type.Array(id, { minItems: 1, maxItems: 50, uniqueItems: true }),
          ),
          ownerIds: optional(
            Type.Array(id, { minItems: 1, maxItems: 10, uniqueItems: true }),
          ),
          visitedWithinDays: optional(
            Type.Integer({ minimum: 1, maximum: 3650 }),
          ),
          likedOnly: optional(Type.Boolean()),
          favoritesOnly: optional(Type.Boolean()),
          format: optional(
            Type.Union(
              [
                "rich_text",
                "spreadsheet",
                "presentation",
                "markdown",
                "canvas",
              ].map((x) => Type.Literal(x)),
            ),
          ),
          offset: optional(Type.Integer({ minimum: 0, maximum: 100000 })),
          cursor: optional(Type.String({ maxLength: 2048 })),
          parentId: optional(id),
        }),
      },
    },
    async (req) =>
      search.search(authenticated(req), { ...req.query, kind: "document" }),
  );
  api.get<{
    Querystring: {
      scope?: string;
      kind?: string;
      q?: string;
      libraryId?: string;
      cursor?: string;
      parentId?: string;
      tree?: boolean;
      format?: string;
      sort?: string;
      order?: string;
    };
  }>(
    "/api/v1/resources",
    {
      schema: {
        summary: "按权限过滤的文档/知识库列表和标题检索",
        tags: ["Content"],
        querystring: object({
          scope: optional(
            Type.Union(
              [
                "mine",
                "owned",
                "recent",
                "shared",
                "libraries",
                "favorites",
                "pins",
                "trash",
                "all",
                "discover",
                "collected",
                "personal",
                "public",
              ].map((x) => Type.Literal(x)),
            ),
          ),
          kind: optional(
            Type.Union([Type.Literal("document"), Type.Literal("library")]),
          ),
          q: optional(Type.String({ maxLength: 160 })),
          sort: optional(
            Type.Union(
              ["created_at", "updated_at", "visited_at"].map((x) =>
                Type.Literal(x),
              ),
            ),
          ),
          order: optional(
            Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
          ),
          libraryId: optional(id),
          cursor: optional(Type.String({ maxLength: 2048 })),
          parentId: optional(id),
          tree: optional(Type.Boolean()),
          format: optional(
            Type.Union(
              [
                "rich_text",
                "spreadsheet",
                "presentation",
                "markdown",
                "canvas",
              ].map((x) => Type.Literal(x)),
            ),
          ),
        }),
      },
    },
    async (req) =>
      library.list(actor(req), {
        ...req.query,
        includeAncestors: req.query.tree,
      }),
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id",
    {
      schema: {
        summary: "读取单个资源（公开资源允许匿名阅读）",
        tags: ["Content"],
        params: object({ id }),
      },
    },
    async (req) => library.detail(actor(req), req.params.id),
  );
  route(
    "POST",
    "/resources/:id/visit",
    "记录本人访问（重新鉴权）",
    undefined,
    async (req, a) => {
      await authorize(db, a, req.params.id!);
      visits.record(a, req.params.id!);
      return { ok: true };
    },
  );
  route<Parameters<typeof library.create>[1]>(
    "POST",
    "/resources",
    "创建私有文档或知识库",
    object({
      title: name,
      kind: Type.Union([Type.Literal("document"), Type.Literal("library")]),
      markdown: optional(Type.String({ maxLength: 524288 })),
      initialContent: optional(Type.Unknown()),
      template: optional(object({
        ref: object({ providerId: name, id: name, revision: name }),
        parameters: Type.Record(Type.String(), Type.Unknown()),
      })),
      format: Type.Union(
        ["rich_text", "spreadsheet", "presentation", "markdown", "canvas"].map(
          (x) => Type.Literal(x),
        ),
      ),
      parentId: optional(nullableId),
      libraryId: optional(nullableId),
    }),
    (req, a) => library.create(a, req.body),
  );
  route<{ initialContent: unknown }>(
    "POST",
    "/resources/:id/import-initial",
    "初始化新建导入文档（不可覆盖）",
    object({ initialContent: Type.Unknown() }),
    (req, a) =>
      library.initializeImport(a, req.params.id!, req.body.initialContent),
  );
  route<{ markdown: string }>(
    "POST",
    "/resources/:id/import-markdown-initial",
    "初始化新建 Markdown 导入文档（不可覆盖）",
    object({ markdown: Type.String({ maxLength: 524288 }) }),
    (req, a) =>
      library.initializeMarkdownImport(a, req.params.id!, req.body.markdown),
  );
  route<{ title: string; version: number }>(
    "PATCH",
    "/resources/:id",
    "重命名",
    object({ title: name, version }),
    (req, a) =>
      library.rename(a, req.params.id!, req.body.title, req.body.version),
  );
  route<{ pageWidth: string; version: number }>(
    "PATCH",
    "/resources/:id/page-width",
    "保存富文本内容宽度",
    object({
      pageWidth: Type.Union(["a4", "a3", "fluid"].map((x) => Type.Literal(x))),
      version,
    }),
    (req, a) =>
      library.setPageWidth(
        a,
        req.params.id!,
        req.body.pageWidth,
        req.body.version,
      ),
  );
  route<Parameters<typeof library.permissions>[2]>(
    "PUT",
    "/resources/:id/permissions",
    "设置权限和协作者",
    object({
      version,
      accessMode: optional(
        Type.Union([Type.Literal("inherit"), Type.Literal("custom")]),
      ),
      visibility: optional(
        Type.Union(
          ["invited", "requestable", "authenticated", "public"].map((x) =>
            Type.Literal(x),
          ),
        ),
      ),
      resetFields: optional(
        Type.Array(
          Type.Union(
            [
              "visibility",
              "public_role",
              "requests_enabled",
              "discoverable",
              "history_readers",
              "share_links_enabled",
            ].map((x) => Type.Literal(x)),
          ),
        ),
      ),
      grants: optional(
        Type.Array(
          object({
            userId: id,
            role,
            includeDescendants: optional(Type.Boolean()),
          }),
          { maxItems: 100 },
        ),
      ),
      publicRole: optional(
        Type.Union(
          ["reader", "commenter", "editor"].map((x) => Type.Literal(x)),
        ),
      ),
      requestsEnabled: optional(Type.Boolean()),
      discoverable: optional(Type.Boolean()),
      historyReaders: optional(Type.Boolean()),
    }),
    (req, a) => library.permissions(a, req.params.id!, req.body),
  );
  route<Parameters<typeof library.transfer>[2]>(
    "POST",
    "/resources/:id/transfer",
    "转移所有权（仅所有者）",
    object({ version, userId: id, retainAccess: Type.Boolean() }),
    (req, a) => library.transfer(a, req.params.id!, req.body),
  );
  route<Parameters<typeof library.move>[2]>(
    "POST",
    "/resources/:id/move",
    "移动子树并重置分享为私有",
    object({ version, parentId: nullableId, libraryId: nullableId }),
    (req, a) => library.move(a, req.params.id!, req.body),
  );
  route<Parameters<typeof library.arrange>[2]>(
    "POST",
    "/resources/:id/arrange",
    "同一目录范围内排序或调整父文档",
    object({
      version,
      targetId: id,
      placement: Type.Union([
        Type.Literal("before"),
        Type.Literal("after"),
        Type.Literal("inside"),
      ]),
    }),
    (req, a) => library.arrange(a, req.params.id!, req.body),
  );
  route<Parameters<typeof library.copy>[2]>(
    "POST",
    "/resources/:id/copy",
    "复制当前文档或整棵子树",
    undefined,
    (req, a) =>
      library.copy(
        a,
        req.params.id!,
        (req.body ?? {}) as Parameters<typeof library.copy>[2],
      ),
  );
  route(
    "GET",
    "/resources/:id/trash-preview",
    "只读预览回收站文件（管理者）",
    undefined,
    (req, a) => library.trashPreview(a, req.params.id!),
  );
  route<{ targets: { id: string; version: number }[] }>(
    "POST",
    "/trash/purge",
    "永久清空已确认的回收站文件",
    object({
      targets: Type.Array(object({ id, version }), {
        minItems: 1,
        maxItems: 1000,
      }),
    }),
    (req, a) => library.purgeTrash(a, req.body.targets),
  );
  for (const action of ["trash", "restore"])
    route<{ version: number }>(
      "POST",
      `/resources/:id/${action}`,
      action === "trash" ? "移入回收站" : "恢复删除批次",
      object({ version }),
      (req, a) =>
        library.trash(
          a,
          req.params.id!,
          req.body.version,
          action === "restore",
        ),
    );
  route<{ version: number }>(
    "POST",
    "/resources/:id/purge",
    "永久删除回收站中的一项及其已删除的子文档",
    object({ version }),
    (req, a) => library.purgeDeleted(a, req.params.id!, req.body.version),
  );
  route<{ kind: "like" | "favorite" | "pin"; enabled: boolean }>(
    "PUT",
    "/resources/:id/reaction",
    "点赞、收藏或置顶（幂等）",
    object({
      kind: Type.Union([
        Type.Literal("like"),
        Type.Literal("favorite"),
        Type.Literal("pin"),
      ]),
      enabled: Type.Boolean(),
    }),
    (req, a) =>
      library.reaction(a, req.params.id!, req.body.kind, req.body.enabled),
  );
  api.get<{
    Params: { id: string };
    Querystring: { cursor?: string; target?: string };
  }>(
    "/api/v1/resources/:id/comments",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        querystring: Type.Object(
          {
            cursor: Type.Optional(Type.String({ maxLength: 2048 })),
            target: Type.Optional(Type.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      library.commentPage(
        actor(req),
        req.params.id,
        req.query.cursor,
        req.query.target,
      ),
  );
  route<{
    richBody: unknown;
    parentId: string | null;
    anchor?: string;
  }>(
    "POST",
    "/resources/:id/comments",
    "新增全文评论或回复",
    object({
      richBody: Type.Unknown(),
      parentId: nullableId,
      anchor: optional(Type.String({ maxLength: 12000 })),
    }),
    (req, a) =>
      library.comment(
        a,
        req.params.id!,
        req.body.richBody,
        req.body.parentId,
        req.body.anchor,
      ),
  );
  route<Parameters<typeof library.updateComment>[3]>(
    "PATCH",
    "/resources/:id/comments/:commentId",
    "修改、删除或处理评论",
    object({
      version,
      richBody: optional(Type.Unknown()),
      deleted: optional(Type.Boolean()),
      resolved: optional(Type.Boolean()),
    }),
    (req, a) =>
      library.updateComment(a, req.params.id!, req.params.commentId!, req.body),
  );
  api.get<{ Querystring: { offset?: number } }>(
    "/api/v1/notifications",
    {
      schema: {
        summary: "分页读取自己的通知",
        tags: ["Notifications"],
        querystring: object({
          offset: optional(Type.Integer({ minimum: 0, maximum: 100000 })),
          cursor: optional(Type.String({ maxLength: 2048 })),
          parentId: optional(id),
        }),
      },
    },
    async (req) => {
      const a = authenticated(req);
      return notificationPage(db, a, req.query.offset ?? 0);
    },
  );
  route(
    "POST",
    "/notifications/read-all",
    "将自己的通知全部标记为已读",
    object({}),
    async (_req, a) => {
      await db
        .updateTable("notifications")
        .set({ read_at: new Date().toISOString() })
        .where("user_id", "=", a.id)
        .where("read_at", "is", null)
        .execute();
      return { ok: true };
    },
  );
  route<{ ids: string[] }>(
    "POST",
    "/notifications/read",
    "标记自己的通知为已读",
    object({ ids: Type.Array(id, { minItems: 1, maxItems: 100 }) }),
    async (req, a) => {
      await db
        .updateTable("notifications")
        .set({ read_at: new Date().toISOString() })
        .where("user_id", "=", a.id)
        .where("id", "in", req.body.ids)
        .execute();
      return { ok: true };
    },
  );
  await registerStaticRoutes(
    api,
    db,
    options.staticDirectory,
    () => realtimeCluster.isReady(),
    options.assetBase,
  );
  try {
    await api.ready();
  } catch (error) {
    await pluginComposition.host.dispose();
    if (webhookTimer) clearInterval(webhookTimer);
    await webhookDispatching;
    if (ownsWebhookDatabase) await webhookDb.destroy();
    throw error;
  }
  return api;
}
