import { createPublicDocumentReads } from "@core/modules/documents/public-read.js";
import { createContent } from "@core/workflows/resources.js";
import { createDocuments } from "@core/modules/collaboration/documents.js";
import { MARKDOWN_CODEC } from "@core/modules/documents/codecs/markdown.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { discoverInstalledPlugins, importInstalledPlugins } from "@server/plugins/installation.js";
import { createApp } from "@server/app/create-app.js";
import { openTestDatabase } from "./database.js";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture(options: { range?: string; server?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "doca-install-")); folders.push(root);
  const pkg = join(root, "example.demo");
  await mkdir(join(pkg, "web"), { recursive: true });
  const manifest = { schemaVersion: 1, id: "example.demo", version: "1.0.0", displayName: "Demo", sdkRange: options.range ?? "^0.1.0" };
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@example/demo", version: "1.0.0", type: "module", doca: { dataVersion: "1", manifest: "./manifest.json", server: options.server ?? "./server.js", web: { directory: "./web", entry: "./index.js" } } }));
  await writeFile(join(pkg, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(pkg, "web/index.js"), "export default ({React}) => ({manifest: {pluginId: 'example.demo', version: '1.0.0', targets: ['web']}});");
  await writeFile(join(pkg, "server.js"), `export default () => ({ manifest: ${JSON.stringify(manifest)}, async uninstall() {}, async mount(ctx) { const http = ctx.inject({id: 'http.v1'}); await ctx.effectAsync(() => http.register('example.demo', [{method:'GET',path:'/snapshot',async handle(req){return ctx.inject({id:'documents.read.v1'}).readSnapshot(req,{documentId:req.query.id})}},{method:'POST',path:'/large',bodyLimit:2097152,handle(req){return {length:req.rawBody.length}}},{method:'GET',path:'/me',async handle(req) {const profile = await ctx.inject({id:'users.v1'}).get(req,req.principal.id); const folders = await ctx.inject({id:'files.v1'}).folders.list({principalId:req.principal.id,signal:req.signal},{parentId:null}); return {profile,folders}}},{method:'GET',path:'/callback',auth:'external',verify(req) { return req.query.state === 'valid' }, handle(req,res) {res.header('Set-Cookie','demo=ok; HttpOnly; SameSite=Lax'); res.redirect(http.callbackUrl('example.demo','/me'));}},{method:'POST',path:'/hook',auth:'external',verify(req) {return req.headers['x-signature'] === 'test-signature' && new TextDecoder().decode(req.rawBody) === '{\"event\":1}'}, handle(req,res) {res.status(202); return {received:true, anonymous:req.principal===null}}}])); } });`);
  return { root, pkg };
}
it("discovers only direct packages and validates their static manifests before importing", async () => {
  const { root } = await fixture({ range: "^9.0.0" });
  const found = await discoverInstalledPlugins(root);
  expect(found).toHaveLength(1);
  await expect(importInstalledPlugins(found)).rejects.toThrow("requires Doca SDK");
  expect(await discoverInstalledPlugins(root, { disabled: { "example.demo": false } })).toEqual([]);
});
it("rejects package entry traversal and symlink escape", async () => {
  const { root, pkg } = await fixture({ server: "./outside.js" });
  await writeFile(join(root, "outside.js"), "throw new Error('must not execute')");
  await symlink(join(root, "outside.js"), join(pkg, "outside.js"));
  await expect(discoverInstalledPlugins(root)).rejects.toThrow("escapes");
});
it("mounts an independently installed JS plugin, serves only its Web root and requires authentication", async () => {
  const { root } = await fixture();
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const app = await createApp(db, { origin: "http://127.0.0.1:39130", pluginDirectory: root });
  try {
    const headers = { host: "127.0.0.1:39130" };
    const bootstrap = await app.inject({ url: "/api/v1/bootstrap", headers });
    expect(bootstrap.json().plugins).toContainEqual({ id: "example.demo", version: "1.0.0", web: "/api/v1/plugin-assets/example.demo/1.0.0/index.js" });
    expect((await app.inject({ url: "/api/v1/plugins/example.demo/me", headers })).statusCode).toBe(401);
    const user = await createUser(db, { login: "plugin-owner", displayName: "Plugin owner", password: "test-password-2026" }, { bootstrap: true });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { ...headers, origin: "http://127.0.0.1:39130" }, payload: { login: "plugin-owner", password: "test-password-2026" } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    for (const _ of [1, 2]) {
      const result = await app.inject({ url: "/api/v1/plugins/example.demo/me", headers: { ...headers, cookie } });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({ profile: { id: user.id, login: "plugin-owner", profile: {} }, folders: { items: [] } });
      expect(result.body).not.toContain("password_hash");
    }
    const actor = { ...user, admin: 1 };
    const doc = await createContent(db).create(actor, { kind: "document", format: "markdown", title: "Public snapshot" });
    await createDocuments(db).exchange(actor, doc.id, MARKDOWN_CODEC);
    const call = (operation: string, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/v1/plugin-platform/example.demo/${operation}`, headers: { ...headers, origin: "http://127.0.0.1:39130", cookie }, payload });
    const snapshot = await call("documents.readSnapshot", { documentId: doc.id });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const expected = await createPublicDocumentReads(db).readSnapshot({ requestId: "test", principal: { id: user.id, publicId: "", displayName: user.display_name, admin: true }, signal: new AbortController().signal }, { documentId: doc.id });
    expect(snapshot.json()).toEqual(expected);
    const injected = await app.inject({ url: `/api/v1/plugins/example.demo/snapshot?id=${doc.id}`, headers: { ...headers, cookie } });
    expect(injected.statusCode, injected.body).toBe(200);
    expect(injected.json()).toEqual(expected);
    expect((await call("documents.readSnapshot", { documentId: doc.id, expectedRevision: "old" })).statusCode).toBe(409);
    expect((await call("files.folders.list", { parentId: null })).json()).toEqual({ items: [], cursor: null });
    expect((await call("libraries.list")).statusCode).toBe(200);
    expect((await call("users.searchPage", { query: "", mode: "all" })).statusCode).toBe(400);
    expect((await call("documents.purge", { documentId: doc.id })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/plugin-platform/example.demo/users.me", headers: { ...headers, origin: "http://127.0.0.1:39130" }, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/plugin-platform/unknown.plugin/users.me", headers: { ...headers, origin: "http://127.0.0.1:39130", cookie }, payload: {} })).statusCode).toBe(404);
    const large = await app.inject({method:"POST",url:"/api/v1/plugins/example.demo/large",headers:{...headers,origin:"http://127.0.0.1:39130",cookie,"content-type":"text/plain"},payload:"a".repeat(1500000)});
    expect(large.statusCode,large.body).toBe(200);expect(large.json().length).toBe(1500000);
    const callback = await app.inject({ url: "/api/v1/plugins/example.demo/callback?state=valid", headers });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("http://127.0.0.1:39130/api/v1/plugins/example.demo/me");
    expect(callback.headers["set-cookie"]).toContain("HttpOnly");
    expect((await app.inject({ url: "/api/v1/plugins/example.demo/callback?state=invalid", headers })).statusCode).toBe(401);
    const hook = await app.inject({ method: "POST", url: "/api/v1/plugins/example.demo/hook", headers: { ...headers, "content-type": "application/json", "x-signature": "test-signature" }, payload: '{"event":1}' });
    expect(hook.statusCode, hook.body).toBe(202);
    expect(hook.json()).toEqual({ received: true, anonymous: true });
    expect((await app.inject({ method: "POST", url: "/api/v1/plugins/example.demo/hook", headers, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/plugins/example.demo/hook", headers: { host: "evil.test" }, payload: {} })).statusCode).toBe(421);
    const asset = await app.inject({ url: "/api/v1/plugin-assets/example.demo/1.0.0/index.js", headers });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect((await app.inject({ url: "/api/v1/plugin-assets/example.demo/1.0.0/server.js", headers })).statusCode).toBe(404);
  } finally { await app.close(); await db.destroy(); }
});

it("uses the configured plugin directory and falls back for empty environment values", async () => {
  const { pluginDirectory } = await import("@server/plugins/installation.js");
  const { resolve } = await import("node:path");
  const oldPlugins = process.env.DOCA_PLUGINS_DIR, oldData = process.env.DOCA_DATA_DIR;
  try {
    process.env.DOCA_PLUGINS_DIR = "  ./external-plugins  ";
    expect(pluginDirectory()).toBe(resolve("external-plugins"));
    process.env.DOCA_PLUGINS_DIR = "  "; process.env.DOCA_DATA_DIR = "./custom-data";
    expect(pluginDirectory()).toBe(resolve("custom-data/plugins"));
    delete process.env.DOCA_PLUGINS_DIR; delete process.env.DOCA_DATA_DIR;
    expect(pluginDirectory()).toBe(resolve("data/plugins"));
  } finally {
    if (oldPlugins === undefined) delete process.env.DOCA_PLUGINS_DIR; else process.env.DOCA_PLUGINS_DIR = oldPlugins;
    if (oldData === undefined) delete process.env.DOCA_DATA_DIR; else process.env.DOCA_DATA_DIR = oldData;
  }
});
