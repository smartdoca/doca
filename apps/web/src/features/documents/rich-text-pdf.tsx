import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { RichTextEditor, type RichTextEditorProps, type EditorValue } from "@smartdoca/slate";

type Options = Pick<RichTextEditorProps, "resources" | "plugins" | "locale" | "formulaRenderer">;
type Projection = { value: EditorValue; mount: HTMLDivElement; ready: () => void };

/** A portal retains host locale, plugin and document contexts without another collaboration session. */
export function useRichTextPdfProjection(options: Options) {
  const [projection, setProjection] = useState<Projection | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function exportPdf(value: EditorValue, resourceId: string, filename: string, width: number, shell?: HTMLElement | null) {
    if (controller.current) throw Error("pdf_render_busy");
    const abort = new AbortController();
    controller.current = abort;
    const mount = document.createElement("div");
    mount.className = shell?.className ?? "document-editor-shell";
    if (shell?.dataset.pageWidth) mount.dataset.pageWidth = shell.dataset.pageWidth;
    mount.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;pointer-events:none`;
    mount.setAttribute("aria-hidden", "true");
    document.body.append(mount);
    let rejectReady: (reason: unknown) => void = () => {};
    const reject = () => rejectReady(abort.signal.reason);
    abort.signal.addEventListener("abort", reject, { once: true });
    const timeout = setTimeout(() => abort.abort(Error("pdf_render_timeout")), 30_000);
    try {
      await new Promise<void>((resolve, reject) => {
        rejectReady = reject;
        setProjection({ value: structuredClone(value), mount, ready: resolve });
      });
      clearTimeout(timeout);
      const page = mount.querySelector<HTMLElement>(".sk-page");
      if (!page) throw Error("pdf_preview_not_ready");
      const { exportRenderedPdf } = await import("./rendered-pdf.js");
      return await exportRenderedPdf(page, resourceId, filename, abort.signal, options.locale);
    } catch (error) {
      const { localizedPdfError } = await import("./rendered-pdf.js");
      throw localizedPdfError(error, options.locale ?? "zh");
    } finally {
      clearTimeout(timeout);
      abort.signal.removeEventListener("abort", reject);
      controller.current = null;
      setProjection(null);
      mount.remove();
    }
  }
  const view = projection ? createPortal(
    <div className="editor-content"><RichTextEditor mode="readonly" initialValue={projection.value} resources={options.resources} plugins={options.plugins} locale={options.locale} formulaRenderer={options.formulaRenderer} onReady={projection.ready} /></div>,
    projection.mount,
  ) : null;
  return { exportPdf, view };
}
