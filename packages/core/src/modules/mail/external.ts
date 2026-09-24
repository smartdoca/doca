export const mailProviderIds = [
  "gmail",
  "outlook",
  "qq",
  "163",
  "126",
  "icloud",
  "yahoo",
  "custom",
] as const;

export type MailProviderId = (typeof mailProviderIds)[number];
export const mailOauthProviderIds = ["gmail", "outlook"] as const;
export type MailOauthProviderId = (typeof mailOauthProviderIds)[number];
export type MailAuthKind = "oauth" | "password";

export type MailServerEndpoint = {
  host: string;
  port: number;
  secure: boolean;
};

export type MailProviderPreset = {
  id: MailProviderId;
  label: string;
  hint: string;
  auth: MailAuthKind;
  helpUrl?: string;
  imap: MailServerEndpoint;
  smtp: MailServerEndpoint;
};

export const mailProviderCatalog: MailProviderPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    auth: "oauth",
    hint: "通过 Google 账号授权，使用 IMAP/SMTP XOAUTH2 代收代发。不要再填登录密码或应用专用密码。",
    helpUrl: "https://developers.google.com/workspace/gmail/imap/imap-smtp",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  },
  {
    id: "outlook",
    label: "Outlook",
    auth: "oauth",
    hint: "通过 Microsoft 账号授权。Outlook.com / Microsoft 365 已停用 IMAP 基本认证，必须走 OAuth。",
    helpUrl: "https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth",
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
  },
  {
    id: "qq",
    label: "QQ 邮箱",
    auth: "password",
    hint: "在 QQ 邮箱网页设置里开启 IMAP/SMTP，并生成 16 位授权码。不要填 QQ 密码。",
    helpUrl: "https://help.mail.qq.com/detail/0/985",
    imap: { host: "imap.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true },
  },
  {
    id: "163",
    label: "网易 163",
    auth: "password",
    hint: "在网页邮箱设置里开启 IMAP/SMTP，并使用客户端授权码，不是登录密码。",
    imap: { host: "imap.163.com", port: 993, secure: true },
    smtp: { host: "smtp.163.com", port: 465, secure: true },
  },
  {
    id: "126",
    label: "网易 126",
    auth: "password",
    hint: "在网页邮箱设置里开启 IMAP/SMTP，并使用客户端授权码，不是登录密码。",
    imap: { host: "imap.126.com", port: 993, secure: true },
    smtp: { host: "smtp.126.com", port: 465, secure: true },
  },
  {
    id: "icloud",
    label: "iCloud",
    auth: "password",
    hint: "Apple 没有对第三方开放邮件 OAuth。请在 Apple 账户里开启双重认证，并生成应用专用密码。",
    helpUrl: "https://support.apple.com/102654",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
  },
  {
    id: "yahoo",
    label: "Yahoo",
    auth: "password",
    hint: "Yahoo 邮件 OAuth 需单独申请白名单。普通应用请在账户安全里生成第三方应用密码。",
    helpUrl: "https://help.yahoo.com/kb/SLN15241.html",
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
  },
  {
    id: "custom",
    label: "自定义 IMAP",
    auth: "password",
    hint: "填写任意服务商的 IMAP / SMTP 主机和端口，使用该服务商要求的密码或授权码。",
    imap: { host: "", port: 993, secure: true },
    smtp: { host: "", port: 465, secure: true },
  },
];

export type MailOauthApp = {
  clientId: string;
  clientSecret: string;
};

export type ExternalMailSettings = {
  enabled: boolean;
  maxAccounts: number;
  providers: Record<MailProviderId, boolean>;
  oauth: Record<MailOauthProviderId, MailOauthApp>;
};

export type ExternalMailCredentials = {
  provider: MailProviderId;
  address: string;
  username: string;
  password: string;
  auth: MailAuthKind;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  imap: MailServerEndpoint;
  smtp: MailServerEndpoint;
};

export type PublicMailProvider = {
  id: MailProviderId;
  label: string;
  hint: string;
  auth: MailAuthKind;
  oauthReady: boolean;
  helpUrl?: string;
};

export const defaultMailOauthApp: MailOauthApp = { clientId: "", clientSecret: "" };

export const defaultExternalMailSettings: ExternalMailSettings = {
  enabled: false,
  maxAccounts: 5,
  providers: {
    gmail: true,
    outlook: true,
    qq: true,
    "163": true,
    "126": true,
    icloud: true,
    yahoo: true,
    custom: true,
  },
  oauth: {
    gmail: { ...defaultMailOauthApp },
    outlook: { ...defaultMailOauthApp },
  },
};

export function mailProviderPreset(id: string) {
  return mailProviderCatalog.find((item) => item.id === id);
}

export function mailProviderLabel(id: string) {
  return mailProviderPreset(id)?.label || "外部邮箱";
}

export function isMailOauthProvider(id: string): id is MailOauthProviderId {
  return (mailOauthProviderIds as readonly string[]).includes(id);
}

export function mailOauthConfigured(app?: MailOauthApp | null) {
  return !!(app?.clientId.trim() && app.clientSecret.trim());
}

function parseOauthApp(raw: unknown, fallback = defaultMailOauthApp): MailOauthApp {
  const value = raw && typeof raw === "object" ? (raw as Partial<MailOauthApp>) : {};
  return {
    clientId: typeof value.clientId === "string" ? value.clientId.trim() : fallback.clientId,
    clientSecret:
      typeof value.clientSecret === "string" ? value.clientSecret : fallback.clientSecret,
  };
}

export function parseExternalMailSettings(raw: unknown): ExternalMailSettings {
  const parsed =
    raw && typeof raw === "object" ? (raw as Partial<ExternalMailSettings>) : {};
  const maxAccounts = Number(parsed.maxAccounts);
  const incoming =
    parsed.providers && typeof parsed.providers === "object"
      ? (parsed.providers as Partial<Record<MailProviderId, boolean>>)
      : {};
  const providers = { ...defaultExternalMailSettings.providers };
  for (const id of mailProviderIds)
    if (typeof incoming[id] === "boolean") providers[id] = incoming[id];
  const oauthRaw =
    parsed.oauth && typeof parsed.oauth === "object"
      ? (parsed.oauth as Partial<Record<MailOauthProviderId, MailOauthApp>>)
      : {};
  return {
    enabled: !!parsed.enabled,
    maxAccounts:
      Number.isInteger(maxAccounts) && maxAccounts >= 1 && maxAccounts <= 20
        ? maxAccounts
        : 5,
    providers,
    oauth: {
      gmail: parseOauthApp(oauthRaw.gmail),
      outlook: parseOauthApp(oauthRaw.outlook),
    },
  };
}

export function mergeExternalMailSettings(
  incoming: unknown,
  previous: ExternalMailSettings,
): ExternalMailSettings {
  const parsed = parseExternalMailSettings(incoming ?? previous);
  const raw =
    incoming && typeof incoming === "object"
      ? (incoming as { oauth?: Partial<Record<MailOauthProviderId, Partial<MailOauthApp> & { clientSecret?: string | null }>> })
      : {};
  const next = { ...parsed, oauth: { ...parsed.oauth } };
  for (const id of mailOauthProviderIds) {
    const patch = raw.oauth?.[id];
    const keep = previous.oauth[id];
    next.oauth[id] = {
      clientId:
        typeof patch?.clientId === "string" ? patch.clientId.trim() : keep.clientId,
      clientSecret:
        patch?.clientSecret === null || patch?.clientSecret === undefined
          ? keep.clientSecret
          : patch.clientSecret.trim(),
    };
  }
  return next;
}

export function redactMailOauthApp(app: MailOauthApp) {
  return {
    clientId: app.clientId,
    clientSecret: app.clientSecret ? null : "",
  };
}

export function publicExternalMailSettings(config: ExternalMailSettings) {
  const providers = mailProviderCatalog
    .filter((item) => config.providers[item.id])
    .map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.hint,
      auth: item.auth,
      oauthReady:
        item.auth === "oauth" &&
        isMailOauthProvider(item.id) &&
        mailOauthConfigured(config.oauth[item.id]),
      helpUrl: item.helpUrl,
    }));
  return {
    enabled: config.enabled && providers.length > 0,
    maxAccounts: config.maxAccounts,
    providers,
  };
}

export function isExternalMailbox(mailbox: { source?: string | null }) {
  return mailbox.source === "external";
}

export function normalizeExternalEmail(value: string) {
  return value.trim().toLowerCase();
}

export function validExternalEmail(value: string) {
  const email = normalizeExternalEmail(value);
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return (
    local.length >= 1 &&
    local.length <= 64 &&
    !/\s/.test(local) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  );
}

function parseEndpoint(
  raw: unknown,
  fallback: MailServerEndpoint,
): MailServerEndpoint {
  const value = raw && typeof raw === "object" ? (raw as Partial<MailServerEndpoint>) : {};
  const host = typeof value.host === "string" ? value.host.trim() : fallback.host;
  const port = Number(value.port);
  return {
    host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback.port,
    secure: typeof value.secure === "boolean" ? value.secure : fallback.secure,
  };
}

export function parseExternalSecret(raw: string): ExternalMailCredentials | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ExternalMailCredentials> & {
      provider?: string;
    };
    const preset = mailProviderPreset(parsed.provider || "") ?? mailProviderPreset("custom")!;
    const address =
      typeof parsed.address === "string" ? normalizeExternalEmail(parsed.address) : "";
    const username =
      typeof parsed.username === "string" && parsed.username.trim()
        ? parsed.username.trim()
        : address;
    const password = typeof parsed.password === "string" ? parsed.password : "";
    const refreshToken =
      typeof parsed.refreshToken === "string" ? parsed.refreshToken : "";
    const accessToken =
      typeof parsed.accessToken === "string" ? parsed.accessToken : "";
    const accessTokenExpiresAt = Number(parsed.accessTokenExpiresAt);
    const auth: MailAuthKind =
      parsed.auth === "oauth" || (!password && !!refreshToken) ? "oauth" : "password";
    if (!validExternalEmail(address)) return null;
    if (auth === "oauth" ? !refreshToken : !password) return null;
    return {
      provider: preset.id,
      address,
      username,
      password,
      auth,
      refreshToken: refreshToken || undefined,
      accessToken: accessToken || undefined,
      accessTokenExpiresAt:
        Number.isFinite(accessTokenExpiresAt) && accessTokenExpiresAt > 0
          ? accessTokenExpiresAt
          : undefined,
      imap: parseEndpoint(parsed.imap, preset.imap),
      smtp: parseEndpoint(parsed.smtp, preset.smtp),
    };
  } catch {
    return null;
  }
}

export function serializeExternalSecret(credentials: ExternalMailCredentials) {
  return JSON.stringify({
    provider: credentials.provider,
    address: credentials.address,
    username: credentials.username,
    password: credentials.password,
    auth: credentials.auth,
    refreshToken: credentials.refreshToken,
    accessToken: credentials.accessToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    imap: credentials.imap,
    smtp: credentials.smtp,
  });
}

export function resolveExternalCredentials(input: {
  provider: string;
  address: string;
  password: string;
  username?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
}): ExternalMailCredentials {
  const preset = mailProviderPreset(input.provider);
  if (!preset) throw new Error("不支持的邮箱服务商");
  if (preset.auth === "oauth")
    throw new Error(`${preset.label} 请使用官方账号授权，不要填写密码`);
  const address = normalizeExternalEmail(input.address);
  if (!validExternalEmail(address)) throw new Error("请填写有效的外部邮箱地址");
  const password = input.password.trim();
  if (!password) throw new Error("请填写邮箱授权码或应用专用密码");
  const imap = parseEndpoint(
    {
      host: input.imapHost ?? preset.imap.host,
      port: input.imapPort ?? preset.imap.port,
      secure: input.imapSecure ?? preset.imap.secure,
    },
    preset.imap,
  );
  const smtp = parseEndpoint(
    {
      host: input.smtpHost ?? preset.smtp.host,
      port: input.smtpPort ?? preset.smtp.port,
      secure: input.smtpSecure ?? preset.smtp.secure,
    },
    preset.smtp,
  );
  if (!imap.host || !smtp.host) throw new Error("请填写 IMAP 和 SMTP 服务器地址");
  return {
    provider: preset.id,
    address,
    username: input.username?.trim() || address,
    password,
    auth: "password",
    imap,
    smtp,
  };
}

export function resolveOauthCredentials(input: {
  provider: MailOauthProviderId;
  address: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}): ExternalMailCredentials {
  const preset = mailProviderPreset(input.provider);
  if (!preset || preset.auth !== "oauth") throw new Error("不支持的邮箱服务商");
  const address = normalizeExternalEmail(input.address);
  if (!validExternalEmail(address)) throw new Error("授权账号没有可用的邮箱地址");
  const refreshToken = input.refreshToken.trim();
  if (!refreshToken) throw new Error("授权未返回可用的刷新令牌，请重试并允许离线访问");
  return {
    provider: preset.id,
    address,
    username: address,
    password: "",
    auth: "oauth",
    refreshToken,
    accessToken: input.accessToken?.trim() || undefined,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    imap: preset.imap,
    smtp: preset.smtp,
  };
}
