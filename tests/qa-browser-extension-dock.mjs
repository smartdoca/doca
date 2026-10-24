// Actual MV3 scripts and shared chat UI, synthetic HTTP data, isolated browser storage.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { captureImageInfo } from "../apps/browser-extension/image-processing.js";

const output = resolve(
  process.argv[2] ?? "artifacts/verification/browser-extension-dock/browser",
);
await mkdir(output, { recursive: true });
const extension = join(output, "extension");
await cp(
  fileURLToPath(new URL("../apps/browser-extension", import.meta.url)),
  extension,
  { recursive: true },
);
const connectionId = randomUUID(),
  profileId = randomUUID(),
  sessionId = randomUUID();
const profile = {
  id: profileId,
  revision: 1,
  name: "网页归档",
  isDefault: true,
  strategy: "create",
};
const session = {
  // The assistant stays bound to the default profile, independently of capture rules.
  id: sessionId,
  title: "网页分析",
  model_id: "fixture-model",
  source: "browser_assistant",
  archived: 0,
};
const otherProfile = {
  id: randomUUID(),
  revision: 2,
  name: "项目资料",
  isDefault: false,
  strategy: "append",
  destinationTitle: "资料收集",
};
const captures = [],
  uploads = [],
  sends = [],
  messages = [],
  jobs = [];
let holdClip = false,
  heldClip = null,
  failCommit = false;
const large = await sharp({
  create: {
    width: 6000,
    height: 5000,
    channels: 4,
    background: { r: 51, g: 112, b: 255, alpha: 0.5 },
  },
})
  .png()
  .toBuffer();
const rotated = await sharp({
  create: { width: 6000, height: 5000, channels: 3, background: "#3370ff" },
})
  .withMetadata({ orientation: 6 })
  .jpeg()
  .toBuffer();
// Seeded pixels make the byte-trigger case repeatable, including non-opaque alpha.
const noise = Buffer.alloc(1200 * 1000 * 4);
let seed = 47;
for (let i = 0; i < noise.length; i++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  noise[i] = seed & 255;
}
const noisy = await sharp(noise, {
  raw: { width: 1200, height: 1000, channels: 4 },
})
  .png()
  .toBuffer();
assert(noisy.length > 4 * 1024 ** 2);
const fixtures = {
  "/large.png": large,
  "/rotated.jpg": rotated,
  "/noisy.png": noisy,
};
const errors = [],
  unexpected = [];
const server = createServer(async (req, res) => {
  try {
    if (fixtures[req.url]) {
      res.writeHead(200, {
        "content-type": req.url.endsWith("jpg") ? "image/jpeg" : "image/png",
      });
      res.end(fixtures[req.url]);
      return;
    }
    if (!req.url.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Doca 收录验证</title><style>body{margin:0;background:#f6f8fb;color:#263040;font:16px/1.85 system-ui}header{padding:22px 6vw;background:white;border-bottom:1px solid #e4e9f1}article{max-width:740px;margin:54px auto;padding:0 48px}h1{font-size:30px;line-height:1.4}h2{font-size:21px;margin-top:36px}img{max-width:100%;height:150px;object-fit:cover;border-radius:10px}.fixed{position:fixed;right:12px;bottom:20px;padding:12px;background:white;border:1px solid #ddd;border-radius:8px;font-size:12px}@media(max-width:500px){article{padding:0 24px;margin:32px auto}h1{font-size:25px}}</style><header><strong>阅读与记录</strong></header><article><h1>把有用的网页，留在知识库</h1><p id="selected">这段内容用于验证选中区域收录，只保存这里的文字。</p><p>阅读网页时，随手归档有价值的信息，再交给 Doca 助手继续分析。</p><img src="/large.png" alt="透明图片压缩验证"><h2>归档时保留上下文</h2><p>正文、来源链接和图片共同组成完整资料，方便之后继续阅读。</p></article><aside class="fixed">网页固定工具</aside>`,
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const binary = req.method === "PUT";
    const body = bytes.length && !binary ? JSON.parse(bytes) : undefined;
    const path = req.url.split("?")[0];
    let result;
    if (path.endsWith("/session")) result = {};
    else if (path.endsWith("/me"))
      result = {
        user: { id: "fixture-user", name: "验证用户" },
        connection: { assistant_enabled: 1 },
      };
    else if (path.endsWith("/profiles"))
      result = { items: [profile, otherProfile] };
    else if (path.endsWith("/options"))
      result = {
        enabled: true,
        memoryAvailable: false,
        webSearchAvailable: false,
        defaultModel: "fixture-model",
        uploadLimits: {
          maxFiles: 8,
          maxFileBytes: 20971520,
          maxTotalBytes: 26214400,
        },
        preferences: { default_model: null, memory_enabled: 0 },
        models: [
          {
            id: "fixture-model",
            name: "验证模型",
            inputRate: 0,
            outputRate: 0,
            imageRate: 0,
            vision: false,
            pdf: false,
          },
        ],
      };
    else if (path.endsWith("/clips")) {
      captures.push(body);
      result = {
        status: "pending",
        uploadedImageIds: uploads
          .filter(({ path }) => path.includes(body.requestId))
          .map(({ path }) => path.split("/").at(-1)),
      };
      if (holdClip) {
        holdClip = false;
        heldClip = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
          heldClip = null;
        };
        return;
      }
    } else if (binary && /\/clips\/[^/]+\/images\//.test(path)) {
      uploads.push({ path, bytes });
      result = {};
    } else if (path.endsWith("/commit")) {
      if (failCommit) {
        failCommit = false;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "clipper_connection_failed" }));
        return;
      }
      result = { status: "completed", url: "/documents/fixture" };
    } else if (path.endsWith("/sessions"))
      result = req.method === "POST" ? session : [session];
    else if (path.endsWith("/messages")) {
      assert(
        !sends.some((send) => send.id === body.id),
        "No duplicate message POST",
      );
      sends.push(body);
      messages.push({
        id: body.id,
        role: "user",
        text: body.text,
        attachments: [],
        references: [],
        explorer: [],
      });
      jobs.push({
        id: body.id,
        status: "running",
        error: "",
        model_id: body.modelId,
      });
      result = { id: body.id };
    } else if (path.endsWith(`/sessions/${sessionId}`))
      result = {
        session,
        browserProfile: { id: profileId, revision: 1 },
        messages,
        jobs,
        operations: [],
        resources: [],
        hasMore: false,
      };
    else {
      unexpected.push({ method: req.method, path });
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    errors.push(error.stack);
    res.writeHead(500);
    res.end("{}");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
const wait = async (predicate, label) => {
  const until = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > until) throw Error("Timed out: " + label);
    await new Promise((done) => setTimeout(done, 50));
  }
};
try {
  context = await chromium.launchPersistentContext(
    join(output, "browser-profile"),
    {
      executablePath: chromium.executablePath(),
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  context.setDefaultTimeout(15000);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionUrl = "chrome-extension://" + new URL(worker.url()).hostname;
  await worker.evaluate(
    async ({ origin, connectionId, profileId, sessionId }) => {
      await chrome.storage.local.set({ site: { version: 2, origin } });
      await chrome.storage.session.set({
        authorization: {
          version: 2,
          origin,
          connectionId,
          token: "doca_browser_v2_" + "1".repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        assistant: { origin, connectionId, profileId, id: sessionId },
      });
    },
    { origin, connectionId, profileId, sessionId },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.goto(origin + "/read");
  await page.locator("[data-doca-capture-ui]").waitFor();
  let cdp = await context.newCDPSession(page);
  const root = async () => {
    const { root: doc } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node) =>
      node.attributes?.includes("data-doca-capture-ui")
        ? node
        : [...(node.children ?? []), ...(node.shadowRoots ?? [])]
            .map(find)
            .find(Boolean);
    const host = find(doc);
    assert(host?.shadowRoots?.[0], "Closed isolated shadow root");
    return host.shadowRoots[0].nodeId;
  };
  const shadow = async (fn, ...args) => {
    const { object } = await cdp.send("DOM.resolveNode", {
      nodeId: await root(),
    });
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const box = async (selector) => {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: await root(),
      selector,
    });
    assert(nodeId, selector);
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
    const [x, y, right, , , bottom] = model.border;
    return { x, y, width: right - x, height: bottom - y };
  };
  const click = async (selector) => {
    const b = await box(selector);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  const layoutReady = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  const text = (selector) =>
    shadow(function (s) {
      return this.querySelector(s)?.textContent ?? "";
    }, selector);
  const ruleReady = () =>
    shadow(function () {
      return (
        this.querySelector(".confirm").textContent === "确认收录" &&
        !this.querySelector(".confirm").disabled &&
        this.querySelector("select").options.length > 0
      );
    });
  const screenshot = async (name, motion = false) => {
    if (!motion)
      await wait(
        async () =>
          await shadow(function () {
            return [
              ...this.querySelectorAll(
                ".dock,.panel:not([hidden]),.doca-select-menu:not([hidden])",
              ),
            ].every((node) => Number(getComputedStyle(node).opacity) === 1);
          }),
        "animation completed",
      );
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(join(output, name + ".png"), Buffer.from(data, "base64"));
  };
  const motionFrames = async (selector, duration, prefix) => {
    await shadow(function (s) {
      const node = this.querySelector(s);
      node.style.animation = "none";
      void node.offsetWidth;
      node.style.animation = "";
      const animation = node.getAnimations()[0];
      animation.pause();
      animation.currentTime = 0;
    }, selector);
    for (const [name, time] of [
      ["start", 0],
      ["middle", duration / 2],
      ["end", duration],
    ]) {
      await shadow(
        function (s, t) {
          this.querySelector(s).getAnimations()[0].currentTime = t;
        },
        selector,
        time,
      );
      await screenshot(`${prefix}-${name}`, true);
    }
  };
  assert.equal(
    await shadow(function () {
      return this.querySelectorAll(".tool").length;
    }),
    4,
  );
  await screenshot("desktop-dock");
  await motionFrames(".dock", 240, "motion-entry");
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#selected"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  assert.equal(
    await shadow(function () {
      return this.querySelector(".panel").hidden;
    }),
    true,
    "Selecting text does not open a floating action",
  );
  await click('[data-action="page"]');
  await wait(ruleReady, "capture rule loaded");
  assert.equal(captures.length, 0, "Opening the bubble never starts capture");
  assert.equal(
    await shadow(function () {
      return this.querySelector("select").hidden;
    }),
    true,
    "Native select stays hidden",
  );
  await click('[role="combobox"]');
  await wait(
    async () =>
      await shadow(function () {
        return !this.querySelector('[role="listbox"]').hidden;
      }),
    "Custom dropdown opens",
  );
  const menu = await box('[role="listbox"]'),
    trigger = await box('[role="combobox"]');
  assert(
    menu.y >= trigger.y + trigger.height,
    "Dropdown opens below the trigger when space permits",
  );
  await screenshot("capture-dropdown");
  await page.keyboard.press("Escape");
  assert.equal(
    await shadow(function () {
      return this.querySelector(".panel").hidden;
    }),
    false,
    "Escape closes the dropdown first",
  );
  await click('[role="combobox"]');
  await click('[role="option"]:nth-child(2)');
  assert((await text('[role="combobox"]')).includes("项目资料"));
  assert.equal(captures.length, 0);
  await screenshot("capture-rule");
  await motionFrames(".panel", 180, "motion-panel");
  const action = await box(".confirm");
  await page.mouse.move(
    action.x + action.width / 2,
    action.y + action.height / 2,
  );
  await screenshot("motion-press-start");
  await page.mouse.down();
  await new Promise((done) => setTimeout(done, 60));
  await screenshot("motion-press-middle");
  failCommit = true;
  await page.mouse.up();
  await wait(
    async () => (await text(".confirm")) === "重试",
    "failed capture remains retryable",
  );
  await screenshot("capture-failure");
  await click(".confirm");
  await wait(
    async () => (await text(".status")).includes("已保存"),
    "retry captured",
  );
  await screenshot("motion-press-end");
  assert(captures[0].markdown.includes("归档时保留上下文"));
  assert.equal(
    captures[0].profileId,
    otherProfile.id,
    "Capture uses the selected custom dropdown rule",
  );
  assert(
    !captures[0].markdown.includes("收录规则"),
    "Capture excludes extension UI",
  );
  assert.equal(
    captures[0].requestId,
    captures[1].requestId,
    "Retry retains the request identity",
  );
  const uploaded = await sharp(uploads[0].bytes).metadata();
  assert(
    Math.max(uploaded.width, uploaded.height) <= 4096 &&
      uploaded.width * uploaded.height <= 16_000_000 &&
      uploaded.hasAlpha,
  );
  const alpha = await sharp(uploads[0].bytes).raw().toBuffer();
  assert(alpha[3] >= 126 && alpha[3] <= 129, "Transparency preserved");
  assert(uploads[0].bytes.length <= 4 * 1024 ** 2);
  assert.equal(uploads.length, 1, "Retry skips the already-uploaded image");
  await click(".close");
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#selected"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await click('[data-action="selection"]');
  await wait(ruleReady, "selection rule");
  await click(".confirm");
  await wait(() => captures.length === 3, "selection submitted");
  assert.equal(captures[2].mode, "selection");
  assert(captures[2].markdown.includes("只保存这里的文字"));
  assert(!captures[2].markdown.includes("归档时保留上下文"));
  await wait(
    async () => (await text(".status")).includes("已保存"),
    "selection done",
  );
  await click(".close");
  const before = await box(".dock"),
    handle = await box(".handle");
  await page.mouse.move(handle.x + 8, handle.y + 8);
  await page.mouse.down();
  await page.mouse.move(handle.x + 8, handle.y - 200, { steps: 12 });
  await page.mouse.up();
  let after = await box(".dock");
  assert(after.y < before.y - 150);
  await wait(
    async () =>
      (await worker.evaluate(
        async () =>
          (await chrome.storage.local.get("dockPosition")).dockPosition,
      )) < 0.4,
    "drag persisted",
  );
  const initialPreference = await worker.evaluate(
    async () => (await chrome.storage.local.get("dockPosition")).dockPosition,
  );
  await worker.evaluate(() => {
    globalThis.docaQaOriginalLocalSet = chrome.storage.local.set.bind(
      chrome.storage.local,
    );
    chrome.storage.local.set = async (value) => {
      if (Object.hasOwn(value, "dockPosition"))
        throw Error("Injected position storage failure");
      return globalThis.docaQaOriginalLocalSet(value);
    };
  });
  const failHandle = await box(".handle");
  await page.mouse.move(failHandle.x + 8, failHandle.y + 8);
  await page.mouse.down();
  await page.mouse.move(failHandle.x + 8, failHandle.y + 38, { steps: 6 });
  await page.mouse.up();
  await wait(
    async () => (await text(".status")).includes("位置未能保存"),
    "Position write failure is visible",
  );
  assert.equal(
    await worker.evaluate(
      async () => (await chrome.storage.local.get("dockPosition")).dockPosition,
    ),
    initialPreference,
    "Failed writes retain the old cache",
  );
  await screenshot("position-save-failure");
  await worker.evaluate(() => {
    chrome.storage.local.set = globalThis.docaQaOriginalLocalSet;
    delete globalThis.docaQaOriginalLocalSet;
  });
  await click(".close");
  after = await box(".dock");
  const collapseControl = await box('[data-action="collapse"]');
  const settingsControl = await box('[data-action="settings"]');
  assert(
    Math.abs(collapseControl.x - settingsControl.x) < 1 &&
      Math.abs(collapseControl.width - settingsControl.width) < 1 &&
      collapseControl.y >= settingsControl.y + settingsControl.height,
    "Collapse control shares the action column below Settings",
  );
  await click('[data-action="collapse"]');
  await wait(
    async () => (await box(".dock")).height < 100,
    "Toolbar collapsed",
  );
  assert.equal(
    await shadow(function () {
      return this.querySelector(".actions").hidden;
    }),
    true,
  );
  assert(
    Math.abs((await box(".dock")).y - after.y) < 2,
    "Collapsing keeps the dock anchor",
  );
  await screenshot("collapsed-dock");
  const compactHandle = await box(".handle");
  await page.mouse.move(compactHandle.x + 8, compactHandle.y + 8);
  await page.mouse.down();
  await page.mouse.move(compactHandle.x + 8, compactHandle.y + 78, {
    steps: 8,
  });
  await page.mouse.up();
  await wait(
    async () =>
      (await worker.evaluate(
        async () =>
          (await chrome.storage.local.get("dockPosition")).dockPosition,
      )) >
      initialPreference + 0.05,
    "Collapsed dragging persists",
  );
  after = await box(".dock");
  await click('[data-action="collapse"]');
  await wait(
    async () => (await box(".dock")).height > 150,
    "Toolbar expanded",
  );
  assert.equal(
    await shadow(function () {
      return this.querySelector(".actions").hidden;
    }),
    false,
  );
  assert(
    Math.abs((await box(".dock")).y - after.y) < 2,
    "Expanding keeps the moved anchor",
  );
  await page.reload();
  await page.locator("[data-doca-capture-ui]").waitFor();
  assert(
    Math.abs((await box(".dock")).y - after.y) < 2,
    "Position restored after reload",
  );
  await screenshot("dragged-dock");
  await page.setViewportSize({ width: 390, height: 844 });
  await layoutReady();
  await click('[data-action="page"]');
  await wait(ruleReady, "narrow capture rule");
  const narrow = await box(".panel");
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 390);
  await screenshot("narrow-capture");
  await click('[role="combobox"]');
  const narrowMenu = await box('[role="listbox"]');
  assert(
    narrowMenu.x >= 0 &&
      narrowMenu.x + narrowMenu.width <= 390 &&
      narrowMenu.y >= 0 &&
      narrowMenu.y + narrowMenu.height <= 844,
  );
  await screenshot("narrow-dropdown");
  await page.keyboard.press("Escape");
  await click(".close");
  await page.setViewportSize({ width: 1280, height: 900 });
  await layoutReady();
  const sourceTabId = await worker.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    page.url(),
  );
  await worker.evaluate(async (id) => chrome.tabs.setZoom(id, 2), sourceTabId);
  await layoutReady();
  await click('[data-action="page"]');
  await wait(ruleReady, "zoom capture rule");
  const zoom = await box(".panel"),
    viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
  assert(
    zoom.x >= 0 &&
      zoom.x + zoom.width <= viewport.width &&
      zoom.y + zoom.height <= viewport.height,
    "200% browser zoom stays in viewport",
  );
  await screenshot("zoom-200");
  await click('[role="combobox"]');
  const zoomMenu = await box('[role="listbox"]');
  assert(
    zoomMenu.x >= 0 &&
      zoomMenu.x + zoomMenu.width <= viewport.width &&
      zoomMenu.y >= 0 &&
      zoomMenu.y + zoomMenu.height <= viewport.height,
  );
  await screenshot("zoom-dropdown-200");
  await page.keyboard.press("Escape");
  await click(".close");
  await worker.evaluate(async (id) => chrome.tabs.setZoom(id, 1), sourceTabId);
  await layoutReady();
  const settingsOpened = context.waitForEvent("page");
  await click('[data-action="settings"]');
  const settings = await settingsOpened;
  await settings.waitForLoadState();
  await settings.locator("#connection-pane:not([hidden])").waitFor();
  assert(settings.url().endsWith("ui.html#settings"));
  await settings.locator("#endpoint").waitFor();
  await settings.screenshot({
    path: join(output, "settings.png"),
    fullPage: true,
  });
  assert.equal(sends.length, 0, "Settings never calls the model");
  await settings.close();
  await page.bringToFront();
  await click('[data-action="assistant"]');
  await wait(
    async () => (await text(".status")) === "",
    "assistant opens without an error bubble",
  );
  // A separate extension page uses the exact production assistant bundle. Keep
  // the source tab active just as it is while a native side panel is open.
  const ui = await context.newPage();
  ui.on("pageerror", (error) => errors.push(error.stack));
  await ui.goto(extensionUrl + "/ui.html#assistant");
  await page.bringToFront();
  await ui.locator('.ant-sender [contenteditable="true"]').waitFor();
  const sendText = async (value) => {
    const input = ui.locator('.ant-sender [contenteditable="true"]');
    await input.fill(value);
    await input.press("Enter");
  };
  holdClip = true;
  await sendText("第一条：分析当前网页");
  await wait(() => heldClip !== null, "held capture before POST");
  const retained = await ui.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("doca-ai-pending", 1);
      request.onupgradeneeded = () => {
        request.transaction.abort();
        reject(Error("Expected an existing pending database"));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction("entries", "readonly")
          .objectStore("entries")
          .getAll();
        request.onsuccess = () =>
          resolve(
            request.result.some(
              (entry) =>
                entry.state === "pending" &&
                entry.item.text === "第一条：分析当前网页",
            ),
          );
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
  assert.equal(
    retained,
    true,
    "Hidden queue copy remains durably recoverable while sending",
  );
  assert.equal(
    await ui.locator(".ai-pending-list").count(),
    0,
    "Sending item has one bubble, no queue duplicate",
  );
  assert((await ui.locator(".ai-messages").innerText()).includes("第一条"));
  await ui.screenshot({
    path: join(output, "chat-sending.png"),
    fullPage: true,
  });
  heldClip();
  await wait(() => sends.length === 1, "first POST accepted");
  await wait(
    async () => (await ui.locator(".ai-pending-list").count()) === 0,
    "accepted item absent from queue before AI answer",
  );
  assert.equal(
    messages.filter((message) => message.role === "assistant").length,
    0,
  );
  await sendText("第二条：整理为要点");
  await ui.locator(".ai-pending-item").waitFor();
  assert.equal(await ui.locator(".ai-pending-item").count(), 1);
  assert(
    !(await ui.locator(".ai-messages").innerText()).includes("第二条"),
    "Waiting item appears only in the queue",
  );
  await ui.screenshot({
    path: join(output, "chat-waiting.png"),
    fullPage: true,
  });
  jobs[0] = { ...jobs[0], status: "completed" };
  messages.push({
    id: randomUUID(),
    role: "assistant",
    text: "已读完网页，可以继续整理。",
  });
  await wait(
    () => sends.length === 2,
    "waiting item dispatches once after previous reply",
  );
  await wait(
    async () =>
      (await ui.locator(".ai-pending-item").count()) === 0 &&
      (await ui.locator(".ai-messages").innerText()).includes("第二条"),
    "second accepted item moves to the timeline before its answer",
  );
  assert.equal(
    await ui.locator(".ai-user-bubble").filter({ hasText: "第二条" }).count(),
    1,
    "Accepted message appears exactly once",
  );
  assert.equal(
    messages.filter((message) => message.role === "assistant").length,
    1,
    "No second AI reply yet",
  );
  await ui.screenshot({
    path: join(output, "chat-accepted.png"),
    fullPage: true,
  });
  await ui.reload();
  await page.bringToFront();
  await wait(
    async () =>
      (await ui
        .locator(".ai-user-bubble")
        .filter({ hasText: "第二条" })
        .count()) === 1,
    "Accepted message survives reload without duplicate sending",
  );
  assert.equal(await ui.locator(".ai-pending-item").count(), 0);
  assert.equal(sends.length, 2);
  const imageResults = [];
  for (const name of ["large.png", "rotated.jpg", "noisy.png"]) {
    const processed = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const id = randomUUID(),
        before = uploads.length;
      const response = await ui.evaluate(
        (message) => chrome.runtime.sendMessage(message),
        {
          type: "capture",
          profileId,
          profileRevision: 1,
          capture: {
            mode: "page",
            title: name,
            url: origin + "/read",
            markdown: `![${name}](doca-image://${id})`,
            images: [{ id, name, url: origin + "/" + name }],
          },
        },
      );
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(uploads.length, before + 1);
      processed.push(uploads.at(-1).bytes);
    }
    const bytes = processed[0];
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const result = {
      input: captureImageInfo(fixtures["/" + name]),
      output: captureImageInfo(bytes),
      bytes: bytes.length,
      hash: hash(bytes),
      repeatHash: hash(processed[1]),
    };
    await writeFile(join(output, "compressed-" + name), bytes);
    assert.equal(result.hash, result.repeatHash, "Deterministic retry bytes");
    assert(
      result.bytes <= 4 * 1024 ** 2 &&
        result.output.width * result.output.height <= 16_000_000 &&
        Math.max(result.output.width, result.output.height) <= 4096,
    );
    assert.equal(result.input.mime, result.output.mime);
    if (name === "rotated.jpg")
      assert(
        result.output.height > result.output.width,
        "EXIF display orientation retained",
      );
    if (name.endsWith("png")) assert((await sharp(bytes).metadata()).hasAlpha);
    imageResults.push({ name, ...result });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  const cachedPosition = await worker.evaluate(
    async () => (await chrome.storage.local.get("dockPosition")).dockPosition,
  );
  const expectedTop = await page
    .locator("[data-doca-capture-ui]")
    .evaluate((node) => node.style.top);
  const browserOptions = {
    executablePath: chromium.executablePath(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  };
  await context.close();
  context = await chromium.launchPersistentContext(
    join(output, "browser-profile"),
    browserOptions,
  );
  const restarted = await context.newPage();
  await restarted.goto(origin + "/reopened");
  await restarted.locator("[data-doca-capture-ui]").waitFor();
  assert.equal(
    await restarted
      .locator("[data-doca-capture-ui]")
      .evaluate((node) => node.style.top),
    expectedTop,
    "Browser restart restores the position before showing the toolbar",
  );
  const another = await context.newPage();
  await another.goto(origin + "/another");
  await another.locator("[data-doca-capture-ui]").waitFor();
  assert.equal(
    await another
      .locator("[data-doca-capture-ui]")
      .evaluate((node) => node.style.top),
    expectedTop,
    "New pages read the same frontend cache",
  );
  cdp = await context.newCDPSession(another);
  await wait(
    async () =>
      await shadow(function () {
        return (
          Number(getComputedStyle(this.querySelector(".dock")).opacity) === 1
        );
      }),
    "Restored toolbar entry completed",
  );
  await another.screenshot({
    path: join(output, "position-after-browser-restart.png"),
  });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        viewport: [1280, 900],
        narrow: [390, 844],
        zoom: "200%",
        controls: {
          customDropdown: true,
          collapseExpand: true,
          collapseInActionColumn: true,
          collapsedDragging: true,
          cachedPosition,
          restoredTop: expectedTop,
          browserRestart: true,
          newPage: true,
          failedPositionWriteRetainedCache: true,
        },
        captures: captures.map(({ mode, requestId }) => ({ mode, requestId })),
        uploads: uploads.map(({ bytes }) => ({
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
        messagesPosted: sends.map(({ id, text }) => ({ id, text })),
        images: imageResults,
        motions: [
          "CSS dock entry sampled at 0/120/240 ms",
          "CSS confirmation bubble entry sampled at 0/90/180 ms",
          "Native pointer press/release and retry result",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      output,
      captures: captures.length,
      messagesPosted: sends.length,
      images: imageResults.map(({ name, bytes, output }) => ({
        name,
        bytes,
        ...output,
      })),
    }),
  );
} catch (error) {
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      {
        error: error.stack,
        errors,
        unexpected,
        captures: captures.length,
        sends,
      },
      null,
      2,
    ),
  );
  if (context)
    for (const [index, page] of context.pages().entries())
      await page
        .screenshot({ path: join(output, `failure-${index}.png`) })
        .catch(() => {});
  throw error;
} finally {
  heldClip?.();
  await context?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
