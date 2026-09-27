// Isolated browser regression; never pass a production origin.
if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated QA only");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const port = process.env.DOCA_QA_PORT || "39250";
if (!["39250", "39251"].includes(port)) throw Error("Unknown QA port");
const origin = "http://127.0.0.1:" + port;
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    const request = async (path, data, method = "GET") => {
      const r = await ctx.request.fetch(origin + "/api/v1" + path, {
        method,
        headers: { origin },
        data,
      });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    await request(
      "/auth/login",
      { login: "aiqa", password: "isolated-ai-qa-2026" },
      "POST",
    );
    const page = await ctx.newPage(),
      errors = [],
      updates = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("websocket", (ws) =>
      ws.on("framesent", ({ payload }) => {
        try {
          const v = JSON.parse(String(payload));
          if (v.type === "update") updates.push(v);
        } catch {}
      }),
    );
    await page.goto(origin);
    await page.getByRole("button", { name: "业务流程", exact: true }).click();
    await page.locator(".doca-canvas canvas").first().waitFor();
    await page.waitForTimeout(1200);
    const resourceId = page.url().split("/r/")[1];
    const before = await request("/ai/resources/" + resourceId + "/preview");
    const surface = await page.locator(".canvas-document").boundingBox();
    // Current AI image exposes native size/ratio controls.
    await page.mouse.click(surface.x + 320, surface.y + 200);
    await page.getByRole("button", { name: "原始比例", exact: true }).waitFor();
    // Reference selection opens AI; type and delete without touching the canvas.
    await page.getByRole("button", { name: "引用给 AI", exact: true }).click();
    const sender = page.locator('.ai-composer [contenteditable="true"]');
    await sender.waitFor();
    await sender.click();
    await page.keyboard.type("abc");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    assert.match(await sender.innerText(), /ab/);
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(500);
    assert.deepEqual(
      await request("/ai/resources/" + resourceId + "/preview"),
      before,
    );
    assert.equal(updates.length, 0);
    console.log(
      "PASS chat Backspace/Delete/Select-all do not delete selected canvas elements",
    );
    // Send an actual selected-element reference and verify no duplicate text rendering.
    await page.mouse.click(surface.x + 320, surface.y + 200);
    await page.getByRole("button", { name: "引用给 AI", exact: true }).click();
    await sender.click();
    await page.keyboard.type(" 请总结这张图");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const bubble = page.locator(".ai-user-bubble").last();
    await bubble.waitFor();
    await bubble.locator(".ai-inline-reference").waitFor();
    assert.equal(await bubble.locator(".ai-inline-reference").count(), 1);
    assert.equal(await bubble.locator(".ai-message-references").count(), 0);
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll(".ai-user-bubble")].at(-1);
      return (
        b &&
        b.querySelectorAll(".ai-inline-reference").length === 1 &&
        !b.textContent.includes("@【")
      );
    });
    await bubble.locator(".ai-inline-reference").click();
    await page.screenshot({ path: "/tmp/doca-native-inline-reference.png" });
    console.log("PASS sent reference: one clickable inline tag");
    // Reopen: same authoritative bytes and native image controls, no autosave repair.
    await page.reload();
    await page.locator(".doca-canvas canvas").first().waitFor();
    await page.waitForTimeout(800);
    assert.deepEqual(
      await request("/ai/resources/" + resourceId + "/preview"),
      before,
    );
    assert.equal(updates.length, 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS reload: stable document, no unintended writes or browser errors",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
