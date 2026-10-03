import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { SettingsTabs } from "@web/features/settings/settings-tabs.js";
import "@web/features/admin/service-credentials.css";
type Config = {
  identity: {
    credentials: Record<string, string | null>;
    allowedOrigins: string[];
  };
  messaging: { endpoint: string; secret: string | null; channels: string[] };
  search: { apiKey: string | null; allowedOrigins: string[] };
};
function SecretField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  multiline?: boolean;
}) {
  const { t } = useI18n();
  const hint =
    value === null
      ? t("credentials.configured")
      : t("credentials.unconfigured");
  return (
    <label className="service-secret">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={value ?? ""}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value || null)}
          rows={5}
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <input
          type="password"
          autoComplete="new-password"
          value={value ?? ""}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value || null)}
        />
      )}
      {value === null && (
        <button type="button" onClick={() => onChange("")}>
          {t("credentials.clear")}
        </button>
      )}
    </label>
  );
}
function Origins({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  return (
    <label>
      {label}
      <textarea
        rows={3}
        value={values.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        placeholder={placeholder}
      />
      <small>{t("credentials.linesHelp")}</small>
    </label>
  );
}
export function ServiceCredentials({
  onlySearch = false,
  onlyIdentity = false,
  onlyMessaging = false,
  onSearchSaved,
}: {
  onlySearch?: boolean;
  onlyIdentity?: boolean;
  onlyMessaging?: boolean;
  onSearchSaved?: (config: Config["search"]) => void;
} = {}) {
  const { t } = useI18n();
  const embedded = onlySearch || onlyIdentity || onlyMessaging,
    [data, setData] = useState<{ revision: number; config: Config } | null>(
      null,
    ),
    [tab, setTab] = useState(
      onlySearch
        ? "search"
        : onlyIdentity
          ? "identity"
          : onlyMessaging
            ? "messaging"
            : "identity",
    ),
    [ref, setRef] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const load = () =>
    api<{ revision: number; config: Config }>(
      "/admin/service-credentials",
    ).then((value) => {
      setData(value);
      return value;
    });
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const change = (update: (c: Config) => void) =>
    setData((previous) => {
      if (!previous) return previous;
      const next = structuredClone(previous);
      update(next.config);
      return next;
    });
  if (!data)
    return (
      <p className="admin-field-help" role={error ? "alert" : "status"}>
        {error || t("credentials.loading")}
      </p>
    );
  const c = data.config;
  function add() {
    const id = ref.trim();
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
      ["__proto__", "prototype", "constructor"].includes(id)
    ) {
      setError(t("credentials.invalidName"));
      return;
    }
    const entries = c.identity.credentials;
    if (Object.hasOwn(entries, id)) {
      setError(t("credentials.duplicateName"));
      return;
    }
    change((v) => {
      v.identity.credentials[id] = "";
    });
    setRef("");
    setError("");
  }
  return (
    <section
      className={
        onlySearch
          ? "service-credentials search-connection-credentials"
          : "admin-card service-credentials"
      }
    >
      {!embedded && (
        <>
          <h3>{t("credentials.title")}</h3>
          <p className="admin-field-help">{t("credentials.help")}</p>
        </>
      )}
      {embedded && !onlySearch && (
        <h3>
          {onlyIdentity
            ? "SSO Client Secret"
            : onlyMessaging
              ? t("credentials.gateway")
              : t("credentials.title")}
        </h3>
      )}
      {!embedded && (
        <SettingsTabs
          label={t("credentials.categories")}
          value={tab}
          items={[
            ["identity", t("credentials.sso")],
            ["messaging", t("credentials.gateway")],
            ["search", t("credentials.search")],
          ]}
          onChange={(v) => {
            setTab(v);
            setRef("");
          }}
        />
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const config = structuredClone(c);
            config.identity.allowedOrigins = config.identity.allowedOrigins
              .map((s) => s.trim())
              .filter(Boolean);
            config.search.allowedOrigins = config.search.allowedOrigins
              .map((s) => s.trim())
              .filter(Boolean);
            await api("/admin/service-credentials", "PUT", {
              revision: data.revision,
              config,
            });
            const saved = await load();
            onSearchSaved?.(saved.config.search);
            setMessage(
              onlySearch
                ? t("credentials.searchSaved")
                : embedded
                  ? t("credentials.keysSaved")
                  : t("credentials.saved"),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="service-credentials-fields">
          {tab === "identity" && (
            <>
              <p className="admin-field-help">
                {t("credentials.identityHelp")}{" "}
                {!embedded && t("credentials.identityMore")}
              </p>
              {Object.entries(c.identity.credentials).map(([id, value]) => (
                <div className="service-credential-row" key={id}>
                  <header>
                    <strong>{id}</strong>
                    <button
                      type="button"
                      onClick={() =>
                        change((v) => {
                          delete v.identity.credentials[id];
                        })
                      }
                    >
                      {t("credentials.remove")}
                    </button>
                  </header>
                  <SecretField
                    label="Client Secret"
                    value={value}
                    onChange={(value) =>
                      change((v) => {
                        v.identity.credentials[id] = value;
                      })
                    }
                  />
                </div>
              ))}
              <Origins
                label={t("credentials.ssoOrigins")}
                values={c.identity.allowedOrigins}
                onChange={(values) =>
                  change((v) => {
                    v.identity.allowedOrigins = values;
                  })
                }
                placeholder="https://sso.example.com"
              />
            </>
          )}
          {tab === "identity" && (
            <div className="service-credential-add">
              <input
                aria-label={t("credentials.newName")}
                placeholder={t("credentials.namePlaceholder")}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
              <button type="button" onClick={add}>
                {t("credentials.add")}
              </button>
            </div>
          )}
          {tab === "messaging" && (
            <>
              <label>
                {t("credentials.gatewayUrl")}
                <input
                  type="url"
                  placeholder="https://messages.example.com/send"
                  value={c.messaging.endpoint}
                  onChange={(e) =>
                    change((v) => {
                      v.messaging.endpoint = e.target.value;
                    })
                  }
                />
              </label>
              <SecretField
                label={t("credentials.gatewayKey")}
                value={c.messaging.secret}
                onChange={(value) =>
                  change((v) => {
                    v.messaging.secret = value;
                  })
                }
              />
              <div className="service-channels">
                {(
                  [
                    ["phone", t("credentials.phone")],
                    ["email", t("credentials.email")],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={c.messaging.channels.includes(id)}
                      onChange={(e) =>
                        change((v) => {
                          v.messaging.channels = e.target.checked
                            ? [...v.messaging.channels, id]
                            : v.messaging.channels.filter((x) => x !== id);
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="admin-field-help">{t("credentials.gatewayHelp")}</p>
            </>
          )}
          {tab === "search" && (
            <>
              <SecretField
                label={t("credentials.searchKey")}
                value={c.search.apiKey}
                onChange={(value) =>
                  change((v) => {
                    v.search.apiKey = value;
                  })
                }
              />
              {onlySearch && <small>{t("credentials.keepKey")}</small>}
              <details
                open={onlySearch ? undefined : true}
                className={onlySearch ? "search-settings-details" : undefined}
              >
                <summary hidden={!onlySearch}>
                  {t("credentials.advanced")}
                </summary>
                <Origins
                  label={t("credentials.searchOrigins")}
                  values={c.search.allowedOrigins}
                  onChange={(values) =>
                    change((v) => {
                      v.search.allowedOrigins = values;
                    })
                  }
                  placeholder="http://127.0.0.1:7700"
                />
              </details>
              {!onlySearch && (
                <p className="admin-field-help">
                  {t("credentials.searchHelp")}
                </p>
              )}
            </>
          )}
        </fieldset>
        <Feedback
          message={error || message}
          tone={error ? "error" : "success"}
        />
        <footer>
          <button className="primary" disabled={busy}>
            {busy
              ? t("credentials.saving")
              : onlySearch
                ? t("credentials.saveSearch")
                : embedded
                  ? t("credentials.saveKeys")
                  : t("credentials.save")}
          </button>
        </footer>
      </form>
    </section>
  );
}
