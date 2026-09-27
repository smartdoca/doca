import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ClipboardList, Copy } from "lucide-react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { BackLink } from "@web/shared/components/back-link.js";
import { realtime } from "@web/features/documents/realtime.js";
import { TicketStatusFilter } from "@web/features/tickets/ticket-status-filter.js";
import { useI18n } from "@web/shared/i18n.js";
import type { MessageKey } from "@doca/i18n";
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
const kinds: Record<string, MessageKey> = {
  access: "ticket.access",
  invitation: "ticket.invitation",
};
const states: Record<string, MessageKey> = {
  pending: "ticket.pending",
  completed: "ticket.completed",
  approved: "ticket.approved",
  accepted: "ticket.accepted",
  rejected: "ticket.rejected",
  cancelled: "ticket.cancelled",
  expired: "ticket.expired",
};
const roles: Record<string, MessageKey> = {
  reader: "role.reader",
  commenter: "role.commenter",
  editor: "role.editor",
  manager: "role.manager",
};
const actionNames: Record<string, MessageKey> = {
  approve: "ticket.approve",
  reject: "ticket.reject",
  accept: "ticket.accept",
  cancel: "ticket.cancel",
  remind: "ticket.remind",
};
const label = (
  t: (key: MessageKey) => string,
  map: Record<string, MessageKey>,
  key: string | null | undefined,
) => (key && map[key] ? t(map[key]) : (key ?? ""));
const stamp = (s: string) => new Date(s).toLocaleString();
export function TicketIcon() {
  const { t } = useI18n();
  return (
    <a
      className="icon todo-icon"
      href="#/tickets"
      title={t("nav.tickets")}
      aria-label={t("nav.tickets")}
    >
      <ClipboardList size={19} />
    </a>
  );
}
export function Tickets({
  resourceId: embeddedResourceId,
  ticketId,
}: { resourceId?: string; ticketId?: string } = {}) {
  const { t: tr } = useI18n();
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
      if (action === "remind") setNotice(tr("ticket.reminded"));
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
      setNotice(tr("ticket.copied"));
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
            <BackLink fallback="/tickets">
              <ArrowLeft size={16} />
              {tr("ticket.all")}
            </BackLink>
            <button
              onClick={() => void load().catch((e) => setError(e.message))}
            >
              {tr("admin.refresh")}
            </button>
          </div>
          {ticket && (
            <>
              <div className="ticket-title">
                <div>
                  <small>{label(tr, kinds, ticket.kind)}</small>
                  <h2>{ticket.resource?.title ?? tr("ticket.resource")}</h2>
                  <span className={"ticket-state " + ticket.status}>
                    {label(tr, states, ticket.status)}
                  </span>
                </div>
                <button onClick={() => void copy()}>
                  <Copy size={15} />
                  {tr("ticket.copyLink")}
                </button>
              </div>
              <p className="ticket-number">{tr("ticket.number", { id: ticket.id })}</p>
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
                            ? label(tr, states, ticket.status)
                            : tr("ticket.waiting")
                          : ticket.status === "completed"
                            ? tr("ticket.done")
                            : terminal
                              ? tr("ticket.notRun")
                              : tr("ticket.afterApproval")}
                    </small>
                    {i === 1 && (
                      <small>
                        {ticket.processorsHidden
                          ? tr("ticket.handlersHidden")
                          : ticket.processors
                              .map((p) => p.display_name)
                              .join(", ") || tr("ticket.noHandler")}
                      </small>
                    )}
                  </li>
                ))}
              </ol>
              <dl className="ticket-facts">
                <dt>{tr("ticket.initiator")}</dt>
                <dd>{ticket.initiator?.display_name ?? tr("ticket.identityHidden")}</dd>
                <dt>{ticket.kind === "invitation" ? tr("ticket.invitee") : tr("ticket.applicant")}</dt>
                <dd>
                  {ticket.subject?.display_name}
                  {ticket.subject?.public_id &&
                    ` · @${ticket.subject.public_id}`}
                </dd>
                {ticket.role && (
                  <>
                    <dt>{tr("ticket.requestedRole")}</dt>
                    <dd>{label(tr, roles, ticket.role)}</dd>
                  </>
                )}
                {ticket.operation?.role &&
                  (ticket.status === "completed" ||
                    ticket.kind === "invitation") && (
                    <>
                      <dt>
                        {ticket.status === "completed"
                          ? tr("ticket.grantedRole")
                          : tr("ticket.inviteScope")}
                      </dt>
                      <dd>
                        {label(tr, roles, ticket.operation.role)} ·{" "}
                        {ticket.operation.includeDescendants
                          ? tr("role.scope.descendants")
                          : tr("role.scope.node")}
                      </dd>
                    </>
                  )}
                {ticket.resource && (
                  <>
                    <dt>{tr("ticket.resourceKind")}</dt>
                    <dd>
                      {ticket.resourceKind === "library" ? tr("shell.kind.library") : tr("shell.type.rich")}
                    </dd>
                    <dt>{tr("ticket.resourceId")}</dt>
                    <dd>{ticket.resourceId}</dd>
                    <dt>{tr("ticket.resource")}</dt>
                    <dd>
                      <a href={ticket.resource.url}>
                        {tr("ticket.openResource", { title: ticket.resource.title })}
                      </a>
                    </dd>
                  </>
                )}
                {ticket.expiresAt && (
                  <>
                    <dt>{tr("ticket.expires")}</dt>
                    <dd>{stamp(ticket.expiresAt)}</dd>
                  </>
                )}
                {ticket.message && (
                  <>
                    <dt>
                      {ticket.kind === "invitation" ? tr("ticket.inviteNote") : tr("ticket.requestNote")}
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
                        {tr("ticket.grantLabel")}
                        <Select
                          aria-label={tr("ticket.grantLabel")}
                          value={grantRole || ticket.role || "reader"}
                          disabled={busy}
                          onChange={(e) => setGrantRole(e.target.value)}
                        >
                          {ticket.approvalRoles.map((role) => (
                            <option key={role} value={role}>
                              {label(tr, roles, role)}
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
                        {tr("role.scope.descendants")}
                      </label>
                    </div>
                  )}
                  {ticket.actions.some((a) => a !== "remind") && (
                    <textarea
                      aria-label={tr("ticket.stepNote")}
                      placeholder={tr("ticket.stepPlaceholder")}
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
                        {label(tr, actionNames, a)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <h3>{tr("ticket.history")}</h3>
              <div className="ticket-history">
                {ticket.events.map((e) => (
                  <article key={e.id}>
                    <strong>
                      {e.status === "pending"
                        ? tr("ticket.submitted")
                        : label(tr, states, e.status)}
                    </strong>
                    <small>
                      {stamp(e.createdAt)} ·{" "}
                      {e.actor?.display_name ?? tr("ticket.personHidden")}
                    </small>
                    {e.operation?.role &&
                      ["approved", "accepted"].includes(e.status) && (
                        <p>
                          {tr("ticket.grantedLine", { role: label(tr, roles, e.operation.role) })} ·{" "}
                          {e.operation.includeDescendants
                            ? tr("role.scope.descendants")
                            : tr("role.scope.node")}
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
              aria-label={tr("ticket.filterKind")}
              value={resourceKind}
              onChange={(e) => setResourceKind(e.target.value)}
            >
              <option value="">{tr("ticket.allResources")}</option>
              <option value="document">{tr("shell.type.rich")}</option>
              <option value="library">{tr("shell.kind.library")}</option>
            </Select>
            <Select
              aria-label={tr("ticket.filterType")}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">{tr("ticket.allTypes")}</option>
              {Object.entries(kinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {tr(v)}
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
              {tr("ticket.mine")}
            </label>
          </div>
          {resourceId && (
            <div className="ticket-resource-filter">
              <span>{tr("ticket.resourceIdFilter", { id: resourceId })}</span>
              {!embeddedResourceId && (
                <button onClick={() => setResourceId("")}>{tr("ticket.clearResource")}</button>
              )}
            </div>
          )}
          <div className="ticket-results" aria-busy={!ready || loadingMore}>
            <div className="ticket-table" role="table" aria-label={tr("ticket.list")}>
              <div className="ticket-table-head" role="row">
                <span role="columnheader">{tr("ticket.col.ticket")}</span>
                <span role="columnheader">{tr("ticket.col.type")}</span>
                <span role="columnheader">{tr("ticket.col.status")}</span>
                <span role="columnheader">{tr("ticket.col.step")}</span>
                <span role="columnheader">{tr("ticket.col.created")}</span>
              </div>
              {items.map((t) => (
                <div className="ticket-table-row" key={t.id} role="row">
                  <div role="cell" className="ticket-name-cell">
                    <a className="ticket-row-link" href={`#/tickets/${t.id}`}>
                      <span className="ticket-file-icon">
                        <ClipboardList size={18} />
                      </span>
                      <span className="ticket-name-text">
                        <span>{t.resource?.title ?? tr("ticket.resource")}</span>
                        {t.role && <small>{label(tr, roles, t.role)}</small>}
                      </span>
                    </a>
                  </div>
                  <span role="cell" className="ticket-type-cell">
                    {label(tr, kinds, t.kind)}
                  </span>
                  <span role="cell">
                    <span className={"ticket-state " + t.status}>
                      {label(tr, states, t.status)}
                    </span>
                  </span>
                  <span role="cell" className="ticket-step-cell">
                    {t.status === "pending"
                      ? t.steps[1]
                      : t.status === "completed"
                        ? t.steps[2]
                        : tr("ticket.ended")}
                  </span>
                  <time
                    role="cell"
                    dateTime={t.createdAt}
                    title={stamp(t.createdAt)}
                  >
                    {new Date(t.createdAt).toLocaleDateString()}
                  </time>
                </div>
              ))}
            </div>
            {ready && !items.length && !error && (
              <p className="empty">{tr("ticket.empty")}</p>
            )}
            {ready && next !== null && (
              <button
                className="ticket-load-more"
                disabled={loadingMore}
                onClick={() =>
                  void load(next).catch((e) => setError(e.message))
                }
              >
                {loadingMore ? tr("common.loading") : tr("common.more")}
              </button>
            )}
            {!ready && <p className="empty">{tr("ticket.loading")}</p>}
          </div>
        </>
      )}
      {ticketId && !ready && <p>{tr("ticket.loading")}</p>}
      {error && (
        <>
          <Feedback tone="error" message={error} />
          <a href="#/home">{tr("ticket.signIn")}</a>
        </>
      )}
      {notice && <Feedback message={notice} />}{" "}
      {manual && (
        <input
          aria-label={tr("ticket.copyManual")}
          readOnly
          value={manual}
          onFocus={(e) => e.target.select()}
        />
      )}
    </section>
  );
}
