import { htmlLang, type MessageKey, type MessageValues } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import {
  AutoComplete,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Switch,
} from "antd";
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
  imageModelProfiles,
  imageProfilesForProvider,
  imageProfileForModel,
  imageOperations,
  type ImageOperation,
} from "@core/modules/ai/image-model-catalog.js";
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
import { AIUploadSettings } from "./ai-upload-settings.js";

function Choice({
  value,
  disabled,
  label,
  options,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  label?: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      showSearch
      optionFilterProp="label"
      className="ai-choice"
      aria-label={label}
      disabled={disabled}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

const formatIds = [
  "rich_text",
  "markdown",
  "spreadsheet",
  "canvas",
  "presentation",
] as const;
const formatKey: Record<(typeof formatIds)[number], MessageKey> = {
  rich_text: "aiAdmin.format.document",
  markdown: "aiAdmin.format.markdown",
  spreadsheet: "aiAdmin.format.spreadsheet",
  canvas: "aiAdmin.format.canvas",
  presentation: "aiAdmin.format.presentation",
};
type Translator = (key: MessageKey, values?: MessageValues) => string;
type AdminNotice =
  | { id: "saved" }
  | { id: "catalog"; count: number }
  | { id: "search"; count: number }
  | { id: "fetch"; provider: string; length: number }
  | {
      id: "test";
      kind: "image" | "embedding" | "chat";
      apiMode?: string;
      maxInput?: number;
      maxOutput?: number;
    };
type AdminError = { message: string; status?: number };

function reportedError(error: unknown): AdminError {
  const value = error as Error & { status?: number };
  return { message: value.message, status: value.status };
}

function adminNotice(notice: AdminNotice, t: Translator, locale: "zh" | "en") {
  const num = (value: number) => value.toLocaleString(htmlLang(locale));
  if (notice.id === "saved") return t("aiAdmin.saved");
  if (notice.id === "catalog")
    return t("aiAdmin.catalogLoaded", { count: notice.count });
  if (notice.id === "search")
    return t("aiAdmin.searchTest", { count: notice.count });
  if (notice.id === "fetch") {
    const providerKey = {
      builtin: "aiAdmin.tools.fetchBuiltin",
      firecrawl: "aiAdmin.tools.fetch.firecrawl",
      jina: "aiAdmin.tools.fetch.jina",
      tavily: "aiAdmin.tools.fetch.tavily",
    }[notice.provider] as MessageKey | undefined;
    return t("aiAdmin.fetchTest", {
      provider: providerKey ? t(providerKey) : notice.provider,
      length: num(notice.length),
    });
  }
  if (notice.kind === "image") return t("aiAdmin.testImagePassed");
  if (notice.kind === "embedding") return t("aiAdmin.testEmbeddingPassed");
  return [
    t("aiAdmin.testPassed"),
    notice.apiMode
      ? t("aiAdmin.testProtocol", {
          protocol:
            notice.apiMode === "chat"
              ? "Chat Completions"
              : notice.apiMode === "responses"
                ? "Responses API"
                : notice.apiMode,
        })
      : "",
    notice.maxInput
      ? t("aiAdmin.testInput", { count: num(notice.maxInput) })
      : "",
    notice.maxOutput
      ? t("aiAdmin.testOutput", { count: num(notice.maxOutput) })
      : "",
    !notice.apiMode && !notice.maxInput && !notice.maxOutput
      ? t("aiAdmin.testValid")
      : "",
    t("aiAdmin.testUsage"),
  ]
    .filter(Boolean)
    .join(" ");
}
export function AIAdmin() {
  const { t, locale } = useI18n();
  const providerLabel = (id: string) => {
    const key = {
      openai: "aiAdmin.provider.openai",
      anthropic: "aiAdmin.provider.anthropic",
      google: "aiAdmin.provider.google",
      azure: "aiAdmin.provider.azure",
      deepseek: "aiAdmin.provider.deepseek",
      qwen: "aiAdmin.provider.qwen",
      doubao: "aiAdmin.provider.doubao",
      moonshot: "aiAdmin.provider.moonshot",
      zhipu: "aiAdmin.provider.zhipu",
      minimax: "aiAdmin.provider.minimax",
      mistral: "aiAdmin.provider.mistral",
      groq: "aiAdmin.provider.groq",
      openrouter: "aiAdmin.provider.openrouter",
      siliconflow: "aiAdmin.provider.siliconflow",
      ollama: "aiAdmin.provider.ollama",
      compatible: "aiAdmin.provider.compatible",
    }[id] as MessageKey | undefined;
    return key ? t(key) : providerPreset(id).name;
  };

  const [config, setConfig] = useState<any>(null),
    [revision, setRevision] = useState(0);
  const [tab, setTab] = useState("models"),
    [selected, setSelected] = useState("");
  const [edit, setEdit] = useState<{
    type: "vendor" | "model" | "skill" | "general" | "tools";
    draft: any;
  } | null>(null);
  const [error, setError] = useState<AdminError | null>(null),
    [notice, setNotice] = useState<AdminNotice | null>(null),
    [busy, setBusy] = useState(false);
  const [catalogs, setCatalogs] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  async function load() {
    const r = await api<any>("/admin/ai");
    const { revision, limits, taskBudget, ...c } = r.config;
    setConfig(c);
    setRevision(revision);
    setSelected((id) =>
      c.vendors.some((v: any) => v.id === id) ? id : (c.vendors[0]?.id ?? ""),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(reportedError(e)));
  }, []);
  async function save(next: any) {
    setBusy(true);
    setError(null);
    setNotice(null);
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
      setNotice({ id: "saved" });
      return true;
    } catch (e) {
      setError(reportedError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function catalog(v: any) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<any>(`/admin/ai/vendors/${v.id}/catalog`);
      setCatalogs((c) => ({ ...c, [v.id]: r.models }));
      setNotice({ id: "catalog", count: r.models.length });
    } catch (e) {
      setError(reportedError(e));
    } finally {
      setBusy(false);
    }
  }
  const open = (type: NonNullable<typeof edit>["type"], draft: any) => {
    setError(null);
    setNotice(null);
    setEdit({ type, draft: structuredClone(draft) });
  };
  const change = (patch: any) =>
    setEdit((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  if (!config) return <p>{error?.message || t("aiAdmin.loading")}</p>;
  const vendor = config.vendors.find((v: any) => v.id === selected);
  const children = config.models.filter((m: any) => m.vendorId === selected);
  const d = edit?.draft;
  const modelVendor = config.vendors.find((v: any) => v.id === d?.vendorId);
  const modelProtocol = providerPreset(modelVendor?.provider).protocol;
  const imageChoices = (operation?: ImageOperation) =>
    config.models
      .filter((m: any) => {
        const vendor = config.vendors.find((v: any) => v.id === m.vendorId);
        const profile = imageProfileForModel({
          ...m,
          provider: vendor?.provider,
        });
        return (
          m.enabled &&
          vendor?.enabled &&
          !!profile &&
          (!operation || profile.operations.includes(operation))
        );
      })
      .map((m: any) => ({ value: m.id, label: m.alias || m.model }));
  const clearImageSelection = (id: string) => ({
    imageModel: config.imageModel === id ? "" : config.imageModel,
    imageToolModels: Object.fromEntries(
      imageOperations.map((operation) => [
        operation,
        config.imageToolModels?.[operation] === id
          ? ""
          : config.imageToolModels?.[operation],
      ]),
    ),
  });
  const supportsApiMode =
    modelProtocol === "openai" || modelProtocol === "azure";
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
      inputRate: 1,
      outputRate: 1,
      imageRate: 1,
      maxInput: 32000,
      maxOutput: 4096,
    });
  async function detectDimensions() {
    setBusy(true);
    setError(null);
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
      setError(reportedError(e));
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
      ...(edit.type === "model" && (d.embedding || d.imageGeneration)
        ? {
            defaultModel:
              config.defaultModel === d.id ? "" : config.defaultModel,
            mediaModel: config.mediaModel === d.id ? "" : config.mediaModel,
          }
        : {}),
      ...(edit.type === "model" &&
      (d.embedding || !d.imageGeneration || !d.enabled)
        ? clearImageSelection(d.id)
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
          <h2>{t("aiAdmin.title")}</h2>
          <p className="subtle">{t("aiAdmin.lead")}</p>
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
          {t("aiAdmin.basicSettings")}
        </button>
      </div>
      <div className="ai-management-status">
        <span>
          {t("aiAdmin.inventory", {
            vendors: config.vendors.length,
            models: config.models.length,
          })}
        </span>
        <span>{t("aiusage.rateSummary")}</span>
      </div>
      <SettingsTabs
        label={t("aiAdmin.tabs")}
        value={tab}
        onChange={setTab}
        items={[
          ["models", t("aiAdmin.tab.models")],
          ["skills", t("aiAdmin.tab.skills")],
          ["tools", t("aiAdmin.tab.tools")],
          ["uploads", t("aiUpload.title")],
        ]}
      />
      {!edit && (
        <>
          <Feedback message={error?.message ?? ""} tone="error" />
          <Feedback message={notice ? adminNotice(notice, t, locale) : ""} />
          {error?.status === 409 && (
            <button onClick={() => void load().then(() => setError(null))}>
              {t("aiAdmin.refreshConfig")}
            </button>
          )}
        </>
      )}
      {tab === "uploads" ? (
        <AIUploadSettings />
      ) : tab === "tools" ? (
        <>
          <div className="ai-section-heading">
            <div>
              <h3>{t("aiAdmin.tools.title")}</h3>
              <p className="subtle">{t("aiAdmin.tools.lead")}</p>
            </div>
          </div>
          <div className="ai-tool-cards">
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>{t("aiAdmin.tools.image")}</h4>
                  <p className="subtle">{t("aiAdmin.tools.imageHelp")}</p>
                </div>
                <span className={`ai-status ${config.imageModel ? "on" : ""}`}>
                  {config.imageModel
                    ? t("aiAdmin.configured")
                    : t("aiAdmin.notConfigured")}
                </span>
              </div>
              <label>
                {t("aiAdmin.tools.useModel")}
                <Choice
                  label={t("aiAdmin.tools.imageModel")}
                  disabled={busy}
                  value={config.imageModel ?? ""}
                  onChange={(imageModel) =>
                    void save({ ...config, imageModel })
                  }
                  options={[
                    { value: "", label: t("aiAdmin.tools.chooseImage") },
                    ...imageChoices(),
                  ]}
                />
              </label>
              <details>
                <summary>{t("aiAdmin.imageToolOverrides")}</summary>
                {imageOperations.map((operation) => (
                  <label key={operation}>
                    {t(`aiAdmin.imageOperation.${operation}`)}
                    <Choice
                      label={t(`aiAdmin.imageOperation.${operation}`)}
                      disabled={busy}
                      value={config.imageToolModels?.[operation] ?? ""}
                      options={[
                        { value: "", label: t("aiAdmin.imageUseDefault") },
                        ...imageChoices(operation),
                      ]}
                      onChange={(id) =>
                        void save({
                          ...config,
                          imageToolModels: {
                            ...config.imageToolModels,
                            [operation]: id,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </details>
              <p className="subtle ai-tool-card-note">
                {t("aiAdmin.tools.imageNote")}
              </p>
            </article>
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>{t("aiAdmin.tools.media")}</h4>
                  <p className="subtle">{t("aiAdmin.tools.mediaHelp")}</p>
                </div>
                <span className={`ai-status ${config.mediaModel ? "on" : ""}`}>
                  {config.mediaModel
                    ? t("aiAdmin.configured")
                    : t("aiAdmin.notConfigured")}
                </span>
              </div>
              <label>
                {t("aiAdmin.tools.useModel")}
                <Choice
                  label={t("aiAdmin.tools.mediaModel")}
                  disabled={busy}
                  value={config.mediaModel ?? ""}
                  onChange={(mediaModel) =>
                    void save({ ...config, mediaModel })
                  }
                  options={[
                    { value: "", label: t("aiAdmin.tools.mediaNone") },
                    ...config.models
                      .filter(
                        (m: any) =>
                          m.enabled &&
                          !m.embedding &&
                          m.vision &&
                          (!m.vendorId ||
                            config.vendors.some(
                              (v: any) => v.id === m.vendorId && v.enabled,
                            )),
                      )
                      .map((m: any) => ({
                        value: m.id,
                        label: m.alias || m.model,
                      })),
                  ]}
                />
              </label>
              <p className="subtle ai-tool-card-note">
                {t("aiAdmin.tools.mediaNote")}
              </p>
            </article>
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>{t("chat.webSearch")}</h4>
                  <p className="subtle">{t("aiAdmin.tools.searchHelp")}</p>
                </div>
                <span className={`ai-status ${config.webSearch ? "on" : ""}`}>
                  {config.webSearch
                    ? t("aiAdmin.configured")
                    : t("aiAdmin.notConfigured")}
                </span>
              </div>
              <p className="ai-tool-provider">
                {(
                  {
                    tavily: "Tavily",
                    brave: "Brave Search",
                    searxng: t("aiAdmin.tools.search.searxng"),
                  } as Record<string, string>
                )[config.webSearch?.provider] ??
                  t("aiAdmin.tools.searchMissing")}
              </p>
              <p className="subtle ai-tool-card-note">
                {t("aiAdmin.tools.searchNote")}
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
                  {t("aiAdmin.tools.configureSearch")}
                </button>
              </div>
            </article>
            <article className="ai-config-card ai-tool-card">
              <div className="ai-tool-card-heading">
                <div>
                  <h4>{t("aiAdmin.tools.fetch")}</h4>
                  <p className="subtle">{t("aiAdmin.tools.fetchHelp")}</p>
                </div>
                <span
                  className={`ai-status ${config.webFetch?.provider !== "builtin" ? "on" : ""}`}
                >
                  {config.webFetch?.provider === "builtin" ||
                  !config.webFetch?.provider
                    ? t("aiAdmin.tools.fetchBuiltin")
                    : t("aiAdmin.configured")}
                </span>
              </div>
              <p className="ai-tool-provider">
                {(
                  {
                    builtin: t("aiAdmin.tools.fetchBuiltin"),
                    firecrawl: t("aiAdmin.tools.fetch.firecrawl"),
                    jina: t("aiAdmin.tools.fetch.jina"),
                    tavily: t("aiAdmin.tools.fetch.tavily"),
                  } as Record<string, string>
                )[config.webFetch?.provider ?? "builtin"] ??
                  t("aiAdmin.tools.fetchBuiltin")}
              </p>
              <p className="subtle ai-tool-card-note">
                {t("aiAdmin.tools.fetchNote")}
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
                  {t("aiAdmin.tools.configureFetch")}
                </button>
              </div>
            </article>
          </div>
        </>
      ) : tab === "models" ? (
        <>
          <div className="ai-section-heading">
            <div>
              <h3>{t("aiAdmin.vendors")}</h3>
              <p className="subtle">{t("aiAdmin.vendorsHelp")}</p>
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
              {t("aiAdmin.addVendor")}
            </button>
          </div>
          {!config.vendors.length && (
            <div className="ai-admin-empty">
              <Server size={28} />
              <h3>{t("aiAdmin.firstVendor")}</h3>
              <p>{t("aiAdmin.firstVendorHelp")}</p>
              <p>{t("aiAdmin.firstVendorNext")}</p>
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
                    {v.enabled ? t("aiAdmin.enabled") : t("aiAdmin.disabled")}
                  </span>
                  <small>{providerLabel(v.provider)}</small>
                  <span className="ai-card-url">{v.baseUrl}</span>
                  <span className="ai-muted">
                    {t("aiAdmin.vendorSummary", {
                      count: config.models.filter(
                        (m: any) => m.vendorId === v.id,
                      ).length,
                      status: v.hasKey
                        ? t("aiAdmin.keyConfigured")
                        : v.provider === "ollama"
                          ? t("aiAdmin.localConnection")
                          : t("aiAdmin.keyMissing"),
                    })}
                  </span>
                </button>
                <div className="ai-card-footer">
                  <button disabled={busy} onClick={() => open("vendor", v)}>
                    <Pencil size={14} />
                    {t("aiAdmin.editVendor")}
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
                    {t("aiAdmin.readModels")}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {vendor && (
            <>
              <div className="ai-section-heading">
                <div>
                  <h3>{t("aiAdmin.modelsOf", { name: vendor.name })}</h3>
                  <p className="subtle">{t("aiAdmin.modelsHelp")}</p>
                </div>
                <button disabled={busy} onClick={newModel}>
                  <Plus size={16} />
                  {t("aiAdmin.addModel")}
                </button>
              </div>
              {!children.length && (
                <div className="ai-admin-empty compact">
                  {t("aiAdmin.noModels")}
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
                        aria-label={t("aiAdmin.modelEnabled", {
                          name: m.alias || m.model,
                        })}
                        checkedChildren={t("aiAdmin.on")}
                        unCheckedChildren={t("aiAdmin.off")}
                        onChange={(enabled) =>
                          void save({
                            ...config,
                            ...(!enabled ? clearImageSelection(m.id) : {}),
                            models: config.models.map((model: any) =>
                              model.id === m.id ? { ...model, enabled } : model,
                            ),
                          })
                        }
                      />
                    </div>
                    <p className="ai-card-url">{m.model}</p>
                    <div className="ai-capability-tags">
                      {(
                        [
                          [m.embedding, "aiAdmin.cap.embedding"],
                          [m.tools, "aiAdmin.cap.tools"],
                          [m.vision, "aiAdmin.cap.vision"],
                          [m.pdf, "aiAdmin.cap.pdf"],
                          [m.imageGeneration, "aiAdmin.cap.image"],
                        ] as const
                      )
                        .filter(([on]) => on)
                        .map(([, key]) => (
                          <span key={key}>{t(key)}</span>
                        ))}
                      {!m.embedding && !m.tools && !m.imageGeneration && (
                        <span>{t("aiAdmin.cap.textOnly")}</span>
                      )}
                    </div>
                    {!m.embedding && (
                      <p className="ai-muted">
                        {m.imageGeneration && !m.tools
                          ? t("aiusage.imageRateValue", {
                              rate: m.imageRate ?? 1,
                            })
                          : t("aiusage.modelRateValue", {
                              input: m.inputRate ?? 1,
                              output: m.outputRate ?? 1,
                            })}
                      </p>
                    )}
                    <div className="ai-card-footer">
                      <button disabled={busy} onClick={() => open("model", m)}>
                        {t("aiAdmin.editModel")}
                      </button>
                      <button
                        disabled={
                          busy ||
                          (!vendor.hasKey && vendor.provider !== "ollama")
                        }
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
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
                            setNotice({
                              id: "test",
                              kind: m.embedding
                                ? "embedding"
                                : m.imageGeneration && !m.tools
                                  ? "image"
                                  : "chat",
                              apiMode: r.apiMode,
                              maxInput: r.maxInput,
                              maxOutput: r.maxOutput,
                            });
                          } catch (e) {
                            setError(reportedError(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {m.embedding
                          ? t("aiAdmin.testEmbedding")
                          : m.imageGeneration && !m.tools
                            ? t("aiAdmin.testImage")
                            : t("aiAdmin.testConnection")}
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
              <h3>{t("aiAdmin.skills")}</h3>
              <p className="subtle">{t("aiAdmin.skillsHelp")}</p>
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
              {t("aiAdmin.addSkill")}
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
                    {s.enabled ? t("aiAdmin.enabled") : t("aiAdmin.disabled")}
                  </span>
                </div>
                <p className="ai-skill-description">{s.description}</p>
                <div className="ai-capability-tags">
                  {(s.formats.length ? s.formats : ["general"]).map(
                    (id: string) => {
                      const key = formatKey[id as (typeof formatIds)[number]];
                      return (
                        <span key={id}>
                          {key ? t(key) : t("aiAdmin.general")}
                        </span>
                      );
                    },
                  )}
                </div>
                <div className="ai-card-footer">
                  <span className="ai-muted">
                    {t("aiAdmin.skillLength", { count: s.content.length })}
                  </span>
                  <button disabled={busy} onClick={() => open("skill", s)}>
                    {t("aiAdmin.editSkill")}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!config.officialSkills?.length && (
            <p className="ai-admin-empty">{t("aiAdmin.noSkills")}</p>
          )}
          <p className="ai-muted">{t("aiAdmin.skillPermission")}</p>
        </>
      )}
      {edit && (
        <Dialog
          title={
            {
              vendor: config.vendors.some((v: any) => v.id === d.id)
                ? t("aiAdmin.editVendor")
                : t("aiAdmin.addVendor"),
              model: config.models.some((m: any) => m.id === d.id)
                ? t("aiAdmin.editModel")
                : t("aiAdmin.addModel"),
              skill: t("aiAdmin.editSkill"),
              general: t("aiAdmin.basicTitle"),
              tools:
                d.section === "search"
                  ? t("aiAdmin.searchConfig")
                  : d.section === "fetch"
                    ? t("aiAdmin.fetchConfig")
                    : t("aiAdmin.toolsConfig"),
            }[edit.type]
          }
          close={() => {
            if (!busy) setEdit(null);
          }}
          className="ai-admin ai-config-dialog"
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              saveDraft();
            }}
          >
            <Feedback message={error?.message ?? ""} tone="error" />
            <div className="ai-admin-grid">
              {edit.type === "vendor" && (
                <>
                  <label>
                    {t("aiAdmin.vendorType")}
                    <Choice
                      label={t("aiAdmin.vendorType")}
                      value={d.provider}
                      onChange={(provider) => {
                        const p = providerPreset(provider);
                        change({
                          provider: p.id,
                          baseUrl: p.baseUrl,
                          apiKey: "",
                          hasKey: false,
                          apiVersion: "",
                          name: d.name || providerLabel(p.id),
                        });
                      }}
                      options={aiProviders.map((p) => ({
                        value: p.id,
                        label: providerLabel(p.id),
                      }))}
                    />
                  </label>
                  <label>
                    {t("aiAdmin.vendorName")}
                    <Input
                      required
                      maxLength={80}
                      placeholder={t("aiAdmin.vendorNamePlaceholder")}
                      value={d.name}
                      onChange={(e) => change({ name: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    {t("aiAdmin.apiUrl")}
                    <Input
                      type="url"
                      required
                      value={d.baseUrl}
                      onChange={(e) => change({ baseUrl: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    {t("aiAdmin.apiKey")}
                    <Input.Password
                      autoComplete="new-password"
                      value={d.apiKey ?? ""}
                      placeholder={
                        d.hasKey
                          ? t("credentials.configured")
                          : t("aiAdmin.apiKeyPlaceholder")
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
                      {t("credentials.clear")}
                    </button>
                  )}
                  {d.provider === "azure" && (
                    <label>
                      {t("aiAdmin.apiVersion")}
                      <Input
                        value={d.apiVersion ?? ""}
                        onChange={(e) => change({ apiVersion: e.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    <Switch
                      checked={d.enabled}
                      onChange={(checked) => change({ enabled: checked })}
                    />
                    {t("aiAdmin.enableVendor")}
                  </label>
                  <p className="subtle ai-field-wide">
                    {t("aiAdmin.vendorScope")}
                  </p>
                </>
              )}
              {edit.type === "model" && (
                <>
                  <label>
                    {t("aiAdmin.vendorOf")}
                    <Choice
                      label={t("aiAdmin.vendorOf")}
                      value={d.vendorId}
                      onChange={(vendorId) =>
                        change({
                          vendorId,
                          ...(d.imageGeneration
                            ? {
                                imageProfile: undefined,
                                model: "",
                                imageSize: undefined,
                              }
                            : {}),
                        })
                      }
                      options={config.vendors.map((v: any) => ({
                        value: v.id,
                        label: v.name,
                      }))}
                    />
                  </label>
                  {d.imageGeneration ? (
                    <>
                      <label>
                        {t("aiAdmin.imageProfile")}
                        <Choice
                          label={t("aiAdmin.imageProfile")}
                          value={d.imageProfile ?? ""}
                          options={[
                            {
                              value: "",
                              label: t("aiAdmin.imageProfileChoose"),
                            },
                            ...imageProfilesForProvider(
                              modelVendor?.provider,
                            ).map((profile) => ({
                              value: profile.id,
                              label: profile.id,
                            })),
                          ]}
                          onChange={(imageProfile) => {
                            const profile = imageModelProfiles.find(
                              (item) => item.id === imageProfile,
                            );
                            change({
                              imageProfile: imageProfile || undefined,
                              model: imageProfile,
                              imageSize: profile?.defaultSize,
                            });
                          }}
                        />
                        <small>{t("aiAdmin.imageProfileHelp")}</small>
                      </label>
                      <label>
                        {t("aiAdmin.imageDeploymentId")}
                        <Input
                          required
                          maxLength={160}
                          value={d.model}
                          disabled={!d.imageProfile}
                          onChange={(e) => change({ model: e.target.value })}
                        />
                        <small>{t("aiAdmin.imageDeploymentHelp")}</small>
                      </label>
                      {d.imageProfile && (
                        <p className="subtle ai-field-wide">
                          {t("aiAdmin.imageSupportedOperations", {
                            operations:
                              imageModelProfiles
                                .find(
                                  (profile) => profile.id === d.imageProfile,
                                )
                                ?.operations.map((operation) =>
                                  t(`aiAdmin.imageOperation.${operation}`),
                                )
                                .join(" / ") ?? "",
                          })}
                        </p>
                      )}
                    </>
                  ) : (
                    <label>
                      {modelVendor?.provider === "azure"
                        ? t("aiAdmin.azureDeployment")
                        : t("aiAdmin.modelId")}
                      <AutoComplete
                        className="ai-choice"
                        value={d.model}
                        placeholder={t("aiAdmin.modelIdPlaceholder")}
                        options={(catalogs[d.vendorId] ?? []).map((m) => ({
                          value: m.id,
                          label:
                            m.name && m.name !== m.id
                              ? `${m.id} (${m.name})`
                              : m.id,
                        }))}
                        filterOption={(input, option) =>
                          String(option?.label ?? "")
                            .toLowerCase()
                            .includes(input.trim().toLowerCase())
                        }
                        onChange={(model) =>
                          change({ model: model.slice(0, 160) })
                        }
                      />
                    </label>
                  )}
                  {supportsApiMode && !d.imageGeneration && (
                    <label>
                      {t("aiAdmin.protocol")}
                      <Choice
                        label={t("aiAdmin.protocol")}
                        value={d.apiMode ?? ""}
                        onChange={(apiMode) =>
                          change({ apiMode: apiMode || undefined })
                        }
                        options={[
                          { value: "", label: t("aiAdmin.protocolAuto") },
                          { value: "chat", label: "Chat Completions" },
                          { value: "responses", label: "Responses API" },
                        ]}
                      />
                      <small>{t("aiAdmin.protocolHelp")}</small>
                    </label>
                  )}
                  <label>
                    {t("aiAdmin.alias")}
                    <Input
                      required={config.display === "alias" && d.enabled}
                      maxLength={80}
                      value={d.alias}
                      placeholder={t("aiAdmin.aliasPlaceholder")}
                      onChange={(e) => change({ alias: e.target.value })}
                    />
                  </label>
                  <label>
                    {t("aiAdmin.purpose")}
                    <Choice
                      label={t("aiAdmin.purpose")}
                      value={
                        d.embedding
                          ? "embedding"
                          : d.imageGeneration
                            ? "image"
                            : "generation"
                      }
                      onChange={(purpose) =>
                        change(
                          purpose === "embedding"
                            ? {
                                embedding: true,
                                tools: false,
                                vision: false,
                                pdf: false,
                                imageGeneration: false,
                                imageProfile: undefined,
                              }
                            : purpose === "image"
                              ? {
                                  embedding: false,
                                  tools: false,
                                  vision: false,
                                  pdf: false,
                                  imageGeneration: true,
                                  imageProfile: undefined,
                                  model: "",
                                  imageSize: undefined,
                                }
                              : {
                                  embedding: false,
                                  tools: true,
                                  imageGeneration: false,
                                  imageProfile: undefined,
                                },
                        )
                      }
                      options={[
                        {
                          value: "generation",
                          label: t("aiAdmin.purposeChat"),
                        },
                        {
                          value: "image",
                          label: t("aiAdmin.purposeImage"),
                          disabled: !imageProfilesForProvider(
                            modelVendor?.provider,
                          ).length,
                        },
                        {
                          value: "embedding",
                          label: t("aiAdmin.cap.embedding"),
                          disabled: !embeddingSource(modelVendor?.provider),
                        },
                      ]}
                    />
                    {!embeddingSource(modelVendor?.provider) && (
                      <small>{t("aiAdmin.embeddingProviders")}</small>
                    )}
                  </label>
                  {d.embedding && (
                    <>
                      <label>
                        {t("aiAdmin.embeddingApi")}
                        <Choice
                          label={t("aiAdmin.embeddingApi")}
                          value={d.embeddingApi ?? "auto"}
                          onChange={(embeddingApiName) =>
                            change({
                              embeddingApi:
                                embeddingApiName === "auto"
                                  ? undefined
                                  : embeddingApiName,
                              embeddingDimensions: undefined,
                            })
                          }
                          options={[
                            {
                              value: "auto",
                              label: t("aiAdmin.embeddingAuto"),
                            },
                            {
                              value: "openai",
                              label: t("aiAdmin.embeddingOpenai"),
                            },
                            {
                              value: "doubao-multimodal",
                              label: t("aiAdmin.embeddingDoubao"),
                            },
                          ]}
                        />
                      </label>
                      <label>
                        {embeddingSource(modelVendor?.provider) === "openAi" &&
                        embeddingApi({
                          ...d,
                          provider: modelVendor?.provider,
                        }) !== "doubao-multimodal"
                          ? t("aiAdmin.dimensionsOptional")
                          : t("aiAdmin.dimensions")}
                        <InputNumber
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
                          value={d.embeddingDimensions ?? null}
                          placeholder={t("aiAdmin.dimensionsPlaceholder")}
                          onChange={(value) =>
                            change({
                              embeddingDimensions: value
                                ? Number(value)
                                : undefined,
                            })
                          }
                        />
                        <button
                          type="button"
                          disabled={busy || !d.model?.trim()}
                          onClick={() => void detectDimensions()}
                        >
                          {busy
                            ? t("aiAdmin.detecting")
                            : t("aiAdmin.detectDimensions")}
                        </button>
                        <small>{t("aiAdmin.dimensionsHelp")}</small>
                      </label>
                      <p className="ai-field-wide subtle">
                        {t("aiAdmin.embeddingEndpoint", {
                          path:
                            embeddingApi({
                              ...d,
                              provider: modelVendor?.provider,
                            }) === "doubao-multimodal"
                              ? "/embeddings/multimodal"
                              : "/embeddings",
                        })}
                      </p>
                    </>
                  )}
                  {!d.embedding &&
                    !d.imageGeneration &&
                    [
                      ["maxInput", "aiAdmin.maxInput", 1000, 10000000],
                      ["maxOutput", "aiAdmin.maxOutput", 32, 1000000],
                    ].map(([f, label, min, max]) => (
                      <label key={f}>
                        {t(label as MessageKey)}
                        <InputNumber
                          required
                          min={Number(min)}
                          max={Number(max)}
                          value={d[f!]}
                          onChange={(value) => change({ [f!]: Number(value) })}
                        />
                        {f === "maxInput" && (
                          <small>{t("aiAdmin.limitsHelp")}</small>
                        )}
                      </label>
                    ))}
                  {!d.embedding && (
                    <fieldset className="ai-field-wide">
                      <legend>{t("aiusage.rates")}</legend>
                      <p className="subtle">
                        {t(
                          d.imageGeneration
                            ? "aiusage.imageRateHelp"
                            : "aiusage.rateHelp",
                        )}
                      </p>
                      <div className="ai-admin-grid">
                        {!d.imageGeneration && (
                          <>
                            <label>
                              {t("aiusage.inputRate")}
                              <InputNumber
                                required
                                min={0}
                                max={1000}
                                step="0.000001"
                                value={d.inputRate ?? 1}
                                onChange={(value) =>
                                  change({ inputRate: Number(value) })
                                }
                              />
                            </label>
                            <label>
                              {t("aiusage.outputRate")}
                              <InputNumber
                                required
                                min={0}
                                max={1000}
                                step="0.000001"
                                value={d.outputRate ?? 1}
                                onChange={(value) =>
                                  change({ outputRate: Number(value) })
                                }
                              />
                            </label>
                          </>
                        )}
                        {d.imageGeneration && (
                          <label>
                            {t("aiusage.imageRate")}
                            <InputNumber
                              required
                              min={0}
                              max={1000000000}
                              step={1}
                              value={d.imageRate ?? 1}
                              onChange={(value) =>
                                change({ imageRate: Number(value) })
                              }
                            />
                          </label>
                        )}
                      </div>
                    </fieldset>
                  )}
                  <label className="ai-field-wide ai-model-enabled">
                    <span>{t("aiAdmin.enableModel")}</span>
                    <Switch
                      checked={!!d.enabled}
                      onChange={(enabled) => change({ enabled })}
                    />
                  </label>
                  {!d.embedding && !d.imageGeneration && (
                    <div className="ai-field-wide ai-actions">
                      {!d.embedding && !d.imageGeneration && (
                        <p className="subtle">{t("aiAdmin.limitsDiffer")}</p>
                      )}
                      {(
                        [
                          ["tools", "aiAdmin.cap.tools"],
                          ["vision", "aiAdmin.cap.vision"],
                          ["pdf", "aiAdmin.cap.pdfNative"],
                        ] as const
                      )
                        .filter(() => !d.embedding && !d.imageGeneration)
                        .map(([f, label]) => (
                          <label key={f}>
                            <Switch
                              checked={!!d[f!]}
                              onChange={(checked) => change({ [f!]: checked })}
                            />
                            {t(label)}
                          </label>
                        ))}
                      {!d.embedding && !d.imageGeneration && (
                        <small className="subtle">{t("aiAdmin.pdfHelp")}</small>
                      )}
                    </div>
                  )}
                  {!d.embedding && d.imageGeneration && (
                    <label>
                      {t("aiAdmin.imageSize")}
                      <Input
                        placeholder={
                          imageModelProfiles.find(
                            (profile) => profile.id === d.imageProfile,
                          )?.defaultSize ?? "1024x1024"
                        }
                        pattern="[0-9]{2,4}x[0-9]{2,4}"
                        value={d.imageSize ?? ""}
                        onChange={(e) =>
                          change({ imageSize: e.target.value || undefined })
                        }
                      />
                      <small className="subtle">
                        {t("aiAdmin.imageSizeHelp")}
                      </small>
                    </label>
                  )}
                </>
              )}
              {edit.type === "skill" && (
                <>
                  <label className="ai-field-wide">
                    {t("aiAdmin.skillName")}
                    <Input
                      required
                      maxLength={80}
                      value={d.name}
                      onChange={(e) => change({ name: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    {t("aiAdmin.skillPurpose")}
                    <Input
                      required
                      maxLength={500}
                      value={d.description}
                      onChange={(e) => change({ description: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    {t("aiAdmin.skillInstructions")}
                    <Input.TextArea
                      required
                      rows={9}
                      maxLength={12000}
                      value={d.content}
                      onChange={(e) => change({ content: e.target.value })}
                    />
                  </label>
                  <label className="ai-field-wide">
                    {t("aiAdmin.skillFormats")}
                    <Select
                      mode="multiple"
                      showSearch
                      optionFilterProp="label"
                      className="ai-choice"
                      value={d.formats}
                      options={formatIds.map((id) => ({
                        value: id,
                        label: t(formatKey[id]),
                      }))}
                      onChange={(formats) => change({ formats })}
                    />
                  </label>
                  <label>
                    <Switch
                      checked={d.enabled}
                      onChange={(checked) => change({ enabled: checked })}
                    />
                    {t("aiAdmin.enableSkill")}
                  </label>
                  {defaultOfficialSkills.some((s) => s.id === d.id) && (
                    <button
                      type="button"
                      onClick={() =>
                        change(defaultOfficialSkills.find((s) => s.id === d.id))
                      }
                    >
                      {t("aiAdmin.restoreSkill")}
                    </button>
                  )}
                </>
              )}
              {edit.type === "general" && (
                <>
                  <label>
                    {t("aiAdmin.displayName")}
                    <Choice
                      label={t("aiAdmin.displayName")}
                      value={d.display}
                      onChange={(display) => change({ display })}
                      options={[
                        { value: "alias", label: t("aiAdmin.displayAlias") },
                        { value: "real", label: t("aiAdmin.displayReal") },
                      ]}
                    />
                  </label>
                  <label>
                    {t("aiAdmin.defaultModel")}
                    <Choice
                      label={t("aiAdmin.defaultModel")}
                      value={d.defaultModel}
                      onChange={(defaultModel) => change({ defaultModel })}
                      options={[
                        { value: "", label: t("aiAdmin.userChooses") },
                        ...config.models
                          .filter((m: any) => m.enabled && !m.embedding && !m.imageGeneration)
                          .map((m: any) => ({
                            value: m.id,
                            label: m.alias || m.model,
                          })),
                      ]}
                    />
                  </label>
                  {(
                    [
                      ["historyRounds", "aiAdmin.historyRounds", 1, 50],
                      ["maxSteps", "aiAdmin.maxSteps", 1, 100],
                    ] as const
                  ).map(([f, label, min, max]) => (
                    <label key={f}>
                      {t(label)}
                      <InputNumber
                        required
                        min={Number(min)}
                        max={Number(max)}
                        value={d[f!]}
                        onChange={(value) => change({ [f!]: Number(value) })}
                      />
                    </label>
                  ))}
                  <p className="subtle ai-field-wide">
                    {t("aiAdmin.generalHelp")}
                  </p>
                </>
              )}
              {edit.type === "tools" && (
                <>
                  {d.section === "search" && (
                    <fieldset className="ai-field-wide">
                      <legend>{t("chat.webSearch")}</legend>
                      <label>
                        {t("aiAdmin.searchService")}
                        <Choice
                          label={t("aiAdmin.searchService")}
                          value={d.webSearch?.provider ?? ""}
                          onChange={(provider) =>
                            change({
                              webSearch: provider
                                ? {
                                    provider,
                                    apiKey: "",
                                    ...(provider === "searxng"
                                      ? { baseUrl: "" }
                                      : {}),
                                  }
                                : undefined,
                            })
                          }
                          options={[
                            {
                              value: "",
                              label: t("accountPolicy.notConfigured"),
                            },
                            { value: "tavily", label: "Tavily" },
                            { value: "brave", label: "Brave Search" },
                            {
                              value: "searxng",
                              label: t("aiAdmin.tools.search.searxng"),
                            },
                          ]}
                        />
                      </label>
                      {d.webSearch?.provider === "searxng" && (
                        <label>
                          {t("aiAdmin.searchUrl")}
                          <Input
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
                            ? t("aiAdmin.searchToken")
                            : t("aiAdmin.searchKey")}
                          <Input.Password
                            autoComplete="new-password"
                            value={d.webSearch.apiKey ?? ""}
                            placeholder={
                              d.webSearch.hasKey
                                ? t("credentials.configured")
                                : t("aiAdmin.keyServerOnly")
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
                      <p className="subtle">{t("aiAdmin.searchHelp")}</p>
                      <button
                        type="button"
                        disabled={busy || !config.webSearch}
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
                          setNotice(null);
                          try {
                            const r = await api<any>(
                              "/admin/ai/web-search/test",
                              "POST",
                            );
                            setNotice({ id: "search", count: r.count });
                          } catch (e) {
                            setError(reportedError(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {t("aiAdmin.testSavedSearch")}
                      </button>
                    </fieldset>
                  )}
                  {d.section === "fetch" && (
                    <fieldset className="ai-field-wide">
                      <legend>{t("aiAdmin.tools.fetch")}</legend>
                      <label>
                        {t("aiAdmin.fetchService")}
                        <Choice
                          label={t("aiAdmin.fetchService")}
                          value={d.webFetch?.provider ?? "builtin"}
                          onChange={(provider) =>
                            change({
                              webFetch: {
                                provider,
                                apiKey: null,
                                ...(provider === "builtin"
                                  ? {}
                                  : { baseUrl: "" }),
                              },
                            })
                          }
                          options={[
                            {
                              value: "builtin",
                              label: t("aiAdmin.tools.fetchBuiltinFree"),
                            },
                            {
                              value: "firecrawl",
                              label: t("aiAdmin.tools.fetch.firecrawl"),
                            },
                            {
                              value: "jina",
                              label: t("aiAdmin.tools.fetch.jina"),
                            },
                            {
                              value: "tavily",
                              label: t("aiAdmin.tools.fetch.tavily"),
                            },
                          ]}
                        />
                      </label>
                      {d.webFetch?.provider !== "builtin" && (
                        <>
                          <label>
                            {t("aiAdmin.fetchUrl")}
                            <Input
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
                            <small>{t("aiAdmin.fetchUrlHelp")}</small>
                          </label>
                          <label>
                            {d.webFetch?.provider === "firecrawl"
                              ? t("aiAdmin.apiKeyOptional")
                              : t("aiAdmin.apiKey")}
                            <Input.Password
                              autoComplete="new-password"
                              value={d.webFetch?.apiKey ?? ""}
                              placeholder={
                                d.webFetch?.hasKey
                                  ? t("credentials.configured")
                                  : d.webFetch?.provider === "firecrawl"
                                    ? t("aiAdmin.firecrawlKeyPlaceholder")
                                    : t("aiAdmin.keyServerOnly")
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
                      <p className="subtle">{t("aiAdmin.fetchHelp")}</p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError(null);
                          setNotice(null);
                          try {
                            const r = await api<any>(
                              "/admin/ai/web-fetch/test",
                              "POST",
                            );
                            setNotice({
                              id: "fetch",
                              provider: r.provider,
                              length: r.length,
                            });
                          } catch (e) {
                            setError(reportedError(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {t("aiAdmin.testSavedFetch")}
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
                      <Popconfirm
                        title={t("aiAdmin.removeConfigConfirm", {
                          name: d.alias || d.name || d.model,
                        })}
                        okText={t("credentials.remove")}
                        cancelText={t("common.cancel")}
                        disabled={busy || hasModels}
                        onConfirm={() =>
                          void save({
                            ...config,
                            ...(edit.type === "model"
                              ? clearImageSelection(d.id)
                              : {}),
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
                        <button
                          className="danger"
                          type="button"
                          disabled={busy || hasModels}
                          title={
                            hasModels
                              ? t("aiAdmin.removeBlocked")
                              : t("aiAdmin.removeConfig")
                          }
                        >
                          {hasModels
                            ? t("aiAdmin.removeWithModels")
                            : t("credentials.remove")}
                        </button>
                      </Popconfirm>
                    )
                  );
                })()}
              <button
                type="button"
                disabled={busy}
                onClick={() => setEdit(null)}
              >
                {t("common.cancel")}
              </button>
              <button className="primary" disabled={busy}>
                {busy ? t("aiAdmin.saving") : t("aiAdmin.save")}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </section>
  );
}
