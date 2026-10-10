// Run against scripts/qa-media-header-server.mts, which uses an isolated in-memory database.
if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated fixture only");
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const origin = "http://127.0.0.1:39361";
const output = "artifacts/rich-diagrams-regression-2026-10-10";

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    const request = async (path, data, method = "GET") => {
      const response = await context.request.fetch(origin + "/api/v1" + path, {
        method,
        headers: { origin },
        data,
      });
      assert.equal(response.status(), 200, await response.text());
      return response.json();
    };
    await request(
      "/auth/login",
      { login: "mediaqa", password: "isolated-media-header-2026" },
      "POST",
    );
    const resource = await request(
      "/resources",
      { title: "图块创建评论引用验收", kind: "document", format: "rich_text" },
      "POST",
    );
    const page = await context.newPage(),
      peer = await context.newPage();
    const consoleWarnings = new Set();
    const errors = [],
      updates = [],
      peerUpdates = [],
      checks = [];
    const watch = (target, frames) => {
      target.on("pageerror", (error) => errors.push(error.message));
      target.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("same key")) consoleWarnings.add(message.text());
      });
      target.on("websocket", (socket) =>
        socket.on("framesent", ({ payload }) => {
          try {
            const frame = JSON.parse(String(payload));
            if (frame.type === "update") frames.push(frame);
          } catch {}
        }),
      );
    };
    watch(page, updates);
    watch(peer, peerUpdates);
    const pass = (label) => {
      checks.push(label);
      console.log("PASS " + label);
    };
    const saved = () =>
      page
        .getByText("已保存到云端", { exact: true })
        .waitFor({ state: "attached" });
    await page.goto(origin + "/#/r/" + resource.id);
    const editor = page.locator('.sk-editable[contenteditable="true"]');
    await editor.waitFor();
    await peer.goto(origin + "/#/r/" + resource.id);
    await peer.locator(".sk-editable").waitFor();
    await page.bringToFront();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const createDiagram = async (name) => {
      const button = page
        .locator(".editor-fixed-toolbar")
        .getByRole("button", { name, exact: true });
      if (!(await button.isVisible()))
        await page.locator(".toolbar-overflow > summary").click();
      await button.click();
    };
    await createDiagram("流程图");
    await page.locator(".sk-block-flowchart .sk-diagram-figure img").waitFor();
    await saved();
    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await createDiagram("思维导图");
    await page.locator(".sk-block-mindmap .sk-diagram-figure img").waitFor();
    await saved();
    await peer.locator(".sk-block-flowchart").waitFor();
    await peer.locator(".sk-block-mindmap").waitFor();
    const before = await request("/ai/resources/" + resource.id + "/preview");
    const blockIds = before.value.map((node) => node.id);
    assert.equal(new Set(blockIds).size, blockIds.length, "Duplicate native block IDs: " + JSON.stringify(before.value));
    const diagrams = before.value.filter((node) =>
      ["flowchart", "mindmap"].includes(node.type),
    );
    assert.equal(diagrams.length, 2);
    assert.equal(
      peerUpdates.length,
      0,
      "Remote diagram insertion echoed a content update",
    );
    pass(
      "toolbar creates both native diagrams; second replica converges without echo",
    );
    await page.reload();
    await editor.waitFor();
    assert.deepEqual(
      (await request("/ai/resources/" + resource.id + "/preview")).value,
      before.value,
    );
    for (const type of ["flowchart", "mindmap"]) {
      const figure = page.locator(`.sk-block-${type} .sk-diagram-figure`);
      await editor.locator(".sk-block-paragraph").first().click();
      await figure.click();
      await page.locator(".selection-comment-floating").waitFor();
      await page
        .locator(".selection-comment-floating")
        .getByRole("button", { name: "评论选中内容", exact: true })
        .click();
      await page
        .locator(".content-comments .rich-comment-composer textarea")
        .fill(type + " review");
      const sent = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/resources/${resource.id}/comments`) &&
          r.request().method() === "POST",
      );
      await page
        .locator(".content-comments .rich-comment-composer .send-comment")
        .click();
      assert.equal((await sent).status(), 200);
      await editor.locator(".sk-block-paragraph").first().click();
      await figure.click();
      await page
        .locator(".selection-comment-floating .ai-reference-button")
        .click();
      await page.locator('.ai-composer [contenteditable="true"]').waitFor();
      pass(
        type + " supports whole-block comments and AI references after reload",
      );
    }
    const detail = await request("/resources/" + resource.id);
    const anchors = detail.comments
      .filter((c) => c.anchor)
      .map((c) => JSON.parse(c.anchor));
    assert.equal(anchors.length, 2);
    assert.deepEqual(
      anchors.map((a) => a.blockId).sort(),
      diagrams.map((d) => d.id).sort(),
    );
    assert(anchors.every((a) => a.kind === "block"));
    await page.screenshot({ path: output + "/diagram-comments-reference.png" });
    const idleCount = updates.length,
      peerIdle = peerUpdates.length;
    await page.waitForTimeout(61000);
    assert.equal(
      updates.length,
      idleCount,
      "Idle selection/comment/reference generated content commits",
    );
    assert.equal(peerUpdates.length, peerIdle);
    pass(
      "60 seconds idle with comments/references generates zero content updates",
    );
    await page.reload();
    await editor.waitFor();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: 2e6,
      uploadThroughput: 80e3,
    });
    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page
      .locator('.editor-fixed-toolbar input[type="file"]')
      .setInputFiles({
        name: "upload-progress.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("progress ".repeat(100000)),
      });
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const values = await page
        .locator(".sk-attachment small")
        .evaluateAll((nodes) =>
          nodes.flatMap((node) => {
            const match = /(\d+)%/.exec(node.textContent);
            return match ? [Number(match[1]) / 100] : [];
          }),
        );
      samples.push(...values);
      if (samples.length && !values.length) break;
      await page.waitForTimeout(200);
    }
    assert(
      samples.some((value) => value > 0 && value < 0.99),
      "No incremental upload progress was rendered: " + samples.join(","),
    );
    await page.locator(".sk-attachment-download").waitFor();
    await saved();
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    pass(
      "real throttled upload renders intermediate progress and saves its asset",
    );
    await page.screenshot({ path: output + "/native-diagrams.png" });
    assert.deepEqual(errors, []);
    await fs.writeFile(
      output + "/report.json",
      JSON.stringify(
        {
          checks,
          progressSamples: samples,
          errors,
          consoleWarnings: [...consoleWarnings],
          updates: updates.length,
          peerUpdates: peerUpdates.length,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: output + "/failure.png" });
      console.error((await page.locator("body").innerText()).slice(-3000));
    }
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
