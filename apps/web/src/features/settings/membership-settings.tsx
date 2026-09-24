import { AICreditsAdmin } from "@web/features/ai/ai-credits-admin.js";
import { MembershipIconPicker } from "@web/features/settings/membership-icon-picker.js";
import { MembershipLevels, type Level } from "@web/features/settings/membership-levels.js";
import { MembershipLink } from "@web/features/settings/membership-link.js";
import { MembershipIcon } from "@web/features/settings/membership-icon.js";
import { SourceLevelSettings } from "@web/features/settings/source-level-settings.js";
import { SettingsTabs } from "@web/features/settings/settings-tabs.js";
import { MembershipIntegration } from "@web/features/settings/membership-integration.js";
import { useEffect, useState } from "react";
import { api, type Me } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Select } from "@web/shared/components/select.js";
type Config = {
  revision: number;
  levels: Level[];
  rules: Record<
    string,
    { enabled: boolean; minLevel: string; classes: string[] }
  >;
  defaultLevel: string;
  timezone: string;
  showLevel: boolean;
  showExpiry: boolean;
  showVip: boolean;
  vipUrl: string;
  vipLabel: string;
  vipIcon: string;
  externalPlans: Record<string, string>;
  capabilities: [string, string, string, boolean][];
  quotas: [string, string, string][];
  membershipReady: boolean;
};
export function MembershipSettings() {
  const [data, setData] = useState<Config | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [plan, setPlan] = useState(""),
    [tab, setTab] = useState("levels");
  useEffect(() => {
    void api<Config>("/admin/entitlements")
      .then(setData)
      .catch((e) => setMessage(e.message));
  }, []);
  async function saveConfig(next: Config) {
    setBusy(true);
    setMessage("");
    try {
      const { revision, capabilities, quotas, membershipReady, ...config } =
        next;
      await api("/admin/entitlements", "PUT", { revision, config });
      setData(await api("/admin/entitlements"));
      setMessage("等级与会员设置已保存");
      window.dispatchEvent(new Event("entitlements-updated"));
      return true;
    } catch (e) {
      setMessage((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const levelChange = (id: string, change: Partial<Level>) =>
    setData((d) =>
      d
        ? {
            ...d,
            levels: d.levels.map((l) =>
              l.id === id ? { ...l, ...change } : l,
            ),
          }
        : d,
    );
  return (
    <section className="membership-settings">
      <h2>用户等级与会员</h2>
      <p>
        永久基础等级长期生效；定时会员在到期前提升等级，到期自动回到基础等级。文档访问权限独立控制。
      </p>
      <SettingsTabs
        label="等级与会员分类"
        value={tab}
        onChange={setTab}
        items={[
          ["levels", "等级模板"],
          ["features", "功能权限"],
          ["quotas", "用量额度"],
          ["ai-credits", "AI 积分"],
          ["membership", "会员展示"],
          ["integration", "会员回调"],
          ["sources", "SSO 等级映射"],
        ]}
      />
      {tab === "sources" && <SourceLevelSettings />}
      {tab === "ai-credits" && <AICreditsAdmin />}
      {data && (
        <form
          hidden={tab === "sources" || tab === "ai-credits"}
          className="admin-card admin-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await saveConfig(data);
          }}
        >
          {tab === "levels" && (
            <MembershipLevels
              levels={data.levels}
              defaultLevel={data.defaultLevel}
              busy={busy}
              save={(levels, defaultLevel) =>
                saveConfig({ ...data, levels, defaultLevel })
              }
            />
          )}
          <div hidden={tab !== "features"}>
            <h3>功能与身份要求</h3>
            <p className="subtle">
              达到最低等级即可使用；身份分类留空表示不额外限制。员工、外包等身份由管理员或可信认证源分配，会员不会改变身份。
            </p>
            {[...new Set(data.capabilities.map((c) => c[1]))].map((group) => (
              <fieldset key={group}>
                <legend>{group}</legend>
                {data.capabilities
                  .filter((c) => c[1] === group)
                  .map(([id, , label, ready]) => {
                    const r = data.rules[id]!;
                    const set = (v: Partial<typeof r>) =>
                      setData({
                        ...data,
                        rules: { ...data.rules, [id]: { ...r, ...v } },
                      });
                    return (
                      <div className="capability-row" key={id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={r.enabled}
                            disabled={!ready}
                            onChange={(e) => set({ enabled: e.target.checked })}
                          />
                          {label}
                          {!ready ? "（尚未开放）" : ""}
                        </label>
                        <Select
                          aria-label={`${label}最低等级`}
                          disabled={!ready}
                          value={r.minLevel}
                          onChange={(e) => set({ minLevel: e.target.value })}
                        >
                          {data.levels.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}及以上
                            </option>
                          ))}
                        </Select>
                        <input
                          aria-label={`${label}身份分类`}
                          disabled={!ready}
                          placeholder="允许的身份分类，逗号分隔"
                          value={r.classes.join(",")}
                          onChange={(e) =>
                            set({
                              classes: e.target.value
                                .split(",")
                                .map((v) => v.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </div>
                    );
                  })}
              </fieldset>
            ))}
          </div>
          <div hidden={tab !== "quotas"}>
            <h3>各等级额度</h3>
            <p className="subtle">
              空白表示不限，0
              表示不允许。高等级额度不得少于低等级；日/月用量不会因升级或删除文档清零。降级保留已有内容，仍可阅读、导出和缩减内容。
            </p>
            <div className="account-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>额度</th>
                    {data.levels.map((l) => (
                      <th key={l.id}>{l.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.quotas.map(([id, , label]) => (
                    <tr key={id}>
                      <th>{label}</th>
                      {data.levels.map((l) => (
                        <td key={l.id}>
                          <input
                            type="number"
                            min={0}
                            aria-label={`${l.name}${label}`}
                            value={l.limits[id] ?? ""}
                            placeholder="不限"
                            onChange={(e) =>
                              levelChange(l.id, {
                                limits: {
                                  ...l.limits,
                                  [id]:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                },
                              })
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label>
              周期计量时区
              <input
                required
                value={data.timezone}
                onChange={(e) => setData({ ...data, timezone: e.target.value })}
              />
            </label>
          </div>
          <div hidden={tab !== "membership"}>
            <h3>会员展示</h3>
            {(
              [
                ["showLevel", "用户可查看自己的等级"],
                ["showExpiry", "显示当前等级到期时间"],
                ["showVip", "展示会员入口"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={data[key]}
                  onChange={(e) =>
                    setData({ ...data, [key]: e.target.checked })
                  }
                />
                {label}
              </label>
            ))}
            <div className="membership-entry-settings">
              <label>
                会员入口文字
                <input
                  required
                  maxLength={24}
                  value={data.vipLabel}
                  onChange={(e) =>
                    setData({ ...data, vipLabel: e.target.value })
                  }
                  placeholder="会员中心"
                />
              </label>
              <MembershipIconPicker
                label="会员入口图标"
                value={data.vipIcon}
                onChange={(vipIcon) => setData({ ...data, vipIcon })}
              />
              <div className="membership-level-preview">
                <small>入口预览</small>
                <span className="membership-label">
                  <MembershipIcon icon={data.vipIcon} />
                  <strong>{data.vipLabel || "会员中心"}</strong>
                </span>
              </div>
              <label>
                会员页面地址
                <input
                  type="url"
                  placeholder="https://…"
                  value={data.vipUrl}
                  onChange={(e) => setData({ ...data, vipUrl: e.target.value })}
                />
              </label>
            </div>
          </div>
          <div hidden={tab !== "integration"}>
            <h3>会员回调与套餐映射</h3>
            <MembershipIntegration
              ready={data.membershipReady}
              onReady={() =>
                setData((d) => (d ? { ...d, membershipReady: true } : d))
              }
            />
            <p className="subtle">
              会员回写服务：
              {data.membershipReady ? "服务端密钥已配置" : "尚未配置服务端密钥"}
              。外部系统关联本站用户后，通过服务端回写套餐和有效期。
            </p>
            {Object.entries(data.externalPlans).map(([key, value]) => (
              <div className="verification-code" key={key}>
                <strong>{key}</strong>
                <Select
                  value={value}
                  aria-label={`${key}对应等级`}
                  onChange={(e) =>
                    setData({
                      ...data,
                      externalPlans: {
                        ...data.externalPlans,
                        [key]: e.target.value,
                      },
                    })
                  }
                >
                  {data.levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  onClick={() => {
                    const p = { ...data.externalPlans };
                    delete p[key];
                    setData({ ...data, externalPlans: p });
                  }}
                >
                  移除套餐
                </button>
              </div>
            ))}
            <div className="verification-code">
              <input
                aria-label="外部套餐ID"
                value={plan}
                maxLength={64}
                placeholder="外部会员套餐ID"
                onChange={(e) => setPlan(e.target.value)}
              />
              <button
                type="button"
                disabled={!plan.trim()}
                onClick={() => {
                  setData({
                    ...data,
                    externalPlans: {
                      ...data.externalPlans,
                      [plan.trim()]: data.defaultLevel,
                    },
                  });
                  setPlan("");
                }}
              >
                添加套餐
              </button>
            </div>
          </div>
          <div className="admin-form-footer" hidden={tab === "levels"}>
            <span>标签页中的修改统一保存</span>
            <button className="primary" disabled={busy}>
              保存等级与会员设置
            </button>
          </div>
        </form>
      )}
      <Feedback message={message} tone="info" />
    </section>
  );
}
export function AssignLevels({
  users,
  close,
  saved,
}: {
  users: { id: string; display_name: string }[];
  close: () => void;
  saved: () => void;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [rows, setRows] = useState<{ id: string; revision: number }[]>([]),
    [level, setLevel] = useState(""),
    [identity, setIdentity] = useState(""),
    [restore, setRestore] = useState(false),
    [reason, setReason] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      api<Config>("/admin/entitlements").then((c) => {
        setConfig(c);
        setLevel(c.defaultLevel);
      }),
      Promise.all(
        users.map(async (u) => ({
          id: u.id,
          ...(await api<{ revision: number }>(
            `/admin/users/${u.id}/entitlements`,
          )),
        })),
      ).then(setRows),
    ]).catch((e) => setMessage(e.message));
  }, []);
  return (
    <Dialog title={`设置永久基础等级 · ${users.length} 人`} close={close}>
      <form
        className="admin-account-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/admin/entitlements/assign", "POST", {
              users: rows.map(({ id, revision }) => ({ id, revision })),
              levelId: level,
              identityClass: identity,
              restoreSource: restore,
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
        <p>{users.map((u) => u.display_name).join("、")}</p>
        <label>
          永久基础等级
          <Select value={level} onChange={(e) => setLevel(e.target.value)}>
            {config?.levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          身份分类
          <input
            value={identity}
            maxLength={64}
            placeholder="例如 employee、contractor，留空表示不分类"
            onChange={(e) => setIdentity(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={restore}
            onChange={(e) => setRestore(e.target.checked)}
          />
          解除手动覆盖，下次来源登录恢复同步
        </label>
        <label>
          调整原因
          <textarea
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || rows.length !== users.length}
        >
          保存基础等级
        </button>
        <Feedback message={message} tone="error" />
      </form>
    </Dialog>
  );
}
export function UserMembership({
  userId,
  close,
  saved,
}: {
  userId: string;
  close: () => void;
  saved: () => void;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [data, setData] = useState<any>(null),
    [draft, setDraft] = useState<any>(null),
    [baseDraft, setBaseDraft] = useState(""),
    [baseReason, setBaseReason] = useState(""),
    [reason, setReason] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<any>(`/admin/users/${userId}/entitlements`).then((d) => {
      setData(d);
      setBaseDraft(d.baseLevel);
    });
  useEffect(() => {
    void Promise.all([
      api<Config>("/admin/entitlements").then(setConfig),
      load(),
    ]).catch((e) => setMessage(e.message));
  }, [userId]);
  const inputDate = (d: string | null) =>
    d
      ? new Date(Date.parse(d) - new Date(d).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : "";
  return (
    <Dialog title="用户会员与等级" close={close}>
      {data && (
        <>
          <div className="membership-summary">
            <span>
              永久基础等级
              <strong className="membership-label" style={{color: config?.levels.find((l) => l.id === data.baseLevel)?.color}}>
                <MembershipIcon
                  icon={
                    config?.levels.find((l) => l.id === data.baseLevel)?.icon
                  }
                />
                {data.baseLevelName}
              </strong>
            </span>
            <span>
              当前有效等级
              <strong className="membership-label" style={{color: data.effectiveLevel.color}}>
                <MembershipIcon icon={data.effectiveLevel.icon} />
                {data.effectiveLevel.name}
              </strong>
            </span>
            <span>
              定时会员到期时间
              <strong>
                {data.timedExpiresAt
                  ? new Date(data.timedExpiresAt).toLocaleString()
                  : "无定时会员"}
              </strong>
            </span>
          </div>
          <p className="admin-field-help">
            会员到期后自动回到永久基础等级。每个账号只有一个定时会员，重新授予会替换当前定时等级和到期时间。
          </p>
          <details className="admin-form-section">
            <summary>调整永久基础等级</summary>
            <form
              className="admin-account-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await api("/admin/entitlements/assign", "POST", {
                    users: [{ id: userId, revision: data.revision }],
                    levelId: baseDraft,
                    identityClass: data.identityClass ?? "",
                    restoreSource: false,
                    reason: baseReason,
                  });
                  await load();
                  saved();
                  setMessage("永久等级已保存");
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                永久等级
                <Select
                  value={baseDraft}
                  onChange={(e) => setBaseDraft(e.target.value)}
                >
                  {config?.levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                调整原因
                <input
                  required
                  maxLength={500}
                  value={baseReason}
                  onChange={(e) => setBaseReason(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy}>
                保存永久等级
              </button>
            </form>
          </details>
          <h3>会员记录</h3>
          {!data.grants.length && (
            <p className="admin-field-help">暂无会员记录</p>
          )}
          {data.grants.map((g: any) => (
            <div className="provider-row" key={g.id}>
              <span>
                <MembershipIcon
                  icon={config?.levels.find((l) => l.id === g.level_id)?.icon}
                />{" "}
                {config?.levels.find((l) => l.id === g.level_id)?.name ??
                  g.level_id}{" "}
                ·{" "}
                {g.status === "superseded"
                  ? "已替换"
                  : g.status !== "active"
                    ? "已撤销"
                    : g.expires_at && Date.parse(g.expires_at) <= Date.now()
                      ? "已过期"
                      : Date.parse(g.starts_at) > Date.now()
                        ? "待生效"
                        : "生效中"}
                <small>
                  {new Date(g.starts_at).toLocaleString()} →{" "}
                  {g.expires_at
                    ? new Date(g.expires_at).toLocaleString()
                    : "永久"}
                </small>
              </span>
              {g.source === "admin" && (
                <button
                  onClick={() => {
                    setDraft({
                      grantId: g.id,
                      version: g.version,
                      levelId: g.level_id,
                      startsAt: g.starts_at,
                      expiresAt: g.expires_at,
                      status: g.status,
                    });
                    setReason("");
                  }}
                >
                  调整
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => {
              setDraft({
                version: 0,
                levelId: config?.defaultLevel,
                startsAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
                status: "active",
              });
              setReason("");
            }}
          >
            授予会员
          </button>
        </>
      )}
      {draft && (
        <form
          className="admin-account-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api(`/admin/users/${userId}/membership`, "POST", {
                ...draft,
                startsAt:
                  draft.status === "revoked"
                    ? draft.startsAt
                    : new Date().toISOString(),
                reason,
              });
              setDraft(null);
              await load();
              saved();
              setMessage("会员授予已保存");
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            会员等级
            <Select
              value={draft.levelId}
              onChange={(e) => setDraft({ ...draft, levelId: e.target.value })}
            >
              {config?.levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            到期时间 *
            <input
              type="datetime-local"
              required
              value={inputDate(draft.expiresAt)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  expiresAt: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : null,
                })
              }
            />
          </label>
          <label>
            状态
            <Select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            >
              <option value="active">生效</option>
              <option value="revoked">撤销</option>
            </Select>
          </label>
          <label>
            调整原因
            <textarea
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button className="primary" disabled={busy}>
            保存会员
          </button>
        </form>
      )}
      <Feedback message={message} tone="info" />
    </Dialog>
  );
}
export function MyMembership({ me }: { me: Me }) {
  const [error, setError] = useState("");
  const e = me.entitlements;
  if (!e?.level && !e?.vip) return null;
  return (
    <section className="settings-card">
      <h2>等级与会员</h2>
      {e.level && (
        <p>
          当前等级：
          <span className="membership-label">
            <MembershipIcon icon={e.level.icon} />
            <span style={{color: e.level.color}}>{e.level.name}</span>
          </span>
          {e.expiresAt
            ? ` · 到期时间：${new Date(e.expiresAt).toLocaleString()}`
            : ""}
        </p>
      )}
      <MembershipLink vip={e.vip} onError={setError} />
      <Feedback message={error} tone="error" />
    </section>
  );
}
