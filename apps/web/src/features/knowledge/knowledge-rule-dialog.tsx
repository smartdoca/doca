import { useEffect, useState } from "react";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";

type Policy = { linkAccess: "public" | "follow" | "closed"; redactContacts: boolean; redactedTerms: string[]; excludedResourceIds: string[] };
type Bundle = { files: { path: string; markdown: string; revision: number }[]; settingsRevision: number; settings: { sourcePolicies: Record<string, Policy>; excludedSourceIds: string[]; [key: string]: unknown } };
export function KnowledgeRuleDialog({ libraryId, source, mode: initialMode, close, saved }: {
  libraryId: string;
  source?: { id: string; title: string; kind: string; canEdit: boolean };
  mode: "guide" | "weights" | "safety";
  close(): void;
  saved(): Promise<void>;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState(initialMode);
  const [bundle, setBundle] = useState<Bundle>();
  const [markdown, setMarkdown] = useState("");
  const [policy, setPolicy] = useState<Policy>({ linkAccess: "public", redactContacts: false, redactedTerms: [], excludedResourceIds: [] });
  const [excluded, setExcluded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = source ? `sources/${source.id}/SOURCE.md` : "guides/weights.md";
  const root = `/knowledge/libraries/${libraryId}`;
  const editable = !source || source.canEdit;
  useEffect(() => {
    const controller = new AbortController();
    void api<Bundle>(`${root}/system`, "GET", undefined, controller.signal).then(value => {
      setBundle(value);
      setMarkdown(value.files.find(file => file.path === path)?.markdown ?? t("knowledge.weightsTemplate"));
      if (source) {
        setPolicy(value.settings.sourcePolicies[source.id] ?? { linkAccess: "public", redactContacts: false, redactedTerms: [], excludedResourceIds: [] });
        setExcluded(value.settings.excludedSourceIds.includes(source.id));
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [libraryId, source?.id]);
  async function save() {
    if (!bundle || !editable) return;
    setBusy(true); setError("");
    try {
      const file = bundle.files.find(item => item.path === path);
      if (markdown !== (file?.markdown ?? "") || (!file?.revision && mode !== "safety")) {
        const updated = await api<{ path: string; markdown: string; revision: number }>(`${root}/instructions`, "POST", { path, markdown, expectedRevision: file?.revision ?? 0 });
        setBundle(current => current ? { ...current, files: [...current.files.filter(item => item.path !== path), updated] } : current);
      }
      if (source) {
        const original = bundle.settings.sourcePolicies[source.id] ?? { linkAccess: "public", redactContacts: false, redactedTerms: [], excludedResourceIds: [] };
        if (JSON.stringify(policy) !== JSON.stringify(original) || excluded !== bundle.settings.excludedSourceIds.includes(source.id)) {
          await api(`${root}/settings`, "POST", { expectedRevision: bundle.settingsRevision, settings: { ...bundle.settings,
            excludedSourceIds: [...bundle.settings.excludedSourceIds.filter(id => id !== source.id), ...(excluded ? [source.id] : [])],
            sourcePolicies: { ...bundle.settings.sourcePolicies, [source.id]: { ...policy, redactedTerms: policy.redactedTerms.map(value => value.trim()).filter(Boolean) } },
          } });
        }
      }
      await saved(); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog className="knowledge-rule-dialog" title={source?.title || t("knowledge.weightsAndConflicts")} close={() => { if (!busy) close(); }}>
    <div className="knowledge-rule-body">
      {source && <div className="knowledge-rule-tabs" role="tablist">{(["guide", "weights", "safety"] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={mode === tab} onClick={() => setMode(tab)}>{t(tab === "guide" ? "knowledge.sourceGuide" : tab === "weights" ? "knowledge.weightsAndConflicts" : "knowledge.sourceLimits")}</button>)}</div>}
      <Feedback tone="error" message={error} />
      {!editable && <p className="knowledge-rule-note">{t("knowledge.sourceCreatorOnly")}</p>}
      {mode === "safety" && source && !editable ? <p className="knowledge-rule-note">{t("knowledge.sourceCreatorHint")}</p> : mode === "safety" && source ? <fieldset disabled={!editable || busy || !bundle} className="knowledge-rule-fields">
        <label className="knowledge-rule-check"><input type="checkbox" checked={excluded} onChange={event => setExcluded(event.target.checked)} /><span>{t("knowledge.excludeSource")}</span></label>
        <label className="knowledge-rule-check"><input type="checkbox" checked={policy.redactContacts} onChange={event => setPolicy({ ...policy, redactContacts: event.target.checked })} /><span>{t("knowledge.redactContacts")}</span></label>
        <label>{t("knowledge.redactedTerms")}<textarea rows={4} value={policy.redactedTerms.join("\n")} onChange={event => setPolicy({ ...policy, redactedTerms: event.target.value.split("\n") })} /></label>
        {source.kind === "url" && <label>{t("knowledge.linkAccess")}<Select value={policy.linkAccess} onChange={event => setPolicy({ ...policy, linkAccess: event.target.value as Policy["linkAccess"] })}><option value="public">{t("knowledge.linkPublic")}</option><option value="follow">{t("knowledge.linkFollow")}</option><option value="closed">{t("knowledge.linkClosed")}</option></Select><small>{t("knowledge.linkAccessHint")}</small></label>}
        <p className="knowledge-rule-note">{t("knowledge.safetyHint")}</p>
      </fieldset> : <>
        <p className="knowledge-rule-note">{t(mode === "weights" ? "knowledge.weightsEditorHint" : "knowledge.sourceCreatorHint")}</p>
        <textarea className="knowledge-rule-markdown" aria-label={t(mode === "weights" ? "knowledge.weightsAndConflicts" : "knowledge.sourceGuide")} value={markdown} readOnly={!editable} disabled={!bundle || busy} onChange={event => setMarkdown(event.target.value)} />
      </>}
    </div>
    <footer><button onClick={close} disabled={busy}>{t("common.cancel")}</button>{editable && <button className="primary" onClick={() => void save()} disabled={!bundle || busy}>{t("knowledge.save")}</button>}</footer>
  </Dialog>;
}
