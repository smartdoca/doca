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
  const [instructionPath, setInstructionPath] = useState("KNOWLEDGE.md");
  const [schedule, setSchedule] = useState<Schedule>("off");
  const [items, setItems] = useState<SubscriptionItem[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canMaintain = roleRank(resource.role) >= 4;
  const statusKeys = { pending: "library.status.pending", active: "library.status.active", stale: "library.status.stale", missing: "library.status.missing" } as const;
  const tabKeys = { knowledge: "knowledge.workspace", structure: "library.relations.tab.structure", preset: "library.relations.tab.preset", sources: "library.relations.tab.sources", triggers: "library.relations.tab.triggers" } as const;
  const scheduleKeys = { off: "library.trigger.off", daily: "library.trigger.daily", weekly: "library.trigger.weekly" } as const;
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
        {(["knowledge", "sources", "triggers"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {t(tabKeys[id])}
          </button>
        ))}
      </div>
      <div hidden={tab !== "knowledge"}>{canMaintain ? <KnowledgeWorkspace key={resource.id} libraryId={resource.id} initialPath={instructionPath} enabled={curated} active={tab === "knowledge"} /> : <p>{t("knowledge.manageOnly")}</p>}</div>
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
                  <small>{label} · {item.status === "detached" ? t("knowledge.unsubscribed") : t(statusKeys[item.status === "stale" || item.status === "missing" || item.status === "pending" ? item.status : "active"])}</small>
                  {item.nodeId && <button type="button" onClick={() => { location.hash = `/r/${item.nodeId}`; }}>{item.nodeTitle || t("library.system.nodes")}</button>}
                  {canMaintain && (
                    <span className="library-system-actions">
                      <button type="button" disabled={busy} onClick={() => { setInstructionPath(`sources/${item.id}/SOURCE.md`); setTab("knowledge"); }}>{t("knowledge.sourceSettings")}</button>
                    </span>
                  )}
                  {canMaintain && item.canDelete && item.status !== "detached" && <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/detach`, "POST"); })}>{t("knowledge.detach")}</button>}

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
              await api(`/knowledge/libraries/${resource.id}/curate`, "POST");
              setNotice(t("knowledge.status.queued"));
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
          <ul className="library-system-links">
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
