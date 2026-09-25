import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useFieldLabels, type AccountOptions } from "@web/features/auth/account-fields.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import {
  userFields,
  type UserFields,
} from "@core/modules/identity/field-policy.js";
export function UserFieldSettings({
  security = false,
}: {
  security?: boolean;
}) {
const { t, locale } = useI18n();

const fieldLabels = useFieldLabels();

  const [data, setData] = useState<AccountOptions | null>(null),
    [providers, setProviders] = useState<{ id: string; name: string }[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      api<AccountOptions>("/admin/accounts/policy"),
      api<{ providers: typeof providers }>("/admin/auth"),
    ])
      .then(([a, b]) => {
        setData({ ...a, fields: userFields(a) });
        setProviders(b.providers);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  return (
    <section className="admin-card">
      <h3>{security ? t("fields.securityTitle") : t("fields.title")}</h3>
      <p className="admin-field-help">
        {security
          ? t("fields.securityHelp")
          : t("fields.help")}
      </p>
      {data && (
        <form
          className="admin-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const { phoneReady, emailReady, ...body } = data;
              await api("/admin/accounts/policy", "PUT", {
                ...body,
              });
              setData(await api("/admin/accounts/policy"));
              setMessage(t("common.settingsSaved"));
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {security ? (
            (
              [
                ["password", t("fields.currentPassword")],
                ["phone", t("fields.linkedPhone")],
                ["email", t("fields.linkedEmail")],
                ...providers.map((p) => [`provider:${p.id}`, p.name]),
              ] as [string, string][]
            ).map(([id, label]) => (
              <label className="setting-toggle" key={id}>
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={data.securityMethods?.includes(id) ?? false}
                  onChange={(e) =>
                    setData({
                      ...data,
                      securityMethods: e.target.checked
                        ? [...(data.securityMethods ?? []), id]
                        : (data.securityMethods ?? []).filter((m) => m !== id),
                    })
                  }
                />
              </label>
            ))
          ) : (
            <div className="user-fields-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("fields.field")}</th>
                    <th>{t("users.enable")}</th>
                    <th>{t("fields.required")}</th>
                    <th>{t("fields.editability")}</th>
                    <th>{t("fields.source")}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.fields!).map(([key, f]) => {
                    const set = (v: Partial<typeof f>) =>
                      setData({
                        ...data,
                        fields: { ...data.fields!, [key]: { ...f, ...v } },
                      });
                    return (
                      <tr key={key}>
                        <td>{fieldLabels[key]}</td>
                        <td>
                          <input
                            aria-label={t("fields.enabledLabel", { name: fieldLabels[key]! })}
                            type="checkbox"
                            disabled={key === "username"}
                            checked={f.enabled}
                            onChange={(e) =>
                              set({
                                enabled: e.target.checked,
                                ...(!e.target.checked
                                  ? { required: false }
                                  : {}),
                              })
                            }
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t("fields.requiredLabel", { name: fieldLabels[key]! })}
                            disabled={key === "username" || !f.enabled}
                            checked={f.required}
                            onChange={(e) =>
                              set({ required: e.target.checked })
                            }
                          />
                        </td>
                        <td>
                          <Select
                            aria-label={t("fields.editabilityLabel", { name: fieldLabels[key]! })}
                            disabled={key === "username" || !f.enabled}
                            value={f.mode}
                            onChange={(e) =>
                              set({ mode: e.target.value as any })
                            }
                          >
                            <option value="editable">{t("accountPolicy.editable")}</option>
                            <option value="sso">{t("accountPolicy.ssoOnly")}</option>
                            <option value="immutable">{t("accountPolicy.immutable")}</option>
                          </Select>
                        </td>
                        <td>
                          <Select
                            aria-label={t("fields.sourceLabel", { name: fieldLabels[key]! })}
                            disabled={!f.enabled}
                            value={f.source}
                            onChange={(e) => set({ source: e.target.value })}
                          >
                            <option value="manual">{t("fields.manual")}</option>
                            {key === "username" && (
                              <>
                                <option value="phone">{t("fields.verifiedPhone")}</option>
                                <option value="email">{t("fields.verifiedEmail")}</option>
                              </>
                            )}
                            {providers.map((p) => (
                              <option key={p.id} value={`provider:${p.id}`}>
                                {p.name}
                              </option>
                            ))}
                          </Select>
                          {["phone", "email"].includes(key) &&
                            f.source.startsWith("provider:") && (
                              <small className="admin-field-help">{t("fields.uniqueHelp")}</small>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <button className="primary" disabled={busy}>{t(security ? "fields.saveSecurity" : "fields.saveFields")}
          </button>
        </form>
      )}
      <Feedback message={message} tone="info" />
    </section>
  );
}
