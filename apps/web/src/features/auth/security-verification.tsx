import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { VerificationField } from "@web/features/auth/account-fields.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
export function SecurityVerification() {
const { t, locale } = useI18n();

  const [data, setData] = useState<{
      methods: { id: string; label: string; value: string }[];
      verified: boolean;
    } | null>(null),
    [generation, setGeneration] = useState(0),
    [method, setMethod] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const d = await api<NonNullable<typeof data>>("/me/security");
    setData(d);
    setMethod((old) =>
      d.methods.some((m) => m.id === old) ? old : (d.methods[0]?.id ?? ""),
    );
  }
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
    const changed = () => {
      setGeneration((v) => v + 1);
      setMessage("");
      void load().catch((e) => setMessage(e.message));
    };
    window.addEventListener("security-verification-changed", changed);
    return () =>
      window.removeEventListener("security-verification-changed", changed);
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setPassword("");
      await load();
      setMessage(t("security.success"));
    } catch (e) {
      setGeneration((v) => v + 1);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const current = data?.methods.find((m) => m.id === method);
  return (
    <div className="security-verification">
      <strong>{t("authAdmin.security")}{data?.verified ? t("security.passedSuffix") : ""}</strong>
      <p className="admin-field-help">{t("security.help")}</p>
      {data && !data.methods.length && (
        <p>{t("security.unavailable")}</p>
      )}
      {!!data?.methods.length && (
        <>
          <Select
            aria-label={t("security.method")}
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
              setMessage("");
            }}
          >
            {data.methods.map((m) => (
              <option value={m.id} key={m.id}>
                {m.id === "password" ? t("fields.currentPassword") : m.id === "phone" ? t("fields.linkedPhone") : m.id === "email" ? t("fields.linkedEmail") : m.label}
              </option>
            ))}
          </Select>
          {method === "password" ? (
            <div className="admin-inline-actions">
              <input
                aria-label={t("security.passwordLabel")}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                disabled={busy || !password}
                onClick={() =>
                  void act(() => api("/auth/reauth", "POST", { password }))
                }
              >{t("security.verify")}</button>
            </div>
          ) : method === "phone" || method === "email" ? (
            <VerificationField
              key={`${method}:${generation}`}
              kind={method}
              purpose="security"
              value={current?.value ?? ""}
              onValue={() => {}}
              readOnly
              onProof={(proof) => {
                if (proof)
                  void act(() =>
                    api("/auth/security/contact", "POST", {
                      kind: method,
                      proof,
                    }),
                  );
              }}
            />
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api<{ url: string }>(
                    `/auth/providers/${method.slice(9)}/start`,
                    "POST",
                    { intent: "security" },
                  );
                  location.assign(r.url);
                })
              }
            >{t("security.originalIdentity")}</button>
          )}
        </>
      )}
      {data?.verified && (
        <button
          type="button"
          onClick={() => {
            setGeneration((v) => v + 1);
            setData({ ...data, verified: false });
            setMessage("");
          }}
        >{t("security.retry")}</button>
      )}
      <Feedback message={message} tone="info" />
    </div>
  );
}
