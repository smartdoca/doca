import type { DB } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { identityPolicy } from "./accounts.js";
import { tokenHash } from "./passwords.js";
export async function credentialFingerprint(
  db: DB,
  userId: string,
  method: string,
) {
  if (method === "password") {
    const u = await db
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", userId)
      .executeTakeFirst();
    return u?.password_hash ? tokenHash(u.password_hash) : "";
  }
  if (method === "phone" || method === "email") {
    const c = await db
      .selectFrom("user_contacts")
      .select("value")
      .where("user_id", "=", userId)
      .where("kind", "=", method)
      .executeTakeFirst();
    return c ? tokenHash(c.value) : "";
  }
  const i = await db
    .selectFrom("auth_identities")
    .select("subject")
    .where("user_id", "=", userId)
    .where("provider_id", "=", method.slice(9))
    .executeTakeFirst();
  return i ? tokenHash(i.subject) : "";
}
export async function allowSecurityMethod(db: DB, method: string) {
  const p = await identityPolicy(db);
  if (!p.securityMethods.includes(method))
    fail(403, "此方式未被管理员选为安全验证方式");
  if ((method === "phone" || method === "email") && !p.fields[method].enabled)
    fail(403, "该联系方式字段已禁用");
  if (method === "password" && !p.passwordEnabled) fail(403, "密码验证已关闭");
  if (method.startsWith("provider:")) {
    const provider = await db
      .selectFrom("auth_providers")
      .select("id")
      .where("id", "=", method.slice(9))
      .where("enabled", "=", 1)
      .executeTakeFirst();
    if (!provider) fail(403, "安全验证身份源已关闭");
  }
  return p;
}
export async function grantSecurity(
  db: DB,
  userId: string,
  sessionId: string,
  method: string,
  expected?: string,
) {
  const p = await allowSecurityMethod(db, method),
    fingerprint = await credentialFingerprint(db, userId, method);
  if (!fingerprint || (expected && fingerprint !== expected))
    fail(403, "原认证信息已变化，请重新验证");
  const row = {
    id: tokenHash("security:" + sessionId),
    kind: "security-verification",
    user_id: userId,
    data: JSON.stringify({
      method,
      fingerprint,
      revision: p.revision,
      sessionId,
    }),
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  await db
    .insertInto("account_flows")
    .values(row)
    .onConflict((oc) => oc.column("id").doUpdateSet(row))
    .execute();
}
export async function requireSecurity(
  db: DB,
  userId: string,
  sessionId: string,
  consume = false,
) {
  const id = tokenHash("security:" + sessionId);
  const proof = consume
    ? await db
        .deleteFrom("account_flows")
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst()
    : await db
        .selectFrom("account_flows")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
  if (
    !proof ||
    proof.user_id !== userId ||
    proof.expires_at <= new Date().toISOString()
  )
    fail(403, "请先完成安全验证（5 分钟内有效，每次仅用于一项修改）");
  const d = JSON.parse(proof.data),
    p = await allowSecurityMethod(db, d.method);
  const session = await db
    .selectFrom("sessions")
    .select("id")
    .where("id", "=", sessionId)
    .where("user_id", "=", userId)
    .where("expires_at", ">", new Date().toISOString())
    .executeTakeFirst();
  if (
    !session ||
    d.sessionId !== sessionId ||
    d.revision !== p.revision ||
    d.fingerprint !== (await credentialFingerprint(db, userId, d.method))
  )
    fail(403, "安全验证已失效，请重新验证");
}
