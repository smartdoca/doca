// Run the real admin handover UI against an isolated SQLite database and file store.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, type Page } from "playwright-core";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";

const output = resolve(
  process.env.DOCA_QA_OUTPUT ?? "artifacts/verification/resource-handover",
);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "store-"));
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
const password = "isolated-handover-browser-2026";
const admin = {
  ...(await createUser(
    db,
    { login: "handoverqa-admin", displayName: "系统管理员 QA", password },
    { bootstrap: true },
  )),
  admin: 1,
};
const source = await createUser(
  db,
  { login: "handoverqa-source", displayName: "已离职员工 QA", password },
  { actor: admin },
);
const target = await createUser(
  db,
  { login: "handoverqa-target", displayName: "接收同事 QA", password },
  { actor: admin },
);
const content = createContent(db);
const library = await content.create(source, {
  title: "交接项目知识库",
  kind: "library",
  format: "rich_text",
});
const doc = await content.create(source, {
  title: "项目交接文档",
  kind: "document",
  format: "rich_text",
  libraryId: library.id,
});
const retained = await content.create(source, {
  title: "暂不交接的私人文档",
  kind: "document",
  format: "rich_text",
});
const origin = "http://127.0.0.1:39446";
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
    port: 39446,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${address.port}`, ws: true } },
  },
});
await web.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
let page: Page | undefined;
const checks: string[] = [],
  errors: string[] = [];
const pass = (label: string) => {
  checks.push(label);
  console.log("PASS " + label);
};
try {
  const sourceContext = await browser.newContext();
  const targetContext = await browser.newContext();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const login = async (ctx: typeof context, name: string) => {
    const response = await ctx.request.post(origin + "/api/v1/auth/login", {
      headers: { origin },
      data: { login: name, password },
    });
    assert.equal(response.status(), 200, await response.text());
  };
  await login(sourceContext, "handoverqa-source");
  await login(targetContext, "handoverqa-target");
  await login(context, "handoverqa-admin");
  const upload = await sourceContext.request.post(
    origin +
      `/api/v1/files/items?filename=project-notes.txt&parentType=document&parentId=${doc.id}`,
    {
      headers: { origin, "content-type": "application/octet-stream" },
      data: Buffer.from("Isolated handover fixture bytes"),
    },
  );
  assert.equal(upload.status(), 200, await upload.text());
  const file = await upload.json();
  const fileBefore = await db
    .selectFrom("file_items")
    .selectAll()
    .where("id", "=", file.id)
    .executeTakeFirstOrThrow();
  const objectBefore = await db
    .selectFrom("file_storage_objects")
    .selectAll()
    .where("id", "=", fileBefore.storage_object_id)
    .executeTakeFirstOrThrow();
  const historiesBefore = await db
    .selectFrom("document_versions")
    .selectAll()
    .orderBy("id")
    .execute();
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", source.id)
    .execute();
  page = await context.newPage();
  page.setDefaultTimeout(25000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/#/admin?tab=users");
  const sourceRow = page
    .locator(".admin-user-row")
    .filter({ hasText: "已离职员工 QA" });
  await sourceRow
    .getByRole("button", { name: "资源交接", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "资源交接 · 已离职员工 QA",
    exact: true,
  });
  await dialog
    .getByRole("checkbox", { name: library.title, exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "project-notes.txt", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .locator(".admin-user-row")
      .filter({ hasText: "接收同事 QA" })
      .getByRole("button", { name: "资源交接", exact: true })
      .count(),
    0,
  );
  const recipientsLoaded = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/admin/users?") &&
      response.url().includes("q="),
  );
  await dialog
    .getByRole("textbox", { name: "搜索正常使用的账号", exact: true })
    .fill("接收同事");
  assert.equal((await recipientsLoaded).status(), 200);
  const recipientPicker = dialog.getByRole("combobox", {
    name: "接收人",
    exact: true,
  });
  await recipientPicker.click();
  // The filtered list contains the placeholder followed by the matched active account.
  await recipientPicker.press("ArrowDown");
  await recipientPicker.press("Enter");
  await dialog
    .getByRole("checkbox", { name: library.title, exact: true })
    .check();
  await page.screenshot({ path: join(output, "inventory-desktop.png") });
  pass(
    "disabled-account inventory and active-recipient picker; document attachment cannot be selected independently; active accounts have no handover button",
  );
  await dialog.getByRole("button", { name: "预览交接", exact: true }).click();
  await dialog
    .getByRole("heading", { name: "确认交接内容", exact: true })
    .waitFor();
  await dialog.getByText("项目交接文档", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "preview-desktop.png") });
  await db
    .updateTable("resources")
    .set({ title: "项目交接文档（已更新）", version: doc.version + 1 })
    .where("id", "=", doc.id)
    .execute();
  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith("/resource-handover/execute"),
  );
  await dialog.getByRole("button", { name: "确认交接", exact: true }).click();
  assert.equal((await staleResponse).status(), 409);
  await dialog
    .getByRole("alert")
    .filter({ hasText: "资源或权限已变化" })
    .waitFor();
  assert.equal(
    (
      await db
        .selectFrom("resources")
        .select("owner_id")
        .where("id", "=", library.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
    source.id,
  );
  pass(
    "changing a child after preview rejects the entire stale confirmation with a localized error and no ownership changes",
  );
  await dialog.getByRole("button", { name: "预览交接", exact: true }).click();
  await dialog
    .getByRole("heading", { name: "确认交接内容", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "preview-mobile.png") });
  assert(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  pass("390px preview has no horizontal overflow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const acceptedResponse = page.waitForResponse((response) =>
    response.url().endsWith("/resource-handover/execute"),
  );
  await dialog.getByRole("button", { name: "确认交接", exact: true }).click();
  assert.equal((await acceptedResponse).status(), 200);
  await dialog
    .getByRole("status")
    .filter({ hasText: "已完成 3 项变更" })
    .waitFor();
  await dialog
    .getByRole("checkbox", { name: retained.title, exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: library.title, exact: true })
      .count(),
    0,
  );
  await page.screenshot({ path: join(output, "completed-desktop.png") });
  assert.equal(
    (
      await db
        .selectFrom("resources")
        .select("owner_id")
        .where("id", "=", retained.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
    source.id,
  );
  assert.equal(
    (
      await db
        .selectFrom("resources")
        .select("owner_id")
        .where("id", "=", library.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
    target.id,
  );
  const fileAfter = await db
    .selectFrom("file_items")
    .selectAll()
    .where("id", "=", file.id)
    .executeTakeFirstOrThrow();
  assert.equal(fileAfter.owner_id, target.id);
  assert.equal(fileAfter.storage_object_id, fileBefore.storage_object_id);
  assert.deepEqual(
    await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", objectBefore.id)
      .executeTakeFirstOrThrow(),
    objectBefore,
  );
  assert.deepEqual(
    await db
      .selectFrom("document_versions")
      .selectAll()
      .orderBy("id")
      .execute(),
    historiesBefore,
  );
  const downloaded = await targetContext.request.get(
    origin + `/api/v1/files/items/${file.id}/content`,
  );
  assert.equal(downloaded.status(), 200, await downloaded.text());
  assert.equal(await downloaded.text(), "Isolated handover fixture bytes");
  pass(
    "confirmed handover transfers library, document and attachment; recipient can download original bytes; unselected document and histories remain intact",
  );
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.locator(".locale-switch summary").click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page
    .locator(".admin-user-row")
    .filter({ hasText: "已离职员工 QA" })
    .getByRole("button", { name: "Hand over resources", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "Resource handover · 已离职员工 QA",
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("checkbox", { name: retained.title, exact: true })
    .waitFor();
  await page.screenshot({ path: join(output, "inventory-english.png") });
  pass("English catalog renders the same admin flow");
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  await rm(join(output, "failure.png"), { force: true });
  await rm(join(output, "failure.txt"), { force: true });
  await sourceContext.close();
  await targetContext.close();
  await context.close();
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  await writeFile(join(output, "failure.txt"), String(error));
  throw error;
} finally {
  await browser.close();
  await web.close();
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
}
