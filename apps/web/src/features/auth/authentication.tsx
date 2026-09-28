import { useI18n } from "@web/shared/i18n.js";
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
import { BackLink } from "@web/shared/components/back-link.js";
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
        "W"
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
const { t, locale } = useI18n();

const names: Record<string, string> = {
  oidc: t("authAdmin.customOidc"),
  oauth2: t("authAdmin.customOauth"),
  google: "Google",
  github: "GitHub",
  wechat: t("authAdmin.wechat"),
  qq: "QQ",
};

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
        label={t("authAdmin.categories")}
        value={tab}
        onChange={setTab}
        items={[
          ["login", t("authAdmin.login")],
          ["registration", t("authAdmin.registration")],
          ["profile", t("authAdmin.fields")],
          ["security", t("authAdmin.security")],
          ["sources", t("authAdmin.providers")],
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
            <h3>{t("authAdmin.joinPolicy")}</h3>
            <p>{t("authAdmin.joinHelp")}</p>
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
                t("authAdmin.policySaved"),
              );
            }}
          >
            {(
              [
                ["local", t("authAdmin.passwordRegistration"), t("authAdmin.passwordRegistrationHelp")],
                ["sso", t("authAdmin.ssoRegistration"), t("authAdmin.ssoRegistrationHelp")],
                ["social", t("authAdmin.socialRegistration"), t("authAdmin.socialRegistrationHelp")],
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
                  <option value="closed">{t("authAdmin.noRegistration")}</option>
                  <option value="auto">{t("authAdmin.autoRegistration")}</option>
                  <option value="approval">{t("authAdmin.reviewRegistration")}</option>
                </Select>
              </div>
            ))}
            <div className="auth-security-note">
              <ShieldCheck size={17} />
              <span>{t("authAdmin.reviewHelp")}</span>
            </div>
            <div className="admin-form-footer">
              <span>{t("authAdmin.registrationNote")}</span>
              <button className="primary" disabled={busy}>{t("authAdmin.savePolicy")}</button>
            </div>
          </form>
        ) : (
          <p>{t("common.loading")}</p>
        )}
      </section>
      <section
        hidden={tab !== "sources"}
        className="admin-card authentication-card"
      >
        <div className="card-heading">
          <div>
            <h3>{t("authAdmin.providerTitle")}</h3>
            <p>{t("authAdmin.providerHelp")}</p>
          </div>
          <button
            onClick={() => {
              setMessage("");
              setSourceTab("connection");
              setDraft({
                id: "",
                type: "oidc",
                name: t("authAdmin.enterprise"),
                issuer: "",
                client_id: "",
                credential_ref: "",
                enabled: 0,
                version: 0,
              });
            }}
          >
            <Plus size={16} />{t("authAdmin.addProvider")}</button>
        </div>
        {!data?.providers.length && (
          <div className="auth-provider-empty">
            <Globe size={28} />
            <strong>{t("authAdmin.connect")}</strong>
            <p>{t("authAdmin.supported")}</p>
            <small>{t("authAdmin.enterpriseHelp")}</small>
          </div>
        )}
        {data?.providers.map((p) => (
          <div className="provider-row" key={p.id}>
            <ProviderIcon type={p.type} />
            <div>
              <strong>{p.name}</strong>
              <small>
                {names[p.type]} ·{" "}
                {p.ready ? t("authAdmin.credentialsReady") : t("authAdmin.credentialsPending")}
              </small>
            </div>
            <span
              className={`status-badge ${p.enabled && p.ready ? "success" : ""}`}
            >
              {p.enabled ? t("admin.enabled") : t("services.disabled")}
            </span>
            <button
              onClick={() => {
                setMessage("");
                setSourceTab("connection");
                setDraft(p);
              }}
            >{t("authAdmin.configure")}</button>
          </div>
        ))}
        <div className="auth-security-note">
          <KeyRound size={17} />
          <span>{t("authAdmin.credentialsHelp")}</span>
        </div>
      </section>
      {tab === "sources" && <ServiceCredentials onlyIdentity />}
      {draft && (
        <Dialog
          className="provider-dialog"
          title={draft.id ? t("authAdmin.configureProvider") : t("authAdmin.addProvider")}
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
                  id ? t("authAdmin.providerSaved") : t("authAdmin.providerCreated"),
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
              label={t("authAdmin.providerCategories")}
              value={sourceTab}
              onChange={setSourceTab}
              items={[
                ["connection", t("authAdmin.connection")],
                ["fields", t("authAdmin.mapping")],
                ["policy", t("authAdmin.accounts")],
              ]}
            />
            <div
              hidden={sourceTab !== "connection"}
              className="admin-form-section"
            >
              <label>{t("authAdmin.loginType")}<Select
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
              <label>{t("authAdmin.buttonName")}<input
                  required
                  maxLength={160}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              {draft.type === "oidc" && (
                <label>{t("authAdmin.issuer")}<input
                    type="url"
                    required
                    disabled={!!draft.id}
                    placeholder="https://sso.example.com/realms/company"
                    value={draft.issuer}
                    onChange={(e) =>
                      setDraft({ ...draft, issuer: e.target.value })
                    }
                  />
                  <small>{t("authAdmin.issuerHelp")}</small>
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
              <label>{t("authAdmin.credentialName")}<input
                  required
                  pattern="[a-zA-Z0-9_-]{1,64}"
                  placeholder={t("authAdmin.credentialExample")}
                  value={draft.credential_ref}
                  onChange={(e) =>
                    setDraft({ ...draft, credential_ref: e.target.value })
                  }
                />
                <small>{t("authAdmin.credentialHelp")}</small>
              </label>
              {draft.type === "oauth2" && (
                <>
                  <small>{t("authAdmin.oauthHelp")}</small>
                  {(
                    [
                      ["authorizationEndpoint", t("authAdmin.authorizationEndpoint")],
                      ["tokenEndpoint", t("authAdmin.tokenEndpoint")],
                      ["userinfoEndpoint", t("authAdmin.profileEndpoint")],
                      ["subjectField", t("authAdmin.subjectField")],
                      ["nameField", t("authAdmin.displayNameField")],
                      ["scopes", t("authAdmin.scopes")],
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
                <label>{t("authAdmin.callback")}<input
                    readOnly
                    value={draft.callbackUrl}
                    onFocus={(e) => e.target.select()}
                  />
                  <small>{t("authAdmin.callbackHelp")}</small>
                </label>
              )}
              <label className="setting-toggle">
                <span>
                  <strong>{t("authAdmin.enableProvider")}</strong>
                  <small>{t("authAdmin.enableHelp")}</small>
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
              <p className="subtle">{t("authAdmin.immutableHelp")}</p>
            </div>
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >{t("common.cancel")}</button>
              <button className="primary" disabled={busy}>{t("authAdmin.saveProvider")}</button>
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
const { t, locale } = useI18n();

  const [items, setItems] = useState<Provider[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ items: Provider[] }>("/auth/providers")
      .then((r) => setItems(r.items))
      .catch(() => setError(t("authAdmin.loadFailed")));
  }, []);
  return (
    <>
      {items.length > 0 && (
        <div className="external-login">
          <span>{t("authAdmin.alternative")}</span>
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
const { t, locale } = useI18n();

  const [message, setMessage] = useState(t("authAdmin.verifying")),
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
        setMessage(t("authAdmin.completeProfile"));
      } else if (r.status === "pending") {
        setFields(null);
        setMessage(t("login.pendingReview"));
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
        <h2>{t("authAdmin.completion")}</h2>
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
            <button className="primary" disabled={busy}>{t("login.continue")}</button>
          </form>
        )}
        {!busy && <BackLink fallback="/home">{t("shell.backLogin")}</BackLink>}
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
const { t, locale } = useI18n();

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
          <h2>{t("authAdmin.accountSecurity")}</h2>
          <p>{t("authAdmin.accountSecurityHelp")}</p>
        </div>
        <Link2 size={22} />
      </div>
      <div className="provider-row">
        <span className="provider-icon">
          <KeyRound size={20} />
        </span>
        <div>
          <strong>{t("login.passwordTab")}</strong>
          <small>
            {data?.passwordEnabled
              ? data.login
              : data?.passwordAllowed
                ? t("authAdmin.passwordHelp")
                : t("authAdmin.passwordDisabled")}
          </small>
        </div>
        <span className="status-badge">
          {data?.passwordEnabled ? t("authAdmin.passwordSet") : t("authAdmin.passwordUnset")}
        </span>
      </div>
      {data?.items.map((b) => (
        <div className="provider-row" key={b.id}>
          <ProviderIcon type={b.type} />
          <div>
            <strong>{b.name}</strong>
            <small>
              {b.display_name} · {b.available ? t("authAdmin.linked") : t("authAdmin.providerUnavailable")}
            </small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() => start(b.provider_id, "replace"), t("authAdmin.redirecting"))
            }
          >{t("authAdmin.replaceLink")}</button>
          <button type="button" disabled={busy} onClick={() => setUnlink(b)}>
            <Unlink size={14} />{t("authAdmin.unlink")}</button>
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
              <small>{t("authAdmin.notLinked")}</small>
            </div>
            <button
              disabled={busy}
              onClick={() => void act(() => start(p.id, "link"), t("authAdmin.redirecting"))}
            >
              <Plus size={14} />{t("library.relations.bind")}</button>
          </div>
        ))}
      {!providers.length && (
        <p className="subtle">{t("authAdmin.noProviders")}</p>
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
            }, t("authAdmin.passwordSaved"));
          }}
        >
          <label>{t("authAdmin.setPassword")}<input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={128}
            />
          </label>
          <button disabled={busy}>{t("authAdmin.setPassword")}</button>
        </form>
      )}
      {message && <Feedback message={message} tone={tone} />}
      {unlink && (
        <Dialog
          title={t("authAdmin.unlinkTitle")}
          close={() => {
            if (!busy) setUnlink(null);
          }}
          className="modal-compact"
        >
          <p>
            {t("authAdmin.unlinkWarning", { name: unlink.name })}
          </p>
          <footer>
            <button disabled={busy} onClick={() => setUnlink(null)}>{t("common.cancel")}</button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(`/me/identities/${unlink.id}`, "DELETE");
                  setUnlink(null);
                }, t("authAdmin.unlinked"))
              }
            >{t("authAdmin.confirmUnlink")}</button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
