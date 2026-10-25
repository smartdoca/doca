import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { createEditor } from "slate";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { restoreDocument } from "../packages/core/src/modules/collaboration/documents.js";
import { captureRichSelection } from "../apps/web/src/features/comments/rich-selection-anchor.js";

const output = resolve("artifacts/verification/rich-comment-scroll");
const label = process.env.QA_SCROLL_BASELINE === "1" ? "before" : "after";
await mkdir(output, { recursive: true });
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: resolve(output, "storage") } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const owner = {
  ...(await createUser(
    db,
    {
      login: "scrollqa",
      displayName: "Scroll QA",
      password: "isolated-scroll-check",
    },
    { bootstrap: true },
  )),
  admin: 1,
};
const content = createContent(db);
const origin = "http://127.0.0.1:39819";
const app = await createApp(db, {
  origin,
  storage: storageRuntime(),
  ai: { memory: { driver: "sqlite", url: ":memory:" } },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
assert(address && typeof address !== "string");
const web = await createServer({
  configFile: resolve("apps/web/vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: {
    host: "127.0.0.1",
    port: 39819,
    strictPort: true,
    hmr: false,
    proxy: { "/api": { target: `http://127.0.0.1:${address.port}`, ws: true } },
  },
});
await web.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
const errors: string[] = [];
const results: any[] = [];
const page = await context.newPage();
page.setDefaultTimeout(25000);
page.on("pageerror", (error) => errors.push(error.message));
const writes: any[] = [];
page.on("websocket", (socket) =>
  socket.on("framesent", ({ payload }) => {
    try {
      const value = JSON.parse(String(payload));
      if (value.type === "update") writes.push(value);
    } catch {}
  }),
);
const body = (text: string) => ({
  version: 1 as const,
  blocks: [
    { type: "paragraph" as const, children: [{ type: "text" as const, text }] },
  ],
});
const state = (id: string) =>
  db
    .selectFrom("document_states")
    .select(["seq", "checkpoint"])
    .where("resource_id", "=", id)
    .executeTakeFirstOrThrow();
const geometry = () =>
  page.evaluate(() => {
    const source = document.querySelector<HTMLElement>(
      ".ai-document-main .main-scroll",
    )!;
    const panel = document.querySelector<HTMLElement>(
      "aside.content-comments",
    )!;
    const card = panel.querySelector<HTMLElement>("[data-thread-id]");
    const block = document.querySelector<HTMLElement>('[data-block-id="p-1"]');
    const ports = [source, ...source.querySelectorAll<HTMLElement>("*")]
      .filter(
        (el) =>
          el.clientHeight > 100 &&
          el.scrollHeight > el.clientHeight + 1 &&
          /^(auto|scroll)$/.test(getComputedStyle(el).overflowY) &&
          el.getBoundingClientRect().width > 0,
      )
      .map((el) => ({
        className: el.className,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
    return {
      compact: !!document.querySelector(".compact-document"),
      ports,
      panelScroll: panel.scrollTop,
      panelOverflow: getComputedStyle(panel).overflowY,
      sourceScroll: source.scrollTop,
      cardTop: card?.getBoundingClientRect().top,
      blockTop: block?.getBoundingClientRect().top,
    };
  });
const open = async (id: string) => {
  await page.goto(origin + "/#/r/" + id);
  await page.locator(".sk-editable").waitFor();
  await page
    .getByText(/(?:^| · |：|:)已保存到云端$/)
    .last()
    .waitFor({ state: "attached" });
  const toggle = page.getByRole("button", {
    name: "展开内容评论",
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
  await page.locator("aside.content-comments").waitFor();
  await delay(500);
};
try {
  const login = await context.request.post(origin + "/api/v1/auth/login", {
    headers: { origin },
    data: { login: "scrollqa", password: "isolated-scroll-check" },
  });
  assert.equal(login.status(), 200, await login.text());
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Shared scroll QA",
    initialContent: {
      schemaVersion: 2,
      children: Array.from({ length: 95 }, (_, i) => ({
        id: "p-" + i,
        type: "paragraph",
        children: [
          {
            text:
              `Paragraph ${i + 1}: document and comments share one vertical scroll. ` +
              "Synthetic content. ".repeat(5),
          },
        ],
      })),
    },
  });
  const loaded = await restoreDocument(db, doc.id);
  const editor = createEditor();
  editor.children = loaded.runtime.getValue();
  const roots: any[] = [];
  for (const index of [1, 45, 92]) {
    const anchor = captureRichSelection(editor, loaded.runtime, {
      anchor: { path: [index, 0], offset: 0 },
      focus: { path: [index, 0], offset: 12 },
    });
    roots.push(
      await content.comment(
        owner,
        doc.id,
        body("Comment " + index),
        null,
        JSON.stringify(anchor),
      ),
    );
  }
  loaded.destroy();
  await open(doc.id);
  const baseline = await state(doc.id);
  for (const width of [2100, 1600, 1000, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    await delay(350);
    await page.locator(".main-scroll").evaluate((el) => {
      el.scrollTop = 0;
    });
    await delay(100);
    const before = await geometry();
    await page.locator(".main-scroll").evaluate((el) => {
      el.scrollTop = 400;
    });
    await delay(150);
    const after = await geometry();
    const panel = await page.locator("aside.content-comments").boundingBox();
    assert(panel);
    await page.mouse.move(panel.x + panel.width / 2, 450);
    await page.mouse.wheel(0, 350);
    await delay(300);
    const wheel = await geometry();
    results.push({ width, before, after, wheel });
    console.log(JSON.stringify(results.at(-1)));
    await page.screenshot({ path: resolve(output, `${label}-${width}.png`) });
    if (label === "after") {
      assert.deepEqual(
        before.ports.map((p) => p.className),
        ["main-scroll"],
        "one vertical document scrollport",
      );
      assert.equal(after.panelScroll, 0);
      assert.equal(wheel.panelScroll, 0);
      assert(
        wheel.sourceScroll > after.sourceScroll,
        "wheel over comments scrolls document",
      );
      assert(
        Math.abs(
          after.cardTop! -
            before.cardTop! +
            (after.sourceScroll - before.sourceScroll),
        ) < 2,
        "comment follows document",
      );
      assert(
        Math.abs(
          after.blockTop! -
            before.blockTop! +
            (after.sourceScroll - before.sourceScroll),
        ) < 2,
        "text follows same scroll",
      );
    }
  }
  if (label === "after") {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page
      .getByRole("button", { name: "AI 辅助创作", exact: true })
      .click();
    await page.locator(".ai-document-panel").waitFor();
    await delay(400);
    const ai = await geometry();
    results.push({ ai });
    assert.deepEqual(
      ai.ports.map((p) => p.className),
      ["main-scroll"],
    );
    await page.screenshot({ path: resolve(output, "after-ai.png") });
    await open(doc.id);
    const last = page.locator(`[data-thread-id="${roots.at(-1).id}"]`);
    await last.hover();
    await last.getByRole("button", { name: "回复", exact: true }).click();
    const input = last.getByRole("textbox", { name: "评论内容", exact: true });
    await input.waitFor();
    await delay(200);
    const inputBounds = await input.boundingBox();
    assert(
      inputBounds &&
        inputBounds.y >= 100 &&
        inputBounds.y + inputBounds.height <= 1000,
      "reply composer visible",
    );
    await input.fill("Scroll verification draft");
    await page.setViewportSize({ width: 1000, height: 1000 });
    await delay(300);
    assert.equal(await input.inputValue(), "Scroll verification draft");
    await page.locator(".main-scroll").evaluate((el) => {
      el.scrollTop = 0;
    });
    await delay(200);
    const firstNav = page
      .locator(".content-comments > header .comment-navigation button")
      .first();
    await firstNav.click();
    await delay(500);
    await page
      .locator(".content-comments > header .comment-navigation button")
      .last()
      .click();
    await delay(500);
    const navigation = await geometry();
    assert(navigation.sourceScroll > 500);
    assert.equal(navigation.panelScroll, 0);
    results.push({ navigation });
    results.push({ composer: true, draftPreserved: true });
    const empty = await content.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Empty comments QA",
      initialContent: { schemaVersion: 2, children: editor.children },
    });
    await open(empty.id);
    const emptyPorts = await geometry();
    assert.deepEqual(
      emptyPorts.ports.map((p) => p.className),
      ["main-scroll"],
    );
    results.push({ emptyComments: emptyPorts });
    await page.screenshot({
      path: resolve(output, "after-empty-comments.png"),
    });
    await open(doc.id);
    // Tall replies may extend past the text; they remain reachable in the shared page.
    for (let i = 0; i < 28; i++)
      await content.comment(
        owner,
        doc.id,
        body("Long reply " + i + " " + "Synthetic text ".repeat(8)),
        roots[2].id,
      );
    await page.reload();
    await open(doc.id);
    const end = page
      .locator(`[data-thread-id="${roots[2].id}"] .comment-message`)
      .last();
    await end.hover();
    assert(await end.isVisible());
    const tall = await geometry();
    assert.deepEqual(
      tall.ports.map((p) => p.className),
      ["main-scroll"],
    );
    results.push({ tallComments: tall });
    await page.screenshot({ path: resolve(output, "after-tall-comments.png") });
    console.log("Checking idle document for 61 seconds");
    await delay(61000);
    assert.deepEqual(await state(doc.id), baseline);
    assert.equal(writes.length, 0);
    assert.deepEqual(errors, []);
  }
  await writeFile(
    resolve(output, `${label}-results.json`),
    JSON.stringify({ results, errors, writes }, null, 2),
  );
  console.log("PASS " + label);
} catch (error) {
  await page
    .screenshot({ path: resolve(output, `${label}-failure.png`) })
    .catch(() => {});
  await writeFile(
    resolve(output, `${label}-failure.json`),
    JSON.stringify(
      {
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
        results,
        geometry: await geometry().catch(() => null),
        errors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await web.close();
  await app.close();
  await db.destroy();
}
