import { htmlLang } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Select } from "@web/shared/components/select.js";
import {
  VerificationField,
  compactProofs,
  useFieldLabels,
  type AccountOptions,
  type Proofs,
} from "@web/features/auth/account-fields.js";
export function AccountPolicySettings({
  section = "login",
}: {
  section?: string;
}) {
const { t, locale } = useI18n();

  const [data, setData] = useState<AccountOptions | null>(null),
    [providers, setProviders] = useState<{ id: string; name: string }[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      api<AccountOptions>("/admin/accounts/policy"),
      api<{ items: { id: string; name: string }[] }>("/auth/providers"),
    ])
      .then(([policy, auth]) => {
        setData(policy);
        setProviders(auth.items);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  return (
    <section className="admin-card">
      <h3>{section === "registration" ? t("accountPolicy.codeRegistration") : t("accountPolicy.basicLogin")}</h3>
      {data && (
        <form
          className="admin-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const {
                phoneReady,
                emailReady,
                ...body
              } = data;
              await api("/admin/accounts/policy", "PUT", body);
              setData(await api("/admin/accounts/policy"));
              setMessage(t("accountPolicy.saved"));
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {section === "login" && (
            <>
              {(
                [
                  ["passwordEnabled", t("accountPolicy.password")],
                  ["smsEnabled", t("accountPolicy.phone")],
                  ["emailEnabled", t("accountPolicy.email")],
                  ["qrLoginEnabled", t("accountPolicy.qr")],
                  ["recoveryEnabled", t("accountPolicy.recovery")],
                ] as const
              ).map(([key, label]) => (
                <label className="setting-toggle" key={key}>
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={!!data[key]}
                    onChange={(e) =>
                      setData({ ...data, [key]: e.target.checked })
                    }
                  />
                </label>
              ))}
              {data.passwordEnabled && (
                <fieldset className="admin-form-section">
                  <legend>{t("accountPolicy.identifiers")}</legend>
                  <p className="admin-field-help">{t("accountPolicy.identifiersHelp")}</p>
                  {(
                    [
                      ["username", t("fields.username")],
                      ["phone", t("login.phone")],
                      ["email", t("fields.email")],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="setting-toggle" key={key}>
                      <span>{label}</span>
                      <input
                        type="checkbox"
                        checked={
                          data.passwordIdentifiers?.includes(key) ?? false
                        }
                        onChange={(e) =>
                          setData({
                            ...data,
                            passwordIdentifiers: e.target.checked
                              ? [...(data.passwordIdentifiers ?? []), key]
                              : (data.passwordIdentifiers ?? []).filter(
                                  (k) => k !== key,
                                ),
                          })
                        }
                      />
                    </label>
                  ))}
                </fieldset>
              )}
              <label>{t("accountPolicy.forceMethod")}<Select
                  value={data.forcedLoginMethod ?? ""}
                  onChange={(e) =>
                    setData({
                      ...data,
                      forcedLoginMethod: e.target.value || null,
                    })
                  }
                >
                  <option value="">{t("accountPolicy.noForce")}</option>
                  {data.passwordEnabled && <option value="password">{t("login.passwordTab")}</option>}
                  {data.smsEnabled && data.phoneReady && <option value="phone">{t("accountPolicy.phoneCode")}</option>}
                  {data.emailEnabled && data.emailReady && <option value="email">{t("login.emailCode")}</option>}
                  {providers.map((provider) => (
                    <option value={`provider:${provider.id}`} key={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
                <small>{t("accountPolicy.forceHelp")}</small>
              </label>
            </>
          )}
          <label hidden={section !== "registration"}>{t("accountPolicy.firstPhone")}<Select
              value={data.smsRegistration ?? "closed"}
              onChange={(e) =>
                setData({ ...data, smsRegistration: e.target.value })
              }
            >
              <option value="closed">{t("authAdmin.noRegistration")}</option>
              <option value="auto">{t("authAdmin.autoRegistration")}</option>
              <option value="approval">{t("authAdmin.reviewRegistration")}</option>
            </Select>
          </label>
          <label hidden={section !== "registration"}>{t("accountPolicy.firstEmail")}<Select
              value={data.emailRegistration ?? "closed"}
              onChange={(e) =>
                setData({ ...data, emailRegistration: e.target.value })
              }
            >
              <option value="closed">{t("authAdmin.noRegistration")}</option>
              <option value="auto">{t("authAdmin.autoRegistration")}</option>
              <option value="approval">{t("authAdmin.reviewRegistration")}</option>
            </Select>
          </label>
          <p className="admin-field-help" hidden={section !== "login"}>
            {t("accountPolicy.serviceStatus", { phone: t(data.phoneReady ? "accountPolicy.configured" : "accountPolicy.notConfigured"), email: t(data.emailReady ? "accountPolicy.configured" : "accountPolicy.notConfigured") })}{" "}{t("accountPolicy.serviceHelp")}</p>
          <button className="primary" disabled={busy}>{t("accountPolicy.save")}</button>
        </form>
      )}
      <Feedback message={message} tone="info" />
    </section>
  );
}
export function SourceProfileSettings({
  section = "fields",
  providerId,
  value,
  onChange,
}: {
  section?: string;
  providerId?: string;
  value?: string;
  onChange: (v: string) => void;
}) {
const { t, locale } = useI18n();

const fieldLabels = useFieldLabels();

  const p = JSON.parse(value || "{}"),
    [fieldPolicy, setFieldPolicy] = useState<AccountOptions | null>(null);
  useEffect(() => {
    void api<AccountOptions>("/admin/accounts/policy")
      .then(setFieldPolicy)
      .catch(() => {});
  }, []);
  const update = (v: Record<string, unknown>) =>
    onChange(JSON.stringify({ ...p, ...v }));
  return (
    <div className="source-fields admin-settings-form">
      <div hidden={section !== "policy"}>
        <label>{t("accountPolicy.sourceRegistration")}<Select
            value={p.signup ?? "inherit"}
            onChange={(e) => update({ signup: e.target.value })}
          >
            <option value="inherit">{t("accountPolicy.defaultRegistration")}</option>
            <option value="closed">{t("authAdmin.noRegistration")}</option>
            <option value="auto">{t("authAdmin.autoRegistration")}</option>
            <option value="approval">{t("authAdmin.reviewRegistration")}</option>
          </Select>
        </label>
      </div>
      <div hidden={section !== "fields"}>
        <h3>{t("accountPolicy.profileMapping")}</h3>
        <p>{t("accountPolicy.mappingHelp")}</p>
        <div className="source-mapping-head">
          <span>{t("accountPolicy.profile")}</span>
          <span>{t("accountPolicy.sourceField")}</span>
          <span>{t("accountPolicy.editRules")}</span>
          <span>{t("accountPolicy.loginSync")}</span>
        </div>
        {Object.entries(fieldLabels)
          .filter(([key]) => key !== "password")
          .map(([key, label]) => {
            const r = {
              source: "",
              sync: false,
              verifiedField: "",
              ...p.fields?.[key],
            };
            const global =
              fieldPolicy?.fields?.[
                key as keyof NonNullable<AccountOptions["fields"]>
              ];
            const owned =
              !global ||
              global.source === "manual" ||
              global.source === `provider:${providerId}`;
            const disabled = !owned || global?.enabled === false;
            const set = (change: object) =>
              update({ fields: { ...p.fields, [key]: { ...r, ...change } } });
            return (
              <div className="source-field source-mapping-row" key={key}>
                <strong>{label}</strong>
                <input
                  disabled={disabled}
                  aria-label={t("accountPolicy.sourceLabel", { name: label })}
                  placeholder={
                    (
                      {
                        username: "preferred_username",
                        displayName: "name",
                        email: "email",
                        phone: "phone_number",
                        avatar: "picture",
                      } as Record<string, string>
                    )[key]
                  }
                  value={r.source}
                  onChange={(e) =>
                    set({
                      source: e.target.value,
                    })
                  }
                />
                <span className="admin-field-help">
                  {!owned
                    ? t("accountPolicy.otherSource")
                    : {
                        editable: t("accountPolicy.editable"),
                        sso: t("accountPolicy.ssoOnly"),
                        immutable: t("accountPolicy.immutable"),
                      }[global?.mode ?? "editable"]}
                </span>
                {key === "username" ? (
                  <span className="admin-field-help">{t("accountPolicy.fixedAccount")}</span>
                ) : (
                  <label>
                    <input
                      type="checkbox"
                      disabled={
                        disabled || !r.source || global?.mode !== "editable"
                      }
                      checked={
                        global?.mode === "sso"
                          ? true
                          : global?.mode === "immutable"
                            ? false
                            : r.sync
                      }
                      onChange={(e) => set({ sync: e.target.checked })}
                    />
                    <span className="sr-only">{label}{t("accountPolicy.syncOnLogin")}</span>
                  </label>
                )}
                {["email", "phone"].includes(key) && (
                  <input
                    aria-label={t("accountPolicy.verifiedLabel", { name: label })}
                    className="source-verification-field"
                    placeholder={
                      key === "email"
                        ? t("accountPolicy.emailVerifiedField")
                        : t("accountPolicy.phoneVerifiedField")
                    }
                    value={r.verifiedField}
                    onChange={(e) => set({ verifiedField: e.target.value })}
                  />
                )}
              </div>
            );
          })}
      </div>
      <div hidden={section !== "policy"}>
        {(["allowLinking"] as const).map((key) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={p[key] ?? true}
              onChange={(e) => update({ [key]: e.target.checked })}
            />
            {t("accountPolicy.allowLinking")}
          </label>
        ))}
      </div>

    </div>
  );
}
function MappingAdd({ add }: { add: (key: string) => void }) {
const { t, locale } = useI18n();

  const [value, setValue] = useState("");
  return (
    <div className="verification-code">
      <input
        aria-label={t("accountPolicy.newSource")}
        placeholder={t("accountPolicy.sourceExample")}
        value={value}
        maxLength={64}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        type="button"
        disabled={!value.trim()}
        onClick={() => {
          add(value.trim());
          setValue("");
        }}
      >{t("accountPolicy.addMapping")}</button>
    </div>
  );
}
export function AccountContacts() {
const { t, locale } = useI18n();

const fieldLabels = useFieldLabels();

  const [data, setData] = useState<{
      editable: Record<string, boolean>;
      contacts: { kind: string; value: string }[];
      policy: AccountOptions;
    } | null>(null),
    [kind, setKind] = useState<"phone" | "email">("email"),
    [value, setValue] = useState(""),
    [proof, setProof] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<NonNullable<typeof data>>("/me/account").then((d) => {
      setData(d);
      if (d.policy.fields?.email.enabled === false) setKind("phone");
    });
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, []);
  if (
    data?.policy.fields?.email.enabled === false &&
    data?.policy.fields?.phone.enabled === false
  )
    return null;
  return (
    <section className="settings-card">
      <h2>{t("accountPolicy.contacts")}</h2>
      {data?.contacts.map((c) => (
        <p key={c.kind}>
          {fieldLabels[c.kind]}：{c.value}{t("accountPolicy.verifiedSuffix")}{data.editable[c.kind] === false ? t("accountPolicy.readOnlySuffix") : ""}
        </p>
      ))}
      <p className="subtle">{t("accountPolicy.contactsHelp")}</p>

      <Select
        value={kind}
        onChange={(e) => {
          setKind(e.target.value as "phone" | "email");
          setValue("");
          setProof("");
        }}
      >
        {data?.policy.fields?.email.enabled !== false && (
          <option value="email">{t("fields.email")}</option>
        )}
        {data?.policy.fields?.phone.enabled !== false && (
          <option value="phone">{t("login.phone")}</option>
        )}
      </Select>
      <VerificationField
        key={kind}
        kind={kind}
        purpose="contact"
        value={value}
        onValue={setValue}
        onProof={setProof}
        disabled={data?.editable[kind] === false}
      />
      <button
        disabled={!proof || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/me/contacts", "PUT", { kind, proof });
            setProof("");
            window.dispatchEvent(new Event("security-verification-changed"));
            await load();
            setMessage(t("accountPolicy.contactsSaved"));
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >{t("accountPolicy.saveContacts")}</button>
      <Feedback message={message} tone="info" />
    </section>
  );
}
export function AdminAccountEditor({
  userId,
  close,
  saved,
}: {
  userId: string;
  close: () => void;
  saved: () => void;
}) {
const { t, locale } = useI18n();

const fieldLabels = useFieldLabels();

  const [data, setData] = useState<any>(null),
    [reason, setReason] = useState(""),
    [restore, setRestore] = useState<string[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<any>(`/admin/users/${userId}/account`)
      .then((d) =>
        setData({
          ...d,
          email: d.contacts.find((c: any) => c.kind === "email")?.value ?? "",
          phone: d.contacts.find((c: any) => c.kind === "phone")?.value ?? "",
          avatar: d.metadata.avatarUrl ?? "",
        }),
      )
      .catch((e) => setMessage(e.message));
  }, [userId]);
  return (
    <Dialog
      title={t("accountPolicy.editUser")}
      close={() => {
        if (!busy) close();
      }}
    >
      {data && (
        <form
          className="admin-account-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api(`/admin/users/${userId}/account`, "PUT", {
                revision: data.revision,
                username: data.username,
                displayName: data.displayName,
                email: data.email,
                phone: data.phone,
                avatar: data.avatar,
                admin: data.admin,
                restoreFields: restore,
                reason,
              });
              saved();
              close();
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="admin-form-fields">
            {(
              ["username", "displayName", "email", "phone", "avatar"] as const
            ).map((key) => (
              <label key={key} className={key === "avatar" ? "full-width" : ""}>
                {fieldLabels[key]}
                {key === "username" ||
                key === "displayName" ||
                (key === "email" && data.policy.fields.email.required) ||
                (key === "phone" && data.policy.fields.phone.required)
                  ? " *"
                  : ""}
                <input
                  type={
                    key === "email"
                      ? "email"
                      : key === "phone"
                        ? "tel"
                        : key === "avatar"
                          ? "url"
                          : "text"
                  }
                  required={
                    key === "username" ||
                    key === "displayName" ||
                    (key === "email" && data.policy.fields.email.required) ||
                    (key === "phone" && data.policy.fields.phone.required)
                  }
                  maxLength={
                    key === "avatar" ? 2048 : key === "email" ? 254 : 160
                  }
                  value={data[key]}
                  placeholder={
                    key === "phone"
                      ? "+86 13800138000"
                      : key === "avatar"
                        ? "https://…"
                        : undefined
                  }
                  onChange={(e) => setData({ ...data, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <p className="admin-field-help">{t("accountPolicy.adminContactHelp")}</p>
          <label className="setting-toggle">
            <span>
              <strong>{t("accountPolicy.systemAdmin")}</strong>
              <small>{t("accountPolicy.systemAdminHelp")}</small>
            </span>
            <input
              type="checkbox"
              checked={data.admin}
              onChange={(e) => setData({ ...data, admin: e.target.checked })}
            />
          </label>
          {!!Object.entries(data.metadata.overrides ?? {}).filter(
            ([k, v]) => k !== "username" && v,
          ).length && (
            <details className="admin-form-section">
              <summary>{t("accountPolicy.identitySync")}</summary>
              {Object.entries(data.metadata.overrides ?? {})
                .filter(([k, v]) => k !== "username" && v)
                .map(([key]) => (
                  <label className="admin-check" key={key}>
                    <input
                      type="checkbox"
                      checked={restore.includes(key)}
                      onChange={(e) =>
                        setRestore(
                          e.target.checked
                            ? [...restore, key]
                            : restore.filter((k) => k !== key),
                        )
                      }
                    />{t("accountPolicy.restoreSync", { name: fieldLabels[key]! })}
                  </label>
                ))}
            </details>
          )}
          <label>{t("accountPolicy.reason")}<textarea
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("accountPolicy.reasonExample")}
            />
          </label>
          <details className="admin-form-section">
            <summary>{t("accountPolicy.recentActions")}</summary>
            {data.audit.length ? (
              data.audit.map((a: any) => (
                <p className="admin-field-help" key={a.id}>
                  {new Date(a.created_at).toLocaleString(htmlLang(locale))} · {a.action}
                </p>
              ))
            ) : (
              <p className="admin-field-help">{t("record.empty")}</p>
            )}
          </details>
          <Feedback message={message} tone="error" />
          <footer>
            <button type="button" disabled={busy} onClick={close}>{t("common.cancel")}</button>
            <button className="primary" disabled={busy}>{t("accountPolicy.saveUser")}</button>
          </footer>
        </form>
      )}
      {!data && (
        <Feedback
          message={message || t("common.loading")}
          tone={message ? "error" : "info"}
        />
      )}
    </Dialog>
  );
}
