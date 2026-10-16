// Real host + browser acceptance using only synthetic accounts and in-memory data.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { chromium, type Page } from "playwright-core";
import {
  createDocuments,
  restoreDocument,
  b64,
} from "../packages/core/src/modules/collaboration/documents.js";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";

const root = await mkdtemp(join(tmpdir(), "doca-editor-upgrade-"));
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
await createUser(
  db,
  {
    login: "editorupgrade",
    displayName: "Editor upgrade QA",
    password: "isolated-editor-upgrade-2026",
  },
  { bootstrap: true },
);
const origin = "http://127.0.0.1:39418";
const app = await createApp(db, {
  origin,
  storage: { ...storageRuntime(), root },
  ai: { memory: { driver: "sqlite", url: ":memory:" } },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
assert(address && typeof address !== "string");
const web = await createServer({
  configFile: resolve("apps/web/vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 39418,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${address.port}`, ws: true } },
  },
});
const output = resolve(
  process.env.DOCA_QA_OUTPUT ?? "artifacts/slate-workspace-upgrade-2026-10-16",
);
await mkdir(output, { recursive: true });
const checks: string[] = [],
  errors: string[] = [];
const pass = (label: string) => {
  checks.push(label);
  console.log("PASS " + label);
};
const until = async (predicate: () => Promise<boolean>, label: string) => {
  for (let n = 0; n < 100; n++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw Error("Timed out: " + label);
};
let diagnosticPage: Page | undefined;
await web.listen();
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const request = async (path: string, data?: unknown, method = "GET") => {
    const response = await context.request.fetch(origin + "/api/v1" + path, {
      method,
      headers: { origin },
      data,
    });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const preview = async (id: string) => {
    const data = await request(`/ai/resources/${id}/preview`);
    const state = await db
      .selectFrom("document_states")
      .select("seq")
      .where("resource_id", "=", id)
      .executeTakeFirstOrThrow();
    return { ...data, seq: state.seq };
  };
  await request(
    "/auth/login",
    { login: "editorupgrade", password: "isolated-editor-upgrade-2026" },
    "POST",
  );
  const watch = async () => {
    const page = await context.newPage(),
      updates: unknown[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.type === "update") updates.push(frame);
        } catch {}
      }),
    );
    return { page, updates };
  };
  const rich = await request(
    "/resources",
    {
      title: "Slate workspace upgrade QA",
      kind: "document",
      format: "rich_text",
    },
    "POST",
  );
  const owner = {
    ...(await db
      .selectFrom("users")
      .selectAll()
      .where("login", "=", "editorupgrade")
      .executeTakeFirstOrThrow()),
    admin: 1,
  };
  const documents = createDocuments(db),
    protocol = { codec: "slate-kit", schemaVersion: 3, protocolVersion: 1 };
  const initial = await documents.exchange(owner, rich.id, protocol);
  const native = await restoreDocument(db, rich.id);
  try {
    const update = native.runtime.execute({
      type: "insertBlock",
      block: {
        id: "retained-mind-map",
        type: "mindmap",
        children: [{ text: "" }],
        previewVersion: 5,
        previewSvg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="180"><text y="30">old preview</text></svg>',
        mindData: {
          direction: 1,
          nodeData: {
            id: "root",
            topic: "保留旧图主题",
            children: [{ id: "old-child", topic: "原有分支", side: "right" }],
          },
        },
      },
    });
    await documents.exchange(owner, rich.id, {
      ...protocol,
      epochId: initial.epochId,
      messageId: "isolated-native-mind-map",
      update: b64(update),
    });
  } finally {
    native.destroy();
  }
  const before = await preview(rich.id);
  const a = await watch(),
    peer = await watch();
  diagnosticPage = a.page;
  await a.page.goto(origin + "/#/r/" + rich.id);
  await peer.page.goto(origin + "/#/r/" + rich.id);
  const editor = a.page.locator('.sk-editable[contenteditable="true"]');
  await editor.waitFor();
  await peer.page.locator(".sk-editable").waitFor();
  const figure = a.page.locator(".sk-block-mindmap .sk-mind-figure");
  await figure.locator("img").waitFor();
  const originalCheckpoint = await db
    .selectFrom("document_states")
    .selectAll()
    .where("resource_id", "=", rich.id)
    .executeTakeFirstOrThrow();
  await editor.locator(".sk-block-paragraph").first().click();
  await figure.locator("img").click();
  assert.equal(await a.page.locator(".sk-media-lightbox").count(), 0);
  await figure.locator("img").click();
  await a.page.locator(".sk-media-lightbox").waitFor();
  await a.page.keyboard.press("Escape");
  await a.page.locator(".sk-media-lightbox").waitFor({ state: "detached" });
  await figure
    .getByRole("button", { name: "编辑思维导图", exact: true })
    .click();
  const dialog = a.page.getByRole("dialog", {
    name: "思维导图编辑器",
    exact: true,
  });
  await dialog.waitFor();
  await dialog
    .getByRole("button", { name: "关闭思维导图编辑器", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual((await preview(rich.id)).value, before.value);
  assert.deepEqual(
    await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", rich.id)
      .executeTakeFirstOrThrow(),
    originalCheckpoint,
  );
  assert.equal(a.updates.length, 0);
  assert.equal(peer.updates.length, 0);
  pass(
    "old version-5 preview regenerates in view state; selection, second-click preview and workspace open/close preserve original checkpoint and zero commits",
  );

  await figure
    .getByRole("button", { name: "编辑思维导图", exact: true })
    .click();
  await dialog.getByRole("button", { name: "向右逻辑图", exact: true }).click();
  await dialog.getByRole("button", { name: "海洋", exact: true }).click();
  await dialog.getByRole("button", { name: "点阵", exact: true }).click();
  await dialog.getByRole("tab", { name: "样式", exact: true }).click();
  await dialog.getByLabel("字号", { exact: true }).selectOption("28");
  await dialog.getByRole("button", { name: "加粗", exact: true }).click();
  await dialog.getByRole("button", { name: /下划线/ }).click();
  await dialog.getByRole("button", { name: "添加子级", exact: true }).click();
  const draft = dialog.locator("textarea");
  await draft.fill("新增中文分支");
  await draft.press("Enter");
  await dialog
    .getByRole("button", { name: "关闭思维导图编辑器", exact: true })
    .click();
  const confirm = dialog.getByRole("dialog", {
    name: "保存对思维导图的更改？",
    exact: true,
  });
  await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(
    (await preview(rich.id)).seq,
    before.seq,
    "unsaved native draft committed early",
  );
  await dialog.getByRole("button", { name: "大纲", exact: true }).click();
  await dialog
    .getByRole("tree", { name: "大纲", exact: true })
    .getByText("新增中文分支", { exact: true })
    .waitFor();
  await a.page.screenshot({ path: join(output, "mindmap-outline.png") });
  await dialog
    .getByRole("button", { name: "保存并返回文档", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  await until(
    async () => (await preview(rich.id)).seq > before.seq,
    "durable mind-map save",
  );
  await a.page
    .getByText("已保存到云端", { exact: true })
    .waitFor({ state: "attached" });
  const after = await preview(rich.id),
    block = after.value.find((node: any) => node.id === "retained-mind-map");
  assert.equal(block.previewVersion, 6);
  assert.equal(block.mindData.structure, "right");
  assert.equal(block.mindData.theme, "ocean");
  assert.equal(block.mindData.background, "dots");
  assert.equal(block.mindData.direction, 1);
  assert.equal(block.mindData.nodeData.id, "root");
  assert.equal(block.mindData.nodeData.fontSize, 28);
  assert.equal(block.mindData.nodeData.bold, true);
  assert.equal(block.mindData.nodeData.style, "underline");
  assert(
    block.mindData.nodeData.children.some(
      (node: any) => node.id === "old-child" && node.topic === "原有分支",
    ),
  );
  assert(
    block.mindData.nodeData.children.some(
      (node: any) => node.topic === "新增中文分支",
    ),
  );
  pass(
    "native settings, typography, old IDs and new topics save through durable ACK; unsaved close confirmation retains the draft",
  );
  await peer.page
    .locator(".sk-block-mindmap")
    .getByRole("button", { name: "编辑思维导图", exact: true })
    .click();
  const peerDialog = peer.page.getByRole("dialog", {
    name: "思维导图编辑器",
    exact: true,
  });
  await peerDialog.getByRole("button", { name: "大纲", exact: true }).click();
  await peerDialog
    .getByRole("tree")
    .getByText("新增中文分支", { exact: true })
    .waitFor();
  await peerDialog
    .getByRole("button", { name: "关闭思维导图编辑器", exact: true })
    .click();
  assert.equal(peer.updates.length, 0);
  await a.page.reload();
  await editor.waitFor();
  assert.deepEqual((await preview(rich.id)).value, after.value);
  pass(
    "same-account peer receives new mind-map fields without echo; reload preserves the complete saved model",
  );

  await figure
    .getByRole("button", { name: "编辑思维导图", exact: true })
    .click();
  const downloadPromise = a.page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出 SVG", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(join(output, "mindmap.svg"));
  await a.page.screenshot({ path: join(output, "mindmap-workspace.png") });
  await dialog
    .getByRole("button", { name: "关闭思维导图编辑器", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  const counts = [a.updates.length, peer.updates.length];
  await a.page.getByRole("combobox", { name: "文档模式", exact: true }).click();
  await a.page.getByRole("option", { name: "阅读", exact: true }).click();
  assert.equal(
    await figure
      .getByRole("button", { name: "编辑思维导图", exact: true })
      .isVisible(),
    false,
  );
  await a.page.setViewportSize({ width: 1440, height: 900 });
  await figure.locator("img").click();
  await a.page.locator(".sk-media-lightbox").waitFor();
  await a.page.keyboard.press("Escape");
  for (let n = 0; n < 2; n++) {
    await delay(30_000);
    console.log("Idle observation " + (n + 1) * 30 + " seconds");
  }
  assert.deepEqual([a.updates.length, peer.updates.length], counts);
  assert.equal((await preview(rich.id)).seq, after.seq);
  assert.deepEqual((await preview(rich.id)).value, after.value);
  assert.deepEqual(errors, []);
  pass(
    "SVG export, readonly preview, selection, resize and 60-second idle produce zero writes or console errors",
  );
  await writeFile(
    join(output, "browser.json"),
    JSON.stringify(
      { result: "passed", checks, errors, idleSeconds: 60 },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await diagnosticPage
    ?.screenshot({ path: join(output, "browser-failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    join(output, "browser.json"),
    JSON.stringify(
      { result: "failed", checks, errors, failure: String(error) },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
  await web.close();
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
}
