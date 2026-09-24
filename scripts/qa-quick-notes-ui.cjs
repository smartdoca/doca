if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated QA only");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const origin = "http://127.0.0.1:39252";
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
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
      { login: "notesqa", password: "isolated-notes-qa-2026" },
      "POST",
    );
    const page = await ctx.newPage(),
      errors = [],
      writes = [],
      updates = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (
        /\/quick-notes\/[a-f0-9-]{36}$/.test(r.url()) &&
        ["PATCH", "PUT"].includes(r.method())
      )
        writes.push(r.postDataJSON());
    });
    page.on("websocket", (ws) =>
      ws.on("framesent", ({ payload }) => {
        try {
          const v = JSON.parse(String(payload));
          if (v.type === "update") updates.push(v);
        } catch {}
      }),
    );
    const originalIds = (await request("/quick-notes")).items.map((n) => n.id);
    await page.goto(origin + "/#/notes");
    await page.getByRole("button", { name: "随手记", exact: true }).waitFor();
    const nav = page.locator(".sidebar nav button");
    const labels = await nav.allTextContents();
    assert.equal(labels[labels.indexOf("AI 助手") + 1], "随手记");
    const editor = page.getByRole("textbox", { name: "随手记正文" });
    await editor.waitFor();
    const left = await page.locator(".note-writing-pane").boundingBox();
    const right = await page.locator(".note-browsing-pane").boundingBox();
    assert.ok(
      right.x >= left.x + left.width - 1,
      "desktop uses left/right panes",
    );
    assert.equal(
      await page.getByRole("button", { name: "加粗", exact: true }).count(),
      0,
      "formatting starts collapsed",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "记下", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "文字格式", exact: true }).click();
    await editor.click();
    await page.keyboard.insertText("想法：做一个轻量的私人记录入口。");
    await page.getByRole("button", { name: "加粗", exact: true }).click();
    await page.keyboard.insertText("重点是随手记。");
    await page.getByRole("button", { name: "加粗", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "待办清单", exact: true }).click();
    await page.keyboard.insertText("下周评审");
    await page.getByLabel("添加附件", { exact: true }).setInputFiles({
      name: "评审.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("隔离附件内容"),
    });
    await page
      .locator(".note-compose-card")
      .getByRole("link", { name: /评审.txt/ })
      .waitFor();
    await page.getByRole("button", { name: /^记下/ }).click();
    await page.waitForFunction(async (ids) => {
      const response = await fetch("/api/v1/quick-notes");
      return (await response.json()).items.some((n) => !ids.includes(n.id));
    }, originalIds);
    await page.locator(".note-card").first().waitFor();
    const note = (await request("/quick-notes")).items[0];
    const card = page.locator(`[data-note-id="${note.id}"]`);
    await card.waitFor();
    assert.ok(note.content.some((n) => n.children.some((c) => c.bold)));
    assert.ok(note.content.some((n) => n.list === "checkbox"));
    assert.equal(note.assets.length, 1);
    const idleWrites = writes.length;
    await editor.click();
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(1100);
    assert.equal(writes.length, idleWrites);
    console.log(
      "PASS create, marks, checklist, attachment, selection makes no save",
    );

    await card
      .getByRole("button", { name: "编辑", exact: true })
      .first()
      .click();
    const dialog = card.getByRole("region", { name: "编辑随手记" });
    const edit = dialog.getByRole("textbox", { name: "随手记正文" });
    await edit.waitFor();
    assert.equal(
      await page.getByRole("dialog", { name: "编辑随手记" }).count(),
      0,
      "editing stays in its card",
    );
    assert.equal(
      await card.locator(".note-body").count(),
      0,
      "card body is replaced by editor",
    );
    await edit.locator(".sk-block-frame").first().hover();
    assert.equal(
      await edit.locator(".sk-block-gutter").first().isVisible(),
      false,
      "line controls stay hidden on hover",
    );
    assert.equal(
      await page
        .locator(".note-compose-card .sk-block-gutter")
        .first()
        .isVisible(),
      false,
      "composer line controls stay hidden",
    );
    await edit.locator("[data-slate-string]").first().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("，周二上午。");

    await page.waitForFunction(
      async ({ origin, id }) => {
        const r = await fetch(origin + "/api/v1/quick-notes/" + id);
        return (await r.json()).version >= 2;
      },
      { origin, id: note.id },
    );
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.reload();
    await page.locator(".note-card").first().waitFor();
    assert.match(await card.innerText(), /周二上午/);
    console.log("PASS edit auto-save and reload");

    await card
      .getByRole("button", { name: "编辑", exact: true })
      .first()
      .click();
    const before = await request("/quick-notes/" + note.id);
    const remote = structuredClone(before.content);
    remote[0].children.push({ text: " 另一台设备的修改" });
    await request(
      "/quick-notes/" + note.id,
      {
        content: remote,
        assetIds: before.assets.map((a) => a.id),
        version: before.version,
      },
      "PATCH",
    );
    await edit.locator("[data-slate-string]").first().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" 本地待合并");
    await dialog
      .getByRole("button", { name: "查看最新版本", exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "查看最新版本", exact: true })
      .click();
    await dialog.locator(".note-remote").waitFor();
    assert.match(
      await dialog.locator(".note-remote").innerText(),
      /另一台设备的修改/,
    );
    assert.match(
      await dialog.getByRole("textbox", { name: "随手记正文" }).innerText(),
      /本地待合并/,
    );
    await dialog
      .getByRole("button", { name: "使用云端版本", exact: true })
      .click();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    console.log(
      "PASS same-account conflict keeps local draft and offers merge",
    );

    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await page.locator(".note-card").first().waitFor();
    await card
      .getByRole("button", { name: "整理", exact: true })
      .first()
      .click();
    const ai = page.getByRole("dialog", { name: "整理成文档" });
    await ai.getByRole("button", { name: "方案草稿", exact: true }).click();
    await ai.getByRole("button", { name: "开始整理", exact: true }).click();
    await ai.getByRole("button", { name: "保存为文档", exact: true }).waitFor();
    await ai.getByRole("button", { name: "修改正文", exact: true }).click();
    await ai
      .getByRole("textbox", { name: "整理结果正文" })
      .fill("# 私人功能方案\n\n保留轻量记录与图片附件。");
    await ai.getByRole("button", { name: "查看预览", exact: true }).click();
    await page.screenshot({ path: "/tmp/doca-quick-notes-preview.png" });
    await ai.getByRole("button", { name: "保存为文档", exact: true }).click();
    const docLink = ai.getByRole("link", { name: "打开文档" });
    await docLink.waitFor();
    const docId = (await docLink.getAttribute("href")).split("/r/")[1];
    const doc = await request("/resources/" + docId);
    assert.equal(doc.resource.visibility, "invited");
    assert.equal(doc.resource.title, "私人功能方案");
    await ai.getByRole("button", { name: "关闭", exact: true }).click();
    console.log("PASS AI preview edit, native document and private access");

    await card
      .getByRole("button", { name: "删除记录", exact: true })
      .first()
      .click();
    const deletion = page.getByRole("dialog", { name: "删除随手记" });
    await deletion.waitFor();
    assert.equal(
      (await request("/quick-notes/" + note.id)).deleted_at,
      null,
      "opening confirmation does not delete",
    );
    await deletion.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(
      (await request("/quick-notes/" + note.id)).deleted_at,
      null,
      "cancel keeps the card",
    );
    await card.getByRole("button", { name: "删除记录", exact: true }).click();
    await deletion
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await deletion.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "已删除", exact: true }).click();
    await page
      .getByRole("button", { name: "恢复", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "全部记录", exact: true }).click();
    await page.locator(".note-card").first().waitFor();
    const batch = [];
    for (let i = 0; i < 3; i++) {
      batch.push(
        await request(
          "/quick-notes/" + crypto.randomUUID(),
          {
            content: [
              {
                id: crypto.randomUUID(),
                type: "paragraph",
                children: [{ text: `批量验证 ${i + 1}` }],
              },
            ],
            assetIds: [],
          },
          "PUT",
        ),
      );
    }
    const batchCard = (n) => page.locator(`[data-note-id="${n.id}"]`);
    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await batchCard(batch[0]).waitFor();
    assert.equal(
      await batchCard(batch[0]).getByRole("checkbox").count(),
      0,
      "checkboxes appear only in batch mode",
    );
    await page.getByRole("button", { name: "批量选择", exact: true }).click();
    for (const n of batch.slice(0, 2))
      await batchCard(n).getByRole("checkbox").check();
    await page.getByRole("button", { name: "删除所选", exact: true }).click();
    assert.match(await deletion.innerText(), /选中的 2 条/);
    await deletion.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(
      await batchCard(batch[0]).getByRole("checkbox").isChecked(),
      true,
    );
    // Another session edits one selected card: only the unchanged card may be deleted.
    await request(
      "/quick-notes/" + batch[1].id,
      {
        version: batch[1].version,
        content: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            children: [{ text: "另一台设备更新" }],
          },
        ],
        assetIds: [],
      },
      "PATCH",
    );
    await page.getByRole("button", { name: "删除所选", exact: true }).click();
    await deletion
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await deletion.getByRole("alert").waitFor();
    assert.match(
      await deletion.getByRole("alert").innerText(),
      /已删除 1 条，1 条未能删除/,
    );
    assert.ok((await request("/quick-notes/" + batch[0].id)).deleted_at);
    assert.equal(
      (await request("/quick-notes/" + batch[1].id)).deleted_at,
      null,
    );
    await deletion.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await batchCard(batch[1]).waitFor();
    await page.getByRole("button", { name: "批量选择", exact: true }).click();
    for (const n of batch.slice(1))
      await batchCard(n).getByRole("checkbox").check();
    await page.getByRole("button", { name: "删除所选", exact: true }).click();
    await deletion
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await deletion.waitFor({ state: "hidden" });
    for (const n of batch.slice(1))
      assert.ok((await request("/quick-notes/" + n.id)).deleted_at);
    console.log(
      "PASS single deletion confirmation/cancel, batch selection, batch confirmation, partial conflict and batch deletion",
    );
    await page.screenshot({ path: "/tmp/doca-quick-notes-desktop.png" });
    assert.equal(
      updates.length,
      0,
      "notes never publish collaboration updates",
    );
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
      "PASS trash restore, mobile layout, no collaboration writes or browser errors",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
