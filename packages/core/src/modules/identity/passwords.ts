import {
  createHash,
  scrypt as derive,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { DB, User } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import {
  claimIdentifier,
  setContact,
  identityPolicy,
  securityAudit,
} from "./accounts.js";
import { validUsername } from "./naming.js";
import { entitlementConfig } from "../entitlements/service.js";
export type Actor = Pick<User, "id" | "display_name" | "admin"> &
  Partial<Pick<User, "public_id">>;
const deriveKey = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    derive(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await deriveKey(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  const actual = await deriveKey(password, salt || "0".repeat(32));
  const expected = Buffer.from(hash || "0".repeat(128), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function publicUser(user: Actor) {
  return {
    id: user.id,
    public_id: user.public_id,
    display_name: user.display_name || user.public_id || "",
    admin: !!user.admin,
  };
}
export async function createUser(
  db: DB,
  input: {
    login: string;
    displayName: string;
    password: string;
    publicId?: string;
  },
  options: {
    bootstrap?: boolean;
    registration?: boolean;
    actor?: Actor;
    verifiedContacts?: Partial<Record<"email" | "phone", string>>;
  } = {},
) {
  const login = (input.publicId ?? input.login).trim().toLowerCase(),
    name = input.displayName.trim();
  const publicId = (input.publicId ?? login).trim().toLowerCase();
  if (!/^[a-z0-9+][a-z0-9_.@+-]{2,159}$/.test(publicId))
    fail(400, "用户标识需为 3–160 位英文、数字或 ._@+-");
  if (
    !/^[a-z0-9+][a-z0-9_.@+-]{2,159}$/.test(login) ||
    name.length > 160 ||
    input.password.length < 12 ||
    input.password.length > 128
  )
    fail(400, "账号需为3–160位英文字符，密码12–128位，姓名不能为空");
  const hash = await hashPassword(input.password);
  return transact(db, async (tx) => {
    const settings = await tx
      .selectFrom("settings")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
    const policy = await identityPolicy(tx);
    if ((options.bootstrap || policy.fields.displayName.required) && !name)
      fail(400, "请填写昵称");
    if (options.registration) {
      if (!policy.passwordEnabled) fail(403, "账号密码注册已关闭");
      if (
        !validUsername(publicId) &&
        !(
          policy.fields.username.source === "phone" &&
          options.verifiedContacts?.phone === publicId
        )
      )
        fail(400, "请设置有意义的用户名，不能使用保留名称");
      const contacts = options.verifiedContacts ?? {};
      if (
        (policy.fields.email.required && !contacts.email) ||
        (policy.fields.phone.required && !contacts.phone)
      )
        fail(400, "请完成必填的手机/邮箱验证");
      if (publicId.includes("@") && contacts.email !== publicId)
        fail(400, "使用邮箱作为用户名需先验证该邮箱");
    }
    if (options.bootstrap) {
      if (
        await tx
          .selectFrom("users")
          .select("id")
          .where("admin", "=", 1)
          .executeTakeFirst()
      )
        fail(409, "管理员已初始化");
    } else if (options.registration) {
      if (!settings.registration) fail(403, "未开放注册");
    } else if (!options.actor?.admin) fail(403, "需要管理员权限");
    if (
      await tx
        .selectFrom("users")
        .select("id")
        .where("login", "=", login)
        .executeTakeFirst()
    )
      fail(409, "账号不可用");
    const user = {
      base_level: (await entitlementConfig(tx)).defaultLevel,
      public_id: publicId,
      id: randomUUID(),
      login,
      display_name: name,
      password_hash: hash,
      admin: options.bootstrap ? 1 : 0,
      status:
        options.registration && settings.registration_review
          ? "pending"
          : "active",
      created_at: new Date().toISOString(),
    };
    if (
      await tx
        .selectFrom("users")
        .select("id")
        .where("public_id", "=", publicId)
        .executeTakeFirst()
    )
      fail(409, "用户标识已被使用");
    await tx.insertInto("users").values(user).execute();
    if (user.status === "pending") await registrationReview(tx, user.id);
    await claimIdentifier(tx, user.id, publicId, "username");
    for (const kind of ["email", "phone"] as const)
      if (options.verifiedContacts?.[kind])
        await setContact(
          tx,
          user.id,
          kind,
          options.verifiedContacts[kind]!,
          "verification",
        );
    return { ...publicUser(user), status: user.status };
  });
}

/**
 * Local-operator recovery for an existing administrator. This intentionally
 * has no HTTP counterpart: access to the deployment host/database is the
 * second factor when all account-bound recovery methods are unavailable.
 */
export async function resetAdminPassword(
  db: DB,
  identifier: string,
  password: string,
) {
  const login = identifier.trim().toLowerCase();
  if (!login) fail(400, "请提供管理员账号");
  if (password.length < 12 || password.length > 128)
    fail(400, "密码需为 12–128 位");
  const hash = await hashPassword(password);
  return transact(db, async (tx) => {
    const user = await tx
      .selectFrom("users")
      .select(["id", "public_id", "status", "admin"])
      .where((eb) =>
        eb.or([eb("login", "=", login), eb("public_id", "=", login)]),
      )
      .executeTakeFirst();
    if (!user || !user.admin) fail(404, "找不到启用中的管理员账号");
    if (user.status !== "active")
      fail(403, "管理员账号当前不可用，请先处理账号状态");
    await tx
      .updateTable("users")
      .set({ password_hash: hash })
      .where("id", "=", user.id)
      .execute();
    await tx.deleteFrom("sessions").where("user_id", "=", user.id).execute();
    await securityAudit(tx, null, user.id, "auth.admin_password_reset", {
      source: "local-operator",
    });
    return { id: user.id, username: user.public_id };
  });
}
import { registrationReview } from "./registration-reviews.js";
