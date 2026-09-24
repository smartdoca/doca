import { useEffect, useState } from "react";
import * as Y from "yjs";
import { PresentationWorkspace } from "@eppt/editor";
import "@eppt/editor/styles.css";
import { CanvasEditor } from "aidcanvas";
import { CanvasModel } from "aidcanvas/model";
import { SpreadsheetEditor } from "@online-office/univer-sheet";
import {
  restoreExlsxDocument,
  createExlsxCollaborationSession,
  type ExlsxCollaborationSession,
} from "@online-office/univer-sheet/yjs";
import { fromBase64 } from "@web/features/documents/realtime.js";
import { assetUrl } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import "aidcanvas/style.css";
import "@online-office/univer-sheet/style.css";
import "@web/features/documents/surface.css";
export type SurfacePreviewData = {
  format: string;
  epochId: string;
  baseline?: any;
  update: string;
};
export default function SurfacePreview({
  id,
  surface,
  trash = false,
  audit = false,
}: {
  id: string;
  surface: SurfacePreviewData;
  trash?: boolean;
  audit?: boolean;
}) {
  const [model, setModel] = useState<
      CanvasModel | ExlsxCollaborationSession | Y.Doc | null
    >(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false,
      cleanup = () => {};
    void (async () => {
      const update = fromBase64(surface.update);
      if (surface.format === "presentation") {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, update);
        cleanup = () => doc.destroy();
        if (!disposed) setModel(doc);
      } else if (surface.format === "canvas") {
        const m = CanvasModel.restore({
          codec: "aidcanvas-yjs",
          schemaVersion: 1,
          epochId: surface.epochId,
          update,
        });
        m.setReadOnly(true);
        cleanup = () => m.dispose();
        if (!disposed) setModel(m);
      } else {
        const doc = await restoreExlsxDocument({
          baseline: surface.baseline,
          update,
          checkpointSeq: 0,
        });
        const session = await createExlsxCollaborationSession({
          doc,
          baseline: surface.baseline,
          sessionId: crypto.randomUUID(),
          readOnly: true,
        });
        cleanup = () => {
          session.dispose();
          doc.destroy();
        };
        if (!disposed) setModel(session);
      }
      if (disposed) cleanup();
    })().catch((e) => {
      if (!disposed) setError(e.message);
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [surface]);
  const resolve = (id: string) =>
    /^[a-f0-9-]{36}$/.test(id)
      ? assetUrl(id) + (audit ? "?audit=1" : trash ? "?trashPreview=1" : "")
      : "";
  return (
    <div className="surface-editor" style={{ height: "65vh" }}>
      <Feedback message={error} tone="error" />
      {model instanceof Y.Doc ? (
        <PresentationWorkspace
          document={model}
          readOnly
          chrome="embedded"
          resources={{
            resolveUrl: resolve,
            uploadImage: async () => {
              throw Error("只读预览不能上传");
            },
          }}
        />
      ) : model instanceof CanvasModel ? (
        <CanvasEditor
          model={model}
          hostManaged
          mode="readonly"
          showHeader={false}
          className="doca-canvas"
          resources={{ resolveUrl: resolve }}
        />
      ) : model ? (
        <SpreadsheetEditor
          workbookId={id}
          collaboration={model}
          readOnly
          showHeader={false}
          showSaveState={false}
          autoSave={false}
          resourceAdapter={{
            upload: async () => {
              throw Error("只读预览不能上传");
            },
            resolve: async (r) => resolve(r.id),
          }}
          style={{ height: "100%", minHeight: 0 }}
        />
      ) : (
        <p>正在加载预览…</p>
      )}
    </div>
  );
}
