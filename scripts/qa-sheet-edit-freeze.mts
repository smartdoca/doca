// Isolated native UI regression: never uses user documents or a user database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { openTestDatabase } from "../tests/database.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";

const builtWeb = process.env.DOCA_QA_BUILT_WEB === "1";
assert(!builtWeb || !process.env.DOCA_QA_SHEET_ENTRY, "Built Web must use its installed npm package");
const installedVersion = JSON.parse(await readFile("node_modules/@smartdoca/sheet/package.json", "utf8")).version;
const expectedVersion = JSON.parse(await readFile("package.json", "utf8")).dependencies["@smartdoca/sheet"];
assert.equal(installedVersion, expectedVersion);
const output = resolve(
  process.env.DOCA_QA_OUTPUT ?? "artifacts/verification/sheet-edit-freeze",
);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "doca-edit-freeze-"));
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: temporary } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const port = Number(process.env.DOCA_QA_PORT ?? 39829),
  origin = `http://127.0.0.1:${port}`;
const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
const password = "isolated-freeze-edit-2026";
const owner = {
  ...(await createUser(
    db,
    { login: "editqa", displayName: "Edit QA", password },
    { bootstrap: true },
  )),
  admin: 1,
};
const content = createContent(db);
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
  cacheDir: resolve("artifacts/verification/sheet-edit-freeze-vite-cache"),
  ...(process.env.DOCA_QA_SHEET_ENTRY
    ? {
        resolve: {
          alias: [
            {
              find: /^@smartdoca\/sheet$/,
              replacement: resolve(process.env.DOCA_QA_SHEET_ENTRY),
            },
          ],
        },
      }
    : {}),
  plugins: [
    {
      name: "qa-sheet-handle",
      enforce: "pre",
      transform(source, id) {
        if (
          id
            .split("?")[0]
            ?.endsWith("/features/documents/spreadsheet-editor.tsx")
        )
          return source.replace(
            "onReady={setHandle}",
            "onReady={h => { (window as any).__qaSheet = h; setHandle(h); }}",
          );
      },
    },
  ],
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
await context.addInitScript("window.__name = value => value");
const page = await context.newPage();
const errors: string[] = [],
  checks: unknown[] = [];
let passed = false;
page.on("pageerror", (error) => errors.push(error.message));
try {
  const login = await context.request.post(origin + "/api/v1/auth/login", {
    headers: { origin },
    data: { login: "editqa", password },
  });
  assert.equal(login.status(), 200, await login.text());
  for (const [name, row, height, zoom] of [
    ["second-row", 1, 30, 1],
    ["scrolled", 20, 180, 1],
    ["unequal", 20, 15, 1],
    ["zoom-150", 20, 180, 1.5],
    ["zoom-50", 20, 180, 0.5],
  ] as const) {
    if (
      process.env.DOCA_QA_CASES &&
      !process.env.DOCA_QA_CASES.split(",").includes(name)
    )
      continue;
    const sheetId = "edit-sheet";
    const document = await content.create(owner, {
      kind: "document",
      format: "spreadsheet",
      title: "Edit " + name,
      initialContent: {
        id: "edit-workbook",
        name: "Frozen edit",
        appVersion: "0.25.1",
        locale: "zhCN",
        styles: {},
        sheetOrder: [sheetId],
        sheets: {
          [sheetId]: {
            id: sheetId,
            name: "Sheet1",
            rowCount: 120,
            columnCount: 30,
            defaultRowHeight: 30,
            defaultColumnWidth: 100,
            freeze: { startRow: 1, startColumn: 0, ySplit: 1, xSplit: 0 },
            rowData: { 0: { h: height, ia: 0 } },
            cellData: Object.fromEntries(
              Array.from({ length: 100 }, (_, r) => [
                r,
                { 0: { v: "Row " + (r + 1) }, 1: { v: "Other" } },
              ]),
            ),
          },
        },
      },
    });
    await page.goto(origin);
    await page.evaluate(
      ({ key, zoom }) =>
        localStorage.setItem(
          key,
          JSON.stringify({ version: 1, zoomRatio: zoom }),
        ),
      { key: `doca.sheet.zoom.v1:${owner.id}:${document.id}`, zoom },
    );
    await page.goto(origin + "/#/r/" + document.id);
    if (builtWeb) {
      // Observe the shipped React ref; all operations below use the public handle.
      await page.waitForFunction(() => {
        const root = document.querySelector(".sheet-document .uos-editor");
        if (!root) return false;
        const key = Object.keys(root).find((key) => key.startsWith("__reactFiber$"));
        let fiber = key ? (root as any)[key] : null;
        while (fiber) {
          const handle = (fiber.memoizedProps?.ref ?? fiber.ref)?.current;
          if (handle?.getRuntime) {
            (window as any).__qaSheet = handle;
            return !!handle.getRuntime()?.univerAPI.getActiveWorkbook();
          }
          fiber = fiber.return;
        }
        return false;
      });
    }
    await page.waitForFunction(
      () =>
        !!(window as any).__qaSheet
          ?.getRuntime()
          ?.univerAPI.getActiveWorkbook(),
    );
    await page
      .getByText(/已保存到云端$/)
      .last()
      .waitFor({ state: "attached" });
    await page.evaluate(
      async ({ row, height }) => {
        const h = (window as any).__qaSheet,
          api = h.getRuntime().univerAPI;
        api.getActiveWorkbook().getActiveSheet().getRange(row, 0).activate();
        await api.executeCommand("sheet.command.scroll-view", {
          sheetViewStartRow: row,
          offsetY: -height,
        });
        (window as any).__qaCommands = [];
        api.onCommandExecuted((c: any) => {
          if (/scroll|edit-visible/.test(c.id))
            (window as any).__qaCommands.push(c);
        });
      },
      { row, height },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const geometry = () =>
      page.evaluate(
        ({ row, sheetId }) => {
          const h = (window as any).__qaSheet;
          const rect = (r: number) =>
            h
              .getRangeRect(
                {
                  sheetId,
                  startRow: r,
                  endRow: r,
                  startColumn: 0,
                  endColumn: 0,
                },
                { allowOutside: true },
              )
              ?.toJSON();
          return {
            target: rect(row),
            frozen: rect(0),
            scroll: h
              .getRuntime()
              .univerAPI.getActiveWorkbook()
              .getActiveSheet()
              .getScrollState(),
            commands: (window as any).__qaCommands,
          };
        },
        { row, sheetId },
      );
    const before = await geometry();
    const saved = () => db.selectFrom("document_states").select(["seq", "checkpoint"]).where("resource_id", "=", document.id).executeTakeFirstOrThrow();
    const stateBeforeEditing = await saved();
    await page.mouse.dblclick(
      before.target.x + 40 * zoom,
      before.target.y + 10 * zoom,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const after = await geometry();
    checks.push({ name, before, after });
    console.log(JSON.stringify({ name, before, after }));
    await page.screenshot({ path: join(output, name + ".png") });
    assert(
      after.target.top >= after.frozen.bottom - 1,
      "editing hides target under frozen pane: " + name,
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(await saved(), stateBeforeEditing, "entering/cancelling a cell draft must not write content");
    if (name === "zoom-50" && process.env.DOCA_QA_IDLE === "1") {
      await page.waitForTimeout(60000);
      assert.deepEqual(await saved(), stateBeforeEditing, "60 seconds idle must not write content");
    }
    if (name === "second-row" && process.env.DOCA_QA_TOOLBAR === "1") {
      await page.getByText("换行", { exact: true }).click();
      await page.waitForFunction(
        () => (window as any).__qaSheet.getFormatState().style.tb === 3,
      );
      await page.getByText("合并", { exact: true }).click();
      await page
        .getByRole("menuitem", { name: "合并选区（保留内容）", exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
    }
  }
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ passed, installedVersion, builtWeb, checks, errors }, null, 2),
  );
  await browser.close();
  await web?.close();
  await app.close();
  await db.destroy();
  await rm(temporary, { recursive: true, force: true });
}
