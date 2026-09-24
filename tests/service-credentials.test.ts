import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { createUser } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import type { IdentityRuntime } from "../apps/server/src/adapters/identity-providers.js";
let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  admin: string,
  user: string;
const origin = "http://localhost:39131",
  password = "credentials-test-password";
let runtime: IdentityRuntime;
const request = (method: any, path: string, cookie = admin, payload?: object) =>
  app.inject({
    method,
    url: "/api/v1" + path,
    headers: { origin, host: "localhost:39131", cookie },
    payload,
  });
const read = async () => {
  const r = await request("GET", "/admin/service-credentials");
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const owner = await createUser(
    db,
    { login: "admin", displayName: "Admin", password },
    { bootstrap: true },
  );
  await createUser(
    db,
    { login: "alice", displayName: "Alice", password },
    { actor: { ...owner, admin: 1 } },
  );
  runtime = { credentials: {}, allowedOrigins: [] };
  app = await createApp(db, { origin, identity: runtime });
  const login = async (login: string) =>
    String(
      (await request("POST", "/auth/login", "", { login, password })).headers[
        "set-cookie"
      ],
    ).split(";")[0]!;
  admin = await login("admin");
  user = await login("alice");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await db.destroy();
});
it("restricts credentials to admins and protects writes against cross-origin requests", async () => {
  expect(
    (await request("GET", "/admin/service-credentials", "")).statusCode,
  ).toBe(401);
  expect(
    (await request("GET", "/admin/service-credentials", user)).statusCode,
  ).toBe(403);
  const c = await read();
  expect(
    (await request("PUT", "/admin/service-credentials", user, c)).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/service-credentials",
        headers: {
          host: "localhost:39131",
          origin: "https://elsewhere.test",
          cookie: admin,
        },
        payload: c,
      })
    ).statusCode,
  ).toBe(403);
});
it("persists secrets without returning them, preserves masked values, checks revisions and survives restart", async () => {
  const c = await read();
  c.config.identity.credentials.company = "sso-private-value";
  c.config.storage.credentials.store = {
    accessKeyId: "access-id",
    secretAccessKey: "storage-private-value",
    sessionToken: "session-private-value",
  };
  c.config.search.apiKey = "search-private-value";
  c.config.messaging = {
    endpoint: "https://gateway.example.test/send",
    secret: "messaging-private-value",
    channels: ["email"],
  };
  expect(
    (await request("PUT", "/admin/service-credentials", admin, c)).statusCode,
  ).toBe(200);
  expect(runtime.credentials.company).toBe("sso-private-value");
  const masked = await read();
  expect(masked.config.identity.credentials.company).toBeNull();
  expect(JSON.stringify(masked)).not.toContain("private-value");
  expect((await request("GET", "/auth/options", "")).json().emailReady).toBe(
    true,
  );
  masked.config.identity.allowedOrigins = ["https://sso.example.test"];
  expect(
    (await request("PUT", "/admin/service-credentials", admin, masked))
      .statusCode,
  ).toBe(200);
  expect(
    (await request("PUT", "/admin/service-credentials", admin, c)).statusCode,
  ).toBe(409);
  const stored = JSON.parse(
    (
      await db
        .selectFrom("account_settings")
        .select("config")
        .where("id", "=", "service-credentials")
        .executeTakeFirstOrThrow()
    ).config,
  );
  expect(stored.storage.credentials.store.secretAccessKey).toBe(
    "storage-private-value",
  );
  await app.close();
  app = await createApp(db, { origin });
  expect((await read()).config.identity.credentials.company).toBeNull();
  expect((await request("GET", "/auth/options", "")).json().emailReady).toBe(
    true,
  );
  const clear = await read();
  clear.config.search.apiKey = "";
  expect(
    (await request("PUT", "/admin/service-credentials", admin, clear))
      .statusCode,
  ).toBe(200);
  expect((await read()).config.search.apiKey).toBe("");
});
it("rejects unsafe endpoint, malformed keys and unexpected configuration fields", async () => {
  const c = await read();
  for (const update of [
    (v: any) => {
      v.identity.allowedOrigins = ["http://sso.example.test"];
    },
    (v: any) => {
      v.storage.cdnPrivateKey = "not-a-private-key";
    },
    (v: any) => {
      v.messaging.endpoint = "http://localhost:1234";
    },
    (v: any) => {
      v.identity.credentials.constructor = "secret";
    },
    (v: any) => {
      v.search.extra = "hidden";
    },
  ]) {
    const changed = structuredClone(c);
    update(changed.config);
    const r = await request(
      "PUT",
      "/admin/service-credentials",
      admin,
      changed,
    );
    expect(r.statusCode, r.body).toBe(400);
  }
});
it("rotates verification gateway credentials live and refreshes another running instance", async () => {
  const otherRuntime: IdentityRuntime = { credentials: {}, allowedOrigins: [] };
  const other = await createApp(db, { origin, identity: otherRuntime });
  try {
    const c = await read();
    c.config.identity.credentials.company = "rotated-client-secret";
    c.config.messaging = {
      endpoint: "https://gateway.example.test/send",
      secret: "rotated-gateway-secret",
      channels: ["email"],
    };
    expect(
      (await request("PUT", "/admin/service-credentials", admin, c)).statusCode,
    ).toBe(200);
    const r = await other.inject({
      method: "GET",
      url: "/api/v1/auth/options",
      headers: { host: "localhost:39131" },
    });
    expect(r.json().emailReady).toBe(true);
    expect(otherRuntime.credentials.company).toBe("rotated-client-secret");
    const sent: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent.push({ input, init });
      return new Response("{}", { status: 200 });
    });
    const start = await request("POST", "/auth/challenges", user, {
      kind: "email",
      value: "alice@example.test",
      purpose: "profile",
    });
    expect(start.statusCode, start.body).toBe(200);
    expect(sent[0].init.headers.Authorization).toBe(
      "Bearer rotated-gateway-secret",
    );
    expect(JSON.parse(sent[0].init.body).destination).toBe(
      "alice@example.test",
    );
  } finally {
    await other.close();
  }
});

it("imports legacy secrets only before database configuration exists", async () => {
  await app.close();
  await db
    .deleteFrom("account_settings")
    .where("id", "=", "service-credentials")
    .execute();
  const previous = process.env.DOCA_AUTH_CREDENTIALS;
  try {
    process.env.DOCA_AUTH_CREDENTIALS = JSON.stringify({
      legacy: "legacy-client-secret",
    });
    app = await createApp(db, { origin });
    const c = await read();
    expect(c.config.identity.credentials.legacy).toBeNull();
    c.config.identity.credentials.legacy = "database-client-secret";
    expect(
      (await request("PUT", "/admin/service-credentials", admin, c)).statusCode,
    ).toBe(200);
    await app.close();
    process.env.DOCA_AUTH_CREDENTIALS = "invalid old environment JSON";
    app = await createApp(db, { origin });
    expect((await read()).config.identity.credentials.legacy).toBeNull();
    const row = await db
      .selectFrom("account_settings")
      .select("config")
      .where("id", "=", "service-credentials")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.config).identity.credentials.legacy).toBe(
      "database-client-secret",
    );
  } finally {
    if (previous === undefined) delete process.env.DOCA_AUTH_CREDENTIALS;
    else process.env.DOCA_AUTH_CREDENTIALS = previous;
  }
});
