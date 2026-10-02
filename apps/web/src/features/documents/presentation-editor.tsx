import { useI18n } from "@web/shared/i18n.js";
import { AIReferenceButton } from "@web/features/ai/ai-context.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { MessageSquare } from "lucide-react";
import { useDocumentReadOnly } from "@web/features/documents/document-mode.js";
import {
  PresentationWorkspace,
  type PresentationWorkspaceHandle,
  type PresentationResources,
} from "@smartdoca/slides";
import {
  isLocalContentOrigin,
  REMOTE_ORIGIN,
  readDocument,
  resolveAnchor,
  findText,
  replaceMatches,
  type CommentAnchor,
  type CommentMarker,
  type TextMatch,
} from "@smartdoca/slides/core";
import {
  assetUrl,
  uploadFile,
  roleRank,
  type Detail,
  type User,
} from "@web/shared/api.js";
import { realtime } from "@web/features/documents/realtime.js";
import { useSurfaceSync, type SurfaceFactory } from "@web/features/documents/surface-sync.js";
import { RegionComments, type RegionController } from "@web/features/comments/region-comments.js";
import {
  DocumentDownload,
  downloadResult,
  readAsset,
} from "@web/features/documents/file-transfer.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { ModelFind, type FindHandle } from "@web/features/search/model-find.js";
import { EditorRecoveryBoundary } from "@web/features/documents/editor-recovery-boundary.js";
import "@smartdoca/slides/styles.css";
import "@web/features/documents/surface.css";

type Replica = { doc: Y.Doc; epochId: string };
const factory: SurfaceFactory<Replica> = async (b) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, b.update, REMOTE_ORIGIN);
  return {
    value: { doc, epochId: b.epochId },
    vector: () => Y.encodeStateVector(doc),
    checkpoint: () => Y.encodeStateAsUpdate(doc),
    apply: (update) => Y.applyUpdate(doc, update, REMOTE_ORIGIN),
    local: (callback) => {
      const listener = (bytes: Uint8Array, origin: unknown) => {
        if (isLocalContentOrigin(origin) || origin instanceof Y.UndoManager)
          callback(bytes);
      };
      doc.on("update", listener);
      return () => doc.off("update", listener);
    },
    dispose: () => doc.destroy(),
  };
};
export default function PresentationDocument({
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
  const id = detail.resource.id;
  const sync = useSurfaceSync(id, user?.id, "eppt-yjs-v5", factory, changed, 2);
  const model = sync.binding?.value;
  const rank = Math.min(roleRank(detail.resource.role), sync.rank);
  const [presenting, setPresenting] = useState(false),
    [failed, setFailed] = useState(false),
    [annotationsVisible, setAnnotationsVisible] = useState(true);
  const root = useRef<HTMLElement>(null);
  const reading = useDocumentReadOnly(model ? rank >= 3 : undefined);
  const editable =
    !reading && rank >= 3 && !!model && !sync.blocked && !presenting && !failed;
  const ref = useRef<PresentationWorkspaceHandle | null>(null);
  const [ready, setReady] = useState(false);
  // The SDK renews its imperative handle on every render. Keep a stable host
  // facade and read the latest ref; reflecting each handle into state loops.
  const onReady = useCallback((h: PresentationWorkspaceHandle | null) => {
    ref.current = h;
    if (h) setReady(true);
  }, []);
  useEffect(() => {
    const section = root.current;
    if (!section || !ready) return;
    const toolbar = section.querySelector<HTMLElement>(".eppt-toolbar");
    const footer = section.querySelector<HTMLElement>(".eppt-status");
    const measure = () => {
      section.style.setProperty(
        "--ppt-toolbar-height",
        `${toolbar?.offsetHeight ?? 72}px`,
      );
      section.style.setProperty(
        "--ppt-status-height",
        `${footer?.offsetHeight ?? 24}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    if (toolbar) observer.observe(toolbar);
    if (footer) observer.observe(footer);
    measure();
    return () => observer.disconnect();
  }, [ready, presenting]);
  useEffect(() => {
    if (targetComment) setAnnotationsVisible(true);
  }, [targetComment]);
  const handle = useMemo(
    () =>
      ready
        ? {
            captureAnchor: () => ref.current?.captureAnchor() ?? null,
            revealAnchor: (anchor: CommentAnchor) =>
              ref.current?.revealAnchor(anchor) ?? false,
            commitTextEdit: () => ref.current?.commitTextEdit(),
          }
        : null,
    [ready],
  );
  const [active, setActive] = useState<string | null>(null),
    [candidates, setCandidates] = useState<string[]>([]),
    [error, setError] = useState("");
  const createComment = useRef<() => void>(() => {}),
    pendingAnchor = useRef<CommentAnchor | null>(null);
  const changePresentation = useCallback(
    (value: boolean) => {
      const workspace = root.current?.closest<HTMLElement>(".workspace");
      if (!value) {
        setPresenting(false);
        if (workspace && document.fullscreenElement === workspace)
          void document.exitFullscreen().catch(() => undefined);
        return;
      }
      if (!workspace?.requestFullscreen) {
        setError(t("doc.fullscreenUnsupported"));
        setPresenting(false);
        return;
      }
      if (document.fullscreenElement === workspace) {
        setError("");
        setPresenting(true);
        return;
      }
      setError("");
      void workspace
        .requestFullscreen()
        .then(() => setPresenting(true))
        .catch(() => {
          setPresenting(false);
          setError(t("doc.fullscreenUnsupported"));
        });
    },
    [t],
  );
  useEffect(() => {
    const show = (event: Event) => {
      if ((event as CustomEvent).detail === id) changePresentation(true);
    };
    window.addEventListener("doca:presentation", show);
    return () => window.removeEventListener("doca:presentation", show);
  }, [id, changePresentation]);
  useEffect(() => {
    const sync = () => {
      const workspace = root.current?.closest<HTMLElement>(".workspace");
      if (document.fullscreenElement !== workspace) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const publish = useCallback(
    (slideId: string, elementIds: string[]) => {
      if (sync.connected)
        realtime.send({
          type: "cursor",
          room: id,
          id: crypto.randomUUID(),
          epochId: model?.epochId,
          selection:
            editable && elementIds.length
              ? { kind: "elements", slideId, elementIds }
              : null,
        });
    },
    [id, sync.connected, editable, model],
  );
  useEffect(() => { if (!editable && model) publish("", []); }, [editable, model, publish]);
  const members = useMemo(
    () =>
      sync.connected && editable
        ? sync.presence.sessions
            .filter((p) => p.selection?.slideId)
            .map((p) => ({
              sessionId: p.connectionId,
              userId: p.userId,
              name: p.name,
              color: p.color,
              slideId: p.selection.slideId,
              selection: { elementIds: p.selection.elementIds, editing: false },
            }))
        : [],
    [sync.connected, editable, sync.presence],
  );
  const controller = useMemo<RegionController | null>(
    () =>
      handle && model
        ? {
            flush: () => handle.commitTextEdit(),
            capture: () => {
              const a = pendingAnchor.current ?? handle.captureAnchor();
              pendingAnchor.current = null;
              return a ? { ...a, epochId: model.epochId } : null;
            },
            valid: (a) =>
              a.epochId === model.epochId && !!resolveAnchor(model.doc, a),
            reveal: (a) => {
              handle.revealAnchor(a);
            },
            label: (a) =>
              `第 ${readDocument(model.doc).slideOrder.indexOf(a.slideId) + 1} 页 · 选中元素`,
          }
        : null,
    [handle, model],
  );
  const markers = useMemo<CommentMarker[]>(
    () =>
      detail.comments.flatMap((c) => {
        if (!c.anchor || c.parent_id || c.resolved || c.deleted_at) return [];
        try {
          const anchor = JSON.parse(c.anchor);
          return controller?.valid(anchor) ? [{ id: c.id, anchor }] : [];
        } catch {
          return [];
        }
      }),
    [detail.comments, controller, sync.revision],
  );
  const resources = useMemo<PresentationResources>(
    () => ({
      resolveUrl: (key) => (/^[a-f0-9-]{36}$/i.test(key) ? assetUrl(key) : ""),
      uploadImage: async (file, context) => {
        if (!file.type.startsWith("image/")) throw Error("请选择图片文件");
        // The server validates size, MIME and decoded image pixels before accepting assets.
        const asset = await uploadFile(file, "attachment", id, context.signal);
        const image = await createImageBitmap(
          await readAsset(asset.id, context.signal),
        );
        try {
          return { id: asset.id, width: image.width, height: image.height };
        } finally {
          image.close();
        }
      },
    }),
    [id],
  );
  const find = useRef<FindHandle<TextMatch> | null>(null);
  find.current =
    model && handle
      ? {
          find: (q) => findText(model.doc, q),
          reveal: (m) => handle.revealAnchor(m.anchor),
          replace: (m, text) => {
            if (editable) replaceMatches(model.doc, [m], text);
          },
          replaceAll: (q, text) => {
            if (editable)
              replaceMatches(model.doc, findText(model.doc, q), text);
          },
        }
      : null;
  return (
    <section
      ref={root}
      className={`surface-editor presentation-document ${reading ? "is-reading" : ""} ${presenting ? "is-presenting" : ""}`}
    >
      <Feedback message={sync.error || error} tone="error" />
      {model && (!sync.connected || sync.blocked) && (
        <button
          className="surface-recovery"
          onClick={() =>
            void sync.exportRecovery().catch((e) => setError(e.message))
          }
        >
          导出本地恢复文件
        </button>
      )}
      <DocumentDownload
        disabled={!model || !handle}
        onError={setError}
        options={[
          {
            label: "PowerPoint（.pptx）",
            run: async () => {
              if (!model) return;
              if (editable) handle?.commitTextEdit();
              const snapshot = {
                ...readDocument(model.doc),
                title: detail.resource.title,
              };
              const { exportPptx } = await import("@smartdoca/slides/pptx");
              downloadResult(
                await exportPptx(snapshot, async (key) => {
                  const blob = await readAsset(key);
                  return new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(Error("图片读取失败"));
                    reader.readAsDataURL(blob);
                  });
                }),
              );
            },
          },
        ]}
      />
      {model ? (
        <EditorRecoveryBoundary
          onFailure={() => setFailed(true)}
          readText={() => readDocument(model.doc).title}
          backup={() =>
            void sync.exportRecovery().catch((e) => setError(e.message))
          }
          render={() => (
            <PresentationWorkspace
              locale={locale}
              ref={onReady}
              document={model.doc}
              chrome="embedded"
              readOnly={!editable}
              resources={resources}
              presentation={presenting}
              onPresentationChange={changePresentation}
              sessionId={sync.presence.self}
              members={members}
              onPresence={publish}
              status={sync.status}
              commentMarkers={presenting || !annotationsVisible ? [] : markers}
              onCommentAnchorClick={(items) => {
                setCandidates(items.map((c) => c.id));
                setActive(items[0]?.id ?? null);
              }}
              renderCommentAction={(anchor) =>
                rank >= 1 && !presenting ? (
                  <span className="ppt-comment-action-group">
                    <AIReferenceButton anchor={{...anchor, epochId: model?.epochId}} />
                    <button
                      className="ppt-comment-action"
                      title={t("editor.commentSelection")}
                      aria-label={t("editor.commentSelection")}
                      disabled={rank < 2 || !sync.connected || sync.blocked}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        pendingAnchor.current = anchor;
                        createComment.current();
                      }}
                    >
                      <MessageSquare size={20} />
                    </button>
                  </span>
                ) : null
              }
            />
          )}
        />
      ) : (
        <p className="empty">正在加载演示文稿…</p>
      )}
      {handle && !presenting && (
        <ModelFind documentId={detail.resource.id} handle={find} revision={sync.revision} canEdit={editable} />
      )}
      {!presenting && (
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
          candidateIds={candidates}
          targetComment={targetComment}
          loadMoreComments={loadMoreComments}
          annotationVisibility={{
            visible: annotationsVisible,
            change: setAnnotationsVisible,
          }}
        />
      )}
    </section>
  );
}
