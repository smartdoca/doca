import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { createMemoryStalwart } from "../apps/server/src/adapters/stalwart.js";
import { defaultMailSettings, publicMailSettings } from "@core/modules/mail/settings.js";

const origin = "http://localhost:39141";
const password = "test-only-password-2026";
let db: DB;
let app: Awaited<ReturnType<typeof createApp>>;
let directory = "";
let adminCookie = "";
let aliceCookie = "";
let mailFetch: typeof fetch | undefined;

function fakeIdToken(email: string) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.x`;
}

async function request(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  cookie: string,
  payload?: unknown,
) {
  return (app.inject as any)({
    method,
    url: "/api/v1" + path,
    headers: {
      host: "localhost:39141",
      origin,
      cookie,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload }),
  }) as Promise<any>;
}

async function login(loginName: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "localhost:39141", origin },
    payload: { login: loginName, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return String(response.headers["set-cookie"]).split(";")[0]!;
}

beforeEach(async () => {
  mailFetch = undefined;
  directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "doca-mail-external-"));
  db = await openTestDatabase({
    driver: "sqlite",
    path: join(directory, "test.db"),
  });
  const admin = await createUser(
    db,
    { login: "admin", displayName: "管理员", password },
    { bootstrap: true },
  );
  await createUser(
    db,
    { login: "alice", displayName: "Alice", password },
    { actor: { ...admin, admin: 1 } as Actor },
  );
  const memory = createMemoryStalwart();
  app = await createApp(db, {
    origin,
    storage: {
      root: join(directory, "uploads"),
      credentials: {},
      endpointHosts: [],
      cdnKeyPairId: undefined,
      cdnPrivateKey: undefined,
    },
    mail: {
      client: memory,
      externalClient: () => memory,
      fetch: (input, init) => (mailFetch ?? fetch)(input, init),
    },
  });
  adminCookie = await login("admin");
  aliceCookie = await login("alice");
});

afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function providers(enabled: Record<string, boolean> = { gmail: true, qq: true }) {
  return {
    gmail: false,
    outlook: false,
    qq: false,
    "163": false,
    "126": false,
    icloud: false,
    yahoo: false,
    custom: false,
    ...enabled,
  };
}

async function saveMail(config: Record<string, unknown>) {
  const current = await request("GET", "/admin/mail", adminCookie);
  expect(current.statusCode).toBe(200);
  const saved = await request("PUT", "/admin/mail", adminCookie, {
    revision: current.json().revision,
    config,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json();
}

it("treats enabled external providers as a configured mail entry", () => {
  expect(
    publicMailSettings({
      ...defaultMailSettings,
      external: {
        ...defaultMailSettings.external,
        enabled: true,
        providers: { ...defaultMailSettings.external.providers, gmail: true },
      },
    }),
  ).toMatchObject({
    configured: true,
    internalConfigured: false,
    external: { enabled: true },
  });
});

it("lets admins open external mail without enabling the internal domain", async () => {
  const saved = await saveMail({
    enabled: false,
    endpoint: "",
    domain: "",
    mode: "free",
    maxMailboxes: 3,
    username: "",
    token: "",
    external: { enabled: true, maxAccounts: 3, providers: providers() },
  });
  expect(saved.config.external.enabled).toBe(true);
  expect(saved.public.configured).toBe(true);
  expect(saved.public.internalConfigured).toBe(false);
  expect(saved.public.external.providers.map((item: { id: string }) => item.id)).toEqual(["gmail", "qq"]);
});

it("lets users bind an external mailbox and marks the provider in the list", async () => {
  await saveMail({
    enabled: false,
    endpoint: "",
    domain: "",
    mode: "independent",
    maxMailboxes: 3,
    username: "",
    token: "",
    external: { enabled: true, maxAccounts: 2, providers: providers({ qq: true }) },
  });
  const bound = await request("POST", "/mail/external", aliceCookie, {
    provider: "qq",
    address: "ada.chen@qq.com",
    password: "app-password",
    displayName: "Ada QQ",
  });
  expect(bound.statusCode, bound.body).toBe(200);
  expect(bound.json()).toMatchObject({
    address: "ada.chen@qq.com",
    source: "external",
    provider: "qq",
    providerLabel: "QQ 邮箱",
    kind: "personal",
    shareable: false,
    deletable: true,
  });
  const page = await request("GET", "/mail", aliceCookie);
  expect(page.statusCode).toBe(200);
  expect(page.json().mailboxes).toHaveLength(1);
  expect(page.json().mailboxes[0]).toMatchObject({
    address: "ada.chen@qq.com",
    source: "external",
    providerLabel: "QQ 邮箱",
  });
  expect(page.json().external.providers.some((item: { id: string }) => item.id === "qq")).toBe(true);
});

it("rejects binding when the provider or the feature is closed", async () => {
  const closed = await request("POST", "/mail/external", aliceCookie, {
    provider: "qq",
    address: "ada@qq.com",
    password: "secret",
  });
  expect(closed.statusCode).toBe(400);
  await saveMail({
    enabled: false,
    endpoint: "",
    domain: "",
    mode: "free",
    maxMailboxes: 3,
    username: "",
    token: "",
    external: { enabled: true, maxAccounts: 2, providers: providers({ qq: true }) },
  });
  const blocked = await request("POST", "/mail/external", aliceCookie, {
    provider: "outlook",
    address: "ada@outlook.com",
    password: "secret",
  });
  expect(blocked.statusCode).toBe(400);
});

it("enforces the external mailbox cap and lets the owner unbind", async () => {
  await saveMail({
    enabled: false,
    endpoint: "",
    domain: "",
    mode: "free",
    maxMailboxes: 3,
    username: "",
    token: "",
    external: { enabled: true, maxAccounts: 1, providers: providers({ "163": true, qq: true }) },
  });
  const first = await request("POST", "/mail/external", aliceCookie, {
    provider: "qq",
    address: "one@qq.com",
    password: "secret",
  });
  expect(first.statusCode, first.body).toBe(200);
  const second = await request("POST", "/mail/external", aliceCookie, {
    provider: "qq",
    address: "two@qq.com",
    password: "secret",
  });
  expect(second.statusCode).toBe(400);
  const removed = await request("DELETE", `/mail/mailboxes/${first.json().id}`, aliceCookie);
  expect(removed.statusCode, removed.body).toBe(200);
  const page = await request("GET", "/mail", aliceCookie);
  expect(page.json().mailboxes).toEqual([]);
});

it("rejects password binding for Gmail and starts Google OAuth when configured", async () => {
  const saved = await saveMail({
    enabled: false,
    endpoint: "",
    domain: "",
    mode: "free",
    maxMailboxes: 3,
    username: "",
    token: "",
    external: {
      enabled: true,
      maxAccounts: 2,
      providers: providers({ gmail: true }),
      oauth: { gmail: { clientId: "google-client", clientSecret: "google-secret" } },
    },
  });
  expect(saved.config.external.oauth.gmail).toEqual({
    clientId: "google-client",
    clientSecret: null,
  });
  expect(saved.public.external.providers.find((item: { id: string }) => item.id === "gmail")).toMatchObject({
    auth: "oauth",
    oauthReady: true,
  });
  const passwordBind = await request("POST", "/mail/external", aliceCookie, {
    provider: "gmail",
    address: "ada.chen@gmail.com",
    password: "app-password",
  });
  expect(passwordBind.statusCode).toBe(400);
  const started = await request("POST", "/mail/oauth/gmail", aliceCookie, { displayName: "Ada Gmail" });
  expect(started.statusCode, started.body).toBe(200);
  const url = new URL(started.json().url);
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("client_id")).toBe("google-client");
  expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/v1/mail/oauth/gmail/callback`);
  expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});

it("binds Gmail from the OAuth callback", async () => {
  await saveMail({
    enabled: false,
    endpoint: "",
    domain: "",
    mode: "free",
    maxMailboxes: 3,
    username: "",
    token: "",
    external: {
      enabled: true,
      maxAccounts: 2,
      providers: providers({ gmail: true }),
      oauth: { gmail: { clientId: "google-client", clientSecret: "google-secret" } },
    },
  });
  mailFetch = (async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "ya29.test",
          refresh_token: "1//refresh",
          expires_in: 3600,
          id_token: fakeIdToken("ada.chen@gmail.com"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const started = await request("POST", "/mail/oauth/gmail", aliceCookie, { displayName: "Ada Gmail" });
  expect(started.statusCode, started.body).toBe(200);
  const authorize = new URL(started.json().url);
  const flowCookie = String(started.headers["set-cookie"]).split(";")[0]!;
  const callback = await app.inject({
    method: "GET",
    url: `/api/v1/mail/oauth/gmail/callback?code=test-code&state=${authorize.searchParams.get("state")}`,
    headers: { host: "localhost:39141", cookie: flowCookie },
  });
  expect(callback.statusCode, callback.body).toBe(302);
  expect(String(callback.headers.location)).toBe(`${origin}/#/mail`);
  const page = await request("GET", "/mail", aliceCookie);
  expect(page.json().mailboxes).toMatchObject([
    {
      address: "ada.chen@gmail.com",
      source: "external",
      provider: "gmail",
      providerLabel: "Gmail",
      displayName: "Ada Gmail",
    },
  ]);
});
