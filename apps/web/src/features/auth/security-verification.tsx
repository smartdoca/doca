import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { VerificationField } from "@web/features/auth/account-fields.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
export function SecurityVerification() {
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
      setMessage("安全验证通过，5 分钟内可完成一项修改。");
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
      <strong>安全验证{data?.verified ? " · 已通过" : ""}</strong>
      <p className="admin-field-help">
        任选一种已绑定方式验证，再修改认证信息。
      </p>
      {data && !data.methods.length && (
        <p>没有可用的安全验证方式，请联系系统管理员纠错。</p>
      )}
      {!!data?.methods.length && (
        <>
          <Select
            aria-label="安全验证方式"
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
              setMessage("");
            }}
          >
            {data.methods.map((m) => (
              <option value={m.id} key={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
          {method === "password" ? (
            <div className="admin-inline-actions">
              <input
                aria-label="安全验证当前密码"
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
              >
                验证身份
              </button>
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
            >
              使用原绑定账号验证
            </button>
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
        >
          重新验证
        </button>
      )}
      <Feedback message={message} tone="info" />
    </div>
  );
}
