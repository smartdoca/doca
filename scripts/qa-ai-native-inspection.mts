// Reopen only this run's retained synthetic model output; no provider request.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm, cp, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { provisionSurface } from "../packages/core/src/modules/documents/codecs/surfaces.js";
import { readAIDocument } from "../packages/core/src/workflows/ai-documents.js";

// Explicit current-format fixture mode for the final rebuilt runtime. This
// creates a new resource; it never opens or rolls back a retained model database.
async function inspectCurrentFixture() {
  assert.equal(process.env.DOCA_QA_ISOLATED, "1");
  assert.equal(process.env.DOCA_QA_WEB_MODE, "production-build");
  const output = resolve(process.env.DOCA_QA_OUTPUT!);
  assert(process.env.DOCA_QA_OUTPUT && !(await stat(join(output, "results.json")).catch(() => null)), "Use a fresh explicit output directory");
  for (const file of ["qa.db", "memory.db"]) assert(!(await stat(join(output, file)).catch(() => null)), "Never reuse a setup-interrupted fixture database: " + file);
  await mkdir(output, { recursive: true });
  const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
  const source = resolve(".local/issue-tracker-ai-native-metadata-repair-export-2026-10-23/after-canvas.json");
  const sourceSha256 = await hash(source), scene = JSON.parse(await readFile(source, "utf8"));
  assert.equal(scene.version, 1);
  const flatten = (value: any) => { const nodes: any[] = []; const walk = (node: any) => { nodes.push(node); (node.children ?? []).forEach(walk); }; value.scene.children.forEach(walk); return nodes; };
  const expectedIds = flatten(scene).map(node => node.id).sort();
  assert.equal(expectedIds.length, 41); assert.equal(new Set(expectedIds).size, 41);
  const expectedMetadata = JSON.parse(await readFile(resolve(".local/issue-tracker-ai-native-metadata-repair-export-2026-10-23/metadata-before-evidence.json"), "utf8")).expectedMetadata;
  assert.deepEqual(flatten(scene).find(node => node.id === "phone-settings").data, expectedMetadata);
  assert(process.env.DOCA_QA_NATIVE_RUNTIME_ROOT, "Provide the two final native browser receipts explicitly");
  const rounds = await Promise.all([1, 2].map(async round => {
    const directory = resolve(process.env.DOCA_QA_NATIVE_RUNTIME_ROOT!, `native-${round}`), resultFile = join(directory, "results.json");
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    assert.equal(result.result, "passed"); assert.equal(result.checks.length, 8); assert.equal(result.runtimeUnchanged, true); assert.equal(result.webMode, "production-build");
    return { directory, result, resultSha256: await hash(resultFile) };
  }));
  assert.equal(rounds[0]!.result.indexSha256, rounds[1]!.result.indexSha256);
  const runtimes = await Promise.all(rounds.map(async round => JSON.parse(await readFile(join(round.directory, "runtime-after.json"), "utf8"))));
  assert.deepEqual(runtimes[0], runtimes[1], "Both independent native rounds must verify the same complete packages/lock/renderer/Web runtime");
  const runtime = runtimes[1];
  const verifyRuntime = async () => {
    assert.equal(await hash("package.json"), runtime.manifestSha256); assert.equal(await hash("pnpm-lock.yaml"), runtime.lockSha256);
    assert.equal(await hash("apps/server/dist/canvas-render/sdk.js"), runtime.rendererSha256);
    for (const editor of runtime.editors) for (const file of editor.files) assert.equal(await hash(join("node_modules", editor.name, file.file)), file.sha256);
    for (const file of runtime.web.files) assert.equal(await hash(join("apps/web/dist", file.file)), file.sha256);
    assert.equal(runtime.web.indexSha256, process.env.DOCA_QA_EXPECT_INDEX_SHA256);
  };
  await verifyRuntime();
  process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
  process.env.DOCA_FILE_STORE_ID = "local";
  process.env.DOCA_FILE_STORES_JSON = JSON.stringify({ version: 1, stores: { local: { provider: "local", root: join(output, "files") } } });
  const db = await openDatabase({ driver: "sqlite", path: join(output, "qa.db") });
  const actor = { ...await createUser(db, { login: "nativepixelsqa", displayName: "Synthetic native pixels", password: "isolated-native-pixels-2026" }, { bootstrap: true }), admin: 1 };
  const board = await createContent(db).create(actor, { kind: "document", format: "canvas", title: "最终原生像素只读验收（合成fixture）" });
  await db.transaction().execute(tx => provisionSurface(tx, board, structuredClone(scene)));
  const before = await readAIDocument(db, { actor }, board.id);
  assert.deepEqual((before.value as any).scene, scene.scene);
  const { createApp } = await import("../apps/server/src/app/create-app.js");
  const { storageRuntime } = await import("../apps/server/src/adapters/storage.js");
  const port = Number(process.env.DOCA_QA_PORT ?? 39512), origin = `http://127.0.0.1:${port}`;
  let providerRequests = 0;
  const forbidden = async () => { providerRequests++; throw Error("Final native inspection must never call a model"); };
  const app = await createApp(db, { origin, staticDirectory: resolve("apps/web/dist"), storage: storageRuntime(), ai: { memory: { driver: "sqlite", url: join(output, "memory.db") }, fetch: forbidden, imageFetch: forbidden } });
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const result: any = { result: "running", isolated: true, source, sourceSha256, sourceDatabaseOpened: false, fixture: "Exact current model-after scene, new resource/new epoch through provisionSurface; no retained DB rollback", allOriginalIds: expectedIds, expectedMetadata, boardId: board.id, webMode: "production-build", indexSha256: runtime.web.indexSha256, lockSha256: runtime.lockSha256, editorTrees: runtime.editors.map(({ name, version, fileCount, treeSha256 }: any) => ({ name, version, fileCount, treeSha256 })), sheetArtifact: rounds[1]!.result.sheetArtifact, checkedRuntimeReceipts: rounds.map(({ directory, resultSha256 }) => ({ directory, resultSha256 })), stages: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 2640, height: 1800 } });
    assert((await context.request.post(origin + "/api/v1/auth/login", { headers: { origin }, data: { login: "nativepixelsqa", password: "isolated-native-pixels-2026" } })).ok());
    const page = await context.newPage(), errors: string[] = [], updates: unknown[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("websocket", socket => socket.on("framesent", ({ payload }) => { try { const frame = JSON.parse(String(payload)); if (frame.type === "update") updates.push(frame); } catch {} }));
    for (const stage of ["passive-open", "passive-reload", "menu-fit", "menu-fit-reload"]) {
      if (stage === "passive-open") await page.goto(origin + "/#/r/" + board.id); else if (stage !== "menu-fit") await page.reload();
      await page.locator(".canvas-host canvas").first().waitFor();
      await page.getByRole("button", { name: "选择 (V / 1)", exact: true }).waitFor();
      if (stage.startsWith("menu-fit")) {
        await page.getByRole("button", { name: "手型工具 (H / Space)", exact: true }).click();
        await page.getByRole("button", { name: "缩放选项", exact: true }).click();
        await page.getByRole("menuitem", { name: "适合画布", exact: false }).click();
        await page.getByRole("button", { name: "选择 (V / 1)", exact: true }).click();
        await page.mouse.move(25, 25);
      }
      await page.waitForTimeout(1100);
      const after = await readAIDocument(db, { actor }, board.id);
      assert.equal(after.seq, before.seq); assert.deepEqual((after.value as any).scene, scene.scene);
      assert.deepEqual(flatten(after.value).map(node => node.id).sort(), expectedIds);
      assert.deepEqual(flatten(after.value).find(node => node.id === "phone-settings").data, expectedMetadata);
      assert.deepEqual(updates, []); assert.deepEqual(errors, []); assert.equal(providerRequests, 0);
      await page.screenshot({ path: join(output, stage + ".png") });
      result.stages.push({ stage, seq: after.seq, allOriginalIds: 41, fullSceneUnchanged: true, metadataUnchanged: true, contentWrites: 0, outgoingContentFrames: 0 });
    }
    // Actual browser pixel captures of the known synthetic scene at maxZoom=1.
    // They are screenshots, not native-export substitutes or runtime mutations.
    result.pixelCaptures = [];
    for (const [name, clip] of [
      ["phone", { x: 400, y: 200, width: 500, height: 1000 }],
      ["web", { x: 850, y: 200, width: 1380, height: 1000 }],
      ["erd", { x: 400, y: 1100, width: 1400, height: 650 }],
    ] as const) { const file = name + "-actual-browser.png"; await page.screenshot({ path: join(output, file), clip }); result.pixelCaptures.push({ file, clip }); }
    result.result = "passed"; result.providerRequests = providerRequests; result.pageErrors = errors;
    result.manualPixelReview = "Required separately for actual phone/Web/ERD contours and text; model fields alone do not verify pixels";
    await writeFile(join(output, "scene.json"), JSON.stringify(scene, null, 2) + "\n");
  } catch (error) { result.result = "failed"; result.error = String(error); process.exitCode = 1; }
  finally { await browser.close(); await app.close(); await db.destroy(); await verifyRuntime(); assert.equal(await hash(source), sourceSha256); result.runtimeAndSourceUnchanged = true; await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n"); }
  console.log("Final native readonly fixture:", result.result, output);
  return result.result === "passed";
}

if (process.env.DOCA_QA_CURRENT_FIXTURE === "1") process.exit(await inspectCurrentFixture() ? 0 : 1);

assert.equal(process.env.DOCA_QA_ISOLATED, "1");
const input = resolve(process.env.DOCA_QA_NATIVE_INPUT ?? ".local/issue-tracker-ai-native-2026-10-22");
assert([
  resolve(".local/issue-tracker-ai-native-2026-10-22"),
  resolve(".local/issue-tracker-ai-native-final-candidate-2026-10-22"),
  resolve(".local/issue-tracker-ai-native-official-0.5.12-lifecycle-2026-10-23"),
  resolve(".local/issue-tracker-ai-native-guidance-fixed-2026-10-23"),
].includes(input), "Only this task's retained synthetic native runs may be reopened");
const result = JSON.parse(await readFile(join(input, "results.json"), "utf8"));
assert.equal(result.isolated, true);
assert.equal(result.paidRequests, 0);
assert(["passed", "failed"].includes(result.result), "Do not inspect a still-running original job");
const sourceHash = () => readFile(join(input, "qa.db")).then(bytes => createHash("sha256").update(bytes).digest("hex"));
const sourceSha256 = await sourceHash();
const cache = await mkdtemp(join(tmpdir(), "doca-ai-native-inspection-"));
// The original synthetic run is evidence. Even authentication/startup writes go
// only to a fresh SQLite backup, never the retained run or its provider config.
const retained = new Database(join(input, "qa.db"), { readonly: true, fileMustExist: true });
try {
  const active = retained.prepare("SELECT id,status FROM ai_jobs WHERE status NOT IN ('completed','failed','cancelled')").all();
  assert.deepEqual(active, [], "Read-only inspection must not start an unfinished original task");
  await retained.backup(join(cache, "qa.db"));
} finally { retained.close(); }
if (await stat(join(input,"memory.db")).catch(() => null)) {
  const memory = new Database(join(input,"memory.db"), { readonly: true, fileMustExist: true });
  try { await memory.backup(join(cache,"memory.db")); } finally { memory.close(); }
}
await cp(join(input,"storage"),join(cache,"storage"),{recursive:true});
const builtWeb = process.env.DOCA_QA_BUILT_WEB === "1";
const port = Number(process.env.DOCA_QA_PORT ?? 39489);
const origin = `http://127.0.0.1:${port}`;
const staticDirectory = join(input,"web");
const indexSha256 = builtWeb ? createHash("sha256").update(await readFile(join(staticDirectory,"index.html"))).digest("hex") : undefined;
if (builtWeb) assert.equal(indexSha256,result.indexSha256,"Inspect the same immutable production build used by the original run");
process.env.DOCA_CREDENTIAL_MASTER_KEY = (
  await readFile(join(input, ".credential-master-key"), "utf8")
).trim();
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: join(cache, "storage") } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } = await import("../apps/server/src/adapters/storage.js");
const db = await openDatabase({ driver: "sqlite", path: join(cache, "qa.db") });
let providerRequests = 0;
const forbidden: typeof fetch = async () => {
  providerRequests++;
  throw Error("Manual inspection cannot call a model provider");
};
const app = await createApp(db, {
  origin,
  ...(builtWeb ? { staticDirectory } : {}),
  storage: storageRuntime(),
  ai: { memory: { driver: "sqlite", url: join(cache, "memory.db") }, fetch: forbidden, imageFetch: forbidden },
});
const output = resolve(process.env.DOCA_QA_OUTPUT ?? "artifacts/verification/issue-tracker-2026-10-21/ai-native-provider");
const canvasVersion = JSON.parse(await readFile("node_modules/@smartdoca/canvas/package.json", "utf8")).version;
await mkdir(output, { recursive: true });
await app.listen({ host: "127.0.0.1", port: builtWeb ? port : 0 });
const address = app.server.address();
assert(address && typeof address !== "string");
const web = builtWeb ? undefined : await createServer({
  configFile: resolve("apps/web/vite.config.ts"),
  cacheDir: cache,
  server: { hmr: false, watch: { ignored: ["**/*"] }, host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${address.port}`, ws: true } } },
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await web?.listen();
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
  const response = await context.request.post(origin + "/api/v1/auth/login", {
    headers: { origin }, data: { login: "actualissue", password: "isolated-actual-issue-2026" },
  });
  assert(response.ok());
  const before = await db.selectFrom("document_states").select(["seq"]).where("resource_id", "=", result.boardId).executeTakeFirstOrThrow();
  const page = await context.newPage();
  const errors: string[] = [], updates: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
    try { const v = JSON.parse(String(payload)); if (v.type === "update") updates.push(v.id); } catch {}
  }));
  await page.goto(origin + "/#/r/" + result.boardId);
  const canvas = page.locator(".canvas-host");
  await canvas.waitFor();
  await page.locator(".canvas-host canvas").first().waitFor();
  await canvas.click({ position: { x: 970, y: 800 } });
  await page.keyboard.press("Shift+Digit1");
  await page.getByRole("button", { name: "手型工具 (H / Space)", exact: true }).click();
  await page.getByRole("button", { name: "选择 (V / 1)", exact: true }).click();
  // Use the visible empty right margin, then move off-canvas so hover ports
  // cannot stand in for the native container outline in the evidence.
  await canvas.click({ position: { x: 1600, y: 850 } });
  await page.mouse.move(25, 25);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(output, "native-all-fit.png") });
  await page.reload();
  await page.locator(".canvas-host canvas").first().waitFor();
  await canvas.click({ position: { x: 970, y: 800 } });
  await page.keyboard.press("Shift+Digit1");
  await page.getByRole("button", { name: "手型工具 (H / Space)", exact: true }).click();
  await page.getByRole("button", { name: "选择 (V / 1)", exact: true }).click();
  await canvas.click({ position: { x: 1600, y: 850 } });
  await page.mouse.move(25, 25);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(output, "native-all-fit-reload.png") });
  const after = await db.selectFrom("document_states").select(["seq"]).where("resource_id", "=", result.boardId).executeTakeFirstOrThrow();
  assert.equal(after.seq, before.seq);
  assert.deepEqual(updates, []);
  assert.deepEqual(errors, []);
  assert.equal(providerRequests,0,"Inspection must make zero model requests");
  assert.equal(await sourceHash(),sourceSha256,"The retained original database must remain byte-for-byte unchanged");
  await writeFile(join(output, "manual-browser.json"), JSON.stringify({ result: "opened-fit-reloaded", isolated:true, canvas: canvasVersion, input, webMode:builtWeb?"production-build-copy":"development-server", indexSha256, sourceSha256, sourceUnchanged:true, databaseMode:"readonly SQLite backup into disposable clone", seq: after.seq, sceneWrites: 0, outgoingContentFrames:updates.length, errors, modelRequests: providerRequests }, null, 2) + "\n");
  console.log("PASS synthetic native board fit/reload with zero content writes and no model requests");
} finally {
  await browser.close();
  await web?.close();
  await app.close();
  await db.destroy();
  assert.equal(await sourceHash(),sourceSha256,"Read-only original evidence must be preserved even if inspection fails");
  await rm(cache, { recursive: true, force: true });
}
