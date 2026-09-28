import type { DB } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { fieldNames, type ProfileField, profilePolicy } from "./naming.js";
export type FieldMode = "editable" | "sso" | "immutable";
export type UserFieldRule = {
  enabled: boolean;
  required: boolean;
  mode: FieldMode;
  source: string;
};
export type UserFields = Record<ProfileField, UserFieldRule>;
export function userFields(raw: any = {}): UserFields {
  const result = Object.fromEntries(
    fieldNames.map((key) => [
      key,
      {
        enabled: true,
        required: key === "username",
        mode: key === "username" ? "immutable" : "editable",
        source: "manual",
        ...raw.fields?.[key],
      },
    ]),
  ) as UserFields;
  result.username.enabled = true;
  result.username.required = true;
  result.username.mode = "immutable";
  return result;
}
export function validateUserFields(raw: any): UserFields {
  const fields = userFields(raw);
  for (const key of fieldNames) {
    const f = fields[key];
    if (
      typeof f.enabled !== "boolean" ||
      typeof f.required !== "boolean" ||
      !["editable", "sso", "immutable"].includes(f.mode) ||
      typeof f.source !== "string" ||
      !/^(manual|phone|email|provider:[a-f0-9-]{36})$/.test(f.source)
    )
      fail(400, "用户字段规则无效");
    if (!f.enabled && f.required) fail(400, "禁用字段不能设为必填");
    if (key !== "username" && ["phone", "email"].includes(f.source))
      fail(400, "仅用户名可选择手机号或邮箱作为来源");
    if (
      key === "username" &&
      raw.fields?.username &&
      (!raw.fields.username.enabled ||
        !raw.fields.username.required ||
        raw.fields.username.mode !== "immutable")
    )
      fail(400, "用户名始终必填且注册后不可修改");
  }
  if (
    ["phone", "email"].includes(fields.username.source) &&
    !fields[fields.username.source as "phone" | "email"].enabled
  )
    fail(400, "用户名依赖的联系方式必须启用");
  return fields;
}
export async function validateFieldSources(db: DB, fields: UserFields) {
  for (const key of fieldNames) {
    const f = fields[key];
    if (f.source.startsWith("provider:")) {
      const p = await db
        .selectFrom("auth_providers")
        .select("id")
        .where("id", "=", f.source.slice(9))
        .executeTakeFirst();
      if (!p) fail(400, "字段来源的 SSO 不存在");
    }
  }
}
// Provider mappings claim a field only once. The global policy serializes all claims.
export async function claimFieldSources(
  db: DB,
  providerId: string,
  raw: string,
  previousRaw?: string,
) {
  const row = await db
    .updateTable("account_settings")
    .set((eb) => ({ revision: eb("revision", "+", 0) }))
    .where("id", "=", "identity")
    .returningAll()
    .executeTakeFirstOrThrow();
  const config = JSON.parse(row.config),
    fields = userFields(config),
    mapping = profilePolicy(raw);
  const previous =
    previousRaw === undefined ? undefined : profilePolicy(previousRaw);
  let changed = false;
  for (const key of fieldNames) {
    // Saving unrelated provider settings must not reclaim a globally reassigned field.
    if (previous && previous.fields[key].source === mapping.fields[key].source)
      continue;
    const source = `provider:${providerId}`;
    if (mapping.fields[key].source) {
      if (fields[key].source !== "manual" && fields[key].source !== source)
        fail(409, `${key} 已指定其他来源，请先在用户字段中调整`);
      if (fields[key].source !== source) {
        fields[key].source = source;
        changed = true;
      }
    } else if (fields[key].source === source) {
      fields[key].source = "manual";
      changed = true;
    }
  }
  if (changed)
    await db
      .updateTable("account_settings")
      .set({
        config: JSON.stringify({ ...config, fields }),
        revision: row.revision + 1,
      })
      .where("id", "=", "identity")
      .execute();
}
