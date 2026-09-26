import Preview from "@web/features/documents/markdown-preview.js";
import { Select } from "@web/shared/components/select.js";
import "./knowledge-workspace.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";

type File = { path: string; markdown: string; revision: number };
type Entry = {
  path: string[];
  id: string;
  title: string;
  markdown: string;
  revision: number;
  origin: string;
  status: string;
  reviewState: { reason?: string; replaces?: string; conflict?: boolean };
};
type SourcePolicy = {
  linkAccess?: "public" | "follow" | "closed";
  redactedTerms: string[];
  redactContacts: boolean;
  excludedResourceIds: string[];
};
type Settings = {
  maxDocumentDepth: number;
  autoPublishWeighted: boolean;
  sourcePolicies: Record<string, SourcePolicy>;
  modelId: string;
  excludedSourceIds: string[];
  redactedTerms: string[];
  redactContacts: boolean;
};
type Payload = {
  sourcePermissions: Record<
    string,
    { canEdit: boolean; canDelete: boolean; kind: string }
  >;
  sourceLabels: Record<string, string>;
  files: File[];
  settings: Settings;
  settingsRevision: number;
  entries: Entry[];
  humanChanges: {
    id: string;
    title: string;
    createdAt: string;
    change: { removed: string; inserted: string };
  }[];
  reviews: { id: string; revision: number; title: string }[];
  runs: { id: string; status: string; detail: string; created_at: string }[];
  gaps: { key: string; title: string; path: string[]; detail: string }[];
};
export function KnowledgeWorkspace({
  libraryId,
  initialPath = "KNOWLEDGE.md",
  enabled,
  active = true,
  refreshVersion = 0,
}: {
  libraryId: string;
  initialPath?: string;
  enabled: boolean;
  active?: boolean;
  refreshVersion?: number;
}) {
  const { t } = useI18n();
  const importInput = useRef<HTMLInputElement>(null);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [deleteId, setDeleteId] = useState("");
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, File>>({});
  const [view, setView] = useState<"instructions" | "entries">(() => location.hash.includes("section=entries") ? "entries" : "instructions");
  useEffect(() => {
    const navigate = () => { if (location.hash.includes("section=entries")) setView("entries"); };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  const [data, setData] = useState<Payload>();
  const [path, setPath] = useState(initialPath);
  const [file, setFile] = useState<File>({
    path: initialPath,
    markdown: "",
    revision: 0,
  });
  const [guideName, setGuideName] = useState("");
  const [settings, setSettings] = useState<Settings>({
    sourcePolicies: {},
    maxDocumentDepth: 3,
    autoPublishWeighted: false,
    modelId: "",
    excludedSourceIds: [],
    redactedTerms: [],
    redactContacts: false,
  });
  const [entry, setEntry] = useState<{
    id?: string;
    path?: string[];
    title: string;
    markdown: string;
    expectedRevision: number;
  }>({ title: "", markdown: "", expectedRevision: 0 });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const root = `/knowledge/libraries/${libraryId}`;
  async function load() {
    const result = await api<Payload>(`${root}/system`);
    setData(result);
    return result;
  }
  useEffect(() => {
    void api<{ models: { id: string; name: string }[] }>("/ai/options")
      .then((r) => setModels(r.models))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const c = new AbortController();
    void api<Payload>(`${root}/system`, "GET", undefined, c.signal)
      .then((result) => {
        setData(result);
        setSettings(result.settings);
        setFile(
          result.files.find((f) => f.path === initialPath) || result.files[0]!,
        );
        setPath(initialPath);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [libraryId]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void api<Payload>(`${root}/system`)
      .then((result) => {
        if (disposed) return;
        setData(result);
        setSettings(previous => JSON.stringify(previous) === JSON.stringify(data?.settings) ? result.settings : previous);
        setFile(previous => {
          const old = data?.files.find(item => item.path === previous.path);
          const next = result.files.find(item => item.path === previous.path);
          return old && next && previous.markdown === old.markdown ? next : previous;
        });
        if (initialPath !== path) {
          setDrafts((current) => ({ ...current, [file.path]: file }));
          const selected =
            drafts[initialPath] ||
            result.files.find((f) => f.path === initialPath);
          if (selected) {
            setFile(selected);
            setPath(initialPath);
            setView("instructions");
          }
        }
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [initialPath, active, refreshVersion]);
  useEffect(() => {
    if (
      !data?.runs.some((r) => r.status === "queued" || r.status === "running")
    )
      return;
    const timer = setInterval(() => {
      void load().catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [data?.runs, libraryId]);
  async function work(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await fn();
      await load();
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const normalizeSettings = (value: Settings) => ({
    ...value,
    redactedTerms: value.redactedTerms
      .map((term) => term.trim())
      .filter(Boolean),
    sourcePolicies: Object.fromEntries(
      Object.entries(value.sourcePolicies).map(([id, policy]) => [
        id,
        {
          ...policy,
          redactedTerms: policy.redactedTerms
            .map((term) => term.trim())
            .filter(Boolean),
        },
      ]),
    ),
  });
  const unsaved =
    !!data &&
    ([
      ...Object.values(drafts).filter((draft) => draft.path !== file.path),
      file,
    ].some(
      (draft) =>
        draft.markdown !==
        (data.files.find((saved) => saved.path === draft.path)?.markdown ?? ""),
    ) ||
      JSON.stringify(normalizeSettings(settings)) !==
        JSON.stringify(normalizeSettings(data.settings)));
  const selectedSource = file.path.startsWith("sources/")
    ? data?.sourcePermissions[file.path.split("/")[1]!]
    : undefined;
  const readOnlySource = !!selectedSource && !selectedSource.canEdit;
  const skipKeys = {
    excluded: "knowledge.skip.excluded",
    unavailable: "knowledge.skip.unavailable",
    creator_unavailable: "knowledge.skip.creator",
    not_parsed: "knowledge.skip.unparsed",
    file_not_parsed: "knowledge.skip.unparsed",
    unsupported: "knowledge.skip.unsupported",
  } as const;
  const originKeys = {
    human_authored: "knowledge.origin.human",
    ai_synthesized: "knowledge.origin.ai",
    human_revised: "knowledge.origin.revised",
  } as const;
  const statusKeys = {
    canceled: "knowledge.status.canceled",
    queued: "knowledge.status.queued",
    running: "knowledge.status.running",
    draft: "knowledge.status.draft",
    published: "knowledge.status.published",
    awaiting_review: "knowledge.status.review",
    failed: "knowledge.status.failed",
    partial: "knowledge.status.partial",
    succeeded: "knowledge.status.succeeded",
  } as const;
  return (
    <section className="knowledge-workspace">
      {error && <Feedback tone="error" message={error} />}
      {saved && <Feedback tone="success" message={t("knowledge.saved")} />}
      <div className="knowledge-overview">
        <div>
          <strong>{data?.files.length ?? 0}</strong>
          <span>{t("knowledge.instructions")}</span>
        </div>
        <div>
          <strong>
            {data?.entries.filter((e) => e.status === "published").length ?? 0}
          </strong>
          <span>{t("knowledge.status.published")}</span>
        </div>
        <div>
          <strong>
            {data?.entries.filter((e) => e.status === "draft").length ?? 0}
          </strong>
          <span>{t("knowledge.status.draft")}</span>
        </div>
      </div>
      <div className="library-system-tabs">
        <button
          aria-pressed={view === "instructions"}
          onClick={() => setView("instructions")}
        >
          {t("knowledge.instructions")}
        </button>
        <button
          aria-pressed={view === "entries"}
          onClick={() => setView("entries")}
        >
          {t("knowledge.entries")}
        </button>
      </div>
      {view === "instructions" && (
        <>
          <h3>{t("knowledge.instructions")}</h3>
          <p>{t("knowledge.instructionsHint")}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void work(async () => {
                const saved = await api<File>(`${root}/instructions`, "POST", {
                  path: file.path,
                  markdown: file.markdown,
                  expectedRevision: file.revision,
                });
                setFile(saved);
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[file.path];
                  return next;
                });
              });
            }}
          >
            <label>
              {t("knowledge.instructionFile")}
              <Select
                value={path}
                disabled={busy}
                onChange={(e) => {
                  setDrafts({ ...drafts, [file.path]: file });
                  setPath(e.target.value);
                  setFile(
                    drafts[e.target.value] ||
                      data!.files.find((f) => f.path === e.target.value)!,
                  );
                }}
              >
                {data?.files.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path === "KNOWLEDGE.md"
                      ? t("knowledge.mainGuide")
                      : f.path.startsWith("sources/")
                        ? data.sourceLabels[f.path.split("/")[1]!] ||
                          t("knowledge.sourceGuide")
                        : f.path.slice(7, -3)}
                  </option>
                ))}
                {[...new Set([...Object.keys(drafts), path])]
                  .filter((p) => !data?.files.some((f) => f.path === p))
                  .map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
              </Select>
            </label>
            <div className="library-system-actions">
              <button
                type="button"
                aria-pressed={!preview}
                onClick={() => setPreview(false)}
              >
                {t("knowledge.write")}
              </button>
              <button
                type="button"
                aria-pressed={preview}
                onClick={() => setPreview(true)}
              >
                {t("knowledge.preview")}
              </button>
            </div>
            {selectedSource && (
              <p>
                {t(
                  readOnlySource
                    ? "knowledge.sourceCreatorOnly"
                    : "knowledge.sourceCreatorHint",
                )}
              </p>
            )}
            {preview ? (
              <Preview value={file.markdown} />
            ) : (
              <textarea
                aria-label={t("knowledge.instructions")}
                value={file.markdown}
                onChange={(e) => {
                  setSaved(false);
                  setFile({ ...file, markdown: e.target.value });
                }}
                readOnly={readOnlySource}
                rows={15}
              />
            )}
            <div className="library-system-actions">
              <button disabled={busy || readOnlySource || !data} type="submit">
                {t("knowledge.save")}
              </button>
              <input
                ref={importInput}
                type="file"
                accept=".md,.markdown,text/markdown,text/plain"
                hidden
                onChange={(event) => {
                  const imported = event.target.files?.[0];
                  event.target.value = "";
                  if (!imported) return;
                  if (imported.size > 160000) {
                    setError(t("knowledge.importTooLarge"));
                    return;
                  }
                  void imported
                    .text()
                    .then((markdown) => {
                      if (markdown.length > 40000) {
                        setError(t("knowledge.importTooLarge"));
                        return;
                      }
                      setFile({ ...file, markdown });
                      setSaved(false);
                      setPreview(false);
                    })
                    .catch((error) => setError(error.message));
                }}
              />
              <button
                type="button"
                disabled={busy || readOnlySource}
                onClick={() => importInput.current?.click()}
              >
                {t("knowledge.import")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([file.markdown], { type: "text/markdown" }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = path.split("/").pop()!;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                {t("knowledge.download")}
              </button>
            </div>
          </form>
          <form
            className="library-system-actions"
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^[a-zA-Z0-9_-]+$/.test(guideName)) return;
              const next = `guides/${guideName}.md`;
              setDrafts((current) => ({ ...current, [file.path]: file }));
              setPath(next);
              setFile(
                drafts[next] ||
                  data?.files.find((f) => f.path === next) || {
                    path: next,
                    revision: 0,
                    markdown: "",
                  },
              );
              setGuideName("");
            }}
          >
            <input
              value={guideName}
              pattern="[a-zA-Z0-9_-]+"
              placeholder={t("knowledge.guideName")}
              aria-label={t("knowledge.guideName")}
              onChange={(e) => setGuideName(e.target.value)}
            />
            <button disabled={!guideName || busy}>
              {t("knowledge.addGuide")}
            </button>
          </form>
          <details open={path.startsWith("sources/")}>
            <summary>{t("knowledge.runtime")}</summary>
            <p>{t("knowledge.safetyHint")}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void work(() =>
                  api(`${root}/settings`, "POST", {
                    expectedRevision: data?.settingsRevision ?? 0,
                    settings: {
                      ...settings,
                      redactedTerms: settings.redactedTerms
                        .map((x) => x.trim())
                        .filter(Boolean),
                      sourcePolicies: Object.fromEntries(
                        Object.entries(settings.sourcePolicies).map(
                          ([id, policy]) => [
                            id,
                            {
                              ...policy,
                              redactedTerms: policy.redactedTerms
                                .map((x) => x.trim())
                                .filter(Boolean),
                            },
                          ],
                        ),
                      ),
                    },
                  }),
                );
              }}
            >
              <label>
                {t("knowledge.model")}
                <Select
                  value={settings.modelId}
                  onChange={(e) =>
                    setSettings({ ...settings, modelId: e.target.value })
                  }
                >
                  <option value="">{t("knowledge.defaultModel")}</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.redactContacts}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      redactContacts: e.target.checked,
                    })
                  }
                />
                {t("knowledge.redactContacts")}
              </label>
              <label>
                {t("knowledge.redactedTerms")}
                <textarea
                  value={settings.redactedTerms.join("\n")}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      redactedTerms: e.target.value.split("\n"),
                    })
                  }
                />
              </label>
              <label>
                {t("knowledge.maxDepth")}
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.maxDocumentDepth}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      maxDocumentDepth: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.autoPublishWeighted}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      autoPublishWeighted: event.target.checked,
                    })
                  }
                />
                {t("knowledge.autoWeighted")}
              </label>
              <small>{t("knowledge.autoWeightedHint")}</small>
              <fieldset>
                <legend>{t("knowledge.sourceSafety")}</legend>
                {data?.files
                  .filter((f) => f.path.startsWith("sources/"))
                  .map((f) => {
                    const id = f.path.split("/")[1]!;
                    const policy = settings.sourcePolicies[id] || {
                      redactedTerms: [],
                      redactContacts: false,
                      excludedResourceIds: [],
                    };
                    const updatePolicy = (patch: Partial<SourcePolicy>) =>
                      setSettings({
                        ...settings,
                        sourcePolicies: {
                          ...settings.sourcePolicies,
                          [id]: { ...policy, ...patch },
                        },
                      });
                    return (
                      <details key={id} open={path === `sources/${id}/SOURCE.md`}>
                        <summary>
                          {data.sourceLabels[id] || t("knowledge.sourceGuide")}
                        </summary>
                        <fieldset
                          disabled={!data.sourcePermissions[id]?.canEdit}
                        >
                          {data.sourcePermissions[id]?.kind === "url" && (
                            <label>
                              {t("knowledge.linkAccess")}
                              <Select
                                value={policy.linkAccess ?? "public"}
                                onChange={(event) =>
                                  updatePolicy({
                                    linkAccess: event.target
                                      .value as SourcePolicy["linkAccess"],
                                  })
                                }
                              >
                                <option value="public">
                                  {t("knowledge.linkPublic")}
                                </option>
                                <option value="follow">
                                  {t("knowledge.linkFollow")}
                                </option>
                                <option value="closed">
                                  {t("knowledge.linkClosed")}
                                </option>
                              </Select>
                              <small>{t("knowledge.linkAccessHint")}</small>
                            </label>
                          )}
                          <label>
                            <input
                              type="checkbox"
                              checked={settings.excludedSourceIds.includes(id)}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  excludedSourceIds: e.target.checked
                                    ? [...settings.excludedSourceIds, id]
                                    : settings.excludedSourceIds.filter(
                                        (x) => x !== id,
                                      ),
                                })
                              }
                            />
                            {t("knowledge.excludeSource")}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={
                                policy.redactContacts || settings.redactContacts
                              }
                              disabled={settings.redactContacts}
                              onChange={(e) =>
                                updatePolicy({
                                  redactContacts: e.target.checked,
                                })
                              }
                            />
                            {t("knowledge.redactContacts")}
                          </label>
                          <label>
                            {t("knowledge.redactedTerms")}
                            <textarea
                              value={policy.redactedTerms.join("\n")}
                              onChange={(e) =>
                                updatePolicy({
                                  redactedTerms: e.target.value.split("\n"),
                                })
                              }
                            />
                          </label>
                        </fieldset>
                      </details>
                    );
                  })}
              </fieldset>
              <button disabled={busy}>{t("knowledge.save")}</button>
            </form>
          </details>
        </>
      )}
      <h3>{t("knowledge.curation")}</h3>
      <p>{t("knowledge.curationHint")}</p>
      {unsaved && <p role="status">{t("knowledge.saveBeforeCuration")}</p>}
      <button
        disabled={
          busy ||
          !enabled ||
          !data ||
          unsaved ||
          data?.runs.some(
            (r) => r.status === "queued" || r.status === "running",
          )
        }
        onClick={() => void work(() => api(`${root}/curate`, "POST", {}))}
      >
        {t("knowledge.curate")}
      </button>
      <h3>{t("knowledge.gaps")}</h3>
      <p>{t("knowledge.gapsHint")}</p>
      {!data?.gaps.length && (
        <p className="knowledge-empty">{t("knowledge.gapsEmpty")}</p>
      )}
      <ul className="library-system-links">
        {data?.gaps.map((gap) => (
          <li key={gap.key}>
            <strong>{gap.title}</strong>
            <p>{gap.detail}</p>
            <button
              disabled={
                busy ||
                !enabled ||
                unsaved ||
                data.runs.some(
                  (run) => run.status === "queued" || run.status === "running",
                )
              }
              onClick={() =>
                void work(() =>
                  api(`${root}/curate`, "POST", {
                    gap: {
                      title: gap.title,
                      path: gap.path,
                      detail: gap.detail,
                    },
                  }),
                )
              }
            >
              {t("knowledge.fillGap")}
            </button>
          </li>
        ))}
      </ul>
      <details className="knowledge-run-history" open={data?.runs.some(run => run.status === "queued" || run.status === "running")}>
      <summary>{t("knowledge.recentRuns")}</summary>
      <ul className="library-system-links">
        {data?.runs
          .filter((r) => r.status !== "done")
          .map((run) => {
            let detail: {
              notes?: string;
              error?: string;
              skipped?: { id: string; reason: string }[];
            } = {};
            try {
              detail = JSON.parse(run.detail);
            } catch {
              /* empty legacy detail */
            }
            return (
              <li key={run.id}>
                <strong>
                  {t(
                    statusKeys[run.status as keyof typeof statusKeys] ||
                      "knowledge.status.review",
                  )}
                </strong>
                <small>{new Date(run.created_at).toLocaleString()}</small>
                {["queued", "running"].includes(run.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void work(() =>
                        api(`${root}/runs/${run.id}/cancel`, "POST"),
                      )
                    }
                  >
                    {t("knowledge.cancelRun")}
                  </button>
                )}
                {detail.error && (
                  <p className="knowledge-run-error" role="status">
                    {detail.error}
                  </p>
                )}
                {detail.notes && <p>{detail.notes}</p>}
                {!!detail.skipped?.length && (
                  <details>
                    <summary>
                      {t("knowledge.skipped", { count: detail.skipped.length })}
                    </summary>
                    {detail.skipped.map((item, index) => (
                      <p key={`${item.id}-${index}`}>
                        {data.sourceLabels[item.id] ||
                          t("knowledge.sourceGuide")}{" "}
                        ·{" "}
                        {t(
                          skipKeys[item.reason as keyof typeof skipKeys] ||
                            "knowledge.skip.unavailable",
                        )}
                      </p>
                    ))}
                  </details>
                )}
              </li>
            );
          })}
      </ul>
      </details>
      {!!data?.reviews.length && (
        <>
          <h3>{t("knowledge.sourceReviews")}</h3>
          <p>{t("knowledge.sourceReviewsHint")}</p>
          <ul>
            {data.reviews.map((review) => (
              <li key={review.id}>
                {review.title}{" "}
                <button
                  disabled={busy}
                  onClick={() =>
                    void work(() =>
                      api(`${root}/entries/${review.id}/review`, "POST", {
                        expectedRevision: review.revision,
                        action: "keep",
                      }),
                    )
                  }
                >
                  {t("knowledge.keep")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {view === "entries" && (
        <>
          <h3>{t("knowledge.entries")}</h3>
          {!data?.entries.length && (
            <p className="knowledge-empty">{t("knowledge.entriesEmpty")}</p>
          )}
          <KnowledgeTree
            entries={data?.entries ?? []}
            render={(item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                {item.reviewState.conflict && item.status === "draft" && (
                  <p>{t("knowledge.conflictPending")}</p>
                )}
                <small>
                  {t(originKeys[item.origin as keyof typeof originKeys])} ·{" "}
                  {t(statusKeys[item.status as keyof typeof statusKeys])}
                </small>
                <details>
                  <summary>{t("knowledge.read")}</summary>
                  {item.reviewState.conflict && item.reviewState.replaces && (
                    <section>
                      <h4>{t("knowledge.currentVersion")}</h4>
                      <Preview
                        value={
                          data?.entries.find(
                            (e) => e.id === item.reviewState.replaces,
                          )?.markdown ?? ""
                        }
                      />
                      <h4>{t("knowledge.proposedVersion")}</h4>
                    </section>
                  )}
                  <Preview value={item.markdown} />
                  {item.reviewState.reason && <p>{item.reviewState.reason}</p>}
                </details>
                <div className="library-system-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      setEntry({
                        id: item.id,
                        path: item.path,
                        expectedRevision: item.revision,
                        title: item.title,
                        markdown: item.markdown,
                      })
                    }
                  >
                    {t("knowledge.edit")}
                  </button>
                  {item.status === "draft" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void work(() =>
                          api(`${root}/entries/${item.id}/review`, "POST", {
                            expectedRevision: item.revision,
                            action: "publish",
                          }),
                        )
                      }
                    >
                      {t("knowledge.publish")}
                    </button>
                  )}
                  <button disabled={busy} onClick={() => setDeleteId(item.id)}>
                    {t("knowledge.delete")}
                  </button>
                </div>
                {deleteId === item.id && (
                  <div className="knowledge-confirm">
                    <p>{t("knowledge.deleteConfirm")}</p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          await api(
                            `${root}/entries/${item.id}/review`,
                            "POST",
                            {
                              expectedRevision: item.revision,
                              action: "delete",
                            },
                          );
                          setDeleteId("");
                        })
                      }
                    >
                      {t("knowledge.delete")}
                    </button>
                    <button onClick={() => setDeleteId("")}>
                      {t("knowledge.cancel")}
                    </button>
                  </div>
                )}
              </li>
            )}
          />
          {!!data?.humanChanges.length && (
            <details>
              <summary>
                {t("knowledge.humanSources", {
                  count: data.humanChanges.length,
                })}
              </summary>
              <ul>
                {data.humanChanges.map((change) => (
                  <li key={change.id}>
                    <strong>{change.title}</strong>
                    <small>{change.createdAt}</small>
                    <pre>
                      {change.change.removed
                        ? `− ${change.change.removed}\n`
                        : ""}
                      + {change.change.inserted}
                    </pre>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <h4>{t(entry.id ? "knowledge.edit" : "knowledge.addHuman")}</h4>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void work(async () => {
                await api(`${root}/entries`, "POST", entry);
                setEntry({ title: "", markdown: "", expectedRevision: 0 });
              });
            }}
          >
            <input
              required
              value={entry.title}
              aria-label={t("knowledge.title")}
              placeholder={t("knowledge.title")}
              onChange={(e) => setEntry({ ...entry, title: e.target.value })}
            />
            <label>
              {t("knowledge.entryPath")}
              <input
                value={(entry.path ?? []).join(" / ")}
                placeholder={t("knowledge.entryPathHint")}
                onChange={(event) =>
                  setEntry({
                    ...entry,
                    path: event.target.value
                      .split("/")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <textarea
              required
              rows={8}
              aria-label={t("knowledge.content")}
              value={entry.markdown}
              onChange={(e) => setEntry({ ...entry, markdown: e.target.value })}
            />
            <button disabled={busy}>{t("knowledge.saveDraft")}</button>
            {entry.id && (
              <button
                type="button"
                onClick={() =>
                  setEntry({ title: "", markdown: "", expectedRevision: 0 })
                }
              >
                {t("knowledge.cancel")}
              </button>
            )}
          </form>
        </>
      )}
    </section>
  );
}

function KnowledgeTree({
  entries,
  render,
  depth = 0,
}: {
  entries: Entry[];
  render: (entry: Entry) => ReactNode;
  depth?: number;
}) {
  const groups = new Map<string, Entry[]>();
  const leaves: Entry[] = [];
  for (const entry of entries) {
    const segment = entry.path?.[depth];
    if (!segment) leaves.push(entry);
    else groups.set(segment, [...(groups.get(segment) ?? []), entry]);
  }
  return (
    <ul className="library-system-links knowledge-tree">
      {[...groups].map(([title, grouped]) => (
        <li key={title}>
          <details open>
            <summary>{title}</summary>
            <KnowledgeTree
              entries={grouped}
              render={render}
              depth={depth + 1}
            />
          </details>
        </li>
      ))}
      {leaves.map(render)}
    </ul>
  );
}
