import { useI18n } from "@web/shared/i18n.js";
import type { UserFields } from "@core/modules/identity/field-policy.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { SecurityVerification } from "@web/features/auth/security-verification.js";
export type ContactKind = "email" | "phone";
export type Proofs = Partial<Record<ContactKind, string>>;
export type AccountOptions = {
  fields?: UserFields;
  securityMethods?: string[];
  passwordIdentifiers?: string[];
  emailEnabled?: boolean;
  emailRegistration?: string;
  smsRegistration?: string;
  passwordEnabled: boolean;
  smsEnabled: boolean;
  recoveryEnabled: boolean;
  qrLoginEnabled?: boolean;
  forcedLoginMethod?: string | null;
  availableLoginMethods?: { id: string; label: string }[];
  phoneReady?: boolean;
  emailReady?: boolean;
  revision: number;
};
export function useFieldLabels() {
 const { t } = useI18n();
 return {
  username: t("login.username"),
  password: t("login.password"),
  displayName: t("login.nickname"),
  email: t("fields.email"),
  phone: t("login.phone"),
  avatar: t("fields.avatar"),
 } as Record<string, string>;
}
export function VerificationField({
  kind,
  purpose = "profile",
  value,
  onValue,
  onProof,
  required = false,
  disabled = false,
  verified = false,
  readOnly = false,
}: {
  kind: ContactKind;
  purpose?: string;
  value: string;
  onValue: (value: string) => void;
  onProof: (proof: string) => void;
  required?: boolean;
  disabled?: boolean;
  verified?: boolean;
  readOnly?: boolean;
}) {
const { t, locale } = useI18n();

const fieldLabels = useFieldLabels();

  const [challenge, setChallenge] = useState(""),
    [code, setCode] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState("");
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="account-verification" disabled={busy || disabled}>
      <label>
        {fieldLabels[kind]}
        {required ? " *" : ""}
        <input
          type={kind === "email" ? "email" : "tel"}
          autoComplete={kind === "email" ? "email" : "tel"}
          required={required}
          readOnly={readOnly}
          maxLength={254}
          value={value}
          placeholder={
            kind === "phone" ? "+86 13800138000" : "name@example.com"
          }
          onChange={(e) => {
            onValue(e.target.value);
            onProof("");
            setConfirmed("");
            setChallenge("");
          }}
        />
      </label>
      {verified || (confirmed === value && !!value) ? (
        <small>{t("fields.verified")}</small>
      ) : (
        !disabled && (
          <>
            <button
              type="button"
              disabled={!value || busy}
              onClick={() =>
                void run(async () => {
                  const r = await api<{ challengeId: string }>(
                    "/auth/challenges",
                    "POST",
                    { kind, value, purpose },
                  );
                  setChallenge(r.challengeId);
                  setCode("");
                  setMessage(t("fields.codeSent"));
                })
              }
            >
              {challenge ? t("fields.resend") : t("fields.sendCode")}
            </button>
            {challenge && (
              <div className="verification-code">
                <input
                  aria-label={t("fields.verificationCode", { name: fieldLabels[kind]! })}
                  value={code}
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={t("fields.codeHint")}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button
                  type="button"
                  disabled={code.length !== 6}
                  onClick={() =>
                    void run(async () => {
                      const r = await api<{ proof: string }>(
                        "/auth/challenges/verify",
                        "POST",
                        { challengeId: challenge, code },
                      );
                      onProof(r.proof);
                      setConfirmed(value);
                      setMessage("");
                    })
                  }
                >{t("fields.verify")}</button>
              </div>
            )}
          </>
        )
      )}
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}
export type RegistrationField = {
  key: string;
  value: string;
  required: boolean;
  editable: boolean;
  verified?: boolean;
  derivedFrom?: string;
};
export function RegistrationFields({
  fields,
  values,
  setValues,
  proofs,
  setProofs,
}: {
  fields: RegistrationField[];
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
  proofs: Proofs;
  setProofs: (v: Proofs) => void;
}) {
const { t, locale } = useI18n();

const fieldLabels = useFieldLabels();

  return (
    <>
      <p className="subtle">{t("fields.usernameHelp")}</p>
      {fields
        .filter((f) => !f.derivedFrom)
        .map((f) =>
          f.key === "phone" || f.key === "email" ? (
            <VerificationField
              key={f.key}
              kind={f.key}
              value={values[f.key] ?? f.value}
              onValue={(v) => setValues({ ...values, [f.key]: v })}
              onProof={(p) => setProofs({ ...proofs, [f.key]: p })}
              required={f.required}
              readOnly={!f.editable}
              verified={f.verified && (values[f.key] ?? f.value) === f.value}
            />
          ) : (
            <label key={f.key}>
              {fieldLabels[f.key]}
              {f.required ? " *" : ""}
              <input
                required={f.required}
                type={
                  f.key === "password"
                    ? "password"
                    : f.key === "avatar"
                      ? "url"
                      : "text"
                }
                autoComplete={f.key === "password" ? "new-password" : undefined}
                minLength={f.key === "password" ? 12 : undefined}
                readOnly={!f.editable}
                value={values[f.key] ?? f.value}
                maxLength={f.key === "avatar" ? 2048 : 160}
                onChange={(e) =>
                  setValues({ ...values, [f.key]: e.target.value })
                }
              />
              {!f.editable && <small>{t("fields.providerLocked")}</small>}
            </label>
          ),
        )}
    </>
  );
}
export function ContactRequirements({
  options,
  proofs,
  setProofs,
  purpose = "profile",
  editable,
}: {
  options: AccountOptions;
  proofs: Proofs;
  setProofs: (p: Proofs) => void;
  purpose?: string;
  editable?: Record<string, boolean>;
}) {
  const [email, setEmail] = useState(""),
    [phone, setPhone] = useState("");
  return (
    <>
      {(options.fields?.email.required || options.emailReady) &&
        options.fields?.email.enabled !== false && (
          <VerificationField
            kind="email"
            purpose={purpose}
            value={email}
            onValue={setEmail}
            onProof={(v) => setProofs({ ...proofs, email: v })}
            required={options.fields?.email.required}
            disabled={editable?.email === false}
          />
        )}{" "}
      {(options.fields?.phone.required || options.phoneReady) &&
        options.fields?.phone.enabled !== false && (
          <VerificationField
            kind="phone"
            purpose={purpose}
            value={phone}
            onValue={setPhone}
            onProof={(v) => setProofs({ ...proofs, phone: v })}
            required={options.fields?.phone.required}
            disabled={editable?.phone === false}
          />
        )}
    </>
  );
}
export function AccountOnboarding({ done }: { done: () => Promise<void> }) {
const { t, locale } = useI18n();

  const [data, setData] = useState<{
      policy: AccountOptions;
      editable: Record<string, boolean>;
    } | null>(null),
    [proofs, setProofs] = useState<Proofs>({}),
    [value, setValue] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<NonNullable<typeof data>>("/me/account")
      .then(setData)
      .catch((e) => setMessage(e.message));
  }, []);
  return (
    <main className="auth">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (data?.policy.forcedLoginMethod === "password")
              await api("/auth/password/setup", "POST", { password: value });
            else if (!data?.policy.forcedLoginMethod?.startsWith("provider:"))
              await api("/me/onboarding", "POST", {
                proofs: Object.fromEntries(
                  Object.entries(proofs).filter(([, v]) => v),
                ),
              });
            await done();
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{t("fields.complete")}</h2>
        <p>
          {data?.policy.forcedLoginMethod
            ? t("fields.methodRequired")
            : t("fields.contactsRequired")}{t("fields.lockedHelp")}</p>
        {data && (
          data.policy.forcedLoginMethod === "password" ? (
            <>
              <SecurityVerification />
              <label>{t("fields.sitePassword")}<input
                  type="password"
                  minLength={12}
                  maxLength={128}
                  required
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            </>
          ) : data.policy.forcedLoginMethod?.startsWith("provider:") ? (
            <>
              <SecurityVerification />
              <ForcedProviderLogin method={data.policy.forcedLoginMethod} />
            </>
          ) : (
            <>
              <ContactRequirements
                options={data.policy}
                editable={data.editable}
                proofs={proofs}
                setProofs={setProofs}
              />
              {data.policy.forcedLoginMethod && (
                <VerificationField
                  kind={data.policy.forcedLoginMethod as ContactKind}
                  purpose="profile"
                  value={value}
                  onValue={(v) => {
                    setValue(v);
                    setProofs({});
                  }}
                  onProof={(proof) =>
                    setProofs({
                      ...proofs,
                      [data.policy.forcedLoginMethod as ContactKind]: proof,
                    })
                  }
                  required
                />
              )}
            </>
          )
        )}
        <Feedback message={message} tone="error" />
        <button
          className="primary"
          hidden={!!data?.policy.forcedLoginMethod?.startsWith("provider:")}
          disabled={busy || !data}
        >{t("fields.saveContinue")}</button>
        <button
          type="button"
          onClick={async () => {
            await api("/auth/logout", "POST");
            await done();
          }}
        >{t("account.signOut")}</button>
      </form>
    </main>
  );
}
function ForcedProviderLogin({ method }: { method: string }) {
const { t } = useI18n();

  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]),
    [message, setMessage] = useState("");
  useEffect(() => {
    void api<{ items: { id: string; name: string }[] }>("/auth/providers")
      .then((r) => setProviders(r.items))
      .catch((e) => setMessage(e.message));
  }, []);
  const provider = providers.find((p) => `provider:${p.id}` === method);
  return (
    <>
      <p>{t("fields.linkRequired", { name: provider?.name ?? t("fields.specifiedProvider") })}</p>
      <button
        type="button"
        disabled={!provider}
        onClick={() => {
          void api<{ url: string }>(
            `/auth/providers/${method.slice(9)}/start`,
            "POST",
            { intent: "link" },
          )
            .then((r) => location.assign(r.url))
            .catch((e) => setMessage(e.message));
        }}
      >{t("fields.linkContinue")}</button>
      {message && <p role="status">{message}</p>}
    </>
  );
}
export const compactProofs = (p: Proofs) =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => !!v));
