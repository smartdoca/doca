import {
  Administrators,
  accessText,
  type Manager,
} from "@web/features/documents/access-management.js";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { ClipboardCheck, Send } from "lucide-react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { realtime } from "@web/features/documents/realtime.js";
export function RequestAccess({
  id,
  rank = 0,
  user,
}: {
  id: string;
  rank?: number;
  user: boolean;
}) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<{
    requestRoles: string[];
    effectiveRequestsEnabled: boolean;
    administrators: Manager[];
  } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    const load = () =>
      api<{
        requestRoles: string[];
        effectiveRequestsEnabled: boolean;
        administrators: Manager[];
      }>(`/resources/${id}/permission-overview`, "GET", undefined, c.signal)
        .then((o) => {
          setOverview(o);
          setRole((current) =>
            o.requestRoles.includes(current)
              ? current
              : (o.requestRoles[0] ?? ""),
          );
        })
        .catch(() => {});
    void load();
    const stop = realtime.subscribe((m) => {
      if (m.type === "notifications.changed") void load();
    });
    return () => {
      c.abort();
      stop();
    };
  }, [id]);
  const [role, setRole] = useState(
    rank < 1 ? "reader" : rank < 3 ? "editor" : "manager",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false),
    [sent, setSent] = useState(""),
    [error, setError] = useState("");
  return (
    <div className="access-request-actions">
      <Administrators
        items={overview?.administrators.filter(
          (u) => role !== "manager" || u.role === "owner",
        )}
      />
      {overview && !overview.effectiveRequestsEnabled ? (
        <span className="subtle">暂未开放权限申请，可联系协作者邀请加入。</span>
      ) : !user ? (
        <span>
          请先<a href="#/home">{t("login.submit")}</a>后申请访问
        </span>
      ) : overview && !overview.requestRoles.length ? (
        <span>当前没有可申请的更高权限</span>
      ) : sent ? (
        <a href={`#/tickets/${sent}`}>申请已提交，查看工单</a>
      ) : (
        <>
          <Select
            aria-label={t("ticket.requestedRole")}
            value={role}
            disabled={busy || !overview}
            onChange={(e) => setRole(e.target.value)}
          >
            {Object.entries({ reader: 1, commenter: 2, editor: 3, manager: 4 })
              .filter(
                ([role, value]) =>
                  value > rank &&
                  (!overview || overview.requestRoles.includes(role)),
              )
              .map(([v]) => (
                <option key={v} value={v}>
                  {accessText(t, v)}
                </option>
              ))}
          </Select>
          <details className="request-note">
            <summary>添加申请说明（选填）</summary>
            <textarea
              aria-label={t("ticket.requestNote")}
              placeholder="申请说明（选填）"
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </details>
          <button
            disabled={busy || !role || !overview}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const q = await api<{ id: string }>(
                  `/resources/${id}/access-requests`,
                  "POST",
                  {
                    role,
                    message,
                  },
                );
                setSent(q.id);
                location.hash = `/tickets/${q.id}`;
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Send size={15} />{t("ticket.requestedRole")}</button>
        </>
      )}
      {error && <Feedback tone="error" message={error} />}
    </div>
  );
}
export function AccessGate({ id, user }: { id: string; user: boolean }) {
const { t } = useI18n();

  const [preview, setPreview] = useState<{
      title: string;
      loginRequired?: boolean;
    } | null>(null),
    [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState("文档不存在");
  useEffect(() => {
    const c = new AbortController();
    void api<{ title: string }>(
      `/resources/${id}/access-preview`,
      "GET",
      undefined,
      c.signal,
    )
      .then(setPreview)
      .catch((e) => {
        if (!c.signal.aborted)
          setUnavailable(
            e.status === 404 ? "文档不存在" : "无法连接服务，请联网后重试",
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [id]);
  return (
    <section className="empty access-gate">
      <ClipboardCheck size={36} />
      <h2>{loading ? "正在检查访问权限…" : (preview?.title ?? unavailable)}</h2>
      {preview && (
        <>
          <p>
            {preview.loginRequired
              ? "这是站内公开文档，请登录后访问。"
              : "此文档需要授权，申请通过后即可访问。"}
          </p>
          {preview.loginRequired ? (
            <a href="#/home">{t("login.submit")}</a>
          ) : (
            <RequestAccess id={id} user={user} />
          )}
        </>
      )}
    </section>
  );
}

export { TicketIcon as TodoIcon, Tickets as AccessTasks } from "@web/features/tickets/tickets.js";
