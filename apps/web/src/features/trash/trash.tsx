import { lazy, Suspense, useEffect, useState } from "react";
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
      title={`${data?.resource.title ?? resource.title} · 回收站只读预览`}
      close={close}
    >
      <div className="trash-preview">
        <Feedback message={error} tone="error" />
        <Suspense fallback={<p className="empty">正在加载预览…</p>}>
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
                <p className="empty">暂无可预览的文档</p>
              )}
            </div>
          ) : (
            !error && (
              <p className="empty">
                {data ? "此文件还没有内容" : "正在加载预览…"}
              </p>
            )
          )}
        </Suspense>
      </div>
    </Dialog>
  );
}

export function EmptyTrash({ done }: { done: () => void }) {
  const [targets, setTargets] = useState<Resource[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const all: Resource[] = [];
      let offset: number | null = 0;
      do {
        const page: Page = await api(
          `/resources?scope=trash&sort=created_at&order=asc&offset=${offset}`,
        );
        all.push(...page.items);
        offset = page.nextOffset;
        if (all.length > 1000)
          throw Error("回收站超过一千项，暂不支持一次清空这么多内容");
      } while (offset !== null);
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
        清空回收站
      </button>
      {!targets && <Feedback message={error} tone="error" />}
      {targets && (
        <Dialog
          title="清空回收站"
          close={() => {
            if (!busy) setTargets(null);
          }}
          className="modal-compact"
        >
          <p className="warning">
            将永久删除 {targets.length}{" "}
            项内容及其历史版本、评论，无法恢复。清空范围为你有管理权限的回收站文件，不受当前筛选条件影响。
          </p>
          <div className="trash-confirm-list">
            {targets.map((r) => (
              <div key={r.id}>{r.title}</div>
            ))}
          </div>
          <Feedback message={error} tone="error" />
          <footer>
            <button disabled={busy} onClick={() => setTargets(null)}>
              取消
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
              {busy ? "正在清空…" : "永久清空"}
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}

type FileTrashItem = { id: string; kind: "folder" | "file"; name: string; version: number; deletedAt: string | null };
export function FileTrash() {
  const [items, setItems] = useState<FileTrashItem[]>([]), [error, setError] = useState("");
  async function load() {
    try {
      const data = await api<{ folders: FileTrashItem[]; files: FileTrashItem[] }>("/files/trash");
      setItems([...data.folders, ...data.files]);
    } catch (e) { setError(e instanceof Error ? e.message : "文件回收站加载失败"); }
  }
  useEffect(() => { void load(); }, []);
  async function restore(item: FileTrashItem) {
    try { await api("/files/trash/restore", "POST", { kind: item.kind, id: item.id, version: item.version }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "恢复失败"); }
  }
  async function purge(item: FileTrashItem) {
    if (!window.confirm(`永久删除“${item.name}”？此操作不可恢复。`)) return;
    try { await api("/files/trash/purge", "POST", { kind: item.kind, id: item.id }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "永久删除失败"); }
  }
  return <section className="file-trash-section"><div className="file-trash-heading"><div><h3>文件和文件夹</h3><p>文档删除时，其中的文件会随文档一起恢复或清理。</p></div><span>{items.length} 项</span></div><Feedback message={error} tone="error" />{items.length ? <div className="file-trash-list">{items.map((item) => <div key={item.kind + item.id}><span className="file-trash-icon">{item.kind === "folder" ? <Folder size={17} /> : <FileText size={17} />}</span><strong title={item.name}>{item.name}</strong><small>{item.kind === "folder" ? "文件夹" : "文件"}</small><button className="icon" onClick={() => void restore(item)} aria-label={`恢复${item.name}`}><RotateCcw size={15} /></button><button className="icon danger" onClick={() => void purge(item)} aria-label={`永久删除${item.name}`}><Trash2 size={15} /></button></div>)}</div> : <p className="file-trash-empty">文件回收站为空</p>}</section>;
}
