import { emitIntegrationEvent } from "../automation/events.js";
import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import {
  fieldNames,
  normalizeUsername,
  validUsername,
  validManualUsername,
  profilePolicy,
  type ProfileField,
  type ProfilePolicy,
} from "./naming.js";
import { userFields, validateUserFields } from "./field-policy.js";
export const identityDefaults = {
  fields: userFields(),
  passwordIdentifiers: ["username", "phone", "email"] as string[],
  securityMethods: ["password", "phone", "email"] as string[],
  forcedLoginMethod: null as string | null,
  emailEnabled: false,
  emailRegistration: "closed" as "closed" | "auto" | "approval",
  smsRegistration: "closed" as "closed" | "auto" | "approval",
  passwordEnabled: true,
  smsEnabled: false,
  recoveryEnabled: true,
  qrLoginEnabled: false,
};
export type IdentityPolicy = typeof identityDefaults;
export async function identityPolicy(db: DB) {
  const row = await db
    .selectFrom("account_settings")
    .selectAll()
    .where("id", "=", "identity")
    .executeTakeFirstOrThrow();
  return {
    ...identityDefaults,
    ...JSON.parse(row.config),
    fields: userFields(JSON.parse(row.config)),
    revision: row.revision,
  } as IdentityPolicy & { revision: number };
}
export function parseIdentityPolicy(input: any): IdentityPolicy {
  const p = { ...identityDefaults, fields: validateUserFields(input) };
  p.passwordIdentifiers =
    input.passwordIdentifiers ?? identityDefaults.passwordIdentifiers;
  if (
    !Array.isArray(p.passwordIdentifiers) ||
    !p.passwordIdentifiers.length ||
    p.passwordIdentifiers.some(
      (v) => !["username", "phone", "email"].includes(v),
    )
  )
    fail(400, "请选择密码登录允许使用的账号类型");
  p.passwordIdentifiers = [...new Set(p.passwordIdentifiers)];
  p.securityMethods = input.securityMethods ?? identityDefaults.securityMethods;
  if (
    !Array.isArray(p.securityMethods) ||
    !p.securityMethods.length ||
    p.securityMethods.length > 100 ||
    p.securityMethods.some(
      (v) =>
        typeof v !== "string" ||
        !/^(password|phone|email|provider:[a-f0-9-]{36})$/.test(v),
    )
  )
    fail(400, "请选择至少一种安全验证方式");
  p.securityMethods = [...new Set(p.securityMethods)];
  p.forcedLoginMethod = input.forcedLoginMethod ?? null;
  if (
    p.forcedLoginMethod !== null &&
    (typeof p.forcedLoginMethod !== "string" ||
      !/^(password|phone|email|provider:[a-f0-9-]{36})$/.test(
        p.forcedLoginMethod,
      ))
  )
    fail(400, "强制补充的登录方式无效");
  p.emailEnabled = input.emailEnabled ?? false;
  p.emailRegistration = input.emailRegistration ?? "closed";
  if (input.qrLoginEnabled !== undefined && typeof input.qrLoginEnabled !== "boolean")
    fail(400, "账号策略无效");
  p.qrLoginEnabled = input.qrLoginEnabled ?? false;
  if (
    typeof p.emailEnabled !== "boolean" ||
    !["closed", "auto", "approval"].includes(p.emailRegistration)
  )
    fail(400, "邮箱登录策略无效");
  for (const key of [
    "passwordEnabled",
    "smsEnabled",
    "recoveryEnabled",
  ] as const) {
    if (typeof input[key] !== "boolean") fail(400, "账号策略无效");
    p[key] = input[key];
  }
  if (
    !["closed", "auto", "approval"].includes(input.smsRegistration ?? "closed")
  )
    fail(400, "短信注册策略无效");
  p.smsRegistration = input.smsRegistration ?? "closed";
  return p;
}

export type LoginMethodRuntime = {
  phoneReady: boolean;
  emailReady: boolean;
  providerReady?: (credentialRef: string) => boolean;
};

/** Return the login methods that can actually authenticate this user now. */
export async function availableLoginMethods(
  db: DB,
  userId: string,
  policy: IdentityPolicy,
  runtime: LoginMethodRuntime,
) {
  const [user, identifiers, contacts, identities] = await Promise.all([
    db
      .selectFrom("users")
      .select(["public_id", "password_hash"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("login_identifiers")
      .select(["value", "kind", "active"])
      .where("user_id", "=", userId)
      .execute(),
    db
      .selectFrom("user_contacts")
      .select(["kind", "value"])
      .where("user_id", "=", userId)
      .execute(),
    db
      .selectFrom("auth_identities as i")
      .innerJoin("auth_providers as p", "p.id", "i.provider_id")
      .select([
        "i.provider_id",
        "p.enabled",
        "p.credential_ref",
      ])
      .where("i.user_id", "=", userId)
      .execute(),
  ]);
  const methods: string[] = [];
  const contact = (kind: "phone" | "email") =>
    contacts.some((c) => c.kind === kind && !!c.value);
  if (policy.passwordEnabled && user.password_hash) {
    const passwordIdentifiers = policy.passwordIdentifiers;
    const username =
      passwordIdentifiers.includes("username") &&
      identifiers.some(
        (i) => i.active && i.value === user.public_id,
      );
    const contactIdentifier = (kind: "phone" | "email") =>
      passwordIdentifiers.includes(kind) &&
      policy.fields[kind].enabled &&
      contact(kind) &&
      identifiers.some(
        (i) =>
          i.active &&
          contacts.some((c) => c.kind === kind && c.value === i.value),
      );
    if (username || contactIdentifier("phone") || contactIdentifier("email"))
      methods.push("password");
  }
  if (policy.smsEnabled && runtime.phoneReady && contact("phone"))
    methods.push("phone");
  if (policy.emailEnabled && runtime.emailReady && contact("email"))
    methods.push("email");
  for (const identity of identities)
    if (
      identity.enabled &&
      runtime.providerReady?.(identity.credential_ref) !== false
    )
      methods.push(`provider:${identity.provider_id}`);
  return methods;
}

export async function missingForcedLoginMethod(
  db: DB,
  userId: string,
  policy: IdentityPolicy,
  runtime: LoginMethodRuntime,
) {
  return policy.forcedLoginMethod &&
    !(await availableLoginMethods(db, userId, policy, runtime)).includes(
      policy.forcedLoginMethod,
    )
    ? policy.forcedLoginMethod
    : null;
}
export async function securityAudit(
  db: DB,
  actor: string | null,
  user: string | null,
  action: string,
  details: unknown,
) {
  if (user && ["profile.completed", "profile.corrected", "contact.updated"].includes(action))
    await emitIntegrationEvent(db, "user.updated", { userId: user });
  await db
    .insertInto("security_audit")
    .values({
      id: randomUUID(),
      actor_id: actor,
      user_id: user,
      action,
      details: JSON.stringify(details),
      created_at: new Date().toISOString(),
    })
    .execute();
}
export function normalizeContact(kind: string, value: string) {
  const v = value.trim();
  if (kind === "phone") {
    const n = v.replace(/[ ()-]/g, "");
    if (!/^\+[1-9]\d{6,14}$/.test(n))
      fail(400, "手机号需包含国家/地区码，例如 +86");
    return n;
  }
  if (kind === "email") {
    if (
      v.length > 254 ||
      !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v)
    )
      fail(400, "邮箱格式无效");
    return v.toLowerCase();
  }
  fail(400, "联系方式类型无效");
}
export async function claimIdentifier(
  db: DB,
  userId: string,
  value: string,
  kind: string,
) {
  const old = await db
    .selectFrom("login_identifiers")
    .selectAll()
    .where("value", "=", value)
    .executeTakeFirst();
  if (old && old.user_id !== userId)
    fail(409, "该登录标识已被使用，请验证已有账号后绑定");
  if (old)
    await db
      .updateTable("login_identifiers")
      .set({ active: 1, kind: old.kind === "username" ? "username" : kind })
      .where("value", "=", value)
      .execute();
  else
    await db
      .insertInto("login_identifiers")
      .values({ value, user_id: userId, kind, active: 1 })
      .execute();
}
export async function passwordIdentity(db: DB, input: string) {
  const p = await identityPolicy(db);
  let value = input.trim().toLowerCase();
  if (/^\+/.test(value)) {
    try {
      value = normalizeContact("phone", value);
    } catch {
      return undefined;
    }
  }
  const entry = await db
    .selectFrom("login_identifiers")
    .selectAll()
    .where("value", "=", value)
    .where("active", "=", 1)
    .executeTakeFirst();
  if (!entry) return undefined;
  if (p.passwordIdentifiers.includes("username")) {
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", entry.user_id)
      .where("public_id", "=", value)
      .executeTakeFirst();
    if (user) return entry;
  }
  const kinds = p.passwordIdentifiers.filter(
    (k) => (k === "phone" || k === "email") && p.fields[k].enabled,
  );
  if (
    kinds.length &&
    (await db
      .selectFrom("user_contacts")
      .select("user_id")
      .where("user_id", "=", entry.user_id)
      .where("value", "=", value)
      .where("kind", "in", kinds)
      .executeTakeFirst())
  )
    return entry;
  return undefined;
}
export async function setContact(
  db: DB,
  userId: string,
  kind: "phone" | "email",
  value: string,
  source: string,
) {
  value = normalizeContact(kind, value);
  await claimIdentifier(db, userId, value, kind);
  const old = await db
    .selectFrom("user_contacts")
    .selectAll()
    .where("user_id", "=", userId)
    .where("kind", "=", kind)
    .executeTakeFirst();
  if (old && old.value !== value)
    await db
      .deleteFrom("login_identifiers")
      .where("user_id", "=", userId)
      .where("value", "=", old.value)
      .where("kind", "!=", "username")
      .execute();
  const row = {
    user_id: userId,
    kind,
    value,
    verified_at: new Date().toISOString(),
    verification_source: source,
  };
  await db
    .insertInto("user_contacts")
    .values(row)
    .onConflict((oc) => oc.columns(["user_id", "kind"]).doUpdateSet(row))
    .execute();
}
export type ProfileValues = Partial<Record<ProfileField, string>>;
export type ProfileMetadata = {
  providerId?: string;
  overrides?: Partial<Record<ProfileField, boolean>>;
  allowLinking?: boolean;
  avatarUrl?: string;
};
export const metadata = (raw?: string): ProfileMetadata =>
  JSON.parse(raw || "{}");
export async function passwordAllowed(db: DB) {
  if (!(await identityPolicy(db)).passwordEnabled)
    fail(403, "本站已关闭账号密码认证");
}
export async function profileRequirements(db: DB, userId: string) {
  const p = await identityPolicy(db),
    contacts = await db
      .selectFrom("user_contacts")
      .select("kind")
      .where("user_id", "=", userId)
      .execute();
  const has = (k: string) => contacts.some((c) => c.kind === k);
  return (
    (p.fields.email.enabled && p.fields.email.required && !has("email")) ||
    (p.fields.phone.enabled && p.fields.phone.required && !has("phone"))
  );
}
export async function registrationProfile(
  db: DB,
  policy: ProfilePolicy,
  source: ProfileValues,
  verified: Partial<Record<"email" | "phone", boolean>>,
  submitted: (ProfileValues & { password?: string }) | undefined,
  proofs: Partial<Record<"email" | "phone", string>> = {},
  providerId?: string,
) {
  const global = await identityPolicy(db),
    values: ProfileValues = {},
    fields: any[] = [];
  let needsPage = false;
  for (const key of fieldNames) {
    const rule = global.fields[key];
    if (!rule.enabled) {
      if (submitted?.[key]) fail(403, `${key} 已禁用`);
      continue;
    }
    const fromProvider =
      rule.source === `provider:${providerId}` && !!policy.fields[key].source;
    let provided = fromProvider ? source[key]?.trim() : undefined;
    // A verified login contact is always retained as the binding used to sign in.
    if (
      (key === "phone" || key === "email") &&
      !providerId &&
      verified[key] &&
      source[key]
    )
      provided = source[key];
    const editable =
      key === "username"
        ? rule.source === "manual"
        : !provided || rule.mode === "editable";
    if (key === "username" && rule.source.startsWith("provider:") && !provided)
      fail(400, "请先通过指定的用户名来源 SSO 注册；该来源必须提供用户名");
    if (key === "username" && ["phone", "email"].includes(rule.source))
      continue;
    if (
      submitted?.[key] !== undefined &&
      !editable &&
      submitted[key] !== provided
    )
      fail(403, `${key} 已由来源提供，不可修改`);
    const value =
      (editable ? (submitted?.[key] ?? provided) : provided)?.trim() ?? "";
    if (value) values[key] = value;
    if (rule.required && !value) needsPage = true;
    fields.push({
      key,
      required: rule.required,
      editable,
      value,
      verified: !!verified[key as "email" | "phone"] && value === provided,
    });
  }
  const usernameSource = global.fields.username.source;
  if (usernameSource === "phone" || usernameSource === "email") {
    values.username = values[usernameSource];
    const f = fields.find((f) => f.key === usernameSource);
    f.required = true;
    if (!values.username) needsPage = true;
    if (submitted?.username && submitted.username !== values.username)
      fail(400, "用户名必须与指定联系方式一致");
    fields.unshift({
      key: "username",
      required: true,
      editable: false,
      value: values.username ?? "",
      derivedFrom: usernameSource,
    });
  }
  if (values.displayName && values.displayName.length > 160)
    fail(400, "昵称不能超过 160 个字符");
  if (values.avatar) {
    let u: URL;
    try {
      u = new URL(values.avatar);
    } catch {
      fail(400, "头像必须为 HTTP(S) 地址");
    }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      fail(400, "头像必须为 HTTP(S) 地址");
  }
  for (const key of ["email", "phone"] as const)
    if (values[key]) {
      values[key] = normalizeContact(key, values[key]!);
      const trusted =
        verified[key] &&
        source[key] &&
        normalizeContact(key, source[key]!) === values[key];
      if (!trusted && proofs[key] !== values[key]) needsPage = true;
    }
  if (usernameSource === "phone" || usernameSource === "email")
    values.username = values[usernameSource];
  if (values.username) {
    values.username = normalizeUsername(values.username);
    const numeric =
      usernameSource === "phone" && values.username === values.phone;
    if (
      (usernameSource === "manual" && !validManualUsername(values.username)) ||
      (!numeric && !validUsername(values.username))
    )
      fail(400, "用户名格式无效，请调整或联系管理员");
    if (values.username.includes("@") && values.username !== values.email) {
      needsPage = true;
      const f = fields.find((f) => f.key === "email");
      if (!f) fail(400, "邮箱形式用户名需要启用并验证同一邮箱");
      f.required = true;
    }
    const occupied = await db
      .selectFrom("login_identifiers")
      .select("value")
      .where("value", "=", values.username)
      .executeTakeFirst();
    if (occupied) fail(409, "用户名已被使用，请验证已有账号后绑定");
  }
  if (global.passwordEnabled) {
    if (!submitted?.password) needsPage = true;
    else if (submitted.password.length < 12 || submitted.password.length > 128)
      fail(400, "密码需为 12–128 位");
    fields.push({ key: "password", required: true, editable: true, value: "" });
  } else if (submitted?.password) fail(403, "密码登录已关闭，不能设置密码");
  if (submitted && needsPage) fail(400, "请填写必填资料并完成手机/邮箱验证");
  return {
    needsPage,
    values,
    fields,
    overrides: {},
  };
}
export async function profileEditable(
  db: DB,
  userId: string,
  key: ProfileField,
) {
  if (key === "username") return false;
  const p = await identityPolicy(db);
  if (!p.fields[key].enabled) return false;
  const u = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  if (p.fields[key].mode === "editable") return true;
  if (key === "phone" || key === "email")
    return !(await db
      .selectFrom("user_contacts")
      .select("value")
      .where("user_id", "=", userId)
      .where("kind", "=", key)
      .executeTakeFirst());
  if (key === "displayName") return !u.display_name;
  const pref = await db
    .selectFrom("user_preferences")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return (
    !metadata(u.profile_metadata).avatarUrl &&
    !pref?.avatar_asset_id &&
    (!pref?.avatar || pref.avatar === "" || pref.avatar === "initials")
  );
}
export async function renameAccount(db: DB, userId: string, username: string) {
  username = normalizeUsername(username);
  const source = (await identityPolicy(db)).fields.username.source;
  if (
    source === "manual"
      ? !validManualUsername(username)
      : source !== "phone" && !validUsername(username)
  )
    fail(400, "用户名格式无效；手填账号不能使用手机号或邮箱");
  if (
    (source === "phone" || source === "email") &&
    !(await db
      .selectFrom("user_contacts")
      .select("value")
      .where("user_id", "=", userId)
      .where("kind", "=", source)
      .where("value", "=", username)
      .executeTakeFirst())
  )
    fail(400, "用户名必须与已绑定的来源联系方式一致");
  const u = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  if (
    username.includes("@") &&
    !(await db
      .selectFrom("user_contacts")
      .select("value")
      .where("user_id", "=", userId)
      .where("kind", "=", "email")
      .where("value", "=", username)
      .executeTakeFirst())
  )
    fail(400, "邮箱形式用户ID须先绑定并验证同一邮箱");
  await claimIdentifier(db, userId, username, "username");
  if (u.public_id !== username) {
    const contact = await db
      .selectFrom("user_contacts")
      .select("kind")
      .where("user_id", "=", userId)
      .where("value", "=", u.public_id ?? "")
      .executeTakeFirst();
    await db
      .updateTable("login_identifiers")
      .set(contact ? { kind: contact.kind, active: 1 } : { active: 0 })
      .where("value", "=", u.public_id ?? "")
      .where("user_id", "=", userId)
      .execute();
  }
  await db
    .updateTable("users")
    .set({ public_id: username, login: username })
    .where("id", "=", userId)
    .execute();
}
export async function applySourceProfile(
  db: DB,
  userId: string,
  providerId: string,
  policy: ProfilePolicy,
  source: ProfileValues,
  verified: Partial<Record<"email" | "phone", boolean>>,
) {
  const u = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", userId)
      .executeTakeFirstOrThrow(),
    m = metadata(u.profile_metadata);
  const global = await identityPolicy(db);
  const sync = (key: ProfileField) =>
    key !== "username" &&
    global.fields[key].enabled &&
    global.fields[key].source === `provider:${providerId}` &&
    global.fields[key].mode !== "immutable" &&
    (global.fields[key].mode === "sso" || policy.fields[key].sync);
  if (sync("avatar") && !m.overrides?.avatar && source.avatar) {
    const url = new URL(source.avatar);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
      m.avatarUrl = url.href;
  }
  m.allowLinking = policy.allowLinking;
  if (source.displayName && source.displayName.trim().length > 160)
    fail(400, "来源昵称超过长度限制");
  if (
    sync("displayName") &&
    !m.overrides?.displayName &&
    source.displayName?.trim()
  )
    await db
      .updateTable("users")
      .set({ display_name: source.displayName })
      .where("id", "=", userId)
      .execute();
  for (const key of ["email", "phone"] as const)
    if (sync(key) && !m.overrides?.[key] && source[key] && verified[key])
      await setContact(db, userId, key, source[key]!, `provider:${providerId}`);
  await db
    .updateTable("users")
    .set({
      profile_metadata: JSON.stringify(m),
      profile_revision: (u.profile_revision ?? 1) + 1,
    })
    .where("id", "=", userId)
    .execute();
}
