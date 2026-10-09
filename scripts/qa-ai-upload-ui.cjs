if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Isolated upload QA only: set DOCA_QA_ISOLATED=1");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const info = require("../.cache/qa-ai-upload-fixture.json");
assert.equal(info.origin, "http://127.0.0.1:39351");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1050 },
  });
  const localFolder = await fs.mkdtemp(path.join(os.tmpdir(), "doca-local-folder-qa-"));
  await fs.mkdir(path.join(localFolder, "人物参考"));
  await fs.writeFile(path.join(localFolder, "book.txt"), "LOCAL_BOOK_MARKER");
  await fs.writeFile(path.join(localFolder, "人物参考", "mom.txt"), "LOCAL_MOM_MARKER");
  const res = await context.request.post(info.origin + "/api/v1/auth/login", {
    headers: { origin: info.origin },
    data: { login: "uploadqa", password: "isolated-upload-qa-2026" },
  });
  assert.equal(res.status(), 200, await res.text());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const input = page.locator('.ai-composer [contenteditable="true"]');
  const go = async (id) => {
    await page.goto(info.origin + "/#/ai?session=" + id);
    await input.waitFor();
  };
  const expectText = async (text) => {
    await page.waitForFunction(
      (text) =>
        document.querySelector('.ai-composer [contenteditable="true"]')
          ?.textContent === text,
      text,
    );
  };
  try {
    await go(info.sessions[0]);
    await input.fill("草稿 A：妈妈讲故事，保留书页构图");
    await page.reload();
    await input.waitFor();
    await expectText("草稿 A：妈妈讲故事，保留书页构图");
    await go(info.sessions[1]);
    await expectText("");
    await input.fill("草稿 B：稍后继续");
    await go(info.sessions[0]);
    await expectText("草稿 A：妈妈讲故事，保留书页构图");
    console.log("PASS drafts survive reload and session switching");
    await page
      .getByRole("button", { name: "上传文件或图片", exact: true })
      .click();
    assert.equal(await page.locator(".file-source-choice").count(), 2);
    assert.equal(await page.locator(".file-source-extras button").count(), 1);
    await page.screenshot({ path: "/tmp/doca-ai-upload-sources.png" });
    await page
      .locator(".file-source-choice")
      .first()
      .locator("button")
      .first()
      .click();
    let picker = page.locator(".folder-file-picker");
    await picker.waitFor();
    await picker.getByRole("button", { name: /sample-one.txt/ }).click();
    await picker.getByRole("button", { name: /sample-two.txt/ }).click();
    await picker.locator("footer button.primary").click();
    await page
      .waitForFunction(() =>
        document
          .querySelector(".ai-upload-list")
          ?.textContent.includes("sample-two"),
      )
      .catch(async () => {
        assert.ok(
          (await page.locator(".ai-upload-list").innerText()).includes(
            "sample-one",
          ),
        );
        assert.ok(
          (await page.locator(".ai-upload-list").innerText()).includes(
            "sample-two",
          ),
        );
      });
    console.log("PASS two main sources and multiple stored file selection");
    await page
      .getByRole("button", { name: "上传文件或图片", exact: true })
      .click();
    await page
      .locator(".file-source-choice")
      .first()
      .locator("button")
      .first()
      .click();
    picker = page.locator(".folder-file-picker");
    await picker.waitFor();
    await picker.getByRole("button", { name: /故事书素材/ }).click();
    await picker.locator("footer button.primary").click();
    const folder = page.locator(".ai-folder-preview-trigger");
    await folder.waitFor();
    await folder.click();
    await page
      .locator(".ant-modal")
      .getByText("book-pages.txt", { exact: true })
      .waitFor();
    await page
      .locator(".ant-modal")
      .getByRole("button", { name: "妈妈六视图", exact: true })
      .click();
    await page
      .locator(".ant-modal")
      .getByText("mom.txt", { exact: true })
      .waitFor();
    await page.locator(".ant-modal-close").click();
    await page.reload();
    await input.waitFor();
    await expectText("草稿 A：妈妈讲故事，保留书页构图");
    assert.ok(
      (await page.locator(".ai-upload-list").innerText()).includes(
        "sample-two",
      ),
    );
    assert.equal(await folder.innerText(), "故事书素材");
    console.log(
      "PASS folder preview, nested files and uploaded attachment/folder draft restoration",
    );
    await page.screenshot({ path: "/tmp/doca-ai-folder-draft.png" });
    // Failed sends preserve the whole draft.
    await page.route("**/api/v1/ai/sessions/*/messages", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Injected send failure" }),
      }),
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("Injected send failure", { exact: true }).first().waitFor();
    await page.reload();
    await input.waitFor();
    await expectText("草稿 A：妈妈讲故事，保留书页构图");
    await page.unroute("**/api/v1/ai/sessions/*/messages");
    assert.equal(await folder.count(), 1);
    console.log("PASS failed send retains draft");
    let sentResponse;
    const responseHeld = new Promise(resolve => { sentResponse = resolve; });
    await page.route("**/api/v1/ai/sessions/*/messages", async route => {
      const response = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, 1500));
      await route.fulfill({ response });
      sentResponse();
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.evaluate(id => { location.hash = "/ai?session=" + id; }, info.sessions[1]);
    await expectText("草稿 B：稍后继续");
    await responseHeld;
    await expectText("草稿 B：稍后继续");
    await page.unroute("**/api/v1/ai/sessions/*/messages");
    await go(info.sessions[0]);
    await expectText("");
    console.log("PASS an in-flight send clears its own draft after switching sessions");

    await page.locator(".ai-sent-target-folder").last().waitFor();
    await page.locator(".ai-sent-target-folder").last().click();
    await page
      .locator(".ant-modal")
      .getByText("book-pages.txt", { exact: true })
      .waitFor();
    await page.locator(".ant-modal-close").click();
    console.log("PASS sent folder reference opens its contents");
    await page.screenshot({ path: "/tmp/doca-ai-sent-folder.png" });
    await go(info.sessions[1]);
    await expectText("草稿 B：稍后继续");
    await page
      .getByRole("button", { name: "上传文件或图片", exact: true })
      .click();
    const chooseFiles = page.waitForEvent("filechooser");
    await page
      .locator(".file-source-choice")
      .nth(1)
      .locator("button")
      .first()
      .click();
    await (
      await chooseFiles
    ).setFiles(
      Array.from({ length: 12 }, (_, i) => ({
        name: `view-${i + 1}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from(`VIEW_${i + 1}`),
      })),
    );
    await page.getByText("view-12.txt", {exact:true}).waitFor();
    await page.evaluate(id => { location.hash = "/ai?session=" + id; }, info.sessions[0]);
    await expectText("");
    await page.evaluate(id => { location.hash = "/ai?session=" + id; }, info.sessions[1]);
    await expectText("草稿 B：稍后继续");
    await page.getByText("view-12.txt", {exact:true}).waitFor();
    console.log("PASS selected local files stay in memory across session switching");
    await page.reload();
    await input.waitFor();
    await expectText("草稿 B：稍后继续");
    assert.equal(await page.getByText("view-12.txt", {exact:true}).count(), 0);
    console.log(
      "PASS reload retains text while local files are never uploaded before sending",
    );
    await page.getByRole("button", {name:"上传文件或图片",exact:true}).click();
    const chooseFolder = page.waitForEvent("filechooser");
    await page.locator(".file-source-choice").nth(1).locator(".file-source-subaction").click();
    await (await chooseFolder).setFiles(localFolder);
    const localReference = page.locator(".ai-folder-preview-trigger").filter({hasText:path.basename(localFolder)});
    await localReference.waitFor({timeout:30000});
    await localReference.click();
    await page.locator(".ant-modal").getByText("book.txt",{exact:true}).waitFor();
    await page.locator(".ant-modal").getByRole("button",{name:"人物参考",exact:true}).click();
    await page.locator(".ant-modal").getByText("mom.txt",{exact:true}).waitFor();
    await page.locator(".ant-modal-close").click();
    await page.reload();await input.waitFor();await localReference.waitFor();
    console.log("PASS local folder selection preserves hierarchy and a clickable draft reference after reload");
    // Closing and reopening a page retains unsent text in the same browser profile.
    await page.close();
    const reopened = await context.newPage();
    reopened.on("pageerror", (e) => errors.push(e.message));
    await reopened.goto(info.origin + "/#/ai?session=" + info.sessions[1]);
    await reopened.locator('.ai-composer [contenteditable="true"]').waitFor();
    assert.equal(
      await reopened
        .locator('.ai-composer [contenteditable="true"]')
        .textContent(),
      "草稿 B：稍后继续",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS successful send clears only its own draft; closing/reopening restores the other session",
    );
  } catch (e) {
    if (!page.isClosed()) {
      await page.screenshot({ path: "/tmp/doca-ai-ui-failure.png" });
      console.log((await page.locator("body").innerText()).slice(-2000));
    }
    throw e;
  } finally {
    await browser.close();
    await fs.rm(localFolder,{recursive:true,force:true});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
