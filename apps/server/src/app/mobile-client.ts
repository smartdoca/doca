import { randomBytes, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toString as renderQr } from "qrcode";
import { identityPolicy } from "@core/modules/identity/accounts.js";
import { recordLogin, tokenHash } from "@core/modules/identity/passwords.js";
import type { MobilePush } from "@core/modules/mobile/push.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import { fail } from "@core/shared/errors.js";
import type { DB } from "@db/index.js";
import { sessionDurations } from "./session-policy.js";

const sessionPattern = /^[a-f0-9]{64}$/;
const qrCodePattern = /^[a-f0-9]{64}$/;

export function sessionExpiresAt(req: { headers: FastifyRequest["headers"] }) {
  const mobile = req.headers["x-doca-client"] === "mobile";
  const { browserSeconds, mobileSeconds } = sessionDurations();
  return new Date(
    Date.now() + (mobile ? mobileSeconds : browserSeconds) * 1000,
  ).toISOString();
}

export async function renewMobileSession(db: DB, token: string) {
  const mobileSessionMs = sessionDurations().mobileSeconds * 1000;
  const renewalIntervalMs = Math.min(30 * 24 * 60 * 60 * 1000, mobileSessionMs / 6);
  await db
    .updateTable("sessions")
    .set({ expires_at: new Date(Date.now() + mobileSessionMs).toISOString() })
    .where("id", "=", tokenHash(token))
    .where(
      "expires_at",
      "<",
      new Date(
        Date.now() + mobileSessionMs - renewalIntervalMs,
      ).toISOString(),
    )
    .execute();
}

export function mobileSession<T extends object>(
  req: FastifyRequest,
  token: string | undefined,
  body: T,
): T & { sessionToken?: string } {
  if (!token || req.headers["x-doca-client"] !== "mobile") return body;
  return { ...body, sessionToken: token };
}

export function startMobilePush(db: DB) {
  let active: Promise<unknown> | undefined;
  const pump = () => {
    if (active) return;
    active = processProjections(
      db,
      "mobile-push",
      (payload) => deliverMobilePush(db, payload as MobilePush),
      10,
      60_000,
    ).finally(() => {
      active = undefined;
    });
  };
  const timer = setInterval(pump, 1000);
  timer.unref();
  pump();
  return async () => {
    clearInterval(timer);
    await active;
  };
}

async function deliverMobilePush(db: DB, event: MobilePush) {
  const devices = await db
    .selectFrom("push_devices")
    .select("token")
    .where("user_id", "=", event.userId)
    .execute();
  if (!devices.length) return;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(
      devices.map((device) => ({
        to: device.token,
        title: event.title,
        body: event.body.slice(0, 180),
        data: { path: event.path },
        sound: "default",
      })),
    ),
  });
  if (!response.ok) throw new Error(`Mobile push failed (${response.status})`);
}

export function registerMobileClient(
  api: FastifyInstance,
  db: DB,
  authenticated: (req: FastifyRequest) => { id: string },
  cookie: (token: string, maxAge?: number) => string,
  limit: (key: string, max?: number) => Promise<void>,
) {
  api.post("/api/v1/auth/webview-ticket", async (req) => {
    const actor = authenticated(req);
    await limit(`webview:${actor.id}`, 30);
    const ticket = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await db
      .deleteFrom("webview_tickets")
      .where("expires_at", "<=", new Date().toISOString())
      .execute();
    await db
      .insertInto("webview_tickets")
      .values({
        id: tokenHash(ticket),
        user_id: actor.id,
        expires_at: expiresAt,
      })
      .execute();
    return { ticket, expiresAt };
  });

  api.post<{ Body: { ticket: string } }>(
    "/api/v1/auth/webview",
    {
      schema: {
        body: Type.Object({
          ticket: Type.String({
            minLength: 64,
            maxLength: 64,
            pattern: "^[a-f0-9]{64}$",
          }),
        }),
      },
    },
    async (req, reply) => {
      await limit(`webview-redeem:${req.ip}`, 30);
      const row = await db
        .selectFrom("webview_tickets")
        .selectAll()
        .where("id", "=", tokenHash(req.body.ticket))
        .executeTakeFirst();
      if (!row || row.expires_at <= new Date().toISOString()) {
        if (row)
          await db
            .deleteFrom("webview_tickets")
            .where("id", "=", row.id)
            .execute();
        fail(401, "文档打开链接已失效，请从手机重新进入");
      }
      const removed = await db
        .deleteFrom("webview_tickets")
        .where("id", "=", row.id)
        .executeTakeFirst();
      if (!removed.numDeletedRows)
        fail(401, "文档打开链接已失效，请从手机重新进入");
      const user = await db
        .selectFrom("users")
        .select("id")
        .where("id", "=", row.user_id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!user) fail(401, "请先登录");
      const token = randomBytes(32).toString("hex");
      await db
        .insertInto("sessions")
        .values({
          id: tokenHash(token),
          user_id: user.id,
          expires_at: new Date(
            Date.now() + sessionDurations().browserSeconds * 1000,
          ).toISOString(),
        })
        .execute();
      await recordLogin(db, user.id);
      reply.header("Set-Cookie", cookie(token));
      return { ok: true };
    },
  );

  api.put<{ Body: { token: string; platform: "ios" | "android" } }>(
    "/api/v1/me/push-devices",
    {
      schema: {
        body: Type.Object({
          token: Type.String({ minLength: 20, maxLength: 200 }),
          platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
        }),
      },
    },
    async (req) => {
      const actor = authenticated(req);
      if (!req.body.token.startsWith("ExponentPushToken["))
        fail(400, "推送令牌无效");
      const now = new Date().toISOString();
      const existing = await db
        .selectFrom("push_devices")
        .select("id")
        .where("token", "=", req.body.token)
        .executeTakeFirst();
      if (existing) {
        await db
          .updateTable("push_devices")
          .set({
            user_id: actor.id,
            platform: req.body.platform,
            updated_at: now,
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
        await db
          .insertInto("push_devices")
          .values({
            id: randomUUID(),
            user_id: actor.id,
            token: req.body.token,
            platform: req.body.platform,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      return { ok: true };
    },
  );

  api.delete<{ Body: { token: string } }>(
    "/api/v1/me/push-devices",
    {
      schema: {
        body: Type.Object({
          token: Type.String({ minLength: 20, maxLength: 200 }),
        }),
      },
    },
    async (req) => {
      const actor = authenticated(req);
      await db
        .deleteFrom("push_devices")
        .where("user_id", "=", actor.id)
        .where("token", "=", req.body.token)
        .execute();
      return { ok: true };
    },
  );

  api.post("/api/v1/auth/qr", async (req) => {
    await requireQrLogin(db);
    await limit(`qr:${req.ip}`, 10);
    const pageOrigin = req.headers.origin;
    if (
      typeof pageOrigin !== "string" ||
      !/^https?:\/\/[^/\s]+$/.test(pageOrigin)
    )
      fail(400, "缺少来源");
    const code = randomBytes(32).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    await db
      .deleteFrom("qr_logins")
      .where("expires_at", "<=", new Date().toISOString())
      .execute();
    await db
      .insertInto("qr_logins")
      .values({
        id: tokenHash(code),
        secret_hash: tokenHash(secret),
        user_id: null,
        expires_at: expiresAt,
      })
      .execute();
    const payload = `doca-login:${pageOrigin}:${code}`;
    const svg = await renderQr(payload, {
      type: "svg",
      margin: 1,
      width: 240,
      errorCorrectionLevel: "M",
    });
    return { code, secret, expiresAt, payload, svg };
  });

  api.get<{ Params: { code: string } }>(
    "/api/v1/auth/qr/:code",
    async (req, reply) => {
      await requireQrLogin(db);
      await limit(`qr-poll:${req.ip}`, 90);
      return claimQrLogin(
        db,
        req.params.code,
        headerSecret(req),
        reply,
        cookie,
      );
    },
  );

  api.post<{ Params: { code: string } }>(
    "/api/v1/auth/qr/:code/confirm",
    async (req) => {
      await requireQrLogin(db);
      const actor = authenticated(req);
      await limit(`qr-confirm:${actor.id}`, 20);
      const row = await loadQrLogin(db, req.params.code);
      if (row.user_id && row.user_id !== actor.id)
        fail(409, "这个二维码已由其他账号确认");
      await db
        .updateTable("qr_logins")
        .set({ user_id: actor.id })
        .where("id", "=", row.id)
        .execute();
      return { ok: true };
    },
  );
}

async function requireQrLogin(db: DB) {
  if (!(await identityPolicy(db)).qrLoginEnabled) fail(403, "扫码登录未开启");
}

function headerSecret(req: FastifyRequest) {
  const secret = req.headers["x-doca-qr-secret"];
  return typeof secret === "string" ? secret : "";
}

async function loadQrLogin(db: DB, code: string) {
  if (!qrCodePattern.test(code)) fail(410, "二维码已失效，请刷新网页");
  const row = await db
    .selectFrom("qr_logins")
    .selectAll()
    .where("id", "=", tokenHash(code))
    .executeTakeFirst();
  if (!row || row.expires_at <= new Date().toISOString()) {
    if (row)
      await db.deleteFrom("qr_logins").where("id", "=", row.id).execute();
    fail(410, "二维码已失效，请刷新网页");
  }
  return row;
}

async function claimQrLogin(
  db: DB,
  code: string,
  secret: string,
  reply: FastifyReply,
  cookie: (token: string, maxAge?: number) => string,
) {
  const row = await loadQrLogin(db, code);
  if (!qrCodePattern.test(secret) || row.secret_hash !== tokenHash(secret))
    fail(401, "登录凭证无效");
  if (!row.user_id)
    return { status: "pending" as const, expiresAt: row.expires_at };
  const removed = await db
    .deleteFrom("qr_logins")
    .where("id", "=", row.id)
    .where("user_id", "=", row.user_id)
    .executeTakeFirst();
  if (!removed.numDeletedRows) fail(410, "二维码已失效，请刷新网页");
  const token = randomBytes(32).toString("hex");
  await db
    .insertInto("sessions")
    .values({
      id: tokenHash(token),
      user_id: row.user_id,
      expires_at: new Date(
        Date.now() + sessionDurations().browserSeconds * 1000,
      ).toISOString(),
    })
    .execute();
  await recordLogin(db, row.user_id);
  reply.header("Set-Cookie", cookie(token));
  return { status: "active" as const };
}

export function bearerSession(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return sessionPattern.test(token) ? token : null;
}
