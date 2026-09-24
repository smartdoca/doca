import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { fieldLabels, type AccountOptions } from "@web/features/auth/account-fields.js";
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
      <h3>{security ? "基础安全验证" : "用户信息字段"}</h3>
      <p className="admin-field-help">
        {security
          ? "修改密码、联系方式或第三方绑定前，用户需通过下列已绑定方式中的任意一种。验证 5 分钟有效，每次用于一项修改。"
          : "必填和修改规则适用于所有登录方式。禁用字段不展示、不允许修改；空字段可首次补填，填写后按修改规则控制。手填用户名不能使用手机号或邮箱格式。"}
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
              setMessage("设置已保存");
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
                ["password", "当前密码"],
                ["phone", "已绑定手机号"],
                ["email", "已绑定邮箱"],
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
                    <th>字段</th>
                    <th>启用</th>
                    <th>必填</th>
                    <th>可修改性</th>
                    <th>唯一来源</th>
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
                            aria-label={`${fieldLabels[key]}启用`}
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
                            aria-label={`${fieldLabels[key]}必填`}
                            disabled={key === "username" || !f.enabled}
                            checked={f.required}
                            onChange={(e) =>
                              set({ required: e.target.checked })
                            }
                          />
                        </td>
                        <td>
                          <Select
                            aria-label={`${fieldLabels[key]}可修改性`}
                            disabled={key === "username" || !f.enabled}
                            value={f.mode}
                            onChange={(e) =>
                              set({ mode: e.target.value as any })
                            }
                          >
                            <option value="editable">支持修改</option>
                            <option value="sso">仅 SSO 更新</option>
                            <option value="immutable">不允许修改</option>
                          </Select>
                        </td>
                        <td>
                          <Select
                            aria-label={`${fieldLabels[key]}来源`}
                            disabled={!f.enabled}
                            value={f.source}
                            onChange={(e) => set({ source: e.target.value })}
                          >
                            <option value="manual">用户填写</option>
                            {key === "username" && (
                              <>
                                <option value="phone">已验证手机号</option>
                                <option value="email">已验证邮箱</option>
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
                              <small className="admin-field-help">
                                全局唯一；SSO 返回重复值将无法注册或同步。
                              </small>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <button className="primary" disabled={busy}>
            保存{security ? "安全验证" : "用户字段"}
          </button>
        </form>
      )}
      <Feedback message={message} tone="info" />
    </section>
  );
}
