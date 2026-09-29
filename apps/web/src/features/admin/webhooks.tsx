import { useEffect, useState } from "react";
import { Select } from "antd";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { notifyFeedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import type { MessageKey } from "@doca/i18n";

const eventNameKey = {
  "document.created": "hooks.event.documentCreated",
  "library.created": "hooks.event.libraryCreated",
  "resource.renamed": "hooks.event.resourceRenamed",
  "resource.transferred": "hooks.event.resourceTransferred",
  "resource.arranged": "hooks.event.resourceArranged",
  "resource.moved": "hooks.event.resourceMoved",
  "resource.copied": "hooks.event.resourceCopied",
  "resource.restored": "hooks.event.resourceRestored",
  "resource.trashed": "hooks.event.resourceTrashed",
  "resource.purged": "hooks.event.resourcePurged",
  "resource.invited": "hooks.event.resourceInvited",
  "resource.permissions_changed": "hooks.event.permissionsChanged",
  "resource.link_changed": "hooks.event.linkChanged",
  "resource.link_joined": "hooks.event.linkJoined",
  "comment.created": "hooks.event.commentCreated",
  "comment.updated": "hooks.event.commentUpdated",
  "like.added": "hooks.event.likeAdded",
  "like.removed": "hooks.event.likeRemoved",
  "favorite.added": "hooks.event.favoriteAdded",
  "favorite.removed": "hooks.event.favoriteRemoved",
  "access.requested": "hooks.event.accessRequested",
  "access.approved": "hooks.event.accessApproved",
  "access.rejected": "hooks.event.accessRejected",
  "access.cancelled": "hooks.event.accessCancelled",
  "invitation.accepted": "hooks.event.invitationAccepted",
  "invitation.rejected": "hooks.event.invitationRejected",
  "invitation.cancel": "hooks.event.invitationCancel",
  "invitation.resend": "hooks.event.invitationResend",
  "notification.created": "hooks.event.notificationCreated",
  "ticket.changed": "hooks.event.ticketChanged",
  "user.created": "hooks.event.userCreated",
  "user.updated": "hooks.event.userUpdated",
  "user.status.changed": "hooks.event.userStatusChanged",
  "ai.usage.recorded": "hooks.event.aiUsageRecorded",
} as const satisfies Record<string, MessageKey>;

type Endpoint = {
  id: string;
  name: string;
  url: string;
  events: string[];
  headers: { name: string; value: string }[];
  enabled: boolean;
  pending: number;
  delivered: number;
  failed: number;
};
type Delivery = {
  id: string;
  eventType: string;
  eventSeq: number;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
};
type Catalog = { eventTypes: string[]; items: Endpoint[] };

export function Webhooks() {
  const { t } = useI18n();
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [allEvents, setAllEvents] = useState(false);
  const [openId, setOpenId] = useState("");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [confirming, setConfirming] = useState("");

  async function load() {
    setData(await api<Catalog>("/admin/webhooks"));
  }
  useEffect(() => {
    void load().catch((reason) => setError((reason as Error).message));
  }, []);

  function resetForm() {
    setEditing(null);
    setName("");
    setUrl("");
    setHeaders([]);
    setEvents([]);
    setAllEvents(false);
  }
  function edit(item: Endpoint) {
    setEditing(item.id);
    setName(item.name);
    setUrl(item.url);
    setHeaders(item.headers);
    setAllEvents(item.events.includes("*"));
    setEvents(item.events.includes("*") ? [] : item.events);
    setError("");
  }
  function eventLabel(type: string) {
    if (type === "*") return `* (${t("hooks.allEvents")})`;
    if (!(type in eventNameKey)) return type;
    return `${type} (${t(eventNameKey[type as keyof typeof eventNameKey])})`;
  }
  function changeEvents(next: string[]) {
    if (next.includes("*") && !allEvents) {
      setAllEvents(true);
      setEvents([]);
      return;
    }
    setAllEvents(false);
    setEvents(next.filter((type) => type !== "*"));
  }
  const statusLabel = (status: string) =>
    status === "delivered"
      ? t("hooks.delivered")
      : status === "failed"
        ? t("hooks.failed")
        : status === "leased"
          ? t("hooks.sending")
          : t("hooks.pending");

  return (
    <>
      <div className="admin-section-heading">
        <div>
          <h2>{t("admin.hooks")}</h2>
          <p>{t("hooks.lead")}</p>
        </div>
      </div>
      {error && <Feedback tone="error" message={error} />}
      <form
        className="admin-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const payload = {
              name,
              url,
              headers: headers.filter((header) => header.name || header.value),
              events: allEvents ? ["*"] : events,
            };
            if (editing) {
              await api(`/admin/webhooks/${editing}`, "PATCH", payload);
              notifyFeedback(t("hooks.saved"), "success");
            } else {
              await api("/admin/webhooks", "POST", payload);
              notifyFeedback(t("hooks.saved"), "success");
            }
            resetForm();
            await load();
          } catch (reason) {
            setError((reason as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>{editing ? t("hooks.edit") : t("hooks.add")}</h3>
        <label>
          {t("hooks.name")}
          <input
            value={name}
            maxLength={80}
            placeholder={t("hooks.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label>
          {t("hooks.url")}
          <input
            value={url}
            type="url"
            maxLength={2000}
            placeholder="https://"
            onChange={(event) => setUrl(event.target.value)}
            required
          />
        </label>
        <fieldset className="webhook-headers" disabled={busy}>
          <legend>{t("hooks.headers")}</legend>
          <p className="subtle">{t("hooks.headersHint")}</p>
          {headers.map((header, index) => (
            <div className="webhook-header-row" key={index}>
              <input
                aria-label={t("hooks.headerName")}
                value={header.name}
                maxLength={80}
                placeholder={t("hooks.headerName")}
                onChange={(event) =>
                  setHeaders((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, name: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <input
                aria-label={t("hooks.headerValue")}
                value={header.value}
                maxLength={4000}
                placeholder={t("hooks.headerValue")}
                onChange={(event) =>
                  setHeaders((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, value: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                onClick={() =>
                  setHeaders((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                {t("hooks.removeHeader")}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setHeaders((current) => [...current, { name: "", value: "" }])
            }
          >
            {t("hooks.addHeader")}
          </button>
        </fieldset>
        <p className="subtle">{t("hooks.pauseHint")}</p>
        <label>
          {t("hooks.events")}
          <Select
            className="webhook-event-select"
            mode="multiple"
            showSearch
            optionFilterProp="label"
            disabled={busy}
            placeholder={t("hooks.eventsPlaceholder")}
            value={allEvents ? ["*"] : events}
            onChange={changeEvents}
            options={[
              { value: "*", label: eventLabel("*") },
              ...(data?.eventTypes ?? []).map((type) => ({
                value: type,
                label: eventLabel(type),
              })),
            ]}
          />
        </label>
        <div className="webhook-actions">
          <button className="primary" disabled={busy} type="submit">
            {editing ? t("hooks.save") : t("hooks.add")}
          </button>
          {editing && (
            <button type="button" disabled={busy} onClick={resetForm}>
              {t("hooks.cancel")}
            </button>
          )}
        </div>
      </form>
      {!data ? (
        <div className="empty">
          {error ? t("hooks.unavailable") : t("hooks.loading")}
          <button
            onClick={() => void load().catch((reason) => setError((reason as Error).message))}
          >
            {t("hooks.reload")}
          </button>
        </div>
      ) : (
        <section className="admin-card">
          <h3>{t("admin.webhooks")}</h3>
          {!data.items.length && <p className="subtle">{t("hooks.empty")}</p>}
          {data.items.map((item) => (
            <article className="webhook-row" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>{item.url}</small>
                <small>{item.events.map((type) => eventLabel(type)).join(", ")}</small>
                <small>
                  {t("hooks.pending")} {item.pending} · {t("hooks.delivered")}{" "}
                  {item.delivered} · {t("hooks.failed")} {item.failed}
                  {item.headers.length
                    ? ` · ${item.headers.map((header) => header.name).join(", ")}`
                    : ""}
                </small>
              </div>
              <div className="webhook-actions">
                <span className={item.enabled ? "status-badge success" : "status-badge"}>
                  {item.enabled ? t("hooks.enabled") : t("hooks.paused")}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await api(`/admin/webhooks/${item.id}`, "PATCH", {
                          enabled: !item.enabled,
                        });
                        await load();
                      } catch (reason) {
                        setError((reason as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  {item.enabled ? t("hooks.pause") : t("hooks.enabled")}
                </button>
                <button type="button" onClick={() => edit(item)}>
                  {t("hooks.edit")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void (async () => {
                      if (openId === item.id) {
                        setOpenId("");
                        return;
                      }
                      setError("");
                      try {
                        const page = await api<{ items: Delivery[] }>(
                          `/admin/webhooks/${item.id}/deliveries`,
                        );
                        setDeliveries(page.items);
                        setOpenId(item.id);
                      } catch (reason) {
                        setError((reason as Error).message);
                      }
                    })()
                  }
                >
                  {t("hooks.deliveries")}
                </button>
                <button
                  type="button"
                  className="text-action danger"
                  disabled={busy}
                  onClick={() =>
                    void (async () => {
                      if (confirming !== item.id) {
                        setConfirming(item.id);
                        return;
                      }
                      setBusy(true);
                      setError("");
                      try {
                        await api(`/admin/webhooks/${item.id}`, "DELETE");
                        if (editing === item.id) resetForm();
                        if (openId === item.id) setOpenId("");
                        setConfirming("");
                        notifyFeedback(t("hooks.deleted"), "success");
                        await load();
                      } catch (reason) {
                        setError((reason as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  {confirming === item.id ? t("hooks.confirmDelete") : t("hooks.delete")}
                </button>
              </div>
              {openId === item.id && (
                <div className="webhook-deliveries">
                  <strong>{t("hooks.deliveries")}</strong>
                  {!deliveries.length && (
                    <p className="subtle">{t("hooks.noDeliveries")}</p>
                  )}
                  {deliveries.map((delivery) => (
                    <div className="service-row" key={delivery.id}>
                      <strong>
                        #{delivery.eventSeq} {delivery.eventType}
                      </strong>
                      <small>
                        {statusLabel(delivery.status)} · {delivery.attempts}
                        {delivery.lastError ? ` · ${delivery.lastError}` : ""}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </section>
      )}
    </>
  );
}
