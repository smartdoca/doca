import { fail } from "../../shared/errors.js";
export const fieldNames = [
  "username",
  "displayName",
  "email",
  "phone",
  "avatar",
] as const;
export type ProfileField = (typeof fieldNames)[number];
export type FieldRule = {
  source: string;
  sync: boolean;
  verifiedField: string;
};
export type ProfilePolicy = {
  fields: Record<ProfileField, FieldRule>;
  signup: "inherit" | "closed" | "auto" | "approval";
  allowLinking: boolean;
  levelMapping: {
    field: string;
    sync: boolean;
    fallback: string;
    rules: Record<string, { levelId: string; identityClass: string }>;
  };
};
export const normalizeUsername = (value: string) => value.trim().toLowerCase();
export const validUsername = (value: string) =>
  (/^[a-z][a-z0-9_.@+-]{2,159}$/.test(value) ||
    (/^[0-9][a-z0-9_.+-]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(value) &&
      value.length <= 160)) &&
  !/^sso_[a-f0-9_]+$/.test(value) &&
  !/^(admin|administrator|system|support|root)$/.test(value);
export const validManualUsername = (value: string) =>
  validUsername(value) && !value.includes("@");
const validPath = (v: unknown) =>
  typeof v === "string" &&
  /^[a-zA-Z0-9_.-]{0,128}$/.test(v) &&
  !v
    .split(".")
    .some((k) => ["__proto__", "prototype", "constructor"].includes(k));
export function profilePolicy(raw?: string): ProfilePolicy {
  let input: any;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    fail(400, "身份资料配置无效");
  }
  const fields = Object.fromEntries(
    fieldNames.map((key) => {
      const r = {
        source: "",
        sync: false,
        verifiedField: "",
        ...(input.fields?.[key] ?? {}),
      };
      if (
        !validPath(r.source) ||
        !validPath(r.verifiedField) ||
        typeof r.sync !== "boolean"
      )
        fail(400, "来源字段规则无效：请检查字段路径和同步选项");
      if (key === "username") r.sync = false;
      return [
        key,
        { source: r.source, sync: r.sync, verifiedField: r.verifiedField },
      ];
    }),
  ) as Record<ProfileField, FieldRule>;
  const levelMapping = {
    field: "",
    sync: true,
    fallback: "standard",
    rules: {},
    ...input.levelMapping,
  };
  if (
    !validPath(levelMapping.field) ||
    typeof levelMapping.sync !== "boolean" ||
    typeof levelMapping.fallback !== "string" ||
    !levelMapping.rules ||
    typeof levelMapping.rules !== "object" ||
    Array.isArray(levelMapping.rules) ||
    Object.keys(levelMapping.rules).length > 100
  )
    fail(400, "等级来源映射无效");
  for (const r of Object.values(levelMapping.rules) as any[])
    if (
      !r ||
      typeof r.levelId !== "string" ||
      typeof r.identityClass !== "string" ||
      r.identityClass.length > 64
    )
      fail(400, "等级映射值无效");
  for (const k of ["allowLinking"])
    if (input[k] !== undefined && typeof input[k] !== "boolean")
      fail(400, "账号策略无效");
  if (
    !["inherit", "closed", "auto", "approval"].includes(
      input.signup ?? "inherit",
    )
  )
    fail(400, "身份源注册策略无效");
  return {
    signup: input.signup ?? "inherit",
    fields,
    allowLinking: input.allowLinking ?? true,
    levelMapping,
  };
}
export function claimField(claims: unknown, path: string): unknown {
  let value: any = claims;
  for (const key of path.split(".")) {
    if (
      !validPath(key) ||
      !value ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = value[key];
  }
  return value;
}
