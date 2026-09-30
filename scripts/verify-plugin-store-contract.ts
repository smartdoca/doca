/** Run against a sibling marketplace checkout; all data stays in memory. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginStore, StoreCursorExpired } from "../apps/server/src/plugins/store.js";
const root = resolve(process.argv[2] ?? "../doca-plugin-store");
const { createApp } = await import(pathToFileURL(resolve(root, "server/app.ts")).href);
const { fixture, addRelease } = await import(pathToFileURL(resolve(root, "tests/helpers.ts")).href);
const db = fixture();
addRelease(db, "example.mail", "1.0.0", { mobile: true });
addRelease(db, "example.mail", "1.1.0", { mobile: true });
addRelease(db, "example.tools", "1.0.0", {category: "developer"});
const {app} = createApp(db, {rateLimit: false});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(r => server.once("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const store = new PluginStore("https://contract.test", (async (input, init) => fetch(String(input).replace("https://contract.test", origin), init)) as typeof fetch);
try {
  const categories = await store.categories("en");
  assert.equal(categories.items.find(c => c.id === "developer")?.count, 1);
  assert.equal(categories.items.find(c => c.id === "other")?.count, 0);
  const first = await store.catalog({limit: 1, sort: "name"});
  assert.equal(first.items.length, 1);
  const next = await store.catalog({limit: 1, sort: "name", cursor: first.page.nextCursor!});
  assert.notEqual(first.items[0]!.id, next.items[0]!.id);
  assert.equal((await store.catalog({category: "developer", target: "web"})).items[0]!.id, "example.tools");
  assert.equal((await store.catalog({q: "mail", target: "mobile"})).items.length, 1);
  assert.equal((await store.detail("example.mail")).description.format, "doca-slate");
  assert.equal((await store.releases("example.mail")).items.length, 2);
  const update = await store.updates([{id: "example.mail", version:"1.0.0", dataVersion:"1"}]);
  assert.equal(update.items[0]!.release?.version, "1.1.0");
  db.prepare("UPDATE snapshots SET expires_at=0").run();
  await assert.rejects(store.catalog({limit:1, sort:"name", cursor:first.page.nextCursor!}), StoreCursorExpired);
  console.log("Marketplace → Doca contract verified: categories, zero counts, filters, pagination, details, releases, updates, cursor expiry.");
} finally { await new Promise<void>((r,j) => server.close((e: Error) => e ? j(e) : r())); db.close(); }
