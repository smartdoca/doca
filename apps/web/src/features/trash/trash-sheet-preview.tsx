import { useEffect, useMemo } from "react";
import {
  SpreadsheetEditor,
  type WorkbookSnapshot,
} from "@online-office/univer-sheet";
import {
  Doc,
  applyUpdate,
  createYjsCollaborationAdapter,
} from "@online-office/univer-sheet/yjs";
import { fromBase64 } from "@web/features/documents/realtime.js";
import { assetUrl } from "@web/shared/api.js";
import "@online-office/univer-sheet/style.css";

export default function TrashSheetPreview({
  id,
  sheet,
}: {
  id: string;
  sheet: { snapshot: WorkbookSnapshot; checkpointId: string; update: string };
}) {
  const preview = useMemo(() => {
    const doc = new Doc();
    applyUpdate(doc, fromBase64(sheet.update));
    return {
      doc,
      adapter: createYjsCollaborationAdapter({
        doc,
        checkpointId: sheet.checkpointId,
      }),
    };
  }, [sheet]);
  useEffect(() => () => preview.doc.destroy(), [preview]);
  return (
    <SpreadsheetEditor
      workbookId={id}
      initialSnapshot={sheet.snapshot}
      collaboration={preview.adapter}
      readOnly
      autoSave={false}
      showHeader={false}
      resourceAdapter={{
        upload: async () => {
          throw Error("回收站预览不支持上传");
        },
        resolve: async (resource) =>
          /^[a-f0-9-]{36}$/.test(resource.id)
            ? assetUrl(resource.id) + "?trashPreview=1"
            : "",
      }}
      style={{ height: "100%", minHeight: 0 }}
    />
  );
}
