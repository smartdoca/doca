import { Feedback } from "@web/shared/components/feedback.js";
import { useEffect, useState } from "react";
import { Globe, Mail, ShieldCheck, Users } from "lucide-react";
import { api } from "@web/shared/api.js";
import { SettingsTabs } from "@web/features/settings/settings-tabs.js";
import { defaultExternalMailSettings, mailProviderCatalog } from "@core/modules/mail/external.js";

type OauthApp = { clientId: string; clientSecret: string | null };
type ExternalConfig = {
  enabled: boolean;
  maxAccounts: number;
  providers: Record<string, boolean>;
  oauth: { gmail: OauthApp; outlook: OauthApp };
};
type Config = {
  enabled: boolean;
  endpoint: string;
  domain: string;
  mode: "independent" | "free";
  maxMailboxes: number;
  username: string;
  token: string | null;
  external: ExternalConfig;
};
type Settings = {
  revision: number;
  config: Config;
  public: { configured: boolean; internalConfigured?: boolean; domain: string; mode: string; maxMailboxes: number };
};
type SharedMailbox = {
  id: string;
  address: string;
  displayName: string;
  kind: string;
  locked: boolean;
  source?: string;
  providerLabel?: string;
};

function hydrateSettings(next: Settings): Settings {
  return {
    ...next,
    config: {
      ...next.config,
      external: {
        ...defaultExternalMailSettings,
        ...next.config.external,
        providers: {
          ...defaultExternalMailSettings.providers,
          ...next.config.external?.providers,
        },
        oauth: {
          gmail: {
            ...defaultExternalMailSettings.oauth.gmail,
            ...next.config.external?.oauth?.gmail,
          },
          outlook: {
            ...defaultExternalMailSettings.oauth.outlook,
            ...next.config.external?.oauth?.outlook,
          },
        },
      },
    },
  };
}

export function MailSettings() {
  const [tab, setTab] = useState("internal");
  const [data, setData] = useState<Settings | null>(null);
  const [persisted, setPersisted] = useState<Settings | null>(null);
  const [mailboxes, setMailboxes] = useState<SharedMailbox[]>([]);
  const [localPart, setLocalPart] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function load() {
    const [next, boxes] = await Promise.all([
      api<Settings>("/admin/mail"),
      api<{ items: SharedMailbox[] }>("/admin/mail/mailboxes").catch(() => ({ items: [] })),
    ]);
    const hydrated = hydrateSettings(next);
    setData(hydrated);
    setPersisted(hydrated);
    setMailboxes(boxes.items);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  function field<K extends keyof Config>(key: K, value: Config[K]) {
    setData((old) => (old ? { ...old, config: { ...old.config, [key]: value } } : old));
    setMessage("");
  }
  function externalField<K extends keyof ExternalConfig>(key: K, value: ExternalConfig[K]) {
    setData((old) =>
      old ? { ...old, config: { ...old.config, external: { ...old.config.external, [key]: value } } } : old,
    );
    setMessage("");
  }
  function oauthField(provider: "gmail" | "outlook", key: keyof OauthApp, value: string | null) {
    setData((old) =>
      old
        ? {
            ...old,
            config: {
              ...old.config,
              external: {
                ...old.config.external,
                oauth: {
                  ...old.config.external.oauth,
                  [provider]: { ...old.config.external.oauth[provider], [key]: value },
                },
              },
            },
          }
        : old,
    );
    setMessage("");
  }
  function payloadConfig(current: Settings): Config {
    if (tab === "external") {
      const base = persisted?.config ?? current.config;
      return { ...base, external: current.config.external, token: null };
    }
    return {
      ...current.config,
      external: persisted?.config.external ?? current.config.external,
    };
  }
  async function save(success: string) {
    if (!data) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = hydrateSettings(
        await api<Settings>("/admin/mail", "PUT", {
          revision: data.revision,
          config: payloadConfig(data),
        }),
      );
      setData(next);
      setPersisted(next);
      setMessage(success);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const c = data?.config;
  const internalReady = !!(data?.public.internalConfigured ?? data?.public.configured);
  return (
    <>
      <div className="admin-section-heading">
        <div>
          <h2>邮箱系统</h2>
          <p>
            {tab === "external"
              ? "开放后，用户可以在邮箱页绑定外部邮箱。Gmail 和 Outlook 走官方 OAuth，其余服务商使用授权码或应用专用密码。"
              : "绑定内部邮件服务，设置顶级域名和邮箱申请模式。管理员需要在该域名的 DNS 下登记 IMAP / SMTP / 管理端口。"}
          </p>
        </div>
      </div>
      <SettingsTabs
        label="邮箱设置分类"
        value={tab}
        onChange={(next) => {
          setTab(next);
          setMessage("");
        }}
        items={[
          ["internal", "内部邮箱"],
          ["external", "外部邮箱"],
        ]}
      />
      {error && <Feedback message={error} tone="error" />}
      {message && <Feedback message={message} tone="success" />}
      {!data || !c ? (
        <div className="empty">
          {error ? "无法加载设置" : "正在加载…"}
          <button onClick={() => void load().catch((e) => setError(e.message))}>重新加载</button>
        </div>
      ) : tab === "internal" ? (
        <form
          className="admin-card"
          onSubmit={(event) => {
            event.preventDefault();
            void save("内部邮箱设置已保存。启用后用户可按当前模式申请 Doca 邮箱。");
          }}
        >
          <fieldset disabled={busy} className="storage-fieldset">
            <legend>服务绑定</legend>
            <button
              type="button"
              className={`service-row ${c.enabled ? "selected" : ""}`}
              onClick={() => field("enabled", !c.enabled)}
            >
              <span className="setting-icon"><Mail size={20} /></span>
              <span>
                <strong>启用内部邮箱</strong>
                <small>Doca 通过内部邮件服务创建账户并收发邮件</small>
              </span>
              <span className="choice-dot">{c.enabled && <ShieldCheck size={13} />}</span>
            </button>
            <label>
              服务绑定地址
              <input
                value={c.endpoint}
                onChange={(event) => field("endpoint", event.target.value)}
                placeholder="留空则使用本地演示后端；正式环境填 https://mail.heyphp.com"
                autoComplete="off"
              />
            </label>
            <label>
              顶级域名
              <input
                value={c.domain}
                onChange={(event) => field("domain", event.target.value)}
                placeholder="heyphp.com"
                autoComplete="off"
              />
              <small>系统邮箱形如 xx@{c.domain || "heyphp.com"}。请把 IMAP / SMTP / 管理端口都登记到该域名的 DNS。</small>
            </label>
            <label>
              管理用户名
              <input
                value={c.username}
                onChange={(event) => field("username", event.target.value)}
                autoComplete="off"
              />
              <small>WildDuck 只校验 API Token，用户名可留空。</small>
            </label>
            <label className="service-secret">
              <span>管理 API Token</span>
              <input
                type="password"
                autoComplete="new-password"
                value={c.token ?? ""}
                placeholder={c.token === null ? "已配置，留空保留现有密钥" : "填写远端 api.accessToken"}
                onChange={(event) => field("token", event.target.value || (c.token === null ? null : ""))}
              />
              {c.token === null && (
                <button type="button" onClick={() => field("token", "")}>清除现有密钥</button>
              )}
              <small>必须与绑定地址上的 WildDuck `api.accessToken` 一致。换成云端地址后请重新填写，不能沿用本地演示 Token。</small>
            </label>
          </fieldset>
          <fieldset disabled={busy} className="storage-fieldset">
            <legend>申请模式</legend>
            <button
              type="button"
              className={`service-row ${c.mode === "independent" ? "selected" : ""}`}
              onClick={() => field("mode", "independent")}
            >
              <span className="setting-icon"><Users size={20} /></span>
              <span>
                <strong>独立邮箱模式</strong>
                <small>每个用户自动获得不可分享、不可删除的 {"{用户名}"}@{c.domain || "域名"}，例如 admin@{c.domain || "域名"}。管理员可另外创建共享邮箱。</small>
              </span>
            </button>
            <button
              type="button"
              className={`service-row ${c.mode === "free" ? "selected" : ""}`}
              onClick={() => field("mode", "free")}
            >
              <span className="setting-icon"><Mail size={20} /></span>
              <span>
                <strong>自由模式</strong>
                <small>
                  {c.maxMailboxes <= 1
                    ? `每名用户自动获得一个系统邮箱 {用户名}@${c.domain || "域名"}，例如 admin@${c.domain || "域名"}，固定排在列表第一位。`
                    : "用户选择邮件名自行申请，名称不能重复。最多申请个数由下面控制。"}
                </small>
              </span>
            </button>
            {c.mode === "free" && (
              <label>
                每名用户最多申请
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={c.maxMailboxes}
                  onChange={(event) => field("maxMailboxes", Number(event.target.value) || 1)}
                />
                <small>
                  {c.maxMailboxes <= 1
                    ? "设为 1 时不显示申请入口，新用户和打开邮箱的已有用户都会自动开通。"
                    : "大于 1 时，邮箱菜单里会显示申请入口，用户自己填写邮件名。"}
                </small>
              </label>
            )}
          </fieldset>
          <div className="admin-form-footer">
            <span className="subtle">
              {internalReady ? `当前域名 ${data.public.domain}` : "保存并启用后，用户才能申请 Doca 内部邮箱。"}
            </span>
            <button className="primary" disabled={busy}>{busy ? "保存中…" : "保存设置"}</button>
          </div>
        </form>
      ) : (
        <form
          className="admin-card"
          onSubmit={(event) => {
            event.preventDefault();
            void save("外部邮箱设置已保存。开放后用户可在添加邮箱时选择服务商并绑定。");
          }}
        >
          <fieldset disabled={busy} className="storage-fieldset">
            <legend>外部邮箱</legend>
            <button
              type="button"
              className={`service-row ${c.external.enabled ? "selected" : ""}`}
              onClick={() => externalField("enabled", !c.external.enabled)}
            >
              <span className="setting-icon"><Globe size={20} /></span>
              <span>
                <strong>允许绑定外部邮箱</strong>
                <small>Gmail / Outlook 需要先在下方填写 OAuth 客户端。QQ、网易、iCloud、Yahoo 仍使用授权码或应用专用密码。</small>
              </span>
              <span className="choice-dot">{c.external.enabled && <ShieldCheck size={13} />}</span>
            </button>
            <label>
              每名用户最多绑定
              <input
                type="number"
                min={1}
                max={20}
                value={c.external.maxAccounts}
                onChange={(event) => externalField("maxAccounts", Number(event.target.value) || 1)}
              />
            </label>
          </fieldset>
          <fieldset disabled={busy} className="storage-fieldset">
            <legend>可选服务商</legend>
            {mailProviderCatalog.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`service-row ${c.external.providers[item.id] ? "selected" : ""}`}
                onClick={() =>
                  externalField("providers", {
                    ...c.external.providers,
                    [item.id]: !c.external.providers[item.id],
                  })
                }
              >
                <span className="setting-icon">{item.label.slice(0, 1)}</span>
                <span>
                  <strong>{item.label}</strong>
                  <small>
                    {item.auth === "oauth" ? "官方 OAuth" : "授权码 / 应用专用密码"}
                    {" · "}
                    {item.hint}
                  </small>
                </span>
                <span className="choice-dot">{c.external.providers[item.id] && <ShieldCheck size={13} />}</span>
              </button>
            ))}
          </fieldset>
          {(["gmail", "outlook"] as const).filter((id) => c.external.providers[id]).map((id) => {
            const app = c.external.oauth[id];
            const label = id === "gmail" ? "Google" : "Microsoft";
            const redirect = `${location.origin}/api/v1/mail/oauth/${id}/callback`;
            return (
              <fieldset key={id} disabled={busy} className="storage-fieldset">
                <legend>{label} OAuth</legend>
                <p className="subtle">
                  创建 Web 应用，把重定向 URI 填成 <code>{redirect}</code>
                  {id === "gmail"
                    ? "，权限使用 https://mail.google.com/。"
                    : "，权限使用 IMAP.AccessAsUser.All、SMTP.Send、openid、email、offline_access。"}
                </p>
                <label>
                  客户端 ID
                  <input
                    value={app.clientId}
                    onChange={(event) => oauthField(id, "clientId", event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="service-secret">
                  <span>客户端密钥</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={app.clientSecret ?? ""}
                    placeholder={app.clientSecret === null ? "已配置，留空保留现有密钥" : "尚未配置"}
                    onChange={(event) =>
                      oauthField(id, "clientSecret", event.target.value || (app.clientSecret === null ? null : ""))
                    }
                  />
                  {app.clientSecret === null && (
                    <button type="button" onClick={() => oauthField(id, "clientSecret", "")}>
                      清除现有密钥
                    </button>
                  )}
                </label>
              </fieldset>
            );
          })}
          <div className="admin-form-footer">
            <span className="subtle">用户页面不会拆成两个入口，添加邮箱时直接选择 Doca 或某一家外部邮箱。</span>
            <button className="primary" disabled={busy}>{busy ? "保存中…" : "保存设置"}</button>
          </div>
        </form>
      )}
      {tab === "internal" && internalReady && (
        <form
          className="admin-card"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setMessage("");
            try {
              await api("/admin/mail/shared", "POST", { localPart, displayName: displayName || undefined });
              setLocalPart("");
              setDisplayName("");
              setMessage("共享邮箱已创建，可以分享给多名用户共同管理。");
              await load();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="storage-fieldset">
            <legend>共享邮箱</legend>
            <p className="subtle">独立模式下用户不能自行申请内部邮箱。管理员可以在这里创建可分享的团队邮箱。</p>
            <label>
              邮箱前缀
              <input value={localPart} onChange={(event) => setLocalPart(event.target.value)} placeholder="support" />
            </label>
            <label>
              显示名称
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="支持邮箱" />
            </label>
            <button className="primary" disabled={busy || !localPart.trim()}>{busy ? "创建中…" : "创建共享邮箱"}</button>
            {!!mailboxes.length && (
              <ul className="admin-simple-list">
                {mailboxes.map((item) => (
                  <li key={item.id}>
                    <strong>{item.displayName}</strong>
                    <small>
                      {item.address} ·{" "}
                      {item.source === "external"
                        ? `外部 · ${item.providerLabel || "外部邮箱"}`
                        : item.kind === "personal"
                          ? "个人"
                          : "共享"}
                      {item.locked ? " · 锁定" : ""}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </form>
      )}
    </>
  );
}
