import * as oidc from "openid-client";
import { claimField, profilePolicy } from "@core/modules/identity/naming.js";
import { fail } from "@core/shared/errors.js";
import type { Schema } from "@db/index.js";
import { oauthProfile } from "./oauth-profile.js";

export type Provider = Schema["auth_providers"];
export type Identity = {
  subject: string;
  name: string;
  fields?: Partial<
    Record<"username" | "displayName" | "email" | "phone" | "avatar", string>
  >;
  verified?: Partial<Record<"email" | "phone", boolean>>;
};
export interface IdentityRuntime {
  credentials: Record<string, string>;
  allowedOrigins: string[];
  fetch?: typeof fetch;
}
export const identityRuntime = (): IdentityRuntime => ({
  credentials: {},
  allowedOrigins: [],
});
const builtinOrigins = [
  "https://accounts.google.com",
  "https://oauth2.googleapis.com",
  "https://www.googleapis.com",
  "https://openidconnect.googleapis.com",
  "https://github.com",
  "https://api.github.com",
  "https://open.weixin.qq.com",
  "https://api.weixin.qq.com",
  "https://graph.qq.com",
];
export function createIdentityAdapter(runtime: IdentityRuntime) {
  function allowed(url: URL) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      ![...builtinOrigins, ...runtime.allowedOrigins].includes(url.origin)
    )
      fail(400, "认证端点必须使用 HTTPS，并加入“服务凭据”的 SSO 允许来源");
  }
  const safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    allowed(url);
    return (runtime.fetch ?? fetch)(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  };
  async function json(url: string, init?: RequestInit): Promise<any> {
    const response = await safeFetch(url, init);
    if (!response.ok) fail(502, "身份源暂时不可用");
    const text = await response.text();
    if (text.length > 1000000) fail(502, "身份源返回异常");
    return JSON.parse(text);
  }
  function secret(p: Provider) {
    const s = runtime.credentials[p.credential_ref];
    return Object.hasOwn(runtime.credentials, p.credential_ref) &&
      typeof s === "string" &&
      s
      ? s
      : fail(503, "身份源凭据未配置");
  }
  async function configuration(p: Provider) {
    const issuer =
      p.type === "google" ? "https://accounts.google.com" : p.issuer;
    allowed(new URL(issuer));
    const c = await oidc.discovery(
      new URL(issuer),
      p.client_id,
      secret(p),
      undefined,
      {
        [oidc.customFetch]: (url, options) =>
          safeFetch(url, options as RequestInit),
        execute: [oidc.enableNonRepudiationChecks],
      },
    );
    const m = c.serverMetadata();
    for (const endpoint of [
      m.authorization_endpoint,
      m.token_endpoint,
      m.jwks_uri,
      m.userinfo_endpoint,
    ])
      if (endpoint) allowed(new URL(endpoint));
    return c;
  }
  const query = (base: string, fields: Record<string, string>) =>
    base + "?" + new URLSearchParams(fields);
  return {
    validate(p: Provider) {
      if (p.type === "oauth2") {
        const c = oauthProfile(p.protocol_config);
        for (const endpoint of [
          c.authorizationEndpoint,
          c.tokenEndpoint,
          c.userinfoEndpoint,
        ])
          allowed(new URL(endpoint));
      }
      if (p.type === "oidc") {
        const u = new URL(p.issuer);
        allowed(u);
        if (u.search || u.hash) fail(400, "Issuer 不能包含参数或片段");
      }
      if (p.enabled) secret(p);
    },
    async authorization(
      p: Provider,
      redirect: string,
      state: string,
      verifier: string,
      nonce: string,
      verifyAgain = false,
    ) {
      if (p.type === "oidc" || p.type === "google") {
        return oidc.buildAuthorizationUrl(await configuration(p), {
          redirect_uri: redirect,
          ...(verifyAgain ? { prompt: "login", max_age: "0" } : {}),
          scope:
            "openid profile" +
            (profilePolicy(p.profile_config).fields.email.source
              ? " email"
              : ""),
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        }).href;
      }
      if (p.type === "oauth2") {
        const c = oauthProfile(p.protocol_config);
        allowed(new URL(c.authorizationEndpoint));
        return query(c.authorizationEndpoint, {
          client_id: p.client_id,
          redirect_uri: redirect,
          response_type: "code",
          scope: c.scopes,
          state,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        });
      }
      if (p.type === "github")
        return query("https://github.com/login/oauth/authorize", {
          client_id: p.client_id,
          redirect_uri: redirect,
          state,
          scope:
            "read:user" +
            (profilePolicy(p.profile_config).fields.email.source
              ? " user:email"
              : ""),
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        });
      if (p.type === "wechat")
        return (
          query("https://open.weixin.qq.com/connect/qrconnect", {
            appid: p.client_id,
            redirect_uri: redirect,
            response_type: "code",
            scope: "snsapi_login",
            state,
          }) + "#wechat_redirect"
        );
      if (p.type === "qq")
        return query("https://graph.qq.com/oauth2.0/authorize", {
          client_id: p.client_id,
          redirect_uri: redirect,
          response_type: "code",
          scope: "get_user_info",
          state,
        });
      return fail(400, "不支持的身份源类型");
    },
    async exchange(
      p: Provider,
      callback: URL,
      redirect: string,
      state: string,
      verifier: string,
      nonce: string,
    ): Promise<Identity> {
      if (
        callback.searchParams.getAll("state").length !== 1 ||
        callback.searchParams.get("state") !== state ||
        callback.searchParams.getAll("code").length !== 1 ||
        callback.searchParams.has("error")
      )
        fail(400, "授权取消或校验失败");
      const code = callback.searchParams.get("code")!;
      let subject: unknown, name: unknown, profile: unknown;
      if (p.type === "oidc" || p.type === "google") {
        const config = await configuration(p);
        const tokens = await oidc.authorizationCodeGrant(config, callback, {
          expectedState: state,
          expectedNonce: nonce,
          pkceCodeVerifier: verifier,
          idTokenExpected: true,
        });
        const claims = tokens.claims()!;
        const mapping = profilePolicy(p.profile_config);
        const paths = [
          ...Object.values(mapping.fields).flatMap((r) => [
            r.source,
            r.verifiedField,
          ]),
        ].filter(Boolean);
        const info =
          config.serverMetadata().userinfo_endpoint &&
          paths.some((path) => claimField(claims, path) === undefined)
            ? await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
            : {};
        profile = { ...claims, ...info };
        subject = claims.sub;
        name =
          claimField(profile, "name") ??
          claimField(profile, "preferred_username");
      } else if (p.type === "oauth2") {
        const c = oauthProfile(p.protocol_config);
        const token = await json(c.tokenEndpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: p.client_id,
            client_secret: secret(p),
            code,
            redirect_uri: redirect,
            code_verifier: verifier,
          }),
        });
        if (
          typeof token.access_token !== "string" ||
          (token.token_type &&
            String(token.token_type).toLowerCase() !== "bearer")
        )
          fail(400, "授权凭据无效");
        profile = await json(c.userinfoEndpoint, {
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            Accept: "application/json",
          },
        });
        subject = claimField(profile, c.subjectField);
        if (typeof subject === "number" && Number.isSafeInteger(subject))
          subject = String(subject);
        name = claimField(profile, c.nameField);
      } else if (p.type === "github") {
        const token = await json(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: p.client_id,
              client_secret: secret(p),
              code,
              redirect_uri: redirect,
              code_verifier: verifier,
            }),
          },
        );
        if (typeof token.access_token !== "string") fail(400, "授权凭据无效");
        const u = await json("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Doca",
          },
        });
        subject =
          typeof u.id === "number" && Number.isSafeInteger(u.id)
            ? String(u.id)
            : undefined;
        if (profilePolicy(p.profile_config).fields.email.source) {
          const emails = await json("https://api.github.com/user/emails", {
            headers: {
              Authorization: `Bearer ${token.access_token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Doca",
            },
          });
          if (!Array.isArray(emails)) fail(502, "身份源返回的邮箱列表无效");
          const primary = emails.find(
            (e) => e.primary === true && typeof e.email === "string",
          );
          u.email = primary?.email ?? u.email;
          u.email_verified = primary?.verified === true;
        }
        profile = u;
        name = u.name || u.login;
      } else if (p.type === "wechat") {
        const token = await json(
          query("https://api.weixin.qq.com/sns/oauth2/access_token", {
            appid: p.client_id,
            secret: secret(p),
            code,
            grant_type: "authorization_code",
          }),
        );
        if (
          typeof token.access_token !== "string" ||
          typeof token.openid !== "string"
        )
          fail(400, "微信授权凭据无效");
        const u = await json(
          query("https://api.weixin.qq.com/sns/userinfo", {
            access_token: token.access_token,
            openid: token.openid,
            lang: "zh_CN",
          }),
        );
        if (u.openid !== token.openid || u.errcode)
          fail(400, "微信身份校验失败");
        subject = token.openid;
        profile = u;
        name = u.nickname;
      } else if (p.type === "qq") {
        const token = await json(
          query("https://graph.qq.com/oauth2.0/token", {
            client_id: p.client_id,
            client_secret: secret(p),
            code,
            grant_type: "authorization_code",
            redirect_uri: redirect,
            fmt: "json",
          }),
        );
        if (typeof token.access_token !== "string")
          fail(400, "QQ 授权凭据无效");
        const who = await json(
          query("https://graph.qq.com/oauth2.0/me", {
            access_token: token.access_token,
            fmt: "json",
          }),
        );
        if (
          String(who.client_id) !== p.client_id ||
          typeof who.openid !== "string"
        )
          fail(400, "QQ 身份校验失败");
        const u = await json(
          query("https://graph.qq.com/user/get_user_info", {
            access_token: token.access_token,
            oauth_consumer_key: p.client_id,
            openid: who.openid,
          }),
        );
        if (u.ret !== 0) fail(400, "QQ 用户资料获取失败");
        subject = who.openid;
        profile = u;
        name = u.nickname;
      }
      if (typeof subject !== "string" || !subject || subject.length > 512)
        fail(400, "身份源缺少有效用户标识");
      const mapping = profilePolicy(p.profile_config);
      const fields: NonNullable<Identity["fields"]> = {};
      for (const [key, rule] of Object.entries(mapping.fields)) {
        const value = rule.source
          ? claimField(profile, rule.source)
          : undefined;
        if (typeof value === "string" && value.length <= 2048)
          fields[key as keyof typeof fields] = value;
      }
      const verified: NonNullable<Identity["verified"]> = {};
      for (const key of ["email", "phone"] as const) {
        const path = mapping.fields[key].verifiedField;
        verified[key] = !!path && claimField(profile, path) === true;
      }
      if (
        p.type === "google" &&
        verified.email &&
        !(
          fields.email?.endsWith("@gmail.com") ||
          typeof claimField(profile, "hd") === "string"
        )
      )
        verified.email = false;
      return {
        subject,
        fields,
        verified,
        name:
          typeof name === "string" && name.trim()
            ? name.trim().slice(0, 160)
            : p.name + "用户",
      };
    },
  };
}
