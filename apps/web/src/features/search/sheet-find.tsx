import { useMemo } from "react";
import type {
  SpreadsheetCellRange,
  SpreadsheetEditorHandle,
} from "@smartdoca/sheet";
import { useI18n } from "@web/shared/i18n.js";
import { ModelFind, type FindHandle } from "./model-find.js";

export function SheetFind({
  documentId,
  handle,
  revision,
  canEdit,
}: {
  documentId: string;
  handle: SpreadsheetEditorHandle;
  revision: number;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const find = useMemo<{ current: FindHandle<SpreadsheetCellRange> }>(
    () => ({
      current: {
        find: async (query) => {
          const finder = await handle.createTextFinder(query, {
            matchCase: false,
            matchEntireCell: false,
            matchFormulaText: false,
          });
          if (!finder) throw Error(t("doc.findUnavailable"));
          try {
            return finder.findAll();
          } finally {
            finder.dispose();
          }
        },
        reveal: (match) => handle.revealRange(match, { select: false }),
        // Replacement remains in the native sheet dialog, never the navigation panel.
        replace: () => {
          throw Error(t("doc.findNativeReplace"));
        },
        replaceAll: () => {
          throw Error(t("doc.findNativeReplace"));
        },
      },
    }),
    [handle, t],
  );
  const open = async (command: string) => {
    const api = handle.getRuntime()?.univerAPI;
    if (!api || (await api.executeCommand(command)) === false)
      throw Error(t("doc.findUnavailable"));
  };
  return (
    <ModelFind
      documentId={documentId}
      handle={find}
      revision={revision}
      canEdit={false}
      openNative={() => open("ui.operation.open-find-dialog")}
      openReplace={() =>
        open(
          canEdit
            ? "ui.operation.open-replace-dialog"
            : "ui.operation.open-find-dialog",
        )
      }
    />
  );
}
