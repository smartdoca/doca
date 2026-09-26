import { fileLocationLabel } from "@web/shared/utils/system-labels.js";
import type { Locale } from "@doca/i18n";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns3,
  Check,
  ClipboardPaste,
  Copy,
  Download,
  File,
  FileText,
  Files,
  Folder,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, } from "react";
import { htmlLang } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import { createPortal } from "react-dom";
import { OpenFileViewerPreview } from "./open-file-viewer-preview.js";
import "@open-file-viewer/core/style.css";
import {
  api,
  fileUrl,
  type FileFolder,
  type FileInfo,
  type FileItem,
  type FilePage,
  type FileParentType,
} from "@web/shared/api.js";
import { useAI } from "@web/features/ai/ai-context.js";
import { readPageState, writePageState, } from "@web/features/page-state/client.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { FolderPermissionPanel } from "./folder-permissions.js";
import {
  captureExternalDrop,
  currentInternalFileDrag,
  destinationEntries,
  endInternalFileDrag,
  findNameConflicts,
  isExternalFileDrag,
  isInternalFileDrag,
  idsInMarquee,
  materializeExternalDrop,
  nextAvailableName,
  normalizeRect,
  orderedRange,
  readFileDrag,
  replaceColumnPage,
  reusedColumnPrefix,
  sameTrail,
  toggleSelectedId,
  trailAfterRemovedFolders,
  trailKey,
  writeFileDrag,
  type DroppedUpload,
  type FileDragItem,
  type NameConflict,
} from "./file-interactions.js";
import { uploadDroppedTree } from "./upload-tree.js";
import "./files.css";

export type FileLocation = {
  type: FileParentType;
  id: string;
  name: string;
  locked?: boolean;
};
type Location = FileLocation;
type Selection =
  | { kind: "folder"; value: FileFolder }
  | { kind: "file"; value: FileItem }
  | null;
type SortMode = "name" | "updated" | "size";
type Selectable = Exclude<Selection, null>;
type ContextMenu = { x: number; y: number; target: Selection };
type UploadEntry = { file: File | null; path: string; selected: boolean };
type UploadProgress = {
  total: number;
  completed: number;
  current: string;
  status: "uploading" | "done" | "error";
  trail: Location[];
};
type SharedFolderSummary = FileFolder & {
  owner: { id: string; display_name: string; public_id?: string | null } | null;
  members: Array<{ user_id: string; role: "admin" | "reader"; display_name: string; public_id?: string | null; }>;
  role: "owner" | "admin" | "reader";
};
type TransferRequest = { mode: "move" | "copy"; items: Selectable[] };
type ItemClipboard = { mode: "copy" | "cut"; items: FileDragItem[] };
type MarqueeState = { origin: { x: number; y: number }; current: { x: number; y: number }; };
type NameConflictPrompt = {
  destination: Location;
  copy: boolean;
  items: FileDragItem[];
  conflicts: NameConflict[];
};

const root: Location = { type: "system", id: "root", name: "我的文件夹" };
function readFocusId() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("focus",);
}
function readFileNavigation(baseRoot: Location = root): Location[] {
  if (typeof window === "undefined")
  return [baseRoot];
  try {
    const raw = new URLSearchParams(
      window.location.hash.split("?")[1] ?? "",
    ).get("path");
  const value = raw
      ?(JSON.parse(raw) as Array<Pick<Location, "type" | "id" | "name">>)
      : [];
  const standaloneSystemRoot =
      baseRoot.id === "root" &&
      value[0]?.type === "system" &&
      ["ai", "documents"].includes(value[0]?.id ?? "");
    if (
      !Array.isArray(value) ||
      !value.length ||(value[0]?.id !== baseRoot.id && !standaloneSystemRoot)) return [baseRoot];
    return value.map(( item) => ({
      type:item.type,
      id:item.id,
      name: item.name,
    }));
  } catch {
    return [baseRoot];
    }
}
function writeFileNavigation (trail: Location[], routeBase = "/files") {
  if(typeof window === "undefined") return;
      const path = encodeURIComponent(
    JSON.stringify(trail.map(({type, id, name}) =>({ type,id, name}))),
  );
  window.history.replaceState(null, "", `#${routeBase}?path=${path}`);
}
const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
};
const fileDate = (value: string, locale: Locale) =>
  new Intl.DateTimeFormat(htmlLang(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
const extension = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const canConvertToDocument = (file: Pick<FileItem, "name" | "mime">) =>
  file.mime.startsWith("text/") ||
  file.mime === "application/pdf" ||
  extension(file.name) === "docx" ||
  ["json", "yaml", "yml", "csv"].includes(extension(file.name));

function SpecialFolderIcon({ icon }: { icon?: FileFolder["icon"] }) {
  if (icon === "sparkles") return <Sparkles />;
  if (icon === "files") return <Files />;
  if (icon === "share") return <Share2 />;
  return <Folder />;
}

function FolderGlyph({ icon }: { icon?: FileFolder["icon"] }) {
  return (
    <span className="folder-glyph">
      {icon && <SpecialFolderIcon icon={icon} />}
    </span>
  );
}

export function FileGlyph({
  file,
  large = false,
}: {
  file: FileItem;
  large?: boolean;
}) {
  const { t, locale } = useI18n();

  const ext = extension(file.name);
  const kind = file.mime.startsWith("image/")
    ? "image"
    : file.mime === "application/pdf"
      ? "pdf"
      : ["xlsx", "xls", "csv"].includes(ext)
        ? "sheet"
        : file.mime.startsWith("video/") || file.mime.startsWith("audio/")
          ? "media"
          : "document";
  const hasDescription = !!file.ai_description?.trim();
  const parsing =
    file.extract_status === "pending" ||
    file.ai_status === "pending" ||
    file.ai_status === "processing";
  return (
    <span
      className={`file-document-glyph file-document-${kind} ${large ? "large" : ""}`}
    >
      <span className="file-type-label">{ext || kind}</span>
      {kind === "image" && (
        <img
          className="file-image-thumbnail"
          src={fileUrl(file.id)}
          alt=""
          loading="lazy"
          draggable={false}
        />
      )}
      {parsing ? (
        <span
          className="file-ai-badge parsing"
          title={t("fileManager.parsing")}
        >
          <Loader2 size={11} />
        </span>
      ) : (
        hasDescription && (
          <span
            className="file-ai-badge"
            title={t("fileManager.hasDescription")}
          >
            <Sparkles size={11} />
          </span>
        )
      )}
    </span>
  );
}

function Preview({ file }: { file: FileItem }) {
  return <OpenFileViewerPreview file={file} />;
}

function PreviewPanel({
  file,
  close,
  openLarge,
}: {
  file: FileItem | null;
  close: () => void;
  openLarge: () => void;
}) {
  const { t, locale } = useI18n();

  if (!file)
    return (
      <aside className="file-preview-panel empty">
        <File className="file-preview-placeholder" />
        <p>{t("fileManager.previewEmpty")}</p>
      </aside>
    );
  return (
    <aside className="file-preview-panel" aria-label={t("fileManager.preview")}>
      <div
        className="file-preview-content"
        onDoubleClick={openLarge}
        title={t("fileManager.previewHelp")}
      >
        <Preview file={file} />
      </div>
    </aside>
  );
}

function FileInfoPanel({
  file,
  close,
  convert,
}: {
  file: FileInfo | null;
  close: () => void;
  convert?: (file: FileInfo) => void;
}) {
  const { t, locale } = useI18n();

  if (!file) return null;
  const rows: Array<[string, string]> = [
    [t("fileManager.filename"), file.name],
    [t("ticket.col.type"), file.mime],
    [t("fileManager.size"), formatSize(file.size)],
    [t("ticket.col.created"), fileDate(file.created_at, locale)],
    [t("home.modified"), fileDate(file.updated_at, locale)],
    [t("fileManager.storageObject"), file.storage_object_id],
    [t("fileManager.objectKey"), file.storage.object_key],
    ["SHA-256", file.storage.sha256],
    [
      t("fileManager.parseStatus"),
      file.extract_status === "pending"
        ? t("fileManager.parsing")
        : file.extract_status === "failed"
          ? t("fileManager.parseFailed")
          : file.extract_status === "ready"
            ? t("fileManager.parsed")
            : t("fileManager.notParsed"),
    ],
    [
      t("fileManager.aiStatus"),
      file.storage.ai_status === "pending" ||
      file.storage.ai_status === "processing"
        ? t("fileManager.recognizing")
        : file.storage.ai_status === "skipped"
          ? t("fileManager.notConfigured")
          : file.storage.ai_status === "failed"
            ? t("fileManager.recognitionFailed")
            : file.storage.ai_status === "ready"
              ? t("fileManager.recognized")
              : t("fileManager.notRecognized"),
    ],
    ...(file.storage.ai_model
      ? [[t("recognition.model"), file.storage.ai_model] as [string, string]]
      : []),
  ];
  return (
    <div className="file-info-backdrop" role="presentation" onClick={close}>
      <section
        className="file-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("fileManager.info")}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{t("fileManager.info")}</strong>
            <span title={file.name}>{file.name}</span>
          </div>
          <button
            className="icon"
            onClick={close}
            aria-label={t("dialog.close")}
          >
            <X size={18} />
          </button>
        </header>
        <div className="file-info-icon">
          <FileGlyph file={file} large />
        </div>
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
        <section className="file-info-description">
          <h3>{t("fileManager.description")}</h3>
          {file.storage.ai_status === "failed" && file.storage.ai_description && (
            <p role="status">{t("fileManager.previousDescription")}</p>
          )}
          <p>
            {file.ai_description_override ||
              file.storage.ai_description ||
              t("fileManager.noDescription")}
          </p>
        </section>
        <footer className="file-info-actions">
          <a className="secondary" href={fileUrl(file.id, true)}>
            {t("doc.download")}
          </a>
          {convert && (
            <button className="primary" onClick={() => convert(file)}>
              {t("fileManager.convert")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function FolderInfoPanel({
  folder,
  contents,
  close,
}: {
  folder: FileFolder | null;
  contents: { folders: number; files: number } | null;
  close: () => void;
}) {
  const { t, locale } = useI18n();

  if (!folder) return null;
  const kind = folder.virtual
    ? t("fileManager.systemFolder")
    : folder.parent_id === "shared"
      ? t("nav.sharedFiles")
      : t("trash.folder");
  const rows: Array<[string, string]> = [
    [t("shell.name"), folder.name],
    [t("ticket.col.type"), kind],
    [
      t("ticket.col.created"),
      folder.created_at ? fileDate(folder.created_at, locale) : "—",
    ],
    [
      t("home.modified"),
      folder.updated_at ? fileDate(folder.updated_at, locale) : "—",
    ],
    [t("fileManager.folderId"), folder.id],
    ...(contents
      ? [
          [
            t("fileManager.contents"),
            t("fileManager.contentsSummary", {
              folders: contents.folders,
              files: contents.files,
            }),
          ] as [string, string],
        ]
      : []),
  ];
  return (
    <div className="file-info-backdrop" role="presentation" onClick={close}>
      <section
        className="file-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("fileManager.folderInfo")}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{t("fileManager.folderInfo")}</strong>
            <span title={folder.name}>{folder.name}</span>
          </div>
          <button
            className="icon"
            onClick={close}
            aria-label={t("dialog.close")}
          >
            <X size={18} />
          </button>
        </header>
        <div className="file-info-icon">
          <FolderGlyph icon={folder.virtual ? folder.icon : undefined} />
        </div>
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

export function FilesExplorer({
  onNavigationChange,
  initialRoot = root,
  routeBase = "/files",
  sharedRoot = false,
}: {
  onNavigationChange?: (trail: FileLocation[]) => void;
  initialRoot?: FileLocation;
  routeBase?: string;
  sharedRoot?: boolean;
}) {
  const ai = useAI();
  const { t, locale } = useI18n();
  const textLocale = htmlLang(locale);
  const initialTrail = useMemo(
    () => readFileNavigation(initialRoot),
    [initialRoot.id],
  );
  const [location, setLocation] = useState<Location>(
    () => initialTrail[initialTrail.length - 1] ?? initialRoot,
  );
  const [trail, setTrail] = useState<Location[]>(initialTrail);
  const [future, setFuture] = useState<Location[]>([]);
  const [data, setData] = useState<FilePage | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [renaming, setRenaming] = useState<{
    kind: "folder" | "file";
    id: string;
    draft: string;
  } | null>(null);
  const [showExtensions, setShowExtensions] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [search, setSearch] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [draggingIds, setDraggingIds] = useState<Set<string>>(new Set());
  const [itemClipboard, setItemClipboard] = useState<ItemClipboard | null>(
    null,
  );
  const [nameConflict, setNameConflict] = useState<NameConflictPrompt | null>(
    null,
  );
  const [trashConfirm, setTrashConfirm] = useState<Selectable[] | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [uploadDestination, setUploadDestination] = useState<Location | null>(
    null,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const didMarqueeRef = useRef(false);
  const [infoFile, setInfoFile] = useState<FileInfo | null>(null);
  const [infoFolder, setInfoFolder] = useState<{
    folder: FileFolder;
    contents: { folders: number; files: number } | null;
  } | null>(null);
  const [view, setView] = useState<"grid" | "list" | "columns">(() => {
    try {
      return (
        (localStorage.getItem("doca.files.view") as
          "grid" | "list" | "columns") || "columns"
      );
    } catch {
      return "columns";
    }
  });
  useEffect(() => {
    let active = true;
    void readPageState<"grid" | "list" | "columns">("ui.filesView")
      .then((item) => {
        if (!active || !item) return;
        if (
          item.value === "grid" ||
          item.value === "list" ||
          item.value === "columns"
        )
          setView(item.value);
      })
      .catch(() => undefined);
    const onPageState = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: unknown }>)
        .detail;
      if (detail?.key !== "ui.filesView") return;
      if (
        detail.value === "grid" ||
        detail.value === "list" ||
        detail.value === "columns"
      ) {
        setView(detail.value);
        try {
          localStorage.setItem("doca.files.view", detail.value);
        } catch {}
      }
    };
    window.addEventListener("doca-page-state", onPageState);
    return () => {
      active = false;
      window.removeEventListener("doca-page-state", onPageState);
    };
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [pendingUpload, setPendingUpload] = useState<UploadEntry[] | null>(
    null,
  );
  const [shareFolder, setShareFolder] = useState<FileFolder | null>(null);
  const [uploadMenu, setUploadMenu] = useState(false);
  const [systemMenu, setSystemMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  const [largePreview, setLargePreview] = useState<FileItem | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const largePreviewRef = useRef<HTMLElement>(null);
  const [documentPicker, setDocumentPicker] = useState<{
    file: FileItem;
    documents: FileFolder[];
  } | null>(null);
  const [transfer, setTransfer] = useState<TransferRequest | null>(null);
  const [recognitionConfirm, setRecognitionConfirm] = useState<{
    target: Selectable | null;
  } | null>(null);
  const [columnPages, setColumnPages] = useState<
    Array<{ location: Location; page: FilePage }>
  >([]);
  const [focusId, setFocusId] = useState<string | null>(() => readFocusId());
  const appliedFocus = useRef<string | null>(null);
  const [columnsRev, setColumnsRev] = useState(0);
  const columnPagesRef = useRef(columnPages);
  const refreshColumnsRef = useRef(false);
  columnPagesRef.current = columnPages;
  const navigationKey = trailKey(trail);
  const setAIFileContext = ai?.setFileContext;
  useEffect(() => {
    if (!setAIFileContext) return;
    const context = {
      type: location.type,
      id: location.id,
      name: fileLocationLabel(location, t),
    };
    setAIFileContext(context);
    return () => {
      setAIFileContext((current) =>
        current?.type === context.type && current.id === context.id
          ? null
          : current,
      );
    };
  }, [location.id, location.name, location.type, setAIFileContext, t]);
  useEffect(() => {
    onNavigationChange?.(
      trail.map((item) => ({ ...item, name: fileLocationLabel(item, t) })),
    );
  }, [onNavigationChange, trail, t]);
  const visibleFolders = useMemo(() => {
    const q = search.trim().toLocaleLowerCase();
    return (data?.folders ?? [])
      .filter(
        (folder) =>
          !(
            location.type === "system" &&
            location.id === "root" &&
            folder.virtual &&
            ["ai", "documents"].includes(folder.id)
          ),
      )
      .filter((folder) => !q || folder.name.toLocaleLowerCase().includes(q))
      .sort((a, b) => {
        const special = { ai: 0, documents: 1, shared: 2 } as Record<
          string,
          number
        >;
        if (a.virtual || b.virtual)
          return (special[a.id] ?? 99) - (special[b.id] ?? 99);
        return a.name.localeCompare(b.name, textLocale);
      });
  }, [data, location.id, location.type, search, textLocale]);
  const visibleFiles = useMemo(() => {
    const q = search.trim().toLocaleLowerCase();
    return (data?.files ?? [])
      .filter(
        (file) =>
          !q ||
          [file.name, file.ai_description].some((value) =>
            value?.toLocaleLowerCase().includes(q),
          ),
      )
      .sort((a, b) =>
        sortMode === "size"
          ? b.size - a.size
          : sortMode === "updated"
            ? b.updated_at.localeCompare(a.updated_at)
            : a.name.localeCompare(b.name, textLocale),
      );
  }, [data, search, sortMode, textLocale]);
  const items = useMemo(
    () => [...visibleFolders, ...visibleFiles],
    [visibleFolders, visibleFiles],
  );
  const allValues = useMemo<Selectable[]>(
    () => [
      ...visibleFolders.map((value) => ({ kind: "folder" as const, value })),
      ...visibleFiles.map((value) => ({ kind: "file" as const, value })),
    ],
    [visibleFiles, visibleFolders],
  );
  const selectedValues = useMemo(() => {
    const fromCurrent = allValues.filter((value) =>
      selectedIds.has(value.value.id),
    );
    if (fromCurrent.length === selectedIds.size) return fromCurrent;
    const seen = new Set(fromCurrent.map((value) => value.value.id));
    const extra: Selectable[] = [];
    for (const column of columnPages) {
      for (const folder of column.page.folders) {
        if (selectedIds.has(folder.id) && !seen.has(folder.id)) {
          seen.add(folder.id);
          extra.push({ kind: "folder", value: folder });
        }
      }
      for (const file of column.page.files) {
        if (selectedIds.has(file.id) && !seen.has(file.id)) {
          seen.add(file.id);
          extra.push({ kind: "file", value: file });
        }
      }
    }
    return [...fromCurrent, ...extra];
  }, [allValues, columnPages, selectedIds]);
  const uploadExtensions = useMemo(
    () => [
      ...new Set(
        (pendingUpload ?? [])
          .filter((entry) => entry.file)
          .map(
            (entry) =>
              extension(entry.file!.name) || t("fileManager.noExtension"),
          ),
      ),
    ],
    [pendingUpload],
  );
  const sharedRootFolder = useMemo<FileFolder | null>(
    () =>
      sharedRoot
        ? {
            id: initialRoot.id,
            parent_id: "shared",
            name: initialRoot.name,
            type: "folder",
            virtual: false,
            locked: false,
            version: 1,
          }
        : null,
    [initialRoot.id, initialRoot.name, sharedRoot],
  );
  const systemReadonly =
    trail[0]?.type === "system" && ["ai", "documents"].includes(trail[0].id);
  const atSystemRoot = trail.length <= 1 && systemReadonly;

  async function load(next = location, options?: { refreshColumns?: boolean }) {
    const keepColumns = view === "columns" && columnPagesRef.current.length > 0;
    if (!keepColumns) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        parentType: next.type,
        parentId: next.id,
      });
      const page = await api<FilePage>(`/files?${params}`);
      setData(page);
      if (view === "columns")
        setColumnPages((old) => replaceColumnPage(old, next, page));
      if (options?.refreshColumns) {
        refreshColumnsRef.current = true;
        setColumnsRev((value) => value + 1);
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : t("fileManager.loadFailed");
      if (
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        e.status === 404
      ) {
        const nextTrail = trailAfterRemovedFolders(trail, [next.id]);
        if (nextTrail.kind === "parent") {
          setFuture([]);
          navigateTrail(nextTrail.trail);
          return;
        }
        if (sharedRoot) {
          window.location.hash = "/shared-files";
          return;
        }
        if (next.type !== root.type || next.id !== root.id) {
          setFuture([]);
          navigateTrail([root]);
          return;
        }
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [location.type, location.id]);
  useEffect(() => {
    const parsing = data?.files.some(
      (file) =>
        file.extract_status === "pending" ||
        file.ai_status === "pending" ||
        file.ai_status === "processing",
    );
    if (!parsing) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [data]);
  useEffect(() => {
    if (!focusId) {
      appliedFocus.current = null;
      return;
    }
    if (appliedFocus.current === focusId) return;
    const file =
      data?.files.find((item) => item.id === focusId) ??
      columnPages
        .flatMap((column) => column.page.files)
        .find((item) => item.id === focusId);
    if (!file) return;
    appliedFocus.current = focusId;
    setSelection({ kind: "file", value: file });
    setSelectedIds(new Set([file.id]));
    setAnchorId(file.id);
    setLargePreview(file);
  }, [columnPages, data, focusId]);
  useEffect(() => {
    if (view !== "columns") return;
    let cancelled = false;
    const nextTrail = trail;
    const force = refreshColumnsRef.current;
    refreshColumnsRef.current = false;
    void (async () => {
      const current = columnPagesRef.current;
      const reused =
        force && current.length ? [] : reusedColumnPrefix(nextTrail, current);
      const pages =
        force && current.length
          ? current.slice(0, nextTrail.length)
          : [...reused];
      if (!force && reused.length !== current.length) setColumnPages(reused);
      const start = force && current.length ? 0 : reused.length;
      for (let index = start; index < nextTrail.length; index++) {
        const item = nextTrail[index]!;
        try {
          const params = new URLSearchParams({
            parentType: item.type,
            parentId: item.id,
          });
          const page = await api<FilePage>(`/files?${params}`);
          if (cancelled) return;
          pages[index] = { location: item, page };
          setColumnPages(pages.slice(0, index + 1));
        } catch {
          if (!cancelled && index > 0) {
            const recovered = trailAfterRemovedFolders(nextTrail, [item.id]);
            if (recovered.kind === "parent") {
              setFuture([]);
              navigateTrail(recovered.trail);
            }
          }
          break;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [columnsRev, navigationKey, view]);
  useEffect(() => {
    const close = () => {
      setContextMenu(null);
      setUploadMenu(false);
      setSystemMenu(false);
      setSortMenu(false);
    };
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("click", close);
      endInternalFileDrag();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  function chooseView(next: typeof view) {
    setView(next);
    if (next === "columns") {
      refreshColumnsRef.current = true;
      setColumnsRev((value) => value + 1);
    }
    try {
      localStorage.setItem("doca.files.view", next);
    } catch {}
    void writePageState("ui.filesView", next).catch(() => undefined);
  }
  function clearSelection() {
    setSelection(null);
    setSelectedIds(new Set());
    setAnchorId(null);
  }
  async function togglePreviewFullscreen() {
    const element = largePreviewRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch {
      setPreviewFullscreen((old) => !old);
    }
  }
  useEffect(() => {
    const syncFullscreen = () =>
      setPreviewFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);
  useEffect(() => {
    const syncFromHash = () => {
      const nextTrail = readFileNavigation(initialRoot);
      const next = nextTrail[nextTrail.length - 1] ?? initialRoot;
      const nextFocus = readFocusId();
      setFocusId(nextFocus);
      if (next.type !== location.type || next.id !== location.id) {
        setTrail(nextTrail);
        setLocation(next);
        setFuture([]);
        clearSelection();
      }
    };
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [initialRoot.id, location.id, location.type]);
  function navigateTrail(nextTrail: Location[]) {
    const next = nextTrail[nextTrail.length - 1] ?? initialRoot;
    setTrail(nextTrail);
    setLocation(next);
    writeFileNavigation(nextTrail, routeBase);
  }
  function open(folder: FileFolder) {
    const next: Location = {
      type: folder.type,
      id: folder.id,
      name: folder.name,
      locked: folder.locked,
    };
    const nextTrail = [...trail, next];
    setFuture([]);
    navigateTrail(nextTrail);
    clearSelection();
  }
  function openSystemFolder(id: "ai" | "documents", name: string) {
    setSystemMenu(false);
    setFuture([]);
    navigateTrail([{ type: "system", id, name, locked: true }]);
    clearSelection();
  }
  function openInColumn(folder: FileFolder, columnIndex: number) {
    const next: Location = {
      type: folder.type,
      id: folder.id,
      name: folder.name,
      locked: folder.locked,
    };
    const nextTrail = [...trail.slice(0, columnIndex + 1), next];
    if (!sameTrail(trail, nextTrail)) {
      setFuture([]);
      navigateTrail(nextTrail);
    }
    setSelectedIds(new Set([folder.id]));
    setAnchorId(folder.id);
    setSelection({ kind: "folder", value: folder });
  }
  function back() {
    if (trail.length <= 1) return;
    const nextTrail = trail.slice(0, -1);
    const next = nextTrail[nextTrail.length - 1]!;
    setFuture((old) => [location, ...old]);
    navigateTrail(nextTrail);
    clearSelection();
  }
  function parentFolder() {
    if (trail.length <= 1) {
      if (sharedRoot) {
        window.location.hash = "/shared-files";
        return;
      }
      if (atSystemRoot) {
        setFuture([]);
        navigateTrail([root]);
        clearSelection();
      }
      return;
    }
    const nextTrail = trail.slice(0, -1);
    setFuture([]);
    navigateTrail(nextTrail);
    clearSelection();
  }
  function forward() {
    const next = future[0];
    if (!next) return;
    setFuture((old) => old.slice(1));
    navigateTrail([...trail, next]);
    clearSelection();
  }
  async function createFolder() {
    if (location.type !== "system" && location.type !== "folder") return;
    try {
      setError("");
      const parentId =
        location.type === "folder"
          ? location.id
          : location.id === "shared"
            ? "shared"
            : null;
      const names = new Set((data?.folders ?? []).map((folder) => folder.name));
      let name = t("fileManager.newFolder");
      for (let index = 2; names.has(name); index += 1)
        name = t("fileManager.numberedFolder", { index });
      const created = await api<FileFolder>("/files/folders", "POST", {
        name,
        parentId,
      });
      setSelection({ kind: "folder", value: created });
      setSelectedIds(new Set([created.id]));
      setAnchorId(created.id);
      setRenaming({ kind: "folder", id: created.id, draft: created.name });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.createFailed"));
    }
  }
  async function recognize(target?: Selectable | null, confirmed = false) {
    const hasExistingDescription =
      target?.kind === "file"
        ? !!target.value.ai_description?.trim()
        : (data?.files ?? []).some((file) => !!file.ai_description?.trim());
    if (hasExistingDescription && !confirmed) {
      setContextMenu(null);
      setRecognitionConfirm({ target: target ?? null });
      return;
    }
    setContextMenu(null);
    setNotice("");
    try {
      const body = target
        ? target.kind === "file"
          ? { ids: [target.value.id] }
          : {
              parentType: "folder" as const,
              parentId: target.value.id,
              recursive: true,
            }
        : { parentType: location.type, parentId: location.id, recursive: true };
      const result = await api<{ count: number }>(
        "/files/recognize",
        "POST",
        body,
      );
      setNotice(
        result.count
          ? t("fileManager.recognitionQueued", { count: result.count })
          : t("fileManager.noRecognizable"),
      );
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("fileManager.recognizeFailed"),
      );
    }
  }
  function selectUpload(
    files: FileList | null,
    destination: Location = location,
  ) {
    if (
      !files?.length ||
      (destination.type !== "system" && destination.type !== "folder")
    )
      return;
    setUploadDestination(destination);
    setPendingUpload(
      Array.from(files).map((file) => ({
        file,
        path:
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name,
        selected: true,
      })),
    );
  }
  async function upload(entries: UploadEntry[]) {
    const dest = uploadDestination ?? location;
    if (!entries.length || (dest.type !== "system" && dest.type !== "folder"))
      return;
    const destIndex = trail.findIndex(
      (item) => item.type === dest.type && item.id === dest.id,
    );
    const destinationTrail =
      destIndex >= 0
        ? trail.slice(0, destIndex + 1).map((item) => ({ ...item }))
        : [...trail.map((item) => ({ ...item })), dest];
    const tree: DroppedUpload[] = entries.map((entry) => ({
      file: entry.file ?? undefined,
      path: entry.path,
      directory: !entry.file,
    }));
    setUploadProgress({
      total: tree.filter((entry) => entry.file).length || tree.length,
      completed: 0,
      current: tree[0]?.path ?? "",
      status: "uploading",
      trail: destinationTrail,
    });
    try {
      const initialParent =
        dest.type === "folder"
          ? dest.id
          : dest.id === "shared"
            ? "shared"
            : null;
      await uploadDroppedTree(tree, initialParent, (path, completed, total) => {
        setUploadProgress((old) =>
          old
            ? { ...old, current: path, completed, total: total || old.total }
            : old,
        );
      });
      await load();
      setUploadProgress((old) =>
        old
          ? {
              ...old,
              current: t("fileManager.uploadComplete"),
              completed: old.total,
              status: "done",
            }
          : old,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.uploadFailed"));
      setUploadProgress((old) => (old ? { ...old, status: "error" } : old));
    }
    if (input.current) input.current.value = "";
    if (folderInput.current) folderInput.current.value = "";
    setPendingUpload(null);
  }
  async function showInfo(target: Selectable) {
    setContextMenu(null);
    try {
      if (target.kind === "file") {
        setInfoFolder(null);
        setInfoFile(
          await api<FileInfo>(`/files/items/${target.value.id}/info`),
        );
        return;
      }
      setInfoFile(null);
      const page = await api<FilePage>(
        `/files?parentType=${target.value.type}&parentId=${encodeURIComponent(target.value.id)}`,
      );
      setInfoFolder({
        folder: target.value,
        contents: { folders: page.folders.length, files: page.files.length },
      });
    } catch (e) {
      if (target.kind === "folder")
        setInfoFolder({ folder: target.value, contents: null });
      else
        setError(e instanceof Error ? e.message : t("fileManager.infoFailed"));
    }
  }
  async function copyToMyFiles(target: Selectable) {
    setContextMenu(null);
    try {
      if (target.kind === "file") {
        await api(`/files/items/${target.value.id}/copy`, "POST", {
          parentType: "system",
          parentId: "root",
        });
        setNotice(t("fileManager.copiedPersonal", { name: target.value.name }));
      } else {
        async function copyFolder(
          source: FileFolder,
          parentId: string | null,
          preferredName = source.name,
        ): Promise<FileFolder> {
          let created: FileFolder | null = null;
          for (let index = 1; !created && index <= 100; index += 1) {
            const name =
              index === 1 ? preferredName : `${preferredName} ${index}`;
            try {
              created = await api<FileFolder>("/files/folders", "POST", {
                name,
                parentId,
              });
            } catch (e) {
              if ((e as { status?: number }).status !== 409) throw e;
            }
          }
          if (!created) throw new Error(t("fileManager.destinationFailed"));
          const page = await api<FilePage>(
            `/files?parentType=${source.type}&parentId=${encodeURIComponent(source.id)}`,
          );
          for (const file of page.files)
            await api(`/files/items/${file.id}/copy`, "POST", {
              parentType: "folder",
              parentId: created.id,
            });
          for (const child of page.folders) await copyFolder(child, created.id);
          return created;
        }
        await copyFolder(
          target.value,
          null,
          t("fileManager.copyName", { name: target.value.name }),
        );
        setNotice(t("fileManager.copiedPersonal", { name: target.value.name }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.copyFailed"));
    }
  }
  async function chooseDocument(file: FileItem) {
    setContextMenu(null);
    try {
      const page = await api<FilePage>(
        "/files?parentType=system&parentId=documents-personal",
      );
      setDocumentPicker({
        file,
        documents: page.folders.filter((folder) => folder.type === "document"),
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("fileManager.documentsFailed"),
      );
    }
  }
  async function addToDocument(document: FileFolder) {
    if (!documentPicker) return;
    try {
      await api(`/files/items/${documentPicker.file.id}/copy`, "POST", {
        parentType: "document",
        parentId: document.id,
      });
      setDocumentPicker(null);
      setNotice(
        t("fileManager.addedDocument", {
          file: documentPicker.file.name,
          document: document.name,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.addFailed"));
    }
  }
  async function convertToDocument(file: FileItem | FileInfo) {
    try {
      const response = await fetch(fileUrl(file.id));
      if (!response.ok) throw new Error(t("create.readFailed"));
      const blob = await response.blob();
      const ext = extension(file.name);
      if (
        file.mime.startsWith("text/") ||
        ["md", "markdown", "json", "yaml", "yml", "csv"].includes(ext)
      ) {
        await api("/resources", "POST", {
          title: file.name.replace(/\.[^.]+$/, ""),
          kind: "document",
          format: "markdown",
          markdown: await blob.text(),
        });
      } else {
        const { createImportedDocument } =
          await import("@web/features/documents/file-transfer.js");
        await createImportedDocument(
          {
            title: file.name.replace(/\.[^.]+$/, ""),
            kind: "document",
            format: ext === "docx" ? "rich_text" : "markdown",
          },
          new window.File([blob], file.name, { type: file.mime }),
        );
      }
      setInfoFile(null);
      setNotice(t("fileManager.converted"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.convertFailed"));
    }
  }
  function openShare(folder: FileFolder) {
    setContextMenu(null);
    setShareFolder(folder);
  }
  async function commitRename() {
    if (!renaming) return;
    const current =
      renaming.kind === "folder"
        ? data?.folders.find((folder) => folder.id === renaming.id)
        : data?.files.find((file) => file.id === renaming.id);
    const name = renaming.draft.trim();
    if (!current || !name) {
      setRenaming(null);
      return;
    }
    if (name === current.name) {
      setRenaming(null);
      return;
    }
    try {
      const path =
        renaming.kind === "folder"
          ? `/files/folders/${current.id}`
          : `/files/items/${current.id}`;
      await api(path, "PATCH", { name, version: current.version });
      setRenaming(null);
      clearSelection();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileManager.renameFailed"));
    }
  }
  function renameSelected() {
    if (!selection || selection.value.locked) return;
    setRenaming({
      kind: selection.kind,
      id: selection.value.id,
      draft: selection.value.name,
    });
    setContextMenu(null);
  }
  function requestTrash() {
    const targets = selectedValues.length
      ? selectedValues
      : selection
        ? [selection]
        : [];
    const removable = targets.filter((target) => !target.value.locked);
    if (!removable.length) return;
    setContextMenu(null);
    setTrashConfirm(removable);
  }
  async function executeTrash() {
    const removable = trashConfirm;
    if (!removable?.length) return;
    setTrashConfirm(null);
    try {
      for (const target of removable) {
        const path =
          target.kind === "folder"
            ? `/files/folders/${target.value.id}`
            : `/files/items/${target.value.id}`;
        await api(path, "DELETE", { version: target.value.version });
      }
      const removedFolders = removable
        .filter((target) => target.kind === "folder")
        .map((target) => target.value.id);
      const nextTrail = trailAfterRemovedFolders(trail, removedFolders);
      clearSelection();
      setNotice(
        removable.length > 1
          ? t("fileManager.trashedMany", { count: removable.length })
          : t("fileManager.trashedOne", { name: removable[0]!.value.name }),
      );
      if (nextTrail.kind === "leave-root") {
        if (sharedRoot) window.location.hash = "/shared-files";
        else {
          setFuture([]);
          navigateTrail([root]);
        }
      } else if (nextTrail.kind === "parent") {
        setFuture([]);
        navigateTrail(nextTrail.trail);
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("embeddings.deleteFailed"));
    }
  }
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]'))
        return;
      if (event.key === "Escape") {
        if (largePreview) {
          if (document.fullscreenElement) void document.exitFullscreen();
          setLargePreview(null);
        } else if (trashConfirm) setTrashConfirm(null);
        else if (contextMenu) setContextMenu(null);
        else if (renaming) setRenaming(null);
        else clearSelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(allValues.map((value) => value.value.id)));
        setAnchorId(allValues[0]?.value.id ?? null);
        setSelection(allValues[0] ?? null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelected("copy");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "x") {
        event.preventDefault();
        copySelected("cut");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteClipboard(location);
        return;
      }
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        selectedValues.length
      ) {
        event.preventDefault();
        void requestTrash();
        return;
      }
      if (
        (event.key === "ArrowRight" ||
          event.key === "ArrowDown" ||
          event.key === "ArrowLeft" ||
          event.key === "ArrowUp") &&
        allValues.length
      ) {
        event.preventDefault();
        const current = selection?.value.id ?? anchorId;
        const index = Math.max(
          0,
          allValues.findIndex((value) => value.value.id === current),
        );
        const nextIndex =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? Math.min(allValues.length - 1, index + 1)
            : Math.max(0, index - 1);
        const next = allValues[nextIndex];
        if (!next) return;
        if (event.shiftKey) {
          const ordered = allValues.map((value) => value.value.id);
          setSelectedIds(
            new Set(
              orderedRange(
                ordered,
                anchorId ?? current ?? next.value.id,
                next.value.id,
              ),
            ),
          );
          setSelection(next);
        } else {
          select(next);
        }
      }
      if (event.key === "Enter" && selection && selectedValues.length === 1) {
        event.preventDefault();
        activate(selection);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    allValues,
    anchorId,
    contextMenu,
    itemClipboard,
    largePreview,
    location,
    renaming,
    selectedValues,
    selection,
    trashConfirm,
  ]);
  const select = (
    value: Selectable,
    event?: MouseEvent,
    orderedItems = allValues,
  ) => {
    const id = value.value.id;
    const ordered = orderedItems.map((item) => item.value.id);
    if (event?.shiftKey && anchorId) {
      setSelectedIds(new Set(orderedRange(ordered, anchorId, id)));
    } else if (event?.metaKey || event?.ctrlKey) {
      setSelectedIds((old) => toggleSelectedId(old, id));
      setAnchorId(id);
    } else {
      setSelectedIds(new Set([id]));
      setAnchorId(id);
    }
    setSelection(value);
  };
  const activate = (value: Selection) => {
    if (!value) return;
    if (value.kind === "folder") open(value.value);
    else {
      setSelection(value);
      setLargePreview(value.value);
    }
  };
  function openCurrentFolderAI() {
    if (!ai?.userId) return;
    ai.setOpen(true);
  }
  const visibleName = (name: string) =>
    showExtensions ? name : name.replace(/\.[^.]+$/, "");
  function toDragItems(values: Selectable[]): FileDragItem[] {
    return values
      .filter(
        (item) =>
          !item.value.locked && !(item.kind === "folder" && item.value.virtual),
      )
      .map((item) => ({
        kind: item.kind,
        id: item.value.id,
        version: item.value.version,
        name: item.value.name,
        ...(item.kind === "file"
          ? { mime: item.value.mime, size: item.value.size }
          : { folderType: item.value.type }),
      }));
  }
  async function transferItems(
    items: FileDragItem[],
    destination: Location,
    copy = false,
    conflictMode?: "overwrite" | "keep",
  ) {
    try {
      const page = await api<FilePage>(
        `/files?parentType=${destination.type}&parentId=${encodeURIComponent(destination.id)}`,
      );
      const entries = destinationEntries(page);
      const currentIds = new Set(entries.map((entry) => entry.id));
      const conflicts = findNameConflicts(items, entries, copy);
      if (conflicts.length && !conflictMode) {
        setNameConflict({ destination, copy, items, conflicts });
        return false;
      }
      const taken = new Set(entries.map((entry) => entry.name));
      let count = 0;
      for (const item of items) {
        if (item.locked || item.id === destination.id) continue;
        if (!copy && currentIds.has(item.id)) continue;
        const conflict = conflicts.find((entry) => entry.item.id === item.id);
        if (conflict && conflictMode === "overwrite") {
          if (conflict.existing.id === item.id) continue;
          if (conflict.existing.locked)
            throw new Error(
              t("fileManager.cannotReplace", { name: conflict.existing.name }),
            );
          const path =
            conflict.existing.kind === "folder"
              ? `/files/folders/${conflict.existing.id}`
              : `/files/items/${conflict.existing.id}`;
          await api(path, "DELETE", { version: conflict.existing.version });
          taken.delete(conflict.existing.name);
        }
        let name = item.name;
        if (conflict && conflictMode === "keep" && item.name) {
          name = nextAvailableName(item.name, taken, item.kind);
        }
        if (name) taken.add(name);
        const parentId =
          destination.type === "folder"
            ? destination.id
            : destination.id === "shared"
              ? "shared"
              : null;
        const renamed = name && name !== item.name ? { name } : {};
        if (copy) {
          if (item.kind === "folder")
            await api(`/files/folders/${item.id}/copy`, "POST", {
              parentId,
              ...renamed,
            });
          else
            await api(`/files/items/${item.id}/copy`, "POST", {
              parentType: destination.type === "folder" ? "folder" : "system",
              parentId: destination.id,
              ...renamed,
            });
        } else {
          const path =
            item.kind === "folder"
              ? `/files/folders/${item.id}`
              : `/files/items/${item.id}`;
          const body =
            item.kind === "folder"
              ? { parentId, version: item.version, ...renamed }
              : {
                  parentType:
                    destination.type === "folder" ? "folder" : "system",
                  parentId: destination.id,
                  version: item.version,
                  ...renamed,
                };
          await api(path, "PATCH", body);
        }
        count += 1;
      }
      if (count) {
        setNotice(
          t(copy ? "fileManager.copiedMany" : "fileManager.movedMany", {
            count,
          }),
        );
        if (!copy)
          setItemClipboard((old) => (old?.mode === "cut" ? null : old));
        clearSelection();
        await load();
        return true;
      }
      return false;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : copy
            ? t("fileManager.copyFailed")
            : t("fileManager.moveFailed"),
      );
      return false;
    }
  }
  function copySelected(mode: "copy" | "cut") {
    const targets = (
      selectedValues.length ? selectedValues : selection ? [selection] : []
    ).filter(
      (item) =>
        !item.value.locked && !(item.kind === "folder" && item.value.virtual),
    );
    if (!targets.length || (mode === "cut" && systemReadonly)) return;
    setItemClipboard({ mode, items: toDragItems(targets) });
    setNotice(
      mode === "cut"
        ? t("fileManager.cutMany", { count: targets.length })
        : t("fileManager.clipboardMany", { count: targets.length }),
    );
    setContextMenu(null);
  }
  async function pasteClipboard(destination: Location) {
    if (!itemClipboard?.items.length || systemReadonly) return;
    if (destination.type !== "system" && destination.type !== "folder") return;
    setContextMenu(null);
    const copy = itemClipboard.mode === "copy";
    const ok = await transferItems(itemClipboard.items, destination, copy);
    if (ok && !copy) setItemClipboard(null);
  }
  function contentPoint(event: { clientX: number; clientY: number }) {
    const root = contentRef.current;
    if (!root) return { x: 0, y: 0 };
    const rect = root.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + root.scrollLeft,
      y: event.clientY - rect.top + root.scrollTop,
    };
  }
  function applyMarquee(
    origin: { x: number; y: number },
    current: { x: number; y: number },
    additive: Set<string>,
  ) {
    const root = contentRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const hits = idsInMarquee(
      normalizeRect(origin, current),
      Array.from(root.querySelectorAll<HTMLElement>(".file-entry")).flatMap(
        (node) => {
          const id = node.dataset.id;
          if (!id) return [];
          const rect = node.getBoundingClientRect();
          return [
            {
              id,
              rect: {
                left: rect.left - rootRect.left + root.scrollLeft,
                top: rect.top - rootRect.top + root.scrollTop,
                right: rect.right - rootRect.left + root.scrollLeft,
                bottom: rect.bottom - rootRect.top + root.scrollTop,
              },
            },
          ];
        },
      ),
    );
    const next = new Set(additive);
    for (const id of hits) next.add(id);
    setSelectedIds(next);
    const last =
      allValues.find((value) => hits.includes(value.value.id)) ??
      columnSelectable(hits.at(-1));
    if (last) {
      setSelection(last);
      setAnchorId(last.value.id);
    }
  }
  function columnSelectable(id?: string) {
    if (!id) return null;
    for (const column of columnPages) {
      const folder = column.page.folders.find((item) => item.id === id);
      if (folder) return { kind: "folder" as const, value: folder };
      const file = column.page.files.find((item) => item.id === id);
      if (file) return { kind: "file" as const, value: file };
    }
    return allValues.find((value) => value.value.id === id) ?? null;
  }
  function startMarquee(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (
      (event.target as Element).closest(
        ".file-entry, .files-context-menu, input, textarea, .file-preview-panel",
      )
    )
      return;
    event.preventDefault();
    const origin = contentPoint(event);
    const additive =
      event.shiftKey || event.metaKey || event.ctrlKey
        ? new Set(selectedIds)
        : new Set<string>();
    if (!(event.shiftKey || event.metaKey || event.ctrlKey)) clearSelection();
    didMarqueeRef.current = false;
    setMarquee({ origin, current: origin });
    const move = (moveEvent: globalThis.MouseEvent) => {
      const current = contentPoint(moveEvent);
      if (Math.hypot(current.x - origin.x, current.y - origin.y) > 3)
        didMarqueeRef.current = true;
      setMarquee({ origin, current });
      applyMarquee(origin, current, additive);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setMarquee(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  function finishInternalDrag() {
    endInternalFileDrag();
    setDragActive(false);
    setDropTargetId(null);
    setDraggingIds(new Set());
  }
  function handleCanvasDragOver(
    event: DragEvent<HTMLElement>,
    destinationId?: string,
  ) {
    event.preventDefault();
    if (isInternalFileDrag(event.dataTransfer) || currentInternalFileDrag()) {
      event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
      if (destinationId) setDropTargetId(destinationId);
      return;
    }
    if (isExternalFileDrag(event.dataTransfer)) {
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    }
  }
  function handleCanvasDrop(
    event: DragEvent<HTMLElement>,
    destination: Location,
  ) {
    const items = readFileDrag(event.dataTransfer);
    const captured = items?.length
      ? null
      : captureExternalDrop(event.dataTransfer);
    event.preventDefault();
    event.stopPropagation();
    finishInternalDrag();
    if (items?.length) {
      void transferItems(items, destination, event.altKey);
      return;
    }
    if (
      !captured ||
      (destination.type !== "system" && destination.type !== "folder")
    )
      return;
    void materializeExternalDrop(captured)
      .then((dropped) => {
        if (!dropped.length) return;
        setUploadDestination(destination);
        setPendingUpload(
          dropped.map((entry) => ({
            file: entry.file ?? null,
            path: entry.path,
            selected: true,
          })),
        );
      })
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : t("fileManager.dropReadFailed"),
        ),
      );
  }
  async function transferTo(destination: Location) {
    if (!transfer) return;
    const items = toDragItems(transfer.items);
    const copy = transfer.mode === "copy";
    setTransfer(null);
    await transferItems(items, destination, copy);
  }
  const openContextMenu = (event: MouseEvent, target: Selectable) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.has(target.value.id)) {
      setSelectedIds(new Set([target.value.id]));
      setAnchorId(target.value.id);
      setSelection(target);
    }
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };
  const canAcceptDrop = (value: Selectable) =>
    value.kind === "folder" &&
    !value.value.virtual &&
    !value.value.locked &&
    !systemReadonly;
  const row = (
    value: Selection,
    key: string,
    options?: {
      openFolder?: (folder: FileFolder) => void;
      openFolderOnClick?: boolean;
      pathSelected?: boolean;
      ordered?: Selectable[];
      columnIndex?: number;
      lastColumn?: boolean;
    },
  ) => {
    if (!value) return null;
    const locked = value.value.locked || systemReadonly;
    const pathSelected = !!options?.pathSelected;
    const selected =
      selectedIds.has(value.value.id) &&
      !pathSelected &&
      (options?.columnIndex == null || !!options.lastColumn);
    const editing =
      renaming?.kind === value.kind && renaming.id === value.value.id;
    const openFolder = options?.openFolder ?? open;
    const dragging = draggingIds.has(value.value.id);
    const dropTarget = dropTargetId === value.value.id && canAcceptDrop(value);
    const movable =
      !locked && !(value.kind === "folder" && value.value.virtual);
    return (
      <button
        key={key}
        type="button"
        data-id={value.value.id}
        draggable={movable}
        className={`file-entry ${selected ? "selected" : ""} ${pathSelected ? "path-selected" : ""} ${locked ? "locked" : ""} ${value.kind === "folder" && value.value.virtual ? "system-folder-entry" : ""} ${dropTarget ? "drop-target" : ""} ${dragging ? "dragging" : ""}`}
        onClick={(event) => {
          select(value, event, options?.ordered);
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (options?.openFolderOnClick && value.kind === "folder")
            openFolder(value.value);
          else if (
            view === "columns" &&
            value.kind === "file" &&
            options?.columnIndex != null &&
            !options.lastColumn
          ) {
            const nextTrail = trail.slice(0, options.columnIndex + 1);
            if (!sameTrail(trail, nextTrail)) {
              setFuture([]);
              navigateTrail(nextTrail);
            }
          }
        }}
        onDoubleClick={() =>
          value.kind === "folder" ? openFolder(value.value) : activate(value)
        }
        onContextMenu={(event) => openContextMenu(event, value)}
        onDragStart={(event) => {
          if (!movable) {
            event.preventDefault();
            return;
          }
          const items = toDragItems(
            selectedIds.has(value.value.id) && selectedValues.length
              ? selectedValues
              : [value],
          );
          if (!items.length) {
            event.preventDefault();
            return;
          }
          event.stopPropagation();
          writeFileDrag(event.dataTransfer, items);
          event.dataTransfer.effectAllowed = "copyMove";
          setDraggingIds(new Set(items.map((item) => item.id)));
        }}
        onDragEnd={() => finishInternalDrag()}
        onDragOver={(event) => {
          if (!canAcceptDrop(value) || draggingIds.has(value.value.id)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = isExternalFileDrag(event.dataTransfer)
            ? "copy"
            : event.altKey
              ? "copy"
              : "move";
          setDropTargetId(value.value.id);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          if (dropTargetId === value.value.id) setDropTargetId(null);
        }}
        onDrop={(event) => {
          if (!canAcceptDrop(value)) return;
          handleCanvasDrop(event, {
            type: "folder",
            id: value.value.id,
            name: value.value.name,
          });
        }}
      >
        <span className="file-entry-icon">
          {value.kind === "folder" ? (
            <FolderGlyph
              icon={value.value.virtual ? value.value.icon : undefined}
            />
          ) : (
            <FileGlyph file={value.value} />
          )}
        </span>
        <span className="file-entry-copy">
          {editing ? (
            <input
              className="file-entry-rename"
              autoFocus
              value={renaming.draft}
              onChange={(event) =>
                setRenaming((old) =>
                  old ? { ...old, draft: event.target.value } : old,
                )
              }
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") void commitRename();
                if (event.key === "Escape") setRenaming(null);
              }}
              onBlur={() => void commitRename()}
            />
          ) : (
            <span
              className="file-entry-name"
              title={
                value.kind === "folder"
                  ? fileLocationLabel(value.value, t)
                  : value.value.name
              }
            >
              {visibleName(
                value.kind === "folder"
                  ? fileLocationLabel(value.value, t)
                  : value.value.name,
              )}
            </span>
          )}
          <span className="file-entry-type">
            {value.kind === "folder"
              ? value.value.virtual
                ? t("fileManager.systemFolder")
                : t("trash.folder")
              : extension(value.value.name).toUpperCase() || t("search.files")}
          </span>
        </span>
        {value.kind === "file" && (
          <span className="file-entry-detail">
            {formatSize(value.value.size)}
          </span>
        )}
        {view === "list" && (
          <>
            <span className="file-entry-date">
              {value.value.updated_at
                ? fileDate(value.value.updated_at, locale)
                : "—"}
            </span>
            <span className="file-entry-size">
              {value.kind === "file" ? formatSize(value.value.size) : "—"}
            </span>
            <span className="file-entry-kind">
              {value.kind === "folder"
                ? t("trash.folder")
                : extension(value.value.name).toUpperCase() ||
                  t("search.files")}
            </span>
          </>
        )}
      </button>
    );
  };
  const columnValues = (page: FilePage, isCurrent: boolean): Selectable[] => {
    const query = isCurrent ? search.trim().toLocaleLowerCase() : "";
    const folders = page.folders
      .filter(
        (folder) =>
          !(
            page.parent.type === "system" &&
            page.parent.id === "root" &&
            folder.virtual &&
            ["ai", "documents"].includes(folder.id)
          ),
      )
      .filter(
        (folder) => !query || folder.name.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) => {
        const special = { ai: 0, documents: 1, shared: 2 } as Record<
          string,
          number
        >;
        if (a.virtual || b.virtual)
          return (special[a.id] ?? 99) - (special[b.id] ?? 99);
        return a.name.localeCompare(b.name, textLocale);
      });
    const files = page.files
      .filter((file) => !query || file.name.toLocaleLowerCase().includes(query))
      .sort((a, b) =>
        sortMode === "size"
          ? b.size - a.size
          : sortMode === "updated"
            ? b.updated_at.localeCompare(a.updated_at)
            : a.name.localeCompare(b.name, textLocale),
      );
    return [
      ...folders.map((value) => ({ kind: "folder" as const, value })),
      ...files.map((value) => ({ kind: "file" as const, value })),
    ];
  };
  const renderedColumns = columnPages.length
    ? columnPages
    : data
      ? [{ location, page: data }]
      : [];
  return (
    <section
      className="files-page"
      onContextMenu={(event) => {
        if (
          (event.target as Element).closest(".file-entry, .files-context-menu")
        )
          return;
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, target: null });
      }}
    >
      <header className="files-toolbar">
        <div className="files-toolbar-actions">
          <button
            className="icon"
            onClick={back}
            disabled={trail.length <= 1}
            aria-label={t("fileManager.back")}
          >
            <ArrowLeft size={18} />
          </button>
          <button
            className="icon"
            onClick={forward}
            disabled={!future.length}
            aria-label={t("fileManager.forward")}
          >
            <ArrowRight size={18} />
          </button>
          <button
            className="icon"
            onClick={parentFolder}
            disabled={trail.length <= 1 && !sharedRoot && !atSystemRoot}
            aria-label={t("fileManager.parent")}
            title={
              trail.length <= 1 && sharedRoot
                ? t("fileManager.backShared")
                : atSystemRoot
                  ? t("fileManager.backPersonal")
                  : t("fileManager.parent")
            }
          >
            <ArrowUp size={18} />
          </button>
          <span className="files-divider" />
          <button
            onClick={createFolder}
            disabled={
              location.type === "document" ||
              (location.type === "system" &&
                !["root", "shared"].includes(location.id))
            }
          >
            <FolderPlus size={16} />
            {t("fileManager.newFolder")}
          </button>
          <div className="files-upload-control">
            <button
              onClick={(event) => {
                event.stopPropagation();
                setUploadMenu((old) => !old);
                setSortMenu(false);
              }}
              disabled={
                location.type === "document" ||
                location.id === "documents" ||
                location.id === "ai"
              }
            >
              <Upload size={16} />
              {t("fileManager.upload")}
            </button>
            {uploadMenu && (
              <div className="files-upload-menu">
                <button
                  onClick={() => {
                    setUploadMenu(false);
                    input.current?.click();
                  }}
                >
                  <File size={14} />
                  {t("create.chooseFile")}
                </button>
                <button
                  onClick={() => {
                    setUploadMenu(false);
                    folderInput.current?.click();
                  }}
                >
                  <Folder size={14} />
                  {t("fileManager.selectFolder")}
                </button>
              </div>
            )}
          </div>
          <input
            ref={input}
            hidden
            multiple
            type="file"
            onChange={(e) => selectUpload(e.target.files)}
          />
          <input
            ref={folderInput}
            hidden
            multiple
            type="file"
            onChange={(e) => selectUpload(e.target.files)}
            {...({ webkitdirectory: "", directory: "" } as Record<
              string,
              string
            >)}
          />
          {!sharedRoot && (
            <div className="files-system-control">
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setSystemMenu((old) => !old);
                  setUploadMenu(false);
                  setSortMenu(false);
                }}
              >
                <Folder size={16} />
                {t("fileManager.systemFiles")}
                <ChevronDown size={13} />
              </button>
              {systemMenu && (
                <div className="files-system-menu">
                  <button
                    onClick={() => openSystemFolder("ai", t("nav.assistant"))}
                  >
                    <Sparkles size={15} />
                    <span>
                      <strong>{t("nav.assistant")}</strong>
                      <small>{t("fileManager.aiFolderHelp")}</small>
                    </span>
                  </button>
                  <button
                    onClick={() =>
                      openSystemFolder("documents", t("recognition.documents"))
                    }
                  >
                    <Files size={15} />
                    <span>
                      <strong>{t("recognition.documents")}</strong>
                      <small>{t("fileManager.documentsHelp")}</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
          <span className="files-divider" />
          <div
            className="files-view-switch"
            role="group"
            aria-label={t("fileManager.viewMode")}
          >
            <button
              className={view === "grid" ? "active" : ""}
              onClick={() => chooseView("grid")}
              aria-label={t("fileManager.icons")}
            >
              <LayoutGrid size={17} />
            </button>
            <button
              className={view === "list" ? "active" : ""}
              onClick={() => chooseView("list")}
              aria-label={t("fileManager.list")}
            >
              <List size={18} />
            </button>
            <button
              className={view === "columns" ? "active" : ""}
              onClick={() => chooseView("columns")}
              aria-label={t("fileManager.columns")}
            >
              <Columns3 size={18} />
            </button>
          </div>
          <label className="files-extension-toggle">
            <input
              type="checkbox"
              checked={showExtensions}
              onChange={(event) => setShowExtensions(event.target.checked)}
            />
            <span>{t("fileManager.extension")}</span>
          </label>
          <div className="files-sort-control">
            <button
              className="files-sort"
              onClick={(event) => {
                event.stopPropagation();
                setSortMenu((old) => !old);
                setUploadMenu(false);
              }}
            >
              <span>{t("fileManager.sort")}</span>
              <strong>
                {sortMode === "name"
                  ? t("shell.name")
                  : sortMode === "updated"
                    ? t("home.modified")
                    : t("fileManager.size")}
              </strong>
              <ChevronDown size={14} />
            </button>
            {sortMenu && (
              <div className="files-sort-menu">
                {(
                  [
                    ["name", t("shell.name")],
                    ["updated", t("home.modified")],
                    ["size", t("fileManager.size")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={sortMode === value ? "is-active" : ""}
                    onClick={() => {
                      setSortMode(value);
                      setSortMenu(false);
                    }}
                  >
                    <span className="files-sort-check">
                      {sortMode === value ? <Check size={14} /> : null}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="files-item-count">
            {t("fileManager.itemCount", { count: items.length })}
          </span>
          <label className="files-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("fileManager.searchFolder")}
              aria-label={t("fileManager.searchFolder")}
            />
          </label>
          <button
            className="icon files-refresh"
            onClick={() => void load(location, { refreshColumns: true })}
            aria-label={t("admin.refresh")}
            title={t("admin.refresh")}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>
      {sharedRootFolder &&
        typeof document !== "undefined" &&
        document.getElementById("files-header-actions") &&
        createPortal(
          <button
            className="primary share-button files-header-share-button"
            data-permissions-trigger
            onClick={() => openShare(sharedRootFolder)}
          >
            <ShieldCheck size={16} />
            {t("share.title")}
          </button>,
          document.getElementById("files-header-actions")!,
        )}
      <div className={`files-body files-view-${view}`}>
        {(error || notice) && (
          <div className="files-toasts">
            {error && (
              <div className="files-error" role="alert">
                <span>{error}</span>
                <button
                  className="icon"
                  onClick={() => setError("")}
                  aria-label={t("fileManager.closeError")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {notice && (
              <div className="files-notice" role="status">
                <span>{notice}</span>
                <button
                  className="icon"
                  onClick={() => setNotice("")}
                  aria-label={t("fileManager.closeNotice")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </div>
        )}
        <div
          ref={contentRef}
          className={`files-content ${dragActive ? "drag-active" : ""} ${draggingIds.size ? "internal-drag" : ""} ${marquee ? "is-marquee" : ""}`}
          onClick={(event) => {
            if (didMarqueeRef.current) {
              didMarqueeRef.current = false;
              return;
            }
            if (
              !(event.target as Element).closest(
                ".file-entry, .file-preview-panel, .files-context-menu, button, input, label",
              )
            )
              clearSelection();
          }}
          onMouseDown={startMarquee}
          onDragEnter={(event) => {
            event.preventDefault();
            if (isExternalFileDrag(event.dataTransfer)) setDragActive(true);
          }}
          onDragOver={(event) => handleCanvasDragOver(event, location.id)}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) {
              setDragActive(false);
              setDropTargetId(null);
            }
          }}
          onDrop={(event) => handleCanvasDrop(event, location)}
        >
          {dragActive && !draggingIds.size && (
            <div className="files-drop-overlay">
              <Upload size={22} />
              <strong>{t("fileManager.drop")}</strong>
              <span>{t("fileManager.dropHelp")}</span>
            </div>
          )}
          {marquee && (
            <div
              className="files-marquee"
              style={{
                left: Math.min(marquee.origin.x, marquee.current.x),
                top: Math.min(marquee.origin.y, marquee.current.y),
                width: Math.abs(marquee.current.x - marquee.origin.x),
                height: Math.abs(marquee.current.y - marquee.origin.y),
              }}
            />
          )}
          {loading && !(view === "columns" && renderedColumns.length) ? (
            <p className="empty">{t("fileManager.loading")}</p>
          ) : !items.length &&
            !(view === "columns" && renderedColumns.length) ? (
            <div className="files-empty">
              <Folder size={38} />
              <strong>
                {search ? t("fileManager.noMatches") : t("shell.emptyList")}
              </strong>
              <span>
                {search
                  ? t("notes.emptySearchHint")
                  : t("fileManager.emptyHelp")}
              </span>
            </div>
          ) : (
            <>
              {view === "list" ? (
                <>
                  <div className="files-list-header">
                    <span>{t("shell.name")}</span>
                    <span>{t("fileManager.modifiedDate")}</span>
                    <span>{t("fileManager.size")}</span>
                    <span>{t("fileManager.kind")}</span>
                  </div>
                  <div className="files-list">
                    {visibleFolders.map((folder) =>
                      row({ kind: "folder", value: folder }, folder.id),
                    )}
                    {visibleFiles.map((file) =>
                      row({ kind: "file", value: file }, file.id),
                    )}
                  </div>
                </>
              ) : view === "grid" ? (
                <div className="files-grid">
                  {visibleFolders.map((folder) =>
                    row({ kind: "folder", value: folder }, folder.id),
                  )}
                  {visibleFiles.map((file) =>
                    row({ kind: "file", value: file }, file.id),
                  )}
                </div>
              ) : (
                <div className="files-columns-browser">
                  {renderedColumns.map((column, index) => {
                    const values = columnValues(
                      column.page,
                      index === renderedColumns.length - 1,
                    );
                    return (
                      <div
                        className={`files-column ${dropTargetId === column.location.id ? "drop-target" : ""}`}
                        key={`${column.location.type}:${column.location.id}`}
                        onDragOver={(event) => {
                          event.stopPropagation();
                          handleCanvasDragOver(event, column.location.id);
                        }}
                        onDrop={(event) =>
                          handleCanvasDrop(event, column.location)
                        }
                      >
                        <div className="files-column-title">
                          {fileLocationLabel(column.location, t)}
                        </div>
                        <div className="files-column-list">
                          {values.map((value) =>
                            row(
                              value,
                              `${column.location.id}:${value.value.id}`,
                              {
                                openFolder: (folder) =>
                                  openInColumn(folder, index),
                                openFolderOnClick: true,
                                pathSelected:
                                  trail[index + 1]?.id === value.value.id,
                                ordered: values,
                                columnIndex: index,
                                lastColumn:
                                  index === renderedColumns.length - 1,
                              },
                            ),
                          )}
                          {!values.length && (
                            <span className="files-column-empty">
                              {t("fileManager.emptyFolder")}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        {view === "columns" && (
          <PreviewPanel
            file={selection?.kind === "file" ? selection.value : null}
            close={() => setSelection(null)}
            openLarge={() => {
              if (selection?.kind === "file") setLargePreview(selection.value);
            }}
          />
        )}
      </div>
      {contextMenu && (
        <div
          className="files-context-menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 190),
            top: Math.min(contextMenu.y, window.innerHeight - 280),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.target ? (
            <>
              <button onClick={() => void showInfo(contextMenu.target!)}>
                {contextMenu.target.kind === "folder" ? (
                  <Folder size={14} />
                ) : (
                  <File size={14} />
                )}
                {t("fileManager.showInfo")}
              </button>
              {contextMenu.target.kind === "file" && (
                <>
                  <a href={fileUrl(contextMenu.target.value.id, true)}>
                    <Download size={14} />
                    {t("doc.download")}
                  </a>
                  <button
                    onClick={() =>
                      void chooseDocument(contextMenu.target!.value as FileItem)
                    }
                  >
                    <Files size={14} />
                    {t("fileManager.addToDocument")}
                  </button>
                  {canConvertToDocument(contextMenu.target.value) && (
                    <button
                      onClick={() => {
                        const file = contextMenu.target!.value as FileItem;
                        setContextMenu(null);
                        void convertToDocument(file);
                      }}
                    >
                      <FileText size={14} />
                      {t("fileManager.convert")}
                    </button>
                  )}
                </>
              )}
              <button
                disabled={!selectedValues.length && !contextMenu.target}
                onClick={() => copySelected("copy")}
              >
                <Copy size={14} />
                {t("fileManager.copy")}
              </button>
              {!systemReadonly && (
                <button
                  disabled={!!contextMenu.target.value.locked}
                  onClick={() => copySelected("cut")}
                >
                  <Scissors size={14} />
                  {t("fileManager.cut")}
                </button>
              )}
              <button
                disabled={!itemClipboard?.items.length || systemReadonly}
                onClick={() =>
                  void pasteClipboard(
                    contextMenu.target?.kind === "folder" &&
                      !contextMenu.target.value.virtual
                      ? {
                          type: "folder",
                          id: contextMenu.target.value.id,
                          name: contextMenu.target.value.name,
                        }
                      : location,
                  )
                }
              >
                <ClipboardPaste size={14} />
                {contextMenu.target.kind === "folder" &&
                !contextMenu.target.value.virtual
                  ? t("fileManager.pasteFolder")
                  : t("fileManager.paste")}
              </button>
              {!systemReadonly && (
                <>
                  <button
                    onClick={() => {
                      setTransfer({
                        mode: "move",
                        items: selectedValues.length
                          ? selectedValues
                          : [contextMenu.target!],
                      });
                      setContextMenu(null);
                    }}
                  >
                    <ArrowRight size={14} />
                    {t("fileManager.moveToDialog")}
                  </button>
                  <button
                    onClick={() => {
                      setTransfer({
                        mode: "copy",
                        items: selectedValues.length
                          ? selectedValues
                          : [contextMenu.target!],
                      });
                      setContextMenu(null);
                    }}
                  >
                    <Copy size={14} />
                    {t("fileManager.copyToDialog")}
                  </button>
                </>
              )}
              {systemReadonly && (
                <button onClick={() => void copyToMyFiles(contextMenu.target!)}>
                  <Copy size={14} />
                  {t("fileManager.copyPersonal")}
                </button>
              )}
              {contextMenu.target.kind === "folder" &&
                contextMenu.target.value.parent_id === "shared" && (
                  <button
                    onClick={() =>
                      void openShare(contextMenu.target!.value as FileFolder)
                    }
                  >
                    <Share2 size={14} />
                    {t("share.title")}
                  </button>
                )}
              {contextMenu.target.kind === "folder" && (
                <button
                  onClick={() => {
                    const folder = contextMenu.target!.value;
                    setContextMenu(null);
                    window.dispatchEvent(
                      new CustomEvent("doca-subscribe-library", {
                        detail: {
                          kind: "folder",
                          id: folder.id,
                          title: folder.name,
                        },
                      }),
                    );
                  }}
                >
                  <Sparkles size={14} />
                  {t("doc.collect")}
                </button>
              )}
              {contextMenu.target.kind === "file" && (
                <button
                  onClick={() => {
                    const file = contextMenu.target!.value as FileItem;
                    setContextMenu(null);
                    window.dispatchEvent(
                      new CustomEvent("doca-subscribe-library", {
                        detail: { kind: "file", id: file.id, title: file.name },
                      }),
                    );
                  }}
                >
                  <Sparkles size={14} />
                  {t("doc.collect")}
                </button>
              )}
              {!systemReadonly && (
                <>
                  <button onClick={() => void recognize(contextMenu.target)}>
                    <Sparkles size={14} />
                    {t("fileManager.generateDescription")}
                  </button>
                  <button
                    disabled={!!contextMenu.target.value.locked}
                    onClick={renameSelected}
                  >
                    <Pencil size={14} />
                    {t("shell.rename")}
                  </button>
                  <button
                    className="danger"
                    disabled={!!contextMenu.target.value.locked}
                    onClick={() => void requestTrash()}
                  >
                    <Trash2 size={14} />
                    {t("fileManager.trash")}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                disabled={!itemClipboard?.items.length || systemReadonly}
                onClick={() => void pasteClipboard(location)}
              >
                <ClipboardPaste size={14} />
                {t("fileManager.paste")}
              </button>
              <button onClick={() => void recognize(null)}>
                <Sparkles size={14} />
                {t("fileManager.generateAll")}
              </button>
              <button
                onClick={() => {
                  setContextMenu(null);
                  void createFolder();
                }}
                disabled={
                  location.type === "document" ||
                  (location.type === "system" &&
                    !["root", "shared"].includes(location.id))
                }
              >
                <FolderPlus size={14} />
                {t("fileManager.newFolder")}
              </button>
            </>
          )}
        </div>
      )}
      {largePreview && (
        <div
          className="file-large-preview-backdrop"
          role="presentation"
          onClick={() => setLargePreview(null)}
        >
          <section
            ref={largePreviewRef}
            className={`file-large-preview ${largePreview.mime.startsWith("image/") ? "image-only" : ""} ${previewFullscreen ? "is-fullscreen" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={t("fileManager.preview")}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <strong title={largePreview.name}>{largePreview.name}</strong>
              <div className="file-large-preview-actions">
                <button
                  className="icon"
                  onClick={() => void togglePreviewFullscreen()}
                  aria-label={
                    previewFullscreen
                      ? t("fileManager.exitFullscreen")
                      : t("fileManager.fullscreen")
                  }
                >
                  {previewFullscreen ? (
                    <Minimize2 size={17} />
                  ) : (
                    <Maximize2 size={17} />
                  )}
                </button>
                <button
                  className="icon"
                  onClick={() => {
                    if (document.fullscreenElement)
                      void document.exitFullscreen();
                    setLargePreview(null);
                  }}
                  aria-label={t("dialog.close")}
                >
                  <X size={18} />
                </button>
              </div>
            </header>
            <div
              className="file-large-preview-content"
              onDoubleClick={() => {
                if (largePreview.mime.startsWith("image/"))
                  void togglePreviewFullscreen();
              }}
            >
              <Preview file={largePreview} />
            </div>
          </section>
        </div>
      )}
      {documentPicker && (
        <div
          className="file-info-backdrop"
          role="presentation"
          onClick={() => setDocumentPicker(null)}
        >
          <section
            className="file-document-picker"
            role="dialog"
            aria-modal="true"
            aria-label={t("fileManager.addToDocument")}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong>{t("fileManager.addToDocument")}</strong>
                <span>{documentPicker.file.name}</span>
              </div>
              <button
                className="icon"
                onClick={() => setDocumentPicker(null)}
                aria-label={t("dialog.close")}
              >
                <X size={18} />
              </button>
            </header>
            <div className="file-document-picker-list">
              {documentPicker.documents.length ? (
                documentPicker.documents.map((document) => (
                  <button
                    key={document.id}
                    onClick={() => void addToDocument(document)}
                  >
                    <FileText size={17} />
                    <span>{document.name}</span>
                    <ChevronDown size={14} />
                  </button>
                ))
              ) : (
                <p>{t("fileManager.noDocuments")}</p>
              )}
            </div>
          </section>
        </div>
      )}
      {shareFolder && (
        <FolderPermissionPanel
          folder={shareFolder}
          close={() => setShareFolder(null)}
        />
      )}
      {transfer && (
        <FolderDestinationPicker
          mode={transfer.mode}
          allowSharedRoot={transfer.items.every(
            (item) => item.kind === "folder",
          )}
          close={() => setTransfer(null)}
          select={transferTo}
        />
      )}
      {recognitionConfirm && (
        <div
          className="file-info-backdrop"
          role="presentation"
          onClick={() => setRecognitionConfirm(null)}
        >
          <section
            className="file-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("fileManager.regenerate")}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong>{t("fileManager.regenerate")}</strong>
                <span>{t("fileManager.descriptionExists")}</span>
              </div>
              <button
                className="icon"
                onClick={() => setRecognitionConfirm(null)}
                aria-label={t("dialog.close")}
              >
                <X size={18} />
              </button>
            </header>
            <p>{t("fileManager.regenerateHelp")}</p>
            <footer>
              <button
                className="secondary"
                onClick={() => setRecognitionConfirm(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="primary"
                onClick={() => {
                  const target = recognitionConfirm.target;
                  setRecognitionConfirm(null);
                  void recognize(target, true);
                }}
              >
                {t("fileManager.continueGeneration")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {trashConfirm && (
        <div
          className="file-info-backdrop"
          role="presentation"
          onClick={() => setTrashConfirm(null)}
        >
          <section
            className="file-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("fileManager.trash")}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong>{t("fileManager.trash")}</strong>
                <span>{t("fileManager.restoreHelp")}</span>
              </div>
              <button
                className="icon"
                onClick={() => setTrashConfirm(null)}
                aria-label={t("dialog.close")}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              {trashConfirm.length > 1
                ? t("fileManager.trashQuestionMany", {
                    count: trashConfirm.length,
                  })
                : t("fileManager.trashQuestionOne", {
                    name: trashConfirm[0]!.value.name,
                  })}
            </p>
            <footer>
              <button
                className="secondary"
                onClick={() => setTrashConfirm(null)}
              >
                {t("common.cancel")}
              </button>
              <button className="primary" onClick={() => void executeTrash()}>
                {t("common.confirm")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {nameConflict && (
        <div
          className="file-info-backdrop"
          role="presentation"
          onClick={() => setNameConflict(null)}
        >
          <section
            className="file-confirm-dialog file-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("fileManager.nameConflict")}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong>{t("fileManager.nameConflict")}</strong>
                <span>
                  {nameConflict.conflicts.length === 1
                    ? t("fileManager.nameExists", {
                        name:
                          nameConflict.conflicts[0]!.item.name ??
                          t("shell.unnamed"),
                      })
                    : t("fileManager.conflictCount", {
                        count: nameConflict.conflicts.length,
                      })}
                </span>
              </div>
              <button
                className="icon"
                onClick={() => setNameConflict(null)}
                aria-label={t("dialog.close")}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              {t("fileManager.conflictHelp", {
                name: nextAvailableName(
                  nameConflict.conflicts[0]!.item.name || t("shell.unnamed"),
                  nameConflict.conflicts
                    .map((item) => item.existing.name)
                    .concat(nameConflict.conflicts[0]!.item.name || ""),
                  nameConflict.conflicts[0]!.item.kind,
                ),
              })}
            </p>
            {nameConflict.conflicts.length > 1 && (
              <ul>
                {nameConflict.conflicts.slice(0, 8).map((item) => (
                  <li key={item.item.id}>{item.item.name}</li>
                ))}
              </ul>
            )}
            <footer className="file-conflict-actions">
              <button
                className="danger"
                disabled={
                  nameConflict.conflicts.every(
                    (item) => item.existing.id === item.item.id,
                  ) ||
                  nameConflict.conflicts.some(
                    (item) =>
                      item.existing.id !== item.item.id &&
                      !!item.existing.locked,
                  )
                }
                onClick={() => {
                  const prompt = nameConflict;
                  setNameConflict(null);
                  void transferItems(
                    prompt.items,
                    prompt.destination,
                    prompt.copy,
                    "overwrite",
                  );
                }}
              >
                {t("fileManager.overwrite")}
              </button>
              <button
                className="primary"
                onClick={() => {
                  const prompt = nameConflict;
                  setNameConflict(null);
                  void transferItems(
                    prompt.items,
                    prompt.destination,
                    prompt.copy,
                    "keep",
                  );
                }}
              >
                {t("fileManager.keepBoth")}
              </button>
              <button
                className="secondary"
                onClick={() => setNameConflict(null)}
              >
                {t("common.cancel")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {pendingUpload && (
        <div className="file-upload-backdrop" role="presentation">
          <section
            className="file-upload-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("fileManager.confirmUpload")}
          >
            <header>
              <div>
                <strong>{t("fileManager.reviewUpload")}</strong>
                <span>{t("fileManager.uploadFilterHelp")}</span>
              </div>
              <button
                className="icon"
                onClick={() => setPendingUpload(null)}
                aria-label={t("common.cancel")}
              >
                <X size={18} />
              </button>
            </header>
            <div className="file-upload-filters">
              <span>{t("fileManager.fileTypes")}</span>
              {uploadExtensions.map((ext) => {
                const enabled = pendingUpload.some(
                  (entry) =>
                    entry.file &&
                    entry.selected &&
                    (extension(entry.file.name) ||
                      t("fileManager.noExtension")) === ext,
                );
                return (
                  <button
                    key={ext}
                    className={enabled ? "active" : ""}
                    onClick={() =>
                      setPendingUpload((old) =>
                        old
                          ? old.map((entry) =>
                              entry.file &&
                              (extension(entry.file.name) ||
                                t("fileManager.noExtension")) === ext
                                ? { ...entry, selected: !enabled }
                                : entry,
                            )
                          : null,
                      )
                    }
                  >
                    {enabled && <Check size={13} />}
                    {ext.toUpperCase()}
                  </button>
                );
              })}
            </div>
            <div className="file-upload-summary">
              <strong>
                {t("fileManager.uploadSelection", {
                  selected: pendingUpload.filter((entry) => entry.selected)
                    .length,
                  total: pendingUpload.length,
                })}
              </strong>
              <span>
                {pendingUpload
                  .filter((entry) => entry.selected && entry.file)
                  .reduce((size, entry) => size + (entry.file?.size ?? 0), 0)
                  ? t("fileManager.selectedUploads")
                  : t("fileManager.chooseUploads")}
              </span>
            </div>
            <div className="file-upload-list">
              {pendingUpload.slice(0, 120).map((entry, index) => (
                <label key={entry.path + index}>
                  <input
                    type="checkbox"
                    checked={entry.selected}
                    onChange={() =>
                      setPendingUpload((old) =>
                        old
                          ? old.map((item, i) =>
                              i === index
                                ? { ...item, selected: !item.selected }
                                : item,
                            )
                          : null,
                      )
                    }
                  />
                  <span title={entry.path}>{entry.path}</span>
                  <small>
                    {entry.file
                      ? formatSize(entry.file.size)
                      : t("trash.folder")}
                  </small>
                </label>
              ))}
            </div>
            <footer>
              <button
                className="secondary"
                onClick={() => setPendingUpload(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="primary"
                disabled={!pendingUpload.some((entry) => entry.selected)}
                onClick={() =>
                  void upload(pendingUpload.filter((entry) => entry.selected))
                }
              >
                <Upload size={15} />
                {t("fileManager.uploadSelected")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {uploadProgress && (
        <button
          className={`file-upload-progress status-${uploadProgress.status}`}
          onClick={() => navigateTrail(uploadProgress.trail)}
          title={t("fileManager.openDestination")}
        >
          <span className="file-upload-progress-icon">
            {uploadProgress.status === "done" ? (
              <Check size={17} />
            ) : uploadProgress.status === "error" ? (
              <X size={17} />
            ) : (
              <Upload size={17} />
            )}
          </span>
          <span className="file-upload-progress-copy">
            <strong>
              {uploadProgress.status === "done"
                ? t("fileManager.uploadComplete")
                : uploadProgress.status === "error"
                  ? t("fileManager.uploadInterrupted")
                  : t("fileManager.uploadProgress", {
                      current: uploadProgress.completed + 1,
                      total: uploadProgress.total,
                    })}
            </strong>
            <small title={uploadProgress.current}>
              {uploadProgress.current}
            </small>
            <i>
              <b
                style={{
                  width: `${uploadProgress.total ? ( uploadProgress.completed / uploadProgress.total) * 100 : 0}%`,
                }}
              />
            </i>
          </span>
          <span
            className="file-upload-progress-close"
            role="button"
            aria-label={t("fileManager.closeUpload")}
            onClick={(event) => {
              event.stopPropagation();
              setUploadProgress(null);
            }}
          >
            <X size={14} />
          </span>
        </button>
      )}
      <FileInfoPanel
        file={infoFile}
        close={() => setInfoFile(null)}
        convert={
          infoFile && canConvertToDocument(infoFile)
            ? (file) => void convertToDocument(file)
            : undefined
        }
      />
      <FolderInfoPanel
        folder={infoFolder?.folder ?? null}
        contents={infoFolder?.contents ?? null}
        close={() => setInfoFolder(null)}
      />
      {ai?.userId && !ai.open && (
        <button
          className="ai-document-trigger files-ai-trigger"
          title={t("fileManager.openFolderAi")}
          aria-label={t("fileManager.openFolderAi")}
          aria-expanded={ai.open}
          onClick={openCurrentFolderAI}
        >
          <Sparkles size={22} />
        </button>
      )}
    </section>
  );
}

export function SharedFoldersPage() {
  const { t, locale } = useI18n();

  const [items, setItems] = useState<SharedFolderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState(t("fileManager.newSharedFolder"));
  const [saving, setSaving] = useState(false);

  async function loadSharedFolders() {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ items: SharedFolderSummary[] }>(
        "/files/shared-folders",
      );
      setItems(result.items);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("fileManager.sharedLoadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const token = new URLSearchParams(
      window.location.hash.split("?")[1] ?? "",
    ).get("token");
    if (!token) {
      void loadSharedFolders();
      return;
    }
    setLoading(true);
    void api<{ id: string; name: string }>("/files/share/redeem", "POST", {
      token,
    })
      .then((folder) => {
        window.location.hash = `/shared-files/${folder.id}?name=${encodeURIComponent(folder.name)}`;
      })
      .catch((e) => {
        setError(
          e instanceof Error ? e.message : t("fileManager.sharedJoinFailed"),
        );
        setLoading(false);
      });
  }, []);

  async function createSharedFolder() {
    const name = draftName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const folder = await api<FileFolder>("/files/folders", "POST", {
        name,
        parentId: "shared",
      });
      setCreating(false);
      window.location.hash = `/shared-files/${folder.id}?name=${encodeURIComponent(folder.name)}`;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("fileManager.sharedCreateFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  function openSharedFolder(folder: SharedFolderSummary) {
    window.location.hash = `/shared-files/${folder.id}?name=${encodeURIComponent(folder.name)}`;
  }

  return (
    <section className="shared-folders-page">
      <header className="shared-folders-header">
        <div>
          <h2>{t("nav.sharedFiles")}</h2>
          <p>{t("fileManager.sharedIntro")}</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setDraftName(t("fileManager.newSharedFolder"));
            setCreating(true);
          }}
        >
          <FolderPlus size={16} />
          {t("fileManager.newSharedFolder")}
        </button>
      </header>
      {error && (
        <div className="files-error" role="alert">
          <span>{error}</span>
          <button
            className="icon"
            onClick={() => setError("")}
            aria-label={t("fileManager.closeError")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div
        className="shared-folders-table"
        role="table"
        aria-label={t("fileManager.sharedList")}
      >
        <div className="shared-folder-row shared-folder-table-head" role="row">
          <span>{t("fileManager.folderName")}</span>
          <span>{t("fileManager.folderId")}</span>
          <span>{t("fileManager.owner")}</span>
          <span>{t("fileManager.myPermission")}</span>
          <span>{t("home.modified")}</span>
        </div>
        {loading ? (
          <p className="empty">{t("fileManager.sharedLoading")}</p>
        ) : (
          items.map((folder) => (
            <button
              className="shared-folder-row"
              role="row"
              key={folder.id}
              onDoubleClick={() => openSharedFolder(folder)}
              onClick={() => openSharedFolder(folder)}
            >
              <span className="shared-folder-name">
                <FolderGlyph />
                <strong>{folder.name}</strong>
              </span>
              <code title={folder.id}>{folder.id}</code>
              <span className="shared-folder-owner">
                {folder.owner ? (
                  <UserBadge
                    passive
                    id={folder.owner.id}
                    name={folder.owner.display_name}
                  />
                ) : (
                  "—"
                )}
              </span>
              <span className={`shared-folder-role role-${folder.role}`}>
                {folder.role === "owner"
                  ? t("search.owner")
                  : folder.role === "admin"
                    ? t("admin.badge")
                    : t("fileManager.reader")}
              </span>
              <span>
                {folder.updated_at ? fileDate(folder.updated_at, locale) : "—"}
              </span>
            </button>
          ))
        )}
        {!loading && !items.length && (
          <div className="shared-folders-empty">
            <Share2 size={28} />
            <strong>{t("fileManager.noShared")}</strong>
            <span>{t("fileManager.sharedHelp")}</span>
          </div>
        )}
      </div>
      {creating && (
        <div
          className="file-info-backdrop"
          role="presentation"
          onClick={() => !saving && setCreating(false)}
        >
          <form
            className="shared-folder-create-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void createSharedFolder();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <strong>{t("fileManager.newSharedFolder")}</strong>
                <span>{t("fileManager.createSharedHelp")}</span>
              </div>
              <button
                type="button"
                className="icon"
                onClick={() => setCreating(false)}
                aria-label={t("dialog.close")}
              >
                <X size={18} />
              </button>
            </header>
            <label>
              <span>{t("fileManager.folderName")}</span>
              <input
                autoFocus
                value={draftName}
                maxLength={255}
                onChange={(event) => setDraftName(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <footer>
              <button
                type="button"
                className="secondary"
                onClick={() => setCreating(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={saving || !draftName.trim()}
              >
                <FolderPlus size={15} />
                {saving ? t("fileManager.creating") : t("fileManager.create")}
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}

export function FolderFilePicker({
  close,
  select,
  selectFolder,
  accept,
}: {
  close: () => void;
  select?: (file: FileItem) => Promise<void> | void;
  selectFolder?: (folder: { id: string; name: string }) => Promise<void> | void;
  accept?: (file: FileItem) => boolean;
}) {
  const { t, locale } = useI18n();

  const roots: Location[] = [
    root,
    { type: "system", id: "shared", name: t("nav.sharedFiles") },
    { type: "system", id: "ai", name: t("nav.assistant"), locked: true },
    {
      type: "system",
      id: "documents",
      name: t("recognition.documents"),
      locked: true,
    },
  ];
  const [trail, setTrail] = useState<Location[]>([root]);
  const [columns, setColumns] = useState<
    Array<{ location: Location; page: FilePage }>
  >([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<FileItem | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    if (query.trim()) {
      const timer = setTimeout(
        () =>
          void api<{
            items: Array<{
              id: string;
              name: string;
              mime: string;
              size: number;
              updatedAt: string;
              description?: string | null;
            }>;
          }>(
            `/files/search?q=${encodeURIComponent(query.trim())}&limit=50`,
            "GET",
            undefined,
            controller.signal,
          )
            .then(({ items }) =>
              setResults(
                items.map((item) => ({
                  id: item.id,
                  name: item.name,
                  mime: item.mime,
                  size: item.size,
                  updated_at: item.updatedAt,
                  created_at: item.updatedAt,
                  version: 1,
                  locked: false,
                  ai_description: item.description ?? null,
                  preview_url: fileUrl(item.id),
                })),
              ),
            )
            .catch((e) => {
              if (e.name !== "AbortError") setError(e.message);
            }),
        180,
      );
      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    }
    setResults(null);
    void Promise.all(
      trail.map(async (location) => ({
        location,
        page: await api<FilePage>(
          `/files?parentType=${location.type}&parentId=${encodeURIComponent(location.id)}`,
          "GET",
          undefined,
          controller.signal,
        ),
      })),
    )
      .then(setColumns)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [query, trail]);
  async function confirm(file = chosen) {
    if (!file || !select) return;
    setBusy(true);
    try {
      await select(file);
      close();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("fileManager.selectionFailed"),
      );
      setBusy(false);
    }
  }
  const current = trail[trail.length - 1] ?? root;
  async function confirmFolder() {
    if (!selectFolder) return;
    setBusy(true);
    try {
      await selectFolder({ id: current.id, name: current.name });
      close();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("fileManager.selectionFailed"),
      );
      setBusy(false);
    }
  }
  return createPortal(
    <div
      className="file-info-backdrop folder-file-picker-backdrop"
      role="presentation"
      onClick={close}
    >
      <section
        className="folder-file-picker finder-picker"
        role="dialog"
        aria-modal="true"
        aria-label={
          selectFolder
            ? t("fileManager.selectFolder")
            : t("fileManager.chooseDoca")
        }
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>
              {selectFolder
                ? t("fileManager.selectFolder")
                : t("fileManager.chooseDoca")}
            </strong>
            <span>
              {selectFolder
                ? t("fileManager.folderAiHelp")
                : t("fileManager.selectHelp")}
            </span>
          </div>
          <button
            className="icon"
            onClick={close}
            aria-label={t("dialog.close")}
          >
            <X size={18} />
          </button>
        </header>
        <div className="folder-file-picker-toolbar">
          <button
            className="icon"
            disabled={trail.length <= 1}
            onClick={() => setTrail((old) => old.slice(0, -1))}
          >
            <ArrowLeft size={17} />
          </button>
          <nav>
            {trail.map((item, index) => (
              <button
                key={`${item.type}:${item.id}`}
                onClick={() => setTrail((old) => old.slice(0, index + 1))}
              >
                {index ? "/ " : ""}
                {fileLocationLabel(item, t)}
              </button>
            ))}
          </nav>
          <label>
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("fileManager.searchFiles")}
            />
          </label>
        </div>
        {error && (
          <div className="files-error">
            <span>{error}</span>
            <button
              className="icon"
              onClick={() => setError("")}
              aria-label={t("fileManager.closeError")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="finder-picker-main">
          <aside>
            {roots.map((item) => (
              <button
                key={item.id}
                className={trail[0]?.id === item.id ? "active" : ""}
                onClick={() => {
                  setChosen(null);
                  setTrail([item]);
                }}
              >
                <HardDrive size={15} />
                <span>{fileLocationLabel(item, t)}</span>
              </button>
            ))}
          </aside>
          <div className="finder-picker-columns">
            {query.trim() ? (
              <div className="finder-picker-column">
                {(results ?? [])
                  .filter((file) => !accept || accept(file))
                  .map((file) => (
                    <button
                      key={file.id}
                      className={chosen?.id === file.id ? "selected" : ""}
                      onClick={() => setChosen(file)}
                      onDoubleClick={() => void confirm(file)}
                    >
                      <FileGlyph file={file} />
                      <span>
                        <strong>{file.name}</strong>
                        <small>{formatSize(file.size)}</small>
                      </span>
                    </button>
                  ))}
              </div>
            ) : (
              columns.map((column, index) => (
                <div
                  className="finder-picker-column"
                  key={`${column.location.type}:${column.location.id}`}
                >
                  {column.page.folders.map((folder) => (
                    <button
                      key={folder.id}
                      className={
                        trail[index + 1]?.id === folder.id ? "selected" : ""
                      }
                      onClick={() => {
                        setChosen(null);
                        setTrail((old) => [
                          ...old.slice(0, index + 1),
                          {
                            type: folder.type,
                            id: folder.id,
                            name: folder.name,
                            locked: folder.locked,
                          },
                        ]);
                      }}
                    >
                      <FolderGlyph icon={folder.icon} />
                      <span>
                        <strong>{folder.name}</strong>
                        <small>
                          {folder.virtual
                            ? t("fileManager.systemFolder")
                            : t("trash.folder")}
                        </small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  {column.page.files
                    .filter((file) => !accept || accept(file))
                    .map((file) => (
                      <button
                        key={file.id}
                        className={chosen?.id === file.id ? "selected" : ""}
                        onClick={() => setChosen(file)}
                        onDoubleClick={() => void confirm(file)}
                      >
                        <FileGlyph file={file} />
                        <span>
                          <strong>{file.name}</strong>
                          <small>{formatSize(file.size)}</small>
                        </span>
                      </button>
                    ))}
                  {!column.page.folders.length &&
                    !column.page.files.filter((file) => !accept || accept(file))
                      .length && <p>{t("fileManager.emptyPicker")}</p>}
                </div>
              ))
            )}
          </div>
        </div>
        <footer>
          <span>
            {selectFolder
              ? t("fileManager.currentPath", {
                  path: trail
                    .map((item) => fileLocationLabel(item, t))
                    .join(" / "),
                })
              : chosen
                ? chosen.name
                : t("fileManager.chooseFile")}
          </span>
          <div>
            <button className="secondary" onClick={close}>
              {t("common.cancel")}
            </button>
            {selectFolder ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void confirmFolder()}
              >
                {busy
                  ? t("fileManager.adding")
                  : t("fileManager.chooseCurrent", {
                      name: fileLocationLabel(current, t),
                    })}
              </button>
            ) : (
              <button
                className="primary"
                disabled={!chosen || busy}
                onClick={() => void confirm()}
              >
                {busy ? t("fileManager.copying") : t("fileManager.select")}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function FolderDestinationPicker({
  mode,
  allowSharedRoot,
  close,
  select,
}: {
  mode: "move" | "copy";
  allowSharedRoot: boolean;
  close: () => void;
  select: (location: Location) => Promise<void> | void;
}) {
  const { t, locale } = useI18n();

  const roots: Location[] = [
    root,
    { type: "system", id: "shared", name: t("nav.sharedFiles") },
  ];
  const [trail, setTrail] = useState<Location[]>([root]);
  const [columns, setColumns] = useState<
    Array<{ location: Location; page: FilePage }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = trail[trail.length - 1] ?? root;
  useEffect(() => {
    let active = true;
    void Promise.all(
      trail.map(async (location) => ({
        location,
        page: await api<FilePage>(
          `/files?parentType=${location.type}&parentId=${encodeURIComponent(location.id)}`,
        ),
      })),
    )
      .then((pages) => active && setColumns(pages))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [trail]);
  const invalidSharedRoot =
    current.type === "system" && current.id === "shared" && !allowSharedRoot;
  return createPortal(
    <div
      className="file-info-backdrop folder-file-picker-backdrop"
      role="presentation"
      onClick={close}
    >
      <section
        className="folder-file-picker finder-picker destination-picker"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>
              {mode === "copy"
                ? t("fileManager.copyTo")
                : t("fileManager.moveTo")}
            </strong>
            <span>{t("fileManager.destinationHelp")}</span>
          </div>
          <button className="icon" onClick={close}>
            <X size={18} />
          </button>
        </header>
        {error && (
          <div className="files-error">
            <span>{error}</span>
          </div>
        )}
        <div className="finder-picker-main">
          <aside>
            {roots.map((item) => (
              <button
                key={item.id}
                className={trail[0]?.id === item.id ? "active" : ""}
                onClick={() => setTrail([item])}
              >
                <HardDrive size={15} />
                <span>{fileLocationLabel(item, t)}</span>
              </button>
            ))}
          </aside>
          <div className="finder-picker-columns">
            {columns.map((column, index) => (
              <div className="finder-picker-column" key={column.location.id}>
                {column.page.folders.map((folder) => (
                  <button
                    key={folder.id}
                    className={
                      trail[index + 1]?.id === folder.id ? "selected" : ""
                    }
                    onClick={() =>
                      setTrail((old) => [
                        ...old.slice(0, index + 1),
                        { type: folder.type, id: folder.id, name: folder.name },
                      ])
                    }
                  >
                    <FolderGlyph icon={folder.icon} />
                    <span>
                      <strong>{folder.name}</strong>
                      <small>{t("trash.folder")}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
                {!column.page.folders.length && (
                  <p>{t("fileManager.emptyPicker")}</p>
                )}
              </div>
            ))}
          </div>
        </div>
        <footer>
          <span>
            {invalidSharedRoot
              ? t("fileManager.sharedDestinationHelp")
              : t("fileManager.destinationPath", {
                  path: trail
                    .map((item) => fileLocationLabel(item, t))
                    .join(" / "),
                })}
          </span>
          <div>
            <button className="secondary" onClick={close}>
              {t("common.cancel")}
            </button>
            <button
              className="primary"
              disabled={busy || invalidSharedRoot}
              onClick={async () => {
                setBusy(true);
                try {
                  await select(current);
                } catch (e) {
                  setError(e instanceof Error ? e.message : t("dialog.failed"));
                  setBusy(false);
                }
              }}
            >
              {busy
                ? t("fileManager.processing")
                : mode === "copy"
                  ? t("fileManager.copyHere")
                  : t("fileManager.moveHere")}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function FileSourceDialog({
  title,
  close,
  chooseLocal,
  chooseDoca,
  chooseFolder,
  chooseLocalFolder,
}: {
  title?: string;
  close: () => void;
  chooseLocal: () => void;
  chooseDoca: () => void;
  chooseFolder?: () => void;
  chooseLocalFolder?: () => void;
}) {
  const { t, locale } = useI18n();

  return createPortal(
    <div
      className="file-info-backdrop file-source-backdrop"
      role="presentation"
      onClick={close}
    >
      <section
        className="file-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? t("fileManager.addFile")}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{title ?? t("fileManager.addFile")}</strong>
          <button className="icon" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div>
          <button
            onClick={() => {
              close();
              chooseDoca();
            }}
          >
            <span className="source-icon doca">
              <Folder size={24} />
            </span>
            <span>
              <strong>{t("fileManager.chooseDocaFiles")}</strong>
              <small>{t("fileManager.browseHelp")}</small>
            </span>
            <ChevronDown size={16} />
          </button>
          {chooseFolder && (
            <button
              onClick={() => {
                close();
                chooseFolder();
              }}
            >
              <span className="source-icon doca">
                <Folder size={24} />
              </span>
              <span>
                <strong>{t("fileManager.chooseAiFolder")}</strong>
                <small>{t("fileManager.aiFolderScope")}</small>
              </span>
              <ChevronDown size={16} />
            </button>
          )}
          <button
            onClick={() => {
              close();
              chooseLocal();
            }}
          >
            <span className="source-icon local">
              <Upload size={24} />
            </span>
            <span>
              <strong>{t("fileManager.uploadLocal")}</strong>
              <small>{t("fileManager.uploadLocalHelp")}</small>
            </span>
            <ChevronDown size={16} />
          </button>
          {chooseLocalFolder && (
            <button
              onClick={() => {
                close();
                chooseLocalFolder();
              }}
            >
              <span className="source-icon local">
                <Upload size={24} />
              </span>
              <span>
                <strong>{t("fileManager.uploadFolder")}</strong>
                <small>{t("fileManager.uploadFolderHelp")}</small>
              </span>
              <ChevronDown size={16} />
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
