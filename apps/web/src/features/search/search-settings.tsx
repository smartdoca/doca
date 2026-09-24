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
        {error || "正在加载搜索配置…"}
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
        section === "connection" ? "连接设置已保存" : "索引设置已保存",
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
        action === "reindex" ? "已安排后台重建索引" : "已安排后台对账",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const phase = !saved.enabled
    ? "已暂停"
    : {
        idle: "等待下一轮",
        remote: "读取索引清单",
        source: "核对文档",
        enqueue: "安排修复",
        waiting: "等待修复完成",
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
            <h3 id="search-connection-heading">Meilisearch 连接设置</h3>
            <p>连接搜索服务，管理访问密钥。</p>
          </div>
          <span
            className={`search-status-badge ${saved.enabled ? "is-active" : ""}`}
          >
            {saved.enabled ? "已启用" : "未启用"}
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
              启用 Meilisearch<small>关闭后使用数据库基础检索。</small>
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
              服务地址
              <input
                value={data.endpoint}
                disabled={busy}
                onChange={(e) => setData({ ...data, endpoint: e.target.value })}
                required
              />
            </label>
            <button className="primary" disabled={busy}>
              保存连接
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
            <h3 id="search-index-heading">索引管理</h3>
            <p>管理文档索引、同步策略与修复任务。</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            刷新状态
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
              索引名称
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
              自动对账间隔（小时）
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
              <small>定期检查遗漏，只修复有差异的记录。</small>
            </label>
          </div>
          <label className="search-setting-toggle">
            <span>
              识别文档中的图片
              <small>
                {data.imageRecognitionAvailable
                  ? "提取图片中的信息用于检索，可能产生模型费用。"
                  : "暂未开放识别，当前仅保存偏好，不产生费用。"}
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
              <strong>{data.indexing ? "正在建立索引" : phase}</strong>
              <span>
                {data.lastIndexedAt
                  ? `最近索引：${new Date(data.lastIndexedAt).toLocaleString()}`
                  : "尚无本次启动的索引记录"}
              </span>
            </div>
            <dl>
              <div>
                <dt>已检查文档</dt>
                <dd>{data.reconciliation.scanned}</dd>
              </div>
              <div>
                <dt>已安排修复</dt>
                <dd>{data.reconciliation.differences}</dd>
              </div>
              <div>
                <dt>待修复</dt>
                <dd>{data.reconciliation.pending}</dd>
              </div>
            </dl>
            {saved.enabled && data.reconciliation.phase === "idle" && (
              <small>
                下次对账：
                {new Date(data.reconciliation.nextAt).toLocaleString()}
              </small>
            )}
            {syncError && (
              <div className="search-sync-error" role="alert">
                <strong>同步失败，正在自动重试</strong>
                <p>{syncError}</p>
                <small>
                  已重试 {data.reconciliation.failedAttempts} 次
                  {data.reconciliation.retryAt
                    ? ` · 下次重试：${new Date(data.reconciliation.retryAt).toLocaleString()}`
                    : ""}
                </small>
              </div>
            )}
            {data.embedding &&
              (data.embedding.error || data.embedding.taskUid !== null) && (
                <details className="search-sync-diagnostics">
                  <summary>查看向量任务详情</summary>
                  <p>
                    配置：{data.embedding.name || "未命名"} · 平台状态：
                    {data.embedding.status} · Meilisearch 状态：
                    {data.embedding.remoteStatus || "未读取"}
                  </p>
                  <p>
                    任务 UID：{data.embedding.taskUid ?? "未生成"}
                    {data.embedding.batchUid !== null &&
                    data.embedding.batchUid !== undefined
                      ? ` · 批次 UID：${data.embedding.batchUid}`
                      : ""}
                  </p>
                  {data.embedding.updatedAt && (
                    <p>
                      最近更新：
                      {new Date(data.embedding.updatedAt).toLocaleString()}
                    </p>
                  )}
                  {data.embedding.error && (
                    <pre>{data.embedding.error}</pre>
                  )}
                </details>
              )}
          </div>
          <details className="search-settings-details">
            <summary>同步说明与历史</summary>
            <p>
              文档变更通过后台增量同步，定期对账补齐遗漏。所有搜索结果都会重新校验用户权限。
            </p>
            {data.reconciliation.checkedAt && (
              <p>
                最近扫描完成：
                {new Date(data.reconciliation.checkedAt).toLocaleString()}
              </p>
            )}
            {data.reconciliation.completedAt && (
              <p>
                最近修复完成：
                {new Date(data.reconciliation.completedAt).toLocaleString()}
              </p>
            )}
          </details>
          <footer className="search-card-actions">
            <button className="primary" disabled={busy}>
              保存索引设置
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
              立即对账
            </button>
            <button
              type="button"
              disabled={!saved.enabled || busy || data.indexing}
              onClick={() => void run("reindex")}
            >
              重建索引
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
