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
function taskLabel(task: Task) {
  const deleting = task.action === "delete";
  return (
    (
      deleting
        ? {
            submitting: "正在提交删除",
            enqueued: "等待删除",
            processing: "正在移除向量",
            succeeded: "配置已删除",
            failed: "删除失败",
            canceled: "已取消",
            unknown: "结果待确认",
          }
        : {
            submitting: "正在提交",
            enqueued: "等待处理",
            processing: "正在生成向量",
            succeeded: "配置已生效",
            failed: "配置失败",
            canceled: "已取消",
            unknown: "结果待确认",
          }
    ) as Record<string, string>
  )[task.status] ?? task.status;
}

export function SearchEmbeddingSettings() {
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
                    ? "向量配置已从 Meilisearch 删除"
                    : "向量模型配置已生效",
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
  }, [task?.status, task?.taskUid]);
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
          <h3 id="search-embedding-heading">向量索引</h3>
          <p className="subtle">
            选择「AI 模型管理」中的向量模型，复用厂商地址、密钥和向量维度。每个配置名称都会在
            Meilisearch 索引里单独生成并保存一份向量；无用的配置请删除，避免重复计费。
          </p>
        </div>
      </header>
      {!config && <p role="status">{error || "正在读取向量配置…"}</p>}
      {config && !config.enabled && (
        <p>请先在上方保存并启用 Meilisearch，再配置向量模型。</p>
      )}
      {config?.enabled && (
        <>
          <p className="subtle">
            当前索引：{config.indexName}（{config.endpoint}）
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
                setMessage("配置任务已提交，Meilisearch 正在后台处理");
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
              模型配置
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
                <option value="">新增模型配置</option>
                {config.embedders.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {!form.supported ? (
              <p>
                该配置使用其他模型来源或自定义接口，目前不能在页面编辑，但可以删除以清理
                Meilisearch 上的向量。也可选择“新增模型配置”。
              </p>
            ) : (
              <>
                <label>
                  配置名称
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
                <small>
                  升级时可新建
                  knowledge_v2。多个配置会分别生成向量，也会分别产生费用。
                </small>
                <label>
                  使用的 AI 向量模型
                  <select
                    required
                    disabled={disabled}
                    value={form.modelId}
                    onChange={(e) =>
                      setForm({ ...form, modelId: e.target.value })
                    }
                  >
                    <option value="">请选择向量模型</option>
                    {form.modelId &&
                      !config.models.some((m) => m.id === form.modelId) && (
                        <option value={form.modelId} disabled>
                          原模型已移除或不再是向量模型
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
                {!config.models.length && (
                  <p>
                    暂无向量模型。请先到「AI
                    模型管理」添加模型，将模型用途设为「向量模型」。
                  </p>
                )}
                {model && (
                  <p className="subtle">
                    模型：{model.model} · 向量维度：
                    {model.dimensions ?? "模型默认值"}
                    {model.issue && ` · ${model.issue}`}
                  </p>
                )}
                {selected && form.needsApply && (
                  <p role="status">
                    已保留你保存的模型与内容设置。配置尚未生效，或模型信息有更新，请检查任务状态后重新应用。
                  </p>
                )}
                <p className="subtle">
                  厂商地址、密钥和维度统一在 AI
                  模型管理中维护。修改后在这里重新应用；Meilisearch
                  需要能访问厂商地址。
                </p>
                <details>
                  <summary>内容设置</summary>
                  <label>
                    向量化内容模板
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
                  <small>
                    {
                      "默认使用 {{doc.title}} 和 {{doc.text}}，即文档标题和正文。"
                    }
                  </small>
                  <label>
                    每篇文档的最大输入字节数
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
                  <small>
                    超过上限的内容会被截断。字节数不等于 token
                    数，请根据模型限制调整。
                  </small>
                </details>
                <p className="subtle">
                  保存会将标题、正文等模板内容发送给所选模型服务。新增配置或修改模型、维度、内容模板可能重新计算现有文档的向量并产生费用。
                </p>
                <button
                  className="primary"
                  disabled={disabled || !model || !!model.issue}
                >
                  保存并应用向量配置
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
                删除此向量配置
              </button>
            ) : null}
          </form>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        重新读取配置和状态
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
              setMessage("AI 搜索相关度门槛已保存，无需重新生成向量");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setSavingRelevance(false);
            }
          }}
        >
          <label>
            AI 搜索最低相关度
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
          <small>
            低于此分数的结果不展示。默认
            0.70；调高可减少无关结果，调低可扩大搜索范围。修改立即用于搜索，不重新计算文档向量。
          </small>
          <button disabled={savingRelevance}>保存相关度设置</button>
        </form>
      )}
      {task && task.status !== "idle" && (
        <p role="status">
          {task.name}
          {task.taskUid !== null ? ` · 任务 ${task.taskUid}` : ""}：
          {taskLabel(task)}
        </p>
      )}
      {task && (task.error || task.remoteStatus || task.taskUid !== null) && (
        <details className="search-embedding-diagnostics">
          <summary>查看向量任务诊断</summary>
          <dl>
            <div>
              <dt>平台状态</dt>
              <dd>{task.status}</dd>
            </div>
            <div>
              <dt>Meilisearch 状态</dt>
              <dd>{task.remoteStatus || "未读取"}</dd>
            </div>
            <div>
              <dt>任务 UID</dt>
              <dd>{task.taskUid ?? "未生成"}</dd>
            </div>
            {task.batchUid !== null && task.batchUid !== undefined && (
              <div>
                <dt>批次 UID</dt>
                <dd>{task.batchUid}</dd>
              </div>
            )}
            {task.updatedAt && (
              <div>
                <dt>最近更新时间</dt>
                <dd>{new Date(task.updatedAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
          {task.error && <pre>{task.error}</pre>}
        </details>
      )}
      {config?.notice && <p role="status">{config.notice}</p>}
      {task?.notice && <p role="status">{task.notice}</p>}
      <p className="subtle">
        最近成功应用的向量配置用于页面 AI 搜索和 Agent 文档检索。
        平台保留已保存的配置；任务成功后才视为生效，重启后可继续查询任务状态。
        删除会向 Meilisearch 提交移除该名称 embedder 的任务，完成后搜索不再使用它。
      </p>
      {!removing && <Feedback message={error} tone="error" />}
      <Feedback message={message} tone="success" />
      {removing && config && (
        <Dialog
          title="删除向量配置"
          close={() => {
            if (!busy) setRemoving("");
          }}
          className="modal-compact"
        >
          <p>
            将从 Meilisearch 删除「{removing}」。该名称下已生成的文档向量会一并移除，无法恢复。
          </p>
          <Feedback message={error} tone="error" />
          <footer>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRemoving("")}
            >
              取消
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
                      setMessage(
                        result.notice || "向量配置已从 Meilisearch 删除",
                      );
                    } else
                      setMessage(
                        "删除任务已提交，Meilisearch 正在后台移除该向量",
                      );
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
              {busy ? "正在删除…" : "确认删除"}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
