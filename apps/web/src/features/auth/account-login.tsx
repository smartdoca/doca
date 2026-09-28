import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { Monitor, QrCode } from "lucide-react";
import { api, type Bootstrap } from "@web/shared/api.js";
import { ExternalLoginOptions } from "@web/features/auth/authentication.js";
import { QrLogin } from "@web/features/auth/qr-login.js";
import { Feedback } from "@web/shared/components/feedback.js";
import {
  VerificationField,
  RegistrationFields,
  ContactRequirements,
  compactProofs,
  type Proofs,
  type AccountOptions,
  type RegistrationField,
} from "@web/features/auth/account-fields.js";
export function AccountLogin({
  bootstrap,
  logged,
}: {
  bootstrap: Bootstrap;
  logged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<AccountOptions | null>(null),
    [mode, setMode] = useState("password"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [phone, setPhone] = useState(""),
    [proofs, setProofs] = useState<Proofs>({}),
    [fields, setFields] = useState<RegistrationField[] | null>(null),
    [values, setValues] = useState<Record<string, string>>({}),
    [recoveryKind, setRecoveryKind] = useState<"email" | "phone">("email"),
    [recoveryValue, setRecoveryValue] = useState(""),
    [scanning, setScanning] = useState(false);
  useEffect(() => {
    void api<AccountOptions>("/auth/options")
      .then((o) => {
        setOptions(o);
        if (!o.passwordEnabled)
          setMode(o.smsEnabled ? "sms" : o.emailEnabled ? "email" : "external");
      })
      .catch((e) => setError(e.message));
  }, []);
  const register = mode === "register",
    recover = mode === "recover",
    qrAvailable =
      Boolean(options?.qrLoginEnabled) && !register && !recover && !fields,
    scanningView = scanning && qrAvailable;
  function switchMode(value: string) {
    setMode(value);
    setScanning(false);
    setProofs({});
    setFields(null);
    setValues({});
    setError("");
  }
  async function completeSms(body?: Record<string, unknown>) {
    const r = await api<{
      status: string;

      fields?: RegistrationField[];
    }>(
      mode === "email" ? "/auth/email/complete" : "/auth/sms/complete",
      "POST",
      body,
    );
    if (r.status === "needs_profile") {
      setFields(r.fields!);
      setValues(Object.fromEntries(r.fields!.map((f) => [f.key, f.value])));
      setProofs({});
    } else if (r.status === "pending") {
      switchMode(mode === "email" ? "email" : "sms");
      setError(t("login.pendingReview"));
    } else await logged();
  }
  return (
    <main className="auth">
      <section className="auth-story">
        <h1>
          {t("login.headline")}
          <br />
          {t("login.headlineRest")}
        </h1>
        <p>
          {t("login.tagline")}
          <br />
          {t("login.taglineRest")}
        </p>
      </section>
      <form
        className={
          scanningView
            ? "auth-card account-login-card is-scanning"
            : "auth-card account-login-card"
        }
        onSubmit={async (e) => {
          e.preventDefault();
          if (scanningView) return;
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            if (fields)
              await completeSms({ ...values, proofs: compactProofs(proofs) });
            else if (mode === "sms" || mode === "email") {
              const r = await api<{ status: string }>(
                mode === "email" ? "/auth/email" : "/auth/sms",
                "POST",
                {
                  proof: proofs[mode === "email" ? "email" : "phone"],
                },
              );
              if (r.status === "needs_profile") await completeSms();
              else if (r.status === "pending")
                setError(t("login.pendingReview"));
              else await logged();
            } else if (recover) {
              await api("/auth/recover", "POST", {
                kind: recoveryKind,
                proof: proofs[recoveryKind],
                password: f.get("password"),
              });
              switchMode("password");
              setError(t("login.passwordReset"));
            } else if (register) {
              const r = await api<{ status: string }>(
                "/auth/register",
                "POST",
                {
                  ...Object.fromEntries(
                    Object.entries(values).filter(
                      ([key]) => key !== "username",
                    ),
                  ),
                  login:
                    options?.fields?.username.source === "phone"
                      ? values.phone
                      : options?.fields?.username.source === "email"
                        ? values.email
                        : values.username,
                  password: values.password,
                  proofs: compactProofs(proofs),
                },
              );
              if (r.status === "pending") {
                switchMode("password");
                setError(t("login.pendingShort"));
              } else await logged();
            } else {
              const r = await api<{ status?: string }>("/auth/login", "POST", {
                login: f.get("login"),
                password: f.get("password"),
              });
              if (r.status === "pending")
                setError(t("login.waiting"));
              else await logged();
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {qrAvailable && (
          <button
            type="button"
            className="qr-corner"
            aria-pressed={scanningView}
            onClick={() => setScanning((value) => !value)}
          >
            <span className="qr-corner-tip">
              {scanningView ? t("login.account") : t("login.scan")}
            </span>
            <span className="qr-corner-mark" aria-hidden="true">
              {scanningView ? (
                <Monitor size={24} strokeWidth={1.75} />
              ) : (
                <QrCode size={24} strokeWidth={1.75} />
              )}
            </span>
          </button>
        )}
        <div className="auth-card-body" inert={scanningView}>
        <span className="eyebrow">{bootstrap.siteName}</span>
        <h2>
          {fields
            ? t("login.finishRegister")
            : register
              ? t("login.createAccount")
              : recover
                ? t("login.recoverAccount")
                : t("login.welcome")}
        </h2>
        {!bootstrap.initialized && <p>{t("login.needInit")}</p>}
        {options && !register && !recover && !fields && (
          <div className="account-login-tabs">
            {options.passwordEnabled && (
              <button
                type="button"
                aria-pressed={mode === "password"}
                onClick={() => switchMode("password")}
              >
                {t("login.passwordTab")}
              </button>
            )}
            {options.emailEnabled && (
              <button
                type="button"
                aria-pressed={mode === "email"}
                onClick={() => switchMode("email")}
              >
                {t("login.emailCode")}
              </button>
            )}
            {options.smsEnabled && (
              <button
                type="button"
                aria-pressed={mode === "sms"}
                onClick={() => switchMode("sms")}
              >
                {t("login.smsCode")}
              </button>
            )}
          </div>
        )}
        {fields ? (
          <RegistrationFields
            fields={fields}
            values={values}
            setValues={setValues}
            proofs={proofs}
            setProofs={setProofs}
          />
        ) : mode === "sms" || mode === "email" ? (
          <VerificationField
            key={mode}
            kind={mode === "email" ? "email" : "phone"}
            purpose="login"
            value={phone}
            onValue={setPhone}
            onProof={(v) =>
              setProofs({ [mode === "email" ? "email" : "phone"]: v })
            }
            required
          />
        ) : register && options?.fields ? (
          <RegistrationFields
            fields={[
              ...Object.entries(options.fields)
                .filter(([, r]) => r.enabled)
                .map(([key, r]) => ({
                  key,
                  value: "",
                  required:
                    r.required || key === options.fields?.username.source,
                  editable: true,
                  ...(key === "username" && r.source !== "manual"
                    ? { derivedFrom: r.source }
                    : {}),
                })),
              { key: "password", value: "", required: true, editable: true },
            ]}
            values={values}
            setValues={setValues}
            proofs={proofs}
            setProofs={setProofs}
          />
        ) : recover ? (
          <>
            <label>
              {t("login.recoverVia")}
              <select
                value={recoveryKind}
                onChange={(e) => {
                  setRecoveryKind(e.target.value as "email" | "phone");
                  setProofs({});
                  setRecoveryValue("");
                }}
              >
                {options?.emailReady &&
                  options.securityMethods?.includes("email") && (
                    <option value="email">{t("login.email")}</option>
                  )}
                {options?.phoneReady &&
                  options.securityMethods?.includes("phone") && (
                    <option value="phone">{t("login.phone")}</option>
                  )}
              </select>
            </label>
            <VerificationField
              key={recoveryKind}
              kind={recoveryKind}
              purpose="recovery"
              value={recoveryValue}
              onValue={setRecoveryValue}
              onProof={(v) => setProofs({ [recoveryKind]: v })}
              required
            />
          </>
        ) : mode !== "external" && (
            <>
              {register && (
                <>
                  <p>{t("login.publicIdHint")}</p>
                  <label>
                    {t("login.nickname")}
                    <input
                      name="name"
                      required
                      maxLength={160}
                      autoComplete="name"
                    />
                  </label>
                </>
              )}
              <label>
                {register
                  ? t("login.username")
                  : (options?.passwordIdentifiers ?? ["username"])
                      .filter(
                        (k) =>
                          k === "username" ||
                          options?.fields?.[k as "phone" | "email"]?.enabled,
                      )
                      .map(
                        (k) =>
                          ({
                            username: t("login.username"),
                            phone: t("login.phone"),
                            email: t("login.email"),
                          })[k],
                      )
                      .join(" / ")}
                <input
                  name="login"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={254}
                />
              </label>
              {register && options && (
                <ContactRequirements
                  options={options}
                  proofs={proofs}
                  setProofs={setProofs}
                  onlyRequired
                />
              )}
            </>
        )}
        {!fields && ["password", "recover"].includes(mode) && (
          <label>
            {recover ? t("login.newPassword") : t("login.password")}
            <input
              name="password"
              type="password"
              required
              minLength={mode === "password" ? 1 : 12}
              maxLength={128}
              autoComplete={
                mode === "password" ? "current-password" : "new-password"
              }
            />
          </label>
        )}
        <Feedback message={error} tone="error" />
        {mode !== "external" && (
          <button
            className="primary"
            disabled={
              busy ||
              !options ||
              !bootstrap.initialized ||
              (["sms", "email"].includes(mode) &&
                !fields &&
                !proofs[mode === "email" ? "email" : "phone"]) ||
              (recover && !proofs[recoveryKind])
            }
          >
            {busy
              ? t("login.wait")
              : fields
                ? t("login.continue")
                : register
                  ? t("login.register")
                  : recover
                    ? t("login.reset")
                    : t("login.submit")}
          </button>
        )}
        {options?.passwordEnabled &&
          bootstrap.registrationEnabled &&
          !options.fields?.username.source.startsWith("provider:") &&
          !fields && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                switchMode(register || recover ? "password" : "register")
              }
            >
              {register || recover ? t("login.back") : t("login.createAccount")}
            </button>
          )}
        {options?.passwordEnabled &&
          options.recoveryEnabled &&
          (options.phoneReady || options.emailReady) &&
          mode === "password" && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setRecoveryKind(
                  options.emailReady &&
                    options.securityMethods?.includes("email")
                    ? "email"
                    : "phone",
                );
                switchMode("recover");
              }}
            >
              {t("login.forgot")}
            </button>
          )}
        {!register && !recover && !fields && <ExternalLoginOptions />}
        </div>
        {scanningView && (
          <div className="qr-login-overlay">
            <h2>{t("login.scanTitle")}</h2>
            <QrLogin logged={logged} />
          </div>
        )}
      </form>
    </main>
  );
}
