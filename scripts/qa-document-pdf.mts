// Uses an isolated fixture and mocked asset/API routes; never opens a user document.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import sharp from "sharp";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderDocumentPdf } from "../apps/server/src/services/document-pdf.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, ".local/document-pdf-qa");
await mkdir(output, { recursive: true });
const html = `${output}/view.html`;
await writeFile(html, `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/@fs/${root}tests/fixtures/document-pdf-view.tsx"></script>`);
const server = await createServer({ configFile: `${root}apps/web/vite.config.ts`, server: { host: "127.0.0.1", port: 0, open: false } });
await server.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.DOCA_PDF_CHROMIUM ? { executablePath: process.env.DOCA_PDF_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const png = await sharp({ create: { width: 200, height: 120, channels: 4, background: "#d4e5ff" } }).png().toBuffer();
  await page.route("**/api/v1/assets/**", route => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/api/v1/resources/pdf-qa/pdf", async route => {
    const { html, width } = route.request().postDataJSON();
    assert(!html.includes("katex-mathml"), "Auxiliary math text duplicated in PDF");
    assert(!/<button\b|contenteditable=/.test(html), "Editing controls present in PDF");
    await route.fulfill({ contentType: "application/pdf", body: await renderDocumentPdf(html, width) });
  });
  const address = server.httpServer!.address();
  assert(address && typeof address !== "string");
  await page.goto(`http://127.0.0.1:${address.port}/@fs/${html}`);
  await page.waitForFunction(() => !!(window as any).pdfQA && !!document.querySelector(".sk-page"));
  assert((await page.locator("#markdown .markdown-body").evaluate(element => getComputedStyle(element).fontFamily)).includes("sans-serif"), "Preview lost the scoped editor typography");
  const rich = await page.evaluate(() => (window as any).pdfQA.exportRich());
  assert(rich.unchanged, "PDF export changed the source Y.Doc");
  const markdown = await page.evaluate(() => (window as any).pdfQA.exportMarkdown());
  assert.equal(await page.locator("#markdown .katex .vlist > span").evaluate(element => !!(element as HTMLElement).style.top), true, "Markdown preview discarded math positioning");
  await page.evaluate(() => (window as any).pdfQA.captureMarkdown());
  await page.locator("#rich .sk-page").screenshot({ path: `${output}/rich-online.png` });
  await page.locator("#markdown .markdown-body").screenshot({ path: `${output}/markdown-online.png` });
  for (const [name, data, required] of [["rich", rich.bytes, ["Editable text", "Readable attachment.pdf", "Host context retained", "Row 34 / 2", "Last row remains visible"]], ["markdown", markdown, ["Start", "Finish", "Last Markdown paragraph"]]] as const) {
    const bytes = new Uint8Array(data);
    await writeFile(`${output}/${name}.pdf`, bytes);
    const pdf = await getDocument({ data: bytes.slice() }).promise;
    try {
      let text = "";
      for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
      for (const expected of required) assert(text.includes(expected), `Missing ${expected} in ${name} PDF`);
      if (name === "rich") assert(pdf.numPages > 1, "Pagination fixture did not span pages");
      console.log(`${name}: ${pdf.numPages} pages; text, images and controls verified`);
    } finally { await pdf.destroy(); }
    const imported = await page.evaluate(bytes => (window as any).pdfQA.importPdf(bytes), Array.from(bytes));
    assert(imported.resources.length >= 1, `${name} image missing after import`);
    await writeFile(`${output}/${name}-import.json`, JSON.stringify(imported.initialValue, null, 2));
  }
  assert.equal(await page.locator('[aria-hidden="true"].document-editor-shell, [aria-hidden="true"].doca-markdown').count(), 0, "Projection leaked after export");
  assert.deepEqual(errors, []);
  console.log(`PDF browser QA passed; visual artifacts: ${output}`);
} finally { await browser?.close(); await server.close(); }
