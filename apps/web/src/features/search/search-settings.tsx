import { htmlLang } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { SearchEmbeddingSettings } from "@web/features/search/search-embeddings.js";
import { ServiceCredentials } from "@web/features/admin/service-credentials.js";
type Config = {
  generation: number;
  enabled: boolean;
  endpoint: string;
  index_name: string;
  credentialConfigured: boolean;
  indexing: boolean;
  lastError: string;
  lastIndexedAt: string | null;
  embedding?: {
    status: string;
    notice: string;
    taskUid: number | null;
    remoteStatus?: string | null;
    error?: string | null;
    batchUid?: number | null;
    updatedAt?: string;
    name?: string;
  };
  syncDiagnostic?: string | null;
  allowedOrigins: string[];
  image_recognition_enabled: boolean;
  imageRecognitionAvailable: boolean;
  reconcile_interval_hours: number;
  reconciliation: {
    phase: "idle" | "remote" | "source" | "enqueue" | "waiting";
    scanned: number;
    differences: number;
    pending: number;
    startedAt: string | null;
    checkedAt: string | null;
    completedAt: string | null;
    nextAt: string;
    lastError: string | null;
    failedAttempts: number;
    retryAt: string | null;
  };
};
import "@web/features/search/search-settings.css";
export function SearchSettings() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Config | null>(null);
  const [saved, setSaved] = useState<Config | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const value = await api<Config>("/admin/search");
    setData(value);
    setSaved(value);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  if (!data || !saved)
    return (
      <p className="empty" role={error ? "alert" : "status"}>
        {error || t("searchAdmin.loading")}
      </p>
    );
  const connection = { enabled: data.enabled, endpoint: data.endpoint };
  const index = {
    index_name: data.index_name,
    image_recognition_enabled: data.image_recognition_enabled,
    reconcile_interval_hours: data.reconcile_interval_hours,
  };
  async function save(section: "connection" | "index", enabled?: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = {
        ...saved!,
        ...(section === "connection"
          ? { ...connection, ...(enabled === undefined ? {} : { enabled }) }
          : index),
      };
      await api("/admin/search", "PUT", {
        enabled: next.enabled,
        endpoint: next.endpoint,
        indexName: next.index_name,
        imageRecognitionEnabled: next.image_recognition_enabled,
        reconcileIntervalHours: next.reconcile_interval_hours,
      });
      const value = await api<Config>("/admin/search");
      setSaved(value);
      setData((previous) =>
        previous
          ? {
              ...value,
              ...(section === "connection"
                ? {
                    index_name: previous.index_name,
                    image_recognition_enabled:
                      previous.image_recognition_enabled,
                    reconcile_interval_hours: previous.reconcile_interval_hours,
                  }
                : { enabled: previous.enabled, endpoint: previous.endpoint }),
            }
          : value,
      );
      setMessage(
        section === "connection"
          ? t("searchAdmin.connectionSaved")
          : t("searchAdmin.indexSaved"),
      );
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function run(action: "reindex" | "reconcile") {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/search/${action}`, "POST");
      const value = await api<Config>("/admin/search");
      setSaved(value);
      setData((previous) =>
        previous
          ? {
              ...value,
              enabled: previous.enabled,
              endpoint: previous.endpoint,
              index_name: previous.index_name,
              image_recognition_enabled: previous.image_recognition_enabled,
              reconcile_interval_hours: previous.reconcile_interval_hours,
            }
          : value,
      );
      setMessage(
        action === "reindex"
          ? t("searchAdmin.reindexQueued")
          : t("searchAdmin.reconcileQueued"),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const phase = !saved.enabled
    ? t("searchAdmin.paused")
    : {
        idle: t("searchAdmin.idle"),
        remote: t("searchAdmin.remote"),
        source: t("searchAdmin.source"),
        enqueue: t("searchAdmin.enqueue"),
        waiting: t("searchAdmin.waiting"),
      }[data.reconciliation.phase];
  const syncError =
    data.syncDiagnostic ||
    data.embedding?.notice ||
    data.lastError ||
    data.reconciliation.lastError;
  return (
    <div className="search-settings-layout">
      <section
        className="search-settings-card"
        aria-labelledby="search-connection-heading"
      >
        <header className="search-card-heading">
          <div>
            <h3 id="search-connection-heading">
              {t("searchAdmin.connection")}
            </h3>
            <p>{t("searchAdmin.connectionHelp")}</p>
          </div>
          <span
            className={`search-status-badge ${saved.enabled ? "is-active" : ""}`}
          >
            {saved.enabled ? t("services.enabled") : t("services.disabled")}
          </span>
        </header>
        <form
          className="search-settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save("connection");
          }}
        >
          <label className="search-setting-toggle">
            <span>
              {t("searchAdmin.enable")}
              <small>{t("searchAdmin.enableHelp")}</small>
            </span>
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={busy}
              onChange={(e) => {
                const enabled = e.target.checked;
                setData({ ...data, enabled });
                void save("connection", enabled).then((ok) => {
                  if (!ok)
                    setData((previous) =>
                      previous ? { ...previous, enabled: !enabled } : previous,
                    );
                });
              }}
            />
          </label>
          <div className="search-connection-row">
            <label>
              {t("searchAdmin.endpoint")}
              <input
                value={data.endpoint}
                disabled={busy}
                onChange={(e) => setData({ ...data, endpoint: e.target.value })}
                required
              />
            </label>
            <button className="primary" disabled={busy}>
              {t("searchAdmin.saveConnection")}
            </button>
          </div>
        </form>
        <ServiceCredentials
          onlySearch
          onSearchSaved={(config) => {
            const fields = {
              credentialConfigured: config.apiKey === null,
              allowedOrigins: config.allowedOrigins,
            };
            setData((previous) =>
              previous ? { ...previous, ...fields } : previous,
            );
            setSaved((previous) =>
              previous ? { ...previous, ...fields } : previous,
            );
          }}
        />
      </section>
      <section
        className="search-settings-card"
        aria-labelledby="search-index-heading"
      >
        <header className="search-card-heading">
          <div>
            <h3 id="search-index-heading">{t("searchAdmin.index")}</h3>
            <p>{t("searchAdmin.indexHelp")}</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            {t("searchAdmin.refresh")}
          </button>
        </header>
        <form
          className="search-settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save("index");
          }}
        >
          <div className="search-field-grid">
            <label>
              {t("searchAdmin.indexName")}
              <input
                value={data.index_name}
                disabled={busy}
                pattern="[a-zA-Z0-9_-]{1,64}"
                required
                onChange={(e) =>
                  setData({ ...data, index_name: e.target.value })
                }
              />
            </label>
            <label>
              {t("searchAdmin.interval")}
              <input
                type="number"
                min={1}
                max={168}
                step={1}
                required
                disabled={busy}
                value={data.reconcile_interval_hours}
                onChange={(e) =>
                  setData({
                    ...data,
                    reconcile_interval_hours: Number(e.target.value),
                  })
                }
              />
              <small>{t("searchAdmin.intervalHelp")}</small>
            </label>
          </div>
          <label className="search-setting-toggle">
            <span>
              {t("searchAdmin.images")}
              <small>
                {data.imageRecognitionAvailable
                  ? t("searchAdmin.imagesHelp")
                  : t("searchAdmin.imagesUnavailable")}
              </small>
            </span>
            <input
              type="checkbox"
              disabled={busy}
              checked={data.image_recognition_enabled}
              onChange={(e) =>
                setData({
                  ...data,
                  image_recognition_enabled: e.target.checked,
                })
              }
            />
          </label>
          <div className="search-index-status" role="status">
            <div className="search-status-title">
              <strong>
                {data.indexing ? t("searchAdmin.indexing") : phase}
              </strong>
              <span>
                {data.lastIndexedAt
                  ? t("searchAdmin.lastIndex", {
                      date: new Date(data.lastIndexedAt).toLocaleString(
                        htmlLang(locale),
                      ),
                    })
                  : t("searchAdmin.noIndex")}
              </span>
            </div>
            <dl>
              <div>
                <dt>{t("searchAdmin.scanned")}</dt>
                <dd>{data.reconciliation.scanned}</dd>
              </div>
              <div>
                <dt>{t("searchAdmin.differences")}</dt>
                <dd>{data.reconciliation.differences}</dd>
              </div>
              <div>
                <dt>{t("searchAdmin.pending")}</dt>
                <dd>{data.reconciliation.pending}</dd>
              </div>
            </dl>
            {saved.enabled && data.reconciliation.phase === "idle" && (
              <small>
                {t("searchAdmin.nextReconcile", {
                  date: new Date(data.reconciliation.nextAt).toLocaleString(
                    htmlLang(locale),
                  ),
                })}
              </small>
            )}
            {syncError && (
              <div className="search-sync-error" role="alert">
                <strong>{t("searchAdmin.syncFailed")}</strong>
                <p>{syncError}</p>
                <small>
                  {t("searchAdmin.retries", {
                    count: data.reconciliation.failedAttempts,
                  })}
                  {data.reconciliation.retryAt
                    ? t("searchAdmin.nextRetry", {
                        date: new Date(
                          data.reconciliation.retryAt,
                        ).toLocaleString(htmlLang(locale)),
                      })
                    : ""}
                </small>
              </div>
            )}
            {data.embedding &&
              (data.embedding.error || data.embedding.taskUid !== null) && (
                <details className="search-sync-diagnostics">
                  <summary>{t("searchAdmin.diagnostics")}</summary>
                  <p>
                    {t("searchAdmin.embeddingState", {
                      name: data.embedding.name || t("searchAdmin.unnamed"),
                      status: data.embedding.status,
                      remote:
                        data.embedding.remoteStatus || t("searchAdmin.unread"),
                    })}
                  </p>
                  <p>
                    {t("searchAdmin.task", {
                      id: data.embedding.taskUid ?? t("searchAdmin.noTask"),
                    })}
                    {data.embedding.batchUid !== null &&
                    data.embedding.batchUid !== undefined
                      ? t("searchAdmin.batch", { id: data.embedding.batchUid })
                      : ""}
                  </p>
                  {data.embedding.updatedAt && (
                    <p>
                      {t("searchAdmin.lastUpdated", {
                        date: new Date(data.embedding.updatedAt).toLocaleString(
                          htmlLang(locale),
                        ),
                      })}
                    </p>
                  )}
                  {data.embedding.error && <pre>{data.embedding.error}</pre>}
                </details>
              )}
          </div>
          <details className="search-settings-details">
            <summary>{t("searchAdmin.history")}</summary>
            <p>{t("searchAdmin.historyHelp")}</p>
            {data.reconciliation.checkedAt && (
              <p>
                {t("searchAdmin.lastScan", {
                  date: new Date(data.reconciliation.checkedAt).toLocaleString(
                    htmlLang(locale),
                  ),
                })}
              </p>
            )}
            {data.reconciliation.completedAt && (
              <p>
                {t("searchAdmin.lastRepair", {
                  date: new Date(
                    data.reconciliation.completedAt,
                  ).toLocaleString(htmlLang(locale)),
                })}
              </p>
            )}
          </details>
          <footer className="search-card-actions">
            <button className="primary" disabled={busy}>
              {t("searchAdmin.saveIndex")}
            </button>
            <button
              type="button"
              disabled={
                !saved.enabled ||
                busy ||
                data.indexing ||
                data.reconciliation.phase !== "idle"
              }
              onClick={() => void run("reconcile")}
            >
              {t("searchAdmin.reconcile")}
            </button>
            <button
              type="button"
              disabled={!saved.enabled || busy || data.indexing}
              onClick={() => void run("reindex")}
            >
              {t("searchAdmin.rebuild")}
            </button>
          </footer>
        </form>
      </section>
      <SearchEmbeddingSettings key={saved.generation} />
      <Feedback message={error} tone="error" />
      <Feedback message={message} tone="success" />
    </div>
  );
}
