// Real settings page and HTTP services, isolated SQLite/browser storage, synthetic content only.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
const output = resolve(
  process.argv[2] ?? "artifacts/verification/clipper-destination-tree/browser",
);
await mkdir(output, { recursive: true });
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: join(output, "objects") } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const socket = createServer();
await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((done) => socket.close(() => done()));
const origin = `http://127.0.0.1:${port}`;
const db = await openDatabase({
  driver: "sqlite",
  path: join(output, "fixture.sqlite"),
});
const password = "isolated-destination-tree-password";
const actor = {
  ...(await createUser(
    db,
    { login: "treeqa", displayName: "目录验收", password },
    { bootstrap: true },
  )),
  admin: 1,
};
const content = createContent(db);
const library = await content.create(actor, {
  kind: "library",
  format: "rich_text",
  title: "现场维护知识库",
});
const parent = await content.create(actor, {
  kind: "document",
  format: "markdown",
  title: "设备资料",
  libraryId: library.id,
});
const child = await content.create(actor, {
  kind: "document",
  format: "markdown",
  title: "启动排查",
  libraryId: library.id,
  parentId: parent.id,
});
const leaf = await content.create(actor, {
  kind: "document",
  format: "markdown",
  title: "接线检查",
  libraryId: library.id,
  parentId: child.id,
});
for (let index = 0; index < 101; index++)
  await content.create(actor, {
    kind: "library",
    format: "rich_text",
    title: `资料库 ${index.toString().padStart(3, "0")}`,
  });
for (let index = 0; index < 105; index++)
  await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: `最近文档 ${index}`,
  });
const app = await createApp(db, {
  origin,
  staticDirectory: resolve("apps/web/dist"),
  storage: storageRuntime(),
  ai: { memory: { driver: "sqlite", url: ":memory:" } },
});
await app.listen({ host: "127.0.0.1", port });
const errors: string[] = [];
let context:
  Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
let page: Page | undefined;
const input = {
  name: "网页保存",
  enabled: true,
  isDefault: true,
  strategy: "create",
  libraryId: null,
  parentId: null,
  targetId: null,
  titleTemplate: "{title}",
  aiInstruction: "",
};
let profile: any;
try {
  const zoomExtension = join(output, "zoom-helper");
  await mkdir(zoomExtension);
  await writeFile(
    join(zoomExtension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Isolated QA zoom",
      version: "1.0.0",
      permissions: ["tabs"],
      background: { service_worker: "background.js" },
    }),
  );
  await writeFile(
    join(zoomExtension, "background.js"),
    "chrome.runtime.onInstalled.addListener(() => {});",
  );
  context = await chromium.launchPersistentContext(
    join(output, "browser-profile"),
    {
      executablePath: chromium.executablePath(),
      headless: true,
      viewport: { width: 1280, height: 1000 },
      args: [
        `--disable-extensions-except=${zoomExtension}`,
        `--load-extension=${zoomExtension}`,
      ],
    },
  );
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  const login = await page.request.post(origin + "/api/v1/auth/login", {
    headers: { origin },
    data: { login: "treeqa", password },
  });
  assert(login.ok(), await login.text());
  const created = await page.request.post(
    origin + "/api/v1/me/browser-clipper/profiles",
    { headers: { origin }, data: input },
  );
  assert(created.ok(), await created.text());
  profile = await created.json();
  const mixed = await page.request.get(
    origin + "/api/v1/me/browser-clipper/destinations",
  );
  assert(
    !(await mixed.json()).items.some((item: any) => item.kind === "library"),
    "Fixture reproduces the old mixed-page problem",
  );
  await page.goto(origin + "/#/browser-assistant");
  await page.locator(".clipper-settings").waitFor();
  const dialog = () => page!.getByRole("dialog", { name: "编辑", exact: true });
  const tree = () => dialog().locator(".clipper-destination");
  async function open() {
    const outline = profile.libraryId
      ? page!.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/v1/resources" &&
            url.searchParams.get("libraryId") === profile.libraryId &&
            url.searchParams.get("tree") === "true"
          );
        })
      : null;
    await page!.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog().waitFor();
    await tree().getByRole("tree").waitFor();
    await tree().getByRole("status").waitFor({ state: "detached" });
    const response = await outline;
    if (!response || response.ok())
      await tree().locator(".ant-tree-node-selected").waitFor();
    await page!.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  }
  async function scrollToTitle(name: string) {
    const node = tree()
      .locator(".ant-tree-title")
      .getByText(name, { exact: true });
    const holder = tree().locator(".ant-tree-list-holder");
    await holder.evaluate(async (element) => {
      element.scrollTop = 0;
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    });
    for (let index = 0; index < 80; index++) {
      if (
        (await node.count()) &&
        (await node.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const viewport = element
            .closest(".ant-tree-list-holder")!
            .getBoundingClientRect();
          return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
        }))
      )
        return node;
      const moved = await holder.evaluate(async (element) => {
        const previous = element.scrollTop;
        element.scrollTop += 210;
        await new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
        return element.scrollTop !== previous;
      });
      if (!moved) break;
    }
    throw Error("Tree title not found: " + name);
  }
  async function select(name: string) {
    await (await scrollToTitle(name)).click();
    await tree()
      .locator(".ant-tree-node-selected")
      .getByText(name, { exact: true })
      .waitFor();
    await page!.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  }
  async function readProfile() {
    const response = await page!.request.get(
      origin + "/api/v1/me/browser-clipper/profiles",
    );
    return (await response.json()).items.find(
      (item: any) => item.id === profile.id,
    );
  }
  async function save(expected: {
    libraryId: string | null;
    parentId: string | null;
  }) {
    await dialog()
      .getByRole("button", { name: "保存方案", exact: true })
      .click();
    await dialog().waitFor({ state: "detached" });
    profile = await readProfile();
    assert.equal(profile.libraryId, expected.libraryId);
    assert.equal(profile.parentId, expected.parentId);
    await page!.reload();
    await page!.locator(".clipper-settings").waitFor();
  }
  await open();
  await select("个人文档");
  await save({ libraryId: null, parentId: null });
  await open();
  await tree().getByRole("button", { name: "加载更多知识库" }).click();
  await select(library.title);
  await save({ libraryId: library.id, parentId: null });
  await open();
  // Hydrate and expand a saved library which is beyond the first 100 libraries.
  await select(parent.title);
  await select(child.title);
  await select(leaf.title);
  await tree().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "tree-desktop.png") });
  let rejectedSave = false;
  await page.route("**/api/v1/me/browser-clipper/profiles/*", async (route) => {
    if (!rejectedSave && route.request().method() === "PUT") {
      rejectedSave = true;
      await route.fulfill({
        status: 409,
        json: { message: "clipper_profile_changed" },
      });
    } else await route.continue();
  });
  await dialog().getByRole("button", { name: "保存方案", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "方案已修改" }).waitFor();
  assert(await dialog().isVisible());
  assert(
    await tree()
      .locator(".ant-tree-node-selected")
      .getByText(leaf.title, { exact: true })
      .count(),
  );
  await page.screenshot({
    path: join(output, "failed-save-retains-selection.png"),
  });
  await page.unroute("**/api/v1/me/browser-clipper/profiles/*");
  await save({ libraryId: library.id, parentId: leaf.id });
  await open();
  await tree()
    .locator(".ant-tree-node-selected")
    .getByText(leaf.title, { exact: true })
    .waitFor();
  await page.screenshot({ path: join(output, "restored-selection.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await tree().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "tree-narrow.png") });
  const bounds = await tree().boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.setViewportSize({ width: 1280, height: 1000 });
  const tabId = await worker.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    page.url(),
  );
  await worker.evaluate(async (id) => chrome.tabs.setZoom(id, 2), tabId);
  await tree().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "tree-zoom-200.png") });
  const zoomBounds = await tree().boundingBox();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert(
    zoomBounds &&
      zoomBounds.x >= 0 &&
      zoomBounds.x + zoomBounds.width <= viewport.width,
  );
  await worker.evaluate(async (id) => chrome.tabs.setZoom(id, 1), tabId);
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  let rejectTree = true;
  await page.route("**/api/v1/resources?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (
      rejectTree &&
      query.get("libraryId") === library.id &&
      query.get("tree") === "true"
    ) {
      await route.fulfill({
        status: 503,
        json: { message: "目录加载暂时失败" },
      });
    } else await route.continue();
  });
  await open();
  await tree()
    .getByRole("alert")
    .filter({ hasText: "目录加载暂时失败" })
    .waitFor();
  assert(
    await dialog()
      .getByRole("button", { name: "保存方案", exact: true })
      .isDisabled(),
  );
  const retained = await readProfile();
  assert.equal(retained.parentId, leaf.id);
  rejectTree = false;
  await tree().getByRole("button", { name: "重新加载保存位置" }).click();
  await tree()
    .locator(".ant-tree-node-selected")
    .getByText(leaf.title, { exact: true })
    .waitFor();
  assert(
    await dialog()
      .getByRole("button", { name: "保存方案", exact: true })
      .isEnabled(),
  );
  await page.screenshot({ path: join(output, "retried-directory-load.png") });
  // Stage and commit synthetic captured text using the profile saved in the real form.
  const installationId = randomUUID(),
    verifier = randomBytes(32).toString("hex");
  const { createHash } = await import("node:crypto");
  const prepared = await page.request.post(
    origin + "/api/v1/me/browser-clipper/authorize",
    {
      headers: { origin },
      data: {
        version: 2,
        installationId,
        challenge: createHash("sha256").update(verifier).digest("hex"),
      },
    },
  );
  assert(prepared.ok(), await prepared.text());
  const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const tokenResponse = await page.request.post(
    origin + "/api/v1/browser-clipper/token",
    {
      headers: { origin: extensionOrigin },
      data: { version: 2, code: (await prepared.json()).code, verifier },
    },
  );
  assert(tokenResponse.ok(), await tokenResponse.text());
  const token = (await tokenResponse.json()).token;
  const requestId = randomUUID();
  const headers = { origin: extensionOrigin, authorization: "Bearer " + token };
  const clip = await page.request.post(
    origin + "/api/v1/browser-clipper/clips",
    {
      headers,
      data: {
        version: 1,
        requestId,
        profileId: profile.id,
        profileRevision: profile.revision,
        mode: "page",
        url: "https://example.test/fixture",
        title: "合成网页收录",
        capturedAt: new Date().toISOString(),
        markdown: "隔离测试正文",
        images: [],
      },
    },
  );
  assert(clip.ok(), await clip.text());
  const commit = await page.request.post(
    origin + `/api/v1/browser-clipper/clips/${requestId}/commit`,
    { headers, data: {} },
  );
  assert(commit.ok(), await commit.text());
  const saved = await db
    .selectFrom("resources")
    .select(["library_id", "parent_id"])
    .where("id", "=", (await commit.json()).resourceId)
    .executeTakeFirstOrThrow();
  assert.equal(saved.library_id, library.id);
  assert.equal(saved.parent_id, leaf.id);
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        libraryCount: 102,
        recentDocumentCount: 105,
        nestedDepth: 3,
        selectedLibraryId: library.id,
        selectedParentId: leaf.id,
        personal: true,
        libraryRoot: true,
        nested: true,
        reloadRestore: true,
        failedSaveRetained: true,
        failedLoadRetainedAndRetried: true,
        capturedIntoSelectedParent: true,
        narrow: [390, 844],
        zoom: "native 200%",
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
      capturedIntoSelectedParent: true,
      errors,
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify({ error: String(error), errors }, null, 2),
  );
  throw error;
} finally {
  await context?.close();
  await app.close();
  await db.destroy();
}
