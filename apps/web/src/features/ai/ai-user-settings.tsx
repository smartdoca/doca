import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useRef, useState } from "react";
import { api } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { AINoteSettings } from "@web/features/ai/ai-note.js";
export function AIUserSettings({
  options,
  close,
  openSession,
}: {
  options: any;
  close: () => void;
  openSession?: (id: string) => Promise<void> | void;
}) {
  const { t } = useI18n();

  const [tab, setTab] = useState("usage"),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [memory, setMemory] = useState(""),
    [revision, setRevision] = useState(0);
  const [skill, setSkill] = useState<any>(null);
  const activeTab = useRef("usage");
  const requestVersion = useRef(0);
  const [preferences, setPreferences] = useState(
    options?.preferences ?? { default_model: null, memory_enabled: 0 },
  );
  const load = async () => {
    const version = ++requestVersion.current;
    if (tab === "note" || tab === "knowledge") {
      setData({ ok: true });
      return;
    }
    const r = await api<any>(
      tab === "archived"
        ? "/ai/sessions?archived=true"
        : `/ai/${tab === "usage" ? "usage" : tab === "memory" ? "memory" : "skills"}`,
    );
    if (activeTab.current !== tab || version !== requestVersion.current) return;
    setData(r);
    if (tab === "memory") {
      setMemory(r.text);
      setRevision(r.revision);
    }
  };
  useEffect(() => {
    setData(null);
    setError("");
    void load().catch((e) => setError(e.message));
  }, [tab]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="AI 设置" close={close}>
      <div className="ai-settings">
        <nav className="ai-settings-tabs">
          {[
            ["usage", "用量"],
            ["memory", "个人偏好"],
            ["skills", "Skill"],
            ["archived", "已归档会话"],
            ["note", "备忘"],
          ].map(([id, title]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              disabled={busy}
              onClick={() => {
                activeTab.current = id!;
                setData(null);
                setTab(id!);
              }}
            >
              {title}
            </button>
          ))}
        </nav>
        <Feedback message={error} tone="error" />
        {tab === "usage" && data && (
          <>
            <div className="ai-usage-grid">
              {(["day", "week", "month"] as const).map((period) => (
                <div key={period}>
                  <small>{t(("aiusage." + period) as "aiusage.day")}</small>
                  <strong>
                    {(data.tokens?.[period]?.total ?? 0).toLocaleString()}
                  </strong>
                  <small>
                    {t("aiusage.input")}:{" "}
                    {(data.tokens?.[period]?.input ?? 0).toLocaleString()}
                  </small>
                  <small>
                    {t("aiusage.output")}:{" "}
                    {(data.tokens?.[period]?.output ?? 0).toLocaleString()}
                  </small>
                  <small>
                    {t("aiusage.image")}:{" "}
                    {(data.tokens?.[period]?.image ?? 0).toLocaleString()}
                  </small>
                </div>
              ))}
            </div>
            <p className="ai-muted">{t("aiusage.note")}</p>
            <table>
              <thead>
                <tr>
                  <th>{t("aiusage.model")}</th>
                  <th>{t("aiusage.input")}</th>
                  <th>{t("aiusage.output")}</th>
                  <th>{t("aiusage.image")}</th>
                  <th>{t("aiusage.total")}</th>
                  <th>{t("aiusage.state")}</th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map((call: any) => (
                  <tr key={call.id}>
                    <td>{call.model}</td>
                    <td>{call.input ?? "—"}</td>
                    <td>{call.output ?? "—"}</td>
                    <td>{call.image ?? "—"}</td>
                    <td>{call.total ?? "—"}</td>
                    <td>{call.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === "memory" && data && (
          <>
            <p>记录常用语言、写作风格和个人偏好。知识库内容仍以原文为准。</p>
            <label>
              默认模型
              <Select
                value={preferences.default_model ?? ""}
                onChange={(e) =>
                  void act(() =>
                    api("/ai/preferences", "PUT", {
                      defaultModel: e.target.value || null,
                      memoryEnabled: !!preferences.memory_enabled,
                    }).then(() =>
                      setPreferences({
                        ...preferences,
                        default_model: e.target.value || null,
                      }),
                    ),
                  )
                }
              >
                <option value="">使用平台默认</option>
                {options?.models.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!preferences.memory_enabled}
                disabled={!options?.memoryAvailable}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  void act(() =>
                    api("/ai/preferences", "PUT", {
                      defaultModel: preferences.default_model,
                      memoryEnabled: enabled,
                    }).then(() =>
                      setPreferences({
                        ...preferences,
                        memory_enabled: Number(enabled),
                      }),
                    ),
                  );
                }}
              />
              {t("assistant.memory.crossSession")}
            </label>
            {!options?.memoryAvailable && (
              <p>管理员尚未启用长期记忆。历史会话仍正常保存。</p>
            )}
            <textarea
              rows={8}
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              maxLength={8000}
              placeholder="例如：用中文回答，先说明结论；报告采用简洁正式的语气。"
            />
            <div className="ai-actions">
              <button
                className="primary"
                disabled={busy || !options?.memoryAvailable}
                onClick={() =>
                  void act(() =>
                    api("/ai/memory", "PUT", { text: memory, revision }),
                  )
                }
              >
                保存偏好
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api("/ai/memory", "PUT", { text: "", revision }),
                  )
                }
              >
                清除偏好
              </button>
            </div>
          </>
        )}
        {tab === "skills" && data && (
          <>
            <h3>官方场景</h3>
            {data.official.map((s: any) => (
              <details key={s.id}>
                <summary>
                  {s.name} · {s.description}
                </summary>
                <p>{s.content}</p>
              </details>
            ))}
            <h3>个人 Skill</h3>
            <button
              onClick={() =>
                setSkill({
                  id: crypto.randomUUID(),
                  name: "",
                  description: "",
                  content: "",
                  formats: [],
                  enabled: true,
                  revision: 0,
                })
              }
            >
              新建 Skill
            </button>
            {data.personal.map((s: any) => (
              <div className="ai-settings-row" key={s.id}>
                <button
                  onClick={() =>
                    setSkill({
                      ...s,
                      formats: JSON.parse(s.formats),
                      enabled: !!s.enabled,
                    })
                  }
                >
                  {s.name} · v{s.revision}
                </button>
                <button
                  onClick={() =>
                    void act(() => api(`/ai/skills/${s.id}`, "DELETE"))
                  }
                >
                  {t("common.delete")}
                </button>
              </div>
            ))}
            {skill && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const { id, ...body } = skill;
                  void act(async () => {
                    await api(`/ai/skills/${id}`, "PUT", body);
                    setSkill(null);
                  });
                }}
              >
                <label>
                  {t("shell.name")}
                  <input
                    required
                    value={skill.name}
                    onChange={(e) =>
                      setSkill({ ...skill, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  适用场景
                  <input
                    required
                    value={skill.description}
                    onChange={(e) =>
                      setSkill({ ...skill, description: e.target.value })
                    }
                  />
                </label>
                <label>
                  步骤、规范与示例
                  <textarea
                    required
                    rows={8}
                    value={skill.content}
                    onChange={(e) =>
                      setSkill({ ...skill, content: e.target.value })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    onChange={(e) =>
                      setSkill({ ...skill, enabled: e.target.checked })
                    }
                  />
                  {t("users.enable")}
                </label>
                <button className="primary" disabled={busy}>
                  {t("aiAdmin.save")}
                </button>
                <button type="button" onClick={() => setSkill(null)}>
                  {t("common.cancel")}
                </button>
              </form>
            )}
          </>
        )}
        {tab === "archived" && data && (
          <>
            <p className="ai-muted">
              已归档的会话不会出现在会话列表中。恢复后即可继续在 AI 助手中使用。
            </p>
            {!data.length && <p className="ai-muted">暂无归档会话</p>}
            {data.map((session: any) => (
              <div
                className="ai-settings-row ai-archived-session"
                key={session.id}
              >
                <span>
                  <strong>{session.title}</strong>
                  {session.updated_at && (
                    <small>
                      {new Date(session.updated_at).toLocaleString("zh-CN")}
                    </small>
                  )}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(`/ai/sessions/${session.id}`, "PATCH", {
                        archived: false,
                      });
                      await openSession?.(session.id);
                    })
                  }
                >
                  恢复并打开
                </button>
              </div>
            ))}
          </>
        )}
        {tab === "note" && data && <AINoteSettings />}
      </div>
    </Dialog>
  );
}
