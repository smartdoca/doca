import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Select } from "@web/shared/components/select.js";
import {
  VerificationField,
  compactProofs,
  fieldLabels,
  type AccountOptions,
  type Proofs,
} from "@web/features/auth/account-fields.js";
export function AccountPolicySettings({
  section = "login",
}: {
  section?: string;
}) {
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
      <h3>{section === "registration" ? "验证码注册" : "基础登录方式"}</h3>
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
              setMessage("账号策略已保存");
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
                  ["passwordEnabled", "允许账号密码登录"],
                  ["smsEnabled", "允许手机验证码登录"],
                  ["emailEnabled", "允许邮箱验证码登录"],
                  ["qrLoginEnabled", "允许 App 扫码登录"],
                  ["recoveryEnabled", "允许找回密码"],
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
                  <legend>密码登录可使用的账号</legend>
                  <p className="admin-field-help">
                    选择用户可填入账号栏的信息。用户名与手机号或邮箱相同时，任意对应选项启用即可登录。
                  </p>
                  {(
                    [
                      ["username", "用户名"],
                      ["phone", "手机号"],
                      ["email", "邮箱"],
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
              <label>
                强制用户补充登录方式
                <Select
                  value={data.forcedLoginMethod ?? ""}
                  onChange={(e) =>
                    setData({
                      ...data,
                      forcedLoginMethod: e.target.value || null,
                    })
                  }
                >
                  <option value="">不强制（新增方式默认如此）</option>
                  {data.passwordEnabled && <option value="password">账号密码</option>}
                  {data.smsEnabled && data.phoneReady && <option value="phone">手机验证码</option>}
                  {data.emailEnabled && data.emailReady && <option value="email">邮箱验证码</option>}
                  {providers.map((provider) => (
                    <option value={`provider:${provider.id}`} key={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
                <small>
                  仅用于替换旧登录方式：先让用户补充完成，再关闭旧方式。
                </small>
              </label>
            </>
          )}
          <label hidden={section !== "registration"}>
            手机验证码首次注册
            <Select
              value={data.smsRegistration ?? "closed"}
              onChange={(e) =>
                setData({ ...data, smsRegistration: e.target.value })
              }
            >
              <option value="closed">不允许新用户加入</option>
              <option value="auto">自动注册，直接使用</option>
              <option value="approval">注册后需管理员审核</option>
            </Select>
          </label>
          <label hidden={section !== "registration"}>
            邮箱验证码首次注册
            <Select
              value={data.emailRegistration ?? "closed"}
              onChange={(e) =>
                setData({ ...data, emailRegistration: e.target.value })
              }
            >
              <option value="closed">不允许新用户加入</option>
              <option value="auto">自动注册，直接使用</option>
              <option value="approval">注册后需管理员审核</option>
            </Select>
          </label>
          <p className="admin-field-help" hidden={section !== "login"}>
            短信服务：{data.phoneReady ? "已配置" : "未配置"} · 邮件服务：
            {data.emailReady ? "已配置" : "未配置"}
            。关闭密码认证前，请先给当前管理员绑定其他可用登录方式。
          </p>
          <button className="primary" disabled={busy}>
            保存账号策略
          </button>
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
  const p = JSON.parse(value || "{}"),
    [fieldPolicy, setFieldPolicy] = useState<AccountOptions | null>(null),
    [levels, setLevels] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void api<AccountOptions>("/admin/accounts/policy")
      .then(setFieldPolicy)
      .catch(() => {});
    void api<{ levels: typeof levels }>("/admin/entitlements")
      .then((r) => setLevels(r.levels))
      .catch(() => {});
  }, []);
  const update = (v: Record<string, unknown>) =>
    onChange(JSON.stringify({ ...p, ...v }));
  const lm = {
    field: "",
    sync: true,
    fallback: "standard",
    rules: {},
    ...p.levelMapping,
  };
  return (
    <div className="source-fields admin-settings-form">
      <div hidden={section !== "policy"}>
        <label>
          此身份源首次加入策略
          <Select
            value={p.signup ?? "inherit"}
            onChange={(e) => update({ signup: e.target.value })}
          >
            <option value="inherit">使用该类身份源的默认策略</option>
            <option value="closed">不允许新用户加入</option>
            <option value="auto">自动注册，直接使用</option>
            <option value="approval">注册后需管理员审核</option>
          </Select>
        </label>
      </div>
      <div hidden={section !== "fields"}>
        <h3>注册资料映射</h3>
        <p>
          手机号和邮箱全局唯一。SSO
          返回的值若已被其他账号占用，会阻止注册或同步，不会自动合并账号。
          每个字段只能指定一个来源。修改规则统一在“用户字段”配置；仅 SSO
          更新的字段每次登录同步，禁用或不可修改的字段不会同步。
        </p>
        <div className="source-mapping-head">
          <span>资料</span>
          <span>来源字段（选填）</span>
          <span>修改规则</span>
          <span>登录同步</span>
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
                  aria-label={`${label}来源字段`}
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
                    ? "已指定其他来源"
                    : {
                        editable: "支持修改",
                        sso: "仅 SSO 更新",
                        immutable: "不允许修改",
                      }[global?.mode ?? "editable"]}
                </span>
                {key === "username" ? (
                  <span className="admin-field-help">固定账号</span>
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
                    <span className="sr-only">{label}登录时同步</span>
                  </label>
                )}
                {["email", "phone"].includes(key) && (
                  <input
                    aria-label={`${label}已验证字段`}
                    className="source-verification-field"
                    placeholder={
                      key === "email"
                        ? "已验证标记（选填），如 email_verified"
                        : "已验证标记（选填），如 phone_number_verified"
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
            {"允许此来源账号追加第三方绑定"}
          </label>
        ))}
      </div>
      <div hidden={section !== "levels"}>
        <h3>永久基础等级与身份分类</h3>
        <label>
          来源字段
          <input
            value={lm.field}
            placeholder="例如 employment_type，留空使用本站默认等级"
            onChange={(e) =>
              update({ levelMapping: { ...lm, field: e.target.value } })
            }
          />
        </label>
        {lm.field && (
          <>
            <label>
              未匹配时的基础等级
              <Select
                value={lm.fallback}
                onChange={(e) =>
                  update({ levelMapping: { ...lm, fallback: e.target.value } })
                }
              >
                {levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={lm.sync}
                onChange={(e) =>
                  update({ levelMapping: { ...lm, sync: e.target.checked } })
                }
              />
              每次通过此来源登录时同步
            </label>
            {Object.entries(lm.rules).map(([key, v]: [string, any]) => (
              <div className="source-field" key={key}>
                <strong>{key}</strong>
                <Select
                  value={v.levelId}
                  onChange={(e) =>
                    update({
                      levelMapping: {
                        ...lm,
                        rules: {
                          ...lm.rules,
                          [key]: { ...v, levelId: e.target.value },
                        },
                      },
                    })
                  }
                >
                  {levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
                <input
                  aria-label={`${key}身份分类`}
                  placeholder="身份分类，例如 employee"
                  value={v.identityClass}
                  onChange={(e) =>
                    update({
                      levelMapping: {
                        ...lm,
                        rules: {
                          ...lm.rules,
                          [key]: { ...v, identityClass: e.target.value },
                        },
                      },
                    })
                  }
                />
                <button
                  type="button"
                  onClick={() => {
                    const rules = { ...lm.rules };
                    delete rules[key];
                    update({ levelMapping: { ...lm, rules } });
                  }}
                >
                  移除
                </button>
              </div>
            ))}
            <MappingAdd
              add={(key) => {
                if (!["__proto__", "constructor", "prototype"].includes(key))
                  update({
                    levelMapping: {
                      ...lm,
                      rules: {
                        ...lm.rules,
                        [key]: { levelId: lm.fallback, identityClass: "" },
                      },
                    },
                  });
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
function MappingAdd({ add }: { add: (key: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="verification-code">
      <input
        aria-label="新的来源值"
        placeholder="来源返回值，例如 employee"
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
      >
        添加映射
      </button>
    </div>
  );
}
export function AccountContacts() {
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
      <h2>手机号与邮箱</h2>
      {data?.contacts.map((c) => (
        <p key={c.kind}>
          {fieldLabels[c.kind]}：{c.value} · 已验证
          {data.editable[c.kind] === false ? " · 不可自行修改" : ""}
        </p>
      ))}
      <p className="subtle">
        绑定或更换联系方式需在最近 5
        分钟内验证身份。新联系方式不能已属于其他账号。
      </p>

      <select
        value={kind}
        onChange={(e) => {
          setKind(e.target.value as "phone" | "email");
          setValue("");
          setProof("");
        }}
      >
        {data?.policy.fields?.email.enabled !== false && (
          <option value="email">邮箱</option>
        )}
        {data?.policy.fields?.phone.enabled !== false && (
          <option value="phone">手机号</option>
        )}
      </select>
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
            setMessage("联系方式已保存");
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        保存联系方式
      </button>
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
      title="编辑用户信息"
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
          <p className="admin-field-help">
            管理员可直接纠正手机号和邮箱，无需验证码。 修改会记录到操作日志。
          </p>
          <label className="setting-toggle">
            <span>
              <strong>系统管理员</strong>
              <small>允许管理用户和平台配置，不授予私有文档权限。</small>
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
              <summary>身份源同步</summary>
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
                    />
                    恢复{fieldLabels[key]}的来源同步
                  </label>
                ))}
            </details>
          )}
          <label>
            调整原因 *
            <textarea
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：用户原手机号已停用，协助更换联系方式"
            />
          </label>
          <details className="admin-form-section">
            <summary>最近操作记录</summary>
            {data.audit.length ? (
              data.audit.map((a: any) => (
                <p className="admin-field-help" key={a.id}>
                  {new Date(a.created_at).toLocaleString()} · {a.action}
                </p>
              ))
            ) : (
              <p className="admin-field-help">暂无记录</p>
            )}
          </details>
          <Feedback message={message} tone="error" />
          <footer>
            <button type="button" disabled={busy} onClick={close}>
              取消
            </button>
            <button className="primary" disabled={busy}>
              保存用户信息
            </button>
          </footer>
        </form>
      )}
      {!data && (
        <Feedback
          message={message || "正在加载…"}
          tone={message ? "error" : "info"}
        />
      )}
    </Dialog>
  );
}
