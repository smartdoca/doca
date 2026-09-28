import { claimFieldSources } from "@core/modules/identity/field-policy.js";
import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { type DB } from "@db/index.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import type { Provider } from "../apps/server/src/adapters/identity-providers.js";

const origin = "http://localhost:39130",
  password = "identity-test-password",
  issuer = "https://sso.example.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  use: "sig",
  alg: "RS256",
};
let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  admin: string,
  subject: string,
  badNonce: boolean,
  badIssuer: boolean,
  badSignature: boolean,
  badUserInfo: boolean;
const codes = new Map<string, { nonce: string; challenge: string }>();
const cookieOf = (headers: Record<string, unknown>, name: string) =>
  [headers["set-cookie"]]
    .flat()
    .map(String)
    .find((v) => v.startsWith(name + "="))
    ?.split(";")[0] ?? "";
function jwt(claims: object) {
  const parts = [{ alg: "RS256", kid: "test-key", typ: "JWT" }, claims]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
    .join(".");
  return (
    parts +
    "." +
    sign("RSA-SHA256", Buffer.from(parts), privateKey).toString("base64url")
  );
}
async function req(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  cookie = "",
  payload?: object,
) {
  return app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host: "localhost:39130", origin, cookie },
    ...(payload ? { payload } : {}),
  });
}
async function login(name = "admin") {
  const r = await req("POST", "/auth/login", "", { login: name, password });
  expect(r.statusCode, r.body).toBe(200);
  return cookieOf(r.headers, "doca_session");
}
async function policy(local = "closed", sso = "closed", social = "closed") {
  const state = (await req("GET", "/admin/auth", admin)).json();
  const r = await req("PUT", "/admin/auth/policy", admin, {
    revision: state.revision,
    local,
    sso,
    social,
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function provider(type = "oidc") {
  const r = await req("POST", "/admin/auth/providers", admin, {
    type,
    name: type,
    issuer: type === "oidc" ? issuer : "",
    client_id: type + "-app",
    credential_ref: "test",
    enabled: 1,
    version: 0,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<Provider>();
}
async function authorize(
  p: Provider,
  session = "",
  extra = "",
  intent?: "security" | "replace",
) {
  if (session && !intent) {
    const verify = await req("POST", "/auth/reauth", session, { password });
    expect(verify.statusCode, verify.body).toBe(200);
  }
  const start = await req("POST", `/auth/providers/${p.id}/start`, session, {
    intent: intent ?? (session ? "link" : "login"),
  });
  expect(start.statusCode, start.body).toBe(200);
  const flowCookie = cookieOf(start.headers, "doca_auth_flow"),
    url = new URL(start.json().url),
    state = url.searchParams.get("state")!,
    code = String(codes.size + 1);
  codes.set(code, {
    nonce: url.searchParams.get("nonce") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
  });
  const path = `/auth/providers/${p.id}/callback?code=${code}&state=${state}${extra}`;
  const callback = await req("GET", path, flowCookie);
  return { flowCookie, callback, path };
}
// Explicit first registration is part of the login fixture; no production username fallback.
async function finishRegistration(cookie: string, payload?: object) {
  let r = await req(
    "POST",
    "/auth/complete",
    cookie,
    payload ? { password, ...payload } : undefined,
  );
  if (r.json().status === "needs_profile" && !payload)
    r = await req("POST", "/auth/complete", cookie, {
      password,
      username:
        r.json().fields.find((f: any) => f.key === "username")?.value ||
        (subject === "admin" ? "alice" : subject),
      displayName:
        r.json().fields.find((f: any) => f.key === "displayName").value ||
        "测试用户",
    });
  return r;
}
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  codes.clear();
  subject = "alice-subject";
  badNonce = false;
  badIssuer = false;
  badSignature = false;
  badUserInfo = false;
  await createUser(
    db,
    { login: "admin", displayName: "管理员", password },
    { bootstrap: true },
  );
  app = await createApp(db, {
    origin,
    identity: {
      credentials: { test: "server-only-secret" },
      allowedOrigins: [issuer],
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const tokenIssuer =
          url.origin === "https://accounts.google.com" ? url.origin : issuer;
        if (url.pathname === "/.well-known/openid-configuration")
          return Response.json({
            issuer: tokenIssuer,
            authorization_endpoint: tokenIssuer + "/authorize",
            token_endpoint: tokenIssuer + "/token",
            jwks_uri: tokenIssuer + "/jwks",
            userinfo_endpoint: tokenIssuer + "/userinfo",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          });
        if (url.pathname === "/userinfo")
          return Response.json({
            sub: badUserInfo ? "different-person" : subject,
            preferred_username: "alice.enterprise",
          });
        if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
        if (url.pathname === "/token") {
          const body = new URLSearchParams(String(init?.body));
          const flow = codes.get(body.get("code")!)!;
          expect(body.get("client_secret")).toBe("server-only-secret");
          expect(
            createHash("sha256")
              .update(body.get("code_verifier")!)
              .digest("base64url"),
          ).toBe(flow.challenge);
          const iat = Math.floor(Date.now() / 1000);
          let token = jwt({
            iss: badIssuer ? "https://attacker.test" : tokenIssuer,
            aud: body.get("client_id"),
            sub: subject,
            name: "测试用户",
            email: "admin@example.test",
            email_verified: true,
            nonce: badNonce ? "wrong" : flow.nonce,
            iat,
            exp: iat + 300,
          });
          if (badSignature) {
            const parts = token.split(".");
            parts[2] = "invalid-signature";
            token = parts.join(".");
          }
          return Response.json({
            access_token: "never-persist",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: token,
          });
        }
        if (url.href === "https://github.com/login/oauth/access_token")
          return Response.json({ access_token: "github-token" });
        if (url.href === "https://api.github.com/user/emails")
          return Response.json([
            { email: "secondary@example.test", primary: false, verified: true },
            { email: "github@example.test", primary: true, verified: true },
          ]);
        if (url.href === "https://api.github.com/user")
          return Response.json({
            id: 123,
            name: "GitHub用户",
            email: "admin@example.test",
          });
        if (url.pathname === "/sns/oauth2/access_token")
          return Response.json({ access_token: "wx-token", openid: subject });
        if (url.pathname === "/sns/userinfo")
          return Response.json({ openid: subject, nickname: "微信用户" });
        if (url.pathname === "/oauth2.0/token")
          return Response.json({ access_token: "qq-token" });
        if (url.pathname === "/oauth2.0/me")
          return Response.json({ openid: subject, client_id: "qq-app" });
        if (url.pathname === "/user/get_user_info")
          return Response.json({ ret: 0, nickname: "QQ用户" });
        throw new Error(
          "Unexpected network request: " + url.origin + url.pathname,
        );
      },
    },
  });
  admin = await login();
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
});

it("separates local approval from SSO/social registration and rejects anonymous admin changes", async () => {
  expect((await req("GET", "/admin/auth")).statusCode).toBe(401);
  await policy("approval", "auto", "closed");
  const registered = await req("POST", "/auth/register", "", {
    login: "pending",
    displayName: "待审核",
    password,
  });
  expect(registered.json().status).toBe("pending");
  const attempted = await req("POST", "/auth/login", "", {
    login: "pending",
    password,
  });
  expect(attempted.statusCode).toBe(200);
  expect(attempted.json()).toEqual({status:"pending"});
  expect(attempted.cookies.map((c) => c.name)).toEqual([]);
  const list = (await req("GET", "/admin/users?status=pending", admin)).json();
  expect(list.items).toHaveLength(1);
  expect(
    (
      await req("POST", `/admin/registration-reviews/${list.items[0].id}`, admin, {
        decision: "approved",
      })
    ).statusCode,
  ).toBe(200);
  const cookie = await login("pending");
  expect((await req("GET", "/admin/auth", cookie)).statusCode).toBe(403);
});
it("never merges an SSO identity with a local account whose public ID is identical", async () => {
  await policy("closed", "auto");
  subject = "admin";
  const p = await provider();
  const flow = await authorize(p);
  const complete = await finishRegistration(flow.flowCookie);
  expect(complete.statusCode, complete.body).toBe(200);
  const me = (
    await req("GET", "/me", cookieOf(complete.headers, "doca_session"))
  ).json();
  expect(me.user.public_id).toBe("alice");
  expect(me.user.admin).toBe(false);
  expect(await db.selectFrom("users").select("id").execute()).toHaveLength(2);
});
it("completes a signed OIDC flow using a Lax flow cookie, then creates a Strict session without persisting tokens", async () => {
  await policy("closed", "auto");
  const p = await provider();
  const flow = await authorize(p);
  expect(flow.callback.headers.location).toBe(origin + "/#/auth/complete");
  const complete = await finishRegistration(flow.flowCookie);
  expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json().status).toBe("active");
  const session = cookieOf(complete.headers, "doca_session");
  expect(session).toBeTruthy();
  expect((await req("GET", "/me", session)).json().user.public_id).toBe(
    subject,
  );
  expect(String(complete.headers["set-cookie"])).toContain("SameSite=Strict");
  expect(
    (await req("GET", "/bootstrap", session)).json().user.display_name,
  ).toBe("测试用户");
  expect(await db.selectFrom("auth_flows").selectAll().execute()).toHaveLength(
    0,
  );
  const bindings = (await req("GET", "/me/identities", session)).json();
  expect(bindings.passwordEnabled).toBe(true);
  expect(bindings.items).toHaveLength(1);
  expect(JSON.stringify(bindings)).not.toContain("never-persist");
  expect((await finishRegistration(flow.flowCookie)).statusCode).toBe(400);
  expect(
    (await req("DELETE", `/me/identities/${bindings.items[0].id}`, session))
      .statusCode,
  ).toBe(403);
  expect(
    (await req("POST", "/auth/password/setup", session, { password }))
      .statusCode,
  ).toBe(403);
  expect(
    (await req("POST", "/auth/reauth", session, { password })).statusCode,
  ).toBe(200);
  expect(
    (await req("POST", "/auth/password/setup", session, { password }))
      .statusCode,
  ).toBe(409);
  expect(
    (await req("DELETE", `/me/identities/${bindings.items[0].id}`, session))
      .statusCode,
  ).toBe(200);
});
it("leaves SSO registrants pending without issuing sessions until approved", async () => {
  await policy("closed", "approval");
  const p = await provider();
  let flow = await authorize(p);
  const result = await finishRegistration(flow.flowCookie);
  expect(result.json().status).toBe("pending");
  expect(cookieOf(result.headers, "doca_session")).toBe("");
  const u = await db
    .selectFrom("users")
    .selectAll()
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  await req("POST", `/admin/registration-reviews/${u.id}`, admin, { decision: "approved" });
  await policy(); // Existing bound identities can still log in when signup closes.
  flow = await authorize(p);
  expect((await finishRegistration(flow.flowCookie)).json().status).toBe(
    "active",
  );
});
it("links several providers explicitly, does not merge by email, rejects account takeover and stale sessions", async () => {
  const p = await provider();
  let flow = await authorize(p, admin);
  expect((await finishRegistration(flow.flowCookie)).statusCode).toBe(401);
  expect(
    (await finishRegistration(flow.flowCookie + "; " + admin)).json().status,
  ).toBe("linked");
  const gh = await provider("github");
  flow = await authorize(gh, admin);
  expect(
    (await finishRegistration(flow.flowCookie + "; " + admin)).json().status,
  ).toBe("linked");
  expect((await req("GET", "/me/identities", admin)).json().items).toHaveLength(
    2,
  );
  await policy("auto", "auto", "auto");
  await req("POST", "/auth/register", "", {
    login: "bob",
    displayName: "Bob",
    password,
  });
  const bob = await login("bob");
  flow = await authorize(p, bob);
  expect(
    (await finishRegistration(flow.flowCookie + "; " + bob)).statusCode,
  ).toBe(409);
  await db
    .updateTable("account_flows")
    .set({ expires_at: "2020-01-01T00:00:00.000Z" })
    .where("kind", "=", "security-verification")
    .execute();
  expect(
    (
      await req("POST", `/auth/providers/${p.id}/start`, admin, {
        intent: "link",
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await req("POST", "/auth/reauth", admin, { password: "wrong" }))
      .statusCode,
  ).toBe(403);
  expect(
    (await req("POST", "/auth/reauth", admin, { password })).statusCode,
  ).toBe(200);
  subject = "another-subject";
  flow = await authorize(p);
  const fresh = await finishRegistration(flow.flowCookie);
  expect(fresh.json().user.id).not.toBe(
    (await req("GET", "/bootstrap", admin)).json().user.id,
  );
});
it("rejects invalid nonce/issuer, missing browser cookie, duplicate parameters and repeated callback", async () => {
  await policy("closed", "auto");
  const p = await provider();
  badNonce = true;
  let flow = await authorize(p);
  expect(flow.callback.headers.location).toContain("auth/error");
  badNonce = false;
  badIssuer = true;
  flow = await authorize(p);
  expect(flow.callback.headers.location).toContain("auth/error");
  badIssuer = false;
  flow = await authorize(p, "", "&state=duplicate");
  expect(flow.callback.headers.location).toContain("auth/error");
  flow = await authorize(p);
  expect((await req("GET", flow.path)).headers.location).toContain(
    "auth/error",
  );
  expect(
    (await req("GET", flow.path, flow.flowCookie)).headers.location,
  ).toContain("auth/error");
  badSignature = true;
  flow = await authorize(p);
  expect(flow.callback.headers.location).toContain("auth/error");
  expect(await db.selectFrom("users").select("id").execute()).toHaveLength(1);
});
it("enforces immutable provider namespaces, server credential references and flow version checks", async () => {
  const p = await provider();
  const flow = await authorize(p, admin);
  const body = {
    type: p.type,
    name: p.name,
    issuer: p.issuer,
    client_id: p.client_id,
    credential_ref: p.credential_ref,
    enabled: p.enabled,
    version: p.version,
  };
  expect(
    (
      await req("PUT", `/admin/auth/providers/${p.id}`, admin, {
        ...body,
        client_id: "evil",
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await req("POST", "/admin/auth/providers", admin, {
        ...body,
        issuer: "http://localhost:8080",
        client_id: "other",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await req("POST", "/admin/auth/providers", admin, {
        ...body,
        issuer: "https://untrusted.test",
        client_id: "other",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await req("POST", "/admin/auth/providers", admin, {
        ...body,
        client_id: "other",
        credential_ref: "constructor",
      })
    ).statusCode,
  ).toBe(503);
  expect(
    (
      await req("PUT", `/admin/auth/providers/${p.id}`, admin, {
        ...body,
        enabled: 0,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await finishRegistration(flow.flowCookie + "; " + admin)).statusCode,
  ).toBe(400);
  expect((await req("GET", "/auth/providers")).json().items).toHaveLength(0);
});
it.each(["google", "github", "wechat", "qq"])(
  "supports %s as a separate social identity and honors the social signup policy",
  async (type) => {
    const p = await provider(type);
    let flow = await authorize(p);
    expect(flow.callback.headers.location).toContain("auth/complete");
    expect((await finishRegistration(flow.flowCookie)).statusCode).toBe(403);
    await policy("closed", "closed", "auto");
    flow = await authorize(p);
    const result = await finishRegistration(flow.flowCookie);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().status).toBe("active");
  },
);

it("rejects cross-origin starts, expired flows, switched binding sessions, and disabled accounts", async () => {
  const p = await provider();
  const wrong = await app.inject({
    method: "POST",
    url: `/api/v1/auth/providers/${p.id}/start`,
    headers: {
      host: "localhost:39130",
      origin: "https://attacker.test",
      cookie: admin,
    },
    payload: { intent: "link" },
  });
  expect(wrong.statusCode).toBe(403);
  let flow = await authorize(p, admin);
  const another = await login();
  expect(
    (await finishRegistration(flow.flowCookie + "; " + another)).statusCode,
  ).toBe(403);
  await db
    .updateTable("auth_flows")
    .set({ expires_at: "2020-01-01T00:00:00.000Z" })
    .execute();
  expect(
    (await finishRegistration(flow.flowCookie + "; " + admin)).statusCode,
  ).toBe(400);
  await policy("closed", "auto");
  flow = await authorize(p);
  const logged = await finishRegistration(flow.flowCookie);
  const id = logged.json().user.id;
  await req("PATCH", `/admin/users/${id}`, admin, { status: "disabled" });
  flow = await authorize(p);
  const rejected = await finishRegistration(flow.flowCookie);
  expect(rejected.statusCode).toBe(403);
  expect(cookieOf(rejected.headers, "doca_session")).toBe("");
  const config = await req("GET", "/admin/auth", admin);
  expect(config.body).not.toContain("server-only-secret");
});

it("keeps verified first-login flows restricted until a unique username is chosen", async () => {
  await policy("closed", "auto", "auto");
  const p = await provider();
  const {
    id,
    ready: _ready,
    callbackUrl: _callback,
    ...body
  } = p as Provider & { ready: boolean; callbackUrl: string };
  expect(
    (
      await req("PUT", `/admin/auth/providers/${id}`, admin, {
        ...body,
        profile_config: JSON.stringify({
          fields: {},
        }),
      })
    ).statusCode,
  ).toBe(200);
  const flow = await authorize(p);
  const first = await req("POST", "/auth/complete", flow.flowCookie);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json()).toMatchObject({
    status: "needs_profile",
    suggestedUsername: "",
  });
  expect(cookieOf(first.headers, "doca_session")).toBe("");
  expect(await db.selectFrom("users").select("id").execute()).toHaveLength(1);
  expect(
    (
      await req("POST", "/auth/complete", flow.flowCookie, {
        username: "admin",
      })
    ).statusCode,
  ).toBe(400);
  const chosen = await req("POST", "/auth/complete", flow.flowCookie, {
    username: "My.Name",
    password,
  });
  expect(chosen.statusCode, chosen.body).toBe(200);
  expect(chosen.json().user.public_id).toBe("my.name");
  expect(
    (
      await req("POST", "/auth/complete", flow.flowCookie, {
        username: "other-name",
      })
    ).statusCode,
  ).toBe(400);
  const again = await authorize(p);
  const loggedIn = await req("POST", "/auth/complete", again.flowCookie);
  expect(loggedIn.json().user.id).toBe(chosen.json().user.id);
  expect(await db.selectFrom("users").select("id").execute()).toHaveLength(2);
});
it("keeps the selected SSO username immutable and never merges identities", async () => {
  await policy("closed", "auto", "auto");
  const p = await provider();
  const {
    id,
    ready: _ready,
    callbackUrl: _callback,
    ...body
  } = p as Provider & { ready: boolean; callbackUrl: string };
  await req("PUT", `/admin/auth/providers/${id}`, admin, {
    ...body,
    profile_config: JSON.stringify({
      fields: { username: { source: "sub" } },
    }),
  });
  let flow = await authorize(p);
  expect(
    (await req("POST", "/auth/complete", flow.flowCookie)).json()
      .suggestedUsername,
  ).toBe("alice-subject");
  expect(
    (await finishRegistration(flow.flowCookie, { username: "same-name" }))
      .statusCode,
  ).toBe(403);
  const first = await finishRegistration(flow.flowCookie, {
    username: "alice-subject",
  });
  expect(first.statusCode, first.body).toBe(200);
  subject = "another-verified-subject";
  flow = await authorize(p);
  expect(
    (
      await finishRegistration(flow.flowCookie, {
        username: "same-name",
      })
    ).statusCode,
  ).toBe(403);
  const second = await finishRegistration(flow.flowCookie, {
    username: "another-verified-subject",
  });
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json().user.id).not.toBe(first.json().user.id);
  expect(
    await db.selectFrom("auth_identities").selectAll().execute(),
  ).toHaveLength(2);
});

it("custom OAuth uses PKCE, stable subject mapping and allowlisted server endpoints", async () => {
  const { createIdentityAdapter } =
    await import("../apps/server/src/adapters/identity-providers.js");
  const seen: string[] = [];
  const adapter = createIdentityAdapter({
    credentials: { test: "server-secret" },
    allowedOrigins: [issuer],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      if (url.pathname === "/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code_verifier")).toBe("verifier");
        expect(body.get("client_secret")).toBe("server-secret");
        return Response.json({
          access_token: "private-token",
          token_type: "bearer",
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer private-token",
      );
      return Response.json({
        stable: { id: "identity-1" },
        username: "a-public-name",
        name: "A User",
      });
    },
  });
  const p: Provider = {
    id: "custom-source",
    type: "oauth2",
    name: "Custom",
    issuer: "",
    client_id: "client",
    credential_ref: "test",
    enabled: 1,
    version: 1,
    protocol_config: JSON.stringify({
      authorizationEndpoint: issuer + "/authorize",
      tokenEndpoint: issuer + "/token",
      userinfoEndpoint: issuer + "/profile",
      subjectField: "stable.id",
      nameField: "name",
      scopes: "profile",
    }),
    profile_config: JSON.stringify({
      fields: { username: { source: "username" } },
    }),
  };
  adapter.validate(p);
  const redirect = "http://localhost:39130/callback";
  const url = new URL(
    await adapter.authorization(p, redirect, "state", "verifier", "nonce"),
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const identity = await adapter.exchange(
    p,
    new URL(redirect + "?state=state&code=code"),
    redirect,
    "state",
    "verifier",
    "nonce",
  );
  expect(identity).toMatchObject({
    subject: "identity-1",
    fields: { username: "a-public-name" },
    name: "A User",
  });
  expect(seen).toEqual(["/token", "/profile"]);
  expect(() =>
    adapter.validate({
      ...p,
      protocol_config: p.protocol_config!.replaceAll(
        issuer,
        "https://not-allowed.example",
      ),
    }),
  ).toThrow();
  await expect(
    adapter.exchange(
      p,
      new URL(redirect + "?state=other&code=code"),
      redirect,
      "state",
      "verifier",
      "nonce",
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it("individual providers may require review or close signup independently of their group", async () => {
  await policy("closed", "auto", "auto");
  let p = await provider();
  await db
    .updateTable("auth_providers")
    .set({ profile_config: JSON.stringify({ signup: "approval" }) })
    .where("id", "=", p.id)
    .execute();
  let flow = await authorize(p);
  const pending = await finishRegistration(flow.flowCookie);
  expect(pending.json().status).toBe("pending");
  expect(cookieOf(pending.headers, "doca_session")).toBe("");
  const u = await db
    .selectFrom("users")
    .selectAll()
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  await req("POST", `/admin/registration-reviews/${u.id}`, admin, { decision: "approved" });
  await db
    .updateTable("auth_providers")
    .set({ profile_config: JSON.stringify({ signup: "closed" }) })
    .where("id", "=", p.id)
    .execute();
  flow = await authorize(p);
  expect((await finishRegistration(flow.flowCookie)).json().status).toBe(
    "active",
  );
  subject = "new-person";
  flow = await authorize(p);
  expect((await finishRegistration(flow.flowCookie)).statusCode).toBe(403);
  const social = await provider("github");
  const socialFlow = await authorize(social);
  expect((await finishRegistration(socialFlow.flowCookie)).json().status).toBe(
    "active",
  );
});

it("fetches missing declared OIDC fields from subject-checked UserInfo", async () => {
  await policy("closed", "auto", "auto");
  const p = await provider();
  await db
    .updateTable("auth_providers")
    .set({
      profile_config: JSON.stringify({
        fields: {
          username: { source: "preferred_username", editable: false },
          displayName: { source: "name", editable: false },
        },
      }),
    })
    .where("id", "=", p.id)
    .execute();
  const mapped = await db
    .selectFrom("auth_providers")
    .select("profile_config")
    .where("id", "=", p.id)
    .executeTakeFirstOrThrow();
  await claimFieldSources(db, p.id, mapped.profile_config!);
  const flow = await authorize(p);
  const done = await finishRegistration(flow.flowCookie);
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json().user.public_id).toBe("alice.enterprise");
  subject = "other-subject";
  badUserInfo = true;
  const wrong = await authorize(p);
  expect(wrong.callback.headers.location).toBe(origin + "/#/auth/error");
  expect(
    await db.selectFrom("auth_identities").selectAll().execute(),
  ).toHaveLength(1);
});
it("uses the verified primary GitHub email only when an email source is declared", async () => {
  await policy("closed", "auto", "auto");
  const p = await provider("github");
  await db
    .updateTable("auth_providers")
    .set({
      profile_config: JSON.stringify({
        fields: {
          username: { source: "email", editable: false },
          displayName: { source: "name", editable: false },
          email: {
            source: "email",
            verifiedField: "email_verified",
            editable: false,
          },
        },
      }),
    })
    .where("id", "=", p.id)
    .execute();
  const mapped = await db
    .selectFrom("auth_providers")
    .select("profile_config")
    .where("id", "=", p.id)
    .executeTakeFirstOrThrow();
  await claimFieldSources(db, p.id, mapped.profile_config!);
  const flow = await authorize(p);
  const done = await finishRegistration(flow.flowCookie);
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json().user.public_id).toBe("github@example.test");
  const contact = await db
    .selectFrom("user_contacts")
    .selectAll()
    .where("user_id", "=", done.json().user.id)
    .executeTakeFirstOrThrow();
  expect(contact.value).toBe("github@example.test");
});

it("verifies the original SSO binding before atomically replacing a sole login identity", async () => {
  const p = await provider("wechat");
  let flow = await authorize(p, admin);
  expect(
    (await req("POST", "/auth/complete", flow.flowCookie + "; " + admin)).json()
      .status,
  ).toBe("linked");
  const config = (await req("GET", "/admin/accounts/policy", admin)).json();
  const { phoneReady, emailReady, ...body } = config;
  const change = await req("PUT", "/admin/accounts/policy", admin, {
    ...body,
    passwordEnabled: false,
    securityMethods: [`provider:${p.id}`],
  });
  expect(change.statusCode, change.body).toBe(200);
  expect(
    (await req("POST", "/auth/reauth", admin, { password })).statusCode,
  ).toBe(403);
  expect(
    (
      await req("POST", `/auth/providers/${p.id}/start`, admin, {
        intent: "replace",
      })
    ).statusCode,
  ).toBe(403);
  subject = "wrong-wechat";
  flow = await authorize(p, admin, "", "security");
  expect(
    (await req("POST", "/auth/complete", flow.flowCookie + "; " + admin))
      .statusCode,
  ).toBe(403);
  subject = "alice-subject";
  flow = await authorize(p, admin, "", "security");
  const verified = await req(
    "POST",
    "/auth/complete",
    flow.flowCookie + "; " + admin,
  );
  expect(verified.statusCode, verified.body).toBe(200);
  expect(verified.json().status).toBe("security_verified");
  subject = "replacement-wechat";
  flow = await authorize(p, admin, "", "replace");
  const changed = await req(
    "POST",
    "/auth/complete",
    flow.flowCookie + "; " + admin,
  );
  expect(changed.statusCode, changed.body).toBe(200);
  const bindings = (await req("GET", "/me/identities", admin)).json();
  expect(bindings.items).toHaveLength(1);
  expect(
    (
      await req("POST", `/auth/providers/${p.id}/start`, admin, {
        intent: "replace",
      })
    ).statusCode,
  ).toBe(403);
  const row = await db
    .selectFrom("auth_identities")
    .selectAll()
    .where("provider_id", "=", p.id)
    .executeTakeFirstOrThrow();
  expect(row.subject).toBe("replacement-wechat");
});

it("allows only one SSO source to claim each basic field", async () => {
  const a = await provider(),
    b = await provider("github");
  const payload = (p: Provider) => ({
    type: p.type,
    name: p.name,
    issuer: p.issuer,
    client_id: p.client_id,
    credential_ref: p.credential_ref,
    enabled: p.enabled,
    version: p.version,
    profile_config: JSON.stringify({ fields: { email: { source: "email" } } }),
  });
  expect(
    (await req("PUT", `/admin/auth/providers/${a.id}`, admin, payload(a)))
      .statusCode,
  ).toBe(200);
  expect(
    (await req("PUT", `/admin/auth/providers/${b.id}`, admin, payload(b)))
      .statusCode,
  ).toBe(409);
});

it("does not reclaim reassigned field sources when editing unrelated SSO settings", async () => {
  const p = await provider();
  const payload = {
    type: p.type,
    name: p.name,
    issuer: p.issuer,
    client_id: p.client_id,
    credential_ref: p.credential_ref,
    enabled: p.enabled,
    version: p.version,
    profile_config: JSON.stringify({ fields: { email: { source: "email" } } }),
  };
  expect(
    (await req("PUT", `/admin/auth/providers/${p.id}`, admin, payload))
      .statusCode,
  ).toBe(200);
  const current = (await req("GET", "/admin/accounts/policy", admin)).json();
  expect(
    (
      await req("PUT", "/admin/accounts/policy", admin, {
        ...Object.fromEntries(
          Object.entries(current).filter(
            ([k]) => !["phoneReady", "emailReady"].includes(k),
          ),
        ),
        fields: {
          ...current.fields,
          email: { ...current.fields.email, source: "manual" },
        },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await req("PUT", `/admin/auth/providers/${p.id}`, admin, {
        ...payload,
        name: "Renamed SSO",
        version: p.version + 1,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await req("GET", "/admin/accounts/policy", admin)).json().fields.email
      .source,
  ).toBe("manual");
});
