import { createHmac, randomBytes, timingSafeEqual as safeEqual } from "node:crypto";
import { fail } from "@core/shared/errors.js";
import {
  isMailOauthProvider,
  mailOauthConfigured,
  type ExternalMailCredentials,
  type ExternalMailSettings,
  type MailOauthApp,
  type MailOauthProviderId,
} from "@core/modules/mail/external.js";

export type MailOauthFlow = {
  state: string;
  userId: string;
  provider: MailOauthProviderId;
  verifier: string;
  displayName: string;
  exp: number;
};

const specs: Record<
  MailOauthProviderId,
  {
    authorize: string;
    token: string;
    scopes: string;
    extraAuthorize?: Record<string, string>;
  }
> = {
  gmail: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: "openid email https://mail.google.com/",
    extraAuthorize: { access_type: "offline", prompt: "consent" },
  },
  outlook: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes:
      "openid email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
  },
};

export function mailOauthRedirect(origin: string, provider: MailOauthProviderId) {
  return `${origin.replace(/\/$/, "")}/api/v1/mail/oauth/${provider}/callback`;
}

export function mailOauthApp(config: ExternalMailSettings, provider: string) {
  if (!isMailOauthProvider(provider)) return null;
  const app = config.oauth[provider];
  return mailOauthConfigured(app) ? app : null;
}

export function createMailOauthFlow(
  userId: string,
  provider: MailOauthProviderId,
  displayName = "",
): MailOauthFlow {
  return {
    state: randomBytes(32).toString("hex"),
    userId,
    provider,
    verifier: randomBytes(32).toString("base64url"),
    displayName: displayName.trim().slice(0, 160),
    exp: Date.now() + 600000,
  };
}

export function signMailOauthFlow(flow: MailOauthFlow, secret: string) {
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function readMailOauthFlow(raw: string, secret: string, provider: MailOauthProviderId) {
  const split = raw.lastIndexOf(".");
  if (split < 1) return null;
  const payload = raw.slice(0, split);
  const sig = raw.slice(split + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (sig.length !== expected.length || !safeEqual(Buffer.from(sig), Buffer.from(expected)))
    return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MailOauthFlow;
    if (
      flow.provider !== provider ||
      typeof flow.userId !== "string" ||
      typeof flow.state !== "string" ||
      typeof flow.verifier !== "string" ||
      typeof flow.exp !== "number" ||
      flow.exp < Date.now()
    )
      return null;
    return flow;
  } catch {
    return null;
  }
}

async function challenge(verifier: string) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function mailOauthAuthorizeUrl(
  provider: MailOauthProviderId,
  app: MailOauthApp,
  origin: string,
  flow: MailOauthFlow,
) {
  const spec = specs[provider];
  const url = new URL(spec.authorize);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", mailOauthRedirect(origin, provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", spec.scopes);
  url.searchParams.set("state", flow.state);
  url.searchParams.set("code_challenge", await challenge(flow.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(spec.extraAuthorize ?? {}))
    url.searchParams.set(key, value);
  return url.href;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
};

function decodeJwtEmail(idToken?: string) {
  if (!idToken) return "";
  const parts = idToken.split(".");
  if (parts.length < 2) return "";
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
      upn?: string;
    };
    const value = claims.email || claims.preferred_username || claims.upn || "";
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

async function tokenRequest(
  provider: MailOauthProviderId,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
) {
  const response = await fetchImpl(specs[provider].token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    fail(502, "邮箱授权服务返回异常");
  }
  if (!response.ok || !parsed.access_token)
    fail(400, parsed.error_description || parsed.error || "邮箱授权失败，请重试");
  return parsed;
}

export async function exchangeMailOauth(
  provider: MailOauthProviderId,
  app: MailOauthApp,
  origin: string,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
) {
  const parsed = await tokenRequest(
    provider,
    {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: mailOauthRedirect(origin, provider),
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    },
    fetchImpl,
  );
  const address = decodeJwtEmail(parsed.id_token);
  if (!address) fail(400, "授权账号没有可用的邮箱地址");
  if (!parsed.refresh_token) fail(400, "授权未返回刷新令牌，请重试并允许离线访问");
  return {
    address,
    refreshToken: parsed.refresh_token,
    accessToken: parsed.access_token,
    accessTokenExpiresAt: Date.now() + Math.max(60, Number(parsed.expires_in) || 3600) * 1000,
  };
}

export async function refreshMailOauthToken(
  provider: MailOauthProviderId,
  app: MailOauthApp,
  credentials: ExternalMailCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalMailCredentials> {
  if (credentials.auth !== "oauth" || !credentials.refreshToken)
    fail(400, "外部邮箱授权已失效，请重新绑定");
  if (
    credentials.accessToken &&
    (credentials.accessTokenExpiresAt ?? 0) > Date.now() + 120000
  )
    return credentials;
  const parsed = await tokenRequest(
    provider,
    {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      ...(provider === "outlook" ? { scope: specs.outlook.scopes } : {}),
    },
    fetchImpl,
  );
  return {
    ...credentials,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || credentials.refreshToken,
    accessTokenExpiresAt: Date.now() + Math.max(60, Number(parsed.expires_in) || 3600) * 1000,
  };
}

export function mailOauthImapAuth(credentials: ExternalMailCredentials) {
  if (credentials.auth === "oauth") {
    if (!credentials.accessToken) fail(400, "外部邮箱授权已失效，请重新绑定");
    return { user: credentials.username, accessToken: credentials.accessToken };
  }
  return { user: credentials.username, pass: credentials.password };
}

export function mailOauthSmtpAuth(credentials: ExternalMailCredentials) {
  if (credentials.auth === "oauth") {
    if (!credentials.accessToken) fail(400, "外部邮箱授权已失效，请重新绑定");
    return {
      type: "OAuth2" as const,
      user: credentials.username,
      accessToken: credentials.accessToken,
    };
  }
  return { user: credentials.username, pass: credentials.password };
}
