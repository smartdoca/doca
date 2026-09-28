import { htmlLang, type Locale } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import type { MessageKey, MessageValues } from "@doca/i18n";
import { Feedback } from "@web/shared/components/feedback.js";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
const VersionPreview = lazy(() => import("@web/features/documents/version-preview.js"));
const MarkdownPreview = lazy(() => import("@web/features/documents/markdown-preview.js"));
const SurfacePreview = lazy(() => import("@web/features/documents/surface-preview.js"));
import {
  Flag,
  Sparkles,
  MoreHorizontal,
  Maximize,
  Info,
  History,
  FolderInput,
  Trash2,
  Upload,
  ArrowLeft,
  ArrowRightLeft,
} from "lucide-react";
import {
  importFormats,
  type ImportProgress,
} from "@web/features/documents/file-transfer.js";
import { api, roleRank, type Detail, type Resource } from "@web/shared/api.js";
import { pageWidthLabel } from "@web/features/documents/document-page-width.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { FileIcon } from "@web/features/documents/document-controls.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { FileSourceDialog, FolderFilePicker } from "@web/features/files/files.js";
import { fileUrl, type FileItem } from "@web/shared/api.js";
export function relativeTime(
  value: string | null,
  now = Date.now(),
  t?: (key: MessageKey, values?: MessageValues) => string,
  locale: Locale = "zh",
) {
  const say = (key: MessageKey, fallback: string, values?: MessageValues) =>
    t ? t(key, values) : fallback;
  if (!value) return say("time.none", "暂无编辑记录");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return say("time.unknown", "时间未知");
  const delta = Math.max(0, now - time);
  if (delta < 60000) return say("time.justNow", "刚刚");
  if (delta < 3600000)
    return say("time.minutes", `${Math.floor(delta / 60000)} 分钟前`, {
      count: Math.floor(delta / 60000),
    });
  if (delta < 86400000)
    return say("time.hours", `${Math.floor(delta / 3600000)} 小时前`, {
      count: Math.floor(delta / 3600000),
    });
  return new Date(time).toLocaleDateString(htmlLang(locale));
}
export function LastEdited({
  detail,
  currentUserId,
}: {
  detail: Detail;
  currentUserId?: string;
}) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const canReadHistory =
    roleRank(detail.resource.role) >= 3 || !!detail.resource.history_readers;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <button
        className="last-editor"
        disabled={!canReadHistory}
        onClick={() => setOpen(true)}
        aria-label={t("doc.viewHistory")}
        title={
          detail.lastEditedAt
            ? t("time.editedBy", {
                name: detail.lastEditorName ?? t("time.unknownUser"),
                when: new Date(detail.lastEditedAt).toLocaleString(htmlLang(locale)),
              })
            : t("time.noEditor")
        }
      >
        <History size={14} aria-hidden="true" />
        <span>
          {detail.lastEditorName ? (
            <>
              {currentUserId && detail.resource.last_editor_id === currentUserId
                ? t("time.me")
                : detail.lastEditorName}{" "}
              {t("time.line", { when: relativeTime(detail.lastEditedAt, now, t, locale) })}
            </>
          ) : (
            t("time.none")
          )}
        </span>
      </button>
      {open && canReadHistory && (
        <DocumentRecords
          detail={detail}
          initial="history"
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function useDismissMenus() {
  useEffect(() => {
    const dismiss = (e: Event) => {
      for (const menu of Array.from(
        document.querySelectorAll<HTMLDetailsElement>("details.menu[open]"),
      ))
        if (!menu.contains(e.target as Node)) menu.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        for (const menu of Array.from(
          document.querySelectorAll<HTMLDetailsElement>("details.menu[open]"),
        ))
          menu.open = false;
    };
    const action = (e: MouseEvent) => {
      const button = (e.target as Element).closest("button,a");
      if (button) {
        const menu = button.closest<HTMLDetailsElement>("details.menu");
        if (menu && !button.closest("summary")) menu.open = false;
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape);
    document.addEventListener("click", action);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("click", action);
    };
  }, []);
}
const createTypeKey = {
  rich_text: "shell.type.rich",
  spreadsheet: "shell.type.sheet",
  markdown: "shell.type.markdown",
  canvas: "shell.type.canvas",
  presentation: "shell.type.slides",
} as const satisfies Record<Resource["format"], MessageKey>;
const importDescKey = {
  rich_text: "import.document.desc",
  spreadsheet: "import.sheet.desc",
  markdown: "import.markdown.desc",
  canvas: "import.canvas.desc",
  presentation: "import.presentation.desc",
} as const satisfies Record<keyof typeof importFormats, MessageKey>;
export function CreatePopover({
  rect,
  close,
  choose,
  busy,
  progress,
}: {
  rect: DOMRect;
  close: () => void;
  choose: (format: Resource["format"], file?: File) => void;
  busy: boolean;
  progress?: ImportProgress | null;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const place = () => {
      const { width, height } = panel.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const top =
        height > below && above > below
          ? rect.top - height - 6
          : rect.bottom + 6;
      const next = {
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      };
      setPosition((old) =>
        old?.left === next.left && old?.top === next.top ? old : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [rect]);
  const [importing, setImporting] = useState(false);
  const [target, setTarget] = useState<keyof typeof importFormats | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [folderPicker, setFolderPicker] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const fn = (e: Event) => {
      if (!busy && !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".file-source-backdrop,.folder-file-picker-backdrop")) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (!busy && e.key === "Escape") close();
    };
    const scroll = (e: Event) => {
      if (!busy && !ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", fn);
    document.addEventListener("keydown", esc);
    ref.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointerdown", fn);
      document.removeEventListener("keydown", esc);
    };
  }, [busy]);
  return createPortal(
    <div
      ref={ref}
      className="create-popover"
      role="dialog"
      aria-label={t("create.chooseType")}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {importing && (
        <button
          disabled={busy}
          onClick={() => (target ? setTarget(null) : setImporting(false))}
        >
          <ArrowLeft size={16} />
          {target
            ? t("create.importAs", { name: t(createTypeKey[target]) })
            : t("create.chooseTarget")}
        </button>
      )}
      {target ? (
        <div className="import-file-panel">
          <p>{t(importDescKey[target])}</p>
          <small>
            {target === "markdown"
              ? t("create.markdownLimit")
              : target === "rich_text"
                ? t("create.documentLimit")
                : t("create.fileLimit")}{" "}
            {t("create.newOnly")}
          </small>
          {busy && progress && (
            <div className="import-progress" role="status" aria-live="polite">
              <div className="import-progress-line">
                <span>{progress.message}</span>
                {progress.percent != null && <strong>{progress.percent}%</strong>}
              </div>
              <div
                className="import-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
                aria-label={progress.message}
              >
                <span
                  style={{
                    width: `${progress.percent ?? 18}%`,
                  }}
                />
              </div>
            </div>
          )}
          {!busy && (
            <button className="markdown-import-choice" onClick={() => setSourceOpen(true)}>
              <Upload size={18} />
              {t("create.chooseFile")}
              <input
                ref={importInput}
                hidden
                aria-label={t("create.importFile", {
                  name: t(createTypeKey[target]),
                })}
                type="file"
                accept={importFormats[target].accept}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) choose(target, file);
                }}
              />
            </button>
          )}
        </div>
      ) : (
        (
          (["rich_text", "spreadsheet", "markdown", "canvas", "presentation"] as const)
          .map((format) => (
            <button
              key={format}
              disabled={busy}
              onClick={() => (importing ? setTarget(format) : choose(format))}
            >
              <FileIcon r={{ kind: "document", format }} />
              <span>
                {importing
                  ? t("create.importAs", { name: t(createTypeKey[format]) })
                  : t(createTypeKey[format])}
              </span>
            </button>
          ))
        )
      )}
      {!importing && (
        <button
          disabled={busy}
          onClick={() => setImporting(true)}
        >
          <span className="file-glyph" aria-hidden="true">
            <Upload size={19} />
          </span>
          {t("create.import")}
        </button>
      )}
      {sourceOpen && <FileSourceDialog title={t("create.importAs", { name: t(createTypeKey[target!]) })} close={() => setSourceOpen(false)} chooseLocal={() => importInput.current?.click()} chooseDoca={() => setFolderPicker(true)} />}
      {folderPicker && <FolderFilePicker close={() => setFolderPicker(false)} select={async (item: FileItem) => { const response = await fetch(fileUrl(item.id)); if (!response.ok) throw new Error(t("create.readFailed")); choose(target!, new File([await response.blob()], item.name, { type: item.mime })); }} />}
    </div>,
    document.body,
  );
}
type People = {
  items: { id: string; display_name: string }[];
  total: number | null;
  nextCursor?: string | null;
};
export function LikePeople({ detail }: { detail: Detail }) {
  const { t } = useI18n();
  const [page, setPage] = useState<People>({
      items: [],
      total: 0,
      nextCursor: null,
    }),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    api<People>(
      `/resources/${detail.resource.id}/likes`,
      "GET",
      undefined,
      c.signal,
    )
      .then(setPage)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [detail.resource.id, detail.likes]);
  return (
    <>
      <button
        className="like-people"
        aria-label={t("doc.likePeopleAll", { count: page.total ?? page.items.length })}
        onClick={() => setOpen(true)}
        disabled={page.total === 0}
      >
        {page.items.slice(0, 8).map((u) => (
          <UserBadge key={u.id} id={u.id} name={u.display_name} avatarOnly />
        ))}
        {(page.total ?? page.items.length) > 8 && <span className="avatar-more">…</span>}
      </button>
      {open && (
        <Dialog title={t("doc.likePeople", { count: page.total ?? page.items.length })} close={() => setOpen(false)}>
          <div className="people-list">
            {page.items.map((u) => (
              <UserBadge key={u.id} id={u.id} name={u.display_name} />
            ))}
          </div>
          {page.nextCursor != null && (
            <button
              onClick={() =>
                void api<People>(
                  `/resources/${detail.resource.id}/likes?cursor=${encodeURIComponent(page.nextCursor!)}`,
                )
                  .then((p) =>
                    setPage((old) => ({
                      ...p,
                      total: p.total ?? old.total,
                      items: [...old.items, ...p.items],
                    })),
                  )
                  .catch((e) => setError(e.message))
              }
            >
              {t("common.more")}
            </button>
          )}
          {error && <Feedback message={error} tone="error" />}
        </Dialog>
      )}
    </>
  );
}
export function DocumentMore({
  detail,
  move,
  transfer,
  remove,
  entryChanged,
}: {
  detail: Detail;
  move: () => void;
  transfer: () => void;
  remove: () => void;
  entryChanged?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [panel, setPanel] = useState(""),
    [error, setError] = useState("");
  const r = detail.resource;
  return (
    <>
      <details className="menu">
        <summary aria-label={t("doc.more")}>
          <MoreHorizontal size={20} />
        </summary>
        <div className="document-more-menu">
          {r.format === "rich_text" && <div id="document-page-width-slot" />}
          <button
            onClick={() => {
              const workspace =
                document.querySelector<HTMLElement>(".app-shell > .workspace");
              if (!workspace?.requestFullscreen) {
                setError(t("doc.fullscreenUnsupported"));
                return;
              }
              void workspace
                .requestFullscreen()
                .then(() => {
                  if (r.format === "presentation")
                    window.dispatchEvent(
                      new CustomEvent("doca:presentation", { detail: r.id }),
                    );
                })
                .catch(() => setError(t("doc.fullscreenUnsupported")));
            }}
          >
            <Maximize size={16} />
            {t("doc.present")}
          </button>
          {r.kind === "document" && <div id="document-export-slot" />}
          <button onClick={() => setPanel("stats")}>
            <Info size={16} />
            {t("doc.info")}
          </button>
          {r.kind === "document" &&
            (roleRank(r.role) >= 3 || r.history_readers) && (
              <button onClick={() => setPanel("history")}>
                <History size={16} />
                {t("doc.history")}
              </button>
            )}
          {roleRank(r.role) >= 4 && (
            <>
              {(r.library_id ? roleRank(r.role) >= 4 : r.role === "owner") && (
                <button onClick={move}>
                <FolderInput size={16} />
                {t("doc.move")}
                </button>
              )}
              {r.role === "owner" && (
                <button onClick={transfer}>
                  <ArrowRightLeft size={16} />
                  {t("doc.transfer")}
                </button>
              )}
              <button
                className="danger"
                disabled={!(r.can_remove ?? r.role === "owner")}
                onClick={remove}
              >
                <Trash2 size={16} />
                {t("common.delete")}
              </button>
            </>
          )}
        </div>
      </details>
      <span id="document-live-info" className="document-live-hidden" />
      {panel && (
        <DocumentRecords
          key={r.id + panel}
          detail={detail}
          initial={panel}
          close={() => setPanel("")}
        />
      )}
      {error && (
        <Dialog
          title={t("doc.present")}
          close={() => setError("")}
          className="modal-compact"
        >
          <p>{error}</p>
        </Dialog>
      )}
    </>
  );
}
function DocumentRecords({
  detail,
  initial,
  close,
}: {
  detail: Detail;
  initial: string;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState(initial),
    [data, setData] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  const id = detail.resource.id;
  const path =
    tab === "history"
      ? `/resources/${id}/versions`
      : `/resources/${id}/info?tab=${tab}`;
  useEffect(() => {
    setData(null);
    setPreview(null);
    setError("");
    const c = new AbortController();
    api(path, "GET", undefined, c.signal)
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [path, reload]);
  const tabs: [string, MessageKey][] =
    initial === "history"
      ? [["history", "record.snapshot"]]
      : [
          ["stats", "record.stats"],
          ...(roleRank(detail.resource.role) >= 4
            ? ([
                ["visits", "record.visits"],
                ["audit", "record.audit"],
              ] as [string, MessageKey][])
            : []),
        ];
  return (
    <Dialog
      title={initial === "history" ? t("doc.history") : t("doc.info")}
      close={close}
    >
      <div className="document-records">
        <nav aria-label={t("record.tabs")}>
          {tabs.map(([k, v]) => (
            <button
              key={k}
              className={tab === k ? "active" : ""}
              onClick={() => setTab(k)}
            >
              {t(v)}
            </button>
          ))}
        </nav>
        <section>
          {error && <Feedback message={error} tone="error" />}
          {!data && !error && <p>{t("common.loading")}</p>}
          {tab === "stats" && data && (
            <>
              <h3>{data.title}</h3>
              <div className="document-stat-grid">
                {(
                  [
                    ["record.words", data.words ?? 0],
                    ["record.images", data.images ?? 0],
                    ["record.attachments", data.attachments ?? 0],
                    ["record.visitCount", data.visits],
                    ["record.likes", data.likes],
                    ["record.favorites", data.favorites],
                    ["record.comments", data.comments],
                  ] as [MessageKey, number][]
                ).map(([label, value]) => (
                  <div key={label}>
                    <strong>{value}</strong>
                    <span>{t(label)}</span>
                  </div>
                ))}
              </div>
              <p>{t("record.created", { time: new Date(data.createdAt).toLocaleString(htmlLang(locale)) })}</p>
              <p>{t("record.updated", { time: new Date(data.updatedAt).toLocaleString(htmlLang(locale)) })}</p>
              {detail.resource.format === "rich_text" && (
                <p>{t("doc.width")} {pageWidthLabel(data.pageWidth, t)}</p>
              )}
            </>
          )}
          {tab === "history" && (
            <>
              <p className="subtle">{t("record.snapshotHint")}</p>
              {roleRank(detail.resource.role) >= 3 &&
                (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void api(`/resources/${id}/versions`, "POST")
                        .then(() => setReload((n) => n + 1))
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {t("record.saveSnapshot")}
                  </button>
                )}
            </>
          )}
          {data?.items?.map((row: any) => (
            <article className="record-row" key={row.id}>
              <UserBadge
                id={row.userId ?? row.author_id}
                name={row.name ?? row.display_name}
              />
              {row.is_ai && (
                <span title={t("record.aiEdited")} className="ai-history-origin">
                  <Sparkles size={13} /> AI
                </span>
              )}
              <span>
                {tab === "history"
                  ? row.title
                  : tab === "visits"
                    ? t("record.visitedDoc")
                    : eventLabel(row.action, t)}
              </span>
              <time>{relativeTime(row.created_at, Date.now(), t)}</time>
              {tab === "history" && (
                <button
                  onClick={() =>
                    void api(`/resources/${id}/versions/${row.id}`)
                      .then(setPreview)
                      .catch((e) => setError(e.message))
                  }
                >
                  {t("record.view")}
                </button>
              )}
            </article>
          ))}
          {data?.items?.length === 0 && <p className="empty">{t("record.empty")}</p>}
          {data?.nextCursor != null && (
            <button
              onClick={() =>
                void api<any>(
                  path +
                    (path.includes("?") ? "&" : "?") +
                    "cursor=" + encodeURIComponent(data.nextCursor),
                )
                  .then((p) =>
                    setData((old: any) => ({
                      ...p,
                      items: [...old.items, ...p.items],
                    })),
                  )
                  .catch((e) => setError(e.message))
              }
            >
              {t("common.more")}
            </button>
          )}
          {preview && (
            <Dialog
              title={preview.title || t("record.snapshotTitle")}
              close={() => setPreview(null)}
              className="version-preview-dialog"
            >
              <p>
                {new Date(preview.createdAt).toLocaleString(htmlLang(locale))} · {t("record.readonly")}
              </p>
              <p className="subtle">
                {preview.canRestore === false
                  ? t("record.rollbackLimited")
                  : t("record.rollbackHint")}
              </p>
              {error && <Feedback message={error} tone="error" />}
              <div className="version-preview">
                <Suspense fallback={<pre>{preview.text}</pre>}>
                  {preview.surface ? (
                    <SurfacePreview id={id} surface={preview.surface} />
                  ) : typeof preview.markdown === "string" ? (
                    <MarkdownPreview value={preview.markdown} />
                  ) : (
                    <VersionPreview key={preview.id} value={preview.value} />
                  )}
                </Suspense>
              </div>
              <footer>
                <button type="button" onClick={() => setPreview(null)}>
                  {t("record.close")}
                </button>
                {roleRank(detail.resource.role) >= 4 &&
                  preview.canRestore !== false && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setError("");
                        void api(
                          `/resources/${id}/versions/${preview.id}/restore`,
                          "POST",
                          { expectedSeq: preview.currentSeq },
                        )
                          .then(() => {
                            close();
                          })
                          .catch((e) => setError(e.message))
                          .finally(() => setBusy(false));
                      }}
                    >
                      {t("record.rollback")}
                    </button>
                  )}
              </footer>
            </Dialog>
          )}
        </section>
      </div>
    </Dialog>
  );
}
function eventLabel(
  action: string,
  t: (key: MessageKey) => string,
) {
  const known = new Set([
    "resource.created",
    "document.created",
    "library.created",
    "document.updated",
    "favorite.added",
    "favorite.removed",
    "resource.renamed",
    "resource.permissions_changed",
    "resource.moved",
    "resource.trashed",
    "resource.restored",
    "resource.link_enabled",
    "resource.link_disabled",
    "document.snapshot_created",
    "document.ai_edited",
    "document.version_restored",
    "resource.transferred",
    "comment.created",
    "comment.updated",
    "like.added",
    "like.removed",
  ]);
  return known.has(action)
    ? t(`record.event.${action}` as MessageKey)
    : action;
}
