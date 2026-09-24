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
    const editor = page.getByRole("textbox", { name: "随手记正文" });
    await editor.waitFor();
    const surface = page.locator(".note-compose-card .note-writing-surface");
    const initial = (await surface.boundingBox()).height;
    assert.ok(initial <= 180, `compact initial input: ${initial}`);
    const textCard = page.locator(`[data-note-id="${textId}"]`);
    await textCard.waitFor();
    const gap = await textCard.evaluate((card) => {
      const header = card.querySelector("header").getBoundingClientRect();
      const body = card
        .querySelector("[data-slate-string]")
        .getBoundingClientRect();
      return body.top - header.bottom;
    });
    assert.ok(gap <= 12, `text follows timestamp closely: ${gap}`);
    const oldCard = page.locator(`[data-note-id="${oldId}"]`);
    assert.equal(
      await oldCard.locator(".note-body").count(),
      0,
      "image-only legacy note has no empty body",
    );
    const imageGap = await oldCard.evaluate(
      (card) =>
        card.querySelector(".note-assets").getBoundingClientRect().top -
        card.querySelector("header").getBoundingClientRect().bottom,
    );
    assert.ok(imageGap <= 8, `image follows timestamp: ${imageGap}`);
    for (const selector of [".note-writing-pane", ".note-browsing-pane"])
      assert.equal(
        await page
          .locator(selector)
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgb(255, 255, 255)",
      );
    await editor.click();
    await page.keyboard.insertText("记录灵感\n".repeat(4));
    assert.ok(
      (await surface.boundingBox()).height > initial,
      "input grows with text",
    );
    await page.keyboard.insertText("记录灵感\n".repeat(70));
    const scroll = await page
      .locator(".note-compose-card .sk-page")
      .evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        scroll: el.scrollHeight,
        client: el.clientHeight,
      }));
    assert.ok(
      scroll.height <= 421 && scroll.scroll > scroll.client,
      JSON.stringify(scroll),
    );
    // Fresh draft: exercise native file paste and its built-in preview.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("doca.quick-note.") && key.endsWith(".new"))
          localStorage.removeItem(key);
    });
    await page.reload();
    await editor.waitFor();
    await editor.click();
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
    await page.locator(".note-compose-card .sk-image img").waitFor();
    const save = page.getByRole("button", { name: "记下", exact: true });
    await save.click();
    await page.waitForFunction(async () => {
      const { items } = await (await fetch("/api/v1/quick-notes")).json();
      return items.some((n) =>
        n.content.some((b) => b.type === "image" && b.path),
      );
    });
    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await page.locator(".note-card .sk-image img").first().waitFor();
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
      "PASS compact auto-growing input, maxHeight scrolling, white split panes, compact text/image-only cards, native image paste/save, mobile overflow",
    );
    console.log(
      JSON.stringify({
        initial,
        textGap: gap,
        imageGap,
        maxHeight: scroll.height,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
