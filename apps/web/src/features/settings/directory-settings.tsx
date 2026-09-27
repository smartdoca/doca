import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
const modes = [
  {
    value: "all",
    label: "所有用户",
    description: "可以搜索并选择本站全部正常用户。",
  },
  {
    value: "related",
    label: "仅相关权限用户",
    description:
      "仅可选择与自己共同拥有文档或知识库显式权限的用户；公开可见不算关联。",
  },
  {
    value: "none",
    label: "不能搜索用户",
    description: "权限邀请和 @ 提及不再提供新用户候选；不撤销已有权限。",
  },
];
type Member = {
  id: string;
  display_name: string;
  public_id?: string;
  directory_mode?: string | null;
};
export function DirectorySettings() {
const { t } = useI18n();

  const [policy, setPolicy] = useState<{
    mode: string;
    revision: number;
  } | null>(null);
  const [users, setUsers] = useState<Member[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  const [q, setQ] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<typeof policy>("/admin/directory-policy")
      .then(setPolicy)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const c = new AbortController();
    setError("");
    const timer = setTimeout(() => {
      void api<{
        items: Member[];
        nextCursor?: string | null;
      }>(
        "/admin/users" + (q.trim() ? "?q=" + encodeURIComponent(q.trim()) : ""),
        "GET",
        undefined,
        c.signal,
      )
        .then((d) => {
          setUsers(d.items);
          setNextCursor(d.nextCursor ?? null);
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 200);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [q]);
  async function save(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      try {
        setPolicy(await api("/admin/directory-policy"));
      } catch {}
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <header>
        <h2>用户可见范围</h2>
        <p className="subtle">
          控制权限邀请、评论 @ 和正文 @
          的候选用户。后端同时校验，不影响原有文档访问权限。
        </p>
      </header>
      {error && <Feedback message={error} tone="error" />}
      <section className="settings-card">
        <h3>站点默认范围</h3>
        <div className="directory-mode-options">
          {modes.map((m) => (
            <button
              key={m.value}
              className={policy?.mode === m.value ? "selected" : ""}
              aria-pressed={policy?.mode === m.value}
              disabled={busy || !policy}
              onClick={() =>
                void save(async () => {
                  await api("/admin/directory-policy", "PUT", {
                    mode: m.value,
                    revision: policy!.revision,
                  });
                  setPolicy(await api("/admin/directory-policy"));
                })
              }
            >
              <strong>{m.label}</strong>
              <small>{m.description}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <h3>按用户设置</h3>
        <p className="subtle">默认跟随站点设置，也可单独覆盖。</p>
        <input
          aria-label="筛选用户可见范围"
          placeholder="搜索昵称、账号或用户标识"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {users.map((u) => (
          <div className="directory-user-row" key={u.id}>
            <UserBadge id={u.id} name={u.display_name} />
            <small>@{u.public_id ?? u.id}</small>
            <Select
              aria-label={u.display_name + "的用户搜索范围"}
              value={u.directory_mode ?? ""}
              disabled={busy}
              onChange={(e) => {
                const mode = e.target.value || null;
                void save(async () => {
                  await api("/admin/users/" + u.id + "/directory", "PUT", {
                    mode,
                  });
                  setUsers((v) =>
                    v.map((x) =>
                      x.id === u.id ? { ...x, directory_mode: mode } : x,
                    ),
                  );
                });
              }}
            >
              <option value="">跟随站点</option>
              {modes.map((m) => (
                <option value={m.value} key={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
        ))}
        {nextCursor !== null && (
          <button
            disabled={busy}
            onClick={() =>
              void save(async () => {
                const d = await api<{
                  items: Member[];
                  nextCursor?: string | null;
                }>(
                  `/admin/users?cursor=${encodeURIComponent(nextCursor)}${q.trim() ? "&q=" + encodeURIComponent(q.trim()) : ""}`,
                );
                setUsers((v) => [...v, ...d.items]);
                setNextCursor(d.nextCursor ?? null);
              })
            }
          >{t("common.more")}</button>
        )}
      </section>
    </section>
  );
}
