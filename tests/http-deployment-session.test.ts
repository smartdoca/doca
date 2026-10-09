import { afterEach, expect, it, vi } from "vitest";
import { config, assetBase } from "@server/bootstrap/config.js";
import { sessionDurations } from "@server/app/session-policy.js";
import { createApp } from "@server/app/create-app.js";
import { createUser, tokenHash } from "@core/modules/identity/passwords.js";
import { openTestDatabase } from "./database.js";

afterEach(() => vi.unstubAllEnvs());

it("accepts HTTP site and asset origins in production", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DOCA_ORIGIN", "http://doca.internal:39120");
  vi.stubEnv("DOCA_DATABASE", "sqlite");
  vi.stubEnv("DOCA_WEBHOOK_DATABASE_URL", "");
  vi.stubEnv("DOCA_SESSION_TTL_SECONDS", "86400");
  vi.stubEnv("DOCA_MOBILE_SESSION_TTL_SECONDS", "15552000");
  expect(config().origin).toBe("http://doca.internal:39120");
  expect(assetBase("http://cdn.internal/doca/")).toBe(
    "http://cdn.internal/doca",
  );
  for (const value of [
    "ftp://doca.internal",
    "http://user:secret@doca.internal",
    "http://doca.internal/subpath",
    "http://doca.internal/?query=1",
    "http://doca.internal/#fragment",
  ]) {
    vi.stubEnv("DOCA_ORIGIN", value);
    expect(() => config()).toThrow("DOCA_ORIGIN");
  }
});

it("defaults to 24 hours on Web and 180 days on mobile, and validates explicit TTLs", () => {
  expect(sessionDurations({})).toEqual({
    browserSeconds: 86400,
    mobileSeconds: 15552000,
  });
  for (const name of [
    "DOCA_SESSION_TTL_SECONDS",
    "DOCA_MOBILE_SESSION_TTL_SECONDS",
  ])
    for (const value of ["", "0", "-1", "1.5", "1e3", " 60", "2147483648"])
      expect(() => sessionDurations({ [name]: value })).toThrow(name);
});

it.each(["http", "https"])(
  "keeps %s login cookies and persisted browser/mobile expiry consistent with configured TTLs",
  async (protocol) => {
    vi.stubEnv("DOCA_SESSION_TTL_SECONDS", "3600");
    vi.stubEnv("DOCA_MOBILE_SESSION_TTL_SECONDS", "7200");
    const origin = `${protocol}://doca.internal:39120`;
    const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      await createUser(
        db,
        {
          login: "isolated",
          displayName: "Isolated",
          password: "isolated-http-login-password",
        },
        { bootstrap: true },
      );
      app = await createApp(db, { origin });
      const login = async (mobile: boolean) => {
        const started = Date.now();
        const response = await app!.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: {
            host: "doca.internal:39120",
            ...(mobile ? { "x-doca-client": "mobile" } : { origin }),
          },
          payload: {
            login: "isolated",
            password: "isolated-http-login-password",
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        const cookie = String(response.headers["set-cookie"]);
        expect(cookie).toContain("Max-Age=3600");
        expect(cookie.includes("; Secure")).toBe(protocol === "https");
        expect(cookie).toContain("HttpOnly; SameSite=Strict");
        const token = mobile
          ? response.json().sessionToken
          : cookie.match(/doca_session=([a-f0-9]{64})/)![1]!;
        const row = await db
          .selectFrom("sessions")
          .select("expires_at")
          .where("id", "=", tokenHash(token))
          .executeTakeFirstOrThrow();
        const expiry = new Date(row.expires_at).getTime();
        const seconds = mobile ? 7200 : 3600;
        expect(expiry).toBeGreaterThanOrEqual(started + seconds * 1000);
        expect(expiry).toBeLessThanOrEqual(Date.now() + seconds * 1000);
        return token;
      };
      const browserToken = await login(false);
      const mobileToken = await login(true);
      await db
        .updateTable("sessions")
        .set({ expires_at: new Date(Date.now() + 10_000).toISOString() })
        .where("id", "=", tokenHash(mobileToken))
        .execute();
      const renewed = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: {
          host: "doca.internal:39120",
          authorization: `Bearer ${mobileToken}`,
          "x-doca-client": "mobile",
        },
      });
      expect(renewed.statusCode, renewed.body).toBe(200);
      const row = await db
        .selectFrom("sessions")
        .select("expires_at")
        .where("id", "=", tokenHash(mobileToken))
        .executeTakeFirstOrThrow();
      expect(new Date(row.expires_at).getTime()).toBeGreaterThan(
        Date.now() + 7_000_000,
      );
      await db
        .updateTable("sessions")
        .set({ expires_at: "2000-01-01T00:00:00.000Z" })
        .where("id", "=", tokenHash(browserToken))
        .execute();
      const expired = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: {
          host: "doca.internal:39120",
          cookie: `doca_session=${browserToken}`,
        },
      });
      expect(expired.statusCode).toBe(401);
    } finally {
      await app?.close();
      await db.destroy();
    }
  },
);
