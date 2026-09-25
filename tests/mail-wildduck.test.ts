import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@core/shared/errors.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { defaultMailSettings } from "../plugins/mail/src/core/settings.js";
import type { DB } from "@db/index.js";
import { createHttpWildduck } from "../plugins/mail/src/server/index.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { openTestDatabase } from "./database.js";

const origin = "http://localhost:39142";
const password = "test-only-password-2026";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function settings(token = "cloud-token") {
  return {
    ...defaultMailSettings,
    enabled: true,
    endpoint: "https://mail.heyphp.com",
    domain: "heyphp.com",
    token,
  };
}

it("maps a missing WildDuck token to a configuration error", async () => {
  const client = createHttpWildduck(
    settings("wrong-token"),
    async () =>
      jsonResponse(403, { code: "InvalidToken", message: "Invalid accessToken value" }),
  );
  await expect(client.testConnection()).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining("API 密钥不存在"),
  } satisfies Partial<AppError>);
});

it("trims the token and sends both WildDuck auth headers", async () => {
  let headers: Headers | undefined;
  const client = createHttpWildduck(settings("  cloud-token  "), async (_url, init) => {
    headers = new Headers(init?.headers);
    return jsonResponse(200, { success: true, version: "1.46.1" });
  });
  await expect(client.testConnection()).resolves.toEqual({
    ok: true,
    version: "1.46.1",
  });
  expect(headers?.get("X-Access-Token")).toBe("cloud-token");
  expect(headers?.get("Authorization")).toBe("Bearer cloud-token");
});

it("does not treat a WildDuck outage as an unhandled backend crash", async () => {
  const client = createHttpWildduck(settings(), async () => {
    throw new TypeError("fetch failed");
  });
  await expect(client.testConnection()).rejects.toMatchObject({
    status: 502,
    message: expect.stringContaining("无法连接 WildDuck"),
  });
});

let db: DB;
let app: Awaited<ReturnType<typeof createApp>>;
let directory = "";
let adminCookie = "";
let mailFetch: typeof fetch = async () => jsonResponse(200, { success: true });

async function request(method: "GET" | "PUT", path: string, payload?: unknown) {
  return (app.inject as any)({
    method,
    url: "/api/v1" + path,
    headers: {
      host: "localhost:39142",
      origin,
      cookie: adminCookie,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload }),
  }) as Promise<any>;
}

beforeEach(async () => {
  mailFetch = async () => jsonResponse(200, { success: true });
  directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "doca-mail-wildduck-"));
  db = await openTestDatabase({
    driver: "sqlite",
    path: join(directory, "test.db"),
  });
  await createUser(
    db,
    { login: "admin", displayName: "管理员", password },
    { bootstrap: true },
  );
  app = await createApp(db, {
    origin,
    storage: {
      root: join(directory, "uploads"),
      credentials: {},
      endpointHosts: [],
      cdnKeyPairId: undefined,
      cdnPrivateKey: undefined,
    },
    mail: { fetch: (input, init) => mailFetch(input, init) },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "localhost:39142", origin },
    payload: { login: "admin", password },
  });
  expect(login.statusCode, login.body).toBe(200);
  adminCookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("rejects cloud WildDuck binding when the API token does not exist", async () => {
  mailFetch = async () =>
    jsonResponse(403, { code: "InvalidToken", message: "Invalid accessToken value" });
  const current = await request("GET", "/admin/mail");
  const saved = await request("PUT", "/admin/mail", {
    revision: current.json().revision,
    config: {
      enabled: true,
      endpoint: "https://mail.heyphp.com",
      domain: "heyphp.com",
      mode: "independent",
      maxMailboxes: 3,
      username: "",
      token: "missing-cloud-token",
    },
  });
  expect(saved.statusCode, saved.body).toBe(400);
  expect(saved.json().message).toContain("API 密钥不存在");
});

it("saves external mail settings without a WildDuck token", async () => {
  let wildduckCalls = 0;
  mailFetch = async () => {
    wildduckCalls += 1;
    return jsonResponse(403, { code: "InvalidToken", message: "Invalid accessToken value" });
  };
  const current = await request("GET", "/admin/mail");
  const saved = await request("PUT", "/admin/mail", {
    revision: current.json().revision,
    config: {
      enabled: false,
      endpoint: "",
      domain: "",
      mode: "free",
      maxMailboxes: 3,
      username: "",
      token: null,
      external: {
        enabled: true,
        maxAccounts: 3,
        providers: { gmail: true, outlook: false, qq: true },
      },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().config.external.enabled).toBe(true);
  expect(saved.json().public.internalConfigured).toBe(false);
  expect(wildduckCalls).toBe(0);
});

it("does not recheck WildDuck when only external settings change", async () => {
  await db
    .updateTable("mail_settings")
    .set({
      config: JSON.stringify({
        ...defaultMailSettings,
        enabled: true,
        endpoint: "https://mail.heyphp.com",
        domain: "heyphp.com",
        token: "",
      }),
      revision: 1,
    })
    .where("id", "=", "system")
    .execute();
  let wildduckCalls = 0;
  mailFetch = async () => {
    wildduckCalls += 1;
    return jsonResponse(403, { code: "InvalidToken", message: "Invalid accessToken value" });
  };
  const current = await request("GET", "/admin/mail");
  const saved = await request("PUT", "/admin/mail", {
    revision: current.json().revision,
    config: {
      ...current.json().config,
      token: null,
      external: {
        enabled: true,
        maxAccounts: 3,
        providers: { gmail: true, qq: true },
      },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().config.external.enabled).toBe(true);
  expect(wildduckCalls).toBe(0);
});

it("saves cloud WildDuck settings after a successful token check", async () => {
  const current = await request("GET", "/admin/mail");
  const saved = await request("PUT", "/admin/mail", {
    revision: current.json().revision,
    config: {
      enabled: true,
      endpoint: "https://mail.heyphp.com",
      domain: "heyphp.com",
      mode: "independent",
      maxMailboxes: 3,
      username: "",
      token: "  cloud-token  ",
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().config.token).toBeNull();
  expect(saved.json().public.internalConfigured).toBe(true);
});
