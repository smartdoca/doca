import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  Download,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useI18n } from "@web/shared/i18n.js";
import { downloadUrl, type PreviewSource } from "./document-file-preview.js";
import "./document-image-preview.css";

const clamp = (value: number) => Math.max(0.2, Math.min(5, value));

/** Canvas images use the same lightbox presentation as the rich-text editor. */
export function DocumentImagePreview({
  file,
  close,
}: {
  file: PreviewSource;
  close(): void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1),
    [error, setError] = useState("");
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<
    { x: number; y: number; left: number; top: number } | undefined
  >(undefined);
  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus({ preventScroll: true });
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setScale((value) => clamp(value + (event.deltaY < 0 ? 0.12 : -0.12)));
    };
    const element = viewport.current;
    element?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element?.removeEventListener("wheel", wheel);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  const copy = () => {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      setError(t("doc.imageCopyFailed"));
      return;
    }
    setError("");
    // Download authorization is checked again for clipboard bytes.
    const png = fetch(downloadUrl(file.url)).then(async (response) => {
      if (!response.ok) throw new Error("IMAGE_COPY_DENIED");
      const blob = await response.blob();
      if (blob.type === "image/png") return blob;
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("IMAGE_COPY_FAILED");
        context.drawImage(bitmap, 0, 0);
        return await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (result) =>
              result ? resolve(result) : reject(new Error("IMAGE_COPY_FAILED")),
            "image/png",
          ),
        );
      } finally {
        bitmap.close();
      }
    });
    void navigator.clipboard
      .write([new ClipboardItem({ "image/png": png })])
      .catch(() => setError(t("doc.imageCopyFailed")));
  };
  return createPortal(
    <div
      ref={root}
      className="document-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      tabIndex={-1}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (["Escape", "+", "=", "-", "0"].includes(event.key))
          event.preventDefault();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
        if (event.key === "+" || event.key === "=")
          setScale((value) => clamp(value + 0.2));
        if (event.key === "-") setScale((value) => clamp(value - 0.2));
        if (event.key === "0") reset();
        if (event.key === "Tab") {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("button,a[href]"),
          );
          const index = controls.indexOf(document.activeElement as HTMLElement);
          event.preventDefault();
          controls[
            (index + (event.shiftKey ? -1 : 1) + controls.length) %
              controls.length
          ]?.focus();
        }
      }}
    >
      <div
        className="document-image-preview-toolbar"
        role="toolbar"
        aria-label={t("doc.imagePreview")}
      >
        <button
          aria-label={t("books.zoomOut")}
          title={t("books.zoomOut")}
          onClick={() => setScale((value) => clamp(value - 0.2))}
        >
          <Minus size={18} />
        </button>
        <button
          className="document-image-preview-scale"
          aria-label={t("doc.imageReset")}
          onClick={reset}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          aria-label={t("books.zoomIn")}
          title={t("books.zoomIn")}
          onClick={() => setScale((value) => clamp(value + 0.2))}
        >
          <Plus size={18} />
        </button>
        <button
          aria-label={t("doc.imageFit")}
          title={t("doc.imageFit")}
          onClick={reset}
        >
          <Maximize2 size={18} />
        </button>
        <button
          aria-label={t("doc.imageReset")}
          title={t("doc.imageReset")}
          onClick={reset}
        >
          <RotateCcw size={17} />
        </button>
        <button
          aria-label={t("doc.imageCopy")}
          title={t("doc.imageCopy")}
          onClick={copy}
        >
          <Copy size={18} />
        </button>
        <a
          href={downloadUrl(file.url)}
          download={file.name}
          aria-label={t("doc.download")}
          title={t("doc.download")}
        >
          <Download size={18} />
        </a>
        <button
          aria-label={t("dialog.close")}
          title={t("dialog.close")}
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      <div
        ref={viewport}
        className="document-image-preview-viewport"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <img
          src={file.url}
          alt={file.name}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
          onLoad={() => setError("")}
          onError={() => setError(t("doc.imageLoadFailed"))}
          onDoubleClick={reset}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: offset.x,
              top: offset.y,
            };
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (current)
              setOffset({
                x: current.left + event.clientX - current.x,
                y: current.top + event.clientY - current.y,
              });
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onPointerCancel={() => {
            drag.current = undefined;
          }}
        />
      </div>
      {error && (
        <div className="document-image-preview-error" role="alert">
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}
