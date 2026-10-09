import { useCallback, useState } from "react";
import type { RichTextEditorProps } from "@smartdoca/slate";
import type { SpreadsheetAttachmentPreviewHandler } from "@smartdoca/sheet";
import { assetUrl } from "@web/shared/api.js";
import {
  DocumentFilePreview,
  guessMime,
  type PreviewSource,
} from "./document-file-preview.js";

export function useAttachmentPreview({
  trash = false,
  audit = false,
}: { trash?: boolean; audit?: boolean } = {}) {
  const [file, previewFile] = useState<PreviewSource | null>(null);
  const open = useCallback(
    (id: string | undefined, name: string, mime?: string) => {
      if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return;
      previewFile({
        url:
          assetUrl(id) + (audit ? "?audit=1" : trash ? "?trashPreview=1" : ""),
        name,
        mime: guessMime(name, mime),
      });
    },
    [audit, trash],
  );
  const onRichAttachmentPreview = useCallback<
    NonNullable<RichTextEditorProps["onAttachmentPreview"]>
  >(
    (attachment) => open(attachment.path, attachment.name, attachment.mimeType),
    [open],
  );
  const onSheetAttachmentPreview =
    useCallback<SpreadsheetAttachmentPreviewHandler>(
      ({ node }) => open(node.refId, node.label),
      [open],
    );
  return {
    previewFile,
    onRichAttachmentPreview,
    onSheetAttachmentPreview,
    dialog: file ? (
      <DocumentFilePreview file={file} close={() => previewFile(null)} />
    ) : null,
  };
}
