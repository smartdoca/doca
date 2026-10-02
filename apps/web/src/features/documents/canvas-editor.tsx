import { useI18n } from "@web/shared/i18n.js";
import { useAI } from "@web/features/ai/ai-context.js";
import { useDocumentReadOnly } from "@web/features/documents/document-mode.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Eye, EyeOff } from "lucide-react";
import {
  DocumentDownload,
  downloadResult,
  readAsset,
} from "@web/features/documents/file-transfer.js";
import {
  CanvasEditor,
  type CanvasAnchorDecoration,
  type CanvasEditorRef,
  type CanvasEditorResources,
} from "@smartdoca/canvas";
import { CanvasModel } from "@smartdoca/canvas/model";
import {
  api,
  assetUrl,
  uploadFile,
  roleRank,
  type Detail,
  type User,
} from "@web/shared/api.js";
import { realtime } from "@web/features/documents/realtime.js";
import {
  useSurfaceSync,
  type SurfaceFactory,
} from "@web/features/documents/surface-sync.js";
import {
  RegionComments,
  type RegionController,
} from "@web/features/comments/region-comments.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { ModelFind } from "@web/features/search/model-find.js";
import { EditorRecoveryBoundary } from "@web/features/documents/editor-recovery-boundary.js";
import "@smartdoca/canvas/style.css";
import "@web/features/documents/surface.css";
const factory: SurfaceFactory<CanvasModel> = async (b) => {
  const value = CanvasModel.restore({
    codec: "aidcanvas-yjs",
    schemaVersion: 1,
    epochId: b.epochId,
    update: b.update,
  });
  return {
    value,
    vector: () => value.stateVector(),
    checkpoint: () => value.checkpoint().update,
    apply: (update) =>
      value.applyUpdate({
        codec: "aidcanvas-yjs",
        schemaVersion: 1,
        epochId: b.epochId,
        update,
      }),
    local: (callback) => value.onLocalUpdate((t) => callback(t.update, t.id)),
    dispose: () => value.dispose(),
  };
};
export default function CanvasDocument({
  detail,
  user,
  changed,
  targetComment,
  loadMoreComments,
}: {
  detail: Detail;
  user: User | null;
  changed(): void;
  targetComment?: string | null;
  loadMoreComments?: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const ai = useAI();
  const aiRef = useRef(ai);
  aiRef.current = ai;
  const id = detail.resource.id,
    sync = useSurfaceSync(id, user?.id, "aidcanvas-yjs", factory, changed, 1);
  const [renderFailed, setRenderFailed] = useState(false);
  const rank = Math.min(roleRank(detail.resource.role), sync.rank);
  const reading = useDocumentReadOnly(sync.binding ? rank >= 3 : undefined);
  const editable =
    !reading && rank >= 3 && !!sync.binding && !sync.blocked && !renderFailed;
  const createComment = useRef<() => void>(() => {});
  const selectionActions = useMemo(
    () => [
      {
        id: "doca.ai",
        label: t("editor.citeAi"),
        icon: <span>@</span>,
        allowInReadOnly: true,
        tooltip: t("editor.citeAi"),
        onClick: () => aiRef.current?.add(),
      },
      {
        id: "doca.comment",
        label: t("editor.commentSelection"),
        icon: <MessageSquare className="canvas-comment-icon" size={20} />,
        allowInReadOnly: true,
        tooltip: t("editor.commentSelection"),
        disabled: () => rank < 2 || !sync.connected || sync.blocked,
        visible: () => rank >= 2 && sync.connected,
        onClick: () => createComment.current(),
      },
    ],
    [rank, sync.connected, sync.blocked, t],
  );
  const ref = useRef<CanvasEditorRef>(null),
    [handle, setHandle] = useState<CanvasEditorRef | null>(null),
    [active, setActive] = useState<string | null>(null),
    [error, setError] = useState("");
  const [slots, setSlots] = useState<{
    live: HTMLElement | null;
    download: HTMLElement | null;
  }>({ live: null, download: null });
  useEffect(() => {
    setSlots({
      live: document.getElementById("document-live-info"),
      download: document.getElementById("document-export-slot"),
    });
  }, [id]);
  const model = sync.binding?.value;
  useEffect(() => {
    if (!editable) handle?.flush();
    model?.setReadOnly(!editable);
  }, [model, editable, handle]);
  const onReady = useCallback((h: CanvasEditorRef) => {
    ref.current = h;
    setHandle(h);
  }, []);
  useEffect(() => {
    if (!handle) return;
    const focus = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        !event.target.closest(".canvas-document")
      )
        handle.select([]);
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, [handle]);
  const publish = useCallback(
    (selection: { elementIds: string[] } | null) => {
      if (sync.connected)
        realtime.send({
          type: "cursor",
          room: id,
          id: crypto.randomUUID(),
          epochId: model?.epochId,
          selection:
            editable && selection?.elementIds.length
              ? { kind: "elements", ...selection }
              : null,
        });
    },
    [id, sync.connected, editable, model],
  );
  useEffect(() => {
    if (!editable && model) publish(null);
  }, [editable, model, publish]);
  const remote = useMemo(
    () =>
      sync.connected && editable
        ? sync.presence.sessions
            .filter((p) => p.selection?.type === "elements")
            .map((p) => ({
              sessionId: p.connectionId,
              userId: p.userId,
              name: p.name,
              color: p.color,
              elementIds: p.selection.elementIds,
            }))
        : [],
    [sync.presence, sync.connected, editable],
  );
  const [referenceHighlight, setReferenceHighlight] =
    useState<CanvasAnchorDecoration | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setReferenceHighlight(null);
    return () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, [id]);
  const controller = useMemo<RegionController | null>(
    () =>
      handle && model
        ? {
            capture: () => handle.captureAnchor(),
            flush: () => handle.flush(),
            valid: (a) => model.resolveAnchor(a).valid,
            reveal: (a) => {
              handle.revealAnchor(a);
              if (!model.resolveAnchor(a).valid) return;
              if (highlightTimer.current) clearTimeout(highlightTimer.current);
              // Use the SDK's local decoration layer, never select or recolor CRDT elements.
              setReferenceHighlight({
                anchorId: "ai-reference-highlight",
                anchor: a,
                label: "AI 引用内容",
              });
              highlightTimer.current = setTimeout(
                () => setReferenceHighlight(null),
                2400,
              );
            },
            label: (a) =>
              `画布区域 · ${model.resolveAnchor(a).elementIds.length} 个元素`,
          }
        : null,
    [handle, model],
  );
  const [showCommentMarks, setShowCommentMarks] = useState(true);
  const anchors = useMemo<CanvasAnchorDecoration[]>(
    () =>
      detail.comments.flatMap((c) => {
        if (!c.anchor || c.parent_id || c.deleted_at || c.resolved) return [];
        try {
          return [
            {
              anchorId: c.id,
              anchor: JSON.parse(c.anchor),
              label: "查看内容评论",
            },
          ];
        } catch {
          return [];
        }
      }),
    [detail.comments],
  );
  const resources = useMemo<CanvasEditorResources>(
    () => ({
      uploadImage: async (blob, context) => {
        const file =
          blob instanceof File
            ? blob
            : new File([blob], context.fileName, { type: blob.type });
        const a = await uploadFile(file, "attachment", id, context.signal);
        context.onProgress?.(1);
        return { path: a.id, name: a.filename, size: a.size, mimeType: a.mime };
      },
      resolveUrl: (path) =>
        /^[a-f0-9-]{36}$/.test(path) ? assetUrl(path) : "",
      resolveDownloadUrl: (path) =>
        /^[a-f0-9-]{36}$/.test(path) ? assetUrl(path) + "?download=1" : "",
      readImage: (path, context) => readAsset(path, context.signal),
    }),
    [id],
  );
  return (
    <section
      className="surface-editor canvas-document"
      onKeyDownCapture={(event) => {
        // Native contenteditable history is replaced during CRDT projection.
        // Route text-input shortcuts to the package's own session undo stack.
        if (
          !editable ||
          !handle ||
          event.nativeEvent.isComposing ||
          !(event.target instanceof HTMLElement) ||
          !event.target.isContentEditable ||
          !event.target.closest(".doca-canvas") ||
          !(event.metaKey || event.ctrlKey) ||
          event.altKey ||
          event.key.toLowerCase() !== "z"
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) handle.redo();
        else handle.undo();
      }}
    >
      {slots.live &&
        createPortal(<span role="status">{sync.status}</span>, slots.live)}
      <button
        className="icon canvas-comment-visibility"
        aria-label={showCommentMarks ? "隐藏画板评论标记" : "显示画板评论标记"}
        title={showCommentMarks ? "隐藏画板评论标记" : "显示画板评论标记"}
        aria-pressed={showCommentMarks}
        onClick={() => {
          setShowCommentMarks((v) => !v);
          setActive(null);
        }}
      >
        {showCommentMarks ? <Eye size={18} /> : <EyeOff size={18} />}
      </button>
      <DocumentDownload
        disabled={!handle}
        onError={setError}
        options={(["png", "svg"] as const).map((format) => ({
          label: format.toUpperCase() + " 图片",
          run: async () => {
            if (handle)
              downloadResult(
                await handle.exportFile({
                  format,
                  scope: "all",
                  filename: detail.resource.title,
                }),
              );
          },
        }))}
      />
      <Feedback message={sync.error || error} tone="error" />
      {sync.binding && (!sync.connected || sync.blocked) && (
        <button
          className="surface-recovery"
          onClick={() =>
            void sync.exportRecovery().catch((e) => setError(e.message))
          }
        >
          导出本地恢复文件
        </button>
      )}
      {model ? (
        <EditorRecoveryBoundary
          readText={() => ""}
          backup={() =>
            void sync.exportRecovery().catch((e) => setError(e.message))
          }
          onFailure={() => {
            setRenderFailed(true);
            model.setReadOnly(true);
            ref.current = null;
            setHandle(null);
          }}
          render={() => (
            <CanvasEditor
              locale={locale}
              selectionActions={selectionActions}
              model={model}
              hostManaged
              autoSave={false}
              mode={editable ? "edit" : "readonly"}
              showHeader={false}
              className="doca-canvas"
              resources={resources}
              anchors={[
                ...(showCommentMarks
                  ? anchors
                  : anchors.filter((a) => a.anchorId === active)),
                ...(referenceHighlight ? [referenceHighlight] : []),
              ]}
              activeAnchorId={referenceHighlight?.anchorId ?? active}
              onAnchorClick={({ anchorId }) => {
                if (anchorId !== "ai-reference-highlight") setActive(anchorId);
              }}
              onReady={onReady}
              onError={(e) => setError(String(e))}
              sessionId={sync.presence.self}
              remoteSelections={remote}
              onPresenceChange={publish}
              saveStatus={
                sync.blocked ? "error" : sync.dirty ? "saving" : "clean"
              }
              style={{ height: "100%", minHeight: 0 }}
            />
          )}
        />
      ) : (
        <p className="empty">正在加载画布…</p>
      )}
      {handle && (
        <ModelFind documentId={detail.resource.id} handle={ref} revision={sync.revision} canEdit={editable} />
      )}
      <RegionComments
        createAction={createComment}
        detail={detail}
        user={user}
        rank={rank}
        connected={sync.connected}
        dirty={sync.dirty}
        controller={controller}
        changed={changed}
        revision={sync.revision}
        active={active}
        setActive={setActive}
        targetComment={targetComment}
        loadMoreComments={loadMoreComments}
      />
    </section>
  );
}
