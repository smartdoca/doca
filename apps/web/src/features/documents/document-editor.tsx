import { useI18n } from "@web/shared/i18n.js";
import { useAIBridge } from "@web/features/ai/ai-context.js";
import { captureRichSelection } from "@web/features/comments/rich-selection-anchor.js";
import { resolveRichAnchor, type RichAnchor } from "@core/modules/documents/codecs/rich-anchor.js";
import { useDocumentReadOnly } from "@web/features/documents/document-mode.js";
import { DocumentFind } from "@web/features/documents/document-find.js";
import { CommentNavigation } from "@web/features/comments/comment-navigation.js";
import { scrollCommentIntoView } from "@web/features/comments/comment-scroll.js";
import { EditorRecoveryBoundary } from "@web/features/documents/editor-recovery-boundary.js";
import {
  DocumentDownload,
  downloadResult,
  readAsset,
  reportWarnings,
  saveToPlatformFolder,
} from "@web/features/documents/file-transfer.js";
import { createEditorDocument } from "@smartdoca/slate/headless";
import { renderKatex } from "@smartdoca/slate/katex";
import { useRichTextPdfProjection } from "./rich-text-pdf.js";
import { ModelFind } from "@web/features/search/model-find.js";
import { replaceRichText } from "@web/features/search/rich-text-search.js";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
const SheetDocument = lazy(() => import("@web/features/documents/spreadsheet-editor.js"));
const CanvasDocument = lazy(() => import("@web/features/documents/canvas-editor.js"));
const PresentationDocument = lazy(() => import("@web/features/documents/presentation-editor.js"));
const MarkdownDocument = lazy(() => import("@web/features/documents/markdown-editor.js"));
import { createPortal } from "react-dom";
import { Editor, Element, Node, Range, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import {
  RichTextEditor,
  type RichTextEditorHandle,
  type ResourceConfig,
  type ResourceUploadState,
  type DocumentHeading,
} from "@smartdoca/slate";
import {
  Doc,
  applyUpdate,
  encodeStateVector,
  encodeStateAsUpdate,
  createYjsAdapter,
} from "@smartdoca/slate/yjs";
import { MessageSquare, PanelRightClose, X } from "lucide-react";
import {
  api,
  assetUrl,
  roleRank,
  type Detail,
  type User,
} from "@web/shared/api.js";
import { realtime, toBase64, fromBase64 } from "@web/features/documents/realtime.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { RemoteCursors } from "@web/features/documents/editor-presence.js";
import { CommentCards } from "@web/features/comments/comment-layout.js";
import {
  CommentComposer,
  CommentMessage,
  parsedComment,
  lookupUsers,
} from "@web/features/comments/rich-comments.js";
import {
  SelectionCommentAction,
  CommentHighlights,
  selectedTextRange,
} from "@web/features/comments/comment-selection.js";
import type { CommentBody } from "@core/modules/interactions/community.js";
import "@smartdoca/slate/style.css";
import "@web/features/documents/editor.css";
import "@web/features/documents/document-page-width.css";
import { EditorToolbar } from "@web/features/documents/editor-toolbar.js";
import { documentUploadProblem, uploadDocumentResource } from "./document-upload.js";
import { OutlineDrawer } from "@web/features/documents/outline-drawer.js";
import { DocumentOutline } from "@web/features/documents/document-outline.js";
import { documentPageLayout } from "@web/features/documents/document-page-layout.js";
import { DocumentPageWidthMenu, canEditPageWidth, useDocumentPageWidth } from "@web/features/documents/document-page-width.js";
import { useAttachmentPreview } from "@web/features/documents/attachment-preview.js";
import { UpdateOutbox } from "@web/features/documents/update-outbox.js";
import { openReplica } from "@web/features/documents/offline-replica.js";
import { documentLinkPlugin, internalDocumentId } from "@web/features/documents/document-link.js";
import { mentionPlugin, DocumentMentions } from "@web/features/documents/document-mentions.js";
import { DocaYjsDocument as YjsDocument } from "@core/modules/documents/codecs/rich-runtime.js";
import { pluginElementPlugin, RichPluginElements } from "./rich-plugin-elements.js";
const documentPlugins = [mentionPlugin, documentLinkPlugin, pluginElementPlugin];
type Anchor = RichAnchor;
export function DocumentEditor({
  detail,
  user,
  changed,
  targetComment,
  loadMoreComments,
  discussion,
}: {
  detail: Detail;
  user: User | null;
  changed: () => void;
  targetComment?: string | null;
  loadMoreComments?: () => Promise<void>;
  discussion?: React.ReactNode;
}) {
  const r = detail.resource;
  if (r.format === "presentation")
    return (
      <Suspense fallback={<p className="empty">正在加载演示文稿…</p>}>
        <PresentationDocument
          key={`${r.id}:${user?.id ?? "anonymous"}`}
          detail={detail}
          user={user}
          changed={changed}
          targetComment={targetComment}
          loadMoreComments={loadMoreComments}
        />
      </Suspense>
    );
  if (r.format === "markdown")
    return (
      <>
        <Suspense fallback={<p className="empty">正在加载 Markdown…</p>}>
          <MarkdownDocument
            key={`${r.id}:${user?.id ?? "anonymous"}`}
            detail={detail}
            user={user}
            changed={changed}
            targetComment={targetComment}
            loadMoreComments={loadMoreComments}
          />
        </Suspense>
        {discussion}
      </>
    );
  if (r.format === "spreadsheet")
    return (
      <Suspense fallback={<p className="empty">正在加载在线表格…</p>}>
        <SheetDocument
          key={`${r.id}:${user?.id ?? "anonymous"}`}
          detail={detail}
          user={user}
          changed={changed}
          targetComment={targetComment}
          loadMoreComments={loadMoreComments}
        />
      </Suspense>
    );
  if (r.format === "canvas")
    return (
      <Suspense fallback={<p className="empty">正在加载画布…</p>}>
        <CanvasDocument
          key={`${r.id}:${user?.id ?? "anonymous"}`}
          detail={detail}
          user={user}
          changed={changed}
          targetComment={targetComment}
          loadMoreComments={loadMoreComments}
        />
      </Suspense>
    );
  if (r.format !== "rich_text")
    return (
      <div className="empty">
        <h2>此文档类型暂不支持编辑</h2>
        <p>已保留独立的编辑器与协同编码接口，此类型暂未接入。</p>
      </div>
    );
  return (
    <RichDocument
      key={`${r.id}:${user?.id ?? "anonymous"}`}
      detail={detail}
      user={user}
      changed={changed}
      targetComment={targetComment}
      loadMoreComments={loadMoreComments}
      discussion={discussion}
    />
  );
}
function RichDocument({
  detail,
  user,
  changed,
  targetComment,
  loadMoreComments,
  discussion,
}: {
  detail: Detail;
  user: User | null;
  changed: () => void;
  targetComment?: string | null;
  loadMoreComments?: () => Promise<void>;
  discussion?: React.ReactNode;
}) {
  const id = detail.resource.id;
  const { locale, t } = useI18n();
  const [pageWidth, setPageWidth] = useDocumentPageWidth(
    detail.resource,
    canEditPageWidth(detail.resource),
    changed,
  );
  const attachmentPreview = useAttachmentPreview();
  const session = useMemo(() => {
    const doc = new Doc();
    return { doc, runtime: new YjsDocument(doc) };
  }, [id]);
  const handle = useRef<RichTextEditorHandle | null>(null);
  const [uploadStates, setUploadStates] = useState<readonly ResourceUploadState[]>([]);
  const [dismissedUploadErrors, setDismissedUploadErrors] = useState<ReadonlySet<string>>(new Set());
  const [mediaCommandError, setMediaCommandError] = useState("");
  const [playbackError, setPlaybackError] = useState<{ name: string; code: number; src: string } | null>(null);
  const [toolbarHandle, setToolbarHandle] =
    useState<RichTextEditorHandle | null>(null);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const unsaved = useRef(false);
  const epoch = useRef<string | undefined>(undefined);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const selectionFrame = useRef(0);
  // Slate may emit several selection updates while reconciling DOM focus.
  // Refresh host controls once per frame, never synchronously re-enter that cycle.
  const selectionChanged = useCallback(() => {
    if (selectionFrame.current) return;
    selectionFrame.current = requestAnimationFrame(() => {
      selectionFrame.current = 0;
      setSelectionRevision((n) => n + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(selectionFrame.current), []);
  const [ready, setReady] = useState(false),
    [localReady, setLocalReady] = useState(false),
    [blocked, setBlocked] = useState(false),
    [connected, setConnected] = useState(false),
    [status, setStatus] = useState("正在连接…"),
    [error, setError] = useState(""),
    [canRetrySync, setCanRetrySync] = useState(true),
    [peers, setPeers] = useState<{ id: string; display_name: string }[]>([]),
    [headings, setHeadings] = useState<DocumentHeading[]>([]),
    [outlineCollapsed, setOutlineCollapsed] = useState(false),
    [commentsChoice, setCommentsChoice] = useState(true),
    [commentDrawerOpen, setCommentDrawerOpen] = useState(false),
    [availableWidth, setAvailableWidth] = useState(0),
    [panelBounds, setPanelBounds] = useState({ right: 0, top: 120, bottom: 0 }),
    [liveInfo, setLiveInfo] = useState<HTMLElement | null>(null),
    [anchor, setAnchor] = useState<Anchor | null>(null),
    [activeThread, setActiveThread] = useState<string | null>(null),
    [reply, setReply] = useState<string | null>(null),
    [replyTo, setReplyTo] = useState<Detail["comments"][number] | undefined>(),
    [visibleThreads, setVisibleThreads] = useState(10),
    [visibleReplies, setVisibleReplies] = useState<Record<string, number>>({}),
    [editingComment, setEditingComment] = useState<{
      id: string;
      version: number;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const outlineChanged = useCallback((next: DocumentHeading[]) => {
    setHeadings((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);
  const editorReady = useCallback((h: RichTextEditorHandle) => {
    handle.current = h;
    setToolbarHandle(h);
  }, []);
  const shell = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!ready || !targetComment) return;
    const target = detail.comments.find((c) => c.id === targetComment);
    const root = target?.parent_id
      ? detail.comments.find((c) => c.id === target.parent_id)
      : target;
    if (!root?.anchor || root.resolved || root.deleted_at) return;
    setActiveThread(root.id);
    setCommentsOpen(true);
    setVisibleThreads(detail.comments.length);
    setVisibleReplies((v) => ({ ...v, [root.id]: detail.comments.length }));
    const t = setTimeout(
      () =>
        scrollCommentIntoView(shell.current
          ?.querySelector(`[data-thread-id="${root.id}"]`), "center"),
      120,
    );
    return () => clearTimeout(t);
  }, [targetComment, ready, detail.comments.length]);
  const contentHost = useRef<HTMLDivElement | null>(null);
  const mobileEditor = /^#\/m\/r\//.test(location.hash);
  const pageLayout = documentPageLayout(availableWidth, mobileEditor ? "fluid" : pageWidth, mobileEditor ? false : !outlineCollapsed);
  const compact = !pageLayout.commentsInline;
  const commentsOpen = compact ? commentDrawerOpen : commentsChoice;
  const outlineInline = !mobileEditor && pageLayout.outlineInline && !outlineCollapsed;
  // Automatic squeezing closes the drawer, but preserves the inline preference
  // for when space returns. Only an explicit comment action opens the drawer.
  useLayoutEffect(() => setCommentDrawerOpen(false), [compact]);
  const setCommentsOpen = (open: boolean) => {
    if (compact) setCommentDrawerOpen(open);
    else setCommentsChoice(open);
  };
  useEffect(() => {
    setLiveInfo(document.getElementById("document-live-info"));
    setToolbarSlot(document.getElementById("editor-toolbar-slot"));
    const measure = () => {
      const root = shell.current;
      const source = root?.closest<HTMLElement>(".main-scroll");
      if (!root || !source) return;
      setAvailableWidth(root.clientWidth);
      const rect = source.getBoundingClientRect();
      const toolbar = document.getElementById("editor-toolbar-slot")?.getBoundingClientRect();
      const next = {
        right: Math.max(0, innerWidth - rect.left - source.clientWidth),
        top: Math.max(rect.top, toolbar?.bottom ?? rect.top),
        bottom: Math.max(0, innerHeight - rect.bottom),
      };
      setPanelBounds((old) => old.right === next.right && old.top === next.top && old.bottom === next.bottom ? old : next);
    };
    const observer = new ResizeObserver(measure);
    if (shell.current) observer.observe(shell.current);
    const source = shell.current?.closest(".main-scroll");
    if (source) observer.observe(source);
    const toolbar = document.getElementById("editor-toolbar-slot");
    if (toolbar) observer.observe(toolbar);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [id]);
  const [serverRank, setServerRank] = useState<number | null>(null);
  const rank = Math.min(roleRank(detail.resource.role), serverRank ?? 5);
  const [presenting, setPresenting] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const changed = () => setPresenting(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const changeRef = useRef(changed);
  changeRef.current = changed;
  useEffect(() => {
    let joined = false,
      disposed = false,
      hydrated = false,
      writes = 0,
      storageFailed = false;
    let replica: Awaited<ReturnType<typeof openReplica>> | undefined;
    let storing = Promise.resolve();
    const reportStorageError = () => {
      storageFailed = true;
      setLocalReady(false);
      setBlocked(true);
      setError(
        "本地保存失败，请保留页面并下载恢复文件。磁盘空间或浏览器存储权限可能不足。",
      );
    };
    const outbox = new UpdateOutbox(
      ({ id: messageId, update }) =>
        realtime.send({
          type: "update",
          id: messageId,
          room: id,
          update: toBase64(update),
          protocolVersion: 1,
          codec: "slate-kit",
          schemaVersion: 3,
          epochId: epoch.current,
        }),
      (dirty) => {
        unsaved.current = dirty || writes > 0 || storageFailed;
        setStatus(
          joined
            ? unsaved.current
              ? "正在保存…"
              : "已保存到云端"
            : writes
              ? "正在保存到本地…"
              : dirty
                ? "已保存到本地 · 等待同步"
                : "本地副本 · 等待连接",
        );
      },
    );
    const origin = { remote: true };
    const join = () => {
      if (!hydrated || disposed) return;
      joined = false;
      outbox.pause();
      setConnected(false);
      setStatus("正在同步…");
      realtime.send({
        type: "join",
        id: crypto.randomUUID(),
        room: id,
        vector: toBase64(encodeStateVector(session.doc)),
        protocolVersion: 1,
        codec: "slate-kit",
        schemaVersion: 3,
        epochId: epoch.current,
      });
    };
    const onUpdate = (bytes: Uint8Array) => {
      const entry = { id: crypto.randomUUID(), update: bytes.slice() };
      if (!replica) {
        outbox.enqueue(bytes, entry.id);
        return;
      }
      writes++;
      unsaved.current = true;
      setStatus(joined ? "正在保存…" : "正在保存到本地…");
      storing = storing
        .then(async () => {
          await replica!.store(entry.update, entry, epoch.current);
          writes--;
          if (!disposed) outbox.enqueue(entry.update, entry.id);
        })
        .catch(reportStorageError);
    };
    const stopLocal = session.runtime.onLocalUpdate(onUpdate);
    const unsubscribe = realtime.subscribe((m) => {
      if (m.type === "connected") join();
      if (m.type === "disconnected") {
        joined = false;
        outbox.pause();
        setConnected(false);
        setStatus("连接中断 · 正在重连");
      }
      if (m.room !== id) return;
      try {
        if (["sync-response", "update", "ack"].includes(m.type)) {
          if (
            m.codec !== "slate-kit" ||
            m.schemaVersion !== 3 ||
            m.protocolVersion !== 1 ||
            !m.epochId ||
            (epoch.current && epoch.current !== m.epochId)
          )
            throw Error("文档谱系不匹配，原数据保留，请导出本地副本");
          epoch.current = m.epochId;
        }
        if (m.type === "sync-response") {
          if (typeof m.rank === "number") setServerRank(m.rank);
          session.runtime.applyRemoteUpdate(fromBase64(m.update));
          if (replica)
            storing = storing
              .then(() =>
                replica!.store(fromBase64(m.update), undefined, epoch.current),
              )
              .then(() => {})
              .catch(reportStorageError);
          joined = true;
          setReady(session.runtime.initialized);
          setConnected(true);
          if (!storageFailed) setBlocked(false);
          setError("");
          setCanRetrySync(true);
          outbox.resume();
        } else if (m.type === "update") {
          session.runtime.applyRemoteUpdate(fromBase64(m.update));
          if (replica)
            storing = storing
              .then(() =>
                replica!.store(fromBase64(m.update), undefined, epoch.current),
              )
              .then(() => {})
              .catch(reportStorageError);
          setRevision((n) => n + 1);
        } else if (m.type === "ack") {
          // Clear local durable outbox first; a crash before this commit safely replays the same ID.
          if (replica)
            storing = storing
              .then(() => replica!.acknowledge(m.id))
              .then(() => {
                if (!disposed) outbox.acknowledge(m.id);
              })
              .catch(reportStorageError);
          else outbox.acknowledge(m.id);
        } else if (m.type === "error") {
          if (m.operation === "cursor") return;
          outbox.pause();
          setError(m.message);
          setCanRetrySync(m.status >= 500 || m.status === 400);
          setStatus("保存未完成");
          setConnected(false);
          setBlocked(true);
          joined = false;
        } else if (m.type === "presence") setPeers(m.users);
        else if (m.type === "document.changed") {
          changeRef.current();
          if (joined)
            realtime.send({
              type: "sync-request",
              id: crypto.randomUUID(),
              room: id,
              vector: toBase64(encodeStateVector(session.doc)),
              protocolVersion: 1,
              codec: "slate-kit",
              schemaVersion: 3,
              epochId: epoch.current,
            });
        }
      } catch (e) {
        outbox.pause();
        setError((e as Error).message);
        setCanRetrySync(false);
        joined = false;
        setConnected(false);
        setBlocked(true);
      }
    });
    const release = realtime.retain();
    void (async () => {
      try {
        if (user) {
          replica = await openReplica(user.id, id, "slate-kit:3");
          const cached = await replica.load();
          if (disposed) {
            replica.close();
            return;
          }
          applyUpdate(session.doc, cached.checkpoint, origin);
          epoch.current = cached.epochId;
          for (const entry of cached.pending)
            outbox.enqueue(entry.update, entry.id);
          setReady(session.runtime.initialized);
          setLocalReady(true);
        }
      } catch {
        if (!disposed) reportStorageError();
      }
      hydrated = true;
      if (realtime.connected) join();
    })();
    const guard = (e: BeforeUnloadEvent) => {
      if (outbox.pending || writes || storageFailed) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", guard);
    const retry = setInterval(() => {
      if (joined && outbox.pending && !storageFailed) {
        outbox.pause();
        outbox.resume();
      }
    }, 8000);
    return () => {
      disposed = true;
      outbox.pause();
      void storing.finally(() => replica?.close());
      realtime.send({ type: "leave" });
      unsubscribe();
      release();
      clearInterval(retry);
      stopLocal();
      window.removeEventListener("beforeunload", guard);
      session.runtime.destroy();
      session.doc.destroy();
    };
  }, [id, session, user?.id]);
  const reading = useDocumentReadOnly(serverRank === null ? undefined : rank >= 3);
  const editable =
    !reading && ready && rank >= 3 && !presenting && !blocked && (connected || localReady);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRevision((n) => n + 1));
    };
    session.doc.on("update", update);
    return () => {
      session.doc.off("update", update);
      cancelAnimationFrame(frame);
    };
  }, [session]);
  const adapter = useMemo(() => createYjsAdapter(session.runtime), [session]);
  const bodyHasContent = useMemo(
    () =>
      session.runtime.getValue().slice(1).some((node: any) => {
        if (Node.string(node).trim()) return true;
        // Empty paragraphs are only layout placeholders. Other blocks such as
        // images, tables, and embeds still make the document non-empty.
        return node.type !== "paragraph";
      }),
    [session, revision, ready],
  );
  const resources = useMemo<ResourceConfig>(() => {
    const upload: NonNullable<ResourceConfig["uploadImage"]> = async (
      file,
      context,
    ) => uploadDocumentResource(file, context, id);
    return {
      uploadImage: upload,
      uploadVideo: upload,
      uploadAttachment: upload,
      resolveUrl: (path) =>
        /^[a-f0-9-]{36}$/.test(path) ? assetUrl(path) : "",
      resolveDownloadUrl: (path) =>
        /^[a-f0-9-]{36}$/.test(path) ? assetUrl(path) + "?download=1" : "",
    };
  }, [id]);
  const pdfProjection = useRichTextPdfProjection({ resources, plugins: documentPlugins, locale, formulaRenderer: renderKatex });
  function captureAISelection() {
      const editor = handle.current?.editor;
      const dom = editor ? selectedTextRange(editor, contentHost.current) : null;
      const selection = dom && !Range.isCollapsed(dom) ? dom : editor?.selection;
      if (!editor || !selection) throw new Error("comment_need_selection");
      return captureRichSelection(editor, session.runtime, selection, epoch.current);
  }
  function selectComment() {
    try {
      setAnchor(captureAISelection());
      setReply(null);
      setEditingComment(null);
      setCommentsOpen(true);
      setError("");
    } catch (e) {
      const message = (e as Error).message;
      setError(message === "comment_need_selection" ? t("comment.needSelection") : message);
    }
  }
  const [aiHighlightedAnchor, setAIHighlightedAnchor] = useState<unknown>(null);
  useEffect(() => {
    if (!aiHighlightedAnchor) return;
    const timer = setTimeout(() => setAIHighlightedAnchor(null), 5000);
    return () => clearTimeout(timer);
  }, [aiHighlightedAnchor]);
  useAIBridge(id, { capture: captureAISelection, ready: () => ready && connected && !unsaved.current && !blocked,
    reveal: a => {
      if (a.epochId !== epoch.current) throw Error("引用已失效，请重新选择内容");
      const resolved = resolveRichAnchor(session.runtime, a)[0];
      if (!resolved) throw Error("引用内容已删除");
      setAIHighlightedAnchor({ ...a });
      handle.current?.scrollToBlock(resolved.blockId);
    } });
  const roots = detail.comments.filter((c) => {
    if (!c.anchor || c.parent_id || c.resolved || c.deleted_at || !ready)
      return false;
    try {
      const a = JSON.parse(c.anchor);
      return resolveRichAnchor(session.runtime, a).length > 0;
    } catch {
      return false;
    }
  });
  // Navigate in document order, not the reverse-chronological API order.
  const blockOrder = new Map<string, number>();
  if (roots.length && handle.current?.editor) {
    for (const [node] of Node.nodes(handle.current.editor)) {
      if (Element.isElement(node) && typeof node.id === "string")
        blockOrder.set(node.id, blockOrder.size);
    }
    const positions = new Map(
      roots.map((c) => {
        const a = JSON.parse(c.anchor!);
        return [
          c.id,
          resolveRichAnchor(session.runtime, a)[0]!,
        ];
      }),
    );
    roots.sort((a, b) => {
      const left = positions.get(a.id)!,
        right = positions.get(b.id)!;
      return (
        (blockOrder.get(left.blockId) ?? Infinity) -
          (blockOrder.get(right.blockId) ?? Infinity) ||
        left.start - right.start
      );
    });
  }
  async function saveComment(richBody: CommentBody) {
    setBusy(true);
    try {
      if (editingComment)
        await api(`/resources/${id}/comments/${editingComment.id}`, "PATCH", {
          version: editingComment.version,
          richBody,
        });
      else
        await api(`/resources/${id}/comments`, "POST", {
          richBody,
          parentId: reply,
          ...(!reply && anchor ? { anchor: JSON.stringify(anchor) } : {}),
        });
      setEditingComment(null);
      setAnchor(null);
      setReply(null);
      changed();
    } finally {
      setBusy(false);
    }
  }
  const composer = (
    <CommentComposer
      autoFocus
      key={editingComment?.id ?? reply ?? anchor?.start ?? "new"}
      resourceId={id}
      replyTo={reply ? replyTo : undefined}
      initial={
        editingComment
          ? parsedComment(
              detail.comments.find((c) => c.id === editingComment.id)!,
            )
          : undefined
      }
      disabled={busy || !connected || unsaved.current}
      submit={saveComment}
      close={() => {
        setReply(null);
        setAnchor(null);
        setEditingComment(null);
      }}
    />
  );
  return (
    <RichPluginElements documentId={id} handle={toolbarHandle} editable={editable}>{elementInsert => <section
      ref={shell}
      data-page-width={pageWidth}
      style={{ "--document-panel-right": `${panelBounds.right}px`, "--document-panel-top": `${panelBounds.top}px`, "--document-panel-bottom": `${panelBounds.bottom}px` } as React.CSSProperties}
      className={`document-editor-shell ${compact ? "compact-document" : ""}`}
      onKeyDownCapture={(e) => {
        if (
          (e.metaKey || e.ctrlKey) &&
          e.altKey &&
          e.key.toLowerCase() === "m" &&
          connected &&
          rank >= 2
        ) {
          e.preventDefault();
          e.stopPropagation();
          selectComment();
        }
      }}
    >
      <DocumentPageWidthMenu
        mode={pageWidth}
        change={setPageWidth}
        disabled={!canEditPageWidth(detail.resource)}
      />
      {attachmentPreview.dialog}
      {pdfProjection.view}
      <DocumentDownload
        disabled={!ready}
        onError={setError}
        options={[...(["docx", "markdown", "pdf"] as const).map((format) => ({
          label:
            format === "docx"
              ? "Word（.docx）"
              : format === "markdown"
                ? "Markdown（.md）"
                : "PDF（.pdf）",
          run: async () => {
            const { exportDocument } =
              await import("@smartdoca/slate/conversion");
            const signal = new AbortController().signal;
            if (format === "pdf") {
              const page = shell.current?.querySelector<HTMLElement>(".sk-page");
              if (!page) throw Error(t("pdf.previewNotReady"));
              downloadResult(await pdfProjection.exportPdf(session.runtime.getValue(), id, detail.resource.title, page.getBoundingClientRect().width, shell.current));
              return;
            }
            downloadResult(
              await exportDocument(session.runtime.getValue(), {
                format,
                filename: detail.resource.title,
                resources: {
                  signal,
                  resolveResource: async (r, purpose) => {
                    const blob = await readAsset(r.path, signal);
                    return purpose === "embed"
                      ? {
                          bytes: blob,
                          mimeType: blob.type || r.mimeType,
                          filename: r.name,
                        }
                      : {
                          url: new URL(
                            assetUrl(r.path) + "?download=1",
                            location.origin,
                          ).href,
                        };
                  },
                },
              }),
            );
          },
        })), {
          label: "保存到平台文件夹（Markdown）",
          run: async () => {
            const { exportDocument } =
              await import("@smartdoca/slate/conversion");
            const signal = new AbortController().signal;
            const exported = await exportDocument(session.runtime.getValue(), {
              format: "markdown",
              filename: detail.resource.title,
              signal,
              resources: {
                signal,
                resolveResource: async (r, purpose) => {
                  const blob = await readAsset(r.path, signal);
                  return purpose === "embed"
                    ? { bytes: blob }
                    : {
                        url: new URL(
                          assetUrl(r.path) + "?download=1",
                          location.origin,
                        ).href,
                      };
                },
              },
            });
            reportWarnings(exported.warnings);
            await saveToPlatformFolder(exported.blob, detail.resource.title + ".md");
          },
        }]}
      />
      {!presenting &&
        rank >= 3 &&
        !(error && !ready) &&
        toolbarSlot &&
        createPortal(
          <EditorToolbar
            handle={toolbarHandle}
            disabled={!editable}
            selectionRevision={selectionRevision}
            elementInsert={elementInsert}
          />,
          toolbarSlot,
        )}
      {liveInfo &&
        createPortal(
          <span className="document-live-details">
            <span role="status">{status}</span>
            <span>{peers.length} 人在线</span>
            <span className="editor-peers">
              {peers.map((p) => (
                <UserBadge
                  key={p.id}
                  id={p.id}
                  name={p.display_name}
                  avatarOnly
                />
              ))}
            </span>
          </span>,
          liveInfo,
        )}
      {!commentsOpen && (
        <button
          className="icon editor-panel-toggle"
          aria-label={t("comment.openRegion")}
          title={t("comment.region")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setCommentsOpen(true)}
        >
          <MessageSquare size={18} />
          {roots.length > 0 && <small>{roots.length}</small>}
        </button>
      )}
      {error && (
        <div className="error" role="alert">
          {error}{" "}
          {canRetrySync && (
            <button onClick={() => realtime.socket?.close()}>重新连接</button>
          )}
        </div>
      )}
      {(uploadStates.some((upload) => upload.status === "error" && !dismissedUploadErrors.has(upload.blockId)) || mediaCommandError || playbackError) && <div className="document-media-errors">
      <button className="icon document-media-errors-close" aria-label={t("dialog.close")} onClick={() => {
        setDismissedUploadErrors(new Set(uploadStates.map((upload) => upload.blockId)));
        setMediaCommandError("");
        setPlaybackError(null);
      }}><X size={16} /></button>
      {uploadStates.filter((upload) => upload.status === "error" && !dismissedUploadErrors.has(upload.blockId)).map((upload) => (
        <div className="document-media-error" role="alert" key={upload.blockId}>
          {t("editor.uploadFailed", {
            name: upload.file.name,
            reason: upload.error instanceof Error ? upload.error.message : t("editor.uploadFailedUnknown"),
          })}
        </div>
      ))}
      {mediaCommandError && <div className="document-media-error" role="alert">{mediaCommandError}</div>}
      {playbackError && (
        <div className="document-media-error" role="alert">
          {t("editor.videoPlaybackFailed", {
            name: playbackError.name,
            reason: t(playbackError.code === 2 ? "editor.videoNetworkError" : playbackError.code === 3 ? "editor.videoDecodeError" : "editor.videoUnsupported"),
          })}
        </div>
      )}
      </div>}
      {(blocked || (ready && !connected)) && (
        <div className="subtle small">
          {blocked
            ? "同步已暂停，未确认的修改仍保留在此浏览器，可先下载恢复文件。"
            : localReady
              ? "离线编辑保存在此浏览器，联网后自动同步。离线期间上传、评论和用户搜索不可用。"
              : "未保存的内容仍保留在此页面，请不要关闭。"}
          <button
            onClick={() => {
              const blob = new Blob(
                [
                  JSON.stringify({
                    codec: "slate-kit",
                    schemaVersion: 3,
                    epochId: epoch.current,
                    resourceId: id,
                    checkpoint: toBase64(encodeStateAsUpdate(session.doc)),
                  }),
                ],
                { type: "application/json" },
              );
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `doca-recovery-${id}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            下载恢复文件
          </button>
        </div>
      )}
      <OutlineDrawer
        container={shell}
        headings={headings}
        always={outlineCollapsed}
        inlineAvailable={pageLayout.outlineInline}
        restore={() => setOutlineCollapsed(false)}
        hidden={presenting || mobileEditor}
        navigate={(id) =>
          handle.current?.scrollToBlock(id, {
            behavior: "smooth",
            block: "start",
          })
        }
      />
      <div className={`editor-columns ${commentsOpen ? "with-comments" : ""} ${!outlineInline ? "outline-collapsed" : ""}`}
        style={{
          gridTemplateColumns: mobileEditor ? "minmax(0, 1fr)" : `${outlineInline ? "200px " : ""}minmax(0, 1fr)${commentsOpen && !compact ? " 280px" : ""}`,
          minWidth: mobileEditor ? 0 : pageLayout.paper ? pageLayout.paper + 40 + (outlineInline ? 216 : 0) + (commentsOpen && !compact ? 296 : 0) : 0,
        }}>
        {ready && (
          <ModelFind documentId={detail.resource.id} handle={handle} revision={revision} canEdit={editable} />
        )}
        {ready && (
          <DocumentMentions
            handle={toolbarHandle}
            revision={selectionRevision}
            enabled={editable}
          />
        )}
        {outlineInline && <DocumentOutline headings={headings} container={shell}
          collapse={() => setOutlineCollapsed(true)}
          navigate={id => handle.current?.scrollToBlock(id, { behavior: "smooth", block: "start" })}
        />}
        <div
          className="editor-content"
          style={{ maxWidth: mobileEditor ? "none" : pageLayout.paper || "none" }}
          ref={contentHost}
          onDragOverCapture={(event) => {
            if (editable && (event.target as HTMLElement).closest("[data-slate-editor]") && event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDropCapture={(event) => {
            const editorHandle = handle.current;
            const files = Array.from(event.dataTransfer.files);
            if (!editable || rank < 3 || presenting || !editorHandle || !files.length || !(event.target as HTMLElement).closest("[data-slate-editor]")) return;
            event.preventDefault();
            event.stopPropagation();
            const problem = files.map(documentUploadProblem).find(Boolean);
            if (problem) { setMediaCommandError(t(problem.key, problem.values)); return; }
            // Use the native upload command at the drop location; it owns placeholders and the live insertion range.
            try {
              Transforms.select(editorHandle.editor, ReactEditor.findEventRange(editorHandle.editor, event));
              editorHandle.commands.focus();
              setMediaCommandError("");
              for (const file of files) void editorHandle.commands.uploadMedia(file).catch((error: Error) => setMediaCommandError(error.message));
            } catch (error) {
              setMediaCommandError((error as Error).message);
            }
          }}
          onErrorCapture={(event) => {
            if (event.target instanceof HTMLVideoElement && event.target.error && event.target.error.code !== 1) setPlaybackError({
              name: event.target.getAttribute("aria-label") || t("editor.video"),
              code: event.target.error.code,
              src: event.target.currentSrc || event.target.src,
            });
          }}
          onLoadedDataCapture={(event) => {
            if (event.target instanceof HTMLVideoElement) {
              const src = event.target.currentSrc || event.target.src;
              setPlaybackError((current) => current?.src === src ? null : current);
            }
          }}
          onPasteCapture={(e) => {
            if (editable && (e.target as HTMLElement).closest("[data-slate-editor]") && e.clipboardData.files.length) {
              const problem = Array.from(e.clipboardData.files).map(documentUploadProblem).find(Boolean);
              if (problem) {
                e.preventDefault();
                e.stopPropagation();
                setMediaCommandError(t(problem.key, problem.values));
              } else setMediaCommandError("");
              return;
            }
            if (
              !editable ||
              rank < 3 ||
              presenting ||
              !handle.current ||
              !(e.target as HTMLElement).closest("[data-slate-editor]") ||
              e.clipboardData.files.length
            )
              return;
            if (
              internalDocumentId(
                e.clipboardData.getData("text/plain").trim(),
                location.origin,
              )
            ) {
              e.preventDefault();
              e.stopPropagation();
              handle.current.editor.insertData(e.clipboardData);
            }
          }}
        >
          {ready ? (
            <EditorRecoveryBoundary
              key={id}
              onFailure={() => {
                handle.current = null;
                setBlocked(true);
                setError("编辑器显示异常，本地数据仍保留，请先下载恢复文件。");
              }}
              readText={() => {
                const lines: string[] = [];
                const visit = (n: any) => {
                  if (typeof n.text === "string") lines.push(n.text);
                  else {
                    if (typeof n.code === "string") lines.push(n.code);
                    if (typeof n.label === "string") lines.push(n.label);
                    n.children?.forEach(visit);
                  }
                };
                session.runtime.getValue().forEach(visit);
                return lines.join("\n");
              }}
              backup={() => {
                const blob = new Blob(
                  [
                    JSON.stringify({
                      codec: "slate-kit",
                      schemaVersion: 3,
                      epochId: epoch.current,
                      resourceId: id,
                      checkpoint: toBase64(encodeStateAsUpdate(session.doc)),
                    }),
                  ],
                  { type: "application/json" },
                );
                const url = URL.createObjectURL(blob),
                  a = document.createElement("a");
                a.href = url;
                a.download = `doca-recovery-${id}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
              render={() => (
                <RichTextEditor
                  locale={locale}
                  formulaRenderer={renderKatex}
                  onChange={selectionChanged}
                  firstLineTitle
                  plugins={documentPlugins}
                  initialValue={session.runtime.getValue()}
                  collaboration={adapter}
                  resources={resources}
                  onAttachmentPreview={attachmentPreview.onRichAttachmentPreview}
                  onUploadStateChange={setUploadStates}
                  mode={editable ? "edit" : "readonly"}
                  onReady={editorReady}
                  onOutlineChange={outlineChanged}
                  placeholder={t("editor.bodyPlaceholder")}
                  bodyPlaceholder={
                    bodyHasContent ? "" : t("editor.bodyPlaceholder")
                  }
                />
              )}
            />
          ) : (
            <p className="empty">正在加载文档内容…</p>
          )}
          {ready && (
            <>
              <SelectionCommentAction
                host={contentHost}
                handle={handle}
                editable={connected && editable}
                canComment={connected && rank >= 2 && !presenting}
                create={selectComment}
              />
              <CommentHighlights
                host={contentHost}
                handle={handle}
                runtime={session.runtime}
                comments={roots}
                transientAnchor={aiHighlightedAnchor}
                active={activeThread}
                select={(threadId) => {
                  setActiveThread(threadId);
                  if (!threadId) return;
                  setCommentsOpen(true);
                  requestAnimationFrame(() =>
                    scrollCommentIntoView(shell.current
                      ?.querySelector(`[data-thread-id="${threadId}"]`)),
                  );
                }}
              />
            </>
          )}
          {ready && (
            <RemoteCursors
              id={id}
              handle={handle}
              runtime={session.runtime}
              host={contentHost}
              editable={connected && editable}
            />
          )}
          {discussion}
        </div>
        {commentsOpen && (
          <aside className={`content-comments ${compact ? "document-comments-drawer" : ""}`} aria-label={compact ? t("comment.drawer") : t("comment.region")}>
            <header>
              <h3>{t("comment.region")}<small>{roots.length}</small>
              </h3>
              <CommentNavigation
                ids={roots.map((c) => c.id)}
                active={activeThread}
                select={(id) => {
                  const c = roots.find((c) => c.id === id)!;
                  setVisibleThreads(roots.length);
                  setActiveThread(id);
                  try {
                    scrollCommentIntoView(contentHost.current?.querySelector(
                      `[data-block-id="${CSS.escape(resolveRichAnchor(session.runtime, JSON.parse(c.anchor!))[0]!.blockId)}"]`,
                    ), "center");
                  } catch {}
                }}
              />
              <button
                className="icon"
                aria-label={t("comment.closeRegion")}
                onClick={() => setCommentsOpen(false)}
              >
                <PanelRightClose size={18} />
              </button>
            </header>
            {!roots.length && !anchor && (
              <p className="subtle">{t("comment.selectionHint")}</p>
            )}
            <CommentCards
              compact={compact}
              handle={handle}
              runtime={session.runtime}
            >
              {roots.slice(0, visibleThreads).map((c) => {
                let quote = t("comment.quoteDeleted"),
                  blockId = "";
                try {
                  const a = JSON.parse(c.anchor!);
                  const resolved = resolveRichAnchor(session.runtime, a)[0];
                  quote = resolved ? a.quote : t("comment.quoteDeleted");
                  blockId = resolved?.blockId ?? "";
                } catch {}
                return (
                  <article
                    className={`selection-thread ${activeThread === c.id ? "active" : ""}`}
                    data-thread-id={c.id}
                    onClick={() => setActiveThread(c.id)}
                    key={c.id}
                    data-anchor={c.anchor}
                    aria-label={t("comment.thread", { quote })}
                  >
                    <button
                      className="comment-quote"
                      title={quote}
                      onClick={() =>
                        scrollCommentIntoView(contentHost.current?.querySelector(
                          `[data-block-id="${CSS.escape(blockId)}"]`,
                        ), "center")
                      }
                    >
                      {quote}
                    </button>
                    {[c, ...detail.comments.filter((x) => x.parent_id === c.id)]
                      .slice(0, (visibleReplies[c.id] ?? 3) + 1)
                      .map((item) => (
                        <CommentMessage
                          key={item.id}
                          comment={item}
                          user={user}
                          rank={rank}
                          reply={() => {
                            setReply(c.id);
                            setReplyTo(item);
                            setAnchor(null);
                            setEditingComment(null);
                          }}
                          edit={() => {
                            setEditingComment({
                              id: item.id,
                              version: item.version,
                            });
                            setReply(null);
                            setAnchor(null);
                          }}
                          act={(patch) => {
                            void api(
                              `/resources/${id}/comments/${item.id}`,
                              "PATCH",
                              { version: item.version, ...patch },
                            )
                              .then(changed)
                              .catch((e) => setError(e.message));
                          }}
                        />
                      ))}
                    {detail.comments.filter((x) => x.parent_id === c.id)
                      .length > (visibleReplies[c.id] ?? 3) && (
                      <button
                        className="comments-load-more"
                        onClick={() =>
                          setVisibleReplies((v) => ({
                            ...v,
                            [c.id]: (v[c.id] ?? 3) + 10,
                          }))
                        }
                      >{t("comment.moreReplies")}</button>
                    )}
                    {(reply === c.id ||
                      (editingComment &&
                        [
                          c,
                          ...detail.comments.filter(
                            (x) => x.parent_id === c.id,
                          ),
                        ].some((x) => x.id === editingComment.id))) &&
                      composer}
                  </article>
                );
              })}
              {anchor && (
                <article
                  className="selection-thread draft"
                  data-anchor={JSON.stringify(anchor)}
                >
                  <blockquote>{anchor.quote}</blockquote>
                  {composer}
                </article>
              )}
            </CommentCards>
            {visibleThreads < roots.length && (
              <button
                className="comments-load-more"
                onClick={() => setVisibleThreads((n) => n + 10)}
              >
                {t("comment.more")}
              </button>
            )}
            {visibleThreads >= roots.length &&
              detail.commentsNextCursor != null && (
                <button
                  className="comments-load-more"
                  disabled={busy}
                  onClick={() => void loadMoreComments?.()}
                >{t("comment.moreLater")}</button>
              )}
          </aside>
        )}
      </div>
    </section>}</RichPluginElements>
  );
}
