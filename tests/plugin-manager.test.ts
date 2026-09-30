import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { openTestDatabase } from "./database.js";
import { PluginManager } from "@server/plugins/manager.js";
import { PluginStore } from "@server/plugins/store.js";
import { digest, unpack } from "@server/plugins/archive.js";
import { createApp } from "@server/app/create-app.js";
import { createUser } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";

const dirs: string[] = [],
  dbs: DB[] = [];
afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.destroy()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "doca-plugin-manager-"));
  dirs.push(dir);
  return dir;
}
async function database() {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  dbs.push(db);
  return db;
}
function bundle(
  version = "1.0.0",
  dataVersion = "1",
  id = "example.demo",
  dependencies: any[] = [],
) {
  const manifest = {
    schemaVersion: 1,
    id,
    version,
    displayName: "Demo",
    sdkRange: "^0.1.0",
    dependencies,
  };
  return zipSync(
    {
      "package.json": strToU8(
        JSON.stringify({
          name: `@example/${id}`,
          version,
          type: "module",
          doca: {
            dataVersion,
            manifest: "./manifest.json",
            server: "./server.js",
            web: { directory: "./web", entry: "./index.js" },
          },
        }).replace(`@example/${id}`, id),
      ),
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "server.js": strToU8(
        `export default () => ({ manifest: ${JSON.stringify(manifest)} });`,
      ),
      "web/index.js": strToU8(
        `export default () => ({manifest: { pluginId: '${id}', version: '${version}', targets:['web']}});`,
      ),
      "web/chunk.js": strToU8("export const value = 42;"),
    },
    { mtime: new Date("2020-01-01T00:00:00Z") },
  );
}
it("synchronizes uploads to a second empty instance and repairs partial/corrupt caches before loading", async () => {
  const db = await database(),
    a = await directory(),
    b = await directory();
  const first = new PluginManager(a, [], db);
  await first.prepare();
  await first.confirm();
  const bytes = bundle();
  expect((await first.install(bytes, "local")).restartRequired).toBe(true);
  const second = new PluginManager(b, [], db);
  const plugins = await second.prepare();
  await second.confirm();
  expect(plugins[0]!.manifest.id).toBe("example.demo");
  expect((await second.inventory()).plugins[0]!.runningVersion).toBe("1.0.0");
  expect((await first.inventory()).plugins[0]!.runningVersion).toBeNull();
  const root = plugins[0]!.root;
  await writeFile(join(root, "web/chunk.js"), "corrupt");
  await rm(join(root, "server.js"));
  const restarted = new PluginManager(b, [], db);
  await restarted.prepare();
  await restarted.confirm();
  expect(await readFile(join(root, "web/chunk.js"), "utf8")).toBe(
    "export const value = 42;",
  );
  expect(await readFile(join(root, "server.js"), "utf8")).toContain(
    "export default",
  );
  await db
    .updateTable("plugin_archives")
    .set({ content: Buffer.from("broken").toString("base64") })
    .execute();
  await expect(
    new PluginManager(await directory(), [], db).prepare(),
  ).rejects.toThrow("checksum");
});
it("upgrades without touching running code and retains data compatibility after uninstall", async () => {
  const db = await database(),
    dir = await directory();
  const installer = new PluginManager(dir, [], db);
  await installer.install(bundle(), "local");
  const running = new PluginManager(dir, [], db);
  const [old] = await running.prepare();
  await running.confirm();
  await running.install(bundle("1.1.0"), "local");
  expect((await running.inventory()).plugins[0]).toMatchObject({
    version: "1.1.0",
    runningVersion: "1.0.0",
    pending: true,
  });
  expect(await readFile(old!.server, "utf8")).toContain('"version":"1.0.0"');
  await expect(running.install(bundle("1.2.0", "2"), "local")).rejects.toThrow(
    "data structure",
  );
  await expect(running.install(bundle("1.0.0"), "local")).rejects.toThrow();
  const newInstance = new PluginManager(await directory(), [], db);
  await newInstance.prepare();
  await newInstance.confirm();
  expect(
    (await newInstance.assetPlugin("example.demo", "1.0.0"))!.manifest.version,
  ).toBe("1.0.0");
  await newInstance.change("example.demo", "remove");
  const emptyInstance = new PluginManager(await directory(), [], db);
  expect(await emptyInstance.prepare()).toEqual([]);
  await emptyInstance.confirm();
  expect((await emptyInstance.inventory()).plugins).toEqual([]);
  await expect(
    emptyInstance.install(bundle("2.0.0", "2"), "local"),
  ).rejects.toThrow("data structure");
  expect(
    await db.selectFrom("plugin_archives").selectAll().execute(),
  ).toHaveLength(2);
});
it("validates enabled dependency graphs and refuses concurrent lost updates", async () => {
  const db = await database();
  const a = new PluginManager(await directory(), [], db),
    b = new PluginManager(await directory(), [], db);
  await a.install(bundle(), "local");
  await a.install(
    bundle("1.0.0", "1", "example.consumer", [
      { id: "example.demo", range: "^1.0.0" },
    ]),
    "local",
  );
  await expect(a.change("example.demo", "disable")).rejects.toThrow();
  await expect(a.change("example.demo", "remove")).rejects.toThrow();
  const results = await Promise.allSettled([
    a.change("example.consumer", "disable"),
    b.change("example.consumer", "remove"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});
it("rejects archive traversal without publishing", async () => {
  const db = await database(),
    manager = new PluginManager(await directory(), [], db);
  const bad = zipSync({
    "../escape": strToU8("bad"),
    "package.json": strToU8("{}"),
  });
  await expect(manager.install(bad, "local")).rejects.toThrow("path");
  expect((await manager.inventory()).plugins).toEqual([]);
});
it("publishes an offline folder once and synchronizes it from the shared registry", async () => {
  const db = await database(),
    dir = await directory();
  for (const [name, content] of Object.entries(unpack(bundle()))) {
    const file = join(dir, "example.demo", name);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content);
  }
  const first = new PluginManager(dir, [], db);
  expect(await first.prepare()).toHaveLength(1);
  await first.confirm();
  const second = new PluginManager(await directory(), [], db);
  expect(await second.prepare()).toHaveLength(1);
  await first.change("example.demo", "remove");
  expect(await new PluginManager(dir, [], db).prepare()).toHaveLength(0);
});
it("protects management endpoints and removes notes from new deployments", async () => {
  const db = await database();
  const app = await createApp(db, {
    origin: "http://127.0.0.1:39130",
    pluginDirectory: await directory(),
  });
  try {
    const headers = {
      host: "127.0.0.1:39130",
      origin: "http://127.0.0.1:39130",
    };
    expect(
      (await app.inject({ url: "/api/v1/admin/plugins", headers })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/api/v1/admin/plugins/operations", headers }))
        .statusCode,
    ).toBe(401);
    await createUser(
      db,
      {
        login: "plugin-admin",
        displayName: "Admin",
        password: "plugin-admin-password",
      },
      { bootstrap: true },
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers,
      payload: { login: "plugin-admin", password: "plugin-admin-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/admin/plugins/upload",
      headers: { ...headers, cookie, "content-type": "application/zip" },
      payload: Buffer.from(bundle()),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    expect(upload.json().restartRequired).toBe(true);
    const history = await app.inject({
      url: "/api/v1/admin/plugins/operations",
      headers: { ...headers, cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(
      history
        .json()
        .items.every(
          (item: { pluginId: string }) => item.pluginId === "example.demo",
        ),
    ).toBe(true);
    expect(
      history.json().items.map((item: { stage: string }) => item.stage),
    ).toEqual(["staged", "requested"]);
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/plugins/upload",
      headers: { ...headers, cookie, "content-type": "application/zip" },
      payload: Buffer.from("invalid archive"),
    });
    expect(failed.statusCode).toBe(400);
    const afterFailure = await app.inject({
      url: "/api/v1/admin/plugins/operations",
      headers: { ...headers, cookie },
    });
    expect(afterFailure.json().items[0].stage).toBe("failed");
    expect(
      (
        await app.inject({
          url: "/api/v1/quick-notes",
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(404);
    const tables = await db.introspection.getTables();
    expect(
      tables.some(
        (t) => t.name === "quick_notes" || t.name === "quick_note_compilations",
      ),
    ).toBe(false);
  } finally {
    await app.close();
  }
});
