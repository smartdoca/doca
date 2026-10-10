import { translate, type MessageKey } from "@doca/i18n";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MarkdownPreview } from "@smartdoca/markdown";
import { platformAssetId } from "@web/shared/utils/asset-path.js";
import { assetUrl } from "@web/shared/api.js";
import { embeddedImage, readAsset } from "./file-transfer.js";
import { loadPdfFontBytes } from "./pdf-font.js";

// Capture the rendered view, including native tables, columns, math and diagrams.
// Computed styles remove the dependency on the host CSS/build in the renderer.
const properties = ("display visibility position float clear box-sizing width min-width max-width height min-height max-height margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left border-top border-right border-bottom border-left border-radius border-collapse border-spacing background-color color font-family font-size font-weight font-style font-feature-settings line-height letter-spacing text-align text-decoration text-indent text-transform white-space word-break overflow-wrap vertical-align opacity flex flex-direction flex-wrap align-items align-self justify-content gap grid-template-columns grid-column grid-row top right bottom left transform transform-origin list-style-type object-fit object-position fill stroke stroke-width").split(" ");
const chrome = "textarea, select, .katex-mathml, .sk-block-gutter, .sk-column-header, .sk-column-resizer, .sk-column-actions, .sk-table-resizers, .sk-table-selection, .sk-image-resizer, .sk-code-slate-value, .sk-code-actions, [data-slate-zero-width]";

function styleFrom(element: Element, pseudo?: string) {
  const style = getComputedStyle(element, pseudo);
  return properties.map(property => `${property}:${style.getPropertyValue(property)}`).join(";");
}

function pseudoContent(element: Element, pseudo: string) {
  const style = getComputedStyle(element, pseudo);
  let content = style.content;
  if (["none", "normal", '""'].includes(content) || style.display === "none") return null;
  const attr = /^attr\(([^)]+)\)$/.exec(content);
  if (attr) content = element.getAttribute(attr[1]!) ?? "";
  else if (/^".*"$/.test(content)) content = JSON.parse(content);
  else return null;
  const span = document.createElement("span");
  span.style.cssText = styleFrom(element, pseudo);
  span.textContent = content;
  return span;
}

async function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Error("pdf_media_read_failed"));
    reader.readAsDataURL(blob);
  });
}

async function imageBytes(source: string, signal?: AbortSignal) {
  const embedded = embeddedImage(source);
  if (embedded) return dataUrl(embedded);
  const svg = /^data:image\/svg\+xml(?:;charset=[a-z0-9-]+)?,(.*)$/i.exec(source);
  if (svg) return dataUrl(new Blob([decodeURIComponent(svg[1]!)], { type: "image/svg+xml" }));
  const url = new URL(source, location.origin);
  const id = url.origin === location.origin ? platformAssetId(url.pathname) : null;
  if (!id) throw Error("pdf_asset_invalid");
  return dataUrl(await readAsset(id, signal));
}

async function embeddedFonts(signal?: AbortSignal) {
  const rules: CSSFontFaceRule[] = [];
  const collect = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSFontFaceRule) rules.push(rule);
      else if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) { try { collect(sheet.cssRules); } catch { /* Cross-origin fonts are not fetched. */ } }
  return (await Promise.all(rules.map(async rule => {
    const source = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue("src"))?.[1];
    if (!source) return "";
    const url = new URL(source, location.href);
    if (url.origin !== location.origin) return "";
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error("pdf_font_read_failed");
    const font = await dataUrl(await response.blob());
    return `@font-face{font-family:${rule.style.fontFamily};font-style:${rule.style.fontStyle || "normal"};font-weight:${rule.style.fontWeight || "normal"};src:url("${font}")}`;
  }))).join("\n");
}

export async function capturePdfView(source: HTMLElement, signal?: AbortSignal, locale = "zh") {
  signal?.throwIfAborted();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const deadline = Date.now() + 20_000;
  while (source.querySelector('[aria-busy="true"], .sk-diagram-loading') || Array.from(source.querySelectorAll(".mermaid-diagram")).some(diagram => !diagram.querySelector("svg"))) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw Error("pdf_render_timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await document.fonts.ready;
  await Promise.all(Array.from(source.querySelectorAll("img")).filter(image => image.getAttribute("src")).map(async image => {
    image.loading = "eager";
    try { await image.decode(); } catch { throw Error("pdf_media_read_failed"); }
  }));
  const clone = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...Array.from(source.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const images: Promise<void>[] = [];
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!, copy = copies[index]!;
    if (original instanceof HTMLElement || original instanceof SVGElement) copy.setAttribute("style", styleFrom(original));
    for (const attribute of Array.from(copy.attributes)) {
      if (/^on/i.test(attribute.name) || ["contenteditable", "autofocus"].includes(attribute.name)) copy.removeAttribute(attribute.name);
    }
    if (original instanceof HTMLImageElement) images.push(imageBytes(original.currentSrc || original.src, signal).then(url => { copy.setAttribute("src", url); copy.removeAttribute("srcset"); }));
    if (original instanceof HTMLCanvasElement) {
      const image = document.createElement("img");
      image.src = original.toDataURL("image/png");
      image.style.cssText = copy.getAttribute("style") ?? "";
      copy.replaceWith(image);
    }
    if (original instanceof HTMLInputElement || original.matches(".sk-todo > button")) {
      const label = document.createElement("span");
      label.textContent = original instanceof HTMLInputElement ? (original.type === "checkbox" ? (original.checked ? "☑" : "☐") : original.value) : (original.classList.contains("is-checked") ? "☑" : "☐");
      label.style.cssText = copy.getAttribute("style") ?? "";
      copy.replaceWith(label);
    }
    const before = original.classList.contains("sk-block-placeholder") ? null : pseudoContent(original, "::before"), after = pseudoContent(original, "::after");
    if (before) copy.prepend(before);
    if (after) copy.append(after);
    // Do not clip scrolling tables/code blocks or fix paragraph heights across pages.
    if (copy instanceof HTMLElement) {
      copy.style.overflow = "visible";
      copy.style.maxHeight = "none";
      if (original.matches("p, h1, h2, h3, h4, h5, pre, table, .sk-block-frame, .sk-editable, .sk-table-block, .sk-table-scroll, .sk-table-canvas")) copy.style.height = "auto";
    }
  }
  clone.querySelectorAll(`${chrome}, script, style, iframe, object, embed`).forEach(element => element.remove());
  // Keep readable attachment/mention labels even when the online view uses a button.
  for (const button of Array.from(clone.querySelectorAll("button"))) {
    const label = document.createElement("span");
    label.style.cssText = button.style.cssText;
    label.append(...Array.from(button.childNodes));
    button.replaceWith(label);
  }
  for (const media of Array.from(clone.querySelectorAll("video, audio"))) {
    const label = document.createElement("p");
    label.textContent = translate(locale === "zh" ? "zh" : "en", media.tagName === "VIDEO" ? "pdf.videoPlaceholder" : "pdf.audioPlaceholder");
    const mediaPath = media.getAttribute("src") || media.querySelector("source")?.getAttribute("src");
    const asset = mediaPath ? platformAssetId(new URL(mediaPath, location.origin).pathname) : null;
    if (asset) {
      const link = document.createElement("a");
      link.href = new URL(assetUrl(asset) + "?download=1", location.origin).href;
      link.textContent = label.textContent;
      label.replaceChildren(link);
    }
    media.replaceWith(label);
  }
  for (const code of Array.from(clone.querySelectorAll<HTMLElement>(".sk-code-highlight"))) Object.assign(code.style, { position: "static", transform: "none", height: "auto", whiteSpace: "pre-wrap" });
  for (const body of Array.from(clone.querySelectorAll<HTMLElement>(".sk-code-body"))) body.style.height = "auto";
  for (const link of Array.from(clone.querySelectorAll("a"))) {
    if (!/^(https?:|mailto:|#|\/)/i.test(link.getAttribute("href") ?? "")) link.removeAttribute("href");
  }
  // The root is a page body, not the live editor's flex/scroll viewport.
  const width = Math.max(400, Math.min(2000, Math.ceil(source.getBoundingClientRect().width)));
  Object.assign(clone.style, { position: "static", display: "block", width: `${width}px`, height: "auto", minHeight: "0", maxHeight: "none", margin: "0", boxShadow: "none" });
  await Promise.all(images);
  const cjk = await loadPdfFontBytes(source.textContent ?? "").catch(() => { throw Error("pdf_font_read_failed"); });
  let fonts = await embeddedFonts(signal);
  if (cjk) {
    const font = await dataUrl(new Blob([new Uint8Array(cjk)], { type: "font/woff2" }));
    fonts += `@font-face{font-family:DocaPDFCJK;src:url("${font}") format("woff2")}`;
    for (const element of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("[style]"))]) {
      if (element.style?.fontFamily) element.style.fontFamily += ", DocaPDFCJK";
    }
  }
  signal?.throwIfAborted();
  return { html: `<style>${fonts}</style>${clone.outerHTML}`, width };
}

export async function exportRenderedPdf(source: HTMLElement, resourceId: string, filename: string, signal?: AbortSignal, locale = "zh") {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  try {
    return await withAbort((async () => {
      const view = await capturePdfView(source, bounded, locale);
      const response = await fetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/pdf`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(view), signal: bounded,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw Error(error?.message || error?.error || "pdf_render_failed");
      }
      return { blob: await response.blob(), filename: `${filename}.pdf` };
    })(), bounded);
  } catch (error) { throw localizedPdfError(bounded.aborted && !signal?.aborted ? Error("pdf_render_timeout") : error, locale); }
}

function withAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Mount only the package's preview; it has no editor, Y.Doc or save transport. */
export async function exportMarkdownPdf(markdown: string, resourceId: string, filename: string, locale: string) {
  const mount = document.createElement("div");
  mount.className = "doca-markdown";
  mount.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;pointer-events:none";
  mount.setAttribute("aria-hidden", "true");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    flushSync(() => root.render(<div className="exmd-editor"><MarkdownPreview value={markdown} locale={locale} resolveImageUrl={path => platformAssetId(path) ? assetUrl(platformAssetId(path)!) : ""} /></div>));
    // Async images and Mermaid finish in the isolated preview before capture.
    const deadline = Date.now() + 20_000;
    await new Promise(resolve => setTimeout(resolve, 0));
    mount.querySelectorAll("img").forEach(image => { image.loading = "eager"; });
    while (Array.from(mount.querySelectorAll(".mermaid-diagram")).some(diagram => !diagram.querySelector("svg")) || Array.from(mount.querySelectorAll("img")).some(image => !!image.getAttribute("src") && !image.complete)) {
      if (Date.now() > deadline) throw Error("pdf_render_timeout");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const body = mount.querySelector<HTMLElement>(".markdown-body");
    if (!body) throw Error("pdf_preview_not_ready");
    return await exportRenderedPdf(body, resourceId, filename, undefined, locale);
  } catch (error) { throw localizedPdfError(error, locale); }
  finally { root.unmount(); mount.remove(); }
}

const pdfErrorKeys: Record<string, MessageKey> = {
  pdf_render_failed: "pdf.exportFailed", pdf_preview_not_ready: "pdf.previewNotReady",
  pdf_asset_invalid: "pdf.assetInvalid", pdf_media_read_failed: "pdf.mediaReadFailed", pdf_font_read_failed: "pdf.fontReadFailed",
  pdf_render_timeout: "pdf.renderTimeout", pdf_render_too_large: "pdf.tooLarge", pdf_render_busy: "pdf.busy",
  pdf_render_unavailable: "pdf.unavailable", pdf_invalid_request: "pdf.invalidRequest", pdf_format_unsupported: "pdf.unsupportedFormat",
};
export function localizedPdfError(error: unknown, locale: string) {
  const key = pdfErrorKeys[error instanceof Error ? error.message : ""];
  return key ? Error(translate(locale === "zh" ? "zh" : "en", key)) : error;
}
