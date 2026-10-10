import { useI18n } from "@web/shared/i18n.js";
import { createPortal } from "react-dom";
import { lazy } from "react";
import { LazyContent } from "@web/shared/components/lazy-content.js";
import { Download, X } from "lucide-react";
import type { PreviewSource } from "@web/features/files/open-file-viewer-preview.js";
const OpenFileViewerPreview = lazy(() => import("@web/features/files/open-file-viewer-preview.js").then((module) => ({ default: module.OpenFileViewerPreview })));
import "@web/features/documents/document-file-preview.css";

export type { PreviewSource };

export function isVisualMedia(mime: string, name = "") {
  const type = (mime || guessMime(name)).toLowerCase();
  return type.startsWith("image/") || type.startsWith("video/");
}

export function guessMime(name: string, mime?: string) {
  if (mime) return mime;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    (
      {
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        zip: "application/zip",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime",
        mp3: "audio/mpeg",
      } as Record<string, string>
    )[ext] ?? "application/octet-stream"
  );
}

export function downloadUrl(url: string) {
  return url + (url.includes("?") ? "&" : "?") + "download=1";
}

export function DocumentFilePreview({
  file,
  close,
}: {
  file: PreviewSource;
  close: () => void;
}) {
const { t } = useI18n();

  return createPortal(
    <div
      className="document-file-preview-backdrop"
      role="presentation"
      onClick={close}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <section
        className="document-file-preview"
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong title={file.name}>{file.name}</strong>
          <div>
            <a
              className="icon"
              href={downloadUrl(file.url)}
              download={file.name}
              aria-label={t("doc.download")}
              title={t("doc.download")}
            >
              <Download size={17} />
            </a>
            <button className="icon" onClick={close} aria-label={t("dialog.close")}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="document-file-preview-body">
          <LazyContent><OpenFileViewerPreview file={file} /></LazyContent>
        </div>
      </section>
    </div>,
    document.body,
  );
}
