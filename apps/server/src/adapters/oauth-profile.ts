import { fail } from "@core/shared/errors.js";
export type OAuthProfile = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  subjectField: string;
  nameField: string;
  scopes: string;
};
export function oauthProfile(raw?: string): OAuthProfile {
  let value: any;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    fail(400, "OAuth 配置无效");
  }
  for (const key of [
    "authorizationEndpoint",
    "tokenEndpoint",
    "userinfoEndpoint",
  ]) {
    let url: URL;
    try {
      url = new URL(value[key]);
    } catch {
      fail(400, "OAuth 端点配置无效");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(400, "OAuth 端点必须为不含凭据、参数及片段的 HTTPS 地址");
  }
  value.nameField ??= "";
  value.scopes ??= "";
  for (const key of ["subjectField", "nameField"])
    if (
      typeof value[key] !== "string" ||
      (!(key === "nameField" && value[key] === "") &&
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(value[key]))
    )
      fail(400, "OAuth 字段映射无效");
  if (
    typeof value.scopes !== "string" ||
    value.scopes.length > 500 ||
    /[\r\n]/.test(value.scopes)
  )
    fail(400, "OAuth scope 无效");
  return value;
}
