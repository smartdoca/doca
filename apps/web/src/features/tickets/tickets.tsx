import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ClipboardList, Copy } from "lucide-react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { realtime } from "@web/features/documents/realtime.js";
import { TicketStatusFilter } from "@web/features/tickets/ticket-status-filter.js";
import "@web/features/tickets/tickets.css";
type Person = { id: string; display_name: string; public_id?: string };
type Operation = { type?: string; role?: string; includeDescendants?: boolean };
type Ticket = {
  operation: Operation;
  approvalRoles: string[];
  id: string;
  kind: string;
  status: string;
  role: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  resourceKind: "document" | "library";
  resourceId: string;
  processorRule: "recipient" | "resource_owner" | "resource_managers";
  resource: { id: string; kind: string; title: string; url: string } | null;
  subject: Person | null;
  initiator: Person | null;
  processors: Person[];
  processorsHidden: boolean;
  steps: string[];
  events: {
    id: string;
    status: string;
    message: string;
    createdAt: string;
    actor: Person | null;
    operation: Operation;
  }[];
  actions: string[];
};
const kinds: Record<string, string> = {
  access: "权限申请工单",
  invitation: "协作邀请工单",
};
const states: Record<string, string> = {
  pending: "处理中",
  completed: "已完成",
  approved: "审批通过",
  accepted: "已接受",
  rejected: "已拒绝",
  cancelled: "已撤销",
  expired: "已过期",
};
const roles: Record<string, string> = {
  reader: "可阅读",
  commenter: "可评论",
  editor: "可编辑",
  manager: "可管理",
};
const actionNames: Record<string, string> = {
  approve: "通过审批",
  reject: "拒绝",
  accept: "接受邀请",
  cancel: "撤销工单",
  remind: "催办",
};
const stamp = (s: string) => new Date(s).toLocaleString();
export function TicketIcon() {
  return (
    <a
      className="icon todo-icon"
      href="#/tickets"
      title="工单"
      aria-label="工单"
    >
      <ClipboardList size={19} />
    </a>
  );
}
export function Tickets({
  resourceId: embeddedResourceId,
  ticketId,
}: { resourceId?: string; ticketId?: string } = {}) {
  const initialQuery = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const [resourceId, setResourceId] = useState(
      embeddedResourceId ?? initialQuery.get("resourceId") ?? "",
    ),
    [resourceKind, setResourceKind] = useState(
      initialQuery.get("resourceKind") ?? "",
    );
  const [kind, setKind] = useState(initialQuery.get("kind") ?? ""),
    [status, setStatus] = useState<string[]>(
      initialQuery.get("status")?.split(",").filter(Boolean) ?? [],
    ),
    [onlyMine, setOnlyMine] = useState(initialQuery.get("onlyMine") === "true"),
    [loadingMore, setLoadingMore] = useState(false),
    [items, setItems] = useState<Ticket[]>([]),
    [next, setNext] = useState<number | null>(null),
    [ticket, setTicket] = useState<Ticket | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [grantRole, setGrantRole] = useState(""),
    [includeDescendants, setIncludeDescendants] = useState(true),
    [notice, setNotice] = useState(""),
    [ready, setReady] = useState(false),
    [manual, setManual] = useState("");
  useEffect(() => {
    if (ticketId || embeddedResourceId) return;
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (status.length) params.set("status", status.join(","));
    if (onlyMine) params.set("onlyMine", "true");
    if (resourceId) params.set("resourceId", resourceId);
    if (resourceKind) params.set("resourceKind", resourceKind);
    history.replaceState(
      null,
      "",
      `#/tickets${params.size ? `?${params}` : ""}`,
    );
  }, [
    ticketId,
    embeddedResourceId,
    kind,
    status,
    onlyMine,
    resourceId,
    resourceKind,
  ]);
  const request = useRef<AbortController | null>(null);
  async function load(offset = 0) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(offset > 0);
    try {
      if (ticketId) {
        const detail = await api<Ticket>(
          `/tickets/${ticketId}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) setTicket(detail);
      } else {
        const params = new URLSearchParams({ offset: String(offset) });
        if (kind) params.set("kind", kind);
        if (status.length) params.set("status", status.join(","));
        if (onlyMine) params.set("onlyMine", "true");
        if (resourceId) params.set("resourceId", resourceId);
        if (resourceKind) params.set("resourceKind", resourceKind);
        const result = await api<{
          items: Ticket[];
          nextOffset: number | null;
        }>(`/tickets?${params}`, "GET", undefined, controller.signal);
        if (controller.signal.aborted) return;
        setItems((old) => (offset ? [...old, ...result.items] : result.items));
        setNext(result.nextOffset);
      }
      if (!controller.signal.aborted) {
        setReady(true);
        setError("");
      }
    } catch (e) {
      if (!controller.signal.aborted) throw e;
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }
  useEffect(() => {
    let alive = true;
    setReady(false);
    setError("");
    setTicket(null);
    setItems([]);
    setNext(null);
    setNotice("");
    setMessage("");
    setGrantRole("");
    setIncludeDescendants(true);
    setManual("");
    const refresh = () => {
      if (alive)
        void load().catch((e) => {
          if (alive) {
            setError(e.message);
            setReady(true);
          }
        });
    };
    refresh();
    const stop = realtime.subscribe((m) => {
      if (m.type === "notifications.changed") refresh();
    });
    // Refresh detail while its approval state can change in another session.
    const timer = ticketId ? setInterval(refresh, 15000) : undefined;
    return () => {
      alive = false;
      request.current?.abort();
      stop();
      clearInterval(timer);
    };
  }, [ticketId, resourceId, resourceKind, kind, status, onlyMine]);
  async function act(action: string) {
    if (!ticket) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setTicket(
        await api<Ticket>(`/tickets/${ticket.id}/actions`, "POST", {
          action,
          ...(action === "approve"
            ? { role: grantRole || ticket.role, includeDescendants }
            : {}),
          message: action === "remind" ? "" : message.trim(),
        }),
      );
      if (action !== "remind") setMessage("");
      if (action === "remind") setNotice("已通知当前处理人");
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    const url = `${location.origin}${location.pathname}#/tickets/${ticket!.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("工单链接已复制");
    } catch {
      setManual(url);
    }
  }
  const terminal = ticket && ticket.status !== "pending";
  return (
    <section
      className={
        "tickets-page" +
        (ticketId ? " tickets-detail" : " tickets-index") +
        (embeddedResourceId ? " tickets-embedded" : "")
      }
    >
      {ticketId ? (
        <>
          <div className="ticket-heading">
            <a href="#/tickets">
              <ArrowLeft size={16} />
              全部工单
            </a>
            <button
              onClick={() => void load().catch((e) => setError(e.message))}
            >
              刷新
            </button>
          </div>
          {ticket && (
            <>
              <div className="ticket-title">
                <div>
                  <small>{kinds[ticket.kind]}</small>
                  <h2>{ticket.resource?.title ?? "关联资源"}</h2>
                  <span className={"ticket-state " + ticket.status}>
                    {states[ticket.status]}
                  </span>
                </div>
                <button onClick={() => void copy()}>
                  <Copy size={15} />
                  复制工单链接
                </button>
              </div>
              <p className="ticket-number">工单编号 {ticket.id}</p>
              <ol className="ticket-steps">
                {ticket.steps.map((s, i) => (
                  <li
                    key={s}
                    className={
                      i === 0 || ticket.status === "completed"
                        ? "done"
                        : i === 1 && !terminal
                          ? "current"
                          : "waiting"
                    }
                  >
                    <span>
                      {i === 0 || ticket.status === "completed" ? (
                        <Check size={16} />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <strong>{s}</strong>
                    <small>
                      {i === 0
                        ? stamp(ticket.createdAt)
                        : i === 1
                          ? terminal
                            ? states[ticket.status]
                            : "等待处理"
                          : ticket.status === "completed"
                            ? "已完成"
                            : terminal
                              ? "未执行"
                              : "审批后自动完成"}
                    </small>
                    {i === 1 && (
                      <small>
                        {ticket.processorsHidden
                          ? "处理人员信息已隐藏"
                          : ticket.processors
                              .map((p) => p.display_name)
                              .join("、") || "暂无处理人"}
                      </small>
                    )}
                  </li>
                ))}
              </ol>
              <dl className="ticket-facts">
                <dt>发起人</dt>
                <dd>{ticket.initiator?.display_name ?? "身份已隐藏"}</dd>
                <dt>{ticket.kind === "invitation" ? "受邀人" : "申请人"}</dt>
                <dd>
                  {ticket.subject?.display_name}
                  {ticket.subject?.public_id &&
                    ` · @${ticket.subject.public_id}`}
                </dd>
                {ticket.role && (
                  <>
                    <dt>申请权限</dt>
                    <dd>{roles[ticket.role]}</dd>
                  </>
                )}
                {ticket.operation?.role &&
                  (ticket.status === "completed" ||
                    ticket.kind === "invitation") && (
                    <>
                      <dt>
                        {ticket.status === "completed"
                          ? "实际授权"
                          : "邀请范围"}
                      </dt>
                      <dd>
                        {roles[ticket.operation.role]} ·{" "}
                        {ticket.operation.includeDescendants
                          ? "包含子文档"
                          : "仅当前节点"}
                      </dd>
                    </>
                  )}
                {ticket.resource && (
                  <>
                    <dt>资源类型</dt>
                    <dd>
                      {ticket.resourceKind === "library" ? "知识库" : "文档"}
                    </dd>
                    <dt>资源 ID</dt>
                    <dd>{ticket.resourceId}</dd>
                    <dt>关联资源</dt>
                    <dd>
                      <a href={ticket.resource.url}>
                        打开{ticket.resource.title}
                      </a>
                    </dd>
                  </>
                )}
                {ticket.expiresAt && (
                  <>
                    <dt>有效期</dt>
                    <dd>{stamp(ticket.expiresAt)}</dd>
                  </>
                )}
                {ticket.message && (
                  <>
                    <dt>
                      {ticket.kind === "invitation" ? "邀请说明" : "申请说明"}
                    </dt>
                    <dd>{ticket.message}</dd>
                  </>
                )}
              </dl>
              {!!ticket.actions.length && (
                <div className="ticket-actions">
                  {ticket.actions.includes("approve") && (
                    <div className="ticket-grant-options">
                      <label>
                        实际授予权限
                        <Select
                          aria-label="实际授予权限"
                          value={grantRole || ticket.role || "reader"}
                          disabled={busy}
                          onChange={(e) => setGrantRole(e.target.value)}
                        >
                          {ticket.approvalRoles.map((role) => (
                            <option key={role} value={role}>
                              {roles[role]}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={includeDescendants}
                          disabled={busy}
                          onChange={(e) =>
                            setIncludeDescendants(e.target.checked)
                          }
                        />
                        包含子文档
                      </label>
                    </div>
                  )}
                  {ticket.actions.some((a) => a !== "remind") && (
                    <textarea
                      aria-label="步骤备注"
                      placeholder="步骤备注（选填，可填写通过、拒绝、接受或撤销的说明）"
                      value={message}
                      maxLength={1000}
                      disabled={busy}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                  )}
                  <div>
                    {ticket.actions.map((a) => (
                      <button
                        key={a}
                        className={
                          ["approve", "accept"].includes(a) ? "primary" : ""
                        }
                        disabled={busy}
                        onClick={() => void act(a)}
                      >
                        {actionNames[a]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <h3>处理记录</h3>
              <div className="ticket-history">
                {ticket.events.map((e) => (
                  <article key={e.id}>
                    <strong>
                      {e.status === "pending"
                        ? "工单已提交"
                        : (states[e.status] ?? e.status)}
                    </strong>
                    <small>
                      {stamp(e.createdAt)} ·{" "}
                      {e.actor?.display_name ?? "人员信息已隐藏"}
                    </small>
                    {e.operation?.role &&
                      ["approved", "accepted"].includes(e.status) && (
                        <p>
                          已授予{roles[e.operation.role]} ·{" "}
                          {e.operation.includeDescendants
                            ? "包含子文档"
                            : "仅当前节点"}
                        </p>
                      )}
                    {e.message && <p>{e.message}</p>}
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="ticket-filters">
            <Select
              aria-label="资源类型"
              value={resourceKind}
              onChange={(e) => setResourceKind(e.target.value)}
            >
              <option value="">全部资源</option>
              <option value="document">文档</option>
              <option value="library">知识库</option>
            </Select>
            <Select
              aria-label="工单类型"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">全部类型</option>
              {Object.entries(kinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <TicketStatusFilter value={status} onChange={setStatus} />
            <label className="ticket-mine-filter">
              <input
                type="checkbox"
                checked={onlyMine}
                onChange={(e) => setOnlyMine(e.target.checked)}
              />
              待我处理
            </label>
          </div>
          {resourceId && (
            <div className="ticket-resource-filter">
              <span>资源 ID：{resourceId}</span>
              {!embeddedResourceId && (
                <button onClick={() => setResourceId("")}>清除资源筛选</button>
              )}
            </div>
          )}
          <div className="ticket-results" aria-busy={!ready || loadingMore}>
            <div className="ticket-table" role="table" aria-label="工单列表">
              <div className="ticket-table-head" role="row">
                <span role="columnheader">工单</span>
                <span role="columnheader">类型</span>
                <span role="columnheader">状态</span>
                <span role="columnheader">当前步骤</span>
                <span role="columnheader">创建时间</span>
              </div>
              {items.map((t) => (
                <div className="ticket-table-row" key={t.id} role="row">
                  <div role="cell" className="ticket-name-cell">
                    <a className="ticket-row-link" href={`#/tickets/${t.id}`}>
                      <span className="ticket-file-icon">
                        <ClipboardList size={18} />
                      </span>
                      <span className="ticket-name-text">
                        <span>{t.resource?.title ?? "关联资源"}</span>
                        {t.role && <small>{roles[t.role]}</small>}
                      </span>
                    </a>
                  </div>
                  <span role="cell" className="ticket-type-cell">
                    {kinds[t.kind]}
                  </span>
                  <span role="cell">
                    <span className={"ticket-state " + t.status}>
                      {states[t.status]}
                    </span>
                  </span>
                  <span role="cell" className="ticket-step-cell">
                    {t.status === "pending"
                      ? t.steps[1]
                      : t.status === "completed"
                        ? t.steps[2]
                        : "已结束"}
                  </span>
                  <time
                    role="cell"
                    dateTime={t.createdAt}
                    title={stamp(t.createdAt)}
                  >
                    {new Date(t.createdAt).toLocaleDateString("zh-CN")}
                  </time>
                </div>
              ))}
            </div>
            {ready && !items.length && !error && (
              <p className="empty">暂无相关工单</p>
            )}
            {ready && next !== null && (
              <button
                className="ticket-load-more"
                disabled={loadingMore}
                onClick={() =>
                  void load(next).catch((e) => setError(e.message))
                }
              >
                {loadingMore ? "正在加载…" : "加载更多"}
              </button>
            )}
            {!ready && <p className="empty">正在加载工单…</p>}
          </div>
        </>
      )}
      {ticketId && !ready && <p>正在加载工单…</p>}
      {error && (
        <>
          <Feedback tone="error" message={error} />
          <a href="#/home">返回平台或登录</a>
        </>
      )}
      {notice && <Feedback message={notice} />}{" "}
      {manual && (
        <input
          aria-label="手动复制工单链接"
          readOnly
          value={manual}
          onFocus={(e) => e.target.select()}
        />
      )}
    </section>
  );
}
