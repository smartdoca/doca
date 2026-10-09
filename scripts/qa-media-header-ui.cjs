if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Set DOCA_QA_ISOLATED=1; isolated fixture only");
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const origin = "http://127.0.0.1:39361";
const output = "artifacts/media-header-regression-2026-10-10";
const run = process.env.DOCA_QA_RUN || "1";

(async () => {
  await fs.mkdir(output, { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x3867ff:s=320x180:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    ".cache/qa-media.mp4",
  ]);
  const video = [...(await fs.readFile(".cache/qa-media.mp4"))];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const login = await context.request.post(origin + "/api/v1/auth/login", {
      headers: { origin },
      data: { login: "mediaqa", password: "isolated-media-header-2026" },
    });
    assert.equal(login.status(), 200, await login.text());
    const page = await context.newPage();
    const errors = [],
      updates = [],
      checks = [];
    let uploads = 0;
    page.on("pageerror", (e) => { errors.push(e.message); console.error(e.stack); });
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/v1/assets?"))
        uploads++;
    });
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.type === "update") updates.push(frame);
        } catch {}
      }),
    );
    const pass = (message) => {
      checks.push(message);
      console.log("PASS " + message);
    };
    const capture = (label) =>
      page.screenshot({ path: `${output}/run-${run}-${label}.png` });
    const headerBoxes = () =>
      page.locator(".global-header-tools").evaluate((el) => {
        const selectors = [
          ':scope > .nav-web-topRight [data-entry-id="doca.notifications"]',
          ":scope > .locale-switch > summary",
          ":scope > .account-menu > summary",
        ];
        return selectors.map((selector) => {
          const r = el.querySelector(selector).getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
      });
    const headerResults = [];
    for (const width of [1440, 1100]) {
      await page.setViewportSize({ width, height: 1000 });
      let reference;
      for (const route of ["home", "admin", "account", "preferences"]) {
        await page.goto(origin + "/#/" + route);
        const bell = page.locator(
          '.global-header-tools .nav-web-topRight [data-entry-id="doca.notifications"]',
        );
        await bell.waitFor();
        const before = await headerBoxes();
        if (reference)
          assert.deepEqual(
            before,
            reference,
            `header alignment on ${route} at ${width}`,
          );
        else reference = before;
        await page.locator(".account-menu > summary").click();
        assert.deepEqual(
          await headerBoxes(),
          before,
          "opening account menu moved its trigger",
        );
        await page.locator(".locale-switch > summary").click();
        assert.deepEqual(
          await headerBoxes(),
          before,
          "opening language menu moved its trigger",
        );
        await bell.click();
        await page.locator(".notification-panel").waitFor();
        const anchor = await bell.boundingBox(),
          panel = await page.locator(".notification-panel").boundingBox();
        assert.equal(panel.y, anchor.y + anchor.height + 8);
        assert.equal(panel.x + panel.width, anchor.x + anchor.width);
        assert.deepEqual(
          await headerBoxes(),
          before,
          "opening notifications moved header controls",
        );
        await capture(`${route}-${width}`);
        await bell.click();
        await page
          .locator(".notification-panel")
          .waitFor({ state: "detached" });
        await bell.click();
        await page.setViewportSize({ width: width - 80, height: 1000 });
        await page.waitForFunction(() => {
          const anchor = document
            .querySelector(
              '.global-header-tools .nav-web-topRight [data-entry-id="doca.notifications"]',
            )
            .getBoundingClientRect();
          const panel = document
            .querySelector(".notification-panel")
            .getBoundingClientRect();
          return Math.abs(panel.right - anchor.right) < 1;
        });
        await page.setViewportSize({ width, height: 1000 });
        await bell.click();
        headerResults.push({ width, route, boxes: before });
      }
    }
    pass(
      "home/admin/account/preferences controls align at two widths; opening, closing and resize preserve anchors",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    const response = await context.request.post(origin + "/api/v1/resources", {
      headers: { origin },
      data: {
        kind: "document",
        format: "rich_text",
        title: "视频拖入粘贴验收",
      },
    });
    assert.equal(response.status(), 200, await response.text());
    const resource = await response.json();
    await page.goto(origin + "/#/r/" + resource.id);
    const editor = page.locator('[data-slate-editor="true"]');
    await page
      .locator('[data-slate-editor="true"][contenteditable="true"]')
      .waitFor();
    await editor.click();
    const transfer = async (kind, name, bytes = video, oversized = false) => {
      const rect = await editor.boundingBox();
      await editor.evaluate(
        (el, input) => {
          const dt = new DataTransfer();
          const content = input.oversized
            ? new Uint8Array(21 * 1024 * 1024)
            : new Uint8Array(input.bytes);
          dt.items.add(new File([content], input.name, { type: "video/mp4" }));
          if (input.kind === "paste")
            el.dispatchEvent(
              new ClipboardEvent("paste", {
                clipboardData: dt,
                bubbles: true,
                cancelable: true,
              }),
            );
          else
            for (const type of ["dragover", "drop"])
              el.dispatchEvent(
                new DragEvent(type, {
                  dataTransfer: dt,
                  clientX: input.rect.x + 100,
                  clientY: input.rect.y + 20,
                  bubbles: true,
                  cancelable: true,
                }),
              );
        },
        { kind, name, bytes, oversized, rect },
      );
    };
    const readyVideos = (count) =>
      page.waitForFunction((count) => {
        const videos = [...document.querySelectorAll(".sk-video video")];
        return (
          videos.length === count &&
          videos.every(
            (video) =>
              video.readyState >= 2 &&
              video.getAttribute("src")?.startsWith("/api/"),
          )
        );
      }, count);
    const saved = () =>
      page
        .getByText("已保存到云端", { exact: true })
        .waitFor({ state: "attached" });
    const peer = await context.newPage();
    const peerUpdates = [];
    peer.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
    peer.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.type === "update") peerUpdates.push(frame);
        } catch {}
      }),
    );
    await peer.goto(origin + "/#/r/" + resource.id);
    await peer.locator('[data-slate-editor="true"]').waitFor();
    await page.bringToFront();
    await editor.click();
    await transfer("paste", "pasted-video.mp4");
    await readyVideos(1);
    await saved();
    await transfer("drop", "dropped-video.mp4");
    await readyVideos(2);
    await saved();
    await peer.locator(".sk-video video").nth(1).waitFor();
    assert.equal(await page.locator(".sk-image").count(), 0);
    const sources = await page
      .locator(".sk-video video")
      .evaluateAll((els) => els.map((el) => el.getAttribute("src")).sort());
    assert.deepEqual(
      await peer
        .locator(".sk-video video")
        .evaluateAll((els) => els.map((el) => el.getAttribute("src")).sort()),
      sources,
    );
    assert.equal(
      peerUpdates.length,
      0,
      "remote media application echoed a content update",
    );
    await page
      .locator(".sk-video video")
      .first()
      .evaluate(async (video) => {
        video.muted = true;
        await video.play();
        video.pause();
        video.currentTime = 0.5;
      });
    await page.reload();
    await page
      .locator('[data-slate-editor="true"][contenteditable="true"]')
      .waitFor();
    await readyVideos(2);
    assert.deepEqual(
      await page
        .locator(".sk-video video")
        .evaluateAll((els) => els.map((el) => el.getAttribute("src")).sort()),
      sources,
    );
    await capture("videos");
    pass(
      "paste/drop use video nodes, play successfully, converge in a second tab and preserve asset URLs after reload",
    );
    const uploadsBeforeLimit = uploads,
      updatesBeforeLimit = updates.length;
    for (const kind of ["paste", "drop"]) {
      await editor.click();
      await transfer(kind, `${kind}-too-large.mp4`, [], true);
      await page
        .locator(".document-media-error")
        .filter({ hasText: "20MB" })
        .waitFor();
      assert.equal(
        uploads,
        uploadsBeforeLimit,
        "oversized file reached the server",
      );
      assert.equal(
        updates.length,
        updatesBeforeLimit,
        "oversized file inserted a persisted placeholder",
      );
      assert.equal(await page.locator(".sk-video").count(), 2);
    }
    await capture("too-large");
    pass(
      "oversized paste/drop show the 20MB limit without uploading or creating broken placeholders",
    );
    const failUpload = async (route) => {
      if (route.request().method() === "POST")
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "隔离测试：存储暂时不可用" }),
        });
      return route.continue();
    };
    await page.route("**/api/v1/assets?*", failUpload);
    await transfer("paste", "storage-failure.mp4");
    await page
      .locator(".document-media-error")
      .filter({ hasText: "存储暂时不可用" })
      .waitFor();
    await capture("upload-error");
    await page.unroute("**/api/v1/assets?*", failUpload);
    pass("upload failures show the original server reason and filename");
    await transfer("paste", "invalid-video.mp4", [0, 1, 2, 3, 4, 5, 6]);
    await page
      .locator(".document-media-error")
      .filter({ hasText: "不支持该视频格式" })
      .waitFor();
    await capture("playback-error");
    pass(
      "invalid video playback shows the browser format failure and keeps original-file download",
    );
    await saved();
    const idleUpdates = updates.length;
    const idleSeconds = Number(process.env.DOCA_QA_IDLE_SECONDS || 1);
    await editor.click();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.locator(".main-scroll").evaluate((el) => {
      el.scrollTop += 100;
    });
    await page.waitForTimeout(idleSeconds * 1000);
    assert.equal(
      updates.length,
      idleUpdates,
      "selection, resize, scroll or idle created content updates",
    );
    pass(
      `selection/resize/scroll and ${idleSeconds}s idle emit no content updates`,
    );
    await page.locator('.document-mode-switch [role="combobox"]').click();
    await page.getByRole("option", { name: "阅读", exact: true }).click();
    await page
      .locator('[data-slate-editor="true"][contenteditable="false"]')
      .waitFor();
    const readonlyUploads = uploads,
      readonlyUpdates = updates.length;
    await transfer("paste", "readonly-paste.mp4");
    await transfer("drop", "readonly-drop.mp4");
    assert.equal(uploads, readonlyUploads);
    assert.equal(updates.length, readonlyUpdates);
    await peer.close();
    pass("readonly paste/drop emit no uploads/content updates");
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + "/#/home");
    await page
      .locator(".global-header-tools .account-menu > summary")
      .waitFor();
    assert.deepEqual(
      await headerBoxes(),
      headerResults.find(
        (result) => result.width === 1440 && result.route === "home",
      ).boxes,
      "lazy editor styles moved shared header controls",
    );
    await capture("header-after-editor");
    const header = await page.locator(".global-header-tools").screenshot();
    const metadata = await sharp(header).metadata();
    await sharp(header)
      .resize(metadata.width * 2, metadata.height * 2)
      .toFile(`${output}/run-${run}-header-200.png`);
    await fs.writeFile(
      `${output}/run-${run}-report.json`,
      JSON.stringify({ checks, headerResults, pageErrors: errors }, null, 2),
    );
    console.log(`Run ${run}: ${checks.length} checks passed`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
