import { lazy, Suspense, useEffect, useState } from "react";
import { useI18n } from "@web/shared/i18n.js";
import type { EditorValue } from "slatetsx-kit-editor";
import type { WorkbookSnapshot } from "@online-office/univer-sheet";
import { FileText, Folder, RotateCcw, Trash2 } from "lucide-react";
import { api, type Page, type Resource } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
const TextPreview = lazy(() => import("@web/features/documents/version-preview.js"));
const SheetPreview = lazy(() => import("@web/features/trash/trash-sheet-preview.js"));
const MarkdownPreview = lazy(() => import("@web/features/documents/markdown-preview.js"));
const SurfacePreview = lazy(() => import("@web/features/documents/surface-preview.js"));
type Preview = {
  resource: Resource;
  value?: EditorValue;
  markdown?: string;
  surface?: import("@web/features/documents/surface-preview.js").SurfacePreviewData;
  children?: { id: string; title: string }[];
  sheet?: {
    snapshot: WorkbookSnapshot;
    checkpointId: string;
    update: string;
  } | null;
};
export function TrashPreview({
  resource,
  close,
}: {
  resource: Resource;
  close: () => void;
}) {
  const { t } = useI18n();
  const [id, setId] = useState(resource.id),
    [data, setData] = useState<Preview | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError("");
    void api<Preview>(
      `/resources/${id}/trash-preview`,
      "GET",
      undefined,
      c.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [id]);
  return (
    <Dialog
      title={t("trash.previewTitle", { title: data?.resource.title ?? resource.title })}
      close={close}
    >
      <div className="trash-preview">
        <Feedback message={error} tone="error" />
        <Suspense fallback={<p className="empty">{t("trash.loadingPreview")}</p>}>
          {data?.surface ? (
            <SurfacePreview id={id} surface={data.surface} trash />
          ) : typeof data?.markdown === "string" ? (
            <MarkdownPreview value={data.markdown} trash />
          ) : data?.value ? (
            <TextPreview key={id} value={data.value} trash />
          ) : data?.sheet ? (
            <SheetPreview key={id} id={id} sheet={data.sheet} />
          ) : data?.children ? (
            <div className="trash-library-children">
              {data.children.length ? (
                data.children.map((r) => (
                  <button key={r.id} onClick={() => setId(r.id)}>
                    <FileText size={16} />
                    {r.title}
                  </button>
                ))
              ) : (
                <p className="empty">{t("trash.noPreview")}</p>
              )}
            </div>
          ) : (
            !error && (
              <p className="empty">
                {data ? t("trash.emptyFile") : t("trash.loadingPreview")}
              </p>
            )
          )}
        </Suspense>
      </div>
    </Dialog>
  );
}

export function EmptyTrash({ done }: { done: () => void }) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<Resource[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const all: Resource[] = [];
      let cursor: string | undefined;
      do {
        const page: Page = await api(
          `/resources?scope=trash&sort=created_at&order=asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        all.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (all.length > 1000)
          throw Error(t("trash.tooMany"));
      } while (cursor);
      setTargets(all);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="danger empty-trash-button"
        disabled={busy}
        onClick={() => void prepare()}
      >
        <Trash2 size={16} />
        {t("trash.emptyAll")}
      </button>
      {!targets && <Feedback message={error} tone="error" />}
      {targets && (
        <Dialog
          title={t("trash.emptyAll")}
          close={() => {
            if (!busy) setTargets(null);
          }}
          className="modal-compact"
        >
          <p className="warning">
            {t("trash.emptyAllBody", { count: targets.length })}
          </p>
          <div className="trash-confirm-list">
            {targets.map((r) => (
              <div key={r.id}>{r.title}</div>
            ))}
          </div>
          <Feedback message={error} tone="error" />
          <footer>
            <button disabled={busy} onClick={() => setTargets(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="danger"
              disabled={busy || !targets.length}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("/trash/purge", "POST", {
                    targets: targets.map(({ id, version }) => ({
                      id,
                      version,
                    })),
                  });
                  setTargets(null);
                  done();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t("trash.emptying") : t("trash.emptyNow")}
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}

type FileTrashItem = { id: string; kind: "folder" | "file"; name: string; version: number; deletedAt: string | null };
export function FileTrash() {
  const { t } = useI18n();
  const [items, setItems] = useState<FileTrashItem[]>([]),
    [error, setError] = useState(""),
    [purgeTarget, setPurgeTarget] = useState<FileTrashItem | null>(null),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const data = await api<{ folders: FileTrashItem[]; files: FileTrashItem[] }>("/files/trash");
      setItems([...data.folders, ...data.files]);
    } catch (e) { setError(e instanceof Error ? e.message : t("trash.filesFailed")); }
  }
  useEffect(() => { void load(); }, []);
  async function restore(item: FileTrashItem) {
    try { await api("/files/trash/restore", "POST", { kind: item.kind, id: item.id, version: item.version }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : t("trash.restoreFailed")); }
  }
  async function purge(item: FileTrashItem) {
    setBusy(true);
    setError("");
    try {
      await api("/files/trash/purge", "POST", { kind: item.kind, id: item.id });
      setItems((current) => current.filter((row) => row.id !== item.id || row.kind !== item.kind));
      setPurgeTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("trash.purgeFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="file-trash-section">
      <div className="file-trash-heading">
        <div>
          <h3>{t("trash.filesTitle")}</h3>
          <p>{t("trash.filesHint")}</p>
        </div>
        <span>{t("home.itemCount", { count: items.length })}</span>
      </div>
      <Feedback message={error} tone="error" />
      {items.length ? (
        <div className="file-trash-list">
          {items.map((item) => (
            <div key={item.kind + item.id}>
              <span className="file-trash-icon">
                {item.kind === "folder" ? <Folder size={17} /> : <FileText size={17} />}
              </span>
              <strong title={item.name}>{item.name}</strong>
              <small>{item.kind === "folder" ? t("trash.folder") : t("trash.file")}</small>
              <button type="button" className="icon" onClick={() => void restore(item)} aria-label={t("trash.restoreNamed", { name: item.name })}>
                <RotateCcw size={15} />
              </button>
              <button type="button" className="icon danger" onClick={() => setPurgeTarget(item)} aria-label={t("trash.purgeNamed", { name: item.name })}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="file-trash-empty">{t("trash.filesEmpty")}</p>
      )}
      {purgeTarget && (
        <Dialog
          title={t("home.purge")}
          close={() => {
            if (!busy) setPurgeTarget(null);
          }}
          className="modal-compact"
        >
          <p className="warning">{t("trash.purgeFile", { name: purgeTarget.name })}</p>
          <footer>
            <button type="button" disabled={busy} onClick={() => setPurgeTarget(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void purge(purgeTarget)}>
              {busy ? t("home.purging") : t("home.purge")}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
