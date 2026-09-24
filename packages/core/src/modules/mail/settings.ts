import {
  defaultExternalMailSettings,
  parseExternalMailSettings,
  publicExternalMailSettings,
  redactMailOauthApp,
  type ExternalMailSettings,
} from "./external.js";

export const mailModes = ["independent", "free"] as const;
export type MailMode = (typeof mailModes)[number];
export const mailboxRoles = ["reader", "sender", "admin"] as const;
export type MailboxRole = (typeof mailboxRoles)[number];
export const mailboxRoleRanks = {
  none: 0,
  reader: 1,
  sender: 2,
  admin: 3,
  owner: 4,
} as const;
export type MailboxAccessRole = keyof typeof mailboxRoleRanks;

export type MailSettingsConfig = {
  enabled: boolean;
  endpoint: string;
  domain: string;
  mode: MailMode;
  maxMailboxes: number;
  username: string;
  token: string;
  external: ExternalMailSettings;
};

export const defaultMailSettings: MailSettingsConfig = {
  enabled: false,
  endpoint: "",
  domain: "",
  mode: "free",
  maxMailboxes: 3,
  username: "",
  token: "",
  external: defaultExternalMailSettings,
};

export function parseMailSettings(raw?: string | null): MailSettingsConfig {
  let parsed: Partial<MailSettingsConfig> = {};
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    parsed = {};
  }
  const mode = mailModes.includes(parsed.mode as MailMode)
    ? (parsed.mode as MailMode)
    : "free";
  const maxMailboxes = Number(parsed.maxMailboxes);
  return {
    enabled: !!parsed.enabled,
    endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint.trim() : "",
    domain: typeof parsed.domain === "string" ? parsed.domain.trim().toLowerCase() : "",
    mode,
    maxMailboxes:
      Number.isInteger(maxMailboxes) && maxMailboxes >= 1 && maxMailboxes <= 50
        ? maxMailboxes
        : 3,
    username: typeof parsed.username === "string" ? parsed.username.trim() : "",
    token: typeof parsed.token === "string" ? parsed.token.trim() : "",
    external: parseExternalMailSettings(parsed.external),
  };
}

export function singleSystemMailbox(config: MailSettingsConfig) {
  return !!(config.enabled && config.domain && (config.mode === "independent" || config.maxMailboxes <= 1));
}

export function publicMailSettings(config: MailSettingsConfig) {
  const internalConfigured = !!(config.enabled && config.domain);
  const external = publicExternalMailSettings(config.external);
  return {
    enabled: config.enabled || external.enabled,
    configured: internalConfigured || external.enabled,
    internalConfigured,
    mock: !!(config.enabled && config.domain && !config.endpoint),
    domain: config.domain,
    mode: config.mode,
    maxMailboxes: config.maxMailboxes,
    external,
  };
}

export function mailConnectionChanged(
  previous: MailSettingsConfig,
  next: MailSettingsConfig,
) {
  return (
    previous.enabled !== next.enabled ||
    previous.endpoint !== next.endpoint ||
    previous.domain !== next.domain ||
    previous.username !== next.username ||
    previous.token !== next.token
  );
}

export function adminMailSettings(config: MailSettingsConfig, revision: number) {
  return {
    revision,
    config: {
      ...config,
      token: config.token ? null : "",
      external: {
        ...config.external,
        oauth: {
          gmail: redactMailOauthApp(config.external.oauth.gmail),
          outlook: redactMailOauthApp(config.external.oauth.outlook),
        },
      },
    },
    public: publicMailSettings(config),
  };
}

export function mailboxRoleRank(role: string | null | undefined) {
  return mailboxRoleRanks[role as MailboxAccessRole] ?? 0;
}
