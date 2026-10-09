import { openTestDatabase as openDatabase } from "./database.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DB } from "@db/index.js";
import { createUser, tokenHash } from "@core/modules/identity/passwords.js";
import { createApp } from "../apps/server/src/app/create-app.js";

const origin = "http://localhost:39131";
const password = "mobile-session-password";
let db: DB;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  await createUser(
    db,
    { login: "mobile", displayName: "手机用户", password },
    { bootstrap: true },
  );
  app = await createApp(db, { origin });
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
});

const host = { host: "localhost:39131" };

it("lets the mobile client log in without a browser origin", async () => {
  const mobile = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: {
      ...host,
      "content-type": "application/json",
      "x-doca-client": "mobile",
    },
    payload: { login: "mobile", password },
  });
  expect(mobile.statusCode, mobile.body).toBe(200);
  expect(mobile.json().sessionToken).toMatch(/^[a-f0-9]{64}$/);

  const browser = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { ...host, "content-type": "application/json" },
    payload: { login: "mobile", password },
  });
  expect(browser.statusCode).toBe(403);

  const cookie = String(mobile.headers["set-cookie"]).split(";")[0]!;
  const forged = await app.inject({
    method: "POST",
    url: "/api/v1/me/heartbeat",
    headers: { ...host, cookie, "x-doca-client": "mobile" },
  });
  expect(forged.statusCode).toBe(403);
});

it("returns a session token only to the mobile client and accepts it as bearer", async () => {
  const browser = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { ...host, origin, "content-type": "application/json" },
    payload: { login: "mobile", password },
  });
  expect(browser.statusCode, browser.body).toBe(200);
  expect(browser.json()).not.toHaveProperty("sessionToken");
  const cookie = String(browser.headers["set-cookie"]).split(";")[0]!;

  const denied = await app.inject({
    method: "POST",
    url: "/api/v1/me/heartbeat",
    headers: { ...host, cookie },
  });
  expect(denied.statusCode).toBe(403);

  const forged = await app.inject({
    method: "POST",
    url: "/api/v1/me/heartbeat",
    headers: {
      ...host,
      cookie,
      authorization: "Bearer " + "ab".repeat(32),
    },
  });
  expect(forged.statusCode).toBe(403);

  const mobile = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: {
      ...host,
      origin,
      "content-type": "application/json",
      "x-doca-client": "mobile",
    },
    payload: { login: "mobile", password },
  });
  expect(mobile.statusCode, mobile.body).toBe(200);
  const token = mobile.json().sessionToken as string;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const beat = await app.inject({
    method: "POST",
    url: "/api/v1/me/heartbeat",
    headers: { ...host, authorization: `Bearer ${token}` },
  });
  expect(beat.statusCode, beat.body).toBe(200);

  const ticket = await app.inject({
    method: "POST",
    url: "/api/v1/auth/webview-ticket",
    headers: { ...host, authorization: `Bearer ${token}` },
  });
  expect(ticket.statusCode, ticket.body).toBe(200);
  const code = ticket.json().ticket as string;
  expect(code).toMatch(/^[a-f0-9]{64}$/);
  expect(code).not.toBe(token);

  const missingOrigin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/webview",
    headers: { ...host, "content-type": "application/json" },
    payload: { ticket: code },
  });
  expect(missingOrigin.statusCode).toBe(403);

  const redeem = await app.inject({
    method: "POST",
    url: "/api/v1/auth/webview",
    headers: { ...host, origin, "content-type": "application/json" },
    payload: { ticket: code },
  });
  expect(redeem.statusCode, redeem.body).toBe(200);
  expect(redeem.json()).toEqual({ ok: true });
  expect(String(redeem.headers["set-cookie"])).toContain("doca_session=");
  const again = await app.inject({
    method: "POST",
    url: "/api/v1/auth/webview",
    headers: { ...host, origin, "content-type": "application/json" },
    payload: { ticket: code },
  });
  expect(again.statusCode).toBe(401);

  const registered = await app.inject({
    method: "PUT",
    url: "/api/v1/me/push-devices",
    headers: {
      ...host,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload: {
      token: "ExponentPushToken[mobile-session-test]",
      platform: "ios",
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
});

it("keeps a mobile session for months and logs the browser in from a confirmed code", async () => {
  const mobile = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: {
      ...host,
      "content-type": "application/json",
      "x-doca-client": "mobile",
    },
    payload: { login: "mobile", password },
  });
  expect(mobile.statusCode, mobile.body).toBe(200);
  const token = mobile.json().sessionToken as string;
  const mobileRow = await db
    .selectFrom("sessions")
    .select("expires_at")
    .where("id", "=", tokenHash(token))
    .executeTakeFirstOrThrow();
  expect(new Date(mobileRow.expires_at).getTime()).toBeGreaterThan(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db
    .updateTable("sessions")
    .set({ expires_at: new Date(Date.now() + 60_000).toISOString() })
    .where("id", "=", tokenHash(token))
    .execute();
  const beat = await app.inject({
    method: "POST",
    url: "/api/v1/me/heartbeat",
    headers: { ...host, authorization: `Bearer ${token}` },
  });
  expect(beat.statusCode, beat.body).toBe(200);
  const renewed = await db
    .selectFrom("sessions")
    .select("expires_at")
    .where("id", "=", tokenHash(token))
    .executeTakeFirstOrThrow();
  expect(new Date(renewed.expires_at).getTime()).toBeGreaterThan(Date.now() + 100 * 24 * 60 * 60 * 1000);

  const browser = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { ...host, origin, "content-type": "application/json" },
    payload: { login: "mobile", password },
  });
  expect(browser.statusCode, browser.body).toBe(200);
  const browserToken = String(browser.headers["set-cookie"]).split(";")[0]!.slice("doca_session=".length);
  const before = await db
    .selectFrom("sessions")
    .select("expires_at")
    .where("id", "=", tokenHash(browserToken))
    .executeTakeFirstOrThrow();
  expect(new Date(before.expires_at).getTime()).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
  const browserBeat = await app.inject({
    method: "POST",
    url: "/api/v1/me/heartbeat",
    headers: { ...host, origin, cookie: `doca_session=${browserToken}` },
  });
  expect(browserBeat.statusCode, browserBeat.body).toBe(200);
  const after = await db
    .selectFrom("sessions")
    .select("expires_at")
    .where("id", "=", tokenHash(browserToken))
    .executeTakeFirstOrThrow();
  expect(after.expires_at).toBe(before.expires_at);

  const options = await app.inject({
    method: "GET",
    url: "/api/v1/auth/options",
    headers: host,
  });
  expect(options.statusCode, options.body).toBe(200);
  expect(options.json().qrLoginEnabled).toBe(false);
  const closed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/qr",
    headers: { ...host, origin, accept: "application/json" },
  });
  expect(closed.statusCode, closed.body).toBe(403);

  await db
    .updateTable("account_settings")
    .set({ config: JSON.stringify({ qrLoginEnabled: true }) })
    .where("id", "=", "identity")
    .execute();
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/auth/qr",
    headers: { ...host, origin, accept: "application/json" },
  });
  expect(created.statusCode, created.body).toBe(200);
  const { code, secret, payload, svg } = created.json();
  expect(payload).toBe(`doca-login:${origin}:${code}`);
  expect(svg).toContain("<svg");
  expect(svg).not.toContain(secret);
  expect(payload).not.toContain(secret);

  const pending = await app.inject({
    method: "GET",
    url: `/api/v1/auth/qr/${code}`,
    headers: { ...host, "x-doca-qr-secret": secret },
  });
  expect(pending.statusCode, pending.body).toBe(200);
  expect(pending.json().status).toBe("pending");
  expect(pending.headers["set-cookie"]).toBeUndefined();

  const anonymous = await app.inject({
    method: "POST",
    url: `/api/v1/auth/qr/${code}/confirm`,
    headers: { ...host, origin },
  });
  expect(anonymous.statusCode).toBe(401);

  const confirm = await app.inject({
    method: "POST",
    url: `/api/v1/auth/qr/${code}/confirm`,
    headers: { ...host, authorization: `Bearer ${token}` },
  });
  expect(confirm.statusCode, confirm.body).toBe(200);

  const done = await app.inject({
    method: "GET",
    url: `/api/v1/auth/qr/${code}`,
    headers: { ...host, "x-doca-qr-secret": secret },
  });
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json().status).toBe("active");
  const cookie = String(done.headers["set-cookie"]).split(";")[0]!;
  expect(cookie).toContain("doca_session=");
  const web = await app.inject({
    method: "POST",
    url: "/api/v1/me/heartbeat",
    headers: { ...host, origin, cookie },
  });
  expect(web.statusCode, web.body).toBe(200);

  const replay = await app.inject({
    method: "GET",
    url: `/api/v1/auth/qr/${code}`,
    headers: { ...host, "x-doca-qr-secret": secret },
  });
  expect(replay.statusCode).toBe(410);
});
