if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated QA only");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const sharp = require("sharp");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    const origin = "http://127.0.0.1:39252";
    async function api(path, data, method = "GET") {
      const r = await ctx.request.fetch(origin + "/api/v1" + path, {
        method,
        data,
        headers: { origin },
      });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    }
    await api(
      "/auth/login",
      { login: "notesqa", password: "isolated-notes-qa-2026" },
      "POST",
    );
    await api("/me/page-state?key=ui.notesFloat", undefined, "DELETE");
    const png = await sharp(
      Buffer.from(
        '<svg width="480" height="260"><rect width="480" height="260" fill="#e8efe4"/><circle cx="240" cy="130" r="70" fill="#829579"/><path d="M210 135l20 20 40-50" fill="none" stroke="white" stroke-width="8" stroke-linecap="round"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const upload = await ctx.request.post(
      origin + "/api/v1/assets?purpose=note_attachment&filename=layout.png",
      {
        data: png,
        headers: { origin, "content-type": "application/octet-stream" },
      },
    );
    assert.equal(upload.status(), 201, await upload.text());
    const asset = await upload.json();
    const blank = () => ({
      id: randomUUID(),
      type: "paragraph",
      children: [{ text: "" }],
    });
    const oldId = randomUUID();
    await api(
      "/quick-notes/" + oldId,
      { content: [blank()], assetIds: [asset.id] },
      "PUT",
    );
    const textId = randomUUID();
    await api(
      "/quick-notes/" + textId,
      {
        content: [
          blank(),
          { ...blank(), children: [{ text: "一个念头，随时记下。" }] },
          blank(),
        ],
        assetIds: [],
      },
      "PUT",
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/#/notes");
    const textRow = page.locator(`[data-note-id="${textId}"]`);
    await textRow.waitFor();
    const split = await page.evaluate(() => {
      const list = document.querySelector(".note-list-pane").getBoundingClientRect();
      const content = document.querySelector(".note-content-pane").getBoundingClientRect();
      return { list: list.right, content: content.left, listColor: getComputedStyle(document.querySelector(".note-list-pane")).backgroundColor };
    });
    assert.ok(split.list <= split.content + 1, `list sits left of the note: ${JSON.stringify(split)}`);
    assert.equal(split.listColor, "rgb(255, 255, 255)");
    await textRow.click();
    const editor = page.getByRole("textbox", { name: "随手记正文" });
    await editor.waitFor();
    await editor.getByText("一个念头，随时记下。").waitFor();
    const pageTitle = await page.evaluate(() => {
      const title = document.querySelector(".files-topbar-title strong").getBoundingClientRect();
      const tools = document.querySelector(".global-header-tools").getBoundingClientRect();
      const search = document.querySelector(".note-list-search-row").getBoundingClientRect();
      const date = document.querySelector(".note-content-head h2").getBoundingClientRect();
      const mid = (box) => box.top + box.height / 2;
      return {
        header: Math.abs(mid(title) - mid(tools)),
        columns: Math.abs(mid(search) - mid(date)),
        text: document.querySelector(".files-topbar-title strong").textContent,
      };
    });
    assert.equal(pageTitle.text, "随手记");
    assert.ok(pageTitle.header < 3, `title and header tools differ by ${pageTitle.header}px`);
    assert.ok(pageTitle.columns < 3, `search and note heading differ by ${pageTitle.columns}px`);
    await page.screenshot({ path: "/tmp/doca-quick-notes-page.png" });
    await page.getByRole("button", { name: "开启悬浮" }).click();
    const floating = page.getByRole("region", { name: "随手记悬浮窗口" });
    await floating.waitFor();
    await page.getByRole("region", { name: "随手记已在悬浮窗口" }).waitFor();
    assert.equal(await floating.getByRole("tab").count(), 0);
    await floating.getByRole("button", { name: "返回列表" }).waitFor();
    await floating.getByRole("textbox", { name: "随手记正文" }).getByText("一个念头，随时记下。").waitFor();
    await floating.getByRole("button", { name: "返回列表" }).click();
    await floating.getByRole("button", { name: "新建随手记" }).waitFor();
    assert.equal(await page.locator(".note-list-pane").count(), 1);
    await floating.getByRole("button", { name: "批量选择" }).click();
    await floating.getByRole("button", { name: "全选" }).waitFor();
    const batch = await floating.locator(".note-selection-bar").evaluate((el) => {
      const bar = el.getBoundingClientRect();
      const buttons = [...el.querySelectorAll("button")].map((node) => node.getBoundingClientRect());
      return {
        oneRow: buttons.every((box) => Math.abs(box.top - buttons[0].top) < 2),
        inside: bar.height < 48,
      };
    });
    assert.equal(batch.oneRow, true);
    assert.equal(batch.inside, true);
    await floating.screenshot({ path: "/tmp/doca-notes-float-batch.png" });
    await floating.getByRole("button", { name: "批量选择" }).click();
    await floating.locator(`[data-note-id="${textId}"]`).waitFor();
    await floating.screenshot({ path: "/tmp/doca-notes-float.png" });
    await page.getByRole("button", { name: "折叠悬浮窗口" }).click();
    const pill = page.locator(".note-float-pill");
    await pill.waitFor();
    await pill.getByRole("button", { name: "关闭悬浮" }).click();
    await floating.waitFor({ state: "detached" });
    await pill.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "新建随手记" }).click();
    await editor.click();
    await page.keyboard.insertText("记录灵感\n".repeat(4));
    // Fresh draft: exercise native file paste and its built-in preview.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("doca.quick-note.") && key.endsWith(".new"))
          localStorage.removeItem(key);
    });
    await editor.evaluate((el, bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], "native.png", { type: "image/png" }),
      );
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, Array.from(png));
    await page.locator(".note-content-pane .sk-image img").waitFor();
    const save = page.getByRole("button", { name: "记下", exact: true });
    if (await save.isVisible().catch(() => false)) await save.click();
    await page.waitForFunction(async () => {
      const { items } = await (await fetch("/api/v1/quick-notes")).json();
      return items.some((n) =>
        n.content.some((b) => b.type === "image" && b.path),
      );
    });
    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await page.locator(".note-content-pane .sk-image img").first().waitFor();
    const records = (await api("/quick-notes")).items;
    const native = records.find((n) =>
      n.content.some((b) => b.type === "image" && b.path),
    );
    assert.ok(native.assets.length === 1);
    assert.equal(
      native.content.find((n) => n.type === "image").path,
      native.assets[0].id,
    );
    await page.screenshot({ path: "/tmp/doca-quick-notes-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "/tmp/doca-quick-notes-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS title list and content pane, floating window, native image paste/save, mobile overflow",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
