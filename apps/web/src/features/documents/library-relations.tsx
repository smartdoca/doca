import { Plus, FileText, Link2, Folder, Database, UserRound, ShieldCheck, Scale, NotebookPen, Play, Clock3 } from "lucide-react";
import { Dialog } from "./dialogs.js";
import { KnowledgeRuleDialog } from "@web/features/knowledge/knowledge-rule-dialog.js";
import { KnowledgeWorkspace } from "@web/features/knowledge/knowledge-workspace.js";
import { KnowledgeAssistants } from "@web/features/knowledge/knowledge-assistants.js";
import type { KnowledgeSourceSelection } from "@doca/web-plugin-registry";
import { pluginMessage, webPluginRegistry, type KnowledgeSourceRenderContext } from "@web/plugins/registry.js";
import { api, roleRank, type Detail } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import "./library-system.css";

type SubscriptionItem = {
  creator: { id: string; displayName: string };
  guideConfigured: boolean;
  guidePreview: string;
  weightHint: string;
  safety: { redactContacts: boolean; hiddenTerms: number; excluded: boolean; linkAccess: string; editable: boolean };
  canEdit: boolean;
  canDelete: boolean;
  id: string;
  sourceKind: string;
  sourceId: string;
  url: string;
  nodeId: string | null;
  nodeTitle: string;
  sourceTitle: string;
  status: string;
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
  runs: RunItem[];
};

type Tab = "knowledge" | "sources" | "triggers";
type Schedule = "off" | "daily" | "weekly";

const runStatusKeys = { queued: "knowledge.status.queued", running: "knowledge.status.running", awaiting_review: "knowledge.status.review", failed: "knowledge.status.failed", partial: "knowledge.status.partial", succeeded: "knowledge.status.succeeded", canceled: "knowledge.status.canceled" } as const;

const knownSelections = new Set<KnowledgeSourceSelection>(["document", "file", "folder", "url", "config"]);

function sourceSelection(source: { sourceKind: string; selection?: KnowledgeSourceSelection }): KnowledgeSourceSelection {
  if (source.selection && knownSelections.has(source.selection)) return source.selection;
  if (source.sourceKind === "document" || source.sourceKind === "file" || source.sourceKind === "folder" || source.sourceKind === "url") return source.sourceKind;
  return "config";
}

function runSummary(detail: string) {
  try {
    const value = JSON.parse(detail) as { pending?: unknown; stale?: unknown };
    if (typeof value.pending === "number" && typeof value.stale === "number")
      return { pending: value.pending, stale: value.stale };
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
  const [tab, setTab] = useState<Tab>("knowledge");
  const [instructionPath] = useState("KNOWLEDGE.md");
  const [picker, setPicker] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [editor, setEditor] = useState<{ source?: SubscriptionItem; mode: "guide" | "weights" | "safety" }>();
  const [schedule, setSchedule] = useState<Schedule>("off");
  const [items, setItems] = useState<SubscriptionItem[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canMaintain = roleRank(resource.role) >= 4;
  const statusKeys = { pending: "library.status.pending", active: "library.status.active", stale: "library.status.stale", missing: "library.status.missing" } as const;
  const tabKeys = { knowledge: "knowledge.workspace", structure: "library.relations.tab.structure", preset: "library.relations.tab.preset", sources: "library.relations.tab.sources", triggers: "library.relations.tab.triggers" } as const;
  const scheduleKeys = { off: "knowledge.manualOnly", daily: "library.trigger.daily", weekly: "library.trigger.weekly" } as const;
  const sources = webPluginRegistry.knowledgeSources.list();

  function apply(payload: SystemPayload) {
    setSchedule(payload.schedule === "daily" || payload.schedule === "weekly" ? payload.schedule : "off");
    setItems(payload.items);
    setRuns(payload.runs ?? []);
  }

  async function reloadList() {
    apply(await api<SystemPayload>(`/knowledge/libraries/${resource.id}/subscriptions`));
  }

  useEffect(() => {
    if (!canMaintain) return;
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
      <header className="knowledge-page-header">
        <div><h2>{t("nav.librarySystem")}</h2>
        <p>{t("library.curated.body")}</p></div>
        {canMaintain && <button type="button" className="knowledge-weights-button" onClick={() => setEditor({ mode: "weights" })}><Scale size={16} />{t("knowledge.weightsAndConflicts")}</button>}
      </header>
      <div className="library-system-switch">
        <div><strong>{t("library.relations.switch")}</strong><small>{t("library.relations.switchHint")}</small></div>
        <button className="knowledge-toggle" type="button" role="switch" aria-checked={curated} aria-label={t("library.relations.switch")} disabled={!canMaintain || busy} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/curation`, "POST", { enabled: !curated }); })}><span /></button>
      </div>
      {error && <Feedback tone="error" message={error} />}
      {notice && <p className="library-system-notice">{notice}</p>}
      <div className="library-system-tabs" role="tablist">
        {(["knowledge", "sources", "triggers"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {t(tabKeys[id])}
          </button>
        ))}
      </div>
      <div hidden={tab !== "knowledge"}>{canMaintain ? <KnowledgeWorkspace key={resource.id} libraryId={resource.id} initialPath={instructionPath} enabled={curated} active={tab === "knowledge"} refreshVersion={refreshVersion} /> : <p>{t("knowledge.manageOnly")}</p>}</div>
      {tab === "sources" && (
        <section className="knowledge-sources-panel">
          <div className="knowledge-section-heading"><div><h3>{t("knowledge.sourceSubscriptions")}</h3><p>{t("knowledge.sourceCardsHint")}</p></div>{canMaintain && <button className="primary" type="button" onClick={() => setPicker(true)}><Plus size={16} />{t("knowledge.addSource")}</button>}</div>
          <div className="knowledge-source-grid">
            {items.map(item => {
              const source = sources.find(entry => entry.sourceKind === item.sourceKind);
              const kindLabel = source?.labelKey ? pluginMessage(locale, source.labelKey) : item.sourceKind;
              const Icon = item.sourceKind === "url" ? Link2 : item.sourceKind === "folder" ? Folder : item.sourceKind === "document" ? FileText : Database;
              const title = item.nodeTitle || item.sourceTitle || item.url || kindLabel;
              return <article key={item.id} className={`knowledge-source-card ${item.status === "detached" ? "is-detached" : ""}`}>
                <div className="knowledge-source-card-top"><span className="knowledge-source-icon"><Icon size={19} /></span><span className="knowledge-source-kind">{kindLabel}</span><span className={`knowledge-source-status status-${item.status}`}>{item.status === "detached" ? t("knowledge.unsubscribed") : t(statusKeys[item.status === "stale" || item.status === "missing" || item.status === "pending" ? item.status : "active"])}</span></div>
                <h4 title={title}>{title}</h4>
                <div className="knowledge-source-creator"><UserRound size={14} /><span>{t("knowledge.sourceCreator")}</span><strong>{item.creator?.displayName || t("knowledge.unknownCreator")}</strong></div>
                <div className="knowledge-source-summary"><span>{t("knowledge.sourceGuide")}</span><p>{item.guideConfigured ? item.guidePreview : t("knowledge.guideNotConfigured")}</p></div>
                <div className="knowledge-source-weight"><Scale size={14} /><span>{item.weightHint || t("knowledge.inheritWeights")}</span></div>
                <div className="knowledge-source-boundaries"><ShieldCheck size={14} /><span>{item.safety?.excluded ? t("knowledge.sourcePaused") : item.safety?.redactContacts ? t("knowledge.contactFilterOn") : t("knowledge.sourceLimits")}</span>{!item.canEdit && <small>{t("knowledge.managedByCreator")}</small>}</div>
                <div className="knowledge-source-card-actions"><button type="button" onClick={() => setEditor({ source: item, mode: "guide" })}><NotebookPen size={14} />{t("knowledge.sourceGuide")}</button><button type="button" onClick={() => setEditor({ source: item, mode: "weights" })}><Scale size={14} />{t("knowledge.weightsShort")}</button><button type="button" onClick={() => setEditor({ source: item, mode: "safety" })}><ShieldCheck size={14} />{t("knowledge.sourceLimits")}</button></div>
                {canMaintain && item.canDelete && item.status !== "detached" && <button type="button" className="knowledge-source-detach" disabled={busy} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/detach`, "POST"); })}>{t("knowledge.detach")}</button>}
              </article>;
            })}
          </div>
          {!items.length && <div className="knowledge-source-empty"><Database size={28} /><strong>{t("library.system.emptySubscriptions")}</strong><p>{t("knowledge.sourceCardsHint")}</p></div>}
        </section>
      )}
      {picker && <Dialog title={t("knowledge.addSource")} close={() => setPicker(false)} className="knowledge-source-picker-dialog"><SourcePicker libraryId={resource.id} locale={locale} busy={busy} bind={(sourceKind, sourceId, url) => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions`, "POST", { sourceKind, sourceId, url }); setPicker(false); setRefreshVersion(value => value + 1); })} /></Dialog>}
      {editor && <KnowledgeRuleDialog libraryId={resource.id} source={editor.source ? { id: editor.source.id, title: editor.source.sourceTitle || editor.source.url || t("knowledge.sourceGuide"), kind: editor.source.sourceKind, canEdit: editor.source.canEdit } : undefined} mode={editor.mode} close={() => setEditor(undefined)} saved={async () => { await reloadList(); setRefreshVersion(value => value + 1); }} />}
      {tab === "triggers" && (
        <section className="knowledge-trigger-panel">
          <div className="knowledge-section-heading"><div><h3>{t("knowledge.curationSchedule")}</h3><p>{t("knowledge.scheduleHint")}</p></div><Clock3 size={20} /></div>
          <form className="knowledge-schedule-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/knowledge/libraries/${resource.id}/schedule`, "POST", { mode: schedule }); }); }}>
            {(["off", "daily", "weekly"] as const).map((mode) => (
              <label key={mode} className={`knowledge-schedule-choice ${schedule === mode ? "is-selected" : ""}`}>
                <input type="radio" name="knowledge-schedule" value={mode} checked={schedule === mode} disabled={!canMaintain || !curated || busy} onChange={() => setSchedule(mode)} />
                {t(scheduleKeys[mode])}
              </label>
            ))}
            {canMaintain && <div className="knowledge-schedule-actions"><button type="submit" className="primary" disabled={busy || !curated}>{t("library.trigger.save")}</button></div>}
            {canMaintain && <button type="button" disabled={busy || !curated} onClick={() => void run(async () => {
              await api(`/knowledge/libraries/${resource.id}/curate`, "POST");
              setNotice(t("knowledge.status.queued"));
            })}>{t("library.trigger.run")}</button>}
          </form>
          <div className="knowledge-section-heading"><h3>{t("knowledge.recentRuns")}</h3></div>
          <ul className="library-system-links knowledge-run-list">
            {runs.map((run) => {
              const counts = runSummary(run.detail);
              const trigger = run.trigger === "schedule" ? t("library.trigger.schedule") : t("library.trigger.manual");
              return (
                <li key={run.id}>
                  <strong>{trigger}</strong>
                  <span className={`knowledge-source-status status-${run.status}`}>{t(runStatusKeys[run.status as keyof typeof runStatusKeys] ?? "knowledge.status.review")}</span>
                  <small>{counts ? t("library.trigger.ran", { pending: counts.pending, stale: counts.stale }) : new Date(run.createdAt).toLocaleString(locale)}</small>
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
      return [];
    };
    void load()
      .then((next) => {
        if (!controller.signal.aborted) setRows(next);
      })
      .catch((cause) => {
        if ((cause as { name?: string }).name !== "AbortError") setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
      });
    return () => controller.abort();
  }, [active?.id, selection, folder.id, folder.type, libraryId]);

  if (!active) return null;
  const context: KnowledgeSourceRenderContext = {
    render: () => null,
    bind: (target) => bind(active.sourceKind, target.sourceId, target.url),
  };

  return (
    <div className="library-source-picker">
      <div className="library-system-tabs">
        {sources.map((source) => (
          <button key={source.id} type="button" aria-pressed={source.id === active.id} onClick={() => { setActiveId(source.id); setFolder({ type: "system", id: "root" }); }}>
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
          {(folder.id !== "root") && (
            <button type="button" onClick={() => { setFolder({ type: "system", id: "root" }); }}>{t("library.relations.back")}</button>
          )}
          <ul className="library-system-links knowledge-picker-results">
            {rows.map((row) => (
              <li key={row.id}>
                <strong>{row.label}</strong>
                <span className="library-system-actions">
                  {row.bindable && <button type="button" className="primary" disabled={busy} onClick={() => bind(active.sourceKind, row.id)}>{t("library.relations.bind")}</button>}
                  {row.enter && <button type="button" disabled={busy} onClick={() => {
                    setFolder({ type: "folder", id: row.id });
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

export function LibraryQaPage({ detail }: { detail: Detail; changed: () => Promise<void> }) {
  return <KnowledgeAssistants libraryId={detail.resource.id} />;
}
