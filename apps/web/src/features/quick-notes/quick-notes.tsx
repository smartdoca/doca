import type { UploadContext } from "@smartdoca/slate";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Feather,
  LockKeyhole,
  Search,
  Trash2,
  RotateCcw,
  Sparkles,
  Paperclip,
  X,
  RefreshCw,
  SquareCheck,
  Plus,
  ChevronLeft,
  PictureInPicture2,
} from "lucide-react";
import { api, assetUrl, uploadFile } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { QuickNoteBody, QuickNoteEditor } from "@web/features/quick-notes/quick-note-editor.js";
import { useAI } from "@web/features/ai/ai-context.js";
import { useI18n } from "@web/shared/i18n.js";
import { htmlLang } from "@doca/i18n";
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
import { useNotesFloat } from "@web/features/quick-notes/notes-float-store.js";
import "@web/features/quick-notes/quick-notes.css";

function useHeaderSlot(id: string) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(id));
  }, [id]);
  return slot;
}

const base = "/quick-notes";
type NotesOpenTarget = {
  note: QuickNote | null;
  creating: boolean;
  stamp: string;
  trash: boolean;
  query: string;
};
let openTarget: NotesOpenTarget | null = null;
let openTargetGeneration = 0;
const errorText = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const stamp = (date: string, lang = "zh-CN") =>
  new Date(date).toLocaleString(lang, {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const notePreview = (
  note: QuickNote,
  label: (key: "notes.image" | "notes.attachment" | "notes.noText") => string,
) => {
  const text = noteText(note.content)
    .replace(/^(\[[ x]\] |- |\d+\. )/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 80);
  if (text) return text;
  if (note.assets.some((asset) => asset.mime.startsWith("image/")))
    return label("notes.image");
  if (note.assets.length) return label("notes.attachment");
  return label("notes.noText");
};
function useNarrow(query = "(max-width: 800px)") {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [query]);
  return narrow;
}
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
  const { t } = useI18n();
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
              aria-label={t("notes.viewImage", { name: a.filename })}
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
              aria-label={t("notes.removeNamed", { name: a.filename })}
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
  autosaveNew = false,
  quiet = false,
}: {
  userId: string;
  note?: QuickNote;
  saved: (note: QuickNote) => void;
  close?: () => void;
  autosaveNew?: boolean;
  quiet?: boolean;
}) {
  const { t } = useI18n();
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
      note ? t("notes.autosaved") : t("notes.draftLocal"),
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
        setError(t("notes.draftBlocked"));
    }
  };
  const update = (patch: Partial<Draft>) => {
    if (!conflictRef.current) setError("");
    const next = { ...current.current, ...patch, version: version.current };
    current.current = next;
    setDraft(next);
    persist(next);
    setSaveState(note ? t("notes.unsaved") : t("notes.draftLocal"));
  };
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  saveRef.current = async () => {
    if (busy.current || uploadingRef.current || conflictRef.current)
      return false;
    if (!hasContent(current.current)) return false;
    const sent = structuredClone(current.current),
      signature = fingerprint(sent);
    if (version.current && signature === acknowledged.current) return true;
    busy.current = true;
    let committed = false;
    if (alive.current) {
      setSaving(true);
      setError("");
      setSaveState(t("notes.saving"));
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
      try {
        if (fingerprint(current.current) !== signature) {
          const pending = {
            ...current.current,
            id: result.id,
            version: result.version,
          };
          localStorage.setItem(
            `doca.quick-note.${userId}.${result.id}`,
            JSON.stringify(pending),
          );
        }
        if (!note || fingerprint(current.current) === signature)
          localStorage.removeItem(cacheKey);
        else persist(current.current);
      } catch {}
      savedCallback.current(result);
      if (alive.current) setSaveState(t("notes.saved"));
      return fingerprint(current.current) === signature;
    } catch (e) {
      persist(current.current);
      if (alive.current) {
        setError(errorText(e, t("notes.failed")));
        setSaveState(t("notes.keptDraft"));
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
    if (note || !autosaveNew || conflict || uploading || saving || error) return;
    if (!hasContent(current.current)) return;
    if (version.current && fingerprint(current.current) === acknowledged.current)
      return;
    const timer = setTimeout(() => {
      void saveRef.current();
    }, 900);
    return () => clearTimeout(timer);
  }, [draft, note, autosaveNew, conflict, uploading, saving, error]);
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
      throw Error(t("notes.assetLimit"));
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
          autoFocus={!!note || autosaveNew}
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
          disabled={!note && saving && !autosaveNew}
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
          {t("notes.uploading")}
        </p>
      )}
      {conflict && (
        <div className="note-conflict">
          <p>{t("notes.conflict")}</p>
          <button
            onClick={async () => {
              try {
                setRemote(await api<QuickNote>(base + "/" + draft.id));
              } catch (e) {
                setError(errorText(e, t("notes.failed")));
              }
            }}
          >
            {t("notes.viewLatest")}
          </button>
          {remote && (
            <>
              <div className="note-remote">
                <QuickNoteBody content={remote.content} />
                <NoteAssets
                  assets={outsideAssets(remote.content, remote.assets)}
                />
              </div>
              <p>{t("notes.mergeHint")}</p>
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
                {t("notes.saveMerge")}
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
                {t("notes.useCloud")}
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
          {note || error || saving || autosaveNew ? saveState : t("notes.shortcut")}
        </span>
        {!quiet && (
        <div>
          {close && (error || conflict) && (
            <button onClick={close}>{t("notes.keepDraft")}</button>
          )}
          <button
            className="primary"
            disabled={saving || uploading || conflict || !hasContent(draft)}
            onClick={() => void submit()}
          >
            {saving ? t("notes.saving") : note ? t("notes.done") : t("notes.save")}
            <span className="note-shortcut" aria-hidden="true">
              ⌘ ↵
            </span>
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

export function QuickNotes({
  userId,
  presentation = "page",
}: {
  userId: string;
  changed: () => void;
  presentation?: "page" | "card";
}) {
  const { locale, t } = useI18n();
  const lang = htmlLang(locale);
  const ai = useAI();
  const float = useNotesFloat(userId);
  const narrow = useNarrow();
  const cardFocus = useRef(presentation === "card" ? openTarget : null);
  const [items, setItems] = useState<QuickNote[]>([]),
    [next, setNext] = useState<number | null>(null);
  const [query, setQuery] = useState(cardFocus.current?.query ?? ""),
    [trash, setTrash] = useState(cardFocus.current?.trash ?? false),
    [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [newKey, setNewKey] = useState(0);
  const [selected, setSelected] = useState<string[]>([]),
    [activeId, setActiveId] = useState<string | null>(cardFocus.current?.note?.id ?? null),
    [creating, setCreating] = useState(cardFocus.current?.creating ?? false),
    [draftStamp, setDraftStamp] = useState(cardFocus.current?.stamp ?? ""),
    [cardView, setCardView] = useState<"list" | "note">(
      cardFocus.current?.note || cardFocus.current?.creating ? "note" : "list",
    );
  const [pinned, setPinned] = useState<QuickNote | null>(cardFocus.current?.note ?? null);
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
          if (!controller.signal.aborted) setError(errorText(e, t("notes.failed")));
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
  useEffect(() => {
    if (presentation === "card" || narrow || creating || trash) return;
    if (activeId && items.some((note) => note.id === activeId)) return;
    if (items[0]) setActiveId(items[0].id);
  }, [items, narrow, creating, trash, activeId, presentation]);
  useEffect(() => {
    if (presentation !== "card" || !cardFocus.current) return;
    const generation = openTargetGeneration;
    const timer = window.setTimeout(() => {
      if (generation === openTargetGeneration) openTarget = null;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [presentation]);
  const updateSaved = (note: QuickNote) => {
    setPinned((current) => (current?.id === note.id ? note : current));
    setItems((rows) => rows.map((n) => (n.id === note.id ? note : n)));
  };
  const active =
    items.find((note) => note.id === activeId) ??
    (pinned?.id === activeId ? pinned : null);
  function openNote(id: string) {
    setCreating(false);
    setActiveId(id);
    setCardView("note");
  }
  function startNew() {
    setTrash(false);
    setQuery("");
    setBatchMode(false);
    setDraftStamp(stamp(new Date().toISOString(), lang));
    setCreating(true);
    setActiveId(null);
    setNewKey((value) => value + 1);
    setCardView("note");
  }
  function backToList() {
    setCreating(false);
    setActiveId(null);
    setCardView("list");
  }
  function acceptCreated(note: QuickNote) {
    setCreating(false);
    setActiveId(note.id);
    setItems((rows) => [note, ...rows.filter((item) => item.id !== note.id)]);
    setTrash(false);
    setRefresh((value) => value + 1);
  }
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
      setError(errorText(e, t("notes.failed")));
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
          reason ||= errorText(e, t("notes.failed"));
        }
      }
      setItems((rows) => rows.filter((n) => !removed.has(n.id)));
      setSelected((ids) => ids.filter((id) => !removed.has(id)));
      setActiveId((id) => (id && removed.has(id) ? null : id));
      if (failed.length) {
        setDeleteTargets(failed);
        setDeleteError(
          t("notes.deletePartial", { removed: removed.size, failed: failed.length, reason }),
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
          label: t("notes.aiLabel", { when: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }),
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
  const showList = presentation === "page" || cardView === "list";
  const showNote = presentation === "page" || cardView === "note";
  const reading = creating || !!activeId;
  const headerSlot = useHeaderSlot(presentation === "page" ? "notes-header-slot" : "");
  const headerTools =
    headerSlot &&
    createPortal(
      <>
        <span className="files-topbar-separator">/</span>
        <span className="notes-topbar-private">
          <LockKeyhole size={12} />
          {t("notes.private")}
        </span>
        <button
          type="button"
          className="note-icon-button notes-topbar-float"
          aria-pressed={float.state.open}
          aria-label={float.state.open ? t("notes.closeFloat") : t("notes.openFloat")}
          title={float.state.open ? t("notes.closeFloat") : t("notes.float")}
          onClick={() => {
            if (float.state.open) {
              float.patch({ open: false, collapsed: false });
              return;
            }
            openTarget = {
              note: creating ? null : active,
              creating,
              stamp: draftStamp,
              trash,
              query,
            };
            openTargetGeneration += 1;
            float.patch({ open: true, collapsed: false });
          }}
        >
          <PictureInPicture2 size={16} />
        </button>
      </>,
      headerSlot,
    );
  if (presentation === "page" && float.state.open) {
    return (
      <>
        {headerTools}
        <section className="quick-notes-hosted" aria-label={t("notes.hosted")} />
      </>
    );
  }
  return (
    <>
      {headerTools}
    <section
      className={`quick-notes-page ${presentation === "card" ? "is-card" : ""} ${reading ? "is-reading" : ""} ${batchMode ? "is-selecting" : ""}`}
    >
      <aside className="note-list-pane" aria-label={t("notes.list")} hidden={!showList}>
        <div className="note-list-search-row">
          <label className="note-list-search">
            <Search size={14} />
            <input
              aria-label={t("notes.searchLabel")}
              placeholder={t("notes.search")}
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="note-icon-button"
            aria-label={t("notes.new")}
            title={t("notes.new")}
            disabled={trash}
            onClick={startNew}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="note-list-tools">
          <div className="note-tabs">
            <button
              type="button"
              className={!trash ? "active" : ""}
              onClick={() => {
                setTrash(false);
                setCreating(false);
                setActiveId(null);
                setSelected([]);
              }}
            >
              {t("notes.all")}
            </button>
            <button
              type="button"
              className={trash ? "active" : ""}
              onClick={() => {
                setTrash(true);
                setCreating(false);
                setActiveId(null);
                setBatchMode(false);
                setSelected([]);
              }}
            >
              <Trash2 size={14} />
              {t("notes.deleted")}
            </button>
          </div>
          {!trash && (
            <button
              type="button"
              className="note-icon-button note-batch-toggle"
              aria-pressed={batchMode}
              disabled={loading || !items.length}
              aria-label={t("notes.batch")}
              title={t("notes.batch")}
              onClick={() => {
                setBatchMode((value) => !value);
                setSelected([]);
              }}
            >
              <SquareCheck size={15} />
            </button>
          )}
          <button
            type="button"
            className="note-icon-button"
            title={t("notes.refresh")}
            aria-label={t("notes.refresh")}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {batchMode && (
          <div className="note-selection-bar">
            <span>{selected.length ? t("notes.selected", { count: selected.length }) : t("notes.selectRows")}</span>
            <div className="note-selection-actions">
              <button
                type="button"
                title={t("notes.batchLimit")}
                onClick={() => setSelected(items.slice(0, 20).map((note) => note.id))}
              >
                {t("notes.selectAll")}
              </button>
              <button type="button" disabled={!selected.length} onClick={() => setSelected([])}>
                {t("notes.clear")}
              </button>
              <button
                type="button"
                className="note-selection-icon note-batch-delete"
                disabled={!selected.length}
                aria-label={t("notes.deleteSelected")}
                title={t("notes.deleteSelected")}
                onClick={() => askDelete(items.filter((note) => selected.includes(note.id)))}
              >
                <Trash2 size={14} />
              </button>
              <button
                type="button"
                className="note-selection-icon"
                disabled={!selected.length}
                aria-label={t("notes.organizeAi")}
                title={t("notes.organizeAi")}
                onClick={() => organize(items.filter((note) => selected.includes(note.id)))}
              >
                <Sparkles size={14} />
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="note-error" role="alert">
            {error}
          </p>
        )}
        <div className="note-list-scroll">
          {loading ? (
            <div className="note-empty" role="status">
              {t("notes.loading")}
            </div>
          ) : !items.length && !creating ? (
            <div className="note-empty">
              <h3>
                {query ? t("notes.emptySearch") : trash ? t("notes.emptyTrash") : t("notes.empty")}
              </h3>
              <p>
                {query
                  ? t("notes.emptySearchHint")
                  : trash
                    ? t("notes.emptyTrashHint")
                    : t("notes.emptyHint")}
              </p>
            </div>
          ) : (
            <div className="note-rows" role="listbox" aria-label={t("notes.titles")}>
              {creating && !trash && (
                <button type="button" className="note-row is-active" onClick={() => setCardView("note")}>
                  <span className="note-row-copy">
                    <span className="note-row-title">{draftStamp}</span>
                    <span className="note-row-preview">{t("notes.newPreview")}</span>
                  </span>
                </button>
              )}
              {items.map((note) => (
                <div
                  key={note.id}
                  className={`note-row ${!creating && activeId === note.id ? "is-active" : ""}`}
                  data-note-id={note.id}
                >
                  {batchMode && !trash && (
                    <label className="note-select">
                      <input
                        type="checkbox"
                        aria-label={t("notes.select", { when: stamp(note.created_at, lang) })}
                        checked={selected.includes(note.id)}
                        disabled={!selected.includes(note.id) && selected.length >= 20}
                        onChange={(event) =>
                          setSelected((ids) =>
                            event.target.checked
                              ? [...ids, note.id]
                              : ids.filter((id) => id !== note.id),
                          )
                        }
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={!creating && activeId === note.id}
                    className="note-row-open"
                    onClick={() => openNote(note.id)}
                  >
                    <span className="note-row-title">{stamp(note.created_at, lang)}</span>
                    <span className="note-row-preview">{notePreview(note, t)}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          {!loading && next !== null && (
            <button
              type="button"
              className="note-load-more"
              disabled={mutating === "load"}
              onClick={async () => {
                const generationId = generation.current;
                setMutating("load");
                try {
                  const page = await api<{
                    items: QuickNote[];
                    nextOffset: number | null;
                  }>(url(next));
                  if (generationId === generation.current) {
                    setItems((old) => [
                      ...new Map([...old, ...page.items].map((note) => [note.id, note])).values(),
                    ]);
                    setNext(page.nextOffset);
                  }
                } catch (exception) {
                  setError(errorText(exception, t("notes.failed")));
                } finally {
                  setMutating(null);
                }
              }}
            >
              {t("common.more")}
            </button>
          )}
        </div>
      </aside>
      <div className="note-content-pane" aria-label={t("notes.body")} hidden={!showNote}>
        {(creating || active) && (
          <div className="note-content-head">
            <button
              type="button"
              className="note-back"
              aria-label={t("notes.back")}
              onClick={backToList}
            >
              <ChevronLeft size={18} />
              <span>{t("notes.all")}</span>
            </button>
            <h2>{creating ? draftStamp : active ? stamp(active.created_at, lang) : ""}</h2>
            <div className="note-content-actions">
              {trash && active ? (
                <button
                  type="button"
                  disabled={mutating === active.id}
                  onClick={() => void restoreNote(active)}
                >
                  <RotateCcw size={14} />
                  {t("common.restore")}
                </button>
              ) : active && !creating ? (
                <>
                  <button type="button" onClick={() => organize([active])}>
                    <Sparkles size={14} />
                    {t("notes.organize")}
                  </button>
                  <button
                    type="button"
                    className="note-delete"
                    aria-label={t("notes.deleteRecord")}
                    title={t("notes.deleteHint")}
                    onClick={() => askDelete([active])}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        )}
        <div className="note-content-body">
          {creating && !trash ? (
            <NoteForm
              key={newKey}
              userId={userId}
              autosaveNew
              saved={acceptCreated}
            />
          ) : active && trash ? (
            <div className="note-readonly">
              <QuickNoteBody content={active.content} />
              <NoteAssets assets={outsideAssets(active.content, active.assets)} />
            </div>
          ) : active ? (
            <NoteForm key={active.id} userId={userId} note={active} quiet saved={updateSaved} />
          ) : (
            <div className="note-empty">
              <Feather size={36} />
              <h3>{query ? t("notes.emptySearch") : trash ? t("notes.emptyTrash") : t("notes.empty")}</h3>
              <p>
                {query
                  ? t("notes.emptySearchHint")
                  : trash
                    ? t("notes.emptyTrashHint")
                    : t("notes.emptyPick")}
              </p>
            </div>
          )}
        </div>
      </div>
      {deleteTargets && (
        <Dialog
          title={t("notes.deleteTitle")}
          close={() => {
            if (!deletingRef.current) setDeleteTargets(null);
          }}
          className="note-delete-dialog modal-compact"
        >
          <p>
            {deleteTargets.length === 1
              ? t("notes.deleteOne")
              : t("notes.deleteMany", { count: deleteTargets.length })}
          </p>
          <p className="note-muted">{t("notes.deleteBody")}</p>
          {deleteError && (
            <p className="note-error" role="alert">
              {deleteError}
            </p>
          )}
          <div className="note-delete-actions">
            <button disabled={deleting} onClick={() => setDeleteTargets(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="note-confirm-delete"
              disabled={deleting || !!deleteError}
              onClick={() => void confirmDelete()}
            >
              {deleting ? t("notes.deleting") : t("notes.confirmDelete")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
    </>
  );
}
