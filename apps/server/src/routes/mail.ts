import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import { AppError, fail } from "@core/shared/errors.js";
import {
  adminMailSettings,
  defaultMailSettings,
  mailboxRoleRank,
  mailConnectionChanged,
  parseMailSettings,
  publicMailSettings,
  singleSystemMailbox,
  type MailSettingsConfig,
} from "@core/modules/mail/settings.js";
import {
  mailboxAddress,
  parseAddresses,
  requireDomain,
  requireLocalPart,
} from "@core/modules/mail/addresses.js";
import { ensureSystemMailbox } from "../services/system-mailbox.js";
import { clearPageState } from "../services/page-state.js";
import { mailDraftKey } from "@core/modules/page-state.js";
import {
  canDeleteMailbox,
  canShareMailbox,
  publicMailbox,
  requireMailboxRole,
  type MailboxRecord,
} from "@core/modules/mail/access.js";
import {
  isExternalMailbox,
  isMailOauthProvider,
  mergeExternalMailSettings,
  parseExternalSecret,
  publicExternalMailSettings,
  resolveExternalCredentials,
  resolveOauthCredentials,
  serializeExternalSecret,
  type ExternalMailCredentials,
  type MailOauthProviderId,
  type MailProviderId,
} from "@core/modules/mail/external.js";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { createImapMail } from "../adapters/imap-mail.js";
import {
  createMailOauthFlow,
  exchangeMailOauth,
  mailOauthApp,
  mailOauthAuthorizeUrl,
  readMailOauthFlow,
  refreshMailOauthToken,
  signMailOauthFlow,
} from "../adapters/mail-oauth.js";
import {
  createHttpWildduck,
  createMemoryStalwart,
  mailboxSecret,
  type MailMessageDetail,
  type StalwartMail,
} from "../adapters/stalwart.js";
import type { StorageRuntime } from "../adapters/storage.js";
import { persistMailAttachments } from "../services/mail-attachments.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import { indexMailMessage, queueMailIndex, queueMailboxIndex, reconcileMailIndex, unindexMailMessage } from "../services/mail-index.js";
import { tagMailMessage } from "../services/mail-tags.js";
import {
  cachedFolders,
  listStoredMessages,
  mailboxSyncState,
  patchStoredMessage,
  reconcileMailbox,
  saveMailboxFolders,
  storedMessage,
  syncMailboxFolder,
} from "../services/mail-store.js";
import { createMailReconcileWorker } from "../jobs/mail-reconcile-worker.js";

const uuid = Type.String({ format: "uuid" });
const mailboxRole = Type.Union([
  Type.Literal("reader"),
  Type.Literal("sender"),
  Type.Literal("admin"),
]);

export type MailRuntime = {
  client?: StalwartMail;
  fetch?: typeof fetch;
  origin?: string;
  storage?: StorageRuntime;
  mock?: boolean;
  externalClient?: (credentials: ExternalMailCredentials) => StalwartMail;
};

export function registerMail(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  admin: (req: FastifyRequest) => Actor,
  runtime: MailRuntime = {},
) {
  const fallbackClient = runtime.client ?? createMemoryStalwart({ seed: !!runtime.mock });

  async function settingsRow() {
    return db
      .selectFrom("mail_settings")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
  }

  async function settings(): Promise<MailSettingsConfig> {
    const config = parseMailSettings((await settingsRow()).config);
    if (runtime.mock && !config.endpoint) {
      return {
        ...config,
        enabled: true,
        domain: config.domain || "heyphp.com",
        mode: config.enabled ? config.mode : "independent",
      };
    }
    return config;
  }

  async function client() {
    const config = await settings();
    if (runtime.client) return runtime.client;
    if (config.endpoint) return createHttpWildduck(config, runtime.fetch);
    return fallbackClient;
  }

  function externalBackend(credentials: ExternalMailCredentials) {
    return runtime.externalClient?.(credentials) ?? createImapMail(credentials);
  }

  function mailOrigin(req: FastifyRequest) {
    return runtime.origin || `${req.protocol}://${req.headers.host}`;
  }

  function mailOauthCookie(origin: string, value: string, age = 600) {
    const secure = origin.startsWith("https:");
    return `doca_mail_oauth=${encodeURIComponent(value)}; Path=/api/v1/mail; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
  }

  function readHeaderCookie(req: FastifyRequest, name: string) {
    return (
      req.headers.cookie
        ?.split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? ""
    );
  }

  async function liveExternalCredentials(mailbox: MailboxRecord) {
    const credentials = parseExternalSecret(mailbox.secret);
    if (!credentials) fail(400, "外部邮箱凭证已损坏，请重新绑定");
    if (credentials.auth !== "oauth" || !isMailOauthProvider(credentials.provider))
      return credentials;
    const config = await settings();
    const app = mailOauthApp(config.external, credentials.provider);
    if (!app) fail(400, "管理员尚未配置该邮箱的 OAuth 客户端");
    const live = await refreshMailOauthToken(
      credentials.provider,
      app,
      credentials,
      runtime.fetch ?? fetch,
    );
    if (
      live.accessToken !== credentials.accessToken ||
      live.refreshToken !== credentials.refreshToken
    ) {
      await db
        .updateTable("mailboxes")
        .set({
          secret: serializeExternalSecret(live),
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", mailbox.id)
        .execute();
    }
    return live;
  }

  async function backendFor(mailbox: MailboxRecord) {
    if (!isExternalMailbox(mailbox)) return client();
    return externalBackend(await liveExternalCredentials(mailbox));
  }

  async function bindExternalMailbox(
    actorId: string,
    credentials: ExternalMailCredentials,
    displayName?: string,
  ) {
    const { external } = await requireExternal();
    if (!external.providers.some((item) => item.id === credentials.provider))
      fail(400, "管理员未开放这家邮箱服务商");
    const owned = await db
      .selectFrom("mailboxes")
      .select("id")
      .where("owner_id", "=", actorId)
      .where("source", "=", "external")
      .where("deleted_at", "is", null)
      .execute();
    if (owned.length >= external.maxAccounts)
      fail(400, `最多只能绑定 ${external.maxAccounts} 个外部邮箱`);
    const exists = await db
      .selectFrom("mailboxes")
      .select("id")
      .where("address", "=", credentials.address)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (exists) fail(409, `邮箱 ${credentials.address} 已被绑定`);
    const secret = serializeExternalSecret(credentials);
    const backend = externalBackend(credentials);
    try {
      await backend.listFolders(credentials.address, secret);
    } catch {
      await backend.createAccount({
        name: credentials.address,
        address: credentials.address,
        secret,
      });
      await backend.listFolders(credentials.address, secret);
    }
    const now = new Date().toISOString();
    const row: Schema["mailboxes"] = {
      id: randomUUID(),
      owner_id: actorId,
      address: credentials.address,
      local_part: credentials.address.split("@")[0]!.slice(0, 64),
      display_name: displayName?.trim() || credentials.address,
      kind: "personal",
      locked: 0,
      secret,
      backend_user_id: "",
      source: "external",
      provider: credentials.provider,
      knowledge_scope: "starred",
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await db.insertInto("mailboxes").values(row).execute();
    return publicMailbox(row, "owner");
  }

  async function requireConfigured() {
    const config = await settings();
    if (!config.enabled || !config.domain)
      fail(400, "管理员尚未启用内部邮箱或未设置顶级域名");
    return config;
  }

  async function requireExternal() {
    const config = await settings();
    const external = publicExternalMailSettings(config.external);
    if (!external.enabled) fail(400, "管理员尚未开放外部邮箱绑定");
    return { config, external };
  }

  async function mailboxRow(id: string) {
    const row = await db
      .selectFrom("mailboxes")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) fail(404, "邮箱不存在");
    return row;
  }

  async function mailboxAccess(actor: Actor, id: string, minimum: "reader" | "sender" | "admin" | "owner" = "reader") {
    const mailbox = await mailboxRow(id);
    const share = await db
      .selectFrom("mailbox_shares")
      .selectAll()
      .where("mailbox_id", "=", id)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    const role = requireMailboxRole(actor, mailbox, share, minimum);
    return { mailbox, share, role };
  }

  function bindStoredUser(backend: StalwartMail, mailbox: MailboxRecord) {
    if (isExternalMailbox(mailbox) || !mailbox.backend_user_id) return;
    backend.bindAccount({ address: mailbox.address, userId: mailbox.backend_user_id });
  }

  async function rememberBackendUser(backend: StalwartMail, mailbox: MailboxRecord) {
    if (isExternalMailbox(mailbox) || mailbox.backend_user_id) return;
    try {
      const resolved = await backend.resolveAccount(mailbox.address);
      if (!resolved.id) return;
      mailbox.backend_user_id = resolved.id;
      backend.bindAccount({ address: mailbox.address, userId: resolved.id });
      await db
        .updateTable("mailboxes")
        .set({ backend_user_id: resolved.id, updated_at: new Date().toISOString() })
        .where("id", "=", mailbox.id)
        .execute();
    } catch {
      /* 下次打开再补记 WildDuck 用户 */
    }
  }

  async function remoteFolders(mailbox: MailboxRecord) {
    const backend = await backendFor(mailbox);
    bindStoredUser(backend, mailbox);
    try {
      const folders = await backend.listFolders(mailbox.address, mailbox.secret);
      await rememberBackendUser(backend, mailbox);
      return folders;
    } catch (error) {
      if (isExternalMailbox(mailbox)) throw error;
      const created = await backend.createAccount({
        name: mailbox.address,
        address: mailbox.address,
        secret: mailbox.secret,
      });
      if (created.id) {
        mailbox.backend_user_id = created.id;
        backend.bindAccount({ address: mailbox.address, userId: created.id });
        await db
          .updateTable("mailboxes")
          .set({ backend_user_id: created.id, updated_at: new Date().toISOString() })
          .where("id", "=", mailbox.id)
          .execute();
      }
      return backend.listFolders(mailbox.address, mailbox.secret);
    }
  }

  async function storedFolders(mailbox: MailboxRecord, fresh = false) {
    const cached = await cachedFolders(db, mailbox.id);
    if (cached.length && !fresh) return cached;
    return saveMailboxFolders(db, mailbox.id, await remoteFolders(mailbox));
  }

  async function rememberMessage(mailbox: MailboxRecord, message: MailMessageDetail | Awaited<ReturnType<StalwartMail["listMessages"]>>["items"][number]) {
    await indexMailMessage(db, mailbox, message);
  }

  async function rememberDetail(mailbox: MailboxRecord, message: MailMessageDetail) {
    const attachments = await persistMailAttachments(db, mailbox, message, {
      storage: runtime.storage,
      loadData: async (attachment) => {
        if (attachment.data) return attachment.data;
        try {
          return (await (await backendFor(mailbox)).getAttachment(mailbox.address, attachment.id, mailbox.secret)).data;
        } catch {
          return undefined;
        }
      },
    }).catch(() => message.attachments);
    await indexMailMessage(db, mailbox, message);
    return { ...message, attachments };
  }

  async function createMailboxRecord(
    actor: Actor,
    input: {
      localPart: string;
      displayName?: string;
      kind: "personal" | "shared";
      locked: boolean;
      ownerId?: string;
    },
  ) {
    const config = await requireConfigured();
    const localPart = requireLocalPart(input.localPart);
    const address = mailboxAddress(localPart, config.domain);
    const exists = await db
      .selectFrom("mailboxes")
      .select("id")
      .where("address", "=", address)
      .executeTakeFirst();
    if (exists) fail(409, `邮箱 ${address} 已被占用`);
    const secret = mailboxSecret();
    const stalwart = await client();
    await stalwart.ensureDomain(config.domain);
    const created = await stalwart.createAccount({
      name: input.displayName?.trim() || address,
      address,
      secret,
    });
    const now = new Date().toISOString();
    const row: Schema["mailboxes"] = {
      id: randomUUID(),
      owner_id: input.ownerId ?? actor.id,
      address,
      local_part: localPart,
      display_name: input.displayName?.trim() || address,
      kind: input.kind,
      locked: input.locked ? 1 : 0,
      secret,
      backend_user_id: created.id,
      source: "internal",
      provider: "",
      knowledge_scope: "starred",
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await db.insertInto("mailboxes").values(row).execute();
    return row;
  }

  async function ensureOwnedSystemMailbox(actor: Actor) {
    const config = await settings();
    if (!singleSystemMailbox(config)) return null;
    return ensureSystemMailbox(
      db,
      { id: actor.id, displayName: actor.display_name },
      await client(),
    );
  }

  async function visibleMailboxes(actor: Actor) {
    const config = await settings();
    if (singleSystemMailbox(config)) await ensureOwnedSystemMailbox(actor);
    const owned = await db
      .selectFrom("mailboxes")
      .selectAll()
      .where("owner_id", "=", actor.id)
      .where("deleted_at", "is", null)
      .orderBy("address")
      .execute();
    const shared = await db
      .selectFrom("mailboxes")
      .innerJoin("mailbox_shares", "mailbox_shares.mailbox_id", "mailboxes.id")
      .selectAll("mailboxes")
      .select("mailbox_shares.role as share_role")
      .where("mailbox_shares.user_id", "=", actor.id)
      .where("mailboxes.deleted_at", "is", null)
      .orderBy("mailboxes.address")
      .execute();
    const seen = new Set(owned.map((item) => item.id));
    return [
      ...owned.map((item) => publicMailbox(item, "owner")),
      ...shared
        .filter((item) => !seen.has(item.id))
        .map((item) => publicMailbox(item, item.share_role)),
    ].sort((left, right) => {
      const rank = (item: { source: string; role: string; kind: string; address: string }) => {
        if (item.source === "internal" && item.role === "owner" && item.kind === "personal") return 0;
        if (item.source === "internal" && item.role === "owner") return 1;
        return 2;
      };
      return rank(left) - rank(right) || left.address.localeCompare(right.address);
    });
  }

  api.get("/api/v1/admin/mail", async (req) => {
    admin(req);
    const row = await settingsRow();
    return adminMailSettings(parseMailSettings(row.config), row.revision);
  });

  api.put<{
    Body: {
      revision: number;
      config: Partial<MailSettingsConfig> & { token?: string | null };
    };
  }>(
    "/api/v1/admin/mail",
    {
      schema: {
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 0 }),
            config: Type.Object(
              {
                enabled: Type.Boolean(),
                endpoint: Type.String({ maxLength: 500 }),
                domain: Type.String({ maxLength: 253 }),
                mode: Type.Union([Type.Literal("independent"), Type.Literal("free")]),
                maxMailboxes: Type.Integer({ minimum: 1, maximum: 50 }),
                username: Type.String({ maxLength: 160 }),
                token: Type.Optional(Type.Union([Type.String({ maxLength: 400 }), Type.Null()])),
                external: Type.Optional(
                  Type.Object(
                    {
                      enabled: Type.Boolean(),
                      maxAccounts: Type.Integer({ minimum: 1, maximum: 20 }),
                      providers: Type.Record(Type.String({ maxLength: 20 }), Type.Boolean()),
                      oauth: Type.Optional(
                        Type.Object(
                          {
                            gmail: Type.Optional(
                              Type.Object({
                                clientId: Type.String({ maxLength: 200 }),
                                clientSecret: Type.Optional(
                                  Type.Union([Type.String({ maxLength: 400 }), Type.Null()]),
                                ),
                              }),
                            ),
                            outlook: Type.Optional(
                              Type.Object({
                                clientId: Type.String({ maxLength: 200 }),
                                clientSecret: Type.Optional(
                                  Type.Union([Type.String({ maxLength: 400 }), Type.Null()]),
                                ),
                              }),
                            ),
                          },
                          { additionalProperties: false },
                        ),
                      ),
                    },
                    { additionalProperties: false },
                  ),
                ),
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const actor = admin(req);
      const row = await settingsRow();
      if (row.revision !== req.body.revision) fail(409, "邮箱设置已被其他人更新，请刷新后重试");
      const previous = parseMailSettings(row.config);
      const next: MailSettingsConfig = {
        ...defaultMailSettings,
        ...previous,
        ...req.body.config,
        domain: req.body.config.domain ? requireDomain(req.body.config.domain) : "",
        token:
          req.body.config.token === null
            ? previous.token
            : req.body.config.token === undefined
              ? previous.token
              : req.body.config.token.trim(),
        external: mergeExternalMailSettings(
          req.body.config.external ?? previous.external,
          previous.external,
        ),
      };
      if (next.enabled && !next.domain) fail(400, "启用内部邮箱时必须设置顶级域名");
      if (next.external.enabled && !publicExternalMailSettings(next.external).enabled)
        fail(400, "开放外部邮箱时请至少启用一家服务商");
      if (next.enabled && next.endpoint && mailConnectionChanged(previous, next)) {
        if (!next.token) fail(400, "尚未配置 WildDuck API Token");
        const backend = runtime.client ?? createHttpWildduck(next, runtime.fetch);
        await backend.testConnection();
        await backend.ensureDomain(next.domain);
      }
      const updated = {
        id: "system",
        config: JSON.stringify(next),
        revision: row.revision + 1,
      };
      await transact(db, async (tx) => {
        await tx
          .updateTable("mail_settings")
          .set(updated)
          .where("id", "=", "system")
          .where("revision", "=", row.revision)
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("audit_events")
          .values({
            id: randomUUID(),
            actor_id: actor.id,
            resource_id: null,
            action: "mail.settings_updated",
            created_at: new Date().toISOString(),
          })
          .execute();
      });
      return adminMailSettings(next, updated.revision);
    },
  );

  api.post<{ Body: { localPart: string; displayName?: string } }>(
    "/api/v1/admin/mail/shared",
    {
      schema: {
        body: Type.Object({
          localPart: Type.String({ minLength: 1, maxLength: 64 }),
          displayName: Type.Optional(Type.String({ maxLength: 160 })),
        }),
      },
    },
    async (req) => {
      const actor = admin(req);
      const mailbox = await createMailboxRecord(actor, {
        localPart: req.body.localPart,
        displayName: req.body.displayName,
        kind: "shared",
        locked: false,
      });
      return publicMailbox(mailbox, "owner");
    },
  );

  api.get("/api/v1/mail", async (req) => {
    const actor = auth(req);
    const config = await settings();
    const publicSettings = publicMailSettings(config);
    return {
      ...publicSettings,
      mailboxes: publicSettings.configured ? await visibleMailboxes(actor) : [],
    };
  });

  api.get("/api/v1/mail/mailboxes", async (req) => {
    const actor = auth(req);
    return { items: await visibleMailboxes(actor) };
  });

  api.post<{ Body: { localPart: string; displayName?: string } }>(
    "/api/v1/mail/mailboxes",
    {
      schema: {
        body: Type.Object({
          localPart: Type.String({ minLength: 1, maxLength: 64 }),
          displayName: Type.Optional(Type.String({ maxLength: 160 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const config = await requireConfigured();
      if (singleSystemMailbox(config))
        fail(400, "当前每个用户只有一个系统邮箱，已自动开通，不能再申请");
      const owned = await db
        .selectFrom("mailboxes")
        .select("id")
        .where("owner_id", "=", actor.id)
        .where("source", "=", "internal")
        .where("deleted_at", "is", null)
        .execute();
      if (owned.length >= config.maxMailboxes)
        fail(400, `最多只能申请 ${config.maxMailboxes} 个邮箱`);
      const mailbox = await createMailboxRecord(actor, {
        localPart: req.body.localPart,
        displayName: req.body.displayName,
        kind: "shared",
        locked: false,
      });
      return publicMailbox(mailbox, "owner");
    },
  );

  api.post<{
    Body: {
      provider: MailProviderId;
      address: string;
      password: string;
      displayName?: string;
      username?: string;
      imapHost?: string;
      imapPort?: number;
      imapSecure?: boolean;
      smtpHost?: string;
      smtpPort?: number;
      smtpSecure?: boolean;
    };
  }>(
    "/api/v1/mail/external",
    {
      schema: {
        body: Type.Object({
          provider: Type.Union([
            Type.Literal("gmail"),
            Type.Literal("outlook"),
            Type.Literal("qq"),
            Type.Literal("163"),
            Type.Literal("126"),
            Type.Literal("icloud"),
            Type.Literal("yahoo"),
            Type.Literal("custom"),
          ]),
          address: Type.String({ minLength: 3, maxLength: 254 }),
          password: Type.String({ minLength: 1, maxLength: 400 }),
          displayName: Type.Optional(Type.String({ maxLength: 160 })),
          username: Type.Optional(Type.String({ maxLength: 254 })),
          imapHost: Type.Optional(Type.String({ maxLength: 253 })),
          imapPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
          imapSecure: Type.Optional(Type.Boolean()),
          smtpHost: Type.Optional(Type.String({ maxLength: 253 })),
          smtpPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
          smtpSecure: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      if (isMailOauthProvider(req.body.provider))
        fail(400, "这家邮箱请使用官方账号授权，不要填写密码");
      let credentials: ExternalMailCredentials;
      try {
        credentials = resolveExternalCredentials(req.body);
      } catch (error) {
        fail(400, error instanceof Error ? error.message : "外部邮箱信息不完整");
      }
      return bindExternalMailbox(actor.id, credentials, req.body.displayName);
    },
  );

  api.post<{
    Params: { provider: MailOauthProviderId };
    Body: { displayName?: string };
  }>(
    "/api/v1/mail/oauth/:provider",
    {
      preValidation: async (req) => {
        req.body ??= {};
      },
      schema: {
        params: Type.Object({
          provider: Type.Union([Type.Literal("gmail"), Type.Literal("outlook")]),
        }),
        body: Type.Object({
          displayName: Type.Optional(Type.String({ maxLength: 160 })),
        }),
      },
    },
    async (req, reply) => {
      const actor = auth(req);
      const { config, external } = await requireExternal();
      if (!external.providers.some((item) => item.id === req.params.provider))
        fail(400, "管理员未开放这家邮箱服务商");
      const app = mailOauthApp(config.external, req.params.provider);
      if (!app) fail(400, "管理员尚未配置这家邮箱的 OAuth 客户端");
      const origin = mailOrigin(req);
      const flow = createMailOauthFlow(actor.id, req.params.provider, req.body.displayName);
      reply.header("Set-Cookie", mailOauthCookie(origin, signMailOauthFlow(flow, app.clientSecret)));
      return { url: await mailOauthAuthorizeUrl(req.params.provider, app, origin, flow) };
    },
  );

  api.get<{ Params: { provider: MailOauthProviderId } }>(
    "/api/v1/mail/oauth/:provider/callback",
    {
      logLevel: "silent",
      schema: {
        params: Type.Object({
          provider: Type.Union([Type.Literal("gmail"), Type.Literal("outlook")]),
        }),
      },
    },
    async (req, reply) => {
      const origin = mailOrigin(req);
      const home = `${origin}/#/mail`;
      const clear = mailOauthCookie(origin, "", 0);
      try {
        const { config } = await requireExternal();
        const app = mailOauthApp(config.external, req.params.provider);
        if (!app) fail(400, "管理员尚未配置这家邮箱的 OAuth 客户端");
        const url = new URL(req.url, origin);
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (url.searchParams.get("error") || !state || !code) fail(400, "授权取消或校验失败");
        const flow = readMailOauthFlow(
          decodeURIComponent(readHeaderCookie(req, "doca_mail_oauth")),
          app.clientSecret,
          req.params.provider,
        );
        if (!flow || flow.state !== state) fail(400, "授权已过期或已使用");
        const tokens = await exchangeMailOauth(
          req.params.provider,
          app,
          origin,
          code,
          flow.verifier,
          runtime.fetch ?? fetch,
        );
        await bindExternalMailbox(
          flow.userId,
          resolveOauthCredentials({
            provider: req.params.provider,
            address: tokens.address,
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          }),
          flow.displayName,
        );
        reply.header("Set-Cookie", clear);
        return reply.redirect(home);
      } catch {
        reply.header("Set-Cookie", clear);
        return reply.redirect(`${home}?mailBind=error`);
      }
    },
  );

  api.delete<{ Params: { id: string } }>(
    "/api/v1/mail/mailboxes/:id",
    { schema: { params: Type.Object({ id: uuid }) } },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.id, "owner");
      if (!canDeleteMailbox(mailbox)) fail(400, "这个邮箱不能删除");
      if (!isExternalMailbox(mailbox)) {
        const stalwart = await client();
        await stalwart.deleteAccount(mailbox.address);
      }
      await db
        .updateTable("mailboxes")
        .set({
          deleted_at: new Date().toISOString(),
          version: mailbox.version + 1,
        })
        .where("id", "=", mailbox.id)
        .execute();
      return { ok: true };
    },
  );

  api.patch<{ Params: { id: string }; Body: { knowledgeScope: "off" | "starred" | "all" } }>(
    "/api/v1/mail/mailboxes/:id",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          knowledgeScope: Type.Union([Type.Literal("off"), Type.Literal("starred"), Type.Literal("all")]),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox, role } = await mailboxAccess(actor, req.params.id, "admin");
      const now = new Date().toISOString();
      await db
        .updateTable("mailboxes")
        .set({ knowledge_scope: req.body.knowledgeScope, updated_at: now, version: mailbox.version + 1 })
        .where("id", "=", mailbox.id)
        .execute();
      await queueMailboxIndex(db, mailbox.id);
      return publicMailbox({ ...mailbox, knowledge_scope: req.body.knowledgeScope, updated_at: now }, role);
    },
  );

  api.get<{ Params: { id: string } }>(
    "/api/v1/mail/mailboxes/:id",
    { schema: { params: Type.Object({ id: uuid }) } },
    async (req) => {
      const actor = auth(req);
      const { mailbox, role } = await mailboxAccess(actor, req.params.id);
      const folders = await storedFolders(mailbox);
      const synced = await mailboxSyncState(db, mailbox.id);
      return {
        ...publicMailbox(mailbox, role),
        folders,
        syncedAt: synced?.synced_at ?? null,
      };
    },
  );

  api.post<{ Params: { id: string }; Querystring: { folderId?: string } }>(
    "/api/v1/mail/mailboxes/:id/sync",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        querystring: Type.Object({
          folderId: Type.Optional(Type.String({ maxLength: 160 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox, role } = await mailboxAccess(actor, req.params.id);
      const result = await reconcileMailbox(db, mailbox, await backendFor(mailbox), {
        folderId: req.query.folderId,
        fillBodies: 16,
      });
      return {
        ...publicMailbox(mailbox, role),
        folders: result.folders,
        syncedAt: result.syncedAt,
      };
    },
  );

  api.get<{ Params: { id: string } }>(
    "/api/v1/mail/mailboxes/:id/shares",
    { schema: { params: Type.Object({ id: uuid }) } },
    async (req) => {
      const actor = auth(req);
      const { mailbox, role } = await mailboxAccess(actor, req.params.id);
      const members = await db
        .selectFrom("mailbox_shares")
        .innerJoin("users", "users.id", "mailbox_shares.user_id")
        .select([
          "mailbox_shares.user_id",
          "mailbox_shares.role",
          "mailbox_shares.version",
          "users.display_name",
          "users.public_id",
        ])
        .where("mailbox_id", "=", mailbox.id)
        .execute();
      const owner = await db
        .selectFrom("users")
        .select(["id", "display_name", "public_id"])
        .where("id", "=", mailbox.owner_id)
        .executeTakeFirst();
      return {
        owner: owner ? { id: owner.id, display_name: owner.display_name, public_id: owner.public_id } : null,
        currentUser: { id: actor.id, display_name: actor.display_name, public_id: actor.public_id },
        members,
        role,
        isOwner: role === "owner",
        canManage: mailboxRoleRank(role) >= mailboxRoleRank("admin") && canShareMailbox(mailbox),
        shareable: canShareMailbox(mailbox),
      };
    },
  );

  api.put<{
    Params: { id: string };
    Body: { userId: string; role: "reader" | "sender" | "admin" };
  }>(
    "/api/v1/mail/mailboxes/:id/shares",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        body: Type.Object({ userId: uuid, role: mailboxRole }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox, role } = await mailboxAccess(actor, req.params.id, "admin");
      if (!canShareMailbox(mailbox)) fail(400, "独立邮箱不能分享");
      if (req.body.userId === mailbox.owner_id) fail(400, "不能修改所有者权限");
      if (req.body.role === "admin" && role !== "owner") fail(403, "只有所有者可以授予管理员");
      const now = new Date().toISOString();
      const old = await db
        .selectFrom("mailbox_shares")
        .selectAll()
        .where("mailbox_id", "=", mailbox.id)
        .where("user_id", "=", req.body.userId)
        .executeTakeFirst();
      const row: Schema["mailbox_shares"] = {
        mailbox_id: mailbox.id,
        user_id: req.body.userId,
        role: req.body.role,
        version: (old?.version ?? 0) + 1,
        created_at: old?.created_at ?? now,
        updated_at: now,
      };
      await db
        .insertInto("mailbox_shares")
        .values(row)
        .onConflict((oc) => oc.columns(["mailbox_id", "user_id"]).doUpdateSet(row))
        .execute();
      return { ok: true };
    },
  );

  api.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/mail/mailboxes/:id/shares/:userId",
    { schema: { params: Type.Object({ id: uuid, userId: uuid }) } },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.id, "admin");
      await db
        .deleteFrom("mailbox_shares")
        .where("mailbox_id", "=", mailbox.id)
        .where("user_id", "=", req.params.userId)
        .execute();
      return { ok: true };
    },
  );

  api.get<{ Params: { id: string } }>(
    "/api/v1/mail/mailboxes/:id/share-link",
    { schema: { params: Type.Object({ id: uuid }) } },
    async (req) => {
      const actor = auth(req);
      const { mailbox, role } = await mailboxAccess(actor, req.params.id);
      const row = await db
        .selectFrom("mailbox_share_links")
        .selectAll()
        .where("mailbox_id", "=", mailbox.id)
        .executeTakeFirst();
      return {
        enabled: !!row?.enabled,
        role: row?.role ?? "reader",
        token: row?.token ?? null,
        url: row ? `#/mail/join?token=${row.token}` : null,
        isOwner: role === "owner",
        shareable: canShareMailbox(mailbox),
      };
    },
  );

  api.put<{
    Params: { id: string };
    Body: { enabled: boolean; role?: "reader" | "sender" | "admin"; rotate?: boolean };
  }>(
    "/api/v1/mail/mailboxes/:id/share-link",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          enabled: Type.Boolean(),
          role: Type.Optional(mailboxRole),
          rotate: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox, role } = await mailboxAccess(actor, req.params.id, "admin");
      if (!canShareMailbox(mailbox)) fail(400, "独立邮箱不能分享");
      if (req.body.role === "admin" && role !== "owner") fail(403, "只有所有者可以把链接设为管理员");
      const now = new Date().toISOString();
      const old = await db
        .selectFrom("mailbox_share_links")
        .selectAll()
        .where("mailbox_id", "=", mailbox.id)
        .executeTakeFirst();
      const token =
        req.body.rotate || !old ? randomBytes(32).toString("base64url") : old.token;
      const row: Schema["mailbox_share_links"] = {
        mailbox_id: mailbox.id,
        token,
        token_hash: createHash("sha256").update(token).digest("hex"),
        role: req.body.role ?? old?.role ?? "reader",
        enabled: req.body.enabled ? 1 : 0,
        created_by: old?.created_by ?? actor.id,
        created_at: old?.created_at ?? now,
        updated_at: now,
      };
      await db
        .insertInto("mailbox_share_links")
        .values(row)
        .onConflict((oc) => oc.column("mailbox_id").doUpdateSet(row))
        .execute();
      return {
        enabled: !!row.enabled,
        role: row.role,
        token: row.token,
        url: `#/mail/join?token=${row.token}`,
        isOwner: role === "owner",
        shareable: true,
      };
    },
  );

  api.post<{ Body: { token: string } }>(
    "/api/v1/mail/share/redeem",
    {
      schema: {
        body: Type.Object({ token: Type.String({ minLength: 20, maxLength: 100 }) }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const hash = createHash("sha256").update(req.body.token).digest("hex");
      const link = await db
        .selectFrom("mailbox_share_links")
        .selectAll()
        .where("token_hash", "=", hash)
        .where("enabled", "=", 1)
        .executeTakeFirst();
      if (!link) fail(404, "分享链接不存在或已停用");
      const mailbox = await mailboxRow(link.mailbox_id);
      if (mailbox.owner_id !== actor.id) {
        const old = await db
          .selectFrom("mailbox_shares")
          .selectAll()
          .where("mailbox_id", "=", mailbox.id)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        const now = new Date().toISOString();
        const row: Schema["mailbox_shares"] = {
          mailbox_id: mailbox.id,
          user_id: actor.id,
          role: old && mailboxRoleRank(old.role) > mailboxRoleRank(link.role) ? old.role : link.role,
          version: (old?.version ?? 0) + 1,
          created_at: old?.created_at ?? now,
          updated_at: now,
        };
        await db
          .insertInto("mailbox_shares")
          .values(row)
          .onConflict((oc) => oc.columns(["mailbox_id", "user_id"]).doUpdateSet(row))
          .execute();
      }
      return { id: mailbox.id, address: mailbox.address };
    },
  );

  api.get("/api/v1/admin/mail/mailboxes", async (req) => {
    admin(req);
    const rows = await db
      .selectFrom("mailboxes")
      .selectAll()
      .where("deleted_at", "is", null)
      .orderBy("kind")
      .orderBy("address")
      .execute();
    return { items: rows.map((row) => publicMailbox(row, "owner")) };
  });

  api.post<{ Params: { id: string }; Body: { name: string } }>(
    "/api/v1/mail/mailboxes/:id/folders",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }) }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.id, "admin");
      return (await backendFor(mailbox)).createFolder(mailbox.address, req.body.name, null, mailbox.secret);
    },
  );

  api.get<{
    Params: { id: string };
    Querystring: {
      folderId?: string;
      q?: string;
      unread?: boolean;
      starred?: boolean;
      offset?: number;
    };
  }>(
    "/api/v1/mail/mailboxes/:id/messages",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        querystring: Type.Object({
          folderId: Type.Optional(Type.String({ maxLength: 160 })),
          q: Type.Optional(Type.String({ maxLength: 200 })),
          unread: Type.Optional(Type.Boolean()),
          starred: Type.Optional(Type.Boolean()),
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.id);
      const query = {
        folderId: req.query.folderId,
        q: req.query.q,
        unread: req.query.unread,
        starred: req.query.starred,
        offset: req.query.offset,
      };
      const cached = await listStoredMessages(db, mailbox.id, query);
      const state = await mailboxSyncState(db, mailbox.id);
      if (cached.items.length || state?.synced_at) return cached;
      await storedFolders(mailbox);
      await syncMailboxFolder(db, mailbox, await backendFor(mailbox), req.query.folderId);
      return listStoredMessages(db, mailbox.id, query);
    },
  );

  api.get<{ Params: { mailboxId: string; id: string } }>(
    "/api/v1/mail/mailboxes/:mailboxId/messages/:id",
    { schema: { params: Type.Object({ mailboxId: uuid, id: Type.String({ maxLength: 160 }) }) } },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.mailboxId);
      const cached = await storedMessage(db, mailbox.id, req.params.id);
      if (cached?.row.body_ready) {
        const files = await db
          .selectFrom("file_items")
          .select(["id", "name", "mime", "size", "metadata"])
          .where("parent_type", "=", "system")
          .where("parent_id", "=", `mail:${mailbox.id}`)
          .where("deleted_at", "is", null)
          .where("metadata", "like", `%"messageId":"${req.params.id}"%`)
          .execute();
        return {
          ...cached.message,
          attachments: files.map((item) => {
            const meta = JSON.parse(item.metadata || "{}") as { attachmentId?: string };
            return {
              id: meta.attachmentId || item.id,
              name: item.name,
              mime: item.mime,
              size: Number(item.size) || 0,
              fileId: item.id,
            };
          }),
        };
      }
      const message = await (await backendFor(mailbox)).getMessage(
        mailbox.address,
        req.params.id,
        mailbox.secret,
      );
      return rememberDetail(mailbox, message);
    },
  );

  api.get<{ Params: { mailboxId: string; id: string; attachmentId: string } }>(
    "/api/v1/mail/mailboxes/:mailboxId/messages/:id/attachments/:attachmentId",
    {
      schema: {
        params: Type.Object({
          mailboxId: uuid,
          id: Type.String({ maxLength: 160 }),
          attachmentId: Type.String({ maxLength: 240 }),
        }),
      },
    },
    async (req, reply) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.mailboxId);
      const stalwart = await backendFor(mailbox);
      const message = await stalwart.getMessage(mailbox.address, req.params.id, mailbox.secret);
      const attachment =
        message.attachments.find((item) => item.id === req.params.attachmentId) ?? {
          id: req.params.attachmentId,
          name: "附件",
          mime: "application/octet-stream",
          size: 0,
        };
      const blob =
        attachment.data
          ? { name: attachment.name, mime: attachment.mime, data: attachment.data }
          : await stalwart.getAttachment(mailbox.address, req.params.attachmentId, mailbox.secret);
      await persistMailAttachments(
        db,
        mailbox,
        { ...message, attachments: [{ ...attachment, data: blob.data }] },
        { storage: runtime.storage },
      ).catch(() => undefined);
      const data = Buffer.from(blob.data, "base64");
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(blob.name || attachment.name)}`,
        )
        .type(blob.mime || "application/octet-stream")
        .send(data);
    },
  );

  api.post<{
    Params: { id: string };
    Body: {
      to: string;
      cc?: string;
      bcc?: string;
      subject: string;
      text?: string;
      html?: string;
      draft?: boolean;
      draftId?: string;
      inReplyTo?: string;
      attachments?: Array<{ name: string; mime: string; data: string }>;
    };
  }>(
    "/api/v1/mail/mailboxes/:id/messages",
    {
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          to: Type.String({ maxLength: 2000 }),
          cc: Type.Optional(Type.String({ maxLength: 2000 })),
          bcc: Type.Optional(Type.String({ maxLength: 2000 })),
          subject: Type.String({ maxLength: 500 }),
          text: Type.Optional(Type.String({ maxLength: 200000 })),
          html: Type.Optional(Type.String({ maxLength: 200000 })),
          draft: Type.Optional(Type.Boolean()),
          draftId: Type.Optional(Type.String({ maxLength: 160 })),
          inReplyTo: Type.Optional(Type.String({ maxLength: 160 })),
          attachments: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ maxLength: 255 }),
                mime: Type.String({ maxLength: 160 }),
                data: Type.String({ maxLength: 15_000_000 }),
              }),
              { maxItems: 10 },
            ),
          ),
        }),
      },
    },
    async (req, reply) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.id, "sender");
      const draft = {
        to: parseAddresses(req.body.to),
        cc: parseAddresses(req.body.cc),
        bcc: parseAddresses(req.body.bcc),
        subject: req.body.subject,
        text: req.body.text,
        html: req.body.html,
        draftId: req.body.draftId,
        inReplyTo: req.body.inReplyTo,
        attachments: req.body.attachments,
      };
      const stalwart = await backendFor(mailbox);
      bindStoredUser(stalwart, mailbox);
      const subject = draft.subject.trim() || "（无主题）";
      const sentAt = new Date().toLocaleString("zh-CN", { hour12: false });
      async function writeReceipt(title: string, lines: string[]) {
        try {
          const receipt = await stalwart.saveReceipt(
            mailbox.address,
            { subject: title, text: lines.filter(Boolean).join("\n") },
            mailbox.secret,
          );
          return await rememberDetail(mailbox, receipt);
        } catch {
          return null;
        }
      }
      try {
        const message = req.body.draft
          ? await stalwart.saveDraft(mailbox.address, draft, mailbox.secret)
          : await stalwart.sendMessage(mailbox.address, draft, mailbox.secret);
        if (!req.body.draft) await clearPageState(db, actor.id, mailDraftKey(mailbox.id));
        const stored = await rememberDetail(mailbox, message);
        if (req.body.draft) return stored;
        const receipt = await writeReceipt(`发送成功：${subject}`, [
          "发送成功",
          `时间：${sentAt}`,
          `收件人：${draft.to.join("，") || "（无）"}`,
          draft.cc.length ? `抄送：${draft.cc.join("，")}` : "",
          `主题：${subject}`,
          "邮件已提交，副本在已发送。",
        ]);
        return receipt ? { ...stored, receipt } : stored;
      } catch (error) {
        if (req.body.draft) throw error;
        const reason = error instanceof AppError
          ? error.message
          : error instanceof Error
            ? error.message
            : "发送失败";
        const receipt = await writeReceipt(`发送失败：${subject}`, [
          "发送失败",
          `时间：${sentAt}`,
          `收件人：${draft.to.join("，") || "（无）"}`,
          draft.cc.length ? `抄送：${draft.cc.join("，")}` : "",
          `主题：${subject}`,
          `原因：${reason}`,
        ]);
        return reply.code(error instanceof AppError ? error.status : 400).send({
          message: reason,
          receipt,
        });
      }
    },
  );

  api.patch<{
    Params: { mailboxId: string; id: string };
    Body: { unread?: boolean; starred?: boolean; folderId?: string };
  }>(
    "/api/v1/mail/mailboxes/:mailboxId/messages/:id",
    {
      schema: {
        params: Type.Object({ mailboxId: uuid, id: Type.String({ maxLength: 160 }) }),
        body: Type.Object({
          unread: Type.Optional(Type.Boolean()),
          starred: Type.Optional(Type.Boolean()),
          folderId: Type.Optional(Type.String({ maxLength: 160 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.mailboxId, "sender");
      const folders = await cachedFolders(db, mailbox.id);
      const folder = req.body.folderId
        ? folders.find((item) => item.id === req.body.folderId)
        : undefined;
      const local = await patchStoredMessage(db, mailbox.id, req.params.id, {
        unread: req.body.unread,
        starred: req.body.starred,
        folderId: req.body.folderId,
        folder: folder?.name,
      });
      try {
        const message = await (await backendFor(mailbox)).updateMessage(mailbox.address, req.params.id, req.body, mailbox.secret);
        await rememberMessage(mailbox, message);
        return message;
      } catch (error) {
        if (local) {
          await queueMailIndex(db, local.row.id);
          return local.message;
        }
        throw error;
      }
    },
  );

  api.post<{
    Params: { id: string };
    Body: { ids: string[]; permanent?: boolean };
  }>(
    "/api/v1/mail/mailboxes/:id/messages/batch-delete",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          ids: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 100 }),
          permanent: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.id, "sender");
      const backend = await backendFor(mailbox);
      const failed: string[] = [];
      for (const id of req.body.ids) {
        try {
          await backend.deleteMessage(mailbox.address, id, req.body.permanent, mailbox.secret);
          await unindexMailMessage(db, mailbox.id, id);
        } catch {
          failed.push(id);
        }
      }
      if (failed.length === req.body.ids.length) fail(400, "邮件删除失败，请稍后重试");
      return { ok: true, deleted: req.body.ids.length - failed.length, failed };
    },
  );

  api.delete<{
    Params: { mailboxId: string; id: string };
    Querystring: { permanent?: boolean };
  }>(
    "/api/v1/mail/mailboxes/:mailboxId/messages/:id",
    {
      schema: {
        params: Type.Object({ mailboxId: uuid, id: Type.String({ maxLength: 160 }) }),
        querystring: Type.Object({ permanent: Type.Optional(Type.Boolean()) }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const { mailbox } = await mailboxAccess(actor, req.params.mailboxId, "sender");
      await (await backendFor(mailbox)).deleteMessage(mailbox.address, req.params.id, req.query.permanent, mailbox.secret);
      await unindexMailMessage(db, mailbox.id, req.params.id);
      return { ok: true };
    },
  );

  api.get<{ Querystring: { q?: string; limit?: number } }>(
    "/api/v1/mail/search",
    {
      schema: {
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const query = (req.query.q ?? "").trim().toLowerCase();
      if (!query) return { items: [] };
      const mailboxes = await visibleMailboxes(actor);
      if (!mailboxes.length) return { items: [] };
      const ids = mailboxes.map((item) => item.id);
      const rows = await db
        .selectFrom("mail_messages")
        .selectAll()
        .where("mailbox_id", "in", ids)
        .where((eb) =>
          eb.or([
            eb("subject", "like", `%${query.replace(/[%_]/g, "\\$&")}%`),
            eb("from_addr", "like", `%${query.replace(/[%_]/g, "\\$&")}%`),
            eb("snippet", "like", `%${query.replace(/[%_]/g, "\\$&")}%`),
            eb("body_text", "like", `%${query.replace(/[%_]/g, "\\$&")}%`),
          ]),
        )
        .orderBy("received_at", "desc")
        .limit(req.query.limit ?? 20)
        .execute();
      return {
        items: rows.map((row) => ({
          id: row.id,
          remoteId: row.remote_id,
          mailboxId: row.mailbox_id,
          address: mailboxes.find((item) => item.id === row.mailbox_id)?.address,
          subject: row.subject,
          from: row.from_addr,
          snippet: row.snippet,
          receivedAt: row.received_at,
          unread: !!row.unread,
        })),
      };
    },
  );

  const reconciler = createMailReconcileWorker(db, backendFor);
  const reconcileTimer = setInterval(() => {
    void reconciler.pump().catch(() => undefined);
  }, 4000);
  reconcileTimer.unref();
  void reconcileMailIndex(db).catch(() => undefined);
  let tagging: Promise<void> | null = null;
  let tagStopped = false;
  const tagTimer = setInterval(() => {
    if (tagging || tagStopped) return;
    tagging = processProjections(db, "mail-tag", async (payload) => {
      const id = String(payload.messageId ?? "");
      if (id) await tagMailMessage(db, id);
    }).then(() => undefined).catch(() => undefined).finally(() => {
      tagging = null;
    });
  }, 1000);
  tagTimer.unref();
  api.addHook("preClose", async () => {
    tagStopped = true;
    clearInterval(reconcileTimer);
    clearInterval(tagTimer);
    if (tagging) await tagging;
  });

  return { visibleMailboxes, mailboxAccess, settings };
}
