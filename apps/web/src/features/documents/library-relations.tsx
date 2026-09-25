import type { KnowledgeSourceSelection } from "@doca/web-plugin-registry";
import { pluginMessage, webPluginRegistry, type KnowledgeSourceRenderContext } from "@web/plugins/registry.js";
import { api, roleRank, type Detail } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import "./library-system.css";

type LibraryPreset = {
  weight: number;
  frequency: "off" | "daily" | "weekly";
  copyText: boolean;
  note: string;
};

type SourcePreset = {
  weight: number | null;
  frequency: "inherit" | "off" | "daily" | "weekly";
  copyText: "inherit" | "yes" | "no";
  note: string;
};

type SubscriptionItem = {
  id: string;
  sourceKind: string;
  sourceId: string;
  url: string;
  nodeId: string | null;
  nodeTitle: string;
  sourceTitle: string;
  status: string;
  preset: SourcePreset;
};

type RunItem = {
  id: string;
  trigger: string;
  status: string;
  detail: string;
  createdAt: string;
};

type SystemPayload = {
  items: SubscriptionItem[];
  guideText: string;
  splitMode: string;
  aiCurated: boolean;
  schedule: "off" | "daily" | "weekly";
  preset: LibraryPreset;
  runs: RunItem[];
};

type Tab = "structure" | "preset" | "sources" | "triggers";
type Schedule = "off" | "daily" | "weekly";

const knownSelections = new Set<KnowledgeSourceSelection>(["document", "file", "folder", "mailbox", "message", "url", "config"]);

function sourceSelection(source: { sourceKind: string; selection?: KnowledgeSourceSelection }): KnowledgeSourceSelection {
  if (source.selection && knownSelections.has(source.selection)) return source.selection;
  if (source.sourceKind === "mail") return "message";
  if (source.sourceKind === "document" || source.sourceKind === "file" || source.sourceKind === "folder" || source.sourceKind === "mailbox" || source.sourceKind === "url") return source.sourceKind;
  return "config";
}

function runSummary(detail: string) {
  try {
    const value = JSON.parse(detail) as { pending?: unknown; stale?: unknown };
    if (typeof value.pending === "number" && typeof value.stale === "number") return value;
  } catch {
    return null;
  }
  return null;
}

export function LibrarySystemPage({
  detail,
  changed,
}: {
  detail: Detail;
  changed: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const resource = detail.resource;
  const curated = Number(resource.ai_curated) === 1;
  const [tab, setTab] = useState<Tab>("sources");
  const [guideText, setGuideText] = useState("");
  const [splitMode, setSplitMode] = useState("source");
  const [schedule, setSchedule] = useState<Schedule>("off");
  const [preset, setPreset] = useState<LibraryPreset>({ weight: 5, frequency: "off", copyText: true, note: "" });
  const [editingId, setEditingId] = useState("");
  const [items, setItems] = useState<SubscriptionItem[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canMaintain = roleRank(resource.role) >= 4;
  const splitKey = (splitMode === "content" || splitMode === "outline" || splitMode === "custom" ? splitMode : "source") as "source" | "content" | "outline" | "custom";
  const splitKeys = { source: "library.split.source", content: "library.split.content", outline: "library.split.outline", custom: "library.split.custom" } as const;
  const statusKeys = { pending: "library.status.pending", active: "library.status.active", stale: "library.status.stale", missing: "library.status.missing" } as const;
  const tabKeys = { structure: "library.relations.tab.structure", preset: "library.relations.tab.preset", sources: "library.relations.tab.sources", triggers: "library.relations.tab.triggers" } as const;
  const scheduleKeys = { off: "library.trigger.off", daily: "library.trigger.daily", weekly: "library.trigger.weekly" } as const;
  const sources = webPluginRegistry.knowledgeSources.list();

  function apply(payload: SystemPayload) {
    setGuideText(payload.guideText);
    setSplitMode(payload.splitMode);
    setSchedule(payload.schedule === "daily" || payload.schedule === "weekly" ? payload.schedule : "off");
    setPreset(payload.preset ?? { weight: 5, frequency: payload.schedule === "daily" || payload.schedule === "weekly" ? payload.schedule : "off", copyText: true, note: "" });
    setItems(payload.items);
    setRuns(payload.runs ?? []);
  }

  async function reloadList() {
    apply(await api<SystemPayload>(`/knowledge/libraries/${resource.id}/subscriptions`));
  }

  useEffect(() => {
    const controller = new AbortController();
    void api<SystemPayload>(`/knowledge/libraries/${resource.id}/subscriptions`, "GET", undefined, controller.signal)
      .then((payload) => {
        if (!controller.signal.aborted) apply(payload);
      })
      .catch((cause) => {
        if ((cause as { name?: string }).name !== "AbortError") setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
      });
    return () => controller.abort();
  }, [resource.id, curated]);

  async function fillPreset(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await changed();
      await reloadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="library-system">
      <header>
        <h2>{t("nav.librarySystem")}</h2>
        <p>{t("library.curated.body")}</p>
      </header>
      <label className="library-system-switch">
        <input
          type="checkbox"
          role="switch"
          checked={curated}
          disabled={!canMaintain || busy}
          aria-label={t("library.relations.switch")}
          onChange={(event) => void run(async () => {
            await api(`/knowledge/libraries/${resource.id}/curation`, "POST", { enabled: event.target.checked });
          })}
        />
        <span>
          <strong>{t("library.relations.switch")}</strong>
          <small>{t("library.relations.switchHint")}</small>
        </span>
      </label>
      {error && <Feedback tone="error" message={error} />}
      {notice && <p className="library-system-notice">{notice}</p>}
      <div className="library-system-tabs" role="tablist">
        {(["structure", "preset", "sources", "triggers"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {t(tabKeys[id])}
          </button>
        ))}
      </div>
      {tab === "structure" && (
        <section>
          <h3>{t("library.system.guideLabel")}</h3>
          {curated ? <p className="library-system-split">{t("library.system.split", { mode: t(splitKeys[splitKey]) })}</p> : <p className="library-system-empty">{t("library.system.pending")}</p>}
          <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/knowledge/libraries/${resource.id}/guide`, "POST", { markdown: guideText }); }); }}>
            <textarea value={guideText} onChange={(event) => setGuideText(event.target.value)} aria-label={t("library.system.guideLabel")} readOnly={!canMaintain || !curated} />
            {canMaintain && <button type="submit" className="primary" disabled={busy || !curated}>{t("library.system.saveGuide")}</button>}
          </form>
        </section>
      )}
      {tab === "preset" && (
        <section>
          <h3>{t("library.relations.tab.preset")}</h3>
          <p className="library-system-split">{t("library.preset.hint")}</p>
          <PresetForm
            preset={preset}
            busy={busy || !canMaintain || !curated}
            onChange={setPreset}
            onDraft={() => void fillPreset(async () => {
              const drafted = await api<{ preset: LibraryPreset }>(`/knowledge/libraries/${resource.id}/preset/draft`, "POST");
              setPreset(drafted.preset);
            })}
            onSave={() => void run(async () => {
              await api(`/knowledge/libraries/${resource.id}/preset`, "POST", preset);
            })}
          />
        </section>
      )}
      {tab === "sources" && (
        <section>
          <h3>{t("library.relations.tab.sources")}</h3>
          {canMaintain && (
            <SourcePicker
              libraryId={resource.id}
              locale={locale}
              busy={busy}
              bind={(sourceKind, sourceId, url) => run(async () => {
                await api(`/knowledge/libraries/${resource.id}/subscriptions`, "POST", { sourceKind, sourceId, url });
              })}
            />
          )}
          <ul className="library-system-links">
            {items.map((item) => {
              const source = sources.find((entry) => entry.sourceKind === item.sourceKind);
              const label = source?.labelKey ? pluginMessage(locale, source.labelKey) : item.sourceKind;
              return (
                <li key={item.id}>
                  <strong>{item.nodeTitle || item.sourceTitle || item.url || label}</strong>
                  <small>{label} · {t(statusKeys[item.status === "stale" || item.status === "missing" || item.status === "pending" ? item.status : "active"])}</small>
                  {item.nodeId && <button type="button" onClick={() => { location.hash = `/r/${item.nodeId}`; }}>{item.nodeTitle || t("library.system.nodes")}</button>}
                  {canMaintain && (
                    <span className="library-system-actions">
                      <button type="button" disabled={busy || !curated} onClick={() => setEditingId(editingId === item.id ? "" : item.id)}>{t("library.preset.open")}</button>
                    </span>
                  )}
                  {canMaintain && editingId === item.id && (
                    <SourcePresetForm
                      preset={item.preset}
                      busy={busy || !curated}
                      onDraft={() => void fillPreset(async () => {
                        const drafted = await api<{ preset: SourcePreset }>(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/preset/draft`, "POST");
                        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, preset: drafted.preset } : entry));
                      })}
                      onSave={(next) => void run(async () => {
                        await api(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/preset`, "POST", next);
                      })}
                    />
                  )}
                  {canMaintain && item.status === "pending" && (
                    <span className="library-system-actions">
                      <button type="button" className="primary" disabled={busy || !curated} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/confirm`, "POST"); })}>{t("library.system.confirm")}</button>
                      <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/dismiss`, "POST"); })}>{t("library.system.dismiss")}</button>
                    </span>
                  )}
                </li>
              );
            })}
            {!items.length && <li className="library-system-empty">{t("library.system.emptySubscriptions")}</li>}
          </ul>
        </section>
      )}
      {tab === "triggers" && (
        <section>
          <h3>{t("library.relations.tab.triggers")}</h3>
          <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/knowledge/libraries/${resource.id}/schedule`, "POST", { mode: schedule }); }); }}>
            {(["off", "daily", "weekly"] as const).map((mode) => (
              <label key={mode}>
                <input type="radio" name="knowledge-schedule" value={mode} checked={schedule === mode} disabled={!canMaintain || !curated || busy} onChange={() => setSchedule(mode)} />
                {t(scheduleKeys[mode])}
              </label>
            ))}
            {canMaintain && <button type="submit" className="primary" disabled={busy || !curated}>{t("library.trigger.save")}</button>}
            {canMaintain && <button type="button" disabled={busy || !curated} onClick={() => void run(async () => {
              const result = await api<{ pending: number; stale: number }>(`/knowledge/libraries/${resource.id}/runs`, "POST");
              setNotice(t("library.trigger.ran", { pending: result.pending, stale: result.stale }));
            })}>{t("library.trigger.run")}</button>}
          </form>
          <ul className="library-system-links">
            {runs.map((run) => {
              const counts = runSummary(run.detail);
              const trigger = run.trigger === "schedule" ? t("library.trigger.schedule") : t("library.trigger.manual");
              return (
                <li key={run.id}>
                  <strong>{trigger}</strong>
                  <small>{counts ? t("library.trigger.ran", { pending: counts.pending, stale: counts.stale }) : run.createdAt}</small>
                </li>
              );
            })}
            {!runs.length && <li className="library-system-empty">{t("library.trigger.empty")}</li>}
          </ul>
        </section>
      )}
    </section>
  );
}

function PresetForm({
  preset,
  busy,
  onChange,
  onDraft,
  onSave,
}: {
  preset: LibraryPreset;
  busy: boolean;
  onChange: (next: LibraryPreset) => void;
  onDraft: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const scheduleKeys = { off: "library.trigger.off", daily: "library.trigger.daily", weekly: "library.trigger.weekly" } as const;
  return (
    <form className="library-preset-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <label className="library-preset-row">
        {t("library.preset.weight")}
        <input type="number" min={1} max={10} value={preset.weight} disabled={busy} aria-label={t("library.preset.weight")} onChange={(event) => {
          const weight = Number(event.target.value);
          if (Number.isInteger(weight) && weight >= 1 && weight <= 10) onChange({ ...preset, weight });
        }} />
      </label>
      <div className="library-preset-row" role="radiogroup" aria-label={t("library.preset.frequency")}>
        {(["off", "daily", "weekly"] as const).map((mode) => (
          <label key={mode}>
            <input type="radio" name="library-preset-frequency" checked={preset.frequency === mode} disabled={busy} onChange={() => onChange({ ...preset, frequency: mode })} />
            {t(scheduleKeys[mode])}
          </label>
        ))}
      </div>
      <label className="library-preset-row">
        <input type="checkbox" checked={preset.copyText} disabled={busy} onChange={(event) => onChange({ ...preset, copyText: event.target.checked })} />
        {t("library.preset.copy")}
      </label>
      <textarea value={preset.note} disabled={busy} aria-label={t("library.preset.note")} onChange={(event) => onChange({ ...preset, note: event.target.value })} />
      <div className="library-system-actions">
        <button type="button" disabled={busy} onClick={onDraft}>{t("library.preset.generate")}</button>
        <button type="submit" className="primary" disabled={busy}>{t("library.preset.save")}</button>
      </div>
    </form>
  );
}

function SourcePresetForm({
  preset,
  busy,
  onDraft,
  onSave,
}: {
  preset: SourcePreset;
  busy: boolean;
  onDraft: () => void;
  onSave: (next: SourcePreset) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(preset);
  useEffect(() => { setValue(preset); }, [preset]);
  const scheduleKeys = { inherit: "library.preset.inherit", off: "library.trigger.off", daily: "library.trigger.daily", weekly: "library.trigger.weekly" } as const;
  const copyKeys = { inherit: "library.preset.inherit", yes: "library.preset.copy.yes", no: "library.preset.copy.no" } as const;
  return (
    <form className="library-preset-form" onSubmit={(event) => { event.preventDefault(); onSave(value); }}>
      <label className="library-preset-row">
        {t("library.preset.weight")}
        <input type="number" min={1} max={10} value={value.weight ?? ""} disabled={busy} placeholder={t("library.preset.inherit")} aria-label={t("library.preset.weight")} onChange={(event) => {
          if (!event.target.value) {
            setValue({ ...value, weight: null });
            return;
          }
          const weight = Number(event.target.value);
          if (Number.isInteger(weight) && weight >= 1 && weight <= 10) setValue({ ...value, weight });
        }} />
      </label>
      <div className="library-preset-row" role="radiogroup" aria-label={t("library.preset.frequency")}>
        {(["inherit", "off", "daily", "weekly"] as const).map((mode) => (
          <label key={mode}>
            <input type="radio" name="source-preset-frequency" checked={value.frequency === mode} disabled={busy} onChange={() => setValue({ ...value, frequency: mode })} />
            {t(scheduleKeys[mode])}
          </label>
        ))}
      </div>
      <div className="library-preset-row" role="radiogroup" aria-label={t("library.preset.copy")}>
        {(["inherit", "yes", "no"] as const).map((mode) => (
          <label key={mode}>
            <input type="radio" name="source-preset-copy" checked={value.copyText === mode} disabled={busy} onChange={() => setValue({ ...value, copyText: mode })} />
            {t(copyKeys[mode])}
          </label>
        ))}
      </div>
      <textarea value={value.note} disabled={busy} aria-label={t("library.preset.note")} onChange={(event) => setValue({ ...value, note: event.target.value })} />
      <div className="library-system-actions">
        <button type="button" disabled={busy} onClick={onDraft}>{t("library.preset.generate")}</button>
        <button type="submit" className="primary" disabled={busy}>{t("library.preset.save")}</button>
      </div>
    </form>
  );
}

function SourcePicker({
  libraryId,
  locale,
  busy,
  bind,
}: {
  libraryId: string;
  locale: string;
  busy: boolean;
  bind: (sourceKind: string, sourceId?: string, url?: string) => void;
}) {
  const { t } = useI18n();
  const sources = webPluginRegistry.knowledgeSources.list();
  const [activeId, setActiveId] = useState(sources[0]?.id ?? "");
  const active = sources.find((source) => source.id === activeId) ?? sources[0];
  const selection = active ? sourceSelection(active) : "config";
  const [rows, setRows] = useState<Array<{ id: string; label: string; bindable: boolean; enter: boolean }>>([]);
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState<{ type: "system" | "folder"; id: string }>({ type: "system", id: "root" });
  const [mailboxId, setMailboxId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || selection === "url" || selection === "config") return;
    const controller = new AbortController();
    setError("");
    const load = async () => {
      if (selection === "document") {
        const page = await api<{ items: Array<{ id: string; title: string; library_id?: string | null }> }>(`/resources?scope=all&kind=document`, "GET", undefined, controller.signal);
        return page.items.filter((item) => item.library_id !== libraryId).slice(0, 40).map((item) => ({ id: item.id, label: item.title, bindable: true, enter: false }));
      }
      if (selection === "file" || selection === "folder") {
        const page = await api<{ folders: Array<{ id: string; name: string; virtual?: boolean; type: string }>; files: Array<{ id: string; name: string }> }>(`/files?parentType=${folder.type}&parentId=${encodeURIComponent(folder.id)}`, "GET", undefined, controller.signal);
        const folders = page.folders.filter((item) => !item.virtual && item.type === "folder").map((item) => ({ id: item.id, label: item.name, bindable: selection === "folder", enter: true }));
        const files = selection === "file" ? page.files.map((item) => ({ id: item.id, label: item.name, bindable: true, enter: false })) : [];
        return [...folders, ...files];
      }
      if (selection === "message" && mailboxId) {
        const page = await api<{ items: Array<{ id: string; subject?: string }> }>(`/mail/mailboxes/${mailboxId}/messages`, "GET", undefined, controller.signal);
        return page.items.slice(0, 40).map((item) => ({ id: item.id, label: item.subject || item.id, bindable: true, enter: false }));
      }
      const page = await api<{ items: Array<{ id: string; address?: string; display_name?: string }> }>("/mail/mailboxes", "GET", undefined, controller.signal);
      return page.items.map((item) => ({ id: item.id, label: item.address || item.display_name || item.id, bindable: selection === "mailbox", enter: selection === "message" }));
    };
    void load()
      .then((next) => {
        if (!controller.signal.aborted) setRows(next);
      })
      .catch((cause) => {
        if ((cause as { name?: string }).name !== "AbortError") setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
      });
    return () => controller.abort();
  }, [active?.id, selection, folder.id, folder.type, mailboxId, libraryId]);

  if (!active) return null;
  const context: KnowledgeSourceRenderContext = {
    render: () => null,
    bind: (target) => bind(active.sourceKind, target.sourceId, target.url),
  };

  return (
    <div className="library-source-picker">
      <div className="library-system-tabs">
        {sources.map((source) => (
          <button key={source.id} type="button" aria-pressed={source.id === active.id} onClick={() => { setActiveId(source.id); setFolder({ type: "system", id: "root" }); setMailboxId(""); }}>
            {source.labelKey ? pluginMessage(locale, source.labelKey) : source.sourceKind}
          </button>
        ))}
      </div>
      {error && <p className="library-system-empty">{error}</p>}
      {selection === "url" && (
        <form onSubmit={(event) => { event.preventDefault(); bind(active.sourceKind, undefined, url.trim()); setUrl(""); }}>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" aria-label={t("library.system.linkLabel")} />
          <button type="submit" className="primary" disabled={busy || !url.trim()}>{t("library.system.addLink")}</button>
        </form>
      )}
      {selection === "config" && active.render(undefined, context)}
      {selection !== "url" && selection !== "config" && (
        <>
          {(folder.id !== "root" || mailboxId) && (
            <button type="button" onClick={() => { setFolder({ type: "system", id: "root" }); setMailboxId(""); }}>{t("library.relations.back")}</button>
          )}
          <ul className="library-system-links">
            {rows.map((row) => (
              <li key={row.id}>
                <strong>{row.label}</strong>
                <span className="library-system-actions">
                  {row.bindable && <button type="button" className="primary" disabled={busy} onClick={() => bind(active.sourceKind, row.id)}>{t("library.relations.bind")}</button>}
                  {row.enter && <button type="button" disabled={busy} onClick={() => {
                    if (selection === "message") setMailboxId(row.id);
                    else setFolder({ type: "folder", id: row.id });
                  }}>{t("library.relations.open")}</button>}
                </span>
              </li>
            ))}
            {!rows.length && <li className="library-system-empty">{t("library.relations.pickEmpty")}</li>}
          </ul>
        </>
      )}
    </div>
  );
}

export function LibraryQaPage({
  detail,
  changed,
}: {
  detail: Detail;
  changed: () => Promise<void>;
}) {
  const { t } = useI18n();
  const resource = detail.resource;
  const canMaintain = roleRank(resource.role) >= 4;
  const [title, setTitle] = useState(resource.title);
  const [published, setPublished] = useState(false);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Array<{ nodeId: string; title: string; excerpt: string }>>([]);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ title: string; published: boolean }>(`/knowledge/libraries/${resource.id}/bot`, "GET", undefined, controller.signal)
      .then((bot) => {
        if (controller.signal.aborted) return;
        setTitle(bot.title);
        setPublished(bot.published);
      })
      .catch((cause) => {
        if ((cause as { name?: string }).name !== "AbortError") setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
      });
    return () => controller.abort();
  }, [resource.id]);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await changed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="library-system">
      <header>
        <h2>{t("library.qa.title")}</h2>
        <p>{t("library.qa.body")}</p>
      </header>
      {error && <Feedback tone="error" message={error} />}
      {canMaintain && (
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/knowledge/libraries/${resource.id}/bot`, "POST", { title, published }); }); }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label={t("library.qa.name")} />
          <label>
            <input type="checkbox" checked={published} onChange={(event) => setPublished(event.target.checked)} />
            {t("library.qa.publish")}
          </label>
          <button type="submit" className="primary" disabled={busy}>{t("library.qa.save")}</button>
        </form>
      )}
      <div className="library-qa-channels">
        <article>
          <h3>{t("library.qa.channel.page")}</h3>
          <p>{t("library.qa.channel.pageHint")}</p>
        </article>
        <article>
          <h3>{t("library.qa.channel.mcp")}</h3>
          <p>{t("library.qa.channel.mcpHint")}</p>
        </article>
        <article>
          <h3>{t("library.qa.channel.api")}</h3>
          <p>{t("library.qa.channel.apiHint")}</p>
        </article>
      </div>
      {(published || canMaintain) && (
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await api<{ items: Array<{ nodeId: string; title: string; excerpt: string }> }>(`/knowledge/libraries/${resource.id}/ask`, "POST", { query: question.trim() });
            setAnswers(result.items);
            setAsked(true);
          });
        }}>
          <input value={question} onChange={(event) => setQuestion(event.target.value)} aria-label={t("library.qa.question")} />
          <button type="submit" className="primary" disabled={busy || !question.trim()}>{t("library.qa.ask")}</button>
        </form>
      )}
      <ul className="library-system-links">
        {answers.map((item) => (
          <li key={item.nodeId}>
            <button type="button" onClick={() => { location.hash = `/r/${item.nodeId}`; }}>{item.title}</button>
            {item.excerpt && <small>{item.excerpt}</small>}
          </li>
        ))}
        {asked && !answers.length && <li className="library-system-empty">{t("library.qa.empty")}</li>}
      </ul>
    </section>
  );
}
