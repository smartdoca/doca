import { AIChoiceCard } from "@web/features/ai/ai-choice-card.js";
import { aiTimeline, taskDuration } from "@web/features/ai/ai-timeline.js";
import { AIGeneratedImage } from "@web/features/ai/ai-generated-image.js";
import { FolderDeliveryCard } from "@web/features/ai/ai-folder-card.js";
import { FileDeliveryCard } from "@web/features/ai/ai-file-card.js";
import { renderPluginAIBlock } from "@web/plugins/registry.js";
import { readPageState, writePageState } from "@web/features/page-state/client.js";
import { createPortal } from "react-dom";
import { applyProgressPatch, type AIProgress, type FileDelivery, type FolderDelivery, type MailComposeDraft, type MailDelivery, type MailOpenTarget } from "@core/modules/ai/progress.js";
import { withSessionHash } from "@web/features/ai/ai-folder-mentions.js";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Sparkles,
  Plus,
  PanelRightClose,
  Maximize2,
  FileText,
  Search,
  WandSparkles,
  Folder,
  FolderOpen,
  File as FileIcon,
  Settings,
  MessageSquare,
  Archive,
  Trash2,
  AtSign,
  Paperclip,
  Globe,
  ShieldCheck,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  SquareCheck,
} from "lucide-react";
import { api, uploadFile, assetUrl, fileUrl, type FileItem, type Resource } from "@web/shared/api.js";
import { FileSourceDialog, FolderFilePicker } from "@web/features/files/files.js";
import {
  captureExternalDrop,
  isExternalFileDrag,
  isInternalFileDrag,
  materializeExternalDrop,
  readFileDrag,
  type DroppedUpload,
} from "@web/features/files/file-interactions.js";
import { uploadDroppedTree } from "@web/features/files/upload-tree.js";
import {
  Actions,
  Attachments,
  Bubble,
  Conversations,
  FileCard,
  Prompts,
  Sender,
  Sources,
  Think,
  ThoughtChain,
  Welcome,
} from "@ant-design/x";
import type {
  BubbleItemType,
  BubbleListRef,
} from "@ant-design/x/es/bubble/interface";
import {
  Alert,
  Button,
  Checkbox,
  ConfigProvider,
  Collapse,
  Empty,
  Input,
  Modal,
  Select,
  Popover,
  Spin,
} from "antd";
import { antdLocale } from "@web/shared/antd-locale.js";
import { useI18n } from "@web/shared/i18n.js";
import type {
  SenderRef,
  SlotConfigType,
} from "@ant-design/x/es/sender/interface";
import type { AIReference } from "@core/workflows/ai-documents.js";
import type { Attachment, AttachmentsRef } from "@ant-design/x/es/attachments";
import { useAI, type QuickNoteReference } from "@web/features/ai/ai-context.js";
import {
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  panelWidthMax,
  readPanelWidth,
  writePanelWidth,
} from "@web/features/ai/ai-side-open.js";
import { AIUserSettings } from "@web/features/ai/ai-user-settings.js";
import { AIReferenceTag, referenceLabel } from "@web/features/ai/ai-reference-tag.js";
import { QuickNoteTag } from "@web/features/ai/ai-note-tag.js";
import { referenceTextParts } from "@web/features/ai/ai-reference-text.js";
import { SearchPanel } from "@web/features/search/search.js";
import { AIQuestionNav } from "@web/features/ai/ai-question-nav.js";
import { AIPendingQueue } from "@web/features/ai/ai-pending-queue.js";
import {
  DRAFT_QUEUE_KEY,
  INITIAL_RENDER_QUESTIONS,
  PENDING_QUEUE_EVENT,
  RENDER_EXPAND_QUESTIONS,
  adoptDraftQueue,
  activeQuestionFromPositions,
  formatContextTokens,
  loadPendingQueue,
  type ExplorerTarget,
  promotePendingItem,
  questionsToReveal,
  userQuestions,
  windowedMessages,
  writePendingQueue,
  type PendingSendItem,
} from "@web/features/ai/ai-session-ux.js";
import {
  readConversationCache,
  writeConversationCache,
  readSessionListCache,
  writeSessionListCache,
} from "@web/features/ai/ai-local-cache.js";
import "@web/features/ai/ai.css";
import { DocumentScrollButtons } from "@web/features/documents/document-scroll-buttons.js";
const AIAnswer = lazy(() => import("@web/features/ai/ai-markdown.js"));
const documentFormats: Record<string, string> = {
  rich_text: "文档",
  markdown: "Markdown",
  spreadsheet: "表格",
  canvas: "画板",
  presentation: "演示文稿",
};
function jobFolderDeliveries(job: {
  progress?: AIProgress | null;
}): FolderDelivery[] {
  const folders = new Map<string, FolderDelivery>();
  for (const event of job.progress?.events ?? []) {
    if (event.folder?.href) folders.set(event.folder.id, event.folder);
  }
  return [...folders.values()];
}
function jobMailDeliveries(job: {
  progress?: AIProgress | null;
}): MailDelivery[] {
  const mails = new Map<string, MailDelivery>();
  for (const event of job.progress?.events ?? []) {
    if (event.mail?.href) mails.set(`${event.mail.mailboxId}:${event.mail.id}`, event.mail);
  }
  return [...mails.values()];
}
function jobFileDeliveries(job: {
  progress?: AIProgress | null;
}): FileDelivery[] {
  const files = new Map<string, FileDelivery>();
  for (const event of job.progress?.events ?? []) {
    if (event.file?.id) files.set(event.file.id, event.file);
  }
  return [...files.values()];
}
function WebSources({
  sources,
}: {
  sources: { title: string; url: string }[];
}) {
  if (!sources.length) return null;
  return (
    <Sources
      title={`联网资料 · ${sources.length} 个来源`}
      defaultExpanded={false}
      items={sources.map((s) => ({
        key: s.url,
        title: s.title,
        url: s.url,
      }))}
    />
  );
}
const AIBubbleList = memo(function AIBubbleList({
  items,
  listRef,
}: {
  items: BubbleItemType[];
  listRef: RefObject<BubbleListRef | null>;
}) {
  return (
    <Bubble.List
      ref={listRef}
      className="ai-bubble-list"
      classNames={{ scroll: "ai-bubble-scroll" }}
      items={items}
      autoScroll
      styles={{ scroll: { padding: 0 } }}
    />
  );
});
function AIChatHeader({
  full,
  children,
}: {
  full: boolean;
  children: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(full ? document.getElementById("ai-header-slot") : null);
  }, [full]);
  const header = (
    <header className={`ai-chat-header ${full ? "ai-page-header" : ""}`}>
      {children}
    </header>
  );
  return full && slot ? createPortal(header, slot) : header;
}
type Session = {
  id: string;
  title: string;
  model_id: string | null;
  resource_ids: string;
  archived: number;
  restricted?: boolean;
  updated_at?: string;
  running?: boolean;
  awaitingApproval?: boolean;
  executionFailed?: boolean;
};
type Options = {
  enabled: boolean;
  memoryAvailable: boolean;
  webSearchAvailable: boolean;
  defaultModel: string;
  preferences: { default_model: string | null; memory_enabled: number };
  models: {
    id: string;
    name: string;
    inputRate: number;
    outputRate: number;
    cacheRate: number;
    maxInput?: number;
    vision: boolean;
    pdf: boolean;
  }[];
};
type ChatFile = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  extractStatus?: "pending" | "ready" | "failed";
  preview?: string;
  description?: string;
  sourceFileId?: string;
  sourceName?: string;
};
function asChatFile(
  file: ChatFile,
  extra?:
    | ChatFile["extractStatus"]
    | {
        extractStatus?: ChatFile["extractStatus"];
        preview?: string;
        description?: string;
      },
): ChatFile {
  const extractStatus = typeof extra === "object" ? extra?.extractStatus : extra;
  const preview = typeof extra === "object" ? extra?.preview : file.preview;
  const description = typeof extra === "object" ? extra?.description : file.description;
  return {
    id: file.id,
    filename: file.filename,
    mime: file.mime,
    size: file.size,
    sourceFileId: file.sourceFileId,
    sourceName: file.sourceName,
    preview: preview ?? file.preview,
    description: description ?? file.description,
    extractStatus:
      extractStatus ??
      file.extractStatus ??
      (file.mime.startsWith("image/") ? "ready" : "pending"),
  };
}
function sourceFileNote(file: ChatFile) {
  if (!file.sourceFileId) return undefined;
  return file.mime.startsWith("image/")
    ? "已发送图片，也可操作原文件"
    : "已发送文件内容，也可操作原文件";
}
function isComposerEditable(target: EventTarget | null) {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return !!el?.closest("[contenteditable='true'], .ant-sender-input");
}
function insertComposerPlainText(sender: SenderRef | null, text: string) {
  const value = text
    .replace(/\u200B/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const editable = sender?.inputElement;
  if (range && editable && editable.contains(range.commonAncestorContainer)) {
    range.deleteContents();
    const node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    editable.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
    );
    return;
  }
  sender?.insert([{ type: "text", value }], "cursor");
}
function composerFile(
  file: ChatFile,
  uid = file.id,
): Attachment<ChatFile> {
  const pending = file.extractStatus === "pending";
  return {
    uid,
    name: file.filename,
    size: file.size,
    status: pending ? "uploading" : "done",
    percent: pending ? 100 : undefined,
    description: pending
      ? "解析中，完成后即可发送"
      : file.description ||
        file.preview ||
        (file.extractStatus === "failed"
          ? "解析未完全成功，仍可发送"
          : sourceFileNote(file)),
    response: file,
    url: assetUrl(file.id),
    thumbUrl: file.mime.startsWith("image/") ? assetUrl(file.id) : undefined,
  };
}
type Conversation = {
  session: Session;
  resources?: { id: string; title: string; format: string; kind: string }[];
  messages: {
    id: string;
    role: string;
    text: string;
    reasoning?: string;
    streaming?: boolean;
    createdAt?: string;
    attachments?: ChatFile[];
    explorer?: ExplorerTarget[];
    references?: AIReference[];
  }[];
  jobs: {
    id: string;
    status: string;
    error: string;
    created_at?: string;
    updated_at?: string;
    progress?: AIProgress;
  }[];
  operations: {
    id: string;
    job_id: string;
    result: any;
    created_at?: string;
  }[];
  hasMore: boolean;
  contextTokens?: number | null;
};
function SessionStatusBadges({ session }: { session: Session }) {
  return (
    <>
      {session.awaitingApproval && (
        <span className="ai-session-status pending" title="会话有待审批操作">
          待审批
        </span>
      )}
      {session.executionFailed && (
        <span className="ai-session-status failed" title="上一次执行因系统问题失败">
          执行失败
        </span>
      )}
    </>
  );
}
function usePanelWidth() {
  const viewport = () =>
    typeof window === "undefined" ? 1280 : window.innerWidth;
  const [width, setWidth] = useState(() => readPanelWidth(viewport()));
  const widthRef = useRef(width);
  const dragging = useRef(false);
  if (!dragging.current) widthRef.current = width;
  useEffect(() => {
    const fit = () => {
      const next = clampPanelWidth(widthRef.current, window.innerWidth);
      widthRef.current = next;
      setWidth(next);
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const panel = handle.parentElement;
    handle.setPointerCapture(event.pointerId);
    dragging.current = true;
    panel?.classList.add("is-resizing");
    document.body.classList.add("ai-panel-resizing");
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const apply = (clientX: number) => {
      const next = clampPanelWidth(
        startWidth + startX - clientX,
        window.innerWidth,
      );
      widthRef.current = next;
      if (panel instanceof HTMLElement) panel.style.width = `${next}px`;
      return next;
    };
    const move = (e: PointerEvent) => {
      apply(e.clientX);
    };
    const finish = (e: PointerEvent) => {
      const next = apply(e.clientX);
      writePanelWidth(next, window.innerWidth);
      dragging.current = false;
      setWidth(next);
      panel?.classList.remove("is-resizing");
      document.body.classList.remove("ai-panel-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };
  const nudge = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
    if (!step) return;
    event.preventDefault();
    const next = writePanelWidth(
      widthRef.current + (event.shiftKey ? step * 4 : step),
      window.innerWidth,
    );
    widthRef.current = next;
    setWidth(next);
  };
  return {
    width: dragging.current ? widthRef.current : width,
    startResize,
    nudge,
  };
}

export function AIDocumentLayout({
  children,
  format,
  surface,
}: {
  children: ReactNode;
  format?: string;
  surface?: "document" | "files" | "mail";
}) {
  const ai = useAI();
  const panel = usePanelWidth();
  const filesSurface = surface === "files";
  const mailSurface = surface === "mail" || !!ai?.mailFocus;
  const enabled =
    !!ai?.userId &&
    (filesSurface ||
      mailSurface ||
      (!!ai.resource && ai.resource.kind === "document"));
  return (
    <div
      className={`ai-document-layout ${enabled && ai?.open ? "ai-document-open" : ""}`}
    >
      <div className="ai-document-main">
        {children}
        {(format === "rich_text" || format === "markdown") && (
          <DocumentScrollButtons />
        )}
      </div>
      {enabled && ai?.open && (
        <aside className="ai-document-panel" style={{ width: panel.width }}>
          <div
            className="ai-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整 AI 对话框宽度"
            aria-valuemin={PANEL_WIDTH_MIN}
            aria-valuenow={panel.width}
            aria-valuemax={panelWidthMax(
              typeof window === "undefined" ? 1280 : window.innerWidth,
            )}
            tabIndex={0}
            onPointerDown={panel.startResize}
            onKeyDown={panel.nudge}
          />
          <AIChat />
        </aside>
      )}
      {enabled && !ai?.open && !filesSurface && (
        <button
          className="ai-document-trigger"
          title={ai.mailFocus ? "AI 助手" : "AI 辅助创作"}
          aria-label={ai.mailFocus ? "AI 助手" : "AI 辅助创作"}
          aria-expanded={ai?.open}
          onClick={() => ai?.setOpen(!ai.open)}
        >
          <Sparkles size={22} />
        </button>
      )}
    </div>
  );
}
export function AIChat({ full = false }: { full?: boolean }) {
  const { locale } = useI18n();
  const ai = useAI()!;
  const currentAI = useRef(ai);
  currentAI.current = ai;
  const [modal, modalContext] = Modal.useModal();
  const [files, setFiles] = useState<Attachment<ChatFile>[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [fileSourceOpen, setFileSourceOpen] = useState(false);
  const filesRef = useRef<Attachment<ChatFile>[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);
  const attachmentRef = useRef<AttachmentsRef>(null);
  const senderRef = useRef<SenderRef>(null);
  const initialSlots = useRef<SlotConfigType[]>([]);
  const composerReady = useRef(false);
  const composerSelection = useRef<Range | null>(null);
  const previousResource = useRef(ai.resource?.id);
  const referenceSlots = useRef(new Map<string, AIReference>());
  const noteSlots = useRef(new Map<string, QuickNoteReference>());
  const referenceIdentity = (r: AIReference) =>
    JSON.stringify([r.resourceId, r.anchor, r.epochId, r.seq]);
  const tagCount = () =>
    (senderRef.current?.getValue().slotConfig ?? []).filter(
      (slot) => slot.type === "tag",
    ).length;
  const insertReference = (r: AIReference) => {
    if (tagCount() >= 20) {
      ai.setError("每条消息最多引用 20 项资料");
      return;
    }
    const key = `ref-${crypto.randomUUID()}`;
    const label = referenceLabel(r);
    referenceSlots.current.set(key, r);
    senderRef.current?.insert(
      [
        {
          type: "tag",
          key,
          props: {
            label: (
              <AIReferenceTag
                reference={r}
                reveal={() => currentAI.current.reveal(r)}
              />
            ),
            value: label,
          },
          formatResult: () => `@【${label}】`,
        },
        { type: "text", value: " " },
      ],
      "cursor",
    );
  };
  const insertNoteReference = (n: QuickNoteReference) => {
    if (tagCount() >= 20) {
      ai.setError("每条消息最多引用 20 项资料");
      return;
    }
    const key = `note-${crypto.randomUUID()}`;
    noteSlots.current.set(key, n);
    senderRef.current?.insert(
      [
        {
          type: "tag",
          key,
          props: {
            label: <QuickNoteTag label={n.label} note={n} />,
            value: n.label,
          },
          formatResult: () => `@【${n.label}#${n.id}】`,
        },
        { type: "text", value: " " },
      ],
      "end",
    );
  };
  const skipReferenceInsert = useRef(false);
  const clearComposer = () => {
    composerSelection.current = null;
    referenceSlots.current.clear();
    noteSlots.current.clear();
    senderRef.current?.clear();
    setHasDraft(false);
  };
  const composerValue = () =>
    (senderRef.current?.getValue().value ?? "").trim();
  const replaceComposerText = (value: string) => {
    clearComposer();
    senderRef.current?.insert([{ type: "text", value }], "end");
  };
  const replaceFiles = (value: Attachment<ChatFile>[]) => {
    filesRef.current = value;
    setFiles(value);
    requestId.current = null;
  };
  const pendingExtractKey = files
    .filter((f) => f.response?.extractStatus === "pending")
    .map((f) => f.response!.id)
    .join(",");
  useEffect(() => {
    if (!pendingExtractKey) return;
    let cancelled = false;
    const poll = async () => {
      for (const id of pendingExtractKey.split(",")) {
        try {
          const next = await api<{
            status: ChatFile["extractStatus"];
            preview?: string;
            description?: string;
          }>(`/assets/${id}/extract`);
          if (cancelled || !next.status || next.status === "pending") continue;
          replaceFiles(
            filesRef.current.map((file) =>
              file.response?.id === id
                ? composerFile(
                    asChatFile(file.response, {
                      extractStatus: next.status,
                      preview: next.preview,
                      description: next.description,
                    }),
                    file.uid,
                  )
                : file,
            ),
          );
        } catch {}
      }
    };
    const timer = window.setInterval(() => void poll(), 700);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingExtractKey]);
  const upload = async (file: File) => {
    if (busy) return;
    if (
      filesRef.current.length >= 8 ||
      filesRef.current.reduce((n, f) => n + (f.size ?? 0), 0) + file.size >
        25 * 1024 * 1024
    ) {
      ai.setError("每条消息最多 8 个附件，总大小不超过 25MB");
      return;
    }
    const uid = crypto.randomUUID();
    replaceFiles([
      ...filesRef.current,
      { uid, name: file.name, size: file.size, status: "uploading" },
    ]);
    try {
      const uploaded = await uploadFile(file, "ai_attachment");
      replaceFiles(
        filesRef.current.map((f) =>
          f.uid === uid
            ? composerFile(asChatFile(uploaded), uid)
            : f,
        ),
      );
    } catch (e) {
      replaceFiles(
        filesRef.current.map((f) =>
          f.uid === uid
            ? { ...f, status: "error", description: "上传失败，请移除后重试" }
            : f,
        ),
      );
      ai.setError((e as Error).message);
    }
  };
  const chooseStoredFile = async (
    file: Pick<FileItem, "id" | "name" | "size">,
    source = true,
  ) => {
    if (
      source &&
      filesRef.current.some((item) => item.response?.sourceFileId === file.id)
    )
      return;
    if (filesRef.current.length >= 8 || filesRef.current.reduce((n, f) => n + (f.size ?? 0), 0) + file.size > 25 * 1024 * 1024) {
      throw new Error("每条消息最多 8 个附件，总大小不超过 25MB");
    }
    const uploaded = await api<ChatFile>(`/files/items/${file.id}/attach`, "POST", { purpose: "ai_attachment" });
    replaceFiles([
      ...filesRef.current,
      composerFile(
        asChatFile({
          ...uploaded,
          sourceFileId: source ? file.id : undefined,
          sourceName: source ? file.name : undefined,
        }),
      ),
    ]);
  };
  const [folderTargets, setFolderTargets] = useState<ExplorerTarget[]>([]);
  const [composerDrop, setComposerDrop] = useState(false);
  const [folderImport, setFolderImport] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const addFolderTarget = (folder: { id: string; name: string }) => {
    setFolderTargets((prev) =>
      prev.some((item) => item.id === folder.id)
        ? prev
        : [...prev, { kind: "folder" as const, id: folder.id, name: folder.name }].slice(0, 8),
    );
  };
  const importDroppedFolders = async (entries: DroppedUpload[]) => {
    const tree = entries.filter((entry) => entry.directory || entry.path.includes("/"));
    const loose = entries.filter((entry) => entry.file && !entry.directory && !entry.path.includes("/"));
    for (const entry of loose) if (entry.file) void upload(entry.file);
    if (!tree.length) return;
    const bytes = tree.reduce((sum, entry) => sum + (entry.file?.size ?? 0), 0);
    const files = tree.filter((entry) => entry.file);
    if (files.length > 200 || bytes > 100 * 1024 * 1024) {
      ai.setError("拖入的文件夹过大，请先放到 Doca 文件夹后再选择");
      return;
    }
    setFolderImport(tree[0]?.path.split("/")[0] || "文件夹");
    try {
      const created = await uploadDroppedTree(tree, null, (path) => {
        setFolderImport(path);
      });
      if (!created.folders.length && files.length)
        ai.setError("文件夹已上传，但没有得到可选择的文件夹");
      for (const folder of created.folders) addFolderTarget(folder);
    } catch (e) {
      ai.setError((e as Error).message);
    } finally {
      setFolderImport("");
    }
  };
  useEffect(() => {
    if (!ai.pendingStoredFiles.length) return;
    const pending = ai.pendingStoredFiles;
    ai.clearPendingStoredFiles();
    void (async () => {
      for (const file of pending) {
        try {
          await chooseStoredFile(file);
        } catch (e) {
          ai.setError((e as Error).message);
          break;
        }
      }
    })();
  }, [ai.pendingStoredFiles]);
  const acceptExplorerDrop = async (dataTransfer: DataTransfer) => {
    const items = readFileDrag(dataTransfer);
    if (!items?.length) return;
    for (const item of items) {
      if (item.kind === "folder") {
        if (item.folderType === "document") {
          try {
            const detail = await api<{ resource: Resource }>(`/resources/${item.id}`);
            if (detail.resource.kind === "document") ai.addDocument(detail.resource);
            else
              setFolderTargets((prev) =>
                prev.some((folder) => folder.id === item.id)
                  ? prev
                  : [...prev, { kind: "folder" as const, id: item.id, name: item.name || detail.resource.title }].slice(0, 8),
              );
          } catch (e) {
            ai.setError((e as Error).message);
          }
          continue;
        }
        setFolderTargets((prev) =>
          prev.some((folder) => folder.id === item.id)
            ? prev
            : [...prev, { kind: "folder" as const, id: item.id, name: item.name || "文件夹" }].slice(0, 8),
        );
        continue;
      }
      try {
        await chooseStoredFile({
          id: item.id,
          name: item.name || "文件",
          size: item.size ?? 0,
        });
      } catch (e) {
        ai.setError((e as Error).message);
        break;
      }
    }
  };
  const explorerFiles = (): ExplorerTarget[] => {
    const files = filesRef.current
      .filter((file) => file.status === "done" && file.response?.sourceFileId)
      .map((file) => ({
        kind: "file" as const,
        id: file.response!.sourceFileId!,
        name: file.response!.sourceName || file.response!.filename,
      }));
    return [...files, ...folderTargets].slice(0, 20);
  };
  const onExplorerDragOver = (event: ReactDragEvent) => {
    if (!isInternalFileDrag(event.dataTransfer) && !isExternalFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!composerDrop) setComposerDrop(true);
  };
  const onExplorerDrop = (event: ReactDragEvent) => {
    const internal = isInternalFileDrag(event.dataTransfer) || !!readFileDrag(event.dataTransfer);
    const external = isExternalFileDrag(event.dataTransfer);
    if (!internal && !external) return;
    const captured = external && !internal ? captureExternalDrop(event.dataTransfer) : null;
    event.preventDefault();
    setComposerDrop(false);
    if (internal) {
      void acceptExplorerDrop(event.dataTransfer);
      return;
    }
    if (!captured) return;
    void materializeExternalDrop(captured)
      .then((dropped) => importDroppedFolders(dropped))
      .catch((e) => ai.setError((e as Error).message));
  };
  useEffect(() => {
    const clear = () => setComposerDrop(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  const [options, setOptions] = useState<Options | null>(null),
    [sessions, setSessions] = useState<Session[]>([]),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [hasDraft, setHasDraft] = useState(false),
    [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [picking, setPicking] = useState(false),
    [webSearch, setWebSearch] = useState(true),
    [skipApprovals, setSkipApprovals] = useState({
      create: false,
      delete: false,
      modify: false,
    }),
    [allScope, setAllScope] = useState(full),
    [list, setList] = useState(full),
    [batch, setBatch] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [skillIds, setSkillIds] = useState<string[]>([]),
    [personalSkills, setPersonalSkills] = useState<any[]>([]),
    [optimistic, setOptimistic] = useState<{
      id: string;
      text: string;
      createdAt: string;
      references?: AIReference[];
      attachments?: ChatFile[];
      explorer?: ExplorerTarget[];
    } | null>(null);
  const requestId = useRef<string | null>(null);
  const haltJobId = useRef<string | null>(null);
  const sendingSession = useRef<string | null>(null);
  const submitting = useRef(false);
  const [olderJobs, setOlderJobs] = useState<Conversation["jobs"]>([]);
  const bubbleRef = useRef<BubbleListRef>(null);
  const sessionListRef = useRef<HTMLElement>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const followLatestRef = useRef(true);
  const userScrollingRef = useRef(false);
  const setFollowing = (value: boolean) => {
    followLatestRef.current = value;
    if (value) userScrollingRef.current = false;
  };
  useEffect(() => {
    const list = bubbleRef.current;
    if (
      !list ||
      (!full && !ai.open) ||
      !conversation ||
      conversation.session.id !== ai.sessionId
    )
      return;
    followLatestRef.current = true;
    userScrollingRef.current = false;
    let frame = 0;
    const box = list.scrollBoxNativeElement;
    let expandedAnchor: { element: HTMLElement; top: number } | null = null;
    const align = () => {
      if (
        userScrollingRef.current ||
        (!followLatestRef.current && !expandedAnchor)
      )
        return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (expandedAnchor?.element.isConnected) {
          // Keep the clicked heading in place while collapse animations change height.
          const top =
            expandedAnchor.element.getBoundingClientRect().top -
            box.getBoundingClientRect().top;
          box.scrollBy({ top: top - expandedAnchor.top, behavior: "instant" });
        } else if (followLatestRef.current) {
          list.scrollTo({ top: "bottom", behavior: "instant" });
        }
      });
    };
    align();
    const update = () => {
      const selection = window.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        box.contains(selection.anchorNode)
      )
        return;
      const reversed =
        getComputedStyle(box).flexDirection === "column-reverse";
      setAwayFromLatest(
        reversed
          ? Math.abs(box.scrollTop) > 80
          : box.scrollHeight - box.clientHeight - box.scrollTop > 80,
      );
      const boxRect = box.getBoundingClientRect();
      const atLatest = reversed
        ? Math.abs(box.scrollTop) <= 80
        : box.scrollHeight - box.clientHeight - box.scrollTop <= 80;
      if (atLatest) setFollowing(true);
      const markerY =
        boxRect.top + Math.min(120, Math.max(48, box.clientHeight * 0.28));
      const markers = Array.from(
        box.querySelectorAll(".ai-user-bubble"),
      ).flatMap((node) => {
        const id = node
          .querySelector("[data-question]")
          ?.getAttribute("data-question");
        return id ? [{ id, top: node.getBoundingClientRect().top }] : [];
      });
      const next = activeQuestionFromPositions(markers, markerY, atLatest);
      setActiveQuestionId((current) => (current === next ? current : next));
      const overflow = box.scrollHeight > box.clientHeight + 24;
      const nearOldest = reversed
        ? box.scrollHeight - box.clientHeight - Math.abs(box.scrollTop) < 72
        : box.scrollTop < 72;
      const atHead = overflow && nearOldest && !followLatestRef.current;
      setAtHistoryHead((current) => (current === atHead ? current : atHead));
      const now = Date.now();
      if (
        historyControl.current.truncated &&
        !overflow &&
        !followLatestRef.current &&
        now - historyControl.current.lastExpand > 360
      ) {
        historyControl.current.lastExpand = now;
        historyControl.current.expandWindow();
      }
    };
    const stopFollowing = () => {
      expandedAnchor = null;
      cancelAnimationFrame(frame);
      userScrollingRef.current = true;
      setFollowing(false);
    };
    const keepExpandedPosition = (e: MouseEvent) => {
      const heading =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>(
              ".ant-collapse-header, .ant-think-status-wrapper",
            )
          : null;
      if (!heading) return;
      setFollowing(false);
      expandedAnchor = {
        element: heading,
        top:
          heading.getBoundingClientRect().top - box.getBoundingClientRect().top,
      };
      align();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) stopFollowing();
    };
    box.addEventListener("wheel", stopFollowing, { passive: true });
    box.addEventListener("touchmove", stopFollowing, { passive: true });
    box.addEventListener("click", keepExpandedPosition, true);
    box.addEventListener("keydown", onKey);
    const resize = new ResizeObserver(align);
    resize.observe(box);
    const content = box.querySelector(
      ":scope > .ant-bubble-list-scroll-content",
    );
    if (content) resize.observe(content);
    box.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      box.removeEventListener("wheel", stopFollowing);
      box.removeEventListener("touchmove", stopFollowing);
      box.removeEventListener("click", keepExpandedPosition, true);
      box.removeEventListener("keydown", onKey);
      box.removeEventListener("scroll", update);
    };
  }, [conversation?.session.id, ai.sessionId, ai.open, full]);
  const [olderOperations, setOlderOperations] = useState<
    Conversation["operations"]
  >([]);
  const [older, setOlder] = useState<Conversation["messages"]>([]),
    [page, setPage] = useState(0),
    [more, setMore] = useState(true);
  const [renderQuestions, setRenderQuestions] = useState(INITIAL_RENDER_QUESTIONS);
  const [focusedQuestionId, setFocusedQuestionId] = useState<string | null>(null);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [atHistoryHead, setAtHistoryHead] = useState(false);
  const [pending, setPending] = useState<PendingSendItem[]>([]);
  const queueKey = ai.sessionId ?? DRAFT_QUEUE_KEY;
  const pendingScrollKey = useRef<string | null>(null);
  const threadCache = useRef<{
    conversation: Conversation | null;
    older: Conversation["messages"];
    olderJobs: Conversation["jobs"];
    olderOperations: Conversation["operations"];
    optimistic: typeof optimistic;
    renderQuestions: number;
    focusedQuestionId: string | null;
    items: BubbleItemType[];
  } | null>(null);
  const historyControl = useRef({
    truncated: false,
    hasMore: false,
    lastExpand: 0,
    expandWindow: () => {},
    loadOlder: () => {},
  });
  const refresh = async () => {
    if (!ai.userId) return;
    const [o, s, k] = await Promise.all([
      api<Options>("/ai/options"),
      api<Session[]>(
        `/ai/sessions?archived=false${!full && ai.resource ? `&resourceId=${ai.resource.id}` : ""}`,
      ),
      api<any>("/ai/skills"),
    ]);
    setOptions(o);
    setSessions(s);
    setPersonalSkills(k.personal);
    setModel(
      (current) =>
        [
          current,
          o.preferences.default_model,
          o.defaultModel,
          o.models[0]?.id,
        ].find((id) => o.models.some((m) => m.id === id)) ?? "",
    );
  };
  useEffect(() => {
    const reload = () => {
      if (document.visibilityState === "visible" && (full || ai.open))
        void refresh().catch((e) => ai.setError(e.message));
    };
    reload();
    window.addEventListener("focus", reload);
    const timer = setInterval(reload, 5000);
    return () => {
      window.removeEventListener("focus", reload);
      clearInterval(timer);
    };
  }, [ai.userId, ai.resource?.id, ai.open, full]);
  useEffect(() => {
    if (!ai.userId) return;
    let active = true;
    void readPageState<string>("ai.model").then((item) => {
      if (active && item?.value) setModel(item.value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [ai.userId]);
  useEffect(() => {
    composerReady.current = true;
    if (previousResource.current !== ai.resource?.id) {
      replaceFiles([]);
      clearComposer();
      previousResource.current = ai.resource?.id;
    }
  }, [ai.resource?.id]);
  useEffect(() => {
    if (skipReferenceInsert.current) return;
    const values = senderRef.current?.getValue().slotConfig ?? [];
    const present = new Set(
      values
        .filter((slot) => slot.type === "tag")
        .map((slot) => referenceSlots.current.get(slot.key!))
        .filter(Boolean)
        .map((r) => referenceIdentity(r!)),
    );
    for (const r of ai.references)
      if (!present.has(referenceIdentity(r))) {
        insertReference(r);
        present.add(referenceIdentity(r));
      }
  }, [ai.references]);
  useEffect(() => {
    if (!full || !ai.composerDraft) return;
    replaceComposerText(ai.composerDraft);
    setHasDraft(!!ai.composerDraft.trim());
    senderRef.current?.focus();
    ai.setComposerDraft(null);
  }, [ai.composerDraft, full]);
  // Declared after the composerDraft effect so organize drafts land before note tags.
  useEffect(() => {
    if (skipReferenceInsert.current) return;
    const values = senderRef.current?.getValue().slotConfig ?? [];
    const present = new Set(
      values
        .filter((slot) => slot.type === "tag")
        .map((slot) => noteSlots.current.get(slot.key!))
        .filter(Boolean)
        .map((n) => n!.id),
    );
    for (const n of ai.noteReferences)
      if (!present.has(n.id)) {
        insertNoteReference(n);
        present.add(n.id);
      }
  }, [ai.noteReferences]);
  useEffect(() => {
    setOptimistic(null);
    setOlder([]);
    setOlderJobs([]);
    setOlderOperations([]);
    setPage(0);
    setMore(true);
    setRenderQuestions(INITIAL_RENDER_QUESTIONS);
    setFocusedQuestionId(null);
    setAtHistoryHead(false);
    if (sendingSession.current !== ai.sessionId) requestId.current = null;
    if (!ai.sessionId) {
      setConversation(null);
      return;
    }
    let active = true;
    const live = new Map<string, Conversation["jobs"][number]>();
    let modelLoaded = false;
    const sessionId = ai.sessionId;
    const userId = ai.userId;
    setConversation((current) =>
      current?.session.id === sessionId ? current : null,
    );
    if (userId)
      void readConversationCache<Conversation>(userId, sessionId).then(
        (cached) => {
          if (!active || !cached || cached.session.id !== sessionId) return;
          setConversation((current) =>
            current?.session.id === sessionId ? current : cached,
          );
        },
      );
    const load = () =>
      api<Conversation>(`/ai/sessions/${sessionId}`)
        .then((data) => {
          if (!active) return;
          const next = {
            ...data,
            jobs: data.jobs.map((job) => {
              const latest = live.get(job.id);
              return latest && ["running", "queued"].includes(job.status)
                ? latest
                : job;
            }),
          };
          setConversation(next);
          if (userId) void writeConversationCache(userId, sessionId, next);
          if (!modelLoaded && data.session.model_id)
            setModel(data.session.model_id);
          modelLoaded = true;
          ai.resourcesChanged(data.operations.map((op) => op.id));
          for (const job of data.jobs) {
            applyLivePageState(job.progress);
            if (!freshJob(job)) continue;
            if (job.progress?.mailOpen) jumpMail(job.id, job.progress.mailOpen);
          }
          setOptimistic((old) =>
            old && data.messages.some((m) => m.id === old.id) ? null : old,
          );
        })
        .catch((e) => {
          if (active) {
            if ([401, 403, 404].includes(e.status)) {
              setConversation(null);
              setOlder([]);
              setOlderJobs([]);
              setOlderOperations([]);
            }
            ai.setError(e.message);
          }
        });
    void load();
    const events = new EventSource(
      `/api/v1/ai/sessions/${ai.sessionId}/stream`,
    );
    events.addEventListener("job", (event) => {
      if (!active) return;
      const data = JSON.parse((event as MessageEvent).data);
      const previous = live.get(data.id);
      const job = {
        ...data,
        progress: data.progress
          ? applyProgressPatch(previous?.progress, data.progress)
          : undefined,
      };
      live.set(job.id, job);
      applyLivePageState(job.progress);
      setConversation((current) =>
        current
          ? {
              ...current,
              jobs: [...current.jobs.filter((j) => j.id !== job.id), job],
            }
          : current,
      );
      if (job.progress?.mailOpen) jumpMail(job.id, job.progress.mailOpen);
      if (!previous || previous.status !== job.status) void load();
    });
    events.addEventListener("revoked", () => {
      events.close();
      live.clear();
      setConversation(null);
      setOlder([]);
      setOlderJobs([]);
      setOlderOperations([]);
      ai.setError("会话或引用资料的访问权限已变化，请重新打开会话");
    });
    // Reconcile durable history and saved-operation receipts; token delivery uses SSE.
    const timer = setInterval(() => void load(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
      events.close();
    };
  }, [ai.sessionId]);
  useEffect(() => {
    const sync = () =>
      setPending(ai.userId ? loadPendingQueue(ai.userId, queueKey) : []);
    sync();
    window.addEventListener(PENDING_QUEUE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PENDING_QUEUE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [ai.userId, queueKey]);
  useEffect(() => {
    const key = pendingScrollKey.current;
    if (!key) return;
    const frame = requestAnimationFrame(() => {
      pendingScrollKey.current = null;
      bubbleRef.current?.scrollTo({
        key,
        block: "start",
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedQuestionId, renderQuestions, conversation, older]);
  useLayoutEffect(() => {
    if (!list) return;
    const reveal = () => {
      const box = sessionListRef.current;
      if (!box) return;
      box.scrollTop = 0;
      box
        .querySelectorAll<HTMLElement>(
          ".ant-conversations, .ant-conversations-list",
        )
        .forEach((el) => {
          el.scrollTop = 0;
        });
    };
    reveal();
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [list]);
  const jobs =
    conversation?.jobs.filter((j) =>
      ["queued", "running", "awaiting_approval"].includes(j.status),
    ) ?? [];
  const replying = busy || jobs.length > 0;
  const stopTasks = () => {
    const inflight = submitting.current ? requestId.current : null;
    if (inflight) haltJobId.current = inflight;
    persistPending([]);
    const ids = [
      ...new Set([...jobs.map((job) => job.id), ...(inflight ? [inflight] : [])]),
    ];
    if (!ids.length) return;
    void action(() =>
      Promise.all(ids.map((jobId) => api(`/ai/jobs/${jobId}/cancel`, "POST"))),
    );
  };
  const openDocument = useCallback((id: string) => {
    const current = currentAI.current;
    location.hash = `/r/${id}${current.sessionId ? `?session=${current.sessionId}` : ""}`;
    current.setOpen(true);
  }, []);
  const seenJumps = useRef(new Set<string>());
  const seenPageState = useRef("");
  const applyLivePageState = (progress?: AIProgress) => {
    const item = progress?.pageState;
    if (!item?.key) return;
    const stamp = JSON.stringify(item);
    if (seenPageState.current === stamp) return;
    seenPageState.current = stamp;
    window.dispatchEvent(new CustomEvent("doca-page-state", { detail: item }));
    if (item.key === "ai.model" && typeof item.value === "string") setModel(item.value);
  };
  const openFolderDelivery = useCallback((href: string) => {
    const current = currentAI.current;
    location.hash = withSessionHash(href, current.sessionId);
    current.setOpen(true);
  }, []);
  const freshJob = (job: { status: string }) =>
    ["running", "queued"].includes(job.status);
  const openComposeCard = (draft: MailComposeDraft) => {
    const current = currentAI.current;
    current.setOpen(true);
    const next = withSessionHash(`/mail/${draft.mailboxId}?compose=1`, current.sessionId);
    if (location.hash === `#${next}`) window.dispatchEvent(new CustomEvent("doca-mail-compose"));
    else location.hash = next;
  };
  const jumpMail = (jobId: string, target: MailOpenTarget) => {
    const key = `mail:${jobId}:${target.href}`;
    if (seenJumps.current.has(key)) return;
    seenJumps.current.add(key);
    const current = currentAI.current;
    location.hash = withSessionHash(target.href, current.sessionId);
    current.setOpen(true);
  };
  const newSession = () => {
    ai.setSessionId(null);
    if (!full) setList(false);
    ai.setReferences([]);
    ai.setNoteReferences([]);
    clearComposer();
    replaceFiles([]);
    setFolderTargets([]);
    ai.setError("");
  };
  const action = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      ai.setError((e as Error).message);
    }
  };
  const toggleSelected = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );
  const archiveSelected = () =>
    action(async () => {
      await api("/ai/sessions/batch", "POST", {
        ids: selected,
        archived: true,
      });
      setSelected([]);
    });
  const doneFiles = () =>
    files
      .filter((f) => f.status === "done" && f.response)
      .map((f) => f.response!);
  const snapshotComposer = (choice?: string): PendingSendItem | null => {
    const text = (choice ?? composerValue()).trim();
    const attachments = doneFiles();
    const targets = explorerFiles();
    if (!text && !attachments.length && !folderTargets.length) return null;
    if (files.some((f) => f.status !== "done")) {
      ai.setError(
        files.some((f) => f.status === "uploading" && f.response)
          ? "请等待文件解析完成后再发送"
          : "请等待附件上传完成，或移除上传失败的文件",
      );
      return null;
    }
    return {
      id: crypto.randomUUID(),
      text: text || (attachments.length ? "请分析这些附件" : "请处理拖入的文件夹"),
      attachments,
      files: targets,
      references: ai.references,
      notes: ai.noteReferences,
      createdAt: new Date().toISOString(),
      modelId: model,
      scope: allScope ? "all" : "document",
      currentResourceId: ai.resource?.id,
      currentMailboxId: ai.mailFocus?.mailboxId || undefined,
      currentMessageId: ai.mailFocus?.message?.id,
      skillIds,
      webSearch,
      skipApprovals,
    };
  };
  const restorePending = (item: PendingSendItem) => {
    skipReferenceInsert.current = true;
    replaceComposerText(item.text);
    replaceFiles(item.attachments.map((f) => composerFile(asChatFile(f))));
    setFolderTargets((item.files ?? []).filter((file) => file.kind === "folder"));
    setHasDraft(!!item.text.trim());
    ai.setReferences(item.references);
    ai.setNoteReferences(item.notes);
    queueMicrotask(() => {
      skipReferenceInsert.current = false;
    });
  };
  const persistPending = (items: PendingSendItem[]) => {
    setPending(items);
    if (ai.userId) writePendingQueue(ai.userId, queueKey, items);
  };
  const pinToLatest = () => {
    pendingScrollKey.current = null;
    setFollowing(true);
    setFocusedQuestionId(null);
    setRenderQuestions(INITIAL_RENDER_QUESTIONS);
    setAwayFromLatest(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bubbleRef.current?.scrollTo({ top: "bottom", behavior: "smooth" });
      });
    });
  };
  const enqueueComposer = (choice?: string) => {
    const item = snapshotComposer(choice);
    if (!item) return;
    persistPending([...pending, item]);
    replaceFiles([]);
    setFolderTargets([]);
    clearComposer();
    ai.setReferences([]);
    ai.setNoteReferences([]);
    pinToLatest();
  };
  const send = async (choice?: string) => {
    if (ai.restoring) return;
    const attachments = doneFiles();
    const targets = explorerFiles();
    const prompt =
      (choice ?? composerValue()).trim() ||
      (attachments.length ? "请分析这些附件" : "") ||
      (folderTargets.length ? "请处理拖入的文件夹" : "");
    if (
      !prompt ||
      !model ||
      busy ||
      !!folderImport ||
      submitting.current ||
      files.some((f) => f.status !== "done")
    ) {
      if (folderImport) ai.setError("请等待文件夹导入完成后再发送");
      else if (files.some((f) => f.status !== "done"))
        ai.setError(
          files.some((f) => f.status === "uploading" && f.response)
            ? "请等待文件解析完成后再发送"
            : "请等待附件上传完成，或移除上传失败的文件",
        );
      return;
    }
    const refs = ai.references;
    const notes = ai.noteReferences;
    const id = (requestId.current ??= crypto.randomUUID());
    submitting.current = true;
    setBusy(true);
    ai.setError("");
    setOptimistic({
      id,
      text: prompt,
      createdAt: new Date().toISOString(),
      references: refs,
      attachments,
      explorer: targets,
    });
    pinToLatest();
    try {
      await ai.beforeSend();
      let sid = ai.sessionId;
      if (!sid) {
        const s = await api<Session>("/ai/sessions", "POST", {
          modelId: model,
          resourceIds: ai.resource ? [ai.resource.id] : [],
        });
        sid = s.id;
        sendingSession.current = sid;
        if (ai.userId) setPending(adoptDraftQueue(ai.userId, sid));
        ai.setSessionId(sid);
      }
      await api(`/ai/sessions/${sid}/messages`, "POST", {
        id,
        text: prompt,
        attachments: attachments.map((f) => f.id),
        ...(targets.length ? { files: targets } : {}),
        modelId: model,
        scope: allScope ? "all" : "document",
        currentResourceId: ai.resource?.id,
        currentMailboxId: ai.mailFocus?.mailboxId || undefined,
        currentMessageId: ai.mailFocus?.message?.id,
        references: refs,
        ...(notes.length ? { quickNoteIds: notes.map((n) => n.id) } : {}),
        skillIds,
        webSearch: webSearch && !!options?.webSearchAvailable,
        skipApprovals,
      });
      if (haltJobId.current === id) {
        haltJobId.current = null;
        await api(`/ai/jobs/${id}/cancel`, "POST");
      }
      requestId.current = null;
      replaceFiles([]);
      setFolderTargets([]);
      clearComposer();
      ai.setReferences([]);
      ai.setNoteReferences([]);
      void refresh();
    } catch (e) {
      ai.setError((e as Error).message);
    } finally {
      if (haltJobId.current === id) haltJobId.current = null;
      submitting.current = false;
      setBusy(false);
    }
  };
  if (!ai.userId) return <div className="empty">登录后使用 AI 助手</div>;
  const visibleMessages: Conversation["messages"] = [
    ...new Map(
      [
        ...older,
        ...(optimistic ? [{ ...optimistic, role: "user" }] : []),
        ...(conversation?.messages ?? []),
      ].map((m) => [m.id, m]),
    ).values(),
  ];
  const visibleJobs = [
    ...new Map(
      [...olderJobs, ...(conversation?.jobs ?? [])].map((job) => [job.id, job]),
    ).values(),
  ];
  const visibleOperations = [
    ...new Map(
      [...olderOperations, ...(conversation?.operations ?? [])].map((op) => [
        op.id,
        op,
      ]),
    ).values(),
  ];
  const pendingApprovals = visibleJobs.flatMap((j) =>
    j.status === "awaiting_approval"
      ? (j.progress?.approvals ?? [])
          .filter((a) => a.state === "pending")
          .map((approval) => ({ job: j, approval }))
      : [],
  );
  const pendingQuestions = visibleJobs.flatMap((j) =>
    visibleMessages.some(
      (m) =>
        m.role === "user" &&
        m.id !== j.id &&
        (m.createdAt ?? "") > (j.created_at ?? ""),
    )
      ? []
      : (j.progress?.questions ?? []).map((question) => ({ job: j, question })),
  );
  for (const job of visibleJobs) {
    const answerId = `${job.id}-answer`;
    if (
      job.progress &&
      (job.progress.text || job.progress.reasoning) &&
      !visibleMessages.some((m) => m.id === answerId)
    )
      visibleMessages.push({
        id: answerId,
        role: "assistant",
        text: job.progress.text,
        reasoning: job.progress.reasoning,
        streaming: job.status === "running",
        createdAt: job.created_at,
      });
  }
  const questions = userQuestions(visibleMessages);
  const windowed = windowedMessages(
    visibleMessages,
    renderQuestions,
    focusedQuestionId,
  );
  const threadMessages = windowed.messages;
  const threadJobs = visibleJobs.filter(
    (job) =>
      threadMessages.some(
        (m) => m.id === job.id || m.id === `${job.id}-answer`,
      ) || ["queued", "running", "awaiting_approval"].includes(job.status),
  );
  const contextLabel = formatContextTokens(conversation?.contextTokens);
  const jumpToQuestion = (id: string) => {
    pendingScrollKey.current = id;
    setFollowing(false);
    setFocusedQuestionId(id);
    setActiveQuestionId(id);
    setRenderQuestions((current) => questionsToReveal(questions, id, current));
  };
  const revealOlderHistory = () => {
    if (windowed.startIndex > 0) {
      setRenderQuestions((current) => current + RENDER_EXPAND_QUESTIONS);
      return;
    }
    if (!(conversation?.hasMore && more) || busy) return;
    void action(async () => {
      const previous = await api<Conversation>(
        `/ai/sessions/${ai.sessionId}?page=${page + 1}`,
      );
      setOlder((current) => [...previous.messages, ...current]);
      setOlderJobs((current) => [...previous.jobs, ...current]);
      setOlderOperations((current) => [
        ...previous.operations,
        ...current,
      ]);
      setPage(page + 1);
      setMore(previous.hasMore);
      setRenderQuestions((current) => current + RENDER_EXPAND_QUESTIONS);
    });
  };
  historyControl.current = {
    truncated: windowed.startIndex > 0,
    hasMore: !!(conversation?.hasMore && more),
    lastExpand: historyControl.current.lastExpand,
    expandWindow: () =>
      setRenderQuestions((current) => current + RENDER_EXPAND_QUESTIONS),
    loadOlder: revealOlderHistory,
  };
  const suggestions = full
    ? [
        {
          key: "search",
          icon: <Search size={18} />,
          label: "查找资料",
          description: "帮我查找相关文档，并总结重点",
        },
        {
          key: "write",
          icon: <FileText size={18} />,
          label: "起草文档",
          description: "帮我创建一份项目计划",
        },
        {
          key: "outline",
          icon: <WandSparkles size={18} />,
          label: "梳理想法",
          description: "帮我将想法整理成清晰的提纲",
        },
        {
          key: "organize",
          icon: <FolderOpen size={18} />,
          label: "整理知识库",
          description: "分析我的知识库，提出整理建议",
        },
      ]
    : [
        {
          key: "summary",
          icon: <FileText size={18} />,
          label: "提炼重点",
          description: "总结这份文档的核心内容",
        },
        {
          key: "polish",
          icon: <WandSparkles size={18} />,
          label: "润色内容",
          description: "帮我完善选中内容",
        },
      ];
  const messageBubble = (
    m: Conversation["messages"][number] & {
      folders?: FolderDelivery[];
      files?: FileDelivery[];
      mails?: MailDelivery[];
      mailCompose?: MailComposeDraft;
      sources?: { title: string; url: string }[];
    },
  ): BubbleItemType => {
    // 随手记引用不随消息持久化：从文本里的序列化标记（@【标签#id】）恢复标签，
    // 数据还在 ai.noteReferences 里时直接预览，否则按 id 拉取笔记内容。
    const noteMarkers = [
      ...new Map(
        [...m.text.matchAll(/@【(随手记 [^】#]+?)(?:#([0-9a-f-]{36}))?】/g)].map(
          (x) => [`${x[1]}#${x[2] ?? ""}`, { label: x[1]!, id: x[2] }],
        ),
      ).values(),
    ];
    return {
    key: m.id,
    role: m.role === "user" ? "user" : "ai",
    placement: m.role === "user" ? "end" : "start",
    className: m.role === "assistant" ? "ai-response-bubble" : "ai-user-bubble",
    variant: m.role === "user" ? "filled" : "borderless",
    styles: m.role === "user" ? { root: { paddingInlineStart: 0 } } : undefined,
    header:
      m.role === "user" ? (
        m.createdAt ? (
          <time className="ai-message-time" dateTime={m.createdAt}>
            {new Date(m.createdAt).toLocaleString([], {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        ) : undefined
      ) : (
        "AI 助手"
      ),
    streaming: !!m.streaming,
    content: (
      <>
        {!!m.explorer?.length && (
          <div className="ai-sent-targets">
            {m.explorer.map((item) => (
              <span className={`ai-sent-target ai-sent-target-${item.kind}`} key={`${item.kind}:${item.id}`}>
                {item.kind === "folder" ? <Folder size={14} /> : <FileIcon size={14} />}
                <span>{item.name || (item.kind === "folder" ? "文件夹" : "文件")}</span>
              </span>
            ))}
          </div>
        )}
        {!!m.attachments?.length && (
          <FileCard.List
            className="ai-message-attachments"
            removable={false}
            overflow="wrap"
            size="small"
            items={m.attachments.map((f) => ({
              key: f.id,
              name: f.filename,
              byte: f.size,
              type: f.mime.startsWith("image/") ? "image" : "file",
              src: f.mime.startsWith("image/") ? assetUrl(f.id) : undefined,
              description: (
                <a href={assetUrl(f.id)} target="_blank" rel="noreferrer">
                  查看附件
                </a>
              ),
            }))}
          />
        )}
        {m.reasoning && (
          <Think
            title={m.streaming ? "思考过程 · 正在生成" : "思考过程"}
            loading={!!m.streaming}
            blink={!!m.streaming}
            defaultExpanded={false}
          >
            <Suspense fallback={<span>{m.reasoning}</span>}>
              <AIAnswer text={m.reasoning} onDocument={openDocument} />
            </Suspense>
          </Think>
        )}
        {m.role === "assistant" ? (
          <Suspense fallback={<span>{m.text}</span>}>
            <>
              <AIAnswer
                text={m.text}
                streaming={m.streaming}
                folders={m.folders}
                files={m.files}
                mails={m.mails}
                ensureFolderCards
                onDocument={openDocument}
                onFolder={openFolderDelivery}
              />
              {m.mailCompose &&
                renderPluginAIBlock("mail-compose", m.mailCompose, () =>
                  openComposeCard(m.mailCompose!),
                )}
            </>
          </Suspense>
        ) : (
          <span
            className="ai-user-message-text"
            data-question={m.id}
            style={{ whiteSpace: "pre-wrap" }}
          >
            {referenceTextParts(
              m.text,
              (m.references ?? []).map(referenceLabel),
              noteMarkers,
            ).map((part, i) =>
              "text" in part ? (
                part.text
              ) : "noteIndex" in part ? (
                <QuickNoteTag
                  key={i}
                  label={noteMarkers[part.noteIndex]!.label}
                  note={ai.noteReferences.find(
                    (n) =>
                      n.id === noteMarkers[part.noteIndex]!.id ||
                      (!noteMarkers[part.noteIndex]!.id &&
                        n.label === noteMarkers[part.noteIndex]!.label),
                  )}
                  noteId={noteMarkers[part.noteIndex]!.id}
                />
              ) : (
                <AIReferenceTag
                  key={i}
                  reference={m.references![part.referenceIndex]!}
                  reveal={() => ai.reveal(m.references![part.referenceIndex]!)}
                />
              ),
            )}
          </span>
        )}
        <WebSources sources={m.sources ?? []} />
      </>
    ),
    footer:
      m.role === "assistant" && !!m.text && !m.streaming ? (
        <Actions
          items={[
            {
              key: "copy",
              label: "复制回答",
              actionRender: <Actions.Copy text={m.text} />,
            },
          ]}
        />
      ) : undefined,
    };
  };
  const jobBubble = (j: Conversation["jobs"][number]): BubbleItemType => ({
    key: `task-${j.id}`,
    role: "progress",
    variant: "borderless",
    content: (
      <ThoughtChain
        items={[
          ...(j.progress?.plan && !j.progress.events?.length
            ? [
                {
                  key: "delivery-plan",
                  title: j.progress.plan.goal,
                  collapsible: true,
                  status: "success" as const,
                  content: (
                    <div>
                      <ol>
                        {j.progress.plan.steps.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                      <strong>验收标准</strong>
                      <ul>
                        {j.progress.plan.criteria.map((criterion, i) => (
                          <li key={i}>{criterion}</li>
                        ))}
                      </ul>
                    </div>
                  ),
                },
              ]
            : []),
          ...(j.progress?.review && !j.progress.events?.length
            ? [
                {
                  key: "delivery-review",
                  title:
                    j.progress.review.verdict === "pass"
                      ? "内容验收通过"
                      : j.progress.review.verdict === "needs_user"
                        ? "需要补充要求"
                        : "验收待修正",
                  description: j.progress.review.summary,
                  status:
                    j.progress.review.verdict === "pass"
                      ? ("success" as const)
                      : ("abort" as const),
                },
              ]
            : []),
          ...(j.progress?.events?.length ? [] : (j.progress?.steps ?? [])).map(
            (s, index) => ({
              key: `step-${index}`,
              title: s.title,
              status:
                s.status === "loading" &&
                !["queued", "running"].includes(j.status)
                  ? ("abort" as const)
                  : s.status,
            }),
          ),
          ...visibleOperations
            .filter((o) => o.job_id === j.id && !j.progress?.events?.length)
            .map((o) => ({
              key: o.id,
              title:
                o.result.kind === "image_generation"
                  ? o.result.state === "saved"
                    ? "生成图片已保存为素材"
                    : o.result.state === "save_failed"
                      ? "图片已生成但保存失败"
                      : "图片生成结果待核对"
                  : "文档操作已保存",
              status:
                o.result.kind === "image_generation" &&
                o.result.state !== "saved"
                  ? ("abort" as const)
                  : ("success" as const),
              collapsible: true,
              content: (
                <Button
                  type="link"
                  onClick={() =>
                    openDocument(o.result.resourceId ?? o.result.id)
                  }
                >
                  查看 {o.result.title ?? "文档修改"}
                </Button>
              ),
            })),
          ...[j].map((j) => ({
            key: j.id,
            title:
              (
                {
                  queued: "任务排队中",
                  running: j.progress?.phase ?? "正在处理",
                  completed: j.progress?.phase?.startsWith("等待")
                    ? j.progress.phase
                    : "任务已完成",
                  failed: "任务失败",
                  cancelled: "任务已停止",
                  interrupted: "任务已中断",
                  awaiting_approval: "等待操作审批",
                } as Record<string, string>
              )[j.status] ?? j.status,
            status: (["queued", "running"].includes(j.status)
              ? "loading"
              : j.status === "failed"
                ? "error"
                : ["cancelled", "interrupted", "awaiting_approval"].includes(
                      j.status,
                    )
                  ? "abort"
                  : "success") as "loading" | "error" | "abort" | "success",
            description:
              j.error ||
              (j.status === "running" ? "关闭页面后仍会继续" : undefined),
            extra: ["failed", "interrupted", "cancelled"].includes(j.status) ? (
              <Button
                size="small"
                disabled={busy || !model || jobs.length > 0}
                onClick={() =>
                  void action(async () => {
                    await api(`/ai/sessions/${ai.sessionId}/messages`, "POST", {
                      id: crypto.randomUUID(),
                      retryOf: j.id,
                      modelId: model,
                      text: "重试原任务",
                      scope: "all",
                    });
                    await refresh();
                  })
                }
              >
                重试任务
              </Button>
            ) : undefined,
            footer: ["queued", "running", "awaiting_approval"].includes(
              j.status,
            ) ? (
              <Button
                size="small"
                onClick={() =>
                  void action(() => api(`/ai/jobs/${j.id}/cancel`, "POST"))
                }
              >
                停止任务
              </Button>
            ) : undefined,
          })),
        ]}
      />
    ),
  });
  const reuseThread = !!(
    threadCache.current &&
    threadCache.current.conversation === conversation &&
    threadCache.current.older === older &&
    threadCache.current.olderJobs === olderJobs &&
    threadCache.current.olderOperations === olderOperations &&
    threadCache.current.optimistic === optimistic &&
    threadCache.current.renderQuestions === renderQuestions &&
    threadCache.current.focusedQuestionId === focusedQuestionId
  );
  const bubbleItems: BubbleItemType[] = reuseThread
    ? threadCache.current!.items
    : aiTimeline(
    threadMessages,
    threadJobs,
  ).flatMap((item): BubbleItemType[] => {
    if (item.kind === "message") {
      if (
        item.message.role === "assistant" &&
        visibleJobs.some(
          (j) =>
            `${j.id}-answer` === item.message.id &&
            (j.progress?.events?.length || j.progress?.questions?.length),
        )
      )
        return [];
      const answerJob = visibleJobs.find(
        (job) => `${job.id}-answer` === item.message.id,
      );
      return [
        messageBubble({
          ...item.message,
          folders: answerJob ? jobFolderDeliveries(answerJob) : undefined,
          files: answerJob ? jobFileDeliveries(answerJob) : undefined,
          mails: answerJob ? jobMailDeliveries(answerJob) : undefined,
          sources: answerJob?.progress?.sources,
        }),
      ];
    }
    const j = item.job;
    const active = ["running", "queued"].includes(j.status);
    const eventItems = (j.progress?.events ?? [])
      .filter((event) => {
        if (
          event.kind === "text" &&
          event.text.trim() === "本轮工具操作已结束，请查看任务结果。"
        )
          return false;
        return event.text || (active && event.status === "loading");
      })
      .map((event): BubbleItemType => ({
        key: `${j.id}-${event.id}`,
        className:
          event.kind === "text" ? "ai-response-bubble" : "ai-step-bubble",
        role: "ai",
        variant: "borderless",
        placement: "start",
        streaming: active && event.status === "loading",
        styles: { content: { padding: 0 }, body: { padding: 0 } },
        content:
          event.kind === "reasoning" ? (
            <Think
              title={
                active && event.status === "loading" ? "正在思考" : "思考过程"
              }
              loading={active && event.status === "loading"}
              blink={active && event.status === "loading"}
              defaultExpanded={false}
            >
              <Suspense fallback={event.text}>
                <AIAnswer
                  text={event.text}
                  onDocument={openDocument}
                  streaming={active && event.status === "loading"}
                />
              </Suspense>
            </Think>
          ) : event.kind === "text" ? (
            <Suspense fallback={event.text}>
              <AIAnswer
                text={event.text}
                folders={jobFolderDeliveries(j)}
                files={jobFileDeliveries(j)}
                mails={jobMailDeliveries(j)}
                onDocument={openDocument}
                onFolder={openFolderDelivery}
                streaming={active && event.status === "loading"}
              />
            </Suspense>
          ) : event.image && !event.detail && !event.resourceId ? (
            <AIGeneratedImage
              sessionId={ai.sessionId}
              image={event.image}
              currentDocument={
                ai.resource?.kind === "document" ? ai.resource : undefined
              }
            />
          ) : (
            <>
              <ThoughtChain
                items={[
                  {
                    key: event.id,
                    title: event.text,
                    collapsible:
                      !!event.detail ||
                      !!event.resourceId ||
                      (event.text === "制定交付计划" && !!j.progress?.plan),
                    content: (
                      <>
                        {event.detail && <p>{event.detail}</p>}
                        {event.resourceId && (
                          <Button
                            type="link"
                            size="small"
                            onClick={() => openDocument(event.resourceId!)}
                          >
                            查看已保存文档
                          </Button>
                        )}
                        {event.text === "制定交付计划" && j.progress?.plan && (
                          <>
                            <strong>{j.progress.plan.goal}</strong>
                            <ol>
                              {j.progress.plan.steps.map((step, i) => (
                                <li key={i}>{step}</li>
                              ))}
                            </ol>
                            <strong>验收标准</strong>
                            <ul>
                              {j.progress.plan.criteria.map((c, i) => (
                                <li key={i}>{c}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </>
                    ),
                    description: new Date(event.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                    status:
                      !active && event.status === "loading"
                        ? "abort"
                        : event.status,
                  },
                ]}
              />
              {event.image && (
                <AIGeneratedImage
                  sessionId={ai.sessionId}
                  image={event.image}
                  currentDocument={
                    ai.resource?.kind === "document" ? ai.resource : undefined
                  }
                />
              )}
              {event.folder && (
                <FolderDeliveryCard
                  folder={event.folder}
                  onOpen={openFolderDelivery}
                />
              )}
              {event.mail &&
                renderPluginAIBlock("mail", event.mail, openFolderDelivery)}
              {event.file && (
                <FileDeliveryCard
                  file={event.file}
                  onOpen={openFolderDelivery}
                />
              )}
            </>
          ),
        footer:
          event.kind === "text" && (!active || event.status !== "loading") ? (
            <Actions
              items={[
                {
                  key: "copy",
                  label: "复制",
                  actionRender: <Actions.Copy text={event.text} />,
                },
              ]}
            />
          ) : undefined,
      }));
    const showSummary =
      !eventItems.length ||
      !!j.progress?.approvals?.length ||
      !["queued", "running", "completed"].includes(j.status) ||
      (!active && !!j.progress?.sources.length);
    const oldImages: BubbleItemType[] = visibleOperations
      .filter(
        (o) =>
          o.job_id === j.id &&
          o.result.kind === "image_generation" &&
          o.result.assetId &&
          !j.progress?.events?.some(
            (e) => e.image?.assetId === o.result.assetId,
          ),
      )
      .map((o) => ({
        key: `${o.id}-image`,
        role: "ai",
        variant: "borderless",
        className: "ai-step-bubble",
        content: (
          <AIGeneratedImage
            sessionId={ai.sessionId}
            image={o.result}
            currentDocument={
              ai.resource?.kind === "document" ? ai.resource : undefined
            }
          />
        ),
      }));
    const eventTime = new Map(
      (j.progress?.events ?? []).map((e) => [`${j.id}-${e.id}`, e.at]),
    );
    const decisionItems: { at: string; bubble: BubbleItemType }[] = (
      j.progress?.approvals ?? []
    )
      .filter((a) => a.state !== "pending" || j.status !== "awaiting_approval")
      .map((a) => ({
        at: a.resolvedAt ?? j.updated_at ?? "",
        bubble: {
          key: `${j.id}-${a.id}-approval`,
          role: "ai",
          variant: "borderless",
          className: "ai-step-bubble",
          content: (
            <div className="ai-approval-result">
              <span className={`ai-approval-state ${a.state}`}>
                {a.state === "approved"
                  ? "已批准"
                  : a.state === "rejected"
                    ? "已拒绝"
                    : "任务已停止"}
              </span>
              {a.title}
            </div>
          ),
        },
      }));
    const documentItems: { at: string; bubble: BubbleItemType }[] =
      visibleOperations
        .filter((o) => o.job_id === j.id && o.result.title && o.result.format)
        .map((o) => ({
          at: o.created_at ?? "",
          bubble: {
            key: `${o.id}-document`,
            role: "ai",
            variant: "borderless",
            className: "ai-step-bubble",
            content: (
              <button
                type="button"
                className="ai-document-card"
                aria-label={`打开${o.result.kind === "library" ? "知识库" : "文档"}：${o.result.title}`}
                onClick={() =>
                  openDocument(o.result.id ?? o.result.resourceId)
                }
              >
                <span className="ai-document-card-icon">
                  <FileText size={18} />
                </span>
                <span className="ai-document-card-copy">
                  <small>
                    {o.result.kind === "library" ? "已创建知识库" : "已创建文档"}
                  </small>
                  <span className="ai-document-card-title">{o.result.title}</span>
                </span>
                <span className="ai-document-card-format">
                  {o.result.kind === "library"
                    ? "知识库"
                    : (documentFormats[o.result.format] ?? "文档")}
                </span>
                <ArrowUpRight className="ai-document-card-arrow" size={16} />
              </button>
            ),
          },
        }));
    const folderItems: { at: string; bubble: BubbleItemType }[] =
      visibleOperations
        .filter(
          (o) =>
            o.job_id === j.id &&
            o.result.kind === "file_folder" &&
            o.result.href &&
            o.result.name &&
            !j.progress?.events?.some(
              (e) => e.folder?.id === o.result.id,
            ),
        )
        .map((o) => ({
          at: o.created_at ?? "",
          bubble: {
            key: `${o.id}-folder`,
            role: "ai",
            variant: "borderless",
            className: "ai-step-bubble",
            content: (
              <FolderDeliveryCard
                folder={{
                  id: o.result.id,
                  name: o.result.name,
                  path: o.result.path,
                  href: o.result.href,
                  shared: o.result.shared,
                }}
                onOpen={openFolderDelivery}
              />
            ),
          },
        }));
    const fileItems: { at: string; bubble: BubbleItemType }[] =
      visibleOperations
        .filter(
          (o) =>
            o.job_id === j.id &&
            o.result.kind === "file_item" &&
            o.result.id &&
            o.result.name &&
            !j.progress?.events?.some((e) => e.file?.id === o.result.id),
        )
        .map((o) => ({
          at: o.created_at ?? "",
          bubble: {
            key: `${o.id}-file`,
            role: "ai",
            variant: "borderless",
            className: "ai-step-bubble",
            content: (
              <FileDeliveryCard
                file={{
                  id: o.result.id,
                  name: o.result.name,
                  path: o.result.path,
                  href: o.result.href,
                  downloadUrl: o.result.downloadUrl,
                  mime: o.result.mime,
                  local: o.result.local,
                }}
                onOpen={openFolderDelivery}
              />
            ),
          },
        }));
    const timedItems = [
      ...eventItems.map((bubble) => ({
        at: eventTime.get(String(bubble.key)) ?? "",
        bubble,
      })),
      ...decisionItems,
      ...documentItems,
      ...folderItems,
      ...fileItems,
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((t) => t.bubble);
    if (
      j.status === "completed" &&
      j.progress?.phase === "已完成" &&
      eventItems.length
    ) {
      const final = j.progress.text;
      const lastText = [...(j.progress.events ?? [])]
        .reverse()
        .find((e) => e.kind === "text");
      // Keep approval decisions in the same chronological process stream as
      // tool/reasoning events. Rendering them after the collapsed process made
      // a later approval look as if it belonged to the end of the task.
      const processItems = [
        ...eventItems.map((bubble) => ({
          at: eventTime.get(String(bubble.key)) ?? "",
          bubble,
        })),
        ...decisionItems,
      ]
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((item) => item.bubble);
      const details = processItems.filter(
        (i) =>
          !lastText ||
          lastText.text.trim() !== final.trim() ||
          i.key !== `${j.id}-${lastText.id}`,
      );
      // Images are deliverables, not hidden execution logs. Keep every verified image visible.
      const imageItems: BubbleItemType[] = [
        ...new Map(
          (j.progress.events ?? [])
            .filter((e) => e.image)
            .map((e) => [e.image!.assetId, e.image!]),
        ).values(),
      ].map((image) => ({
        key: `${j.id}-${image.assetId}-deliverable`,
        role: "ai",
        variant: "borderless",
        content: (
          <AIGeneratedImage
            sessionId={ai.sessionId}
            image={image}
            currentDocument={
              ai.resource?.kind === "document" ? ai.resource : undefined
            }
          />
        ),
      }));
      return [
        ...(details.length
          ? [
              {
                key: `${j.id}-details`,
                role: "ai",
                className: "ai-process-bubble",
                variant: "borderless" as const,
                content: (
                  <Collapse
                    ghost
                    expandIconPlacement="end"
                    styles={{
                      header: { width: "fit-content", gap: 6 },
                      title: { flex: "none" },
                      body: { padding: "4px 0" },
                    }}
                    className="ai-completed-process"
                    items={[
                      {
                        key: "process",
                        label: taskDuration(j.created_at, j.updated_at),
                        children: (
                          <div className="ai-process-events">
                            {details.map(({ key, role: _role, ...props }) => (
                              <Bubble key={key} {...props} />
                            ))}
                          </div>
                        ),
                      },
                    ]}
                  />
                ),
              },
            ]
          : []),
        ...imageItems,
        ...oldImages,
        ...documentItems.map((t) => t.bubble),
        ...folderItems.map((t) => t.bubble),
        ...fileItems.map((t) => t.bubble),
        ...(final
          ? [
              messageBubble({
                id: `${j.id}-final`,
                role: "assistant",
                text: final,
                folders: jobFolderDeliveries(j),
                files: jobFileDeliveries(j),
                mails: jobMailDeliveries(j),
                mailCompose: j.progress?.mailCompose,
                sources: j.progress?.sources,
              }),
            ]
          : j.progress?.mailCompose
            ? [
                messageBubble({
                  id: `${j.id}-final`,
                  role: "assistant",
                  text: "",
                  mailCompose: j.progress.mailCompose,
                }),
              ]
            : []),
      ];
    }
    return [
      ...timedItems,
      ...oldImages,
      ...(showSummary ? [jobBubble(j)] : []),
      ...(j.progress?.sources.length &&
      (eventItems.length || j.progress?.questions?.length)
        ? [
            {
              key: `${j.id}-sources`,
              role: "ai" as const,
              variant: "borderless" as const,
              className: "ai-sources-bubble",
              content: <WebSources sources={j.progress.sources} />,
            },
          ]
        : []),
    ];
    });
  if (!reuseThread) {
    if (!visibleMessages.length && !optimistic)
      bubbleItems.push({
      key: "welcome",
      role: "welcome",
      variant: "borderless",
      styles: {
        content: { padding: 0, width: "100%" },
        body: { width: "100%" },
      },
      content: (
        <div className="ai-welcome">
          <Welcome
            variant="borderless"
            icon={<Sparkles size={32} />}
            title={full ? "今天有什么想法？" : "一起完善这份文档"}
            description={
              full
                ? "从查找资料到完成创作，交给 Doca 助手。"
                : "写作、总结、画图，从一个想法开始。"
            }
            styles={{
              root: {
                flexDirection: "column",
                textAlign: "center",
                alignItems: "center",
                padding: 0,
              },
              title: { fontSize: full ? 28 : 21 },
              icon: { color: "#8064b1" },
            }}
          />
          <Prompts
            className="ai-official-prompts"
            items={suggestions}
            vertical={!full}
            wrap={full}
            styles={{ item: { flex: full ? "1 1 40%" : undefined } }}
            onItemClick={({ data }) => {
              replaceComposerText(String(data.description));
              senderRef.current?.focus();
            }}
          />
        </div>
      ),
    });
    threadCache.current = {
      conversation,
      older,
      olderJobs,
      olderOperations,
      optimistic,
      renderQuestions,
      focusedQuestionId,
      items: bubbleItems,
    };
  }
  return (
    <ConfigProvider
      locale={antdLocale(locale)}
      theme={{
        token: {
          colorPrimary: "#7859b8",
          borderRadius: 10,
          fontFamily: "inherit",
        },
      }}
    >
      {modalContext}
      <section
        className={`ai-chat ${full ? "ai-chat-full" : ""} ${list ? "ai-history-open" : ""} ${composerDrop ? "is-file-drop" : ""}`}
        aria-label="AI 助手"
        // Embedded editors listen on window. Let Sender handle input first,
        // then keep typing, deletion and history shortcuts inside this chat.
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onDragOverCapture={onExplorerDragOver}
        onDragLeaveCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setComposerDrop(false);
        }}
        onDropCapture={onExplorerDrop}
      >
        <AIChatHeader full={full}>
          {!full && (
            <>
              <Sparkles size={19} />
              <strong>AI 助手</strong>
            </>
          )}
          {!full && <span className="ai-flex" />}
          {full &&
            !!conversation?.resources?.length &&
            (conversation.resources.length === 1 ? (
              <Button
                type="text"
                size="small"
                aria-label="关联文档"
                title={conversation.resources[0]!.title}
                onClick={() => openDocument(conversation.resources![0]!.id)}
                style={{
                  width: "auto",
                  minWidth: 0,
                  maxWidth: 240,
                  overflow: "hidden",
                  display: "inline-flex",
                  gap: 6,
                }}
              >
                <FileText size={16} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {conversation.resources[0]!.title}
                </span>
              </Button>
            ) : (
              <Popover
                trigger="click"
                placement="bottomLeft"
                content={
                  <div
                    style={{ maxWidth: 340, maxHeight: 300, overflowY: "auto" }}
                  >
                    {conversation.resources.map((r) => (
                      <div key={r.id}>
                        <Button
                          type="text"
                          onClick={() => openDocument(r.id)}
                          style={{ maxWidth: "100%" }}
                        >
                          <FileText size={15} />
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {r.title}
                          </span>
                        </Button>
                      </div>
                    ))}
                  </div>
                }
              >
                <Button
                  type="text"
                  size="small"
                  aria-label="关联文档"
                  style={{
                    width: "auto",
                    minWidth: 0,
                    maxWidth: 240,
                    overflow: "hidden",
                    display: "inline-flex",
                    gap: 6,
                  }}
                >
                  <FileText size={16} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {`关联文档 ${conversation.resources.length}`}
                  </span>
                </Button>
              </Popover>
            ))}
          <button
            title="会话列表"
            aria-label="会话列表"
            aria-expanded={list}
            className={list ? "active" : ""}
            onClick={() => setList(!list)}
          >
            <MessageSquare size={17} />
          </button>
          <button title="新建会话" onClick={newSession}>
            <Plus size={18} />
          </button>
          {!full && (
            <AIQuestionNav
              variant="popover"
              questions={questions}
              activeId={activeQuestionId ?? questions.at(-1)?.id}
              onJump={jumpToQuestion}
            />
          )}
          <button title="偏好、用量与工具" onClick={() => setSettings(true)}>
            <Settings size={17} />
          </button>
          {!full && (
            <>
              <button
                title="打开完整助手"
                onClick={() => {
                  location.hash = `/ai${ai.sessionId ? `?session=${ai.sessionId}` : ""}`;
                }}
              >
                <Maximize2 size={17} />
              </button>
              <button title="收起 AI" onClick={() => ai.setOpen(false)}>
                <PanelRightClose size={17} />
              </button>
            </>
          )}
        </AIChatHeader>
        {!full && !!conversation?.resources?.length && (
          <div className="ai-associated-documents" aria-label="关联文档">
            {conversation.resources.map((r) => (
              <Button
                key={r.id}
                type="text"
                size="small"
                title={r.title}
                onClick={() => openDocument(r.id)}
              >
                <FileText size={14} />
                <span>{r.title}</span>
              </Button>
            ))}
          </div>
        )}
        <div className="ai-chat-body">
          {list && (
            <nav
              ref={sessionListRef}
              className="ai-session-list"
              aria-label="历史会话"
            >
              <div className="ai-session-tools">
                <div className="ai-session-batch-row">
                  <button
                    className="ai-batch-toggle"
                    aria-pressed={batch}
                    disabled={!sessions.length}
                    onClick={() => {
                      setBatch((value) => !value);
                      setSelected([]);
                    }}
                  >
                    <SquareCheck size={13} />
                    {batch ? "退出批量管理" : "批量管理"}
                  </button>
                </div>
                {batch && (
                  <div className="ai-selection-bar">
                    <span>
                      {selected.length
                        ? `已选择 ${selected.length} 个`
                        : "请选择会话"}
                    </span>
                    <button
                      disabled={!sessions.length}
                      onClick={() => setSelected(sessions.map((s) => s.id))}
                    >
                      全选
                    </button>
                    <button
                      disabled={!selected.length}
                      onClick={() => setSelected([])}
                    >
                      清空
                    </button>
                    <button
                      className="primary"
                      disabled={!selected.length}
                      onClick={() => void archiveSelected()}
                    >
                      <Archive size={13} />
                      归档所选
                    </button>
                  </div>
                )}
              </div>
              <Conversations
                creation={{ label: "新对话", onClick: newSession }}
                activeKey={ai.sessionId ?? undefined}
                items={sessions.map((s) => ({
                  key: s.id,
                  label: batch ? (
                    <span className="ai-session-check">
                      <Checkbox
                        aria-label={`选择会话 ${s.title}`}
                        checked={selected.includes(s.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelected(s.id)}
                      />
                      <span className="ai-session-label" title={s.title}>
                        <span className="ai-session-check-title">{s.title}</span>
                        <SessionStatusBadges session={s} />
                      </span>
                    </span>
                  ) : (
                    <span className="ai-session-label" title={s.title}>
                      <span className="ai-session-title">{s.title}</span>
                      <SessionStatusBadges session={s} />
                    </span>
                  ),
                  className:
                    batch && selected.includes(s.id)
                      ? "ai-session-picked"
                      : undefined,
                  icon: (
                    s.id === ai.sessionId
                      ? jobs.some(
                          (j) =>
                            j.status === "queued" || j.status === "running",
                        )
                      : s.running
                  ) ? (
                    <Spin size="small" aria-label="任务执行中" />
                  ) : undefined,
                  group: s.updated_at
                    ? new Date(s.updated_at).toDateString() ===
                      new Date().toDateString()
                      ? "今天"
                      : "更早"
                    : "会话",
                }))}
                groupable
                onActiveChange={(id) => {
                  if (batch) {
                    toggleSelected(id);
                    return;
                  }
                  ai.setSessionId(id);
                  bubbleRef.current?.scrollTo({
                    top: "bottom",
                    behavior: "instant",
                  });
                  if (!full) setList(false);
                  clearComposer();
                  replaceFiles([]);
                  setFolderTargets([]);
                  ai.setReferences([]);
                  ai.setNoteReferences([]);
                  ai.setError("");
                }}
                menu={(item) =>
                  batch
                    ? undefined
                    : {
                        items: [
                          { key: "rename", label: "重命名" },
                          {
                            key: "archive",
                            label: "归档会话",
                            icon: <Archive size={14} />,
                          },
                          {
                            key: "delete",
                            label: "删除会话",
                            danger: true,
                            icon: <Trash2 size={14} />,
                          },
                        ],
                        onClick: ({ key }) => {
                          if (key === "rename") {
                            let title =
                              sessions.find((s) => s.id === item.key)?.title ??
                              "";
                            modal.confirm({
                              title: "重命名会话",
                              content: (
                                <Input
                                  aria-label="会话名称"
                                  defaultValue={title}
                                  maxLength={120}
                                  onChange={(e) => {
                                    title = e.target.value;
                                  }}
                                />
                              ),
                              onOk: async () => {
                                if (!title.trim())
                                  throw Error("请填写会话名称");
                                await api(
                                  `/ai/sessions/${item.key}`,
                                  "PATCH",
                                  { title },
                                );
                                await refresh();
                              },
                            });
                          }
                          if (key === "archive")
                            void action(() =>
                              api(`/ai/sessions/${item.key}`, "PATCH", {
                                archived: true,
                              }),
                            );
                          if (key === "delete")
                            modal.confirm({
                              title: "删除此会话？",
                              content: "删除历史消息，个人偏好保留。",
                              okButtonProps: { danger: true },
                              onOk: async () => {
                                await api(`/ai/sessions/${item.key}`, "DELETE");
                                if (ai.sessionId === item.key)
                                  ai.setSessionId(null);
                                await refresh();
                              },
                            });
                        },
                      }
                }
              />
              {!sessions.length && (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    "你的对话会保存在这里"
                  }
                />
              )}
            </nav>
          )}
          <div className="ai-conversation">
            <div className="ai-messages" aria-live="polite">
              {full && (
                <AIQuestionNav
                  variant="rail"
                  questions={questions}
                  activeId={activeQuestionId ?? questions.at(-1)?.id}
                  onJump={jumpToQuestion}
                />
              )}
              <AIBubbleList items={bubbleItems} listRef={bubbleRef} />
              {atHistoryHead &&
                (windowed.startIndex > 0 ||
                  !!(conversation?.hasMore && more)) && (
                  <Button
                    className="ai-older-button"
                    shape="round"
                    size="small"
                    icon={<ArrowUp size={14} />}
                    disabled={busy}
                    onClick={revealOlderHistory}
                  >
                    {windowed.startIndex > 0
                      ? "显示更早的对话"
                      : "加载更早的消息"}
                  </Button>
                )}
              {awayFromLatest && (
                <Button
                  className="ai-latest-button"
                  shape="round"
                  size="small"
                  icon={<ArrowDown size={14} />}
                  onClick={pinToLatest}
                >
                  回到最新
                </Button>
              )}
            </div>
            <div
              className="ai-composer"
              ref={composerRef}
              onPasteCapture={(event) => {
                const text = event.clipboardData?.getData("text/plain") ?? "";
                if (!text || !isComposerEditable(event.target)) return;
                event.preventDefault();
                event.stopPropagation();
                insertComposerPlainText(senderRef.current, text);
              }}
              onKeyDownCapture={(event) => {
                if (
                  event.key !== "Enter" ||
                  !event.shiftKey ||
                  event.nativeEvent.isComposing ||
                  !isComposerEditable(event.target)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                insertComposerPlainText(senderRef.current, "\n");
              }}
            >
              {!!(pendingApprovals.length || pendingQuestions.length) && (
                <div className="ai-composer-requests">
                  {pendingApprovals.map(({ job: j, approval }) => (
                    <div className="ai-approval-card" key={approval.id}>
                      <strong>{approval.title}</strong>
                      <p>{approval.detail}</p>
                      {approval.preview && (
                        <details>
                          <summary>查看待保存内容</summary>
                          <Suspense fallback={approval.preview}>
                            <AIAnswer
                              text={approval.preview}
                              onDocument={openDocument}
                            />
                          </Suspense>
                        </details>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button
                          size="small"
                          type="primary"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await api(`/ai/jobs/${j.id}/approval`, "POST", {
                                approvalId: approval.id,
                                approved: true,
                              });
                              await refresh();
                            })
                          }
                        >
                          批准并继续
                        </Button>
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await api(`/ai/jobs/${j.id}/approval`, "POST", {
                                approvalId: approval.id,
                                approved: false,
                              });
                              await refresh();
                            })
                          }
                        >
                          拒绝
                        </Button>
                      </div>
                    </div>
                  ))}
                  {pendingQuestions.map(({ job: j, question }) => (
                    <AIChoiceCard
                      key={`${j.id}-${question.id}-choice`}
                      question={question}
                      disabled={busy || jobs.length > 0}
                      answer={send}
                    />
                  ))}
                </div>
              )}
              {ai.error && (
                <Alert
                  type="error"
                  title={ai.error}
                  closable
                  onClose={() => ai.setError("")}
                />
              )}
              <AIPendingQueue
                items={pending}
                waiting={jobs.length > 0 || busy}
                onEdit={(item) => {
                  persistPending(
                    pending.filter((entry) => entry.id !== item.id),
                  );
                  restorePending(item);
                  senderRef.current?.focus();
                }}
                onWithdraw={(id) =>
                  persistPending(pending.filter((entry) => entry.id !== id))
                }
                onBump={(item) => {
                  persistPending(promotePendingItem(pending, item.id));
                  if (!jobs.length) return;
                  void action(() =>
                    Promise.all(
                      jobs.map((j) => api(`/ai/jobs/${j.id}/cancel`, "POST")),
                    ),
                  );
                }}
              />
              {contextLabel && (
                <div className="ai-composer-meta">
                  <span
                    className="ai-context-count"
                    title="上一轮实际送入模型的输入 Token"
                  >
                    {contextLabel}
                  </span>
                </div>
              )}
              {!!folderTargets.length && (
                <div className="ai-drop-targets">
                  {folderTargets.map((folder) => (
                    <span className="ai-drop-target" key={folder.id}>
                      文件夹 · {folder.name || "未命名"}
                      <button
                        type="button"
                        aria-label={`移除文件夹 ${folder.name || ""}`}
                        onClick={() =>
                          setFolderTargets((prev) =>
                            prev.filter((item) => item.id !== folder.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {!!folderImport && (
                <div className="ai-drop-targets">正在导入文件夹 {folderImport}</div>
              )}
              {composerDrop && (
                <div className="ai-file-drop-hint">
                  松开后加入文件；文件夹会导入到我的文件，并作为本次操作对象
                </div>
              )}
              <Sender
                ref={senderRef}
                slotConfig={initialSlots.current}
                onBlur={(event) => {
                  const selection = window.getSelection();
                  if (
                    selection?.rangeCount &&
                    event.currentTarget.contains(selection.anchorNode)
                  )
                    composerSelection.current = selection
                      .getRangeAt(0)
                      .cloneRange();
                }}
                onChange={(value, _event, slots) => {
                  requestId.current = null;
                  const next =
                    !!value.trim() ||
                    (slots ?? []).some(
                      (slot) =>
                        slot.type === "tag" ||
                        (slot.type === "text" &&
                          String(slot.value ?? "").trim()),
                    );
                  setHasDraft((current) => (current === next ? current : next));
                  const tags = (slots ?? []).filter((slot) => slot.type === "tag");
                  const active = tags
                    .map((slot) => referenceSlots.current.get(slot.key!))
                    .filter((r): r is AIReference => !!r);
                  const activeNotes = tags
                    .map((slot) => noteSlots.current.get(slot.key!))
                    .filter((n): n is QuickNoteReference => !!n);
                  if (composerReady.current) {
                    const sameRefs =
                      active.length === ai.references.length &&
                      active.every(
                        (r, i) =>
                          referenceIdentity(r) ===
                          referenceIdentity(ai.references[i]!),
                      );
                    if (!sameRefs) ai.setReferences(active);
                    const sameNotes =
                      activeNotes.length === ai.noteReferences.length &&
                      activeNotes.every(
                        (n, i) => n.id === ai.noteReferences[i]!.id,
                      );
                    if (!sameNotes) ai.setNoteReferences(activeNotes);
                  }
                }}
                onSubmit={(message) => {
                  if (jobs.length > 0 || busy || pending.length > 0)
                    enqueueComposer(message);
                  else void send(message);
                }}
                loading={false}
                suffix={false}
                header={
                  <>
                    <Attachments
                      ref={attachmentRef}
                      style={{ display: files.length ? undefined : "none" }}
                      overflow="scrollX"
                      maxCount={8}
                      className="ai-upload-list"
                      items={files}
                      accept=".txt,.md,.csv,.json,.log,.yaml,.yml,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.gif"
                      multiple
                      disabled={busy}
                      beforeUpload={(file) => {
                        void upload(file);
                        return false;
                      }}
                      onRemove={(file) => {
                        replaceFiles(
                          filesRef.current.filter((f) => f.uid !== file.uid),
                        );
                        return true;
                      }}
                      getDropContainer={() => null}
                    />
                  </>
                }
                footer={(_, { components: { SendButton } }) => (
                  <div className="ai-composer-tools">
                    <Button
                      type="text"
                      onClick={() => setFileSourceOpen(true)}
                      className="ai-upload-trigger"
                      disabled={busy}
                      title="上传文件或图片"
                      aria-label="上传文件或图片"
                    >
                      <Plus size={20} />
                    </Button>

                    <Popover
                      trigger="click"
                      placement="topLeft"
                      open={picking}
                      onOpenChange={setPicking}
                      destroyOnHidden
                      styles={{
                        container: {
                          padding: 8,
                          borderRadius: 12,
                          border: "1px solid #e7e5ed",
                          boxShadow: "0 8px 32px #201b3020",
                        },
                      }}
                      content={
                        <SearchPanel
                          compact
                          select={(r) => {
                            setPicking(false);
                            // Preserve the insertion point while the search input has focus.
                            const range = composerSelection.current;
                            senderRef.current?.focus();
                            if (
                              range &&
                              composerRef.current?.contains(
                                range.startContainer,
                              )
                            ) {
                              const selection = window.getSelection();
                              selection?.removeAllRanges();
                              selection?.addRange(range);
                            }
                            insertReference({
                              resourceId: r.id,
                              label: r.title,
                              format: r.format,
                            });
                          }}
                        />
                      }
                    >
                      <Button
                        type="text"
                        title="引用知识库或文档"
                        aria-label="引用知识库或文档"
                      >
                        <AtSign size={17} />
                      </Button>
                    </Popover>
                    <Button
                      type={webSearch ? "primary" : "text"}
                      size="small"
                      disabled={!options?.webSearchAvailable}
                      aria-label="联网搜索"
                      aria-pressed={webSearch}
                      title={
                        options?.webSearchAvailable
                          ? "允许本轮检索互联网公开资料"
                          : "管理员尚未配置联网搜索"
                      }
                      onClick={() => setWebSearch((value) => !value)}
                    >
                      <Globe size={16} />
                      {full && "联网"}
                    </Button>
                    <Popover
                      trigger="click"
                      placement="topLeft"
                      content={
                        <div className="ai-skip-approvals">
                          <small>可跳过的审批，默认都要审批</small>
                          {(
                            [
                              ["create", "创建（增）"],
                              ["delete", "删除（删）"],
                              ["modify", "修改（改）"],
                            ] as const
                          ).map(([key, label]) => (
                            <Checkbox
                              key={key}
                              checked={skipApprovals[key]}
                              onChange={(e) =>
                                setSkipApprovals((value) => ({
                                  ...value,
                                  [key]: e.target.checked,
                                }))
                              }
                            >
                              {label}
                            </Checkbox>
                          ))}
                        </div>
                      }
                    >
                      <Button
                        type={
                          skipApprovals.create ||
                          skipApprovals.delete ||
                          skipApprovals.modify
                            ? "primary"
                            : "text"
                        }
                        size="small"
                        title="跳过创建、删除或修改审批"
                        aria-label="跳过审批"
                      >
                        <ShieldCheck size={16} />
                        {full && "审批"}
                      </Button>
                    </Popover>
                    {
                      <Popover
                        trigger="click"
                        placement="topLeft"
                        content={
                          <Checkbox
                            checked={allScope}
                            onChange={(e) => setAllScope(e.target.checked)}
                          >
                            允许跨文档任务
                          </Checkbox>
                        }
                      >
                        <Button
                          type="text"
                          title={
                            allScope
                              ? "任务范围：跨文档"
                              : "任务范围：当前文档与引用文档"
                          }
                          aria-label="任务范围"
                        >
                          <FolderOpen size={16} />
                        </Button>
                      </Popover>
                    }
                    <span className="ai-flex" />
                    <Select
                      aria-label="选择 AI 模型"
                      className="ai-model-select"
                      variant="borderless"
                      popupMatchSelectWidth={false}
                      value={
                        options?.models.some((m) => m.id === model)
                          ? model
                          : undefined
                      }
                      placeholder="暂无可用模型"
                      onChange={(value) => {
                        setModel(value);
                        void writePageState("ai.model", value).catch(() => undefined);
                        if (ai.sessionId)
                          void action(() =>
                            api(`/ai/sessions/${ai.sessionId}`, "PATCH", {
                              modelId: value,
                            }),
                          );
                      }}
                      options={options?.models.map((m) => ({
                        value: m.id,
                        label: m.name,
                        title: `输入 ${m.inputRate}/百万 · 输出 ${m.outputRate}/百万 · 缓存 ${m.cacheRate}/百万`,
                      }))}
                    />
                    <span className="ai-send-control">
                      <SendButton
                        className={replying ? "ai-send-standby" : undefined}
                        aria-hidden={replying || undefined}
                        tabIndex={replying ? -1 : undefined}
                        aria-label="发送"
                        title={
                          files.some((f) => f.status !== "done")
                            ? "请等待文件解析完成后再发送"
                            : replying
                              ? "回车加入待发送"
                              : "发送"
                        }
                        disabled={
                          !!folderImport ||
                          files.some((f) => f.status !== "done") ||
                          !options?.models.some((m) => m.id === model) ||
                          !options?.enabled
                        }
                      />
                      {replying && (
                        <Button
                          type="primary"
                          shape="circle"
                          className="ai-stop-button"
                          aria-label="停止当前任务和待发送"
                          title="停止当前任务和待发送"
                          icon={<span className="ai-stop-icon" />}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            stopTasks();
                          }}
                        />
                      )}
                    </span>
                  </div>
                )}
                onPasteFile={(items) => {
                  for (const file of Array.from(items)) void upload(file);
                }}
                autoSize={{ minRows: 2, maxRows: 6 }}
                disabled={ai.restoring}
                placeholder={
                  full
                    ? "发消息，或把文件拖到这里…"
                    : "描述想法，或把文件拖到这里…"
                }
              />
              {!!personalSkills.length && (
                <details>
                  <summary>本次使用的个人 Skill</summary>
                  {personalSkills.map((s) => (
                    <label key={s.id}>
                      <input
                        type="checkbox"
                        checked={skillIds.includes(s.id)}
                        onChange={(e) =>
                          setSkillIds(
                            e.target.checked
                              ? [...skillIds, s.id]
                              : skillIds.filter((id) => id !== s.id),
                          )
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </details>
              )}
              {options && !options.models.length && (
                <p className="ai-muted">
                  暂无可用模型。管理员需配置模型、开启对应等级的 AI
                  能力并设置积分。
                </p>
              )}
            </div>
          </div>
        </div>
        {settings && (
          <AIUserSettings
            options={options}
            openSession={async (id) => {
              setSettings(false);
              ai.setSessionId(id);
              setList(false);
              await refresh();
            }}
            close={() => {
              setSettings(false);
              void refresh();
            }}
          />
        )}
        {filePickerOpen && <FolderFilePicker close={() => setFilePickerOpen(false)} select={chooseStoredFile} />}
        {folderPickerOpen && (
          <FolderFilePicker
            close={() => setFolderPickerOpen(false)}
            selectFolder={(folder) => addFolderTarget(folder)}
          />
        )}
        {fileSourceOpen && (
          <FileSourceDialog
            title="添加文件或文件夹"
            close={() => setFileSourceOpen(false)}
            chooseDoca={() => setFilePickerOpen(true)}
            chooseFolder={() => setFolderPickerOpen(true)}
            chooseLocal={() => attachmentRef.current?.select({ multiple: true })}
            chooseLocalFolder={() => folderInputRef.current?.click()}
          />
        )}
        <input
          ref={folderInputRef}
          hidden
          multiple
          type="file"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (!picked.length) return;
            void importDroppedFolders(
              picked.map((file) => ({
                file,
                path:
                  (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
                  file.name,
              })),
            );
          }}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
      </section>
    </ConfigProvider>
  );
}
