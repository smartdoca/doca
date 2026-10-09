import { chromium } from "playwright-core";
import { fail } from "@core/shared/errors.js";

export const PDF_RENDER_MAX_BYTES = 32 * 1024 * 1024;
let active = 0;

/** Render a self-contained view. No cookies, host filesystem or network access. */
export async function renderDocumentPdf(html: string, width: number, signal?: AbortSignal) {
  if (Buffer.byteLength(html) > PDF_RENDER_MAX_BYTES) fail(413, "pdf_render_too_large");
  if (active >= 2) fail(429, "pdf_render_busy");
  signal?.throwIfAborted();
  active++;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const abort = () => { void browser?.close(); };
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort(); }, 60_000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.DOCA_PDF_CHROMIUM ? { executablePath: process.env.DOCA_PDF_CHROMIUM } : {}),
      timeout: 20_000,
    });
    signal?.throwIfAborted();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport: { width, height: 1123 } });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.emulateMedia({ media: "screen" });
    // CSP covers data URLs too: SVG/image content cannot run scripts or fetch resources.
    const printStyle = `@page { size: ${width}px ${Math.round(width * Math.SQRT2)}px; margin: 24px 0; } html, body { margin: 0; padding: 0; width: ${width}px; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } tr, figure, img, .sk-image, .sk-diagram-figure { break-inside: avoid; } h1, h2, h3, h4, h5, .sk-block-heading-one, .sk-block-heading-two, .sk-block-heading-three { break-after: avoid; } p { orphans: 3; widows: 3; } thead { display: table-header-group; }`;
    await page.setContent(`<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'"></head><body>${html}<style>${printStyle}</style></body></html>`, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(image => image.decode()));
    });
    const result = await page.pdf({ printBackground: true, preferCSSPageSize: true, tagged: true });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) fail(504, "pdf_render_timeout");
    if (error instanceof Error && /Executable doesn't exist|executable.*not|Failed to launch/i.test(error.message))
      fail(503, "pdf_render_unavailable");
    fail(502, "pdf_render_failed");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    try { await browser?.close(); } finally { active--; }
  }
}
