import { Switch } from "antd";
import { useEffect, useState } from "react";
import {
  Boxes,
  SlidersHorizontal,
  Plus,
  Sparkles,
  Server,
  Pencil,
} from "lucide-react";
import { defaultOfficialSkills } from "@core/modules/ai/skills.js";
import {
  aiProviders,
  providerPreset,
  embeddingSource,
  embeddingApi,
} from "@core/modules/ai/providers.js";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { SettingsTabs } from "@web/features/settings/settings-tabs.js";
import "@web/features/ai/ai.css";

const formats = [
  ["rich_text", "文档"],
  ["markdown", "Markdown"],
  ["spreadsheet", "表格"],
  ["canvas", "画板"],
  ["presentation", "演示文稿"],
];
const formatName = (id: string) => formats.find((f) => f[0] === id)?.[1] ?? id;
export function AIAdmin() {
  const [config, setConfig] = useState<any>(null),
    [revision, setRevision] = useState(0),
    [levels, setLevels] = useState<any[]>([]);
  const [tab, setTab] = useState("models"),
    [selected, setSelected] = useState("");
  const [edit, setEdit] = useState<{
    type: "vendor" | "model" | "skill" | "general" | "tools";
    draft: any;
  } | null>(null);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [catalogs, setCatalogs] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  async function load() {
    const r = await api<any>("/admin/ai");
    const { revision, limits, taskBudget, ...c } = r.config;
    setConfig(c);
    setRevision(revision);
    setLevels(r.levels);
    setSelected((id) =>
      c.vendors.some((v: any) => v.id === id) ? id : (c.vendors[0]?.id ?? ""),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function save(next: any) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/admin/ai/management", "PUT", {
        revision,
        config: {
          ...next,
          webSearch: next.webSearch
            ? (({ hasKey, ...value }: any) => value)(next.webSearch)
            : undefined,
          webFetch: next.webFetch
            ? (({ hasKey, ...value }: any) => value)(next.webFetch)
            : undefined,
          vendors: next.vendors.map(({ hasKey, ...v }: any) => v),
        },
      });
      await load();
      setEdit(null);
      setMessage("设置已保存");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function catalog(v: any) {
    setBusy(true);
    setError("");
    try {
      const r = await api<any>(`/admin/ai/vendors/${v.id}/catalog`);
      setCatalogs((c) => ({ ...c, [v.id]: r.models }));
      setMessage(`已读取 ${r.models.length} 个模型，添加模型时可选择`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const open = (type: NonNullable<typeof edit>["type"], draft: any) => {
    setError("");
    setMessage("");
    setEdit({ type, draft: structuredClone(draft) });
  };
  const change = (patch: any) =>
    setEdit((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  if (!config) return <p>{error || "正在加载 AI 设置…"}</p>;
  const vendor = config.vendors.find((v: any) => v.id === selected);
  const children = config.models.filter((m: any) => m.vendorId === selected);
  const d = edit?.draft;
  const modelVendor = config.vendors.find((v: any) => v.id === d?.vendorId);
  const modelProtocol = providerPreset(modelVendor?.provider).protocol;
  const supportsApiMode = modelProtocol === "openai" || modelProtocol === "azure";
  const newModel = () =>
    open("model", {
      id: crypto.randomUUID(),
      vendorId: selected,
      model: "",
      alias: "",
      enabled: true,
      tools: true,
      embedding: false,
      vision: false,
      pdf: false,
      levels: [],
      inputRate: 1,
      outputRate: 1,
      cacheRate: 1,
      imageRate: 1,
      maxInput: 32000,
      maxOutput: 4096,
    });
  async function detectDimensions() {
    setBusy(true);
    setError("");
    const draftId = d.id,
      model = d.model,
      vendorId = d.vendorId,
      protocol = d.embeddingApi;
    try {
      const result = await api<{ dimensions: number }>(
        "/admin/ai/embeddings/detect",
        "POST",
        {
          vendorId,
          model,
          embeddingApi: protocol,
        },
      );
      setEdit((current) =>
        current?.type === "model" &&
        current.draft.id === draftId &&
        current.draft.model === model &&
        current.draft.vendorId === vendorId &&
        current.draft.embeddingApi === protocol
          ? {
              ...current,
              draft: {
                ...current.draft,
                embeddingDimensions: result.dimensions,
              },
            }
          : current,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const saveDraft = () => {
    if (!edit) return;
    if (edit.type === "general") {
      void save({ ...config, ...d });
      return;
    }
    if (edit.type === "tools") {
      void save({
        ...config,
        ...(d.section === "fetch"
          ? { webFetch: d.webFetch }
          : { webSearch: d.webSearch }),
      });
      return;
    }
    const key = { vendor: "vendors", model: "models", skill: "officialSkills" }[
      edit.type
    ];
    const values = config[key] ?? [];
    void save({
      ...config,
      ...(edit.type === "model" && d.embedding
        ? {
            defaultModel:
              config.defaultModel === d.id ? "" : config.defaultModel,
            imageModel: config.imageModel === d.id ? "" : config.imageModel,
            mediaModel: config.mediaModel === d.id ? "" : config.mediaModel,
          }
        : {}),
      [key]: values.some((x: any) => x.id === d.id)
        ? values.map((x: any) => (x.id === d.id ? d : x))
        : [...values, d],
    });
  };
  return (
    <section className="ai-admin ai-management">
      <div className="ai-management-heading">
        <div>
          <h2>AI 管理</h2>
          <p className="subtle">
            管理大模型、Agent 工具、官方 Skill 与积分规则。
          </p>
        </div>
        <button
          onClick={() =>
            open("general", {
              memoryEnabled: config.memoryEnabled,
              display: config.display,
              defaultModel: config.defaultModel,
              historyRounds: config.historyRounds,
              maxSteps: config.maxSteps,
              webSearch: config.webSearch,
              imageModel: config.imageModel,
            })
          }
        >
          <SlidersHorizontal size={16} />
          基础设置
        </button>
      </div>
      <div className="ai-management-status">
        <span>
          {config.vendors.length} 个厂商 · {config.models.length} 个模型
        </span>
        <span>积分配置位于「等级与会员 → AI 积分」</span>
      </div>
      <SettingsTabs
        label="AI 管理分类"
        value={tab}
        onChange={setTab}
        items={[
          ["models", "厂商与模型"],
          ["skills", "官方 Skill"],
          ["tools", "工具配置"],
        ]}
      />
      {!edit && (
        <>
          <Feedback message={error} tone="error" />
          <Feedback message={message} />
          {error.includes("刷新") && (
            <button onClick={() => void load().then(() => setError(""))}>
              刷新配置
            </button>
          )}
        </>
      )}
      {tab === "tools" ? (
        <>
          <div className="ai-section-heading">
            <div>
              <h3>工具配置</h3>
              <p className="subtle">
                为助手的图片生成、联网搜索和网页读取工具选择服务，可按场景分别配置。
              </p>
            </div>
          </div>
          <div className="ai-tool-cards">
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>图片生成</h4>
                  <p className="subtle">为文档、演示文稿和画板生成配图。</p>
                </div>
                <span className={`ai-status ${config.imageModel ? "on" : ""}`}>
                  {config.imageModel ? "已配置" : "未配置"}
                </span>
              </div>
              <label>
                使用模型
                <select
                  aria-label="图片生成工具使用模型"
                  disabled={busy}
                  value={config.imageModel ?? ""}
                  onChange={(e) =>
                    void save({ ...config, imageModel: e.target.value })
                  }
                >
                  <option value="">请选择生图模型</option>
                  {config.models
                    .filter(
                      (m: any) =>
                        m.enabled &&
                        !m.embedding &&
                        m.imageGeneration &&
                        (!m.vendorId ||
                          config.vendors.some(
                            (v: any) => v.id === m.vendorId && v.enabled,
                          )),
                    )
                    .map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.alias || m.model}
                      </option>
                    ))}
                </select>
              </label>
              <p className="subtle ai-tool-card-note">
                仅显示已启用图片生成能力的模型。生图按每张图片积分扣费，与对话共用会员额度和额外积分。
              </p>
            </article>
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>附件识别</h4>
                  <p className="subtle">
                    主模型没有图片理解时，用此模型识别上传的图片。
                  </p>
                </div>
                <span className={`ai-status ${config.mediaModel ? "on" : ""}`}>
                  {config.mediaModel ? "已配置" : "未配置"}
                </span>
              </div>
              <label>
                使用模型
                <select
                  aria-label="附件识别模型"
                  disabled={busy}
                  value={config.mediaModel ?? ""}
                  onChange={(e) =>
                    void save({ ...config, mediaModel: e.target.value })
                  }
                >
                  <option value="">不单独配置</option>
                  {config.models
                    .filter(
                      (m: any) =>
                        m.enabled &&
                        !m.embedding &&
                        (m.vision) &&
                        (!m.vendorId ||
                          config.vendors.some(
                            (v: any) => v.id === m.vendorId && v.enabled,
                          )),
                    )
                    .map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.alias || m.model}
                      </option>
                    ))}
                </select>
              </label>
              <p className="subtle ai-tool-card-note">
                仅显示已启用图片理解的对话模型。未配置时，不支持视觉的主模型会拒绝图片附件。PDF、Office 和文本会先解析成文字再送给当前对话模型。
              </p>
            </article>
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>联网搜索</h4>
                  <p className="subtle">为助手提供公开网页检索能力。</p>
                </div>
                <span className={`ai-status ${config.webSearch ? "on" : ""}`}>
                  {config.webSearch ? "已配置" : "未配置"}
                </span>
              </div>
              <p className="ai-tool-provider">
                {(
                  {
                    tavily: "Tavily",
                    brave: "Brave Search",
                    searxng: "自建 SearXNG",
                  } as Record<string, string>
                )[config.webSearch?.provider] ?? "尚未配置搜索服务"}
              </p>
              <p className="subtle ai-tool-card-note">
                支持第三方搜索服务和自建 SearXNG。网页链接读取已内置，知识库检索仍使用平台搜索。
              </p>
              <div className="ai-card-footer">
                <button
                  onClick={() =>
                    open("tools", {
                      section: "search",
                      webSearch: config.webSearch,
                    })
                  }
                >
                  配置搜索服务
                </button>
              </div>
            </article>
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>网页读取</h4>
                  <p className="subtle">读取用户提供的公开网页正文。</p>
                </div>
                <span
                  className={`ai-status ${config.webFetch?.provider !== "builtin" ? "on" : ""}`}
                >
                  {config.webFetch?.provider === "builtin" ||
                  !config.webFetch?.provider
                    ? "内置解析"
                    : "已配置"}
                </span>
              </div>
              <p className="ai-tool-provider">
                {(
                  {
                    builtin: "内置解析",
                    firecrawl: "Firecrawl（开源/自建）",
                    jina: "Jina Reader（外部 API）",
                    tavily: "Tavily Extract（厂商 API）",
                  } as Record<string, string>
                )[config.webFetch?.provider ?? "builtin"] ?? "内置解析"}
              </p>
              <p className="subtle ai-tool-card-note">
                默认使用内置解析；动态网页可切换到 Firecrawl、Jina Reader 或 Tavily Extract。
              </p>
              <div className="ai-card-footer">
                <button
                  onClick={() =>
                    open("tools", {
                      section: "fetch",
                      webFetch: config.webFetch ?? {
                        provider: "builtin",
                        apiKey: null,
                      },
                    })
                  }
                >
                  配置网页读取
                </button>
              </div>
            </article>
          </div>
        </>
      ) : tab === "models" ? (
        <>
          <div className="ai-section-heading">
            <div>
              <h3>模型厂商</h3>
              <p className="subtle">同一厂商下的模型共用地址和密钥。</p>
            </div>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                open("vendor", {
                  id: crypto.randomUUID(),
                  name: "",
                  provider: "openai",
                  baseUrl: providerPreset("openai").baseUrl,
                  apiKey: "",
                  enabled: true,
                })
              }
            >
              <Plus size={16} />
              添加厂商
            </button>
          </div>
          {!config.vendors.length && (
            <div className="ai-admin-empty">
              <Server size={28} />
              <h3>连接第一个模型厂商</h3>
              <p>
                支持 OpenAI、Claude、Gemini、DeepSeek 等，也可连接兼容服务。
              </p>
              <p>添加厂商后，为它配置可用模型。</p>
            </div>
          )}
          <div className="ai-cards ai-vendor-cards">
            {config.vendors.map((v: any) => (
              <article
                key={v.id}
                className={`ai-config-card ${selected === v.id ? "selected" : ""}`}
              >
                <button
                  className="ai-vendor-select"
                  aria-pressed={selected === v.id}
                  onClick={() => setSelected(v.id)}
                >
                  <span className="ai-card-symbol">
                    <Server size={20} />
                  </span>
                  <strong>{v.name}</strong>
                  <span className={`ai-status ${v.enabled ? "on" : ""}`}>
                    {v.enabled ? "已启用" : "已停用"}
                  </span>
                  <small>{providerPreset(v.provider).name}</small>
                  <span className="ai-card-url">{v.baseUrl}</span>
                  <span className="ai-muted">
                    {
                      config.models.filter((m: any) => m.vendorId === v.id)
                        .length
                    }{" "}
                    个模型 ·{" "}
                    {v.hasKey
                      ? "密钥已配置"
                      : v.provider === "ollama"
                        ? "本地连接"
                        : "待配置密钥"}
                  </span>
                </button>
                <div className="ai-card-footer">
                  <button disabled={busy} onClick={() => open("vendor", v)}>
                    <Pencil size={14} />
                    编辑厂商
                  </button>
                  <button
                    disabled={
                      busy ||
                      v.provider === "azure" ||
                      (!v.hasKey && v.provider !== "ollama")
                    }
                    onClick={() => {
                      setSelected(v.id);
                      void catalog(v);
                    }}
                  >
                    读取模型
                  </button>
                </div>
              </article>
            ))}
          </div>
          {vendor && (
            <>
              <div className="ai-section-heading">
                <div>
                  <h3>{vendor.name} 的模型</h3>
                  <p className="subtle">
                    分别设置展示名称、支持能力和使用等级。
                  </p>
                </div>
                <button disabled={busy} onClick={newModel}>
                  <Plus size={16} />
                  添加模型
                </button>
              </div>
              {!children.length && (
                <div className="ai-admin-empty compact">
                  暂无模型，点击「添加模型」填写模型 ID，或先读取厂商模型列表。
                </div>
              )}
              <div className="ai-cards">
                {children.map((m: any) => (
                  <article className="ai-config-card" key={m.id}>
                    <div className="ai-card-title">
                      <span className="ai-card-symbol">
                        <Boxes size={20} />
                      </span>
                      <h4>{m.alias || m.model}</h4>
                      <Switch
                        size="small"
                        checked={m.enabled}
                        loading={busy}
                        aria-label={`${m.alias || m.model}启用状态`}
                        checkedChildren="开"
                        unCheckedChildren="关"
                        onChange={(enabled) =>
                          void save({
                            ...config,
                            models: config.models.map((model: any) =>
                              model.id === m.id ? { ...model, enabled } : model,
                            ),
                          })
                        }
                      />
                    </div>
                    <p className="ai-card-url">{m.model}</p>
                    <div className="ai-capability-tags">
                      {[
                        [m.embedding, "向量模型"],
                        [m.tools, "工具调用"],
                        [m.vision, "图片理解"],
                        [m.pdf, "PDF 阅读"],
                        [m.imageGeneration, "图片生成"],
                      ]
                        .filter(([v]) => v)
                        .map(([, label]) => (
                          <span key={String(label)}>{label}</span>
                        ))}
                      {!m.embedding && !m.tools && !m.imageGeneration && (
                        <span>仅文本 · 不可用于助手</span>
                      )}
                    </div>
                    <p className="ai-muted">
                      {m.embedding
                        ? `向量维度：${m.embeddingDimensions ?? "模型默认值"}`
                        : `上下文 ${m.maxInput.toLocaleString()} · 输出 ${m.maxOutput.toLocaleString()}`}
                    </p>
                    <p className="ai-muted">
                      {m.embedding
                        ? "用于平台文档检索，不出现在助手模型列表"
                        : m.levels.length
                          ? m.levels
                              .map(
                                (id: string) =>
                                  levels.find((l) => l.id === id)?.name ?? id,
                              )
                              .join("、")
                          : "所有具备 AI 权益的等级"}
                    </p>
                    <div className="ai-card-footer">
                      <button disabled={busy} onClick={() => open("model", m)}>
                        编辑模型
                      </button>
                      <button
                        disabled={
                          busy ||
                          (!vendor.hasKey && vendor.provider !== "ollama")
                        }
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          try {
                            const r = await api<any>(
                              `/admin/ai/models/${m.id}/test`,
                              "POST",
                            );
                            if (r.revision) setRevision(r.revision);
                            if (r.apiMode || r.maxInput || r.maxOutput) {
                              setConfig((current: any) =>
                                current
                                  ? {
                                      ...current,
                                      models: current.models.map((item: any) =>
                                        item.id === m.id
                                          ? {
                                              ...item,
                                              ...(r.apiMode && !item.apiMode
                                                ? { apiMode: r.apiMode }
                                                : {}),
                                              ...(r.maxInput
                                                ? { maxInput: r.maxInput }
                                                : {}),
                                              ...(r.maxOutput
                                                ? { maxOutput: r.maxOutput }
                                                : {}),
                                            }
                                          : item,
                                      ),
                                    }
                                  : current,
                              );
                            }
                            setMessage(r.message || "连接测试成功");
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {m.embedding
                          ? "测试向量连接"
                          : m.imageGeneration && !m.tools
                            ? "测试生图接口"
                            : "测试连接"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="ai-section-heading">
            <div>
              <h3>官方 Skill</h3>
              <p className="subtle">
                定义各类创作场景的工作指令，修改后对新任务生效。
              </p>
            </div>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                open("skill", {
                  id: `official-${crypto.randomUUID()}`,
                  name: "",
                  description: "",
                  content: "",
                  formats: [],
                  enabled: true,
                })
              }
            >
              <Plus size={16} />
              添加 Skill
            </button>
          </div>
          <div className="ai-cards">
            {(config.officialSkills ?? []).map((s: any) => (
              <article className="ai-config-card" key={s.id}>
                <div className="ai-card-title">
                  <span className="ai-card-symbol">
                    <Sparkles size={20} />
                  </span>
                  <h4>{s.name}</h4>
                  <span className={`ai-status ${s.enabled ? "on" : ""}`}>
                    {s.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                <p className="ai-skill-description">{s.description}</p>
                <div className="ai-capability-tags">
                  {(s.formats.length
                    ? s.formats.map(formatName)
                    : ["通用"]
                  ).map((f: string) => (
                    <span key={f}>{f}</span>
                  ))}
                </div>
                <div className="ai-card-footer">
                  <span className="ai-muted">
                    {s.content.length} 字工作指令
                  </span>
                  <button disabled={busy} onClick={() => open("skill", s)}>
                    编辑 Skill
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!config.officialSkills?.length && (
            <p className="ai-admin-empty">
              暂无官方 Skill，添加后即可为助手配置场景指令。
            </p>
          )}
          <p className="ai-muted">Skill 不会扩大用户的文档访问或编辑权限。</p>
        </>
      )}
      {edit && (
        <Dialog
          title={
            {
              vendor: config.vendors.some((v: any) => v.id === d.id)
                ? "编辑厂商"
                : "添加厂商",
              model: config.models.some((m: any) => m.id === d.id)
                ? "编辑模型"
                : "添加模型",
              skill: "编辑官方 Skill",
              general: "AI 基础设置",
              tools:
                d.section === "search"
                  ? "联网搜索配置"
                  : d.section === "fetch"
                    ? "网页读取配置"
                    : "AI 工具配置",
            }[edit.type]
          }
          close={() => {
            if (!busy) setEdit(null);
          }}
          className="ai-admin ai-config-dialog"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveDraft();
            }}
          >
            <Feedback message={error} tone="error" />
            <div className="ai-admin-grid">
              {edit.type === "vendor" && (
                <>
                  <label>
                    厂商类型
                    <select
                      value={d.provider}
                      onChange={(e) => {
                        const p = providerPreset(e.target.value);
                        change({
                          provider: p.id,
                          baseUrl: p.baseUrl,
                          apiKey: "",
                          hasKey: false,
                          apiVersion: "",
                          name: d.name || p.name,
                        });
                      }}
                    >
                      {aiProviders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    厂商名称
                    <input
                      required
                      maxLength={80}
                      placeholder="例如：DeepSeek 官方"
                      value={d.name}
                      onChange={(e) => change({ name: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    API 地址
                    <input
                      type="url"
                      required
                      value={d.baseUrl}
                      onChange={(e) => change({ baseUrl: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    API Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={d.apiKey ?? ""}
                      placeholder={
                        d.hasKey ? "已配置，留空保留原密钥" : "填写服务端密钥"
                      }
                      onChange={(e) =>
                        change({ apiKey: e.target.value || null })
                      }
                    />
                  </label>
                  {d.hasKey && (
                    <button
                      type="button"
                      onClick={() => change({ apiKey: "", hasKey: false })}
                    >
                      清除已保存密钥
                    </button>
                  )}
                  {d.provider === "azure" && (
                    <label>
                      API 版本（可选）
                      <input
                        value={d.apiVersion ?? ""}
                        onChange={(e) => change({ apiVersion: e.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={(e) => change({ enabled: e.target.checked })}
                    />
                    启用厂商
                  </label>
                  <p className="subtle ai-field-wide">
                    地址、密钥和启用状态对旗下所有模型生效。密钥仅保存在服务端。
                  </p>
                </>
              )}
              {edit.type === "model" && (
                <>
                  <label>
                    所属厂商
                    <select
                      required
                      value={d.vendorId}
                      onChange={(e) => change({ vendorId: e.target.value })}
                    >
                      {config.vendors.map((v: any) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {modelVendor?.provider === "azure"
                      ? "Azure 部署名称"
                      : "真实模型 ID"}
                    <input
                      required
                      maxLength={160}
                      list="ai-vendor-model-list"
                      value={d.model}
                      placeholder="输入或选择模型 ID"
                      onChange={(e) => change({ model: e.target.value })}
                    />
                    <datalist id="ai-vendor-model-list">
                      {catalogs[d.vendorId]?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  {supportsApiMode && (
                    <label>
                      接口协议
                      <select
                        value={d.apiMode ?? ""}
                        onChange={(e) =>
                          change({
                            apiMode: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">自动检测</option>
                        <option value="chat">Chat Completions</option>
                        <option value="responses">Responses API</option>
                      </select>
                      <small>
                        保存模型后点击“测试连接”会自动识别并回填；火山方舟 Agent Plan 通常选择 Chat Completions。
                      </small>
                    </label>
                  )}
                  <label>
                    展示别名
                    <input
                      required={config.display === "alias" && d.enabled}
                      maxLength={80}
                      value={d.alias}
                      placeholder="例如：专业创作"
                      onChange={(e) => change({ alias: e.target.value })}
                    />
                  </label>
                  <label>
                    模型用途
                    <select
                      value={d.embedding ? "embedding" : "generation"}
                      onChange={(e) =>
                        change(
                          e.target.value === "embedding"
                            ? {
                                embedding: true,
                                tools: false,
                                vision: false,
                                pdf: false,
                                imageGeneration: false,
                                levels: [],
                              }
                            : { embedding: false, tools: true },
                        )
                      }
                    >
                      <option value="generation">对话与内容生成</option>
                      <option
                        value="embedding"
                        disabled={!embeddingSource(modelVendor?.provider)}
                      >
                        向量模型
                      </option>
                    </select>
                    {!embeddingSource(modelVendor?.provider) && (
                      <small>
                        向量模型目前支持 OpenAI 和 OpenAI 兼容接口。
                      </small>
                    )}
                  </label>
                  {d.embedding && (
                    <>
                      <label>
                        向量接口
                        <select
                          value={d.embeddingApi ?? "auto"}
                          onChange={(e) =>
                            change({
                              embeddingApi:
                                e.target.value === "auto"
                                  ? undefined
                                  : e.target.value,
                              embeddingDimensions: undefined,
                            })
                          }
                        >
                          <option value="auto">自动识别</option>
                          <option value="openai">标准文本向量</option>
                          <option value="doubao-multimodal">
                            豆包多模态向量
                          </option>
                        </select>
                      </label>
                      <label>
                        向量维度
                        {embeddingSource(modelVendor?.provider) === "openAi" &&
                        embeddingApi({
                          ...d,
                          provider: modelVendor?.provider,
                        }) !== "doubao-multimodal"
                          ? "（可选）"
                          : ""}
                        <input
                          type="number"
                          min={1}
                          max={65536}
                          step={1}
                          required={
                            embeddingSource(modelVendor?.provider) !==
                              "openAi" ||
                            embeddingApi({
                              ...d,
                              provider: modelVendor?.provider,
                            }) === "doubao-multimodal"
                          }
                          value={d.embeddingDimensions ?? ""}
                          placeholder="点击下方按钮自动检测"
                          onChange={(e) =>
                            change({
                              embeddingDimensions: e.target.value
                                ? Number(e.target.value)
                                : undefined,
                            })
                          }
                        />
                        <button
                          type="button"
                          disabled={busy || !d.model?.trim()}
                          onClick={() => void detectDimensions()}
                        >
                          {busy ? "正在检测…" : "检测并填入维度"}
                        </button>
                        <small>
                          维度是模型返回的向量长度，不需要猜测。检测会发送一小段测试文字，自动填入实际长度。
                        </small>
                      </label>
                      <p className="ai-field-wide subtle">
                        当前接口：
                        {embeddingApi({
                          ...d,
                          provider: modelVendor?.provider,
                        }) === "doubao-multimodal"
                          ? "/embeddings/multimodal"
                          : "/embeddings"}
                        。保存后到「平台设置 → 文档搜索」选择此模型并应用到
                        Meilisearch。修改厂商或模型配置后需重新应用。
                      </p>
                    </>
                  )}
                  {!d.embedding &&
                    [
                      ["maxInput", "输入上下文上限（Token）", 1000, 10000000],
                      ["maxOutput", "单次输出上限（Token）", 32, 1000000],
                    ].map(([f, label, min, max]) => (
                      <label key={f}>
                        {label}
                        <input
                          type="number"
                          required
                          min={min}
                          max={max}
                          value={d[f!]}
                          onChange={(e) =>
                            change({ [f!]: Number(e.target.value) })
                          }
                        />
                        {f === "maxInput" && (
                          <small>
                            保存后测试连接会尝试从厂商模型目录自动读取上下文与输出限制；厂商未提供时可手工填写。
                          </small>
                        )}
                      </label>
                    ))}
                  <label className="ai-field-wide ai-model-enabled">
                    <span>启用模型</span>
                    <Switch
                      checked={!!d.enabled}
                      onChange={(enabled) => change({ enabled })}
                    />
                  </label>
                  <div className="ai-field-wide ai-actions">
                    {!d.embedding && (
                      <p className="subtle">
                        输入与输出是不同的限制，请按当前厂商接口填写。平台允许配置大上下文，并不代表厂商支持同等长度的单次输出。
                      </p>
                    )}
                    {[
                      ["tools", "工具调用"],
                      ["vision", "图片理解"],
                      ["pdf", "原生 PDF 阅读"],
                      ["imageGeneration", "图片生成（Images API）"],
                    ]
                      .filter(() => !d.embedding)
                      .map(([f, label]) => (
                        <label key={f}>
                          <input
                            type="checkbox"
                            checked={!!d[f!]}
                            onChange={(e) => change({ [f!]: e.target.checked })}
                          />
                          {label}
                        </label>
                      ))}
                    {!d.embedding && (
                      <small className="subtle">
                        日常 PDF 会先解析成文字再送给模型。只有厂商明确支持把 PDF 原件直接交给模型时，才需要打开原生 PDF 阅读。
                      </small>
                    )}
                  </div>
                  {!d.embedding && d.imageGeneration && (
                    <label>
                      默认生图尺寸
                      <input
                        placeholder="1024x1024"
                        pattern="[0-9]{2,4}x[0-9]{2,4}"
                        value={d.imageSize ?? ""}
                        onChange={(e) =>
                          change({ imageSize: e.target.value || undefined })
                        }
                      />
                      <small className="subtle">
                        按厂商支持填写，例如 1024x1024 或
                        2048x2048。生图按每张图片积分结算，可在 AI
                        积分中按尺寸分档，与对话共用会员额度。
                      </small>
                    </label>
                  )}
                  {!d.embedding && (
                    <fieldset className="ai-field-wide">
                      <legend>允许使用的等级</legend>
                      <p className="subtle">
                        不选择表示所有具备 AI 权益的等级。
                      </p>
                      <div className="ai-actions">
                        {levels.map((l) => (
                          <label key={l.id}>
                            <input
                              type="checkbox"
                              checked={d.levels.includes(l.id)}
                              onChange={(e) =>
                                change({
                                  levels: e.target.checked
                                    ? [...d.levels, l.id]
                                    : d.levels.filter(
                                        (x: string) => x !== l.id,
                                      ),
                                })
                              }
                            />
                            {l.name}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                </>
              )}
              {edit.type === "skill" && (
                <>
                  <label className="ai-field-wide">
                    Skill 名称
                    <input
                      required
                      maxLength={80}
                      value={d.name}
                      onChange={(e) => change({ name: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    用途说明
                    <input
                      required
                      maxLength={500}
                      value={d.description}
                      onChange={(e) => change({ description: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    工作指令
                    <textarea
                      required
                      rows={9}
                      maxLength={12000}
                      value={d.content}
                      onChange={(e) => change({ content: e.target.value })}
                    />
                  </label>
                  <fieldset className="ai-field-wide">
                    <legend>适用类型（不选择表示通用）</legend>
                    <div className="ai-actions">
                      {formats.map(([f, label]) => (
                        <label key={f}>
                          <input
                            type="checkbox"
                            checked={d.formats.includes(f)}
                            onChange={(e) =>
                              change({
                                formats: e.target.checked
                                  ? [...d.formats, f]
                                  : d.formats.filter((x: string) => x !== f),
                              })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label>
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={(e) => change({ enabled: e.target.checked })}
                    />
                    启用 Skill
                  </label>
                  {defaultOfficialSkills.some((s) => s.id === d.id) && (
                    <button
                      type="button"
                      onClick={() =>
                        change(defaultOfficialSkills.find((s) => s.id === d.id))
                      }
                    >
                      恢复默认指令
                    </button>
                  )}
                </>
              )}
              {edit.type === "general" && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={d.memoryEnabled}
                      onChange={(e) =>
                        change({ memoryEnabled: e.target.checked })
                      }
                    />
                    允许用户保存长期偏好
                  </label>
                  <label>
                    用户看到的名称
                    <select
                      value={d.display}
                      onChange={(e) => change({ display: e.target.value })}
                    >
                      <option value="alias">模型别名</option>
                      <option value="real">真实模型名</option>
                    </select>
                  </label>
                  <label>
                    默认模型
                    <select
                      value={d.defaultModel}
                      onChange={(e) => change({ defaultModel: e.target.value })}
                    >
                      <option value="">由用户选择</option>
                      {config.models
                        .filter((m: any) => m.enabled && !m.embedding)
                        .map((m: any) => (
                          <option key={m.id} value={m.id}>
                            {m.alias || m.model}
                          </option>
                        ))}
                    </select>
                  </label>
                  {[
                    ["historyRounds", "压缩时优先保留的原文轮数", 1, 50],
                    ["maxSteps", "每阶段最多模型调用步骤", 1, 100],
                  ].map(([f, label, min, max]) => (
                    <label key={f}>
                      {label}
                      <input
                        type="number"
                        required
                        min={min}
                        max={max}
                        value={d[f!]}
                        onChange={(e) =>
                          change({ [f!]: Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
                  <p className="subtle ai-field-wide">
                    写过文档后仍会做独立验收，但验收只读成果大纲和原始要求，不再回放整段对话。问答和澄清阶段只核对工具回执。前缀保持稳定以便模型缓存命中，用量里的「输入缓存命中」反映实际节省。
                  </p>
                </>
              )}
              {edit.type === "tools" && (
                <>
                  {d.section === "search" && (
                    <fieldset className="ai-field-wide">
                    <legend>联网搜索</legend>
                    <label>
                      搜索服务
                      <select
                        value={d.webSearch?.provider ?? ""}
                        onChange={(e) =>
                          change({
                            webSearch: e.target.value
                              ? {
                                  provider: e.target.value,
                                  apiKey: "",
                                  ...(e.target.value === "searxng"
                                    ? { baseUrl: "" }
                                    : {}),
                                }
                              : undefined,
                          })
                        }
                      >
                        <option value="">未配置</option>
                        <option value="tavily">Tavily</option>
                        <option value="brave">Brave Search</option>
                        <option value="searxng">自建 SearXNG</option>
                      </select>
                    </label>
                    {d.webSearch?.provider === "searxng" && (
                      <label>
                        自建搜索地址
                        <input
                          type="url"
                          required
                          placeholder="https://search.example.com/"
                          value={d.webSearch.baseUrl ?? ""}
                          onChange={(e) =>
                            change({
                              webSearch: {
                                ...d.webSearch,
                                baseUrl: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    )}
                    {d.webSearch && (
                      <label>
                        {d.webSearch.provider === "searxng"
                          ? "访问令牌（可选）"
                          : "搜索服务 API Key"}
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={d.webSearch.apiKey ?? ""}
                          placeholder={
                            d.webSearch.hasKey
                              ? "已配置，留空保留原密钥"
                              : "密钥仅保存在服务端"
                          }
                          onChange={(e) =>
                            change({
                              webSearch: {
                                ...d.webSearch,
                                apiKey: e.target.value || null,
                              },
                            })
                          }
                        />
                      </label>
                    )}
                    <p className="subtle">
                      用户可在输入框选择本轮是否联网。自建 SearXNG 需开启 JSON
                      搜索接口。此服务只检索公开网页，知识库检索仍使用平台搜索。
                    </p>
                    <button
                      type="button"
                      disabled={busy || !config.webSearch}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        setMessage("");
                        try {
                          const r = await api<any>(
                            "/admin/ai/web-search/test",
                            "POST",
                          );
                          setMessage(
                            `搜索连接成功，获得 ${r.count} 条结果（测试已保存的配置）`,
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      测试已保存的搜索配置
                    </button>
                    </fieldset>
                  )}
                  {d.section === "fetch" && (
                    <fieldset className="ai-field-wide">
                      <legend>网页读取</legend>
                      <label>
                        读取服务
                        <select
                          value={d.webFetch?.provider ?? "builtin"}
                          onChange={(e) =>
                            change({
                              webFetch: {
                                provider: e.target.value,
                                apiKey: null,
                                ...(e.target.value === "builtin"
                                  ? {}
                                  : { baseUrl: "" }),
                              },
                            })
                          }
                        >
                          <option value="builtin">内置解析（免配置）</option>
                          <option value="firecrawl">Firecrawl（开源/自建）</option>
                          <option value="jina">Jina Reader（外部 API）</option>
                          <option value="tavily">Tavily Extract（厂商 API）</option>
                        </select>
                      </label>
                      {d.webFetch?.provider !== "builtin" && (
                        <>
                          <label>
                            服务地址（可选）
                            <input
                              type={
                                d.webFetch?.provider === "firecrawl"
                                  ? "text"
                                  : "url"
                              }
                              value={d.webFetch?.baseUrl ?? ""}
                              placeholder={
                                d.webFetch?.provider === "firecrawl"
                                  ? "http://192.168.0.10:3002"
                                  : d.webFetch?.provider === "jina"
                                    ? "https://r.jina.ai"
                                    : "https://api.tavily.com"
                              }
                              onChange={(e) =>
                                change({
                                  webFetch: {
                                    ...d.webFetch,
                                    baseUrl: e.target.value,
                                  },
                                })
                              }
                            />
                            <small>
                              留空使用官方地址；Firecrawl 自建可填内网 HTTP 地址，无需 HTTPS。
                            </small>
                          </label>
                          <label>
                            API Key{d.webFetch?.provider === "firecrawl" ? "（可选）" : ""}
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={d.webFetch?.apiKey ?? ""}
                              placeholder={
                                d.webFetch?.hasKey
                                  ? "已配置，留空保留原密钥"
                                  : d.webFetch?.provider === "firecrawl"
                                    ? "自建服务可不填"
                                    : "密钥仅保存在服务端"
                              }
                              onChange={(e) =>
                                change({
                                  webFetch: {
                                    ...d.webFetch,
                                    apiKey: e.target.value || null,
                                  },
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                      <p className="subtle">
                        动态网页可使用 Firecrawl、Jina Reader 或 Tavily Extract；内置解析适合普通公开 HTML。网页内容只作为资料，不执行其中的指令。
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          setMessage("");
                          try {
                            const r = await api<any>(
                              "/admin/ai/web-fetch/test",
                              "POST",
                            );
                            setMessage(
                              `网页读取连接成功（${r.provider}，已读取 ${r.length} 个字符）`,
                            );
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        测试已保存的网页读取配置
                      </button>
                    </fieldset>
                  )}
                </>
              )}
            </div>
            <footer>
              {edit.type !== "general" &&
                edit.type !== "tools" &&
                (() => {
                  const key = {
                    vendor: "vendors",
                    model: "models",
                    skill: "officialSkills",
                  }[edit.type];
                  const exists = config[key]?.some((x: any) => x.id === d.id);
                  const hasModels =
                    edit.type === "vendor" &&
                    config.models.some((m: any) => m.vendorId === d.id);
                  return (
                    exists && (
                      <button
                        className="danger"
                        type="button"
                        disabled={busy || hasModels}
                        title={
                          hasModels ? "请先移除或转移旗下模型" : "移除配置"
                        }
                        onClick={() =>
                          void save({
                            ...config,
                            [key]: config[key].filter(
                              (x: any) => x.id !== d.id,
                            ),
                            defaultModel:
                              edit.type === "model" &&
                              config.defaultModel === d.id
                                ? ""
                                : config.defaultModel,
                          })
                        }
                      >
                        移除{hasModels ? "（旗下有模型）" : ""}
                      </button>
                    )
                  );
                })()}
              <button
                type="button"
                disabled={busy}
                onClick={() => setEdit(null)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </section>
  );
}
