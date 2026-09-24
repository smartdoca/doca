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
      setError("注册申请已提交，等待管理员审核后请重新登录。");
    } else await logged();
  }
  return (
    <main className="auth">
      <section className="auth-story">
        <h1>
          把知识留在
          <br />
          触手可及的地方。
        </h1>
        <p>
          个人记录，轻量共享。
          <br />
          你的文档与知识库，从这里开始。
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
                setError("注册申请已提交，等待管理员审核后请重新登录。");
              else await logged();
            } else if (recover) {
              await api("/auth/recover", "POST", {
                kind: recoveryKind,
                proof: proofs[recoveryKind],
                password: f.get("password"),
              });
              switchMode("password");
              setError("密码已重置，其他会话已退出，请重新登录。");
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
                setError("注册申请已提交，等待管理员审核。");
              } else await logged();
            } else {
              const r = await api<{ status?: string }>("/auth/login", "POST", {
                login: f.get("login"),
                password: f.get("password"),
              });
              if (r.status === "pending")
                setError("账号正在等待管理员审核，通过后请重新登录。");
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
              {scanningView ? "账号登录" : "扫码登录"}
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
            ? "完成注册"
            : register
              ? "创建账号"
              : recover
                ? "找回账号"
                : "欢迎回来"}
        </h2>
        {!bootstrap.initialized && <p>请先由部署管理员完成系统初始化。</p>}
        {options && !register && !recover && !fields && (
          <div className="account-login-tabs">
            {options.passwordEnabled && (
              <button
                type="button"
                aria-pressed={mode === "password"}
                onClick={() => switchMode("password")}
              >
                账号密码
              </button>
            )}
            {options.emailEnabled && (
              <button
                type="button"
                aria-pressed={mode === "email"}
                onClick={() => switchMode("email")}
              >
                邮箱验证码
              </button>
            )}
            {options.smsEnabled && (
              <button
                type="button"
                aria-pressed={mode === "sms"}
                onClick={() => switchMode("sms")}
              >
                短信验证码
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
              通过已绑定联系方式恢复
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
                    <option value="email">邮箱</option>
                  )}
                {options?.phoneReady &&
                  options.securityMethods?.includes("phone") && (
                    <option value="phone">手机号</option>
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
                  <p>请设置有意义的唯一用户ID，注册后仅系统管理员可纠错。</p>
                  <label>
                    昵称
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
                  ? "用户名（账号）"
                  : (options?.passwordIdentifiers ?? ["username"])
                      .filter(
                        (k) =>
                          k === "username" ||
                          options?.fields?.[k as "phone" | "email"]?.enabled,
                      )
                      .map(
                        (k) =>
                          ({
                            username: "用户名",
                            phone: "手机号",
                            email: "邮箱",
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
                />
              )}
            </>
        )}
        {!fields && ["password", "recover"].includes(mode) && (
          <label>
            {recover ? "新密码" : "密码"}
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
              ? "请稍候…"
              : fields
                ? "确认并继续"
                : register
                  ? "注册"
                  : recover
                    ? "重置密码"
                    : "登录"}
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
              {register || recover ? "返回登录" : "创建账号"}
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
              忘记密码
            </button>
          )}
        {!register && !recover && !fields && <ExternalLoginOptions />}
        </div>
        {scanningView && (
          <div className="qr-login-overlay">
            <h2>扫码登录</h2>
            <QrLogin logged={logged} />
          </div>
        )}
      </form>
    </main>
  );
}
