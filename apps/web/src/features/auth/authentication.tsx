import { UserFieldSettings } from "@web/features/settings/user-field-settings.js";
import { SettingsTabs } from "@web/features/settings/settings-tabs.js";
import {
  AccountPolicySettings,
  SourceProfileSettings,
} from "@web/features/account/account-settings.js";
import {
  RegistrationFields,
  compactProofs,
  type Proofs,
  type RegistrationField,
} from "@web/features/auth/account-fields.js";
import { Feedback, type FeedbackTone } from "@web/shared/components/feedback.js";
import { useEffect, useState } from "react";
import {
  CodeXml,
  Globe,
  KeyRound,
  Link2,
  Plus,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { ServiceCredentials } from "@web/features/admin/service-credentials.js";
import "@web/features/auth/authentication.css";

type Provider = {
  id: string;
  type: string;
  name: string;
  issuer: string;
  client_id: string;
  credential_ref: string;
  profile_config?: string;
  protocol_config?: string;
  enabled: number;
  version: number;
  ready?: boolean;
  callbackUrl?: string;
};
type Policy = {
  revision: number;
  local: string;
  sso: string;
  social: string;
  providers: Provider[];
};
const names: Record<string, string> = {
  oidc: "自定义 SSO · OpenID Connect",
  oauth2: "自定义 OAuth 2.0",
  google: "Google",
  github: "GitHub",
  wechat: "微信网站扫码",
  qq: "QQ",
};
function ProviderIcon({ type }: { type: string }) {
  return (
    <span className={`provider-icon ${type}`}>
      {type === "github" ? (
        <CodeXml size={20} />
      ) : type === "oidc" ? (
        <ShieldCheck size={20} />
      ) : type === "google" ? (
        "G"
      ) : type === "wechat" ? (
        "微"
      ) : type === "qq" ? (
        "Q"
      ) : (
        <Globe size={20} />
      )}
    </span>
  );
}
export function AuthenticationSettings({
  saved,
}: {
  saved: () => Promise<void>;
}) {
  const [data, setData] = useState<Policy | null>(null),
    [draft, setDraft] = useState<Provider | null>(null),
    [tab, setTab] = useState("login"),
    [sourceTab, setSourceTab] = useState("connection"),
    [tone, setTone] = useState<FeedbackTone>("info"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function load() {
    setData(await api<Policy>("/admin/auth"));
  }
  useEffect(() => {
    void load().catch((e) => {
      setTone("error");
      setMessage(e.message);
    });
  }, []);
  async function act(f: () => Promise<unknown>, message: string) {
    setBusy(true);
    setMessage("");
    try {
      await f();
      await Promise.all([load(), saved()]);
      setTone("success");
      setMessage(message);
      return true;
    } catch (e) {
      setTone("error");
      setMessage((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SettingsTabs
        label="登录与注册分类"
        value={tab}
        onChange={setTab}
        items={[
          ["login", "登录方式"],
          ["registration", "注册规则"],
          ["profile", "用户字段"],
          ["security", "安全验证"],
          ["sources", "SSO 与第三方"],
        ]}
      />
      {["login", "registration"].includes(tab) && (
        <AccountPolicySettings key={tab} section={tab} />
      )}
      {tab === "login" && <ServiceCredentials onlyMessaging />}
      {tab === "profile" && <UserFieldSettings />}
      {tab === "security" && <UserFieldSettings security />}
      {message && <Feedback message={message} tone={tone} />}
      <div hidden={tab !== "registration"}>
      </div>
      <section
        hidden={tab !== "registration"}
        className="admin-card authentication-card"
      >
        <div className="card-heading">
          <div>
            <h3>新用户加入策略</h3>
            <p>分别控制不同入口。关闭注册不会阻止已有绑定账号登录。</p>
          </div>
          <ShieldCheck size={22} />
        </div>
        {data ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api("/admin/auth/policy", "PUT", {
                    revision: data.revision,
                    local: data.local,
                    sso: data.sso,
                    social: data.social,
                  }),
                "注册策略已保存",
              );
            }}
          >
            {(
              [
                ["local", "账号密码注册", "用户在本站创建账号和密码"],
                ["sso", "企业 SSO 首次登录", "由可信企业身份源创建本站账号"],
                ["social", "第三方首次登录", "使用已配置的第三方身份源加入"],
              ] as const
            ).map(([key, label, help]) => (
              <div className="policy-row" key={key}>
                <div>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </div>
                <Select
                  aria-label={label}
                  value={data[key]}
                  onChange={(e) => setData({ ...data, [key]: e.target.value })}
                >
                  <option value="closed">不允许新用户加入</option>
                  <option value="auto">自动注册，直接使用</option>
                  <option value="approval">注册后需管理员审核</option>
                </Select>
              </div>
            ))}
            <div className="auth-security-note">
              <ShieldCheck size={17} />
              <span>
                待审核用户不能登录或访问文档。不同身份不会因为邮箱或昵称相同而自动合并。
              </span>
            </div>
            <div className="admin-form-footer">
              <span>
                管理员创建的用户直接生效；公开注册需另行部署防滥用措施
              </span>
              <button className="primary" disabled={busy}>
                保存注册策略
              </button>
            </div>
          </form>
        ) : (
          <p>正在加载…</p>
        )}
      </section>
      <section
        hidden={tab !== "sources"}
        className="admin-card authentication-card"
      >
        <div className="card-heading">
          <div>
            <h3>SSO 与第三方身份源</h3>
            <p>一个账号可主动绑定多个身份，文档归属保持不变。</p>
          </div>
          <button
            onClick={() => {
              setMessage("");
              setSourceTab("connection");
              setDraft({
                id: "",
                type: "oidc",
                name: "企业 SSO",
                issuer: "",
                client_id: "",
                credential_ref: "",
                enabled: 0,
                version: 0,
              });
            }}
          >
            <Plus size={16} />
            添加身份源
          </button>
        </div>
        {!data?.providers.length && (
          <div className="auth-provider-empty">
            <Globe size={28} />
            <strong>连接你的登录服务</strong>
            <p>
              支持通用 OIDC、自定义 OAuth 2.0、Google、GitHub、微信网站扫码和
              QQ。
            </p>
            <small>企业 SSO 可连接 Keycloak、authentik 等 OIDC 身份源。</small>
          </div>
        )}
        {data?.providers.map((p) => (
          <div className="provider-row" key={p.id}>
            <ProviderIcon type={p.type} />
            <div>
              <strong>{p.name}</strong>
              <small>
                {names[p.type]} ·{" "}
                {p.ready ? "服务端凭据就绪" : "待配置服务端凭据"}
              </small>
            </div>
            <span
              className={`status-badge ${p.enabled && p.ready ? "success" : ""}`}
            >
              {p.enabled ? "已启用" : "未启用"}
            </span>
            <button
              onClick={() => {
                setMessage("");
                setSourceTab("connection");
                setDraft(p);
              }}
            >
              配置
            </button>
          </div>
        ))}
        <div className="auth-security-note">
          <KeyRound size={17} />
          <span>
            在下方按“凭据名称”维护各身份源的 Client
            Secret，已保存的密钥不会回显。
          </span>
        </div>
      </section>
      {tab === "sources" && <ServiceCredentials onlyIdentity />}
      {draft && (
        <Dialog
          className="provider-dialog"
          title={draft.id ? "配置身份源" : "添加身份源"}
          close={() => {
            if (!busy) setDraft(null);
          }}
        >
          <form
            className="provider-form admin-account-form"
            onInvalidCapture={() => setSourceTab("connection")}
            onSubmit={async (e) => {
              e.preventDefault();
              const { id, ready, callbackUrl, ...body } = draft;
              if (
                await act(
                  () =>
                    api(
                      "/admin/auth/providers" + (id ? "/" + id : ""),
                      id ? "PUT" : "POST",
                      body,
                    ),
                  id ? "身份源已保存" : "身份源已创建，请配置下方回调地址",
                )
              ) {
                if (id) setDraft(null);
                else {
                  const latest = await api<Policy>("/admin/auth");
                  setDraft(
                    latest.providers.find(
                      (p) =>
                        p.type === draft.type &&
                        p.client_id === draft.client_id,
                    ) ?? null,
                  );
                }
              }
            }}
          >
            <SettingsTabs
              label="身份源配置分类"
              value={sourceTab}
              onChange={setSourceTab}
              items={[
                ["connection", "连接配置"],
                ["fields", "资料映射"],
                ["policy", "注册与账号"],
              ]}
            />
            <div
              hidden={sourceTab !== "connection"}
              className="admin-form-section"
            >
              <label>
                登录类型
                <Select
                  value={draft.type}
                  disabled={!!draft.id}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      type: e.target.value,
                      name: names[e.target.value]!,
                      issuer: "",
                    })
                  }
                >
                  {Object.entries(names).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                按钮显示名称
                <input
                  required
                  maxLength={160}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              {draft.type === "oidc" && (
                <label>
                  Issuer 地址
                  <input
                    type="url"
                    required
                    disabled={!!draft.id}
                    placeholder="https://sso.example.com/realms/company"
                    value={draft.issuer}
                    onChange={(e) =>
                      setDraft({ ...draft, issuer: e.target.value })
                    }
                  />
                  <small>
                    填写身份源颁发者地址，不是登录页；域名须加入服务器白名单。
                  </small>
                </label>
              )}
              <label>
                {draft.type === "wechat" || draft.type === "qq"
                  ? "App ID"
                  : "Client ID"}
                <input
                  required
                  maxLength={256}
                  disabled={!!draft.id}
                  value={draft.client_id}
                  onChange={(e) =>
                    setDraft({ ...draft, client_id: e.target.value })
                  }
                />
              </label>
              <label>
                凭据名称
                <input
                  required
                  pattern="[a-zA-Z0-9_-]{1,64}"
                  placeholder="例如 company-sso"
                  value={draft.credential_ref}
                  onChange={(e) =>
                    setDraft({ ...draft, credential_ref: e.target.value })
                  }
                />
                <small>
                  对应下方“SSO Client Secret”中添加的凭据名称。
                </small>
              </label>
              {draft.type === "oauth2" && (
                <>
                  <small>
                    用于支持授权码和 PKCE
                    的认证源；端点域名需加入下方“SSO Client
                    Secret”中的允许来源。稳定身份字段不能使用邮箱或用户名。
                  </small>
                  {(
                    [
                      ["authorizationEndpoint", "授权端点"],
                      ["tokenEndpoint", "令牌端点"],
                      ["userinfoEndpoint", "用户资料端点"],
                      ["subjectField", "稳定身份字段"],
                      ["nameField", "显示名称字段"],
                      ["scopes", "授权范围"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        required={!["scopes", "nameField"].includes(key)}
                        disabled={!!draft.id}
                        value={
                          JSON.parse(draft.protocol_config || "{}")[key] ?? ""
                        }
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            protocol_config: JSON.stringify({
                              ...JSON.parse(draft.protocol_config || "{}"),
                              [key]: e.target.value,
                            }),
                          })
                        }
                      />
                    </label>
                  ))}
                </>
              )}
            </div>
            <div hidden={sourceTab === "connection"}>
              <SourceProfileSettings
                providerId={draft.id}
                section={sourceTab}
                value={draft.profile_config}
                onChange={(profile_config) =>
                  setDraft({ ...draft, profile_config })
                }
              />
            </div>
            <div hidden={sourceTab !== "connection"}>
              {draft.callbackUrl && (
                <label>
                  授权回调地址
                  <input
                    readOnly
                    value={draft.callbackUrl}
                    onFocus={(e) => e.target.select()}
                  />
                  <small>原样填写到身份源的应用配置中。</small>
                </label>
              )}
              <label className="setting-toggle">
                <span>
                  <strong>启用此身份源</strong>
                  <small>启用后显示在登录页和账号绑定页</small>
                </span>
                <input
                  className="switch-input"
                  type="checkbox"
                  checked={!!draft.enabled}
                  onChange={(e) =>
                    setDraft({ ...draft, enabled: e.target.checked ? 1 : 0 })
                  }
                />
              </label>
              <p className="subtle">
                类型、Issuer、Client ID 和自定义协议配置
                保存后不可修改，以避免把已有绑定指向另一个身份源。微信、QQ
                还需完成平台侧网站应用申请与域名审核。
              </p>
            </div>
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存身份源
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </>
  );
}

async function start(id: string, intent: "login" | "link" | "replace") {
  const result = await api<{ url: string }>(
    `/auth/providers/${id}/start`,
    "POST",
    { intent },
  );
  location.assign(result.url);
}
export function ExternalLoginOptions() {
  const [items, setItems] = useState<Provider[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ items: Provider[] }>("/auth/providers")
      .then((r) => setItems(r.items))
      .catch(() => setError("第三方登录方式暂时加载失败，请刷新重试"));
  }, []);
  return (
    <>
      {items.length > 0 && (
        <div className="external-login">
          <span>或使用以下方式</span>
          <div>
            {items.map((p) => (
              <button
                type="button"
                key={p.id}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void start(p.id, "login").catch((e) => {
                    setError(e.message);
                    setBusy(false);
                  });
                }}
              >
                <ProviderIcon type={p.type} />
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <Feedback message={error} tone="error" />}
    </>
  );
}
export function AuthCompletion({
  done,
}: {
  done: (status: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("正在验证登录结果…"),
    [busy, setBusy] = useState(true),
    [fields, setFields] = useState<RegistrationField[] | null>(null),
    [values, setValues] = useState<Record<string, string>>({}),
    [proofs, setProofs] = useState<Proofs>({});
  async function complete(body?: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await api<{
        status: string;
        fields?: RegistrationField[];
      }>("/auth/complete", "POST", body);
      if (r.status === "needs_profile") {
        setFields(r.fields!);
        setValues(Object.fromEntries(r.fields!.map((f) => [f.key, f.value])));
        setMessage("请确认并补全你的账号资料。");
      } else if (r.status === "pending") {
        setFields(null);
        setMessage("注册申请已提交，等待管理员审核后请重新登录。");
      } else if (r.status === "security_verified" || r.status === "linked") {
        await done(r.status);
        location.hash = "/account";
      } else await done(r.status);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void complete();
  }, []);
  return (
    <main className="auth">
      <section className="auth-card">
        <h2>身份验证与注册</h2>
        <p role="status">{message}</p>
        {fields && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void complete({ ...values, proofs: compactProofs(proofs) });
            }}
          >
            <RegistrationFields
              fields={fields}
              values={values}
              setValues={setValues}
              proofs={proofs}
              setProofs={setProofs}
            />
            <button className="primary" disabled={busy}>
              确认并继续
            </button>
          </form>
        )}
        {!busy && <a href="#/home">返回登录页</a>}
      </section>
    </main>
  );
}
type Binding = {
  id: string;
  provider_id: string;
  name: string;
  type: string;
  display_name: string;
  available: boolean;
};
export function LinkedIdentities({
  passwordStatus,
}: {
  passwordStatus?: (enabled: boolean) => void;
}) {
  const [data, setData] = useState<{
      login: string;
      passwordEnabled: boolean;
      passwordAllowed: boolean;
      linkingAllowed: boolean;
      items: Binding[];
    } | null>(null),
    [providers, setProviders] = useState<Provider[]>([]),
    [tone, setTone] = useState<FeedbackTone>("info"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [unlink, setUnlink] = useState<Binding | null>(null);
  async function load() {
    const [a, b] = await Promise.all([
      api<NonNullable<typeof data>>("/me/identities"),
      api<{ items: Provider[] }>("/auth/providers"),
    ]);
    setData(a);
    passwordStatus?.(a.passwordEnabled);
    setProviders(b.items);
  }
  useEffect(() => {
    void load().catch((e) => {
      setTone("error");
      setMessage(e.message);
    });
  }, []);
  async function act(f: () => Promise<unknown>, text: string) {
    setBusy(true);
    setMessage("");
    try {
      await f();
      window.dispatchEvent(new Event("security-verification-changed"));
      await load();
      setTone("success");
      setMessage(text);
    } catch (e) {
      setTone("error");
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card identity-card">
      <div className="card-heading">
        <div>
          <h2>登录方式与安全</h2>
          <p>同一个账号，多种登录方式。你的文档和权限始终保留。</p>
        </div>
        <Link2 size={22} />
      </div>
      <div className="provider-row">
        <span className="provider-icon">
          <KeyRound size={20} />
        </span>
        <div>
          <strong>账号密码</strong>
          <small>
            {data?.passwordEnabled
              ? data.login
              : data?.passwordAllowed
                ? "当前通过其他方式登录，可在下方设置本站密码"
                : "账号密码认证已关闭"}
          </small>
        </div>
        <span className="status-badge">
          {data?.passwordEnabled ? "已设置" : "未设置"}
        </span>
      </div>
      {data?.items.map((b) => (
        <div className="provider-row" key={b.id}>
          <ProviderIcon type={b.type} />
          <div>
            <strong>{b.name}</strong>
            <small>
              {b.display_name} · {b.available ? "已绑定" : "身份源当前不可用"}
            </small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() => start(b.provider_id, "replace"), "正在跳转…")
            }
          >
            更换绑定
          </button>
          <button type="button" disabled={busy} onClick={() => setUnlink(b)}>
            <Unlink size={14} />
            解除绑定
          </button>
        </div>
      ))}
      {providers
        .filter(
          (p) =>
            data?.linkingAllowed &&
            !data?.items.some((b) => b.provider_id === p.id),
        )
        .map((p) => (
          <div className="provider-row" key={p.id}>
            <ProviderIcon type={p.type} />
            <div>
              <strong>{p.name}</strong>
              <small>未绑定</small>
            </div>
            <button
              disabled={busy}
              onClick={() => void act(() => start(p.id, "link"), "正在跳转…")}
            >
              <Plus size={14} />
              绑定
            </button>
          </div>
        ))}
      {!providers.length && (
        <p className="subtle">管理员尚未启用 SSO 或第三方登录。</p>
      )}

      {!data?.passwordEnabled && data?.passwordAllowed && (
        <form
          className="reauth-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            void act(async () => {
              await api("/auth/password/setup", "POST", {
                password: new FormData(f).get("password"),
              });
              f.reset();
            }, "密码已设置");
          }}
        >
          <label>
            设置密码
            <input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={128}
            />
          </label>
          <button disabled={busy}>设置密码</button>
        </form>
      )}
      {message && <Feedback message={message} tone={tone} />}
      {unlink && (
        <Dialog
          title="解除登录绑定"
          close={() => {
            if (!busy) setUnlink(null);
          }}
          className="modal-compact"
        >
          <p>
            解除「{unlink.name}
            」后，该身份将不能再登录当前账号。文档不会被删除。
          </p>
          <footer>
            <button disabled={busy} onClick={() => setUnlink(null)}>
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(`/me/identities/${unlink.id}`, "DELETE");
                  setUnlink(null);
                }, "已解除绑定")
              }
            >
              确认解除
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
