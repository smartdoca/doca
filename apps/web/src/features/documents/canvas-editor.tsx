import { useCanvasRichExtensions } from "./canvas-rich-extensions.js";
import { useI18n } from "@web/shared/i18n.js";
import { useCommentHighlight } from "@web/features/comments/use-comment-highlight.js";
import { useAI } from "@web/features/ai/ai-context.js";
import { useDocumentReadOnly } from "@web/features/documents/document-mode.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Sparkles } from "lucide-react";
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
  type CanvasResourceUploadContext,
} from "@smartdoca/canvas";
import { CanvasModel, type CanvasPresence } from "@smartdoca/canvas/model";
import {
  isCanvasViewPreferences,
  isCanvasCreationPreferences,
} from "@smartdoca/canvas/preferences";
import { useCanvasBrowserPreference } from "./canvas-browser-preferences.js";
import { useAttachmentPreview } from "./attachment-preview.js";
import { canvasImageGallery } from "./canvas-image-gallery.js";
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
async function uploadCanvasResource(
  blob: Blob,
  context: CanvasResourceUploadContext,
  id: string,
) {
  const file =
    blob instanceof File
      ? blob
      : new File([blob], context.fileName, { type: blob.type });
  const asset = await uploadFile(
    file,
    "attachment",
    id,
    context.signal,
    (progress) => {
      context.onProgress?.(
        progress.total ? Math.min(0.99, progress.loaded / progress.total) : 0,
      );
    },
  );
  context.onProgress?.(1);
  return {
    path: asset.id,
    name: asset.filename,
    size: asset.size,
    mimeType: asset.mime,
  };
}

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
  const richTextExtensions = useCanvasRichExtensions();
  const aiRef = useRef(ai);
  aiRef.current = ai;
  const id = detail.resource.id,
    sync = useSurfaceSync(id, user?.id, "aidcanvas-yjs", factory, changed, 1);
  const viewPreferences = useCanvasBrowserPreference(
    user?.id,
    id,
    "view",
    isCanvasViewPreferences,
  );
  const creationPreferences = useCanvasBrowserPreference(
    user?.id,
    id,
    "creation",
    isCanvasCreationPreferences,
  );
  const preferenceWarning =
    viewPreferences.status === "unsupported" ||
    creationPreferences.status === "unsupported"
      ? t("editor.canvasPreferenceUnsupported")
      : viewPreferences.status === "unavailable" ||
          creationPreferences.status === "unavailable"
        ? t("editor.canvasPreferenceUnavailable")
        : "";
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
        icon: <Sparkles size={20} />,
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
    commentHost = useRef<HTMLElement>(null),
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
  const attachmentPreview = useAttachmentPreview({
    imageResources: () =>
      model ? canvasImageGallery(model.getValue().scene) : [],
  });
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
        !event.target.closest(".canvas-document") &&
        !commentHost.current?.closest(".ai-document-main")?.querySelector(".document-comment-dock")?.contains(event.target)
      )
        handle.select([]);
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, [handle]);
  const publish = useCallback(
    (selection: CanvasPresence | null) => {
      if (sync.connected)
        realtime.send({
          type: "cursor",
          room: id,
          id: crypto.randomUUID(),
          epochId: model?.epochId,
          selection:
            editable &&
            selection &&
            (selection.elementIds.length || selection.cursor || selection.text)
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
              cursor: p.selection.cursor,
              text: p.selection.text,
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
            reveal: (a, source) => {
              handle.revealAnchor(a);
              if (source === "comment") {
                if (highlightTimer.current) clearTimeout(highlightTimer.current);
                setReferenceHighlight(null);
                return;
              }
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
  const [showCommentMarks, setShowCommentMarks] = useState(false);
  const [highlightedComment, highlightComment] = useCommentHighlight(id, detail.comments);
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
      uploadImage: (blob, context) => uploadCanvasResource(blob, context, id),
      uploadAttachment: (blob, context) =>
        uploadCanvasResource(blob, context, id),
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
      ref={commentHost}
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
      <DocumentDownload
        disabled={!handle}
        onError={setError}
        options={(["png", "svg"] as const).map((format) => ({
          label: format.toUpperCase() + " 图片",
          run: async () => {
            if (!handle) return;
            const result = await handle.exportFile({
              format,
              scope: "all",
              filename: detail.resource.title,
            });
            downloadResult({
              ...result,
              warnings: result.warnings.map((warning) =>
                warning.code === "FONT_NOT_EMBEDDED_SYSTEM_FALLBACK"
                  ? { ...warning, message: t("editor.canvasFontExportWarning") }
                  : warning,
              ),
            });
          },
        }))}
      />
      {attachmentPreview.dialog}
      <Feedback message={sync.error || error} tone="error" />
      <Feedback message={preferenceWarning} tone="warning" />
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
              viewPreferences={viewPreferences.value}
              onViewPreferencesChange={viewPreferences.onChange}
              creationPreferences={creationPreferences.value}
              onCreationPreferencesChange={creationPreferences.onChange}
              selectionActions={selectionActions}
              model={model}
              hostManaged
              autoSave={false}
              mode={editable ? "edit" : "readonly"}
              showHeader={false}
              richTextExtensions={richTextExtensions}
              className="doca-canvas"
              resources={resources}
              onResourcePreview={attachmentPreview.onCanvasResourcePreview}
              onAttachmentPreview={attachmentPreview.onCanvasAttachmentPreview}
              anchors={[
                ...(showCommentMarks
                  ? anchors
                  : []),
                ...(referenceHighlight ? [referenceHighlight] : []),
              ]}
              activeAnchorId={referenceHighlight?.anchorId ?? (showCommentMarks ? highlightedComment : null)}
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
        <ModelFind
          documentId={detail.resource.id}
          handle={ref}
          revision={sync.revision}
          canEdit={editable}
        />
      )}
      <RegionComments
        onHighlightChange={highlightComment}
        onOpenChange={setShowCommentMarks}
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
