import { fileURLToPath } from "node:url";
import { fail } from "@core/shared/errors.js";
import { renderProcess } from "./render-process.js";

export const PDF_RENDER_MAX_BYTES = 32 * 1024 * 1024;
let active = 0;

/** Export a readonly projection without browser processes or external resources. */
export async function renderDocumentPdf(
  html: string,
  width: number,
  signal?: AbortSignal,
) {
  if (Object.hasOwn(process.env, "DOCA_PDF_CHROMIUM"))
    throw new Error(
      "DOCA_PDF_CHROMIUM is no longer supported; install WeasyPrint and configure DOCA_PDF_PYTHON if needed",
    );
  if (Buffer.byteLength(html) > PDF_RENDER_MAX_BYTES)
    fail(413, "pdf_render_too_large");
  if (!Number.isInteger(width) || width < 400 || width > 2000)
    fail(400, "pdf_invalid_request");
  if (active >= 2) fail(429, "pdf_render_busy");
  signal?.throwIfAborted();
  active++;
  try {
    const result = await renderProcess(
      process.env.DOCA_PDF_PYTHON || "python3",
      [fileURLToPath(new URL("../renderers/document-pdf.py", import.meta.url))],
      JSON.stringify({ html, width }),
      { signal, timeout: 60_000 },
    );
    if (result.subarray(0, 5).toString() !== "%PDF-")
      fail(502, "pdf_render_failed");
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.message === "render_timeout")
      fail(504, "pdf_render_timeout");
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof Error &&
        /No module named .weasyprint|cannot load library/.test(error.message))
    )
      fail(503, "pdf_render_unavailable");
    fail(502, "pdf_render_failed");
  } finally {
    active--;
  }
}
