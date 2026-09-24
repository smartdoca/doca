if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Use the isolated QA server only");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } }),
      origin = "http://127.0.0.1:39140";
    const req = async (path, data) => {
      const r = await ctx.request.post(origin + "/api/v1" + path, {
        headers: { origin },
        data,
      });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    await req("/auth/login", { login: "qatest", password: "qa-password-2026" });
    const p = await ctx.newPage(),
      errors = [];
    let commits = 0;
    p.on("websocket", (ws) =>
      ws.on("framesent", ({ payload }) => {
        try {
          if (JSON.parse(String(payload)).type === "update") commits++;
        } catch {}
      }),
    );
    p.on("pageerror", (e) => {
      errors.push(e.message);
      console.log("PAGEERROR", e.message);
    });
    p.on("response", async (r) => {
      if (r.status() >= 400)
        console.log("HTTPERROR", r.status(), r.url(), await r.text());
    });
    p.on("console", (m) => {
      if (m.type() === "warning" || m.text().startsWith("KEY"))
        console.log("BROWSER", m.text());
    });
    const sheet = await req("/resources", {
      kind: "document",
      format: "spreadsheet",
      title: "Office acceptance",
    });
    await p.goto(origin + "/#/r/" + sheet.id);
    await p.locator(".uos-office-toolbar").waitFor();
    await p.waitForTimeout(1800);
    await p.screenshot({ path: "/private/tmp/doca-two-row-before.png" });
    await p.mouse.click(400, 250);
    await p.waitForTimeout(400);
    console.log("COMMENT", await p.locator(".sheet-selection-comment").count());
    await p.getByLabel("评论选中区域", { exact: true }).waitFor();
    assert.equal(await p.locator(".sheet-selection-comment").count(), 0);
    console.log("PASS top sheet comment");
    // rc.6 deliberately disables whole-cell objects until native atomic inline editing ships.
    await p.getByLabel("字号", { exact: true }).waitFor();
    await p.mouse.click(500, 320);
    await p.keyboard.type("upgrade-rc6");
    await p.keyboard.press("Enter");
    await p
      .getByText("已保存到云端", { exact: true })
      .waitFor({ state: "attached" });
    await p.getByLabel("评论选中区域", { exact: true }).click();
    const drawer = p.getByLabel("内容评论抽屉");
    await drawer.getByLabel("评论内容", { exact: true }).fill("升级评论回归");
    await drawer.getByLabel("评论内容", { exact: true }).press("Enter");
    await drawer.getByText("升级评论回归", { exact: true }).waitFor();
    await p.getByLabel("收起内容评论").click();
    await p.reload();
    await p.locator(".uos-office-toolbar").waitFor();
    const peer = await ctx.newPage();
    peer.on("pageerror", (e) => errors.push(e.message));
    await peer.goto(origin + "/#/r/" + sheet.id);
    await peer.locator(".uos-office-toolbar").waitFor();
    await peer
      .getByText("已保存到云端", { exact: true })
      .waitFor({ state: "attached" });
    await peer.close();
    await p.getByLabel("插入", { exact: true }).click();
    await p
      .getByText(
        "@用户、站内文档、内联图片与附件：原子内联模型待实现，未启用。",
        { exact: true },
      )
      .waitFor();
    await p.getByLabel("关闭工具栏菜单", { exact: true }).click();
    await p.screenshot({ path: "/private/tmp/doca-rc6-toolbar.png" });
    console.log(
      "PASS sheet input, top comment, reload, peer mount and unsupported capability gate",
    );
    await p.getByLabel("文档信息与更多操作").click();
    const [xlsx] = await Promise.all([
      p.waitForEvent("download"),
      p.getByRole("button", { name: "下载", exact: true }).click(),
    ]);
    const xlsxBuffer = fs.readFileSync(await xlsx.path());
    assert.equal(xlsxBuffer.subarray(0, 2).toString(), "PK");
    console.log("PASS xlsx download");
    async function importUI(label, name, buffer) {
      for (const close of await p.getByLabel("关闭提示", { exact: true }).all())
        await close.click();
      await p.goto(origin + "/#/home");
      await p.getByLabel("新建个人文档", { exact: true }).click();
      await p.getByRole("button", { name: "导入", exact: true }).click();
      await p
        .getByRole("button", { name: "导入为" + label, exact: true })
        .click();
      await p
        .getByLabel("导入" + label + "文件", { exact: true })
        .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
      await p.waitForURL(/#\/r\//);
      await p.waitForTimeout(1600);
      for (const close of await p.getByLabel("关闭提示", { exact: true }).all())
        await close.click();
    }
    await importUI("在线表格", "roundtrip.xlsx", xlsxBuffer);
    await p.locator(".uos-office-toolbar").waitFor();
    console.log("PASS xlsx import");
    await importUI(
      "在线 Markdown",
      "outline.md",
      Buffer.from("# Title\n\nAlpha Bravo\n\n## Second\n\nBody"),
    );
    await p.getByLabel("展开文档导航", { exact: true }).click();
    await p.getByRole("button", { name: "Second", exact: true }).click();
    console.log("PASS markdown outline");
    const content = p.locator(".cm-content");
    await content.click();
    await p.keyboard.press("Meta+Home");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.down("Shift");
    await p.keyboard.press("End");
    await p.keyboard.up("Shift");
    await p.getByRole("toolbar", { name: "选中文字操作" }).waitFor();
    assert.equal(
      await p
        .locator("#editor-toolbar-slot")
        .getByLabel("评论选中区域", { exact: true })
        .count(),
      0,
    );
    console.log("PASS markdown selection comment");
    await importUI(
      "在线文档",
      "basic.md",
      Buffer.from(
        "# Imported title\n\n**Bold** and text\n\n| A | B |\n| - | - |\n| 1 | 2 |",
      ),
    );
    await p.getByLabel("文档信息与更多操作").click();
    if ((await p.locator(".download-options").getAttribute("open")) === null)
      await p.locator(".download-options > summary").click();
    const [word] = await Promise.all([
      p.waitForEvent("download"),
      p.getByRole("button", { name: "Word（.docx）", exact: true }).click(),
    ]);
    const wordBuffer = fs.readFileSync(await word.path());
    assert.equal(wordBuffer.subarray(0, 2).toString(), "PK");
    console.log("PASS rich Markdown import / Word export");
    await importUI("在线文档", "word.docx", wordBuffer);
    console.log("PASS Word reimport");
    await importUI(
      "在线画板",
      "shape.svg",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#3366ff"/></svg>',
      ),
    );
    await p.locator(".doca-canvas canvas").first().waitFor();
    await p.waitForTimeout(1000);
    const beforeExport = commits;
    for (const format of ["PNG", "SVG"]) {
      await p.getByLabel("文档信息与更多操作").click();
      if ((await p.locator(".download-options").getAttribute("open")) === null)
        await p.locator(".download-options > summary").click();
      const [file] = await Promise.all([
        p.waitForEvent("download"),
        p.getByRole("button", { name: format + " 图片", exact: true }).click(),
      ]);
      assert.ok(fs.statSync(await file.path()).size > 100);
      console.log("PASS canvas", format);
      await p.mouse.click(900, 30); // Close menus outside the editable canvas.
    }
    assert.equal(commits, beforeExport, "Export must not submit content");
    const idle = commits;
    await p.waitForTimeout(60000);
    assert.equal(commits, idle, "Idle must not submit content");
    console.log("PASS export purity and 60 second idle");
    assert.deepEqual(errors, []);
    console.log("PASS OFFICE ACCEPTANCE");
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
