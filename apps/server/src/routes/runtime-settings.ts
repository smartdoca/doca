import { resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { createPrivateKey } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "@core/shared/errors.js";
import { securityAudit } from "@core/modules/identity/accounts.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import {
  identityRuntime,
  type IdentityRuntime,
} from "../adapters/identity-providers.js";
import { storageRuntime, type StorageRuntime } from "../adapters/storage.js";
import {
  messagingRuntime,
  configuredMessaging,
  type MessagingRuntime,
} from "../adapters/messaging.js";
import type { SearchRuntime } from "./search.js";
const object = (properties: Parameters<typeof Type.Object>[0]) =>
  Type.Object(properties, { additionalProperties: false });
const text = Type.String({ maxLength: 16000 });
// A union type avoids coercing null (keep existing) into an empty string (clear).
const secret = Type.Unsafe<string | null>({
  type: ["string", "null"],
  maxLength: 16000,
});
const list = Type.Array(Type.String({ maxLength: 500 }), { maxItems: 100 });
const refs = (schema: any) =>
  Type.Record(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }), schema, {
    maxProperties: 100,
  });
const schema = object({
  identity: object({ credentials: refs(secret), allowedOrigins: list }),
  storage: object({
    credentials: refs(
      object({
        accessKeyId: text,
        secretAccessKey: secret,
        sessionToken: secret,
      }),
    ),
    endpointHosts: list,
    cdnKeyPairId: text,
    cdnPrivateKey: secret,
  }),
  messaging: object({
    endpoint: Type.String({ maxLength: 2000 }),
    secret,
    channels: Type.Array(
      Type.Union([Type.Literal("phone"), Type.Literal("email")]),
      { maxItems: 2, uniqueItems: true },
    ),
  }),
  search: object({ apiKey: secret, allowedOrigins: list }),
});
type Settings = Static<typeof schema>;
export async function registerRuntimeSettings(
  api: FastifyInstance,
  db: DB,
  admin: (req: FastifyRequest) => Actor,
  overrides: {
    identity?: IdentityRuntime;
    storage?: StorageRuntime;
    messaging?: MessagingRuntime;
    search?: SearchRuntime;
  },
) {
  const existing = await db
    .selectFrom("account_settings")
    .selectAll()
    .where("id", "=", "service-credentials")
    .executeTakeFirst();
  const saved = existing ? JSON.parse(existing.config) : null;
  const identity: IdentityRuntime =
    overrides.identity ?? (saved ? saved.identity : identityRuntime());
  const storage: StorageRuntime =
    overrides.storage ??
    (saved
      ? {
          root: resolve(process.env.DOCA_UPLOAD_DIR || "data/v1/uploads"),
          ...saved.storage,
        }
      : storageRuntime());
  const messaging: MessagingRuntime =
    overrides.messaging ??
    (saved ? configuredMessaging(saved.messaging) : messagingRuntime());
  const search: SearchRuntime = overrides.search ??
    saved?.search ?? {
      apiKey: process.env.MEILI_API_KEY,
      allowedOrigins: (
        process.env.MEILI_ALLOWED_ORIGINS ??
        "http://127.0.0.1:7700,http://localhost:7700"
      ).split(","),
    };
  const seed = {
    identity: {
      credentials: identity.credentials,
      allowedOrigins: identity.allowedOrigins,
    },
    storage: {
      credentials: Object.fromEntries(
        Object.entries(storage.credentials).map(([ref, c]) => [
          ref,
          { ...c, sessionToken: c.sessionToken ?? "" },
        ]),
      ),
      endpointHosts: storage.endpointHosts,
      cdnKeyPairId: storage.cdnKeyPairId ?? "",
      cdnPrivateKey: storage.cdnPrivateKey ?? "",
    },
    messaging: {
      endpoint: process.env.DOCA_VERIFICATION_ENDPOINT ?? "",
      secret: messaging.secret,
      channels: [
        messaging.phoneReady ? "phone" : "",
        messaging.emailReady ? "email" : "",
      ].filter(Boolean),
    },
    search: {
      apiKey: search.apiKey ?? "",
      allowedOrigins: search.allowedOrigins,
    },
  };
  if (!existing)
    await db
      .insertInto("account_settings")
      .values({
        id: "service-credentials",
        config: JSON.stringify(seed),
        revision: 1,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  let revision = 0;
  const read = () =>
    db
      .selectFrom("account_settings")
      .selectAll()
      .where("id", "=", "service-credentials")
      .executeTakeFirstOrThrow();
  async function refresh() {
    const current = await db
      .selectFrom("account_settings")
      .select("revision")
      .where("id", "=", "service-credentials")
      .executeTakeFirstOrThrow();
    if (current.revision === revision) return;
    const row = await read();
    const c = JSON.parse(row.config);
    Object.assign(identity, c.identity);
    Object.assign(storage, c.storage);
    Object.assign(search, c.search);
    // Test/deployment adapters may supply an in-process sender rather than an HTTP gateway.
    if (
      !overrides.messaging ||
      existing ||
      revision > 0 ||
      c.messaging.endpoint
    ) {
      delete messaging.send;
      Object.assign(messaging, configuredMessaging(c.messaging));
    }
    revision = row.revision;
  }
  await refresh();
  // Keep each server process current, including rotations performed on another instance.
  api.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/api/")) await refresh();
  });
  function redacted(c: any) {
    const value = structuredClone(c);
    for (const ref of Object.keys(value.identity.credentials))
      value.identity.credentials[ref] = value.identity.credentials[ref]
        ? null
        : "";
    for (const credential of Object.values(value.storage.credentials) as any[])
      for (const key of ["secretAccessKey", "sessionToken"])
        credential[key] = credential[key] ? null : "";
    value.storage.cdnPrivateKey = value.storage.cdnPrivateKey ? null : "";
    value.messaging.secret = value.messaging.secret ? null : "";
    value.search.apiKey = value.search.apiKey ? null : "";
    return value;
  }
  api.get("/api/v1/admin/service-credentials", async (req) => {
    admin(req);
    const row = await read();
    return { revision: row.revision, config: redacted(JSON.parse(row.config)) };
  });
  api.put<{ Body: { revision: number; config: Settings } }>(
    "/api/v1/admin/service-credentials",
    {
      schema: {
        body: object({
          revision: Type.Integer({ minimum: 1 }),
          config: schema,
        }),
      },
    },
    async (req) => {
      const actor = admin(req);
      await transact(db, async (tx) => {
        const row = await tx
          .selectFrom("account_settings")
          .selectAll()
          .where("id", "=", "service-credentials")
          .executeTakeFirstOrThrow();
        if (row.revision !== req.body.revision)
          fail(409, "凭据已由其他管理员更新，请刷新后重试");
        const old = JSON.parse(row.config),
          c = structuredClone(req.body.config) as any;
        const keep = (value: any, previous: any) =>
          value === null ? (previous ?? "") : value;
        for (const ref of [
          ...Object.keys(c.identity.credentials),
          ...Object.keys(c.storage.credentials),
        ])
          if (["__proto__", "prototype", "constructor"].includes(ref))
            fail(400, "凭据名称不可用");
        for (const ref of Object.keys(c.identity.credentials)) {
          c.identity.credentials[ref] = keep(
            c.identity.credentials[ref],
            old.identity.credentials[ref],
          );
          if (
            !c.identity.credentials[ref].trim() &&
            !Object.hasOwn(old.identity.credentials, ref)
          )
            fail(400, "请填写 SSO 密钥，或移除该凭据");
        }
        for (const [ref, credential] of Object.entries(
          c.storage.credentials,
        ) as [string, any][]) {
          for (const key of ["secretAccessKey", "sessionToken"])
            credential[key] = keep(
              credential[key],
              old.storage.credentials[ref]?.[key],
            );
          if (
            (!credential.accessKeyId.trim() ||
              !credential.secretAccessKey.trim()) &&
            !Object.hasOwn(old.storage.credentials, ref)
          )
            fail(400, "请填写对象存储的 Access Key 和 Secret Key");
        }
        c.storage.cdnPrivateKey = keep(
          c.storage.cdnPrivateKey,
          old.storage.cdnPrivateKey,
        );
        c.messaging.secret = keep(c.messaging.secret, old.messaging.secret);
        c.search.apiKey = keep(c.search.apiKey, old.search.apiKey);
        const origin = (value: string, https: boolean) => {
          try {
            const u = new URL(value);
            if (
              (https
                ? u.protocol !== "https:"
                : !["http:", "https:"].includes(u.protocol)) ||
              u.username ||
              u.password ||
              u.pathname !== "/" ||
              u.search ||
              u.hash
            )
              throw new Error();
            return u.origin;
          } catch {
            return fail(400, "允许的服务来源请填写完整域名，不含路径或凭据");
          }
        };
        c.identity.allowedOrigins = c.identity.allowedOrigins.map((v: string) =>
          origin(v, true),
        );
        c.search.allowedOrigins = c.search.allowedOrigins.map((v: string) =>
          origin(v, false),
        );
        for (const host of c.storage.endpointHosts)
          if (new URL(origin("https://" + host, true)).host !== host)
            fail(400, "存储端点请填写域名及可选端口");
        if (c.messaging.endpoint) {
          try {
            const u = new URL(c.messaging.endpoint);
            if (u.protocol !== "https:" || u.username || u.password || u.hash)
              throw new Error();
          } catch {
            fail(400, "验证码网关必须是 HTTPS 地址");
          }
          if (!c.messaging.secret || !c.messaging.channels.length)
            fail(400, "请设置网关密钥并选择发送渠道");
        }
        if (c.storage.cdnPrivateKey) {
          try {
            createPrivateKey(c.storage.cdnPrivateKey);
          } catch {
            fail(400, "CDN 签名私钥格式无效，请填写 PEM 私钥");
          }
          if (!c.storage.cdnKeyPairId.trim())
            fail(400, "请填写 CDN 签名密钥 ID");
        }
        const updated = await tx
          .updateTable("account_settings")
          .set({ config: JSON.stringify(c), revision: row.revision + 1 })
          .where("id", "=", "service-credentials")
          .where("revision", "=", row.revision)
          .executeTakeFirst();
        if (!Number(updated.numUpdatedRows))
          fail(409, "凭据已更新，请刷新后重试");
        await securityAudit(
          tx,
          actor.id,
          null,
          "services.credentials_updated",
          {},
        );
      });
      await refresh();
      return { ok: true };
    },
  );
  return { identity, storage, messaging, search, refresh };
}
