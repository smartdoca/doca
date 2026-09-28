import { useI18n } from "@web/shared/i18n.js";
import { platformAssetId } from "@web/shared/utils/asset-path.js";
import { useAI } from "@web/features/ai/ai-context.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, MessageSquare } from "lucide-react";
import {
  DocumentDownload,
  downloadResult,
  readAsset,
  preparePdfImage,
} from "@web/features/documents/file-transfer.js";
import { loadPdfFontBytes } from "@web/features/documents/pdf-font.js";
import { OutlineDrawer } from "@web/features/documents/outline-drawer.js";
import { attachMarkdownScroll } from "@web/features/documents/markdown-scroll.js";
import { useDocumentReadOnly } from "@web/features/documents/document-mode.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createPortal } from "react-dom";
import * as Y from "yjs";
import {
  CollaborativeMarkdownEditor,
  createHostMarkdownSession,
  initializeMarkdownDocument,
  updateHostMarkdownSession,
  observeLocalMarkdownUpdates,
  applyRemoteMarkdownUpdate,
  MARKDOWN_HOST_CAPABILITIES,
  type CollaborativeMarkdownEditorHandle,
  type EditorResources,
  type MarkdownTextSelection,
  type ToolbarProps,
  Toolbar,
  exportMarkdownFile,
  createMarkdownTextAnchor,
  type RemoteMarkdownSelection,
} from "@smartdoca/markdown";
import {
  api,
  assetUrl,
  roleRank,
  uploadFile,
  type Detail,
  type User,
} from "@web/shared/api.js";
import { realtime, fromBase64, toBase64 } from "@web/features/documents/realtime.js";
import { openReplica } from "@web/features/documents/offline-replica.js";
import { UpdateOutbox } from "@web/features/documents/update-outbox.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { ModelFind } from "@web/features/search/model-find.js";
import {
  RegionComments,
  RegionCommentActionContext,
  type RegionController,
} from "@web/features/comments/region-comments.js";
import {
  decodeMarkdownAnchor,
  encodeMarkdownAnchor,
} from "@core/modules/documents/codecs/markdown-anchor.js";
import "@web/features/documents/surface.css";
import "@smartdoca/markdown/style.css";
import "katex/dist/katex.min.css";
import "@web/features/documents/markdown.css";

const Empty = () => null;
function MarkdownToolbar(props: ToolbarProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("editor-toolbar-slot")), []);
  // Public SDK commands, host layout. Prevent icon clicks from discarding the text selection.
  return slot
    ? createPortal(
        <div
          className="doca-markdown markdown-toolbar"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) e.preventDefault();
          }}
        >
          <Toolbar {...props} hostActions={undefined} />
        </div>,
        slot,
      )
    : null;
}
const components = { Header: Empty, Footer: Empty, Toolbar: MarkdownToolbar };
const protocol = {
  codec: MARKDOWN_HOST_CAPABILITIES.codec,
  schemaVersion: MARKDOWN_HOST_CAPABILITIES.schemaVersion,
  protocolVersion: MARKDOWN_HOST_CAPABILITIES.protocolVersion,
};

export default function MarkdownDocument({
  detail,
  user,
  changed,
  targetComment,
  loadMoreComments,
}: {
  detail: Detail;
  user: User | null;
  changed: () => void;
  targetComment?: string | null;
  loadMoreComments?: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const id = detail.resource.id;
  const ai = useAI();
  const createComment = useRef<() => void>(() => {});
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    if (container.current) return attachMarkdownScroll(container.current);
  }, []);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const previousTitle = useRef(detail.resource.title);
  useEffect(() => {
    if (previousTitle.current === detail.resource.title) return;
    const timer = setTimeout(() => {
      previousTitle.current = detail.resource.title;
      changedRef.current();
    }, 2000);
    return () => clearTimeout(timer);
  }, [detail.resource.title]);
  const model = useMemo(() => {
    const doc = new Y.Doc();
    // The session asserts codec metadata immediately. An empty replica has none
    // until the server checkpoint arrives, so stamp the supported codec first.
    initializeMarkdownDocument(doc, "");
    return createHostMarkdownSession({
      doc,
      state: "loading",
      saveState: "unavailable",
      ready: false,
    });
  }, [id]);
  const handle = useRef<CollaborativeMarkdownEditorHandle>(null);
  const [active, setActive] = useState<string | null>(null);
  const [ready, setReady] = useState(false),
    [online, setOnline] = useState(false),
    [blocked, setBlocked] = useState(false),
    [serverRank, setServerRank] = useState(5),
    [dirty, setDirty] = useState(false),
    [status, setStatus] = useState("正在加载 Markdown…"),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const [liveSlot, setLiveSlot] = useState<HTMLElement | null>(null);
  const epoch = useRef<string | undefined>(undefined),
    unsaved = useRef(false),
    remote = useRef<RemoteMarkdownSelection[]>([]);
  const reading = useDocumentReadOnly(
    ready
      ? Math.min(serverRank, roleRank(detail.resource.role)) >= 3
      : undefined,
  );
  const canEdit =
    !reading &&
    !!user &&
    ready &&
    !blocked &&
    Math.min(serverRank, roleRank(detail.resource.role)) >= 3;
  const editable = useRef(canEdit);
  editable.current = canEdit;
  const session = useMemo(
    () =>
      updateHostMarkdownSession(model, {
        ready,
        state: blocked
          ? "error"
          : online
            ? "ready"
            : ready
              ? "disconnected"
              : "loading",
        saveState: blocked
          ? "error"
          : dirty
            ? online
              ? "saving"
              : "dirty"
            : online
              ? "clean"
              : "unavailable",
        epochId: epoch.current,
      }),
    [model, ready, online, blocked, dirty],
  );
  useEffect(
    () => setLiveSlot(document.getElementById("document-live-info")),
    [],
  );
  const contentChanged = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let disposed = false,
      hydrated = false,
      joined = false,
      failed = false,
      writes = 0;
    let replica: Awaited<ReturnType<typeof openReplica>> | undefined;
    let storing = Promise.resolve();
    const display = (pending: boolean) => {
      unsaved.current = pending || writes > 0 || failed;
      setDirty(unsaved.current);
      setStatus(
        failed
          ? "同步已暂停，请保留页面并导出恢复副本"
          : joined
            ? unsaved.current
              ? "正在保存…"
              : "已保存到云端"
            : writes
              ? "正在保存到本地…"
              : pending
                ? "已保存到本地 · 等待同步"
                : "本地副本 · 等待连接",
      );
    };
    const queue = new UpdateOutbox(
      (entry) =>
        realtime.send({
          type: "update",
          room: id,
          id: entry.id,
          ...protocol,
          epochId: epoch.current,
          update: toBase64(entry.update),
        }),
      display,
    );
    const failure = (e: unknown) => {
      if (disposed) return;
      failed = true;
      joined = false;
      queue.pause();
      setOnline(false);
      setBlocked(true);
      setError((e as Error).message);
      display(queue.pending);
    };
    const join = () => {
      if (!hydrated || disposed || failed) return;
      joined = false;
      queue.pause();
      setOnline(false);
      realtime.send({
        type: "join",
        room: id,
        id: crypto.randomUUID(),
        ...protocol,
        epochId: epoch.current,
        vector: toBase64(Y.encodeStateVector(model.doc)),
      });
    };
    const stopLocal = observeLocalMarkdownUpdates(model, ({ update }) => {
      const entry = { id: crypto.randomUUID(), update: update.slice() };
      writes++;
      display(true);
      storing = storing
        .then(async () => {
          if (!replica || !epoch.current)
            throw Error("本地副本不可用，请导出当前内容后重新打开");
          await replica.store(entry.update, entry, epoch.current);
          writes--;
          if (!disposed) queue.enqueue(entry.update, entry.id);
        })
        .catch(failure);
    });
    const validate = (m: Record<string, any>) => {
      if (
        m.codec !== protocol.codec ||
        m.schemaVersion !== protocol.schemaVersion ||
        m.protocolVersion !== protocol.protocolVersion ||
        typeof m.epochId !== "string"
      )
        throw Error("Markdown 协同协议不匹配");
      if (epoch.current && epoch.current !== m.epochId)
        throw Error("文档版本已切换；未同步内容仍保留在本地，请导出恢复副本");
    };
    const stop = realtime.subscribe((m) => {
      if (disposed) return;
      if (m.type === "connected") join();
      if (m.type === "disconnected") {
        joined = false;
        queue.pause();
        setOnline(false);
        remote.current = [];
        handle.current?.clearRemoteSelections();
        if (m.code === 4403 || m.code === 4401)
          failure(Error("访问权限已变更，已停止编辑和同步"));
        else display(queue.pending);
      }
      if (m.room !== id || failed) return;
      try {
        if (m.type === "sync-response" || m.type === "update") {
          validate(m);
          epoch.current = m.epochId;
          if (typeof m.rank === "number") setServerRank(m.rank);
          applyRemoteMarkdownUpdate(model.doc, fromBase64(m.update));
          storing = storing
            .then(async () => {
              if (replica)
                await replica.store(
                  fromBase64(m.update),
                  undefined,
                  epoch.current,
                );
            })
            .catch(failure);
          if (m.type === "sync-response") {
            setReady(true);
            joined = true;
            setOnline(true);
            queue.resume();
          }
          if (editable.current)
            handle.current?.renderRemoteSelections(remote.current);
        } else if (m.type === "ack") {
          validate(m);
          storing = storing
            .then(async () => {
              if (replica) await replica.acknowledge(m.id);
              if (!disposed) queue.acknowledge(m.id);
            })
            .catch(failure);
        } else if (m.type === "document.changed" && joined) {
          changedRef.current();
          realtime.send({
            type: "sync-request",
            room: id,
            id: crypto.randomUUID(),
            ...protocol,
            epochId: epoch.current,
            vector: toBase64(Y.encodeStateVector(model.doc)),
          });
        } else if (m.type === "cursors") {
          remote.current = m.sessions
            .filter(
              (p: any) =>
                p.connectionId !== m.self && p.selection?.kind === "markdown",
            )
            .map((p: any) => ({
              sessionId: p.connectionId,
              userId: p.userId,
              name: p.name,
              color: p.color,
              selection: {
                kind: "text",
                anchor: { bytes: fromBase64(p.selection.anchor) },
                focus: { bytes: fromBase64(p.selection.focus) },
              },
            }));
          if (editable.current)
            handle.current?.renderRemoteSelections(remote.current);
        } else if (m.type === "error" && m.operation !== "cursor")
          failure(Error(m.message));
      } catch (e) {
        failure(e);
      }
    });
    const release = realtime.retain();
    // A lost application ACK must not leave a live socket stuck forever. Retry
    // the same outbox head and bytes; the server's durable receipt is idempotent.
    const retry = window.setInterval(() => {
      if (joined && !failed && queue.pending) {
        queue.pause();
        queue.resume();
      }
    }, 8000);
    void (async () => {
      if (user) {
        replica = await openReplica(
          user.id,
          id,
          `${protocol.codec}:schema-${protocol.schemaVersion}`,
        );
        if (disposed) {
          replica.close();
          return;
        }
        const local = await replica.load();
        if (disposed) return;
        if (local.epochId) {
          epoch.current = local.epochId;
          applyRemoteMarkdownUpdate(model.doc, local.checkpoint);
          setReady(true);
          for (const item of local.pending) queue.enqueue(item.update, item.id);
        }
      }
      hydrated = true;
      if (realtime.connected) join();
    })().catch(failure);
    const guard = (e: BeforeUnloadEvent) => {
      if (unsaved.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      disposed = true;
      queue.pause();
      stopLocal();
      stop();
      window.clearInterval(retry);
      realtime.send({ type: "leave" });
      release();
      void storing.finally(() => replica?.close());
      model.dispose?.();
      model.doc.destroy();
      window.removeEventListener("beforeunload", guard);
    };
  }, [model, id, user?.id]);
  useEffect(() => {
    const publish = (selection: MarkdownTextSelection | null) =>
      realtime.send({
        type: "cursor",
        room: id,
        id: crypto.randomUUID(),
        selection:
          selection && canEdit && online
            ? {
                kind: "markdown",
                anchor: toBase64(selection.anchor.bytes),
                focus: toBase64(selection.focus.bytes),
              }
            : null,
      });
    const stop = handle.current?.onSelectionChange((selection) => {
      // Switching browser tabs must not erase this session's last location.
      // A real focus move within this page (e.g. into a comment) still clears it.
      if (!selection && !document.hasFocus() && canEdit && online) return;
      publish(selection);
    });
    if (!canEdit || !online) {
      publish(null);
      handle.current?.clearRemoteSelections();
    }
    const leave = () => publish(null);
    window.addEventListener("pagehide", leave);
    return () => {
      stop?.();
      publish(null);
      window.removeEventListener("pagehide", leave);
    };
  }, [ready, canEdit, online, id]);
  const controller = useMemo<RegionController | null>(
    () =>
      ready
        ? {
            capture: () => {
              const a = handle.current?.captureAnchor();
              const range = a && handle.current?.resolveAnchor(a);
              return a && range && epoch.current
                ? encodeMarkdownAnchor(
                    a,
                    epoch.current,
                    model.text.toString().slice(range.from, range.to),
                  )
                : null;
            },
            valid: (a) => {
              try {
                return !!handle.current?.resolveAnchor(
                  decodeMarkdownAnchor(a, epoch.current),
                );
              } catch {
                return false;
              }
            },
            reveal: (a) => {
              try {
                handle.current?.revealAnchor(
                  decodeMarkdownAnchor(a, epoch.current),
                );
              } catch {}
            },
            label: (a) => a.quote || "Markdown 选中文字",
            scrollOffset: () => {
              const view = handle.current?.getEditorView();
              if (!view) return 0;
              if (view.dom.getClientRects().length)
                return (
                  (view.dom.closest(".editor-pane")?.scrollTop ?? 0) +
                  view.scrollDOM.scrollTop
                );
              return (
                view.dom.closest(".workspace")?.querySelector(".preview-pane")
                  ?.scrollTop ?? 0
              );
            },
            scrollExtent: () => {
              const view = handle.current?.getEditorView();
              if (!view) return 0;
              const extent = (el: Element | null) =>
                el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
              if (view.dom.getClientRects().length)
                return (
                  extent(view.dom.closest(".editor-pane")) +
                  extent(view.scrollDOM)
                );
              return extent(
                view.dom
                  .closest(".workspace")
                  ?.querySelector(".preview-pane") ?? null,
              );
            },
            position: (a, commentId) => {
              const range = handle.current?.resolveAnchor(
                decodeMarkdownAnchor(a, epoch.current),
              );
              const view = handle.current?.getEditorView();
              if (!range || !view) return null;
              const sourceVisible = view.dom.getClientRects().length > 0;
              if (sourceVisible) {
                const point = view.coordsAtPos(range.from);
                return {
                  order: range.from,
                  top:
                    point?.top ??
                    view.documentTop + view.lineBlockAt(range.from).top,
                };
              }
              // Preview annotations are portalled to this document's body by
              // the SDK. Comment IDs are resource-global UUIDs, not row indexes.
              const mark = view.dom.ownerDocument.querySelector<HTMLElement>(
                `.exmd-preview-comment[data-comment-id="${CSS.escape(commentId)}"]`,
              );
              return mark
                ? {
                    order: range.from,
                    top: mark.getBoundingClientRect().top,
                  }
                : null;
            },
          }
        : null,
    [ready, model],
  );
  useEffect(() => {
    if (!ready || !handle.current) return;
    const anchors = detail.comments
      .filter((c) => c.anchor && !c.parent_id)
      .flatMap((c) => {
        try {
          return [
            {
              id: c.id,
              anchor: decodeMarkdownAnchor(
                JSON.parse(c.anchor!),
                epoch.current,
              ),
              resolved: !!c.resolved,
              deleted: !!c.deleted_at,
            },
          ];
        } catch {
          return [];
        }
      });
    handle.current.renderAnchors(anchors);
    handle.current.setActiveAnchor(active);
  }, [detail.comments, active, ready, revision]);
  useEffect(() => {
    if (!ready) return;
    const stop = handle.current?.onAnchorClick(setActive);
    const clear = (e: PointerEvent) => {
      if (
        !(e.target as HTMLElement).closest(
          ".exmd-comment-anchor,.region-comments-drawer,.region-comment-controls",
        )
      )
        setActive(null);
    };
    document.addEventListener("pointerdown", clear);
    return () => {
      stop?.();
      document.removeEventListener("pointerdown", clear);
      handle.current?.clearAnchors();
    };
  }, [ready]);
  const resources = useMemo<EditorResources>(
    () => ({
      uploadImage: async (file, context) => {
        const asset = await uploadFile(file, "attachment", id, context.signal);
        context.onProgress(100);
        return { path: asset.id, name: asset.filename, mimeType: asset.mime };
      },
      resolveUrl: (path) =>
        platformAssetId(path) ? assetUrl(platformAssetId(path)!) : "",
      resolveDownloadUrl: (path) =>
        platformAssetId(path) ? assetUrl(platformAssetId(path)!) : "",
    }),
    [id],
  );
  const download = useCallback(
    async (markdown: string, suggestedFileName: string) => {
      // Export current local content for offline recovery; no asset ACL bypass or signed URLs.
      downloadResult(
        exportMarkdownFile(markdown, {
          fileName: suggestedFileName || `${detail.resource.title}.md`,
        }),
      );
    },
    [detail.resource.title],
  );
  const downloadPdf = useCallback(
    async (markdown: string) => {
      const { exportPdfFile } = await import("@smartdoca/markdown");
      downloadResult(
        await exportPdfFile(markdown, {
          fileName: `${detail.resource.title}.pdf`,
          fontBytes: await loadPdfFontBytes(markdown),
          fontSubset: false,
          resolveResource: async ({ path }) => ({
            bytes: await preparePdfImage(
              await readAsset(platformAssetId(path) ?? path),
            ),
          }),
        }),
      );
    },
    [detail.resource.title],
  );
  const headings = useMemo(() => {
    const tree = fromMarkdown(model.text.toString());
    const text = (node: any): string =>
      node.value ?? node.children?.map(text).join("") ?? "";
    const result: { id: string; text: string; level: number }[] = [];
    const walk = (node: any) => {
      if (node.type === "heading")
        result.push({
          id: String(node.position.start.offset),
          text: text(node),
          level: node.depth,
        });
      node.children?.forEach(walk);
    };
    walk(tree);
    return result;
  }, [model, revision, ready]);
  return (
    <RegionCommentActionContext.Provider
      value={{
        add: () => createComment.current(),
        enabled:
          online &&
          !blocked &&
          Math.min(serverRank, roleRank(detail.resource.role)) >= 2,
      }}
    >
      <section ref={container} className="markdown-document surface-editor">
        <OutlineDrawer
          container={container}
          launcherOffset={40}
          headings={headings}
          hidden={!ready}
          always
          keepOpenOnNavigate
          navigate={(id) => {
            const view = handle.current?.getEditorView();
            if (!view) return;
            const position = Number(id),
              line = view.state.doc.lineAt(position);
            handle.current?.revealAnchor(
              createMarkdownTextAnchor(
                model.text,
                position,
                Math.max(position + 1, line.to),
              ),
            );
          }}
        />
        <DocumentDownload
          disabled={!ready}
          onError={setError}
          options={[
            {
              label: "Markdown（.md）",
              run: () =>
                download(
                  handle.current?.getMarkdown() ?? model.text.toString(),
                  "",
                ),
            },
            {
              label: "PDF（.pdf）",
              run: () =>
                downloadPdf(
                  handle.current?.getMarkdown() ?? model.text.toString(),
                ),
            },
          ]}
        />
        {liveSlot &&
          createPortal(<span role="status">{status}</span>, liveSlot)}
        <Feedback message={error} tone="error" />
        {ready && (
          <ModelFind handle={handle} revision={revision} canEdit={canEdit} />
        )}
        <div className="doca-markdown markdown-sdk-container">
          <CollaborativeMarkdownEditor
            locale={locale}
            ref={handle}
            roomId={id}
            collaboration={session}
            mode={canEdit ? "edit" : "readonly"}
            selectionToolbar
            selectionActions={[
              {
                id: "doca.ai",
                title: t("editor.citeAi"),
                icon: <AtSign size={17} />,
                disabled: !user,
                onClick: () => ai?.add(),
              },
              {
                id: "doca.comment",
                title: t("editor.commentSelection"),
                icon: <MessageSquare size={20} />,
                disabled:
                  !online ||
                  blocked ||
                  Math.min(serverRank, roleRank(detail.resource.role)) < 2,
                onClick: () => createComment.current(),
              },
            ]}
            components={components}
            resources={resources}
            title={detail.resource.title}
            onChange={contentChanged}
            height="100%"
          />
        </div>
        <RegionComments
          createAction={createComment}
          detail={detail}
          user={user}
          rank={Math.min(serverRank, roleRank(detail.resource.role))}
          connected={online && !blocked}
          dirty={dirty}
          controller={controller}
          changed={changed}
          revision={revision}
          active={active}
          setActive={setActive}
          targetComment={targetComment}
          loadMoreComments={loadMoreComments}
        />
      </section>
    </RegionCommentActionContext.Provider>
  );
}
