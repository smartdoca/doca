import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, RefreshCw } from "lucide-react";
import type {
  HandoverEntry,
  HandoverKind,
  HandoverPreview,
} from "@core/modules/identity/resource-handover.js";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Select } from "@web/shared/components/select.js";
import "./resource-handover.css";

type Recipient = { id: string; display_name: string; public_id: string };
const pageSize = 50;
const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
        : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function ResourceHandoverDialog({
  source,
  close,
}: {
  source: { id: string; display_name: string };
  close: () => void;
}) {
  const { t } = useI18n();
  const endpoint = `/admin/users/${source.id}/resource-handover`;
  const [items, setItems] = useState<HandoverEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [page, setPage] = useState(0);
  const [targetQuery, setTargetQuery] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [recipientLoading, setRecipientLoading] = useState(false);
  const [moreRecipients, setMoreRecipients] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<HandoverPreview | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [sourceAvailable, setSourceAvailable] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSourceAvailable(false);
    void api<{ items: HandoverEntry[] }>(
      endpoint,
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => {
        setItems(data.items);
        setSourceAvailable(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setRecipientLoading(true);
    const timer = setTimeout(() => {
      void api<{ items: Recipient[]; nextCursor: string | null }>(
        `/admin/users?${new URLSearchParams({ status: "active", ...(targetQuery.trim() ? { q: targetQuery.trim() } : {}) })}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((data) => {
          setRecipients(data.items);
          setMoreRecipients(!!data.nextCursor);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setRecipientLoading(false);
        });
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [targetQuery]);

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (!query ||
            item.name
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase())) &&
          (scope === "all" ||
            (scope === "access"
              ? item.kind.endsWith("_access")
              : scope === "managed"
                ? !item.selectable
                : item.role === "owner" && item.selectable)),
      ),
    [items, query, scope],
  );
  const pageItems = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const availablePage = pageItems.filter((item) => item.selectable);
  const changeSelection = (keys: string[], checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys)
        if (checked) next.add(key);
        else next.delete(key);
      return next;
    });
    setError("");
    setSuccess("");
  };
  const roleLabel = (role: string) =>
    role === "admin"
      ? t("handover.folderAdmin")
      : t(`role.${role}` as "role.reader");
  async function inspect() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      setPreview(
        await api<HandoverPreview>(endpoint + "/preview", "POST", {
          targetUserId: targetId,
          keys: [...selected],
        }),
      );
      setPreviewPage(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ changes: number }>(
        endpoint + "/execute",
        "POST",
        {
          targetUserId: targetId,
          keys: [...selected],
          fingerprint: preview.fingerprint,
        },
      );
      setSelected(new Set());
      setPreview(null);
      setPage(0);
      setSuccess(t("handover.success", { count: result.changes }));
      setRevision((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
      // A lost response can follow a committed transaction. Always inspect the server inventory before another confirmation.
      setRevision((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }
  function pager(
    count: number,
    current: number,
    change: (value: number) => void,
  ) {
    return (
      count > pageSize && (
        <div className="handover-pagination">
          <button
            aria-label={t("handover.previousPage")}
            disabled={busy || current === 0}
            onClick={() => change(current - 1)}
          >
            ←
          </button>
          <span>
            {current + 1} / {Math.ceil(count / pageSize)}
          </span>
          <button
            aria-label={t("handover.nextPage")}
            disabled={busy || (current + 1) * pageSize >= count}
            onClick={() => change(current + 1)}
          >
            →
          </button>
        </div>
      )
    );
  }
  return (
    <Dialog
      title={t("handover.title", { name: source.display_name })}
      close={() => {
        if (!busy) close();
      }}
      className="resource-handover-dialog"
    >
      <p>{t("handover.intro")}</p>
      {error && (
        <div className="handover-notice error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="handover-notice success" role="status">
          {success}
        </div>
      )}
      {preview ? (
        <>
          <h3>{t("handover.review")}</h3>
          <div className="handover-summary">
            <ArrowRightLeft size={18} />
            <strong>
              {preview.source.display_name} → {preview.target.display_name}
            </strong>
            <span>
              {t("handover.summary", {
                count: preview.changes.length,
                affected: preview.affectedResources,
                size: sizeLabel(preview.bytes),
              })}
            </span>
          </div>
          <p className="subtle">{t("handover.confirmHelp")}</p>
          {!!preview.conflicts.length && (
            <div className="handover-notice error" role="alert">
              <strong>{t("handover.conflicts")}</strong>
              <ul>
                {preview.conflicts.map((conflict) => (
                  <li key={conflict.id + conflict.code}>
                    {conflict.name}：{t(`handover.conflict.${conflict.code}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div
            className="handover-table"
            role="table"
            aria-label={t("handover.review")}
          >
            {preview.changes
              .slice(previewPage * pageSize, (previewPage + 1) * pageSize)
              .map((change) => (
                <div
                  className="handover-change"
                  key={change.kind + change.id + change.action}
                  role="row"
                >
                  <span role="cell">
                    <strong>{change.name}</strong>
                    <small>
                      {t(`handover.kind.${change.kind}`)}
                      {change.deleted ? ` · ${t("handover.deleted")}` : ""}
                    </small>
                    {!!change.path.length && (
                      <small>
                        {t("handover.location", {
                          path: change.path.join(" / "),
                        })}
                      </small>
                    )}
                  </span>
                  <span role="cell">
                    {change.action === "access"
                      ? t("handover.accessChange", {
                          role: roleLabel(change.role),
                        })
                      : t(`handover.${change.action}`)}
                    <small>
                      {change.action === "access"
                        ? t(
                            change.includeDescendants
                              ? "handover.descendants"
                              : "handover.nodeOnly",
                          )
                        : t(
                            change.destination === "personal_root"
                              ? "handover.personalRoot"
                              : "handover.unchanged",
                          )}
                    </small>
                  </span>
                </div>
              ))}
          </div>
          {pager(preview.changes.length, previewPage, setPreviewPage)}
          {!!preview.retained.length && (
            <details className="handover-retained">
              <summary>
                {t("handover.retained", { count: preview.retained.length })}
              </summary>
              <ul>
                {preview.retained.map((item) => (
                  <li key={item.kind + item.id}>
                    {item.name} · {t(`handover.kind.${item.kind}`)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!preview.cancelledInvitations && (
            <p className="subtle">
              {t("handover.cancelInvitations", {
                count: preview.cancelledInvitations,
              })}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="subtle">{t("handover.scope")}</p>
          <fieldset
            disabled={busy || loading || !sourceAvailable}
            className="handover-controls"
          >
            <label>
              {t("handover.recipient")}
              <input
                aria-label={t("handover.recipientSearch")}
                placeholder={t("handover.recipientSearch")}
                value={targetQuery}
                onChange={(e) => {
                  setTargetQuery(e.target.value);
                  setTargetId("");
                }}
              />
            </label>
            <Select
              aria-label={t("handover.recipient")}
              value={targetId}
              disabled={recipientLoading}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">
                {recipientLoading
                  ? t("common.loading")
                  : t("handover.chooseRecipient")}
              </option>
              {recipients.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name} · @{person.public_id}
                </option>
              ))}
            </Select>
            {moreRecipients && (
              <small className="subtle">{t("handover.refineSearch")}</small>
            )}
          </fieldset>
          <div className="handover-toolbar">
            <input
              aria-label={t("handover.filter")}
              placeholder={t("handover.filter")}
              value={query}
              disabled={busy}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <Select
              aria-label={t("handover.inventory")}
              value={scope}
              disabled={busy}
              onChange={(e) => {
                setScope(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">{t("handover.all")}</option>
              <option value="owned">{t("handover.owned")}</option>
              <option value="access">{t("handover.access")}</option>
              <option value="managed">{t("handover.managed")}</option>
            </Select>
            <button
              disabled={busy || loading}
              aria-label={t("admin.refresh")}
              onClick={() => {
                setError("");
                setSelected(new Set());
                setRevision((n) => n + 1);
              }}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="handover-selection">
            <label>
              <input
                type="checkbox"
                checked={
                  availablePage.length > 0 &&
                  availablePage.every((item) => selected.has(item.key))
                }
                disabled={
                  busy || loading || !sourceAvailable || !availablePage.length
                }
                onChange={(e) =>
                  changeSelection(
                    availablePage.map((item) => item.key),
                    e.target.checked,
                  )
                }
              />
              {t("handover.selectPage")}
            </label>
            <span>{t("handover.selected", { count: selected.size })}</span>
            <button
              className="text-action"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              {t("handover.clear")}
            </button>
          </div>
          {loading ? (
            <div className="empty">{t("common.loading")}</div>
          ) : (
            <div
              className="handover-table"
              role="table"
              aria-label={t("handover.inventory")}
            >
              {!pageItems.length && (
                <div className="empty">{t("handover.empty")}</div>
              )}
              {pageItems.map((item) => (
                <label className="handover-entry" key={item.key} role="row">
                  <input
                    aria-label={item.name}
                    type="checkbox"
                    checked={selected.has(item.key)}
                    disabled={busy || !sourceAvailable || !item.selectable}
                    onChange={(e) =>
                      changeSelection([item.key], e.target.checked)
                    }
                  />
                  <span role="cell">
                    <strong>{item.name}</strong>
                    <small>
                      {t(`handover.kind.${item.kind as HandoverKind}`)}
                      {item.deleted ? ` · ${t("handover.deleted")}` : ""}
                    </small>
                    {!!item.path.length && (
                      <small>
                        {t("handover.location", {
                          path: item.path.join(" / "),
                        })}
                      </small>
                    )}
                  </span>
                  <span role="cell" className="subtle">
                    {item.reason
                      ? t(`handover.${item.reason}`)
                      : item.size
                        ? sizeLabel(item.size)
                        : item.role === "member"
                          ? t("handover.access")
                          : roleLabel(item.role)}
                  </span>
                </label>
              ))}
            </div>
          )}
          {pager(filtered.length, page, setPage)}
          {selected.size > 500 && (
            <div className="handover-notice error" role="alert">
              {t("handover.selectionLimit")}
            </div>
          )}
        </>
      )}
      <footer>
        <button
          disabled={busy}
          onClick={() => (preview ? setPreview(null) : close())}
        >
          {preview ? t("handover.back") : t("dialog.close")}
        </button>
        {preview ? (
          <button
            className="primary"
            disabled={busy || !!preview.conflicts.length}
            onClick={() => void execute()}
          >
            {busy ? t("common.loading") : t("handover.confirm")}
          </button>
        ) : (
          <button
            className="primary"
            disabled={
              busy ||
              loading ||
              !sourceAvailable ||
              !targetId ||
              !selected.size ||
              selected.size > 500
            }
            onClick={() => void inspect()}
          >
            {busy ? t("common.loading") : t("handover.preview")}
          </button>
        )}
      </footer>
    </Dialog>
  );
}
