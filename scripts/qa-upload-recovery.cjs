if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated QA only");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const origin = "http://127.0.0.1:39140",
      ctx = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
      });
    const req = async (path, data) => {
      const r = await ctx.request.post(origin + "/api/v1" + path, {
        headers: { origin },
        data,
      });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    await req("/auth/login", { login: "qatest", password: "qa-password-2026" });
    const r = await req("/resources", {
      kind: "document",
      format: "rich_text",
      title: "Recovery QA",
      initialContent: {
        schemaVersion: 2,
        children: [
          {
            id: "title",
            type: "paragraph",
            children: [{ text: "Recovery title" }],
          },
          {
            id: "body",
            type: "paragraph",
            children: [{ text: "Do not lose this text" }],
          },
        ],
      },
    });
    const p = await ctx.newPage(),
      errors = [];
    p.on("pageerror", (e) => {
      errors.push(e.message);
      console.log("PAGEERROR", e.stack);
    });
    p.on("response", (r) => {
      if (r.status() >= 400) console.log("HTTP", r.status(), r.url());
    });
    await p.goto(origin + "/#/r/" + r.id);
    const editor = p.locator("[data-slate-editor=true]");
    await editor.waitFor();
    await editor.click();
    await p.keyboard.press("Meta+End");
    const png = [
      ...(await require("sharp")({
        create: { width: 80, height: 40, channels: 3, background: "#00aaff" },
      })
        .png()
        .toBuffer()),
    ];
    let failUpload = true;
    await p.route("**/api/v1/assets**", (route) =>
      route.request().method() === "POST" && failUpload
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Injected upload failure" }),
          })
        : route.continue(),
    );
    const paste = () =>
      editor.evaluate((el, bytes) => {
        const data = new DataTransfer();
        data.items.add(
          new File([new Uint8Array(bytes)], "recovery.png", {
            type: "image/png",
          }),
        );
        el.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, png);
    await paste();
    await p.getByRole("button", { name: "重试上传", exact: true }).waitFor();
    assert.equal(await editor.getAttribute("contenteditable"), "true");
    assert.ok((await editor.innerText()).includes("Do not lose this text"));
    failUpload = false;
    await p.getByRole("button", { name: "重试上传", exact: true }).click();
    await p.waitForFunction(() => {
      const img = document.querySelector(".sk-image img");
      return (
        img &&
        img.complete &&
        img.naturalWidth > 0 &&
        img.getAttribute("src").includes("/api/")
      );
    });
    await p
      .getByText("已保存到云端", { exact: true })
      .waitFor({ state: "attached" });
    await p.reload();
    await editor.waitFor();
    assert.ok((await editor.innerText()).includes("Do not lose this text"));
    await p.waitForFunction(() => {
      const img = document.querySelector(".sk-image img");
      return img && img.complete && img.naturalWidth > 0;
    });
    console.log("PASS failed upload, retry, persistence, preserved text");
    failUpload = true;
    await editor.click();
    await p.keyboard.press("Meta+End");
    await paste();
    await p.getByRole("button", { name: "重试上传", exact: true }).waitFor();
    await p
      .getByText("已保存到云端", { exact: true })
      .waitFor({ state: "attached" });
    await p.reload();
    await editor.waitFor();
    await p
      .getByRole("button", { name: "重新选择图片", exact: true })
      .waitFor();
    assert.equal(await editor.getAttribute("contenteditable"), "true");
    assert.ok((await editor.innerText()).includes("Do not lose this text"));
    await p.screenshot({ path: "/private/tmp/doca-upload-recovery.png" });
    assert.deepEqual(errors, []);
    console.log("PASS failed-placeholder reload remains editable");
    const sheet = await req("/resources", {
      kind: "document",
      format: "spreadsheet",
      title: "Toolbar QA",
    });
    await p.goto(origin + "/#/r/" + sheet.id);
    await p.locator(".uos-office-toolbar").waitFor();
    await p.waitForTimeout(1200);
    const groups = p.locator(".uos-office-toolbar .uos-office-group");
    assert.ok((await groups.count()) >= 3);
    for (const group of await groups.all())
      assert.equal(await group.locator(":scope > div").count(), 2);
    assert.equal(await p.locator(".sheet-selection-comment").count(), 0);
    await p
      .locator(".uos-toolbar-host-actions")
      .getByRole("button", { name: "评论选中区域", exact: true })
      .waitFor();
    await p.screenshot({ path: "/private/tmp/doca-toolbar-recovered.png" });
    console.log("PASS two row toolbar and top comment");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
