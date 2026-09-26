import { KnowledgeCurationSettings } from "@web/features/knowledge/knowledge-curation-settings.js";
import { KnowledgeChat } from "@web/features/knowledge/knowledge-chat.js";
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

type SourceGroup = {config?:string;id:string;title:string;source_kind:string};
type SubscriptionItem = {
  groupId?:string|null;
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
  groups: SourceGroup[];
  guideText: string;
  splitMode: string;
  aiCurated: boolean;
  schedule: "off" | "daily" | "weekly";
  runs: RunItem[];
};

type Tab = "knowledge" | "sources" | "triggers" | "settings" | "instructions";
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
  const [groups,setGroups]=useState<SourceGroup[]>([]);
  const [editingGroup,setEditingGroup]=useState<SourceGroup>();
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canMaintain = roleRank(resource.role) >= 4;
  const statusKeys = { pending: "library.status.pending", active: "library.status.active", stale: "library.status.stale", missing: "library.status.missing" } as const;
  const tabKeys = { instructions: "knowledge.instructions", settings: "studio.settingsTab", knowledge: "knowledge.workspace", structure: "library.relations.tab.structure", preset: "library.relations.tab.preset", sources: "library.relations.tab.sources", triggers: "library.relations.tab.triggers" } as const;
  const scheduleKeys = { off: "knowledge.manualOnly", daily: "library.trigger.daily", weekly: "library.trigger.weekly" } as const;
  const sources = webPluginRegistry.knowledgeSources.list();

  function apply(payload: SystemPayload) {
    setSchedule(payload.schedule === "daily" || payload.schedule === "weekly" ? payload.schedule : "off");
    setItems(payload.items);
    setGroups(payload.groups??[]);
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
    <section className="library-system knowledge-full-width">
      {error && <Feedback tone="error" message={error} />}
      {notice && <p className="library-system-notice">{notice}</p>}
      <div className="library-system-tabs" role="tablist">
        {(["knowledge", "sources", "instructions", "triggers", "settings"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {t(tabKeys[id])}
          </button>
        ))}
      </div>
      {tab === "settings" && <><header className="knowledge-page-header">
        <div>
        <p>{t("library.curated.body")}</p></div>
        {canMaintain && <button type="button" className="knowledge-weights-button" onClick={() => setEditor({ mode: "weights" })}><Scale size={16} />{t("knowledge.weightsAndConflicts")}</button>}
      </header>
      {canMaintain && <><KnowledgeCurationSettings scopeId={resource.id}/><KnowledgeWorkspace surface="settings" libraryId={resource.id} enabled={curated} active={tab === "settings"} refreshVersion={refreshVersion}/></>}</>}
      {canMaintain && <div hidden={tab !== "instructions"}><KnowledgeWorkspace surface="instructions" libraryId={resource.id} initialPath={instructionPath} enabled={curated} active={tab === "instructions"} refreshVersion={refreshVersion}/></div>}
      <div hidden={tab !== "knowledge"}>{canMaintain ? <><KnowledgeChat key={`${resource.id}:${refreshVersion}`} scopeId={resource.id} kind="curation" /></> : <p>{t("knowledge.manageOnly")}</p>}</div>
      {tab === "sources" && (
        <section className="knowledge-sources-panel">
          <div className="knowledge-section-heading"><div><h3>{t("knowledge.sourceSubscriptions")}</h3><p>{t("knowledge.sourceCardsHint")}</p></div>{canMaintain && <button className="primary" type="button" onClick={() => setPicker(true)}><Plus size={16} />{t("knowledge.addSource")}</button>}</div>
          <div className="knowledge-source-grid">
            {groups.map(group=>{const members=items.filter(x=>x.groupId===group.id&&x.status!=="detached");const paused=members.length>0&&members.every(x=>x.safety.excluded);return <article className="knowledge-source-card" key={group.id}><h4>{group.title}</h4><small>{t((`sourceGroup.kind.${group.source_kind}`) as any)} · {members.length}</small><details><summary>{t("sourceGroup.members",{count:members.length})}</summary><ul>{members.map(member=><li key={member.id}><span>{member.sourceTitle||member.url||member.sourceId}</span> <small>{member.status}</small><button type="button" onClick={()=>setEditor({source:member,mode:"guide"})}>{t("knowledge.sourceGuide")}</button></li>)}</ul></details><div className="knowledge-source-card-actions"><button type="button" onClick={()=>setEditingGroup(group)}>{t("sourceGroup.edit")}</button><button disabled={busy} type="button" onClick={()=>void run(async()=>{await api(`/knowledge/libraries/${resource.id}/source-actions`,"POST",{sourceKey:group.id,action:paused?"resume":"pause",reason:t("studio.manualSourceChange")});})}>{t(paused?"sourceGroup.resume":"sourceGroup.pause")}</button></div></article>;})}
            {items.filter(item=>!item.groupId).map(item => {
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
      {picker && <Dialog title={t("knowledge.addSource")} close={() => setPicker(false)} className="knowledge-source-picker-dialog"><SourcePicker libraryId={resource.id} locale={locale} busy={busy} bind={(sourceKind, sourceIds, urls, title, guide) => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions`, "POST", { sourceKind, title, guide, ...(sourceKind==="url"?{urls}:{sourceIds}) }); setPicker(false); setRefreshVersion(value => value + 1); })} /></Dialog>}
      {editingGroup&&<Dialog title={t("sourceGroup.edit")} close={()=>setEditingGroup(undefined)} className="knowledge-source-picker-dialog"><SourcePicker libraryId={resource.id} locale={locale} busy={busy} initial={{guide:JSON.parse(editingGroup.config??"{}").guide??"",sourceKind:editingGroup.source_kind,title:editingGroup.title,sourceIds:items.filter(x=>x.groupId===editingGroup.id&&x.status!=="detached").map(x=>x.sourceId).filter(Boolean),urls:items.filter(x=>x.groupId===editingGroup.id&&x.status!=="detached").map(x=>x.url).filter(Boolean)}} bind={(sourceKind,sourceIds,urls,title,guide)=>void run(async()=>{await api(`/knowledge/libraries/${resource.id}/source-groups/${editingGroup.id}`,"PUT",{title,guide,...(sourceKind==="url"?{urls}:{sourceIds})});setEditingGroup(undefined);setRefreshVersion(x=>x+1);})}/></Dialog>}
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
              setTab("knowledge");
              setRefreshVersion(value=>value+1);
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

export function SourcePicker({libraryId,locale,busy,bind,initial}:{libraryId:string;locale:string;busy:boolean;bind:(sourceKind:string,sourceIds:string[],urls:string[],title:string,guide:string)=>void;initial?:{sourceKind:string;title:string;sourceIds:string[];urls:string[];guide?:string}}) {
  const {t}=useI18n();
  const sources=webPluginRegistry.knowledgeSources.list();
  const [kind,setKind]=useState(initial?.sourceKind??"url"),[name,setName]=useState(initial?.title??"");
  const [guide,setGuide]=useState(initial?.guide??"");
  const [selected,setSelected]=useState<string[]>(initial?.sourceIds??[]),[url,setUrl]=useState(initial?.urls.join("\n")??"");
  const [rows,setRows]=useState<Array<{id:string;label:string;bindable:boolean;enter:boolean}>>([]);
  const [folder,setFolder]=useState<{type:"system"|"folder";id:string}>({type:"system",id:"root"});
  const [error,setError]=useState("");
  const active=sources.find(x=>x.sourceKind===kind);
  useEffect(()=>{
    const controller=new AbortController();
    setError("");setRows([]);
    const load=async()=>{
      if(kind==="document"||kind==="library") {
        const all:typeof rows=[];let offset:number|null=0;
        do {const page: {items:Array<{id:string;title:string;library_id?:string|null;libraryName?:string}>;nextOffset:number|null}=await api<{items:Array<{id:string;title:string;library_id?:string|null;libraryName?:string}>;nextOffset:number|null}>(`/resources?scope=all&kind=${kind}&offset=${offset}`,"GET",undefined,controller.signal);all.push(...page.items.filter(x=>x.id!==libraryId&&x.library_id!==libraryId).map(x=>({id:x.id,label:[x.libraryName,x.title].filter(Boolean).join(" / "),bindable:true,enter:false})));offset=page.nextOffset;}while(offset!=null&&!controller.signal.aborted);
        return all;
      }
      if(kind==="file"||kind==="folder") {
        const page=await api<{folders:Array<{id:string;name:string;virtual?:boolean;type:string}>;files:Array<{id:string;name:string}>}>(`/files?parentType=${folder.type}&parentId=${encodeURIComponent(folder.id)}`,"GET",undefined,controller.signal);
        return [...page.folders.filter(x=>!x.virtual&&x.type==="folder").map(x=>({id:x.id,label:x.name,bindable:kind==="folder",enter:true})),...(kind==="file"?page.files.map(x=>({id:x.id,label:x.name,bindable:true,enter:false})):[])];
      }
      return [];
    };
    void load().then(x=>{if(!controller.signal.aborted)setRows(x);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[kind,folder.id,folder.type,libraryId]);
  const choices=[...new Set(["url","library","document",...sources.map(x=>x.sourceKind)])];
  const label=(k:string)=>{const source=sources.find(x=>x.sourceKind===k);return k==="library"?t("sourceGroup.libraries"):source?.labelKey?pluginMessage(locale,source.labelKey):k;};
  const urls=[...new Set(url.split(/\s+/).map(x=>x.trim()).filter(Boolean))];
  return <div className="library-source-picker">
    <p>{t("sourceGroup.hint")}</p>
    <label>{t("sourceGroup.name")}<input value={name} onChange={e=>setName(e.target.value)} placeholder={t("sourceGroup.nameExample")}/></label>
    <div className="library-system-tabs">{choices.map(k=><button type="button" key={k} disabled={!!initial&&k!==initial.sourceKind} aria-pressed={kind===k} onClick={()=>{setKind(k);setSelected([]);setUrl("");setFolder({type:"system",id:"root"});}}>{label(k)}</button>)}</div>
    {error&&<p role="alert">{error}</p>}
    {kind==="url"?<textarea value={url} onChange={e=>setUrl(e.target.value)} rows={8} aria-label={t("sourceGroup.links")} placeholder={t("sourceGroup.links")}/>:<>
      {folder.id!=="root"&&<button type="button" onClick={()=>setFolder({type:"system",id:"root"})}>{t("library.relations.back")}</button>}
      <ul className="library-system-links knowledge-picker-results">{rows.map(row=><li key={row.id}><label>{row.bindable&&<input type="checkbox" checked={selected.includes(row.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,row.id]:old.filter(id=>id!==row.id))}/>} {row.label}</label>{row.enter&&<button type="button" onClick={()=>setFolder({type:"folder",id:row.id})}>{t("library.relations.open")}</button>}</li>)}</ul>
      {!rows.length&&<p>{t("library.relations.pickEmpty")}</p>}
      {active&&sourceSelection(active)==="config"&&active.render(undefined,{render:()=>null,bind:target=>{if(target.sourceId)setSelected(old=>[...new Set([...old,target.sourceId!])]);if(target.url)setUrl(old=>old+"\n"+target.url);}})}
    </>}
    <label>{t("knowledge.sourceGuide")}<textarea rows={4} value={guide} onChange={e=>setGuide(e.target.value)} placeholder={t("sourceGroup.guideHint")}/></label>
    <p>{t("sourceGroup.selected",{count:kind==="url"?urls.length:selected.length})}</p>
    <button type="button" className="primary" disabled={busy||!name.trim()||!(kind==="url"?urls.length:selected.length)} onClick={()=>bind(kind,selected,urls,name,guide)}>{t(initial?"sourceGroup.save":"sourceGroup.create")}</button>
  </div>;
}

export function LibraryQaPage({ detail }: { detail: Detail; changed: () => Promise<void> }) {
  const {t}=useI18n();
  return <section className="library-system knowledge-full-width"><p>{t("studio.qaGuide")}</p><a className="primary" href={`#/knowledge-assistants?library=${detail.resource.id}`}>{t("studio.manageBots")}</a></section>;
}

export function KnowledgeCurationToggle({detail,changed}:{detail:Detail;changed:()=>Promise<void>}) {
 const {t}=useI18n();const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const enabled=Number(detail.resource.ai_curated)===1;
 return <span className="knowledge-heading-toggle"><button type="button" className="knowledge-toggle" role="switch" aria-label={t("library.relations.switch")} aria-checked={enabled} title={t("library.relations.switchHint")} disabled={busy||roleRank(detail.resource.role)<4} onClick={async()=>{setBusy(true);setError("");try{await api(`/knowledge/libraries/${detail.resource.id}/curation`,"POST",{enabled:!enabled});await changed();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><span/></button>{error&&<small role="alert">{error}</small>}</span>;
}
