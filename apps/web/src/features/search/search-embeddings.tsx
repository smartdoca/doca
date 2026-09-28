import { htmlLang } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import "@web/features/search/search-embeddings.css";

type Task = {
  status: string;
  taskUid: number | null;
  name: string;
  action?: "apply" | "delete";
  notice: string;
  remoteStatus?: string | null;
  error?: string | null;
  batchUid?: number | null;
  updatedAt?: string;
  endpoint?: string;
  indexName?: string;
};
type Embedder = {
  name: string;
  supported: boolean;
  remotePresent?: boolean;
  modelId: string;
  needsApply: boolean;
  documentTemplate: string;
  documentTemplateMaxBytes: number;
};
type Model = {
  id: string;
  name: string;
  model: string;
  vendor: string;
  dimensions: number | null;
  issue: string;
};
type Config = {
  enabled: boolean;
  generation: number;
  endpoint: string;
  indexName: string;
  task: Task;
  embedders: Embedder[];
  models: Model[];
  aiRevision: number;
  notice?: string;
  minScore: number;
};
const defaults = (): Embedder => ({
  name: "knowledge_v1",
  supported: true,
  modelId: "",
  needsApply: true,
  documentTemplate: "{{doc.title}}\n{{doc.text}}",
  documentTemplateMaxBytes: 8000,
});
const pending = (task?: Task) =>
  !!task && ["submitting", "enqueued", "processing"].includes(task.status);
function taskLabel(task: Task, t: ReturnType<typeof useI18n>["t"]) {
  const deleting = task.action === "delete";
  return (
    (
      (deleting
        ? {
            submitting: t("embeddings.deleteSubmitting"),
            enqueued: t("embeddings.deleteEnqueued"),
            processing: t("embeddings.deleteProcessing"),
            succeeded: t("embeddings.deleted"),
            failed: t("embeddings.deleteFailed"),
            canceled: t("embeddings.canceled"),
            unknown: t("embeddings.unknown"),
          }
        : {
            submitting: t("embeddings.submitting"),
            enqueued: t("embeddings.enqueued"),
            processing: t("embeddings.processing"),
            succeeded: t("embeddings.succeeded"),
            failed: t("embeddings.failed"),
            canceled: t("embeddings.canceled"),
            unknown: t("embeddings.unknown"),
          }) as Record<string, string>
    )[task.status] ?? task.status
  );
}

export function SearchEmbeddingSettings() {
  const { t, locale } = useI18n();
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState(defaults);
  const [selected, setSelected] = useState("");
  const [task, setTask] = useState<Task>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [minScore, setMinScore] = useState(0.7);
  const [savingRelevance, setSavingRelevance] = useState(false);
  const [removing, setRemoving] = useState("");
  function accept(value: Config) {
    setConfig(value);
    setTask(value.task);
    setMinScore(value.minScore);
    const first =
      value.embedders.find((e) => e.name === value.task.name) ??
      value.embedders[0];
    setSelected(first?.name ?? "");
    setForm(first ?? defaults());
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<Config>(
      "/admin/search/embeddings",
      "GET",
      undefined,
      controller.signal,
    )
      .then(accept)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!pending(task)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Task>("/admin/search/embeddings/status");
        if (!stopped) {
          if (!pending(next)) {
            if (next.status === "succeeded") {
              const value = await api<Config>("/admin/search/embeddings");
              if (!stopped) {
                accept(value);
                setMessage(
                  next.action === "delete"
                    ? t("embeddings.removed")
                    : t("embeddings.applied"),
                );
              }
            } else setTask(next);
            return;
          }
          setTask(next);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [task?.status, task?.taskUid, t]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      accept(await api<Config>("/admin/search/embeddings"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const model = config?.models.find((m) => m.id === form.modelId);
  const disabled = busy || pending(task) || !config?.enabled;
  return (
    <section
      className="search-settings-card search-embedding-settings"
      aria-labelledby="search-embedding-heading"
    >
      <header className="search-card-heading">
        <div>
          <h3 id="search-embedding-heading">{t("embeddings.title")}</h3>
          <p className="subtle">{t("embeddings.intro")}</p>
        </div>
      </header>
      {!config && <p role="status">{error || t("embeddings.loading")}</p>}
      {config && !config.enabled && <p>{t("embeddings.enableFirst")}</p>}
      {config?.enabled && (
        <>
          <p className="subtle">
            {t("embeddings.currentIndex", {
              name: config.indexName,
              endpoint: config.endpoint,
            })}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setMessage("");
              try {
                const result = await api<Task>(
                  "/admin/search/embeddings",
                  "PUT",
                  {
                    generation: config.generation,
                    name: form.name,
                    modelId: form.modelId,
                    aiRevision: config.aiRevision,
                    documentTemplate: form.documentTemplate,
                    documentTemplateMaxBytes: form.documentTemplateMaxBytes,
                  },
                );
                setTask(result);
                setMessage(t("embeddings.submitted"));
              } catch (e) {
                setError((e as Error).message);
                const progress = await api<Task>(
                  "/admin/search/embeddings/status",
                ).catch(() => undefined);
                if (progress) setTask(progress);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {t("embeddings.configuration")}
              <select
                disabled={disabled}
                value={selected}
                onChange={(e) => {
                  const value = config.embedders.find(
                    (item) => item.name === e.target.value,
                  );
                  setSelected(e.target.value);
                  setMessage("");
                  const fresh = defaults();
                  let version = 1;
                  while (
                    config.embedders.some(
                      (item) => item.name === `knowledge_v${version}`,
                    )
                  )
                    version++;
                  setForm(
                    value ? value : { ...fresh, name: `knowledge_v${version}` },
                  );
                }}
              >
                <option value="">{t("embeddings.add")}</option>
                {config.embedders.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {!form.supported ? (
              <p>{t("embeddings.unsupported")}</p>
            ) : (
              <>
                <label>
                  {t("embeddings.name")}
                  <input
                    value={form.name}
                    readOnly={!!selected}
                    disabled={disabled}
                    required
                    pattern="[a-zA-Z0-9_-]{1,64}"
                    maxLength={64}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <small>{t("embeddings.nameHelp")}</small>
                <label>
                  {t("embeddings.model")}
                  <select
                    required
                    disabled={disabled}
                    value={form.modelId}
                    onChange={(e) =>
                      setForm({ ...form, modelId: e.target.value })
                    }
                  >
                    <option value="">{t("embeddings.chooseModel")}</option>
                    {form.modelId &&
                      !config.models.some((m) => m.id === form.modelId) && (
                        <option value={form.modelId} disabled>
                          {t("embeddings.missingModel")}
                        </option>
                      )}
                    {config.models.map((m) => (
                      <option key={m.id} value={m.id} disabled={!!m.issue}>
                        {m.vendor} · {m.name}
                        {m.issue ? `（${m.issue}）` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {!config.models.length && <p>{t("embeddings.noModels")}</p>}
                {model && (
                  <p className="subtle">
                    {t("embeddings.modelDetails", {
                      model: model.model,
                      dimensions:
                        model.dimensions ?? t("embeddings.defaultDimensions"),
                    })}
                    {model.issue && ` · ${model.issue}`}
                  </p>
                )}
                {selected && form.needsApply && (
                  <p role="status">{t("embeddings.needsApply")}</p>
                )}
                <p className="subtle">{t("embeddings.providerHelp")}</p>
                <details>
                  <summary>{t("embeddings.content")}</summary>
                  <label>
                    {t("embeddings.template")}
                    <textarea
                      rows={3}
                      value={form.documentTemplate}
                      disabled={disabled}
                      required
                      maxLength={8000}
                      onChange={(e) =>
                        setForm({ ...form, documentTemplate: e.target.value })
                      }
                    />
                  </label>
                  <small>{t("embeddings.templateHelp")}</small>
                  <label>
                    {t("embeddings.maxBytes")}
                    <input
                      type="number"
                      value={form.documentTemplateMaxBytes}
                      disabled={disabled}
                      required
                      min={1}
                      max={1000000}
                      step={1}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          documentTemplateMaxBytes: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <small>{t("embeddings.maxBytesHelp")}</small>
                </details>
                <p className="subtle">{t("embeddings.costHelp")}</p>
                <button
                  className="primary"
                  disabled={disabled || !model || !!model.issue}
                >
                  {t("embeddings.save")}
                </button>
              </>
            )}
            {selected ? (
              <button
                type="button"
                className="danger"
                disabled={disabled}
                onClick={() => {
                  setError("");
                  setRemoving(selected);
                }}
              >
                {t("embeddings.delete")}
              </button>
            ) : null}
          </form>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {t("embeddings.refresh")}
      </button>
      {config && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSavingRelevance(true);
            setError("");
            setMessage("");
            try {
              await api("/admin/search/relevance", "PUT", { minScore });
              setConfig({ ...config, minScore });
              setMessage(t("embeddings.relevanceSaved"));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setSavingRelevance(false);
            }
          }}
        >
          <label>
            {t("embeddings.minScore")}
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              required
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            />
          </label>
          <small>{t("embeddings.minScoreHelp")}</small>
          <button disabled={savingRelevance}>
            {t("embeddings.saveRelevance")}
          </button>
        </form>
      )}
      {task && task.status !== "idle" && (
        <p role="status">
          {task.name}
          {task.taskUid !== null
            ? t("embeddings.taskLabel", { id: task.taskUid })
            : ""}
          : {taskLabel(task, t)}
        </p>
      )}
      {task && (task.error || task.remoteStatus || task.taskUid !== null) && (
        <details className="search-embedding-diagnostics">
          <summary>{t("embeddings.diagnostics")}</summary>
          <dl>
            <div>
              <dt>{t("embeddings.platformStatus")}</dt>
              <dd>{task.status}</dd>
            </div>
            <div>
              <dt>{t("embeddings.remoteStatus")}</dt>
              <dd>{task.remoteStatus || t("searchAdmin.unread")}</dd>
            </div>
            <div>
              <dt>{t("embeddings.taskUid")}</dt>
              <dd>{task.taskUid ?? t("searchAdmin.noTask")}</dd>
            </div>
            {task.batchUid !== null && task.batchUid !== undefined && (
              <div>
                <dt>{t("embeddings.batchUid")}</dt>
                <dd>{task.batchUid}</dd>
              </div>
            )}
            {task.updatedAt && (
              <div>
                <dt>{t("embeddings.updated")}</dt>
                <dd>
                  {new Date(task.updatedAt).toLocaleString(htmlLang(locale))}
                </dd>
              </div>
            )}
          </dl>
          {task.error && <pre>{task.error}</pre>}
        </details>
      )}
      {config?.notice && <p role="status">{config.notice}</p>}
      {task?.notice && <p role="status">{task.notice}</p>}
      <p className="subtle">{t("embeddings.lifecycleHelp")}</p>
      {!removing && <Feedback message={error} tone="error" />}
      <Feedback message={message} tone="success" />
      {removing && config && (
        <Dialog
          title={t("embeddings.deleteTitle")}
          close={() => {
            if (!busy) setRemoving("");
          }}
          className="modal-compact"
        >
          <p>{t("embeddings.deleteWarning", { name: removing })}</p>
          <Feedback message={error} tone="error" />
          <footer>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRemoving("")}
            >
              {t("embeddings.cancel")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                const name = removing;
                void (async () => {
                  setBusy(true);
                  setError("");
                  setMessage("");
                  try {
                    const result = await api<Task>(
                      "/admin/search/embeddings",
                      "DELETE",
                      {
                        generation: config.generation,
                        name,
                      },
                    );
                    setRemoving("");
                    setTask(result);
                    if (!pending(result)) {
                      accept(await api<Config>("/admin/search/embeddings"));
                      setMessage(result.notice || t("embeddings.removed"));
                    } else setMessage(t("embeddings.deleteSubmitted"));
                  } catch (e) {
                    setError((e as Error).message);
                    const progress = await api<Task>(
                      "/admin/search/embeddings/status",
                    ).catch(() => undefined);
                    if (progress) setTask(progress);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {busy ? t("embeddings.deleting") : t("embeddings.confirmDelete")}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
