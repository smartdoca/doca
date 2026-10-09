if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Isolated send QA only: set DOCA_QA_ISOLATED=1");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const sharp = require("sharp");
const info = require("../.cache/qa-ai-upload-fixture.json");
assert.equal(info.origin, "http://127.0.0.1:39351");
const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
  const login = await context.request.post(info.origin + "/api/v1/auth/login", {
    headers: { origin: info.origin }, data: { login: "uploadqa", password: "isolated-upload-qa-2026" },
  });
  assert.equal(login.status(), 200, await login.text());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const creation = gate(), upload = gate();
  let uploadCount = 0;
  const messages = [];
  let firstSend = true;
  await page.route("**/api/v1/ai/sessions", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await creation.promise;
    await route.continue();
  });
  await page.route("**/api/v1/assets?*", async route => {
    if (route.request().method() !== "POST") return route.continue();
    uploadCount++;
    await upload.promise;
    await route.continue();
  });
  await page.route("**/api/v1/ai/sessions/*/messages", async route => {
    messages.push(route.request().postDataJSON());
    if (firstSend) {
      firstSend = false;
      return route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ message: "Injected send failure" }) });
    }
    await route.continue();
  });
  try {
    await page.goto(info.origin + "/#/ai");
    const input = page.locator('.ai-composer [contenteditable="true"]');
    await input.waitFor();
    await page.getByRole("button", { name: "上传文件或图片", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".file-source-choice").nth(1).locator("button").first().click();
    const png = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#8ba4c5" } }).png().toBuffer();
    await (await chooser).setFiles([{ name: "send-preview.png", mimeType: "image/png", buffer: png }]);
    await page.locator('.ai-upload-list img[src^="blob:"]').waitFor();
    await input.fill("SEND_IMMEDIATE_MARKER");
    await page.waitForTimeout(300);
    assert.equal(uploadCount, 0, "selection must not upload");
    assert.equal((await context.request.get(info.origin + "/api/v1/files?parentType=system&parentId=ai")).status(), 200);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.locator(".ai-user-message-text").filter({ hasText: "SEND_IMMEDIATE_MARKER" }).waitFor({ timeout: 1000 });
    await page.locator('[data-delivery="sending"]').waitFor({ timeout: 1000 });
    assert.equal(uploadCount, 0);
    assert.equal(messages.length, 0);
    console.log("PASS selection stays local; message is visible before session creation returns");
    creation.release();
    for (let attempt = 0; attempt < 100 && !uploadCount; attempt++) await page.waitForTimeout(50);
    assert.equal(uploadCount, 1);
    assert.equal(messages.length, 0, "AI job must wait for the upload");
    assert.equal(await page.locator(".ai-user-message-text").filter({ hasText: "SEND_IMMEDIATE_MARKER" }).count(), 1);
    await fs.mkdir("artifacts/ai-send-regression-2026-10-09", { recursive: true });
    await page.screenshot({ path: "artifacts/ai-send-regression-2026-10-09/uploading.png" });
    console.log("PASS new session keeps the message while its image uploads");
    upload.release();
    await page.locator('[data-delivery="failed"]').waitFor();
    assert.equal(messages.length, 1);
    await page.getByRole("button", { name: "重新发送", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-delivery="sending"]') &&
      !document.querySelector('[data-delivery="failed"]'));
    assert.equal(uploadCount, 1, "retry must reuse the uploaded image");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].id, messages[1].id, "retry must preserve the message identity");
    assert.deepEqual(messages[0].attachments, messages[1].attachments);
    await page.waitForFunction(() => !document.querySelector('.ai-composer [contenteditable="true"]')?.textContent);
    assert.equal(await page.locator(".ai-user-message-text").filter({ hasText: "SEND_IMMEDIATE_MARKER" }).count(), 1);
    await page.screenshot({ path: "artifacts/ai-send-regression-2026-10-09/sent.png" });
    console.log("PASS failure stays visible; retry reuses upload and message ID without a duplicate bubble");
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: "/tmp/doca-ai-send-failure.png" });
    console.log((await page.locator("body").innerText()).slice(-2500));
    throw error;
  } finally {
    creation.release(); upload.release();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
