import type { UploadContext } from "slatetsx-kit-editor";
import { useEffect, useRef, useState } from "react";
import {
  Feather,
  LockKeyhole,
  Search,
  Trash2,
  RotateCcw,
  Sparkles,
  Paperclip,
  X,
  Pencil,
  RefreshCw,
  SquareCheck,
} from "lucide-react";
import { api, assetUrl, uploadFile } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { QuickNoteBody, QuickNoteEditor } from "@web/features/quick-notes/quick-note-editor.js";
import { useAI } from "@web/features/ai/ai-context.js";
import {
  blankNote,
  noteBodySchema,
  noteText,
  noteHasText,
  inlineNoteAssets,
  type NoteAsset,
  type NoteContent,
  type QuickNote,
} from "@core/shared/quick-notes.js";
import "@web/features/quick-notes/quick-notes.css";

const base = "/quick-notes";
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";
const stamp = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const collapsible = (n: QuickNote) =>
  noteText(n.content).length > 180 ||
  noteText(n.content).split("\n").length > 7 ||
  n.assets.length > 2;
type Draft = {
  id: string;
  content: NoteContent;
  assets: NoteAsset[];
  version?: number;
};
function loadDraft(key: string, note?: QuickNote): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      /^[a-f0-9-]{36}$/.test(value.id) &&
      (!note || value.id === note.id) &&
      Array.isArray(value.assets) &&
      noteBodySchema.safeParse({
        content: value.content,
        assetIds: value.assets.map((a: NoteAsset) => a.id),
      }).success
    )
      return value;
  } catch {}
  return {
    id: note?.id ?? crypto.randomUUID(),
    content: note ? structuredClone(note.content) : blankNote(),
    assets: note?.assets ?? [],
    version: note?.version,
  };
}
const fingerprint = (d: Pick<Draft, "content" | "assets">) =>
  JSON.stringify({ content: d.content, assets: d.assets.map((a) => a.id) });

const hasContent = (d: Draft) => d.assets.length > 0 || noteHasText(d.content);
const outsideAssets = (content: NoteContent, assets: NoteAsset[]) =>
  assets.filter((a) => !inlineNoteAssets(content).includes(a.id));

function NoteAssets({
  assets,
  remove,
}: {
  assets: NoteAsset[];
  remove?: (id: string) => void;
}) {
  if (!assets.length) return null;
  return (
    <div className="note-assets">
      {assets.map((a) => (
        <div
          key={a.id}
          className={a.mime.startsWith("image/") ? "note-image" : "note-file"}
        >
          {a.mime.startsWith("image/") ? (
            <a
              href={assetUrl(a.id)}
              target="_blank"
              rel="noreferrer"
              aria-label={`查看图片 ${a.filename}`}
            >
              <img loading="lazy" src={assetUrl(a.id)} alt={a.filename} />
            </a>
          ) : (
            <a href={assetUrl(a.id) + "?download=1"}>
              <Paperclip size={16} />
              <span>
                {a.filename}
                <small>
                  {a.size < 1024 * 1024
                    ? `${Math.ceil(a.size / 1024)} KB`
                    : `${(a.size / 1024 / 1024).toFixed(1)} MB`}
                </small>
              </span>
            </a>
          )}
          {remove && (
            <button
              type="button"
              aria-label={`移除 ${a.filename}`}
              onClick={() => remove(a.id)}
            >
              <X size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function NoteForm({
  userId,
  note,
  saved,
  close,
}: {
  userId: string;
  note?: QuickNote;
  saved: (note: QuickNote) => void;
  close?: () => void;
}) {
  const cacheKey = `doca.quick-note.${userId}.${note?.id ?? "new"}`;
  const [draft, setDraft] = useState(() => loadDraft(cacheKey, note));
  const current = useRef(draft),
    version = useRef(draft.version);
  const acknowledged = useRef(note ? fingerprint(note) : "");
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState(
      !!note && draft.version !== note.version,
    ),
    [remote, setRemote] = useState<QuickNote | null>(null);
  const [editorKey, setEditorKey] = useState(0),
    [saveState, setSaveState] = useState(
      note ? "修改会自动保存" : "草稿保存在此浏览器",
    );
  const busy = useRef(false),
    alive = useRef(true),
    conflictRef = useRef(conflict),
    uploadingRef = useRef(false);
  const pendingUploads = useRef(0);
  const knownAssets = useRef(new Map(draft.assets.map((a) => [a.id, a])));
  const savedCallback = useRef(saved);
  savedCallback.current = saved;
  const persist = (next: Draft) => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(next));
    } catch {
      if (alive.current)
        setError("浏览器无法保存恢复草稿，请保持页面打开并及时保存到云端");
    }
  };
  const update = (patch: Partial<Draft>) => {
    if (!conflictRef.current) setError("");
    const next = { ...current.current, ...patch, version: version.current };
    current.current = next;
    setDraft(next);
    persist(next);
    setSaveState(note ? "尚未保存" : "草稿保存在此浏览器");
  };
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  saveRef.current = async () => {
    if (busy.current || uploadingRef.current || conflictRef.current)
      return false;
    if (!hasContent(current.current)) return false;
    const sent = structuredClone(current.current),
      signature = fingerprint(sent);
    if (note && signature === acknowledged.current) return true;
    busy.current = true;
    let committed = false;
    if (alive.current) {
      setSaving(true);
      setError("");
      setSaveState("正在保存…");
    }
    try {
      const result = await api<QuickNote>(
        base + "/" + sent.id,
        version.current ? "PATCH" : "PUT",
        {
          content: sent.content,
          assetIds: sent.assets.map((a) => a.id),
          ...(version.current ? { version: version.current } : {}),
        },
      );
      version.current = result.version;
      current.current.version = result.version;
      acknowledged.current = signature;
      committed = true;
      if (fingerprint(current.current) === signature) {
        try {
          localStorage.removeItem(cacheKey);
        } catch {}
      } else persist(current.current);
      savedCallback.current(result);
      if (alive.current) setSaveState("已保存到云端");
      return fingerprint(current.current) === signature;
    } catch (e) {
      persist(current.current);
      if (alive.current) {
        setError(errorText(e));
        setSaveState("未保存，草稿已保留");
        if ((e as { status?: number }).status === 409) {
          conflictRef.current = true;
          setConflict(true);
        }
      }
      return false;
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
      else if (
        committed &&
        note &&
        fingerprint(current.current) !== acknowledged.current
      )
        void saveRef.current();
    }
  };
  useEffect(() => {
    if (
      !note ||
      conflict ||
      uploading ||
      saving ||
      error ||
      fingerprint(draft) === acknowledged.current
    )
      return;
    const timer = setTimeout(() => {
      void saveRef.current();
    }, 900);
    return () => clearTimeout(timer);
  }, [draft, note, conflict, uploading, saving, error]);
  useEffect(() => {
    alive.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (
        busy.current ||
        uploadingRef.current ||
        (note && fingerprint(current.current) !== acknowledged.current)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      alive.current = false;

      window.removeEventListener("beforeunload", warn);
      if (note) void saveRef.current();
    };
  }, []);
  async function upload(file: File, context: UploadContext) {
    if (current.current.assets.length + pendingUploads.current >= 12)
      throw Error("每条随手记最多 12 个图片或附件");
    pendingUploads.current++;
    uploadingRef.current = true;
    setUploading(true);
    try {
      const asset = await uploadFile(
        file,
        "note_attachment",
        undefined,
        context.signal,
      );
      if (!alive.current || context.signal.aborted)
        throw new DOMException("Upload cancelled", "AbortError");
      knownAssets.current.set(asset.id, asset);
      context.onProgress(1);
      return {
        path: asset.id,
        name: asset.filename,
        size: asset.size,
        mimeType: asset.mime,
      };
    } finally {
      pendingUploads.current--;
    }
  }
  const submit = async () => {
    if (await saveRef.current()) close?.();
  };
  return (
    <div className="note-form">
      <div className="note-writing-surface">
        <QuickNoteEditor
          key={editorKey}
          initial={draft.content}
          autoFocus={!!note}
          onChange={(content) => {
            const before = inlineNoteAssets(current.current.content),
              after = inlineNoteAssets(content);
            const assets = current.current.assets.filter(
              (a) => !before.includes(a.id) || after.includes(a.id),
            );
            for (const id of after) {
              const asset = knownAssets.current.get(id);
              if (asset && !assets.some((a) => a.id === id)) assets.push(asset);
            }
            update({ content, assets });
          }}
          upload={upload}
          onUploading={(pending) => {
            uploadingRef.current = pending;
            if (alive.current) setUploading(pending);
          }}
          submit={() => void submit()}
          disabled={!note && saving}
        />
        <NoteAssets
          assets={outsideAssets(draft.content, draft.assets)}
          remove={
            saving || uploading
              ? undefined
              : (id) =>
                  update({
                    assets: current.current.assets.filter((a) => a.id !== id),
                  })
          }
        />
      </div>
      {uploading && (
        <p className="note-status" role="status">
          正在上传，请稍候…
        </p>
      )}
      {conflict && (
        <div className="note-conflict">
          <p>这条记录已有较新版本。本地内容已保留，请查看最新版本后合并。</p>
          <button
            onClick={async () => {
              try {
                setRemote(await api<QuickNote>(base + "/" + draft.id));
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            查看最新版本
          </button>
          {remote && (
            <>
              <div className="note-remote">
                <QuickNoteBody content={remote.content} />
                <NoteAssets
                  assets={outsideAssets(remote.content, remote.assets)}
                />
              </div>
              <p>可以在上方编辑区合并内容，确认后用合并结果更新云端。</p>
              <button
                disabled={!!remote.deleted_at}
                onClick={() => {
                  version.current = remote.version;
                  conflictRef.current = false;
                  setConflict(false);
                  update({});
                  setError("");
                  void saveRef.current();
                }}
              >
                保存合并后的内容
              </button>
              <button
                onClick={() => {
                  version.current = remote.version;
                  acknowledged.current = fingerprint(remote);
                  current.current = { ...remote };
                  remote.assets.forEach((a) =>
                    knownAssets.current.set(a.id, a),
                  );
                  setDraft(current.current);
                  savedCallback.current(remote);
                  try {
                    localStorage.removeItem(cacheKey);
                  } catch {}
                  setEditorKey((v) => v + 1);
                  conflictRef.current = false;
                  setConflict(false);
                  setRemote(null);
                  setError("");
                }}
              >
                使用云端版本
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="note-error" role="alert">
          {error}
        </p>
      )}
      <div className="note-form-footer">
        <span className="note-status" role="status">
          {note || error || saving ? saveState : "⌘ Enter 记下"}
        </span>
        <div>
          {close && (error || conflict) && (
            <button onClick={close}>收起并保留草稿</button>
          )}
          <button
            className="primary"
            disabled={saving || uploading || conflict || !hasContent(draft)}
            onClick={() => void submit()}
          >
            {saving ? "正在保存…" : note ? "完成" : "记下"}
            <span className="note-shortcut" aria-hidden="true">
              ⌘ ↵
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function QuickNotes({
  userId,
}: {
  userId: string;
  changed: () => void;
}) {
  const ai = useAI();
  const [items, setItems] = useState<QuickNote[]>([]),
    [next, setNext] = useState<number | null>(null);
  const [query, setQuery] = useState(""),
    [trash, setTrash] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [newKey, setNewKey] = useState(0);
  const [selected, setSelected] = useState<string[]>([]),
    [editing, setEditing] = useState<string | null>(null),
    [expanded, setExpanded] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<QuickNote[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deletingRef = useRef(false);
  const [mutating, setMutating] = useState<string | null>(null);
  const generation = useRef(0);
  const url = (offset = 0) =>
    base +
    "?" +
    new URLSearchParams({
      q: query,
      trash: trash ? "1" : "0",
      offset: String(offset),
    });
  useEffect(() => {
    generation.current++;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSelected([]);
    setBatchMode(false);
    setEditing(null);
    const timer = setTimeout(() => {
      void api<{ items: QuickNote[]; nextOffset: number | null }>(
        url(),
        "GET",
        undefined,
        controller.signal,
      )
        .then((p) => {
          setItems(p.items);
          setNext(p.nextOffset);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(errorText(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, trash, refresh]);
  const updateSaved = (note: QuickNote) =>
    setItems((rows) => rows.map((n) => (n.id === note.id ? note : n)));
  async function restoreNote(note: QuickNote) {
    setMutating(note.id);
    setError("");
    try {
      await api(base + "/" + note.id + "/trash", "POST", {
        version: note.version,
        deleted: false,
      });
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMutating(null);
    }
  }
  function askDelete(notes: QuickNote[]) {
    if (!notes.length) return;
    setDeleteError("");
    setDeleteTargets(notes);
  }
  async function confirmDelete() {
    if (!deleteTargets?.length || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError("");
    const removed = new Set<string>(),
      failed: QuickNote[] = [];
    let reason = "";
    try {
      for (const note of deleteTargets) {
        try {
          await api(base + "/" + note.id + "/trash", "POST", {
            version: note.version,
            deleted: true,
          });
          removed.add(note.id);
        } catch (e) {
          failed.push(note);
          reason ||= errorText(e);
        }
      }
      setItems((rows) => rows.filter((n) => !removed.has(n.id)));
      setSelected((ids) => ids.filter((id) => !removed.has(id)));
      if (failed.length) {
        setDeleteTargets(failed);
        setDeleteError(
          `已删除 ${removed.size} 条，${failed.length} 条未能删除。${reason}。请返回列表刷新后重试。`,
        );
      } else {
        setDeleteTargets(null);
        setRefresh((value) => value + 1);
      }
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }
  function organize(notes: QuickNote[]) {
    if (!notes.length || !ai) return;
    const pad = (v: number) => String(v).padStart(2, "0");
    ai.addNotes(
      notes.map((n) => {
        const d = new Date(n.created_at);
        return {
          id: n.id,
          label: `随手记 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
          content: n.content,
          attachments: n.assets.map((a) => ({
            id: a.id,
            filename: a.filename,
            mime: a.mime,
            size: a.size,
          })),
          createdAt: n.created_at,
        };
      }),
    );
  }
  return (
    <section className="quick-notes-page">
      <aside className="note-writing-pane" aria-label="记录想法">
        <div className="quick-notes-heading">
          <div>
            <h1>
              <Feather size={25} />
              随手记
            </h1>
          </div>
          <span className="note-private">
            <LockKeyhole size={13} />
            仅自己可见
          </span>
        </div>
        <div className="note-compose-card">
          <NoteForm
            key={newKey}
            userId={userId}
            saved={() => {
              setNewKey((k) => k + 1);
              setQuery("");
              setTrash(false);
              setRefresh((n) => n + 1);
            }}
          />
        </div>
      </aside>
      <div className={`note-browsing-pane ${batchMode ? "is-selecting" : ""}`}>
        <div className="note-list-tools">
          <div className="note-tabs">
            <button
              className={!trash ? "active" : ""}
              onClick={() => setTrash(false)}
            >
              全部记录
            </button>
            <button
              className={trash ? "active" : ""}
              onClick={() => setTrash(true)}
            >
              <Trash2 size={14} />
              已删除
            </button>
          </div>
          {searchOpen || query ? (
            <div className="note-search">
              <Search size={15} />
              <input
                aria-label="搜索随手记"
                autoFocus
                placeholder="搜索记录…"
                value={query}
                maxLength={200}
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => {
                  if (!query) setSearchOpen(false);
                }}
              />
            </div>
          ) : (
            <button
              aria-label="搜索随手记"
              title="搜索随手记"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={17} />
            </button>
          )}
          {!trash && (
            <button
              className="note-batch-toggle"
              aria-pressed={batchMode}
              disabled={loading || !!editing || !items.length}
              title={editing ? "请先完成当前编辑" : "批量选择"}
              onClick={() => {
                setBatchMode((value) => !value);
                setSelected([]);
              }}
            >
              <SquareCheck size={16} />
              {batchMode ? "退出选择" : "批量选择"}
            </button>
          )}
          <button
            title="刷新记录"
            aria-label="刷新记录"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {batchMode && (
          <div className="note-selection-bar">
            <span>
              {selected.length
                ? `已选择 ${selected.length} 条`
                : "请选择卡片（最多 20 条）"}
            </span>
            <button
              onClick={() => setSelected(items.slice(0, 20).map((n) => n.id))}
            >
              {items.length > 20 ? "选择前 20 条" : "全选"}
            </button>
            <button disabled={!selected.length} onClick={() => setSelected([])}>
              清空
            </button>
            <button
              disabled={!selected.length}
              className="note-batch-delete"
              onClick={() =>
                askDelete(items.filter((n) => selected.includes(n.id)))
              }
            >
              <Trash2 size={14} />
              删除所选
            </button>
            <button
              className="primary"
              disabled={!selected.length}
              onClick={() =>
                organize(items.filter((n) => selected.includes(n.id)))
              }
            >
              <Sparkles size={15} />
              AI 整理
            </button>
          </div>
        )}
        {error && (
          <p className="note-error" role="alert">
            {error}
          </p>
        )}
        <div className="note-browsing-content">
          {loading ? (
            <div className="note-empty" role="status">
              正在加载记录…
            </div>
          ) : !items.length ? (
            <div className="note-empty">
              <Feather size={36} />
              <h3>
                {query
                  ? "没有找到相关记录"
                  : trash
                    ? "没有已删除的记录"
                    : "从一个小想法开始"}
              </h3>
              <p>
                {query
                  ? "换个关键词试试。"
                  : trash
                    ? "删除的卡片可以在这里恢复。"
                    : "不必起标题，也不用先想好放在哪里。"}
              </p>
            </div>
          ) : (
            <div className="note-grid">
              {items.map((n) => (
                <article
                  key={n.id}
                  data-note-id={n.id}
                  className={`note-card ${selected.includes(n.id) ? "selected" : ""} ${editing === n.id ? "is-editing" : ""}`}
                >
                  <header>
                    <time dateTime={n.updated_at}>{stamp(n.updated_at)}</time>
                    {batchMode && !trash && editing !== n.id && (
                      <label className="note-select">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${stamp(n.created_at)} 的记录`}
                          checked={selected.includes(n.id)}
                          disabled={
                            !selected.includes(n.id) && selected.length >= 20
                          }
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked
                                ? [...s, n.id]
                                : s.filter((id) => id !== n.id),
                            )
                          }
                        />
                        <span>选择</span>
                      </label>
                    )}
                  </header>
                  {editing === n.id && !trash ? (
                    <div
                      className="note-card-editor"
                      role="region"
                      aria-label="编辑随手记"
                    >
                      <NoteForm
                        userId={userId}
                        note={n}
                        saved={updateSaved}
                        close={() =>
                          setEditing((current) =>
                            current === n.id ? null : current,
                          )
                        }
                      />
                    </div>
                  ) : (
                    <>
                      <div
                        className={`note-card-content ${!collapsible(n) || expanded.includes(n.id) ? "expanded" : ""}`}
                      >
                        <QuickNoteBody content={n.content} />
                        <NoteAssets
                          assets={outsideAssets(n.content, n.assets)}
                        />
                      </div>
                      {collapsible(n) && (
                        <button
                          className="note-expand"
                          onClick={() =>
                            setExpanded((ids) =>
                              ids.includes(n.id)
                                ? ids.filter((id) => id !== n.id)
                                : [...ids, n.id],
                            )
                          }
                        >
                          {expanded.includes(n.id) ? "收起" : "展开内容"}
                        </button>
                      )}
                      <footer>
                        {trash ? (
                          <button
                            disabled={mutating === n.id}
                            onClick={() => void restoreNote(n)}
                          >
                            <RotateCcw size={14} />
                            恢复
                          </button>
                        ) : (
                          <>
                            <button
                              disabled={batchMode}
                              onClick={() => setEditing(n.id)}
                            >
                              <Pencil size={14} />
                              编辑
                            </button>
                            <button onClick={() => organize([n])}>
                              <Sparkles size={14} />
                              整理
                            </button>
                            <button
                              className="note-delete"
                              disabled={mutating === n.id}
                              aria-label="删除记录"
                              title="移到已删除，可恢复"
                              onClick={() => askDelete([n])}
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </footer>
                    </>
                  )}
                </article>
              ))}
            </div>
          )}
          {!loading && next !== null && (
            <button
              className="note-load-more"
              onClick={async () => {
                const g = generation.current;
                setMutating("load");
                try {
                  const page = await api<{
                    items: QuickNote[];
                    nextOffset: number | null;
                  }>(url(next));
                  if (g === generation.current) {
                    setItems((old) => [
                      ...new Map(
                        [...old, ...page.items].map((n) => [n.id, n]),
                      ).values(),
                    ]);
                    setNext(page.nextOffset);
                  }
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setMutating(null);
                }
              }}
              disabled={mutating === "load"}
            >
              加载更多
            </button>
          )}
        </div>
      </div>
      {deleteTargets && (
        <Dialog
          title="删除随手记"
          close={() => {
            if (!deletingRef.current) setDeleteTargets(null);
          }}
          className="note-delete-dialog modal-compact"
        >
          <p>
            {deleteTargets.length === 1
              ? "确定删除这条随手记吗？"
              : `确定删除选中的 ${deleteTargets.length} 条随手记吗？`}
          </p>
          <p className="note-muted">删除后会移入“已删除”，可以随时恢复。</p>
          {deleteError && (
            <p className="note-error" role="alert">
              {deleteError}
            </p>
          )}
          <div className="note-delete-actions">
            <button disabled={deleting} onClick={() => setDeleteTargets(null)}>
              取消
            </button>
            <button
              className="note-confirm-delete"
              disabled={deleting || !!deleteError}
              onClick={() => void confirmDelete()}
            >
              {deleting ? "正在删除…" : "确认删除"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
