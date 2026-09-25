import { useI18n } from "@web/shared/i18n.js";
import { useAI } from "@web/features/ai/ai-context.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DocumentDownload, downloadResult } from "@web/features/documents/file-transfer.js";
import { spreadsheetXlsxOptions } from "@web/features/documents/spreadsheet-xlsx.js";
import { useDocumentReadOnly } from "@web/features/documents/document-mode.js";
import {
  SpreadsheetEditor,
  type SpreadsheetEditorHandle,
  type ResourceAdapter,
  type SpreadsheetCellSelection,
  type SpreadsheetMenuExtension,
} from "@online-office/univer-sheet";
import {
  restoreExlsxDocument,
  createExlsxCollaborationSession,
  EXLSX_SCHEMA_VERSION,
  type ExlsxCollaborationSession,
} from "@online-office/univer-sheet/yjs";
import * as Y from "yjs";
import {
  assetUrl,
  uploadFile,
  roleRank,
  type Detail,
  type User,
} from "@web/shared/api.js";
import { realtime } from "@web/features/documents/realtime.js";
import { DocumentFind } from "@web/features/documents/document-find.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useSurfaceSync, type SurfaceFactory } from "@web/features/documents/surface-sync.js";
import { RegionComments, type RegionController } from "@web/features/comments/region-comments.js";
import { activeCommentCandidate } from "@web/features/comments/region-comment-interaction.js";
import { renderSheetObject } from "@web/features/documents/sheet-interactions.js";
import {
  DocumentFilePreview,
  type PreviewSource,
} from "@web/features/documents/document-file-preview.js";
import { SheetNativeMentions } from "@web/features/documents/sheet-native-mentions.js";
import { useSheetDocumentLinks } from "@web/features/documents/sheet-document-links.js";
import { useSheetDocumentPicker } from "@web/features/documents/sheet-document-picker.js";
import "@online-office/univer-sheet/style.css";
import "@web/features/documents/surface.css";
import { AtSign, Eye, EyeOff, MessageSquare } from "lucide-react";
const factory: SurfaceFactory<ExlsxCollaborationSession> = async (
  b,
  sessionId,
) => {
  const doc = await restoreExlsxDocument({
    baseline: b.baseline,
    update: b.update,
    checkpointSeq: 0,
  });
  const value = await createExlsxCollaborationSession({
    doc,
    baseline: b.baseline,
    sessionId,
    readOnly: true,
  });
  return {
    value,
    vector: () => Y.encodeStateVector(doc),
    checkpoint: () => Y.encodeStateAsUpdate(doc),
    apply: (update) =>
      value.applyUpdate({
        codec: "exlsx-cell-registers",
        schemaVersion: b.baseline.schemaVersion,
        epochId: b.epochId,
        update,
      }),
    local: (callback) => value.onLocalTransaction((t) => callback(t.update)),
    dispose: () => {
      value.dispose();
      doc.destroy();
    },
  };
};
export default function SheetDocument({
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
  const { locale } = useI18n();
  const id = detail.resource.id,
    sync = useSurfaceSync(
      id,
      user?.id,
      "exlsx-cell-registers",
      factory,
      changed,
      detail.editorSchemaVersion ?? EXLSX_SCHEMA_VERSION,
    );
  const createComment = useRef<() => void>(() => {});
  const rank = Math.min(roleRank(detail.resource.role), sync.rank);
  const reading = useDocumentReadOnly(sync.binding ? rank >= 3 : undefined);
  const editable = !reading && rank >= 3 && !!sync.binding && !sync.blocked;
  const ref = useRef<SpreadsheetEditorHandle>(null),
    [handle, setHandle] = useState<SpreadsheetEditorHandle | null>(null);
  const [active, setActive] = useState<string | null>(null),
    [candidateIds, setCandidateIds] = useState<string[]>([]),
    [error, setError] = useState("");
  const [showCommentMarks, setShowCommentMarks] = useState(true);
  const [filePreview, setFilePreview] = useState<PreviewSource | null>(null);
  const pasteDocumentLink = useSheetDocumentLinks(handle, editable, setError);
  const documentPicker = useSheetDocumentPicker(id, editable);
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
  const ai = useAI();
  const aiRef = useRef(ai); aiRef.current = ai;
  const session = sync.binding?.value;
  const menus = useMemo<SpreadsheetMenuExtension[]>(
    () => [
      { id: "doca-ai", title: "引用给 AI", ariaLabel: "引用给 AI", path: "ribbon.others.others", order: 998, icon: <AtSign size={18} />, requiresEditPermission: false, enabled: context => !!context.selection && !!aiRef.current?.userId, action: () => aiRef.current?.add() },
      {
        id: "doca-region-comment",
        title: "评论",
        ariaLabel: "评论选中区域",
        path: "ribbon.others.others",
        order: 999,
        icon: <MessageSquare size={18} />,
        tone: "amber",
        requiresEditPermission: false,
        enabled: (context) =>
          !!context.selection && rank >= 2 && sync.connected && !sync.blocked,
        action: () => createComment.current(),
      },
    ],
    [rank, sync.connected, sync.blocked],
  );
  const publish = useCallback(
    (selection: SpreadsheetCellSelection | null) => {
      if (!selection && !document.hasFocus() && editable && sync.connected)
        return;
      if (sync.connected)
        realtime.send({
          type: "cursor",
          id: crypto.randomUUID(),
          room: id,
          epochId: session?.baseline.epochId,
          selection:
            editable && selection ? { ...selection, kind: "cells" } : null,
        });
    },
    [id, session, sync.connected, editable],
  );
  useEffect(() => { if (!editable && session) publish(null); }, [editable, session, publish]);
  const remoteSelections = useMemo(
    () =>
      sync.connected && editable
        ? sync.presence.sessions
            .filter((p) => p.selection?.kind === "cells")
            .map((p) => ({
              sessionId: p.connectionId,
              userId: p.userId,
              name: p.name,
              color: p.color,
              selection: { ...p.selection, type: "cells" as const },
            }))
        : [],
    [sync.presence, sync.connected, editable],
  );
  const controller = useMemo<RegionController | null>(
    () =>
      handle
        ? {
            capture: () => handle.captureCommentAnchor(),
            valid: (a) => handle.resolveCommentAnchorRanges(a).length > 0,
            reveal: (a) => {
              handle.revealCommentAnchor(a);
            },
            label: (a) =>
              a.version === 3
                ? `单元格区域 · ${a.rowIds.length} 条记录`
                : `单元格区域 · 第 ${+a.startRowId.slice(2) + 1}–${+a.endRowId.slice(2) + 1} 行`,
          }
        : null,
    [handle],
  );
  const markers = useMemo(
    () =>
      detail.comments
        .filter((c) => c.anchor && !c.parent_id && !c.resolved && !c.deleted_at)
        .flatMap((c) => {
          try {
            const anchor = JSON.parse(c.anchor!);
            return controller?.valid(anchor)
              ? [
                  {
                    id: c.id,
                    anchor,
                    color: active === c.id ? "#e5a000" : "#f2c94c",
                  },
                ]
              : [];
          } catch {
            return [];
          }
        }),
    [detail.comments, controller, active, sync.revision],
  );
  const resources = useMemo<ResourceAdapter>(
    () => ({
      upload: async (file, resource, context) => {
        const a = await uploadFile(file, "attachment", id, context.signal);
        return {
          id: a.id,
          kind: resource.kind,
          name: a.filename,
          size: a.size,
          mimeType: a.mime,
        };
      },
      resolve: async (r) =>
        /^[a-f0-9-]{36}$/.test(r.id) ? assetUrl(r.id) : "",
      download: async (r) =>
        /^[a-f0-9-]{36}$/.test(r.id) ? assetUrl(r.id) + "?download=1" : "",
    }),
    [id],
  );
  return (
    <section className={`surface-editor sheet-document ${reading ? "is-reading" : ""}`}>
      {documentPicker.picker}
      {filePreview && (
        <DocumentFilePreview file={filePreview} close={() => setFilePreview(null)} />
      )}
      <button
        className="icon canvas-comment-visibility"
        aria-label={showCommentMarks ? "隐藏表格评论标记" : "显示表格评论标记"}
        title={showCommentMarks ? "隐藏表格评论标记" : "显示表格评论标记"}
        aria-pressed={showCommentMarks}
        onClick={() => {
          setShowCommentMarks((v) => !v);
          setActive(null);
          setCandidateIds([]);
        }}
      >
        {showCommentMarks ? <Eye size={18} /> : <EyeOff size={18} />}
      </button>
      {slots.live &&
        createPortal(<span role="status">{sync.status}</span>, slots.live)}
      <DocumentDownload
        disabled={!handle}
        onError={setError}
        options={[
          {
            label: "Excel（.xlsx）",
            run: async () => {
              if (handle)
                downloadResult({
                  ...(await handle.exportXlsx(spreadsheetXlsxOptions())),
                  filename: `${detail.resource.title}.xlsx`,
                });
            },
          },
        ]}
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
      {handle && (
        <SheetNativeMentions
          handle={handle}
          enabled={editable}
          onError={setError}
        />
      )}
      {handle && (
        <DocumentFind
          openNative={async () => {
            const api = handle.getRuntime()?.univerAPI;
            if (
              !api ||
              (await api.executeCommand("ui.operation.open-find-dialog")) ===
                false
            )
              throw Error("无法打开表格查找");
          }}
          openReplace={
            editable
              ? async () => {
                  const api = handle.getRuntime()?.univerAPI;
                  if (
                    !api ||
                    (await api.executeCommand(
                      "ui.operation.open-replace-dialog",
                    )) === false
                  )
                    throw Error("无法打开表格替换");
                }
              : undefined
          }
        />
      )}
      {session ? (
        <SpreadsheetEditor
          locale={locale}
          toolbarLayout="two-row"
          menus={menus}
          renderCellObject={(object) => renderSheetObject(object, setFilePreview)}
          onPasteContent={pasteDocumentLink}
          ref={ref}
          workbookId={id}
          collaboration={session}
          onReady={setHandle}
          readOnly={!editable}
          autoSave={false}
          autoFitContent={false}
          showHeader={false}
          showInsertToolbar={false}
          showSaveState={false}
          currentSessionId={sync.presence.self}
          remoteSelections={remoteSelections}
          onSelectionChange={publish}
          resourceAdapter={resources}
          inlineActions={documentPicker.actions}
          commentMarkers={showCommentMarks ? markers : []}
          activeCommentId={showCommentMarks ? active : null}
          onCommentAnchorsClick={({ candidateIds: ids }) => {
            setCandidateIds(ids);
            setActive(current => activeCommentCandidate(current, ids));
          }}
          onError={(e) => setError(e.message)}
          style={{ flex: 1, height: "100%", minHeight: 0 }}
        />
      ) : (
        <p className="empty">正在加载表格…</p>
      )}
      <RegionComments
        candidateIds={candidateIds}
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
