import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  createUser,
  tokenHash,
  resetAdminPassword,
} from "@core/modules/identity/passwords.js";
import {
  identityPolicy,
  registrationProfile,
  setContact,
  applySourceProfile,
  metadata,
} from "@core/modules/identity/accounts.js";
import { profilePolicy } from "@core/modules/identity/naming.js";
import { transact } from "@db/transactions.js";
import type { VerificationMessage } from "../apps/server/src/adapters/messaging.js";
let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  admin: string,
  user: string,
  adminId: string,
  userId: string;
const origin = "http://localhost:39131",
  password = "account-test-password",
  messages: VerificationMessage[] = [];
const cookie = (r: any, name = "doca_session") =>
  [r.headers["set-cookie"]]
    .flat()
    .map(String)
    .find((v) => v.startsWith(name + "="))
    ?.split(";")[0] ?? "";
async function req(
  method: any,
  path: string,
  session = "",
  payload?: object,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host: "localhost:39131", origin, cookie: session, ...headers },
    ...(payload ? { payload } : {}),
  });
}
async function accountPolicy(p: object) {
  const old = await identityPolicy(db);
  const change = p as any;
  const fields = { ...old.fields, ...change.fields };
  if (change.requiredEmail !== undefined)
    fields.email = { ...fields.email, required: change.requiredEmail };
  if (change.requiredPhone !== undefined)
    fields.phone = { ...fields.phone, required: change.requiredPhone };
  const r = await req("PUT", "/admin/accounts/policy", admin, {
    ...old,
    ...Object.fromEntries(
      Object.entries(p).filter(
        ([k]) => !["requiredEmail", "requiredPhone"].includes(k),
      ),
    ),
    fields,
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function proof(
  kind: "phone" | "email",
  value: string,
  purpose = "profile",
  session = "",
) {
  const start = await req("POST", "/auth/challenges", session, {
    kind,
    value,
    purpose,
  });
  expect(start.statusCode, start.body).toBe(200);
  const binding =
    cookie(start, "doca_account_flow") ||
    session.split("; ").find((c) => c.startsWith("doca_account_flow=")) ||
    "";
  const sessionCookie = [session, binding].filter(Boolean).join("; ");
  const message = messages.at(-1)!;
  const checked = await req("POST", "/auth/challenges/verify", sessionCookie, {
    challengeId: start.json().challengeId,
    code: message.code,
  });
  expect(checked.statusCode, checked.body).toBe(200);
  return {
    proof: checked.json().proof as string,
    cookie: sessionCookie,
    challengeId: start.json().challengeId,
    code: message.code,
  };
}
async function createDoc(session = user, extra: object = {}) {
  return req("POST", "/resources", session, {
    kind: "document",
    format: "markdown",
    title: "测试文档",
    ...extra,
  });
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  messages.length = 0;
  await createUser(
    db,
    { login: "admin", displayName: "管理员", password },
    { bootstrap: true },
  );
  const a = await db
    .selectFrom("users")
    .selectAll()
    .where("login", "=", "admin")
    .executeTakeFirstOrThrow();
  adminId = a.id;
  await createUser(
    db,
    { login: "alice", displayName: "Alice", password },
    { actor: a },
  );
  userId = (
    await db
      .selectFrom("users")
      .selectAll()
      .where("login", "=", "alice")
      .executeTakeFirstOrThrow()
  ).id;
  app = await createApp(db, {
    origin,
    messaging: {
      secret: "verification-test-secret",
      phoneReady: true,
      emailReady: true,
      send: async (m) => {
        messages.push(m);
      },
    },
  });
  admin = cookie(
    await req("POST", "/auth/login", "", { login: "admin", password }),
  );
  user = cookie(
    await req("POST", "/auth/login", "", { login: "alice", password }),
  );
});
afterEach(async () => {
  await app.close();
  await db.destroy();
});
it("requires meaningful usernames and verified contacts, with one-use proof bound to purpose and browser", async () => {
  await db
    .updateTable("settings")
    .set({ registration: 1 })
    .where("id", "=", "system")
    .execute();
  await accountPolicy({ requiredEmail: true });
  const a = await proof("email", "member@example.test");
  const wrong = await req("POST", "/auth/register", "", {
    login: "member",
    displayName: "Member",
    password,
    proofs: { email: a.proof },
  });
  expect(wrong.statusCode).toBe(403);
  const invalid = await req("POST", "/auth/register", a.cookie, {
    login: "sso_abcd",
    displayName: "Member",
    password,
    proofs: { email: a.proof },
  });
  expect(invalid.statusCode).toBe(400);
  const good = await req("POST", "/auth/register", a.cookie, {
    login: "member",
    displayName: "Member",
    password,
    proofs: { email: a.proof },
  });
  expect(good.statusCode, good.body).toBe(200);
  expect(
    (
      await req("POST", "/auth/register", a.cookie, {
        login: "another",
        displayName: "Another",
        password,
        proofs: { email: a.proof },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await req("POST", "/auth/login", "", {
        login: "MEMBER@EXAMPLE.TEST",
        password,
      })
    ).statusCode,
  ).toBe(200);
});
it("SMS admission is independent of password registration, approval grants no session and creates no duplicate after review", async () => {
  await accountPolicy({ smsEnabled: true, smsRegistration: "approval" });
  expect(
    (
      await db
        .selectFrom("settings")
        .select("registration")
        .executeTakeFirstOrThrow()
    ).registration,
  ).toBe(0);
  const p = await proof("phone", "+8613800138000", "login");
  const started = await req("POST", "/auth/sms", p.cookie, { proof: p.proof });
  expect(started.json().status).toBe("needs_profile");
  expect(cookie(started)).toBe("");
  const enrollment = p.cookie + "; " + cookie(started, "doca_enrollment");
  const init = await req("POST", "/auth/sms/complete", enrollment);
  expect(init.json().status).toBe("needs_profile");
  expect((await db.selectFrom("users").select("id").execute()).length).toBe(2);
  const complete = await req("POST", "/auth/sms/complete", enrollment, {
    username: "zhangsan",
    displayName: "张三",
    password,
  });
  expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json().status).toBe("pending");
  expect(cookie(complete)).toBe("");
  const pending = await db
    .selectFrom("users")
    .selectAll()
    .where("login", "=", "zhangsan")
    .executeTakeFirstOrThrow();
  expect(pending.status).toBe("pending");
  expect(
    (
      await req("POST", "/admin/registration-reviews/" + pending.id, admin, {
        decision: "approved",
      })
    ).statusCode,
  ).toBe(200);
  await accountPolicy({ smsRegistration: "closed" });
  await db.deleteFrom("verification_challenges").execute();
  const again = await proof("phone", "+8613800138000", "login");
  const signed = await req("POST", "/auth/sms", again.cookie, {
    proof: again.proof,
  });
  expect(signed.statusCode, signed.body).toBe(200);
  expect(cookie(signed)).toBeTruthy();
  expect((await db.selectFrom("users").select("id").execute()).length).toBe(3);
});
it("OTP incorrect-attempt budget persists and prevents replay; recovery revokes old sessions", async () => {
  const start = await req("POST", "/auth/challenges", "", {
    kind: "email",
    value: "wrong@example.test",
    purpose: "profile",
  });
  const binding = cookie(start, "doca_account_flow");
  for (let i = 0; i < 5; i++)
    expect(
      (
        await req("POST", "/auth/challenges/verify", binding, {
          challengeId: start.json().challengeId,
          code: "000000",
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await req("POST", "/auth/challenges/verify", binding, {
        challengeId: start.json().challengeId,
        code: messages.at(-1)!.code,
      })
    ).statusCode,
  ).toBe(400);
  await transact(db, (tx) =>
    setContact(tx, userId, "email", "alice@example.test", "test"),
  );
  const p = await proof("email", "alice@example.test", "recovery");
  const r = await req("POST", "/auth/recover", p.cookie, {
    kind: "email",
    proof: p.proof,
    password: "new-account-password",
  });
  expect(r.statusCode, r.body).toBe(200);
  expect((await req("GET", "/me", user)).statusCode).toBe(401);
  expect(
    (
      await req("POST", "/auth/login", "", {
        login: "alice@example.test",
        password: "new-account-password",
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await req("POST", "/auth/challenges/verify", p.cookie, {
        challengeId: p.challengeId,
        code: p.code,
      })
    ).statusCode,
  ).toBe(400);
});
it("allows only a local operator to reset an existing administrator password and revokes sessions", async () => {
  await expect(
    resetAdminPassword(db, "alice", "operator-reset-password"),
  ).rejects.toThrow("找不到启用中的管理员账号");
  await resetAdminPassword(db, "admin", "operator-reset-password");
  expect((await req("GET", "/me", admin)).statusCode).toBe(401);
  expect(
    (
      await req("POST", "/auth/login", "", {
        login: "admin",
        password: "operator-reset-password",
      })
    ).statusCode,
  ).toBe(200);
  const audit = await db
    .selectFrom("security_audit")
    .select(["action", "details"])
    .where("action", "=", "auth.admin_password_reset")
    .executeTakeFirstOrThrow();
  expect(audit.details).toContain("local-operator");
  expect(audit.details).not.toContain("operator-reset-password");
});
it("all required fields must have declared sources to skip registration, while locked fields reject client values", async () => {
  const manual = await registrationProfile(
    db,
    profilePolicy(),
    { displayName: "Alice" },
    {},
    undefined,
  );
  expect(manual.needsPage).toBe(true);
  const policy = profilePolicy(
    JSON.stringify({
      fields: {
        username: { source: "login", editable: false },
        displayName: { source: "name", editable: false },
      },
    }),
  );
  const global = await identityPolicy(db);
  await db
    .updateTable("account_settings")
    .set({
      config: JSON.stringify({
        ...global,
        passwordEnabled: false,
        fields: {
          ...global.fields,
          username: { ...global.fields.username, source: "provider:company" },
          displayName: {
            ...global.fields.displayName,
            required: true,
            mode: "immutable",
            source: "provider:company",
          },
        },
      }),
    })
    .where("id", "=", "identity")
    .execute();
  expect(
    (
      await registrationProfile(
        db,
        policy,
        { username: "employee", displayName: "员工" },
        {},
        undefined,
        {},
        "company",
      )
    ).needsPage,
  ).toBe(false);
  await expect(
    registrationProfile(
      db,
      policy,
      { username: "employee", displayName: "员工" },
      {},
      { username: "intruder", displayName: "员工" },
      {},
      "company",
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    registrationProfile(
      db,
      policy,
      { displayName: "员工" },
      {},
      undefined,
      {},
      "company",
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    registrationProfile(
      db,
      policy,
      { username: "alice", displayName: "员工" },
      {},
      undefined,
      {},
      "company",
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("profile locks apply on writes; admin corrections keep internal identity and resist source resync", async () => {
  const policy = profilePolicy(
    JSON.stringify({
      fields: {
        username: { source: "login", editable: false },
        displayName: { source: "name", editable: false, sync: true },
        avatar: { source: "picture", editable: false },
      },
    }),
  );
  await db
    .updateTable("users")
    .set({
      profile_metadata: JSON.stringify({
        providerId: "company",
        fields: policy.fields,
      }),
    })
    .where("id", "=", userId)
    .execute();
  await accountPolicy({
    fields: {
      ...(await identityPolicy(db)).fields,
      displayName: {
        enabled: true,
        required: false,
        mode: "immutable",
        source: "manual",
      },
      avatar: {
        enabled: true,
        required: false,
        mode: "immutable",
        source: "manual",
      },
    },
  });
  const me = (await req("GET", "/me", user)).json();
  expect(me.editable.displayName).toBe(false);
  const changed = await req("PUT", "/me/profile", user, {
    version: me.preferences.version,
    displayName: "攻击者",
    avatar: "initials",
    avatarAssetId: null,
  });
  expect(changed.statusCode, changed.body).toBe(403);
  const state = (
    await req("GET", `/admin/users/${userId}/account`, admin)
  ).json();
  const correction = await req("PUT", `/admin/users/${userId}/account`, admin, {
    revision: state.revision,
    username: "alice.corrected",
    displayName: "纠错姓名",
    reason: "姓名登记错误",
  });
  expect(correction.statusCode, correction.body).toBe(200);
  await transact(db, (tx) =>
    applySourceProfile(
      tx,
      userId,
      "company",
      policy,
      { displayName: "旧姓名" },
      {},
    ),
  );
  const u = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  expect(u.display_name).toBe("纠错姓名");
  expect(u.public_id).toBe("alice.corrected");
  expect(u.id).toBe(userId);
  expect(
    (await req("POST", "/auth/login", "", { login: "alice", password }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await req("POST", "/auth/login", "", {
        login: "alice.corrected",
        password,
      })
    ).statusCode,
  ).toBe(200);
  await expect(
    createUser(
      db,
      { login: "alice", displayName: "Other", password },
      { actor: { id: adminId, admin: 1, display_name: "Admin" } },
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("new mandatory contacts gate an existing session and allow only restricted profile completion", async () => {
  await accountPolicy({ requiredPhone: true });
  expect((await req("GET", "/bootstrap", user)).json().needsProfile).toBe(true);
  const gated = await createDoc();
  expect(gated.statusCode).toBe(403);
  expect(gated.headers["x-doca-profile-required"]).toBe("1");
  const root = await app.inject({
    method: "GET",
    url: "/",
    headers: { host: "localhost:39131", cookie: user },
  });
  expect(root.statusCode).not.toBe(403);
  expect((await req("GET", "/me", user)).statusCode).toBe(200);
  const p = await proof("phone", "+8613800138001", "profile", user);
  expect(
    (
      await req("POST", "/me/onboarding", p.cookie, {
        proofs: { phone: p.proof },
      })
    ).statusCode,
  ).toBe(200);
  expect((await createDoc()).statusCode).toBe(200);
});
it("password disabling protects last usable admin login and SMS remains available independently", async () => {
  const p = await identityPolicy(db);
  expect(
    (
      await req("PUT", "/admin/accounts/policy", admin, {
        ...p,
        passwordEnabled: false,
      })
    ).statusCode,
  ).toBe(409);
  await transact(db, (tx) =>
    setContact(tx, adminId, "phone", "+8613800138002", "test"),
  );
  await transact(db, (tx) =>
    setContact(tx, userId, "phone", "+8613800138003", "test"),
  );
  await accountPolicy({ smsEnabled: true, passwordEnabled: false });
  expect(
    (await req("POST", "/auth/login", "", { login: "admin", password }))
      .statusCode,
  ).toBe(403);
  expect(
    (await req("POST", "/auth/reauth", admin, { password })).statusCode,
  ).toBe(403);
});
it("disabling a contact field used for password login triggers the full login-method check", async () => {
  await setContact(db, adminId, "phone", "+8613800738000", "test");
  await setContact(db, userId, "phone", "+8613800738001", "test");
  await accountPolicy({ passwordIdentifiers: ["phone"] });
  const p = await identityPolicy(db);
  const r = await req("PUT", "/admin/accounts/policy", admin, {
    ...p,
    fields: { ...p.fields, phone: { ...p.fields.phone, enabled: false } },
  });
  expect(r.statusCode, r.body).toBe(409);
  expect((await identityPolicy(db)).fields.phone.enabled).toBe(true);
  await accountPolicy({ passwordIdentifiers: ["phone", "username"] });
  const q = await identityPolicy(db);
  const ok = await req("PUT", "/admin/accounts/policy", admin, {
    ...q,
    fields: { ...q.fields, phone: { ...q.fields.phone, enabled: false } },
  });
  expect(ok.statusCode, ok.body).toBe(200);
});

it("lets an administrator replace a lost password and end existing sessions", async () => {
  const next = "replacement-password";
  expect(
    (
      await req("POST", `/admin/users/${userId}/password`, user, {
        password: next,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await req("POST", `/admin/users/${userId}/password`, admin, {
        password: "short",
      })
    ).statusCode,
  ).toBe(400);
  const reset = await req("POST", `/admin/users/${userId}/password`, admin, {
    password: next,
  });
  expect(reset.statusCode, reset.body).toBe(200);
  expect((await req("GET", "/me", user)).statusCode).toBe(401);
  expect(
    (await req("POST", "/auth/login", "", { login: "alice", password }))
      .statusCode,
  ).toBe(401);
  const login = await req("POST", "/auth/login", "", {
    login: "alice",
    password: next,
  });
  expect(login.statusCode, login.body).toBe(200);
  const audit = await db
    .selectFrom("security_audit")
    .select(["action", "details"])
    .where("user_id", "=", userId)
    .where("action", "=", "password.admin_reset")
    .executeTakeFirstOrThrow();
  expect(audit.details).not.toContain(next);
});
it("admin user creation follows required profile fields and corrections can replace lost contacts without verification", async () => {
  await accountPolicy({ requiredEmail: true, requiredPhone: true });
  const missing = await req("POST", "/admin/users", admin, {
    login: "new-user",
    displayName: "New",
    password,
  });
  expect(missing.statusCode).toBe(400);
  const created = await req("POST", "/admin/users", admin, {
    login: "new-user",
    displayName: "New",
    password,
    email: "new@example.com",
    phone: "+8613800138000",
  });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id;
  let profile = (await req("GET", `/admin/users/${id}/account`, admin)).json();
  expect(profile.username).toBe("new-user");
  const corrected = await req("PUT", `/admin/users/${id}/account`, admin, {
    revision: profile.revision,
    username: "new-account",
    email: "replacement@example.com",
    phone: "+8613900139000",
    admin: true,
    reason: "Lost original phone",
  });
  expect(corrected.statusCode, corrected.body).toBe(200);
  const oldLogin = await req("POST", "/auth/login", "", {
    login: "+8613800138000",
    password,
  });
  expect(oldLogin.statusCode).toBe(401);
  const newLogin = await req("POST", "/auth/login", "", {
    login: "+8613900139000",
    password,
  });
  expect(newLogin.statusCode, newLogin.body).toBe(200);
  expect(newLogin.json().user.admin).toBe(true);
  const list = (await req("GET", "/admin/users", admin)).json().items;
  const row = list.find((u: any) => u.id === id);
  expect(row.login).toBe("new-account");
  expect(row.public_id).toBe(row.login);
  expect(row).not.toHaveProperty("baseLevel");
  expect(row.loginMethodDetails).toContainEqual({ kind: "password" });
  expect(Date.parse(row.last_login_at)).toBeGreaterThan(0);
  profile = (await req("GET", `/admin/users/${id}/account`, admin)).json();
  const cleared = await req("PUT", `/admin/users/${id}/account`, admin, {
    revision: profile.revision,
    phone: "",
    reason: "Clear required contact",
  });
  expect(cleared.statusCode).toBe(400);
  const duplicate = await req("PUT", `/admin/users/${userId}/account`, admin, {
    revision: 1,
    email: "replacement@example.com",
    phone: "+8613700137000",
    reason: "Duplicate",
  });
  expect(duplicate.statusCode).toBe(409);
});

it("protects the last administrator and denies non-admin corrections", async () => {
  expect(
    (
      await req("PUT", `/admin/users/${userId}/account`, user, {
        revision: 1,
        admin: true,
        reason: "self promote",
      })
    ).statusCode,
  ).toBe(403);
  const profile = (
    await req("GET", `/admin/users/${adminId}/account`, admin)
  ).json();
  const demote = await req("PUT", `/admin/users/${adminId}/account`, admin, {
    revision: profile.revision,
    admin: false,
    reason: "remove last admin",
  });
  expect(demote.statusCode, demote.body).toBe(409);
});

it("rejects meaningless admin-created usernames and malformed avatars", async () => {
  for (const extra of [
    { login: "13800138000" },
    { login: "admin" },
    { avatar: "invalid-url" },
    { login: "someone@example.com", email: "different@example.com" },
  ]) {
    const result = await req("POST", "/admin/users", admin, {
      login: "valid-account",
      displayName: "Valid",
      password,
      ...extra,
    });
    expect(result.statusCode, result.body).toBe(400);
  }
});

it("keeps document and knowledge-base defaults and reviewer visibility independent", async () => {
  const old = (await req("GET", "/admin/distribution", admin)).json();
  const update = await req("PUT", "/admin/distribution", admin, {
    ...old,
    resourcePolicies: {
      document: {
        defaultVisibility: "invited",
        grantMode: "direct",
        managerInfoVisible: false,
      },
      library: {
        defaultVisibility: "authenticated",
        grantMode: "invite",
        managerInfoVisible: true,
      },
    },
  });
  expect(update.statusCode, update.body).toBe(200);
  const doc = (await createDoc(admin)).json();
  const library = (
    await req("POST", "/resources", admin, {
      kind: "library",
      format: "markdown",
      title: "Shared library",
    })
  ).json();
  const rows = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "in", [doc.id, library.id])
    .execute();
  expect(rows.find((r) => r.id === doc.id)!.visibility).toBe("invited");
  expect(rows.find((r) => r.id === library.id)!.visibility).toBe(
    "authenticated",
  );
  for (const id of [doc.id, library.id]) {
    const r = rows.find((r) => r.id === id)!;
    expect(
      (
        await req("PUT", `/resources/${id}/members/${userId}`, admin, {
          revision: r.authz_revision,
          role: "reader",
        })
      ).statusCode,
    ).toBe(200);
  }
  const grants = await db
    .selectFrom("grants")
    .selectAll()
    .where("user_id", "=", userId)
    .execute();
  expect(grants.some((g) => g.resource_id === doc.id)).toBe(true);
  expect(grants.some((g) => g.resource_id === library.id)).toBe(false);
  const invite = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", library.id)
    .executeTakeFirst();
  expect(invite?.state).toBe("pending");
});

it("uses any configured original credential for one security-sensitive change, never the new contact", async () => {
  await setContact(db, userId, "phone", "+8613800238000", "test");
  await accountPolicy({ securityMethods: ["password", "phone"] });
  const old = await proof("phone", "+8613800238000", "security", user);
  expect(
    (
      await req("POST", "/auth/security/contact", old.cookie, {
        kind: "phone",
        proof: old.proof,
      })
    ).statusCode,
  ).toBe(200);
  const replacement = await proof(
    "email",
    "changed@example.test",
    "contact",
    old.cookie,
  );
  expect(
    (
      await req("PUT", "/me/contacts", replacement.cookie, {
        kind: "email",
        proof: replacement.proof,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await req("POST", "/auth/password", user, {
        newPassword: "some-new-password",
      })
    ).statusCode,
  ).toBe(403);
  const fake = await req("POST", "/auth/challenges", user, {
    kind: "phone",
    value: "+8613900239000",
    purpose: "security",
  });
  expect(fake.statusCode).toBe(403);
  expect(
    (await req("POST", "/auth/reauth", user, { password })).statusCode,
  ).toBe(200);
  const changed = await req("POST", "/auth/password", user, {
    newPassword: "some-new-password",
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect((await req("GET", "/me", user)).statusCode).toBe(401);
});

it("fills empty immutable contacts once and blocks disabled field writes and SSO sync", async () => {
  const fields = (await identityPolicy(db)).fields;
  await accountPolicy({
    fields: {
      ...fields,
      phone: { ...fields.phone, mode: "immutable" },
      displayName: { ...fields.displayName, enabled: false, required: false },
    },
  });
  expect(
    (await req("POST", "/auth/reauth", user, { password })).statusCode,
  ).toBe(200);
  const first = await proof("phone", "+8613800338000", "contact", user);
  const save = await req("PUT", "/me/contacts", first.cookie, {
    kind: "phone",
    proof: first.proof,
  });
  expect(save.statusCode, save.body).toBe(200);
  expect((await req("GET", "/me/account", user)).json().editable.phone).toBe(
    false,
  );
  expect(
    (await req("POST", "/auth/reauth", user, { password })).statusCode,
  ).toBe(200);
  expect(
    (
      await req("POST", "/auth/challenges", user, {
        kind: "phone",
        value: "+8613900339000",
        purpose: "contact",
      })
    ).statusCode,
  ).toBe(403);
  const me = (await req("GET", "/me", user)).json();
  expect(me.fields.displayName.enabled).toBe(false);
  const update = await req("PUT", "/me/profile", user, {
    version: me.preferences.version,
    displayName: "Forbidden",
    avatar: "initials",
    avatarAssetId: null,
  });
  expect(update.statusCode).toBe(403);
});

it("automatically registers verified phone usernames without optional fields or a password", async () => {
  // Configure an isolated fixture with an SMS-ready admin before disabling password login.
  await setContact(db, adminId, "phone", "+8613800438000", "test");
  await setContact(db, userId, "phone", "+8613800438001", "test");
  const fields = (await identityPolicy(db)).fields;
  await accountPolicy({
    passwordEnabled: false,
    smsEnabled: true,
    smsRegistration: "auto",
    fields: {
      ...fields,
      username: { ...fields.username, source: "phone" },
      displayName: { ...fields.displayName, enabled: false, required: false },
      avatar: { ...fields.avatar, enabled: false, required: false },
    },
  });
  const verification = await proof("phone", "+8613900439000", "login");
  const login = await req("POST", "/auth/sms", verification.cookie, {
    proof: verification.proof,
  });
  const enrollment = cookie(login, "doca_enrollment");
  const complete = await req(
    "POST",
    "/auth/sms/complete",
    enrollment + "; " + verification.cookie,
  );
  expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json().status).toBe("active");
  const row = await db
    .selectFrom("users")
    .selectAll()
    .where("public_id", "=", "+8613900439000")
    .executeTakeFirstOrThrow();
  expect(row.password_hash).toBe("");
  expect(row.display_name).toBe("");
  expect(
    (await req("POST", "/auth/password/setup", cookie(complete), { password }))
      .statusCode,
  ).toBe(403);
});

it("filters password identifiers without splitting a contact-based username into separate accounts", async () => {
  await setContact(db, userId, "email", "alias@example.test", "test");
  await setContact(db, userId, "phone", "+8613800538000", "test");
  await setContact(db, adminId, "email", "admin-alias@example.test", "test");
  await accountPolicy({ passwordIdentifiers: ["email"] });
  for (const value of ["alice", "+8613800538000"])
    expect(
      (await req("POST", "/auth/login", "", { login: value, password }))
        .statusCode,
    ).toBe(401);
  expect(
    (
      await req("POST", "/auth/login", "", {
        login: "ALIAS@EXAMPLE.TEST",
        password,
      })
    ).json().user.id,
  ).toBe(userId);
  await db
    .updateTable("users")
    .set({ public_id: "alias@example.test", login: "alias@example.test" })
    .where("id", "=", userId)
    .execute();
  await db
    .updateTable("login_identifiers")
    .set({ kind: "username" })
    .where("value", "=", "alias@example.test")
    .execute();
  // The row's kind is username, but the same value remains a permitted email login.
  expect(
    (
      await req("POST", "/auth/login", "", {
        login: "alias@example.test",
        password,
      })
    ).json().user.id,
  ).toBe(userId);
  await accountPolicy({ passwordIdentifiers: ["username"] });
  expect(
    (
      await req("POST", "/auth/login", "", {
        login: "alias@example.test",
        password,
      })
    ).json().user.id,
  ).toBe(userId);
  expect(
    (await req("POST", "/auth/login", "", { login: "alice", password }))
      .statusCode,
  ).toBe(401);
});

it("rejects contact-shaped manual usernames, and enforces contact uniqueness in the database", async () => {
  for (const username of [
    "someone@example.test",
    "+8613800638000",
    "13800638000",
  ])
    await expect(
      registrationProfile(db, profilePolicy(), {}, {}, { username, password }),
    ).rejects.toMatchObject({ status: 400 });
  await setContact(db, userId, "email", "UNIQUE@example.test", "test");
  await expect(
    transact(db, (tx) =>
      setContact(tx, adminId, "email", "unique@example.test", "provider:test"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const row = await db
    .selectFrom("user_contacts")
    .selectAll()
    .where("user_id", "=", userId)
    .where("kind", "=", "email")
    .executeTakeFirstOrThrow();
  await expect(
    db
      .insertInto("user_contacts")
      .values({ ...row, user_id: adminId })
      .execute(),
  ).rejects.toThrow();
  expect(
    await db
      .selectFrom("user_contacts")
      .selectAll()
      .where("user_id", "=", adminId)
      .execute(),
  ).toHaveLength(0);
});

it("email-code enrollment derives a verified username and respects admission review", async () => {
  await setContact(db, adminId, "email", "admin-code@example.test", "test");
  await setContact(db, userId, "email", "alice-code@example.test", "test");
  const fields = (await identityPolicy(db)).fields;
  await accountPolicy({
    passwordEnabled: false,
    emailEnabled: true,
    emailRegistration: "approval",
    fields: { ...fields, username: { ...fields.username, source: "email" } },
  });
  const verification = await proof("email", "new-code@example.test", "login");
  const start = await req("POST", "/auth/email", verification.cookie, {
    proof: verification.proof,
  });
  const enrollment =
    cookie(start, "doca_enrollment") + "; " + verification.cookie;
  expect((await req("POST", "/auth/sms/complete", enrollment)).statusCode).toBe(
    403,
  );
  const result = await req("POST", "/auth/email/complete", enrollment);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({
    status: "pending",
  });
  expect(cookie(result)).toBe("");
  const account = await db
    .selectFrom("users")
    .selectAll()
    .where("public_id", "=", "new-code@example.test")
    .executeTakeFirstOrThrow();
  expect(account.password_hash).toBe("");
  expect(account.status).toBe("pending");
  expect(result.json().ticketId).toBeUndefined();
  expect((await req("GET", "/tickets", "")).statusCode).toBe(401);
  const reviews = (
    await req("GET", "/admin/registration-reviews?status=pending", admin)
  ).json();
  expect(
    reviews.items.some((r: { user_id: string }) => r.user_id === account.id),
  ).toBe(true);
});

it("invalidates security proofs after policy changes or expiry and lets optional nicknames remain empty", async () => {
  expect(
    (await req("POST", "/auth/reauth", user, { password })).statusCode,
  ).toBe(200);
  await accountPolicy({ securityMethods: ["password"] });
  expect(
    (
      await req("POST", "/auth/password", user, {
        newPassword: password + "-new",
      })
    ).statusCode,
  ).toBe(403);
  await req("POST", "/auth/reauth", user, { password });
  await db
    .updateTable("account_flows")
    .set({ expires_at: "2000-01-01T00:00:00.000Z" })
    .where("kind", "=", "security-verification")
    .execute();
  expect(
    (
      await req("POST", "/auth/password", user, {
        newPassword: password + "-new",
      })
    ).statusCode,
  ).toBe(403);
  const me = (await req("GET", "/me", user)).json();
  expect(
    (
      await req("PUT", "/me/profile", user, {
        version: me.preferences.version,
        displayName: "",
        avatar: "initials",
      })
    ).statusCode,
  ).toBe(200);
  expect((await req("GET", "/me", user)).json()).toMatchObject({
    profileName: "alice",
    user: { display_name: "alice" },
  });
});

it("syncs only the globally owned enabled fields and rolls back all SSO changes on a contact conflict", async () => {
  const global = await identityPolicy(db),
    source = "provider:company";
  await db
    .updateTable("account_settings")
    .set({
      config: JSON.stringify({
        ...global,
        fields: {
          ...global.fields,
          displayName: { ...global.fields.displayName, source, mode: "sso" },
          avatar: { ...global.fields.avatar, source, enabled: false },
          email: { ...global.fields.email, source, mode: "sso" },
        },
      }),
    })
    .where("id", "=", "identity")
    .execute();
  const policy = profilePolicy(
    JSON.stringify({
      fields: {
        displayName: { source: "name", sync: false },
        avatar: { source: "picture", sync: true },
        email: { source: "email", sync: true },
      },
    }),
  );
  await transact(db, (tx) =>
    applySourceProfile(
      tx,
      userId,
      "unrelated",
      policy,
      { displayName: "Wrong" },
      {},
    ),
  );
  expect((await req("GET", "/me", user)).json().profileName).toBe("Alice");
  await transact(db, (tx) =>
    applySourceProfile(
      tx,
      userId,
      "company",
      policy,
      { displayName: "From SSO", avatar: "https://example.test/avatar.png" },
      {},
    ),
  );
  expect((await req("GET", "/me", user)).json()).toMatchObject({
    profileName: "From SSO",
  });
  expect((await req("GET", "/me", user)).json().avatarUrl).toBeUndefined();
  await setContact(db, adminId, "email", "taken@example.test", "test");
  await expect(
    transact(db, (tx) =>
      applySourceProfile(
        tx,
        userId,
        "company",
        policy,
        { displayName: "Should rollback", email: "taken@example.test" },
        { email: true },
      ),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await req("GET", "/me", user)).json().profileName).toBe("From SSO");
});
