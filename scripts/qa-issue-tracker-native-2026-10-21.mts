// Actual Doca website checks. All accounts/documents/database/file storage are disposable.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { restoreDocument } from "../packages/core/src/modules/collaboration/documents.js";
import { captureRichSelection } from "../apps/web/src/features/comments/rich-selection-anchor.js";
import { createEditor } from "slate";

const temporary = await mkdtemp(join(tmpdir(), "doca-tracker-native-"));
const output = resolve(process.env.DOCA_QA_OUTPUT ?? "artifacts/verification/issue-tracker-2026-10-21/native-browser");
const diagnostics = resolve(process.env.DOCA_QA_DEBUG_OUTPUT ?? "artifacts/verification/issue-tracker-2026-10-21/native-diagnostics");
const stages = new Set((process.env.DOCA_QA_STAGES ?? "presence,comments,defaults,link,heading,diagram,filter").split(","));
const port = Number(process.env.DOCA_QA_PORT ?? 39464), origin = `http://127.0.0.1:${port}`;
const builtWeb = process.env.DOCA_QA_BUILT_WEB === "1";
if (process.env.DOCA_QA_WEB_MODE) assert.equal(process.env.DOCA_QA_WEB_MODE, builtWeb ? "production-build" : "development-server", "The requested mode must match the existing actual build switch");
assert(!(await stat(join(output, "results.json")).catch(() => null)), "Use a new result directory; retained failure receipts must not be overwritten");
await mkdir(output, { recursive: true });
await mkdir(diagnostics, { recursive: true });
const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const fileTree = async (directory: string) => {
  const root = await realpath(directory), files: Array<{ file: string; bytes: number; sha256: string }> = [];
  const walk = async (path: string) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { assert(entry.isFile(), "Unexpected package symlink: " + file); files.push({ file: relative(root, file), bytes: (await stat(file)).size, sha256: await sha256(file) }); }
    }
  };
  await walk(root);
  return { files, fileCount: files.length, treeSha256: createHash("sha256").update(files.map(f => `${f.file}\0${f.sha256}\n`).join("")).digest("hex") };
};
const fingerprints = async () => ({
  manifestSha256: await sha256("package.json"), lockSha256: await sha256("pnpm-lock.yaml"),
  scriptSha256: await sha256("scripts/qa-issue-tracker-native-2026-10-21.mts"),
  editors: await Promise.all(["canvas", "sheet", "slate", "markdown", "slides"].map(async name => ({ name: "@smartdoca/" + name, version: JSON.parse(await readFile(`node_modules/@smartdoca/${name}/package.json`, "utf8")).version, ...await fileTree(`node_modules/@smartdoca/${name}`) }))),
  ...(builtWeb ? { web: { indexSha256: await sha256("apps/web/dist/index.html"), ...await fileTree("apps/web/dist") }, rendererSha256: await sha256("apps/server/dist/canvas-render/sdk.js") } : {}),
});
const runtimeBefore = await fingerprints();
if (process.env.DOCA_QA_EXPECT_INDEX_SHA256) assert.equal(runtimeBefore.web?.indexSha256, process.env.DOCA_QA_EXPECT_INDEX_SHA256);
if (process.env.DOCA_QA_EXPECT_SHEET_VERSION) assert.equal(runtimeBefore.editors.find(p => p.name === "@smartdoca/sheet")?.version, process.env.DOCA_QA_EXPECT_SHEET_VERSION);
if (process.env.DOCA_QA_EXPECT_CANVAS_VERSION) assert.equal(runtimeBefore.editors.find(p => p.name === "@smartdoca/canvas")?.version, process.env.DOCA_QA_EXPECT_CANVAS_VERSION);
const sheetArtifact = process.env.DOCA_QA_SHEET_CANDIDATE_TGZ ? { releaseStatus: "candidate, not official npm acceptance", path: resolve(process.env.DOCA_QA_SHEET_CANDIDATE_TGZ), sha256: await sha256(process.env.DOCA_QA_SHEET_CANDIDATE_TGZ) } : undefined;
if (sheetArtifact) assert.equal(sheetArtifact.sha256, process.env.DOCA_QA_SHEET_CANDIDATE_SHA256, "Candidate archive must match the independently supplied digest");
await writeFile(join(output, "runtime-before.json"), JSON.stringify(runtimeBefore, null, 2) + "\n");
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({ version: 1, stores: { local: { provider: "local", root: join(temporary, "files") } } });
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } = await import("../apps/server/src/adapters/storage.js");
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const owner = { ...await createUser(db, { login: "nativeqa", displayName: "Native QA owner", password: "isolated-native-qa-2026" }, { bootstrap: true }), admin: 1 };
const empty = await createUser(db, { login: "emptynameqa", displayName: "Temporary fixture name", password: "isolated-native-qa-2026" }, { actor: owner });
// Explicit synthetic legacy-state fixture, never a production account or migration.
await db.updateTable("users").set({ display_name: "" }).where("id", "=", empty.id).execute();
let providerRequests = 0;
const forbiddenModelFetch = async () => { providerRequests++; throw Error("Native website acceptance must not call a model provider"); };
const app = await createApp(db, { origin, ...(builtWeb ? { staticDirectory: resolve("apps/web/dist") } : {}), storage: storageRuntime(), ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: forbiddenModelFetch, imageFetch: forbiddenModelFetch } });
await app.listen({ host: "127.0.0.1", port: builtWeb ? port : 0 });
const address = app.server.address(); assert(address && typeof address !== "string");
const web = builtWeb ? undefined : await createServer({ configFile: resolve("apps/web/vite.config.ts"), cacheDir: join(temporary, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, hmr: false, proxy: { "/api": { target: `http://127.0.0.1:${address.port}`, ws: true } } } });
await web?.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
const peerContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [], checks: any[] = [];
const observed: Array<{ p: Page; updates: unknown[] }> = [], resources = new Set<string>();
let current: Page | undefined;
const packages = JSON.parse(await readFile("package.json", "utf8")).dependencies;
const requestFor = async (ctx: BrowserContext, path: string, data?: unknown, method = "GET") => {
  const res = await ctx.request.fetch(origin + "/api/v1" + path, { method, headers: { origin }, data });
  assert.equal(res.status(), 200, `${method} ${path}: ${await res.text()}`); return res.json();
};
const request = (path: string, data?: unknown, method = "GET") => requestFor(context, path, data, method);
const until = async (f: () => Promise<boolean>, label: string) => { for (let n = 0; n < 150; n++) { if (await f()) return; await delay(100); } throw Error("Timed out: " + label); };
const saved = (p: Page) => p.getByText(/(?:^| · )已保存到云端$/).last().waitFor({ state: "attached" });
const seq = async (id: string) => (await db.selectFrom("document_states").select("seq").where("resource_id", "=", id).executeTakeFirstOrThrow()).seq;
const shot = async (p: Page, name: string) => { await p.screenshot({ path: join(output, name + ".png") }); return name + ".png"; };
const watch = async (ctx = context) => { const p = await ctx.newPage(); current = p; p.setDefaultTimeout(15000); const updates: unknown[] = []; p.on("pageerror", e => errors.push(e.message)); p.on("websocket", s => s.on("framesent", ({ payload }) => { try { const v = JSON.parse(String(payload)); if (v.type === "update") updates.push(v); } catch {} })); const t={p,updates};observed.push(t);return t; };
const create = (format: string, title: string) => request("/resources", { kind: "document", format, title }, "POST");
const open = async (id: string, selector: string, ctx = context) => { resources.add(id);const t = await watch(ctx); await t.p.goto(origin + "/#/r/" + id); await t.p.locator(selector).waitFor(); await saved(t.p); return t; };
const project = async (id: string) => { const x = await request(`/ai/resources/${id}/preview`); if (x.resource.format === "spreadsheet") { const { projectExlsxWorkbook } = await import("@smartdoca/sheet/model"); x.value = await projectExlsxWorkbook({ baseline: x.surface.baseline, update: new Uint8Array(Buffer.from(x.surface.update, "base64")), checkpointSeq: 0 }); } return x; };
const select = async (p: Page, value: string) => { const n = p.locator(".uos-editor").getByRole("textbox", { exact: true }); await n.fill(value); await n.press("Enter"); };
const run = async (rows: number[], label: string, f: () => Promise<unknown>) => { try { const details = await f(); checks.push({ rows, label, result: "passed", details }); console.log("PASS", rows.join(","), label); } catch (e) { checks.push({ rows, label, result: "failed", error: String(e) }); console.error("FAIL", rows.join(","), e); if (current) { await shot(current, "failure-" + rows.join("-")).catch(() => {}); await writeFile(join(output, "failure-" + rows.join("-") + ".html"), await current.content()).catch(() => {}); if(rows.includes(6))await writeFile(join(diagnostics,"row6-link-dom-events.json"),JSON.stringify(await current.evaluate(()=>({events:(window as any).__qaLinkDOM,active:document.activeElement?.outerHTML,focused:document.hasFocus(),inputs:[...document.querySelectorAll('.uos-inline-insert-form input')].map(el=>({label:el.getAttribute('aria-label'),value:(el as HTMLInputElement).value}))})),null,2)).catch(()=>{}); } } };
try {
  await request("/auth/login", { login: "nativeqa", password: "isolated-native-qa-2026" }, "POST");
  await requestFor(peerContext, "/auth/login", { login: "emptynameqa", password: "isolated-native-qa-2026" }, "POST");
  if (stages.has("presence")) await run([4], "blank-displayName peer caret on actual two-client rich text", async () => {
    const doc = await createContent(db).create(owner, { kind: "document", format: "rich_text", title: "Empty-name cursor QA", initialContent: { schemaVersion: 2, children: [{ id: "title", type: "paragraph", children: [{ text: "Empty-name cursor QA" }] }, { id: "body", type: "paragraph", children: [{ text: "Move the caret in this body." }] }] } });
    await request(`/resources/${doc.id}/permissions`, { version: doc.version, visibility: "invited", accessMode: "custom", grants: [{ userId: empty.id, role: "editor" }] }, "PUT");
    const a = await open(doc.id, ".sk-editable"), b = await open(doc.id, ".sk-editable", peerContext);
    await b.p.bringToFront(); await b.p.locator('.sk-block-paragraph').last().click(); await b.p.keyboard.press("End");
    await a.p.locator(".remote-caret").waitFor();
    const geometry = await a.p.locator(".remote-caret").first().evaluate(el => { const r = el.getBoundingClientRect(), css = getComputedStyle(el); return { rect: r.toJSON(), borderColor: css.borderColor, borderWidth: css.borderLeftWidth, label: el.textContent }; });
    assert(geometry.rect.height > 10 && parseFloat(geometry.borderWidth) > 0, JSON.stringify(geometry));
    const before = await seq(doc.id); await b.p.keyboard.press("ArrowLeft"); await delay(500); assert.equal(await seq(doc.id), before);
    await shot(a.p, "row4-empty-name-caret");
    await b.p.keyboard.insertText(" Peer edit"); await until(async () => (await a.p.locator(".sk-editable").innerText()).includes("Peer edit"), "remote rich edit");
    assert.equal(a.updates.length, 0, "remote update echo");
    return { userStoredDisplayName: "", serverPublicId: "emptynameqa", geometry, localUpdates: b.updates.length, remoteEcho: a.updates.length, selectionWrites: 0 };
  });
  if (stages.has("comments")) await run([5], "comment controls wide/narrow and opened/closed states", async () => {
    const content=createContent(db),doc = await content.create(owner,{kind:"document",format:"rich_text",title:"Comment controls QA",initialContent:{schemaVersion:2,children:[{id:"comment-title",type:"paragraph",children:[{text:"Comment controls QA"}]},{id:"comment-body",type:"paragraph",children:[{text:"Review this synthetic paragraph."}]}]}}), a = await open(doc.id, ".sk-editable");
    const baseline = await seq(doc.id), observations = [];
    for (const width of [1600, 760, 390]) {
      await a.p.setViewportSize({ width, height: 900 });
      const close = a.p.getByRole("button", { name: "收起内容评论", exact: true });
      if (await close.isVisible()) await close.click();
      const button = a.p.getByRole("button", { name: "展开内容评论", exact: true }); await button.waitFor();
      const g = await button.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), expanded: el.getAttribute("aria-expanded"), icon: !!el.querySelector("svg"), accessibleName: el.getAttribute("aria-label") }));
      assert(g.rect.x >= 0 && g.rect.right <= width && g.rect.height >= 24 && g.icon); assert.equal(g.expanded, "false");
      await shot(a.p, `row5-${width}-closed`); await button.click(); await close.waitFor();
      const aside = a.p.locator("aside.content-comments"); assert(await aside.isVisible());
      const inside = await close.boundingBox(); assert(inside && inside.x >= 0 && inside.x + inside.width <= width);
      await shot(a.p, `row5-${width}-open`); await close.focus(); await a.p.keyboard.press("Enter"); await button.waitFor();
      observations.push({ width, closedButton: g, openCloseButton: inside, drawer: (await aside.count()) > 0 });
    }
    const loaded=await restoreDocument(db,doc.id);
    try{const e=createEditor();e.children=loaded.runtime.getValue();const anchor=captureRichSelection(e,loaded.runtime,{anchor:{path:[1,0],offset:0},focus:{path:[1,0],offset:6}});await content.comment(owner,doc.id,{version:1,blocks:[{type:"paragraph",children:[{type:"text",text:"Synthetic review"}]}]},null,JSON.stringify(anchor));}finally{loaded.destroy();}
    await a.p.reload();await a.p.locator(".sk-editable").waitFor();await saved(a.p);
    for(const width of [390,1600]){
      await a.p.setViewportSize({width,height:900});
      const close=a.p.getByRole("button",{name:"收起内容评论",exact:true});if(await close.isVisible())await close.click();
      const button=a.p.getByRole("button",{name:"展开内容评论",exact:true});await button.waitFor();assert.equal(await button.locator("small").innerText(),"1");await shot(a.p,`row5-${width}-one-comment-closed`);await button.click();await close.waitFor();assert(await a.p.getByText("Synthetic review",{exact:true}).isVisible());
      await a.p.getByRole("combobox",{name:"文档模式",exact:true}).click();await a.p.getByRole("option",{name:"阅读",exact:true}).click();await shot(a.p,`row5-${width}-one-comment-readonly`);
      await a.p.getByRole("combobox",{name:"文档模式",exact:true}).click();await a.p.getByRole("option",{name:"编辑",exact:true}).click();
    }
    assert.equal(await seq(doc.id), baseline); assert.equal(a.updates.length, 0);
    return observations;
  });
  if (stages.has("defaults")) await run([8], "new and native-appended worksheet dimensions", async () => {
    const doc = await create("spreadsheet", "Worksheet default size QA"), a = await open(doc.id, ".uos-editor__select-all");
    const initial = await project(doc.id);
    const dimensions = (value: any) => value.sheetOrder.map((id: string) => ({ id, rowHeight: value.sheets[id].defaultRowHeight, columnWidth: value.sheets[id].defaultColumnWidth }));
    const first = dimensions(initial.value); assert(first.length === 1); assert.equal(first[0].rowHeight, 21.78); assert.equal(first[0].columnWidth, 87.12);
    await shot(a.p, "row8-new-worksheet");
    await writeFile(join(diagnostics, "row8-ui.txt"), await a.p.locator("body").innerText());
    await a.p.getByRole("button", { name: "新增工作表", exact: true }).click();
    await until(async () => (await project(doc.id)).value.sheetOrder.length === 2, "native add sheet");
    const appended = dimensions((await project(doc.id)).value); assert(appended.every((s: any) => s.rowHeight === 21.78 && s.columnWidth === 87.12));
    await a.p.reload(); await a.p.locator(".uos-editor__select-all").waitFor(); assert.deepEqual(dimensions((await project(doc.id)).value), appended);
    return { first, appended, screenshot: await shot(a.p, "row8-added-worksheet") };
  });
  if (stages.has("link")) await run([6], "native hyperlink cancellation and confirmed roundtrip", async () => {
    const doc = await create("spreadsheet", "Hyperlink cancel QA"), a = await open(doc.id, ".uos-editor__select-all"), b = await open(doc.id, ".uos-editor__select-all"); current = a.p;
    await a.p.evaluate(`(() => {
      const events = [];
      window.__qaLinkDOM = events;
      const describe = element => element instanceof HTMLElement ? { tag: element.tagName, id: element.id, label: element.getAttribute("aria-label"), value: "value" in element ? element.value : element.textContent?.slice(0, 200) } : null;
      const originalFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function(...args) { events.push({time:performance.now(),type:'focus-call',target:describe(this),stack:new Error().stack}); return originalFocus.apply(this,args); };
      for (const type of ["focusin", "focusout", "beforeinput", "input", "keydown"]) document.addEventListener(type, event => events.push({ time: performance.now(), type, target: describe(event.target), active: describe(document.activeElement), data: event.data, key: event.key, focused: document.hasFocus() }), true);
    })()`);
    const initial = (await project(doc.id)).value, before = a.updates.length;
    const dialog = () => a.p.getByRole("dialog", { name: "插入超链接", exact: true });
    const openLink = async () => { await a.p.bringToFront(); await select(a.p, "A1"); await a.p.getByRole("button", { name: "插入", exact: true }).click(); await a.p.getByRole("menuitem", { name: "超链接", exact: true }).click(); await dialog().waitFor(); };
    for (const method of ["cancel", "close", "escape", "outside"]) {
      await openLink(); await dialog().getByRole("textbox", { name: "链接显示文字", exact: true }).fill("Unsaved draft"); await dialog().getByRole("textbox", { name: "链接地址", exact: true }).fill("https://example.com/unsaved");
      assert.equal(await dialog().getByRole("textbox", { name: "链接显示文字", exact: true }).inputValue(), "Unsaved draft");
      assert.equal(await dialog().getByRole("textbox", { name: "链接地址", exact: true }).inputValue(), "https://example.com/unsaved");
      if (method === "cancel") await dialog().getByRole("button", { name: "取消", exact: true }).click();
      if (method === "close") await a.p.getByRole("button", { name: "关闭工具栏菜单", exact: true }).click();
      if (method === "escape") await dialog().getByRole("textbox", { name: "链接地址", exact: true }).press("Escape");
      if (method === "outside") await a.p.locator(".document-title-edit").click();
      await dialog().waitFor({ state: "hidden" }); await a.p.keyboard.press("Escape"); await select(a.p, "A2");
      assert.deepEqual((await project(doc.id)).value, initial); assert.equal(a.updates.length, before); assert.equal(b.updates.length, 0);
    }
    await openLink(); await dialog().getByRole("textbox", { name: "链接显示文字", exact: true }).fill("Verified link"); await dialog().getByRole("textbox", { name: "链接地址", exact: true }).fill("https://example.com/verified");
    await writeFile(join(diagnostics, "row6-link-dom-events.json"), JSON.stringify(await a.p.evaluate(() => ({ events: (window as any).__qaLinkDOM, active: document.activeElement?.outerHTML, focused: document.hasFocus(), inputs: [...document.querySelectorAll('.uos-inline-insert-form input')].map((el) => ({ label: el.getAttribute('aria-label'), value: (el as HTMLInputElement).value })) })), null, 2));
    assert.equal(await dialog().getByRole("textbox", { name: "链接显示文字", exact: true }).inputValue(), "Verified link");
    assert.equal(await dialog().getByRole("textbox", { name: "链接地址", exact: true }).inputValue(), "https://example.com/verified");
    await dialog().getByRole("button", { name: "插入链接", exact: true }).click(); await a.p.keyboard.press("Enter");
    const linked = async () => JSON.stringify((await project(doc.id)).value).includes("https://example.com/verified"); await until(linked, "confirmed link durable"); await saved(a.p);
    await a.p.getByRole("button", { name: "撤销", exact: true }).click(); await until(async () => !(await linked()), "link undo"); await a.p.getByRole("button", { name: "重做", exact: true }).click(); await until(linked, "link redo");
    await a.p.reload(); await a.p.locator(".uos-editor__select-all").waitFor(); assert(await linked()); assert.equal(b.updates.length, 0);
    return { cancelPaths: ["cancel", "close", "escape", "outside"], cancelWrites: 0, remoteEcho: 0, screenshot: await shot(a.p, "row6-saved-link") };
  });
  if(stages.has("heading"))await run([2],"heading Enter creates normal paragraphs at end/middle/empty; text survives peer/reload",async()=>{
    const doc=await createContent(db).create(owner,{kind:"document",format:"rich_text",title:"Heading Enter QA",initialContent:{schemaVersion:2,children:[{id:"head-title",type:"paragraph",children:[{text:"Heading Enter QA"}]},{id:"head-one",type:"paragraph",title:"h1",children:[{text:"Heading one ending"}]},{id:"head-two",type:"paragraph",title:"h2",children:[{text:"Heading two ending"}]},{id:"head-middle",type:"paragraph",title:"h3",children:[{text:"SplitHeadingSample"}]},{id:"head-empty",type:"paragraph",title:"h4",children:[{text:""}]},{id:"head-tail",type:"paragraph",children:[{text:"Tail paragraph"}]}]}});
    const a=await open(doc.id,".sk-editable"),b=await open(doc.id,".sk-editable");current=a.p;
    const value=async()=>(await project(doc.id)).value;
    const caret=()=>a.p.evaluate(()=>{const s=getSelection(),el=s?.anchorNode?.parentElement;return {block:el?.closest('[data-block-id]')?.getAttribute('data-block-id'),offset:s?.anchorOffset,length:s?.anchorNode?.textContent?.length,collapsed:s?.isCollapsed,editable:!!el?.closest('[data-slate-editor]')};});
    const move=async(id:string,end:boolean)=>{for(let n=0;n<100;n++){const s=await caret();if(s.block===id&&s.collapsed&&s.offset===(end?s.length:0))return;await a.p.keyboard.press(end?"ArrowRight":"ArrowLeft");}throw Error("Unable to move actual caret: "+JSON.stringify(await caret()));};
    await writeFile(join(diagnostics,"row2-initial.json"),JSON.stringify(await value(),null,2));await a.p.bringToFront();
    for(const [id,text]of [["head-one","Body after H1"],["head-two","Body after H2"]]){
      await a.p.locator(`[data-block-id="${id}"] [data-slate-string]`).click();await move(id,true);await a.p.keyboard.press("Enter");await delay(100);await writeFile(join(diagnostics,`row2-after-${id}.json`),JSON.stringify({value:await value(),caret:await caret()},null,2));
      await until(async()=>{const v=await value(),index=v.findIndex((x:any)=>x.id===id);return index>=0&&v[index+1]?.type==="paragraph"&&!v[index+1]?.title},"heading end resets block type");
      await a.p.keyboard.insertText(text);await until(async()=>JSON.stringify(await value()).includes(text),"new body durable");await b.p.getByText(text,{exact:true}).waitFor();
    }
    await a.p.locator('[data-block-id="head-middle"] [data-slate-string]').click();const middle=await caret();assert(middle.block==="head-middle"&&middle.offset!>0&&middle.offset!<middle.length!,JSON.stringify(middle));await a.p.keyboard.press("Enter");
    await until(async()=>{const v=await value(),i=v.findIndex((x:any)=>x.id==="head-middle");return i>=0&&v[i].title==="h3"&&v[i+1]?.type==="paragraph"&&!v[i+1]?.title&&v[i].children[0].text+v[i+1]?.children[0].text==="SplitHeadingSample"},"middle split leaves source heading and new body paragraph");
    await a.p.locator('[data-block-id="head-empty"] h4').click();await a.p.keyboard.press("Enter");await until(async()=>{const v=await value(),i=v.findIndex((x:any)=>x.id==="head-empty");return i>=0&&v[i+1]?.type==="paragraph"&&!v[i+1]?.title},"empty heading Enter creates body paragraph");
    await saved(a.p);const final=await value();assert.equal(b.updates.length,0);await shot(a.p,"row2-heading-enter");await a.p.reload();await a.p.locator(".sk-editable").waitFor();assert.deepEqual(await value(),final);
    return {endLevels:[1,2],middleLevel:3,middleNewBlock:"paragraph without title; source text preserved",emptyLevel:4,emptyNewBlock:"paragraph without title",remoteEcho:0,screenshot:"row2-heading-enter.png"};
  });
  if (stages.has("diagram")) await run([11], "flowchart double-click selects full node and edge labels", async () => {
    const doc = await createContent(db).create(owner, { kind: "document", format: "rich_text", title: "Flowchart label QA", initialContent: { schemaVersion: 2, children: [{ id: "title", type: "paragraph", children: [{ text: "Flowchart label QA" }] }, { id: "flow", type: "flowchart", nodes: [{ id: "start", label: "Original start label", x: 0, y: 0 }, { id: "end", label: "Original end label", x: 260, y: 0 }], edges: [{ id: "edge", source: "start", target: "end", label: "Original edge label" }], children: [{ text: "" }] }, { id: "tail", type: "paragraph", children: [{ text: "After flowchart" }] }] } });
    const a = await open(doc.id, ".sk-block-flowchart .sk-diagram-figure img"), b = await open(doc.id, ".sk-block-flowchart .sk-diagram-figure img"); current = a.p;
    await a.p.getByRole("button", { name: "编辑流程图", exact: true }).click();
    await a.p.locator(".x6-node").first().waitFor();
    const selections=[];
    for (const [selector, label] of [['.x6-node[data-cell-id="start"]', "Replacement node"], ['.x6-edge[data-cell-id="edge"] text', "Replacement edge"]]) {
      const target = await a.p.locator(selector).first().boundingBox(); assert(target); await a.p.mouse.dblclick(target.x+target.width/2,target.y+target.height/2); const text = a.p.locator("textarea.sk-diagram-inline-editor"); await text.waitFor();
      const s = await text.evaluate(el => { const t = el as HTMLTextAreaElement; return { value: t.value, start: t.selectionStart, end: t.selectionEnd }; }); assert.equal(s.start, 0); assert.equal(s.end, s.value.length); selections.push(s);
      await a.p.keyboard.insertText(label); await text.press("Enter");
    }
    const workspace=a.p.locator(".sk-diagram-modal");await workspace.getByRole("button",{name:"撤销",exact:true}).click();await workspace.getByRole("button",{name:"重做",exact:true}).click();
    await shot(a.p, "row11-replaced-labels"); await writeFile(join(diagnostics, "row11-ui.txt"), await a.p.locator("body").innerText());
    await a.p.getByRole("button", { name: "保存并返回文档", exact: true }).click();
    await until(async () => JSON.stringify((await project(doc.id)).value).includes("Replacement edge"), "native graph save"); await saved(a.p); assert.equal(b.updates.length, 0);
    await b.p.getByRole("button",{name:"编辑流程图",exact:true}).click();await b.p.locator('.x6-node[data-cell-id="start"]').first().dblclick();const peerText=b.p.locator("textarea.sk-diagram-inline-editor");await peerText.waitFor();assert.equal(await peerText.inputValue(),"Replacement node");await peerText.press("Escape");await b.p.getByRole("button",{name:"关闭图示编辑器",exact:true}).click();assert.equal(b.updates.length,0);
    await a.p.reload(); await a.p.locator(".sk-block-flowchart .sk-diagram-figure img").waitFor();
    const value = JSON.stringify((await project(doc.id)).value); assert(value.includes("Replacement node") && value.includes("Replacement edge")); assert(!value.includes("Original start labelReplacement"));
    return { selections, remoteEcho: 0, screenshot: await shot(a.p, "row11-reloaded-flowchart") };
  });
  if (stages.has("filter")) await run([23, 33, 34, 56], "native dropdown value under shared filter across clients/reload", async () => {
    const doc = await create("spreadsheet", "Dropdown filter QA");
    await request(`/resources/${doc.id}/permissions`, { version: doc.version, visibility: "invited", accessMode: "custom", grants: [{ userId: empty.id, role: "editor" }] }, "PUT");
    const a = await open(doc.id, ".uos-editor__select-all"), b = await open(doc.id, ".uos-editor__select-all",peerContext); current = a.p;
    await select(a.p, "A1"); await context.grantPermissions(["clipboard-read", "clipboard-write"]); await a.p.evaluate(() => navigator.clipboard.writeText("事项\t状态\n任务甲\t待解决\n任务乙\t已解决\n任务丙\t解决中\n任务丁\t待解决")); await a.p.keyboard.press("ControlOrMeta+v");
    await until(async () => JSON.stringify((await project(doc.id)).value).includes("任务丁"), "native pasted data");
    await select(a.p, "B2:B5"); await a.p.getByRole("button", { name: "插入", exact: true }).click(); await a.p.getByRole("menuitem", { name: "下拉列表", exact: true }).click();
    const dd = a.p.getByRole("dialog", { name: "下拉列表", exact: true }); await dd.waitFor();
    for(let n=1;n<=3;n++){ if(!(await dd.getByRole("textbox",{name:`选项 ${n}`,exact:true}).count()))await dd.getByRole("button",{name:"新增选项",exact:true}).click(); await dd.getByRole("textbox",{name:`选项 ${n}`,exact:true}).fill(["待解决","解决中","已解决"][n-1]!); }
    await dd.getByRole("button",{name:"确认",exact:true}).click(); await dd.waitFor({state:"detached"}); await saved(a.p);
    await select(a.p, "A1:B5"); await a.p.getByRole("button", { name: "筛选", exact: true }).click(); await saved(a.p); await select(a.p,"D8");
    await shot(a.p,"row23-filter-inactive-range");
    const grid = a.p.locator('canvas[id^="univer-sheet-main-canvas_"]');
    await grid.click({position:{x:48+2*87.12-9,y:22+10}}); await delay(350);
    await writeFile(join(diagnostics,"row56-filter-menu.txt"),await a.p.locator("body").innerText()); await shot(a.p,"row56-filter-menu");
    const panel=a.p.locator('[data-u-comp="sheets-filter-panel"]').first(); await panel.waitFor();
    const excluded=panel.getByText("已解决",{exact:true}).locator("..").locator("..").locator("..");
    await excluded.locator('label[data-u-comp="checkbox"]').click();assert.equal(await excluded.locator('input[type="checkbox"]').isChecked(),false);
    await panel.getByRole("button",{name:"确认",exact:true}).click(); await panel.waitFor({state:"detached"}); await saved(a.p);
    await until(async()=>JSON.stringify((await project(doc.id)).value.resources).includes('filterColumns\\\":[')&&JSON.stringify((await project(doc.id)).value.resources).includes('待解决'),"filter criteria persisted");
    const nativeSnapshot=await project(doc.id); await writeFile(join(output,"row56-filter-projection.json"),JSON.stringify(nativeSnapshot.value,null,2));
    const activeCell=async(p:Page)=>p.locator(".uos-editor").getByRole("textbox",{exact:true}).inputValue();
    const visibleCell=async(p:Page,visibleRow:number,cell:string,label:string)=>{await p.keyboard.press("Escape");await p.locator('canvas[id^="univer-sheet-main-canvas_"]').click({position:{x:64,y:22+(visibleRow-1)*21.78+9}});await p.keyboard.press("Escape");await until(async()=>await activeCell(p)===cell,label);};
    await visibleCell(a.p,3,"A4","local filtered row3 is hidden");
    await visibleCell(b.p,3,"A4","other account receives shared filter");
    await shot(a.p,"row56-before-dropdown-change"); await shot(b.p,"row56-peer-shared-filter");
    await select(a.p,"B2");
    await grid.click({position:{x:48+87.12+60,y:22+21.78+10}}); await delay(250);
    await writeFile(join(diagnostics,"row56-dropdown-menu.txt"),await a.p.locator("body").innerText()); await shot(a.p,"row56-dropdown-menu");
    await a.p.getByText("已解决",{exact:true}).click();
    await until(async()=>{const x=(await project(doc.id)).value;return x.sheets[x.sheetOrder[0]].cellData[1][1].v==="已解决"},"native dropdown commits excluded value"); await saved(a.p);
    await visibleCell(a.p,2,"A4","local row2 hides immediately after dropdown");
    await visibleCell(b.p,2,"A4","peer row2 hides after remote dropdown edit");
    await shot(a.p,"row56-after-dropdown-change");await shot(b.p,"row56-peer-after-change");
    await a.p.getByRole("button",{name:"撤销",exact:true}).click();await visibleCell(a.p,2,"A2","dropdown undo restores included row");await visibleCell(b.p,2,"A2","peer undo filter refresh");
    await a.p.getByRole("button",{name:"重做",exact:true}).click();await visibleCell(a.p,2,"A4","dropdown redo hides row");await visibleCell(b.p,2,"A4","peer redo filter refresh");
    const finalSeq=await seq(doc.id),echo=b.updates.length;assert.equal(echo,0);
    await a.p.reload();await a.p.locator(".uos-editor__select-all").waitFor();await saved(a.p);await visibleCell(a.p,2,"A4","reload retains filter projection");await shot(a.p,"row56-reloaded-filter");
    assert.equal(await seq(doc.id),finalSeq,"reload/selection must not write");assert.equal(b.updates.length,0);
    const plain=await create("spreadsheet","Plain cell shared filter QA");await request(`/resources/${plain.id}/permissions`,{version:plain.version,visibility:"invited",accessMode:"custom",grants:[{userId:empty.id,role:"editor"}]},"PUT");
    const pa=await open(plain.id,".uos-editor__select-all"),pb=await open(plain.id,".uos-editor__select-all",peerContext);current=pa.p;
    await select(pa.p,"A1");await pa.p.evaluate(()=>navigator.clipboard.writeText("事项\t状态\n普通甲\t待解决\n普通乙\t已解决\n普通丙\t解决中\n普通丁\t待解决"));await pa.p.keyboard.press("ControlOrMeta+v");await until(async()=>JSON.stringify((await project(plain.id)).value).includes("普通丁"),"plain grid paste");
    await select(pa.p,"A1:B5");await pa.p.getByRole("button",{name:"筛选",exact:true}).click();await saved(pa.p);await select(pa.p,"D8");
    await pa.p.locator('canvas[id^="univer-sheet-main-canvas_"]').click({position:{x:48+2*87.12-9,y:32}});const pp=pa.p.locator('[data-u-comp="sheets-filter-panel"]').first();await pp.waitFor();const ex=pp.getByText("已解决",{exact:true}).locator("..").locator("..").locator("..");await ex.locator('label[data-u-comp="checkbox"]').click();assert.equal(await ex.locator('input[type="checkbox"]').isChecked(),false);await pp.getByRole("button",{name:"确认",exact:true}).click();await pp.waitFor({state:"detached"});
    await visibleCell(pa.p,3,"A4","plain local filter hides resolved row");await visibleCell(pb.p,3,"A4","plain peer receives criteria");const originWrites=pa.updates.length;
    await select(pb.p,"B2");await pb.p.keyboard.press("F2");await pb.p.keyboard.press("ControlOrMeta+a");await pb.p.keyboard.insertText("已解决");await pb.p.keyboard.press("Enter");await until(async()=>{const v=(await project(plain.id)).value;return v.sheets[v.sheetOrder[0]].cellData[1][1].v==="已解决"},"ordinary cell typed status durable");
    await visibleCell(pb.p,2,"A4","plain editor immediately hides row");await visibleCell(pa.p,2,"A4","plain remote cell update hides row");assert.equal(pa.updates.length,originWrites,"plain remote update echo");
    await shot(pa.p,"row33-plain-remote-filter");await shot(pb.p,"row33-plain-editor-filter");const plainSeq=await seq(plain.id);await pa.p.reload();await pa.p.locator(".uos-editor__select-all").waitFor();await saved(pa.p);await visibleCell(pa.p,2,"A4","plain shared filter reload");assert.equal(await seq(plain.id),plainSeq);await shot(pa.p,"row33-plain-filter-reloaded");
    return {criteria:"include 待解决 and 解决中, exclude 已解决",dropdown:{initialHiddenPhysicalRow3:"A4",afterDropdownHiddenPhysicalRow2:"A4",otherAccount:true,remoteEcho:echo,refreshWrites:0,undoRedo:true,screenshot:"row56-reloaded-filter.png"},ordinary:{editor:"other account",afterTypedValuePhysicalRow2:"A4",remoteEcho:0,refreshWrites:0,screenshot:"row33-plain-filter-reloaded.png"}};
  });
  if(process.env.DOCA_QA_IDLE!=="0")await run([2,4,5,6,8,11,23,33,34,56],"60 seconds idle after actual editing/selection/resize has no content writes",async()=>{
    const heads=new Map(await Promise.all([...resources].map(async id=>[id,await seq(id)] as const))),counts=observed.map(x=>x.updates.length);
    for(let n=0;n<2;n++){await delay(30000);console.log("Idle observation",(n+1)*30,"seconds");}
    for(const [id,head]of heads)assert.equal(await seq(id),head,"idle head changed");assert.deepEqual(observed.map(x=>x.updates.length),counts);return {seconds:60,documents:heads.size,clients:observed.length,contentUpdates:0};
  });
} finally {
  let runtimeUnchanged = false;
  try { const after = await fingerprints(); await writeFile(join(output, "runtime-after.json"), JSON.stringify(after, null, 2) + "\n"); assert.deepEqual(after, runtimeBefore, "No package/lock/build/source change may occur during a verification run"); runtimeUnchanged = true; }
  catch (error) { checks.push({ rows: [], label: "runtime fingerprints unchanged", result: "failed", error: String(error) }); }
  if (providerRequests) checks.push({ rows: [], label: "native gate makes zero model requests", result: "failed", providerRequests });
  await writeFile(join(output, "results.json"), JSON.stringify({ result: checks.some(x=>x.result==="failed") || errors.length ? "failed":"passed", scope: "isolated actual Doca website; synthetic users/documents only; no paid models", webMode: builtWeb ? "production-build" : "development-server", indexSha256: runtimeBefore.web?.indexSha256, lockSha256: runtimeBefore.lockSha256, runtimeUnchanged, runtimeFiles: ["runtime-before.json", "runtime-after.json"], editorTrees: runtimeBefore.editors.map(({name,version,fileCount,treeSha256})=>({name,version,fileCount,treeSha256})), sheetArtifact, requestedStages: [...stages], packages: Object.fromEntries(Object.entries(packages).filter(([n])=>["@smartdoca/canvas","@smartdoca/slate","@smartdoca/sheet","@smartdoca/markdown","@smartdoca/slides"].includes(n))), checks, pageErrors: errors, providerRequests, productionAccepted: false }, null, 2)+"\n");
  await browser.close(); await web?.close(); await app.close(); await db.destroy(); await rm(temporary,{recursive:true,force:true});
}
if(checks.some(x=>x.result==="failed")||errors.length)process.exitCode=1;
