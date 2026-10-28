// Actual MV3 worker and closed-shadow toolbar, isolated storage and local pages.
import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";

const output = resolve(process.argv[2] ?? "artifacts/verification/browser-extension-open-site/browser-focused");
await mkdir(output, { recursive: true });
const extension = join(output, "extension");
await cp(resolve("apps/browser-extension"), extension, { recursive: true });
const apiRequests = [];
const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) apiRequests.push(req.url);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><title>Doca toolbar verification</title><style>body{font:18px system-ui;margin:60px;background:#f6f8fb;color:#263040}</style><h1>Doca browser assistant</h1><p>Open the configured website from the toolbar.</p>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
const results = [];
try {
  context = await chromium.launchPersistentContext(join(output, "profile"), {
    headless: true, executablePath: chromium.executablePath(),
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionOrigin = "chrome-extension://" + new URL(worker.url()).hostname;
  await worker.evaluate(async origin => {
    await chrome.storage.local.set({ site: { version: 2, origin }, locale: "zh" });
    await chrome.storage.session.set({ pending: { requestId: "retained-fixture", capture: { markdown: "Unsent material" } } });
  }, origin);
  const storage = () => worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  const page = await context.newPage();
  await page.goto(origin + "/article");
  await page.locator("[data-doca-capture-ui]").waitFor();
  const cdp = await context.newCDPSession(page);
  async function shadow(fn, arg) {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = node => node.attributes?.includes("data-doca-capture-ui") ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(find).find(Boolean);
    const nodeId = find(root).shadowRoots[0].nodeId;
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
    const result = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn.toString(), arguments: [{ value: arg ?? null }], returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function clickSite(keyboard = false) {
    const button = await shadow(function () {
      const b = this.querySelector('[data-action="site"]'), r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.getAttribute("aria-label") };
    });
    const opened = context.waitForEvent("page");
    if (keyboard) {
      await shadow(function () { this.querySelector('[data-action="site"]').focus(); });
      await page.keyboard.press("Enter");
    } else await page.mouse.click(button.x, button.y);
    const tab = await opened;
    await tab.waitForLoadState();
    return { tab, label: button.label };
  }
  // Wait for cached language/position initialization without triggering state/login.
  await page.waitForFunction(() => document.querySelector('[data-doca-capture-ui]').style.visibility !== "hidden");
  const before = await storage();
  assert(!before.session.authorization);
  const first = await clickSite();
  assert.equal(first.label, "打开 Doca 网站");
  assert.equal(first.tab.url(), origin + "/");
  await first.tab.close();
  assert.deepEqual(await storage(), before);
  results.push("signed-out click opens configured site and preserves all stored material");
  await page.screenshot({ path: join(output, "desktop.png") });

  await worker.evaluate(async origin => chrome.storage.local.set({ site: { version: 2, origin }, locale: "en" }), origin.replace("127.0.0.1", "localhost"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-doca-capture-ui]')?.style.visibility === "visible");
  const second = await clickSite(true);
  assert.equal(second.label, "Open Doca website");
  assert.equal(second.tab.url(), origin.replace("127.0.0.1", "localhost") + "/");
  await second.tab.close();
  results.push("English keyboard activation reads the latest configured site");

  await page.setViewportSize({ width: 390, height: 260 });
  await page.screenshot({ path: join(output, "short-viewport.png") });
  assert(await shadow(function () {
    return [...this.querySelectorAll('.tool,.handle,.collapse')].every(b => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  }), "All toolbar controls remain in the short viewport");
  results.push("five icons fit a 390 × 260 viewport");

  await worker.evaluate(async () => chrome.storage.local.remove("site"));
  const missing = await clickSite();
  assert.equal(missing.tab.url(), extensionOrigin + "/ui.html#settings");
  await missing.tab.close();
  results.push("missing site opens extension settings");
  await worker.evaluate(async () => chrome.storage.local.set({ site: { version: 2, origin: "javascript:alert(1)" } }));
  const invalid = await clickSite();
  assert.equal(invalid.tab.url(), extensionOrigin + "/ui.html#settings");
  await invalid.tab.close();
  assert.equal((await storage()).local.site.origin, "javascript:alert(1)");
  results.push("invalid site opens settings without changing the stored value");
  assert.deepEqual(apiRequests, [], "Opening the website does not make capture, login or AI API requests");
  const report = { passed: true, extensionVersion: "0.2.11", results, apiRequests };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
