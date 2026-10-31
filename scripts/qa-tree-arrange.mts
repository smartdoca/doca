// Disposable database/browser regression for directory moves and error feedback.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { openTestDatabase } from "../tests/database.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";

const builtWeb = process.env.DOCA_QA_BUILT_WEB === "1";
const output = resolve(`artifacts/verification/tree-arrange${builtWeb ? "-built" : ""}`);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "doca-tree-arrange-"));
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: temporary } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const port = 39830,
  origin = `http://127.0.0.1:${port}`;
const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
const password = "isolated-tree-arrange-2026";
const owner = {
  ...(await createUser(
    db,
    { login: "treeqa", displayName: "Tree QA", password },
    { bootstrap: true },
  )),
  admin: 1,
};
const content = createContent(db);
const library = await content.create(owner, {
  kind: "library",
  format: "rich_text",
  title: "Isolated tree",
});
const create = (title: string, parentId?: string) =>
  content.create(owner, {
    kind: "document",
    format: "markdown",
    title,
    libraryId: library.id,
    parentId,
    markdown: "# " + title,
  });
const parent = await create("Old parent"),
  source = await create("Move me", parent.id),
  target = await create("Destination");
const deleted = await create("Retained trash", source.id);
await content.trash(owner, deleted.id, deleted.version);
const original = await db
  .selectFrom("resources")
  .selectAll()
  .where("id", "=", deleted.id)
  .executeTakeFirstOrThrow();
const app = await createApp(db, {
  origin,
  ...(builtWeb ? { staticDirectory: resolve("apps/web/dist") } : {}),
  storage: storageRuntime(),
  ai: { memory: { driver: "sqlite", url: ":memory:" } },
});
await app.listen({ host: "127.0.0.1", port: builtWeb ? port : 0 });
const address = app.server.address();
assert(address && typeof address !== "string");
const web = builtWeb ? undefined : await createServer({
  configFile: resolve("apps/web/vite.config.ts"),
  cacheDir: resolve("artifacts/verification/tree-arrange-vite-cache"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    hmr: false,
    proxy: { "/api": { target: `http://127.0.0.1:${address.port}`, ws: true } },
  },
});
await web?.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  assert.equal(
    (
      await context.request.post(origin + "/api/v1/auth/login", {
        headers: { origin },
        data: { login: "treeqa", password },
      })
    ).status(),
    200,
  );
  await page.goto(origin + "/#/r/" + source.id);
  const row = () => page.locator(`.tree-row[data-resource-id="${source.id}"]`);
  const destination = page.locator(
    `.tree-row[data-resource-id="${target.id}"]`,
  );
  await destination.waitFor();
  const box = await destination.boundingBox();
  assert(box);
  const saving = Promise.withResolvers<void>(),
    refreshing = Promise.withResolvers<void>(),
    refreshStarted = Promise.withResolvers<void>();
  let holdRefresh = false;
  const arrangeRoute = `**/resources/${source.id}/arrange`;
  const treeRoute = "**/resources?**";
  await page.route(arrangeRoute, async (route) => {
    await saving.promise;
    holdRefresh = true;
    await route.continue();
  });
  await page.route(treeRoute, async (route) => {
    if (holdRefresh && new URL(route.request().url()).searchParams.get("tree") === "true") {
      refreshStarted.resolve();
      await refreshing.promise;
    }
    await route.continue();
  });
  const status = page.getByRole("status").filter({ hasText: "调整位置中…" });
  const moved = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/resources/${source.id}/arrange`) &&
      r.request().method() === "POST",
  );
  const treeRefreshed = page.waitForResponse(
    (r) => r.url().includes("/resources?") && new URL(r.url()).searchParams.get("tree") === "true",
  );
  await row().dragTo(destination, {
    targetPosition: { x: 80, y: box.height - 2 },
  });
  await status.waitFor();
  assert.equal(await row().getAttribute("draggable"), "false");
  await page.screenshot({ path: join(output, "arranging-save.png") });
  saving.resolve();
  const response = await moved;
  assert.equal(response.status(), 200, await response.text());
  await refreshStarted.promise;
  assert.equal(await status.isVisible(), true, "Loading stays visible during the tree refresh");
  assert.equal(await row().getAttribute("draggable"), "false");
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await page.locator(".sidebar").screenshot({ path: join(output, "arranging-refresh-200.png") });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  refreshing.resolve();
  await treeRefreshed;
  await status.waitFor({ state: "hidden" });
  assert.equal(await row().getAttribute("draggable"), "true");
  await page.unroute(arrangeRoute);
  await page.unroute(treeRoute);
  assert.equal(
    (
      await db
        .selectFrom("resources")
        .select("parent_id")
        .where("id", "=", source.id)
        .executeTakeFirstOrThrow()
    ).parent_id,
    null,
  );
  assert.deepEqual(
    await db
      .selectFrom("resources")
      .selectAll()
      .where("id", "=", deleted.id)
      .executeTakeFirstOrThrow(),
    original,
  );
  await page.screenshot({ path: join(output, "moved-with-trash.png") });
  const message = "目录已被修改，请刷新后重试";
  await page.route(`**/resources/${source.id}/arrange`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ message }),
    }),
  );
  const refreshed = page.waitForResponse(
    (r) => r.url().includes("/resources?") && r.request().method() === "GET",
  );
  await row().dragTo(destination, {
    targetPosition: { x: 80, y: box.height / 2 },
  });
  await refreshed;
  await status.waitFor({ state: "hidden" });
  assert.equal(await row().getAttribute("draggable"), "true");
  // The notification must survive the successful list refresh and remain visible.
  await page.getByRole("alert").filter({ hasText: message }).waitFor();
  await page
    .getByRole("button", { name: "在Destination中创建", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("alert").filter({ hasText: message }).count(),
    1,
  );
  await page.screenshot({ path: join(output, "persistent-error.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        moveWithTrash: true,
        retainedTrashUnchanged: true,
        errorSurvivesRefresh: true,
        loadingDuringSave: true,
        loadingDuringRefresh: true,
        draggingBlockedWhileArranging: true,
        loadingClearsAfterSuccessAndFailure: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await web?.close();
  await app.close();
  await db.destroy();
  await rm(temporary, { recursive: true, force: true });
}
