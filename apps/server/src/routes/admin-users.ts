import { randomBytes } from "node:crypto";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  createUser,
  hashPassword,
  type Actor,
} from "@core/modules/identity/passwords.js";
import {
  identityPolicy,
  normalizeContact,
  passwordAllowed,
  securityAudit,
} from "@core/modules/identity/accounts.js";
import { fail } from "@core/shared/errors.js";
import {
  normalizeUsername,
  validUsername,
  validManualUsername,
} from "@core/modules/identity/naming.js";

export async function adminUserDetails<T extends { id: string }>(
  db: DB,
  users: T[],
) {
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const [rows, identities, contacts] = await Promise.all([
    db.selectFrom("users").selectAll().where("id", "in", ids).execute(),
    db
      .selectFrom("auth_identities as i")
      .innerJoin("auth_providers as p", "p.id", "i.provider_id")
      .select(["i.user_id", "p.name"])
      .where("i.user_id", "in", ids)
      .execute(),
    db
      .selectFrom("user_contacts")
      .select(["user_id", "kind", "value"])
      .where("user_id", "in", ids)
      .execute(),
  ]);
  return users.map((user) => {
    const row = rows.find((u) => u.id === user.id)!;
    const supplied = user as T & {
      display_name?: string | null;
      public_id?: string | null;
      login?: string | null;
    };
    return {
      ...user,
      last_login_at: row.last_login_at ?? null,
      display_name:
        supplied.display_name ||
        supplied.public_id ||
        supplied.login ||
        row.display_name ||
        row.public_id ||
        row.login,
      loginMethodDetails: [
        ...(row.password_hash ? [{ kind: "password" }] : []),
        ...contacts
          .filter((c) => c.user_id === user.id)
          .map((c) => ({ kind: c.kind })),
        ...identities
          .filter((i) => i.user_id === user.id)
          .map((i) => ({ kind: "provider", name: i.name })),
      ],
      loginMethods: [
        ...(row.password_hash ? ["账号密码"] : []),
        ...contacts
          .filter((c) => c.user_id === user.id && c.kind === "phone")
          .map(() => "手机验证码"),
        ...contacts
          .filter((c) => c.user_id === user.id && c.kind === "email")
          .map(() => "邮箱验证码"),
        ...identities.filter((i) => i.user_id === user.id).map((i) => i.name),
      ],
      contacts: contacts
        .filter((c) => c.user_id === user.id)
        .map(({ kind, value }) => ({ kind, value })),
    };
  });
}

export async function createAdminUser(
  db: DB,
  actor: Actor,
  input: {
    login: string;
    password?: string;
    displayName: string;
    email?: string;
    phone?: string;
    avatar?: string;
  },
) {
  return transact(db, async (tx) => {
    input.login = normalizeUsername(input.login);
    const policy = await identityPolicy(tx);
    const email = input.email?.trim()
      ? normalizeContact("email", input.email)
      : "";
    const phone = input.phone?.trim()
      ? normalizeContact("phone", input.phone)
      : "";
    const source = policy.fields.username.source;
    if (
      (source === "manual" && !validManualUsername(input.login)) ||
      (source === "phone"
        ? input.login !== phone || !phone
        : source === "email"
          ? input.login !== email || !email
          : !validUsername(input.login))
    )
      fail(
        400,
        "用户名格式无效；手填账号不能使用手机号或邮箱，联系方式来源需与对应号码一致",
      );
    if (
      (policy.fields.email.required && !email) ||
      (policy.fields.phone.required && !phone)
    )
      fail(400, "请填写注册策略要求的手机号或邮箱");
    if (!policy.passwordEnabled && input.password)
      fail(403, "密码登录已关闭，不能设置密码");
    if (policy.fields.avatar.required && !input.avatar)
      fail(400, "请填写头像地址");
    if (policy.passwordEnabled && !input.password) fail(400, "请设置初始密码");
    if (input.login.includes("@") && input.login !== email)
      fail(400, "使用邮箱作为用户名时，请填写相同的邮箱");
    if (input.avatar) {
      let u: URL;
      try {
        u = new URL(input.avatar);
      } catch {
        fail(400, "头像需为 HTTPS 地址");
      }
      if (u.protocol !== "https:" || u.username || u.password)
        fail(400, "头像需为 HTTPS 地址");
    }
    const u = await createUser(
      tx,
      {
        login: input.login,
        displayName: input.displayName,
        password: input.password || randomBytes(32).toString("hex"),
      },
      {
        actor,
        verifiedContacts: {
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        },
      },
    );
    if (!input.password)
      await tx
        .updateTable("users")
        .set({ password_hash: "" })
        .where("id", "=", u.id)
        .execute();
    if (input.avatar)
      await tx
        .updateTable("users")
        .set({
          profile_metadata: JSON.stringify({
            avatarUrl: input.avatar,
            overrides: { avatar: true },
          }),
        })
        .where("id", "=", u.id)
        .execute();
    await tx
      .updateTable("user_contacts")
      .set({ verification_source: `admin:${actor.id}` })
      .where("user_id", "=", u.id)
      .execute();
    await securityAudit(tx, actor.id, u.id, "user.created", {
      username: input.login,
      contacts: { email, phone },
    });
    return u;
  });
}

export async function resetUserPassword(
  db: DB,
  actor: Actor,
  userId: string,
  password: string,
) {
  if (!actor.admin) fail(403, "需要管理员权限");
  if (password.length < 12 || password.length > 128)
    fail(400, "密码需为 12–128 位");
  const hash = await hashPassword(password);
  return transact(db, async (tx) => {
    await passwordAllowed(tx);
    const user =
      (await tx
        .selectFrom("users")
        .select(["id", "public_id"])
        .where("id", "=", userId)
        .executeTakeFirst()) ?? fail(404, "用户不存在");
    await tx
      .updateTable("users")
      .set({ password_hash: hash })
      .where("id", "=", user.id)
      .execute();
    await tx.deleteFrom("sessions").where("user_id", "=", user.id).execute();
    await securityAudit(tx, actor.id, user.id, "password.admin_reset", {
      username: user.public_id,
    });
    return { ok: true };
  });
}
