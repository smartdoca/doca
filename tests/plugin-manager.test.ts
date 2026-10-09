import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { zipSync, strToU8 } from "fflate";
import { openTestDatabase } from "./database.js";
import { PluginManager } from "@server/plugins/manager.js";
import { PluginStore } from "@server/plugins/store.js";
import { digest, unpack, archiveFileIndex } from "@server/plugins/archive.js";
import { createApp } from "@server/app/create-app.js";
import { createUser } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { storageRuntime } from "@server/adapters/storage.js";
import { createHostFileStore } from "@server/services/host-file-store.js";
import { configuredFileStore } from "@server/services/file-store-config.js";

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
  uninstall = "async uninstall() {}",
) {
  const manifest = {
    schemaVersion: 1,
    id,
    version,
    displayName: "Demo",
    sdkRange: "^0.1.7",
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
            storage: "host",
            manifest: "./manifest.json",
            server: "./server.js",
            web: { directory: "./web", entry: "./index.js" },
          },
        }).replace(`@example/${id}`, id),
      ),
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "server.js": strToU8(
        `export default () => ({ manifest: ${JSON.stringify(manifest)}${uninstall ? `, ${uninstall}` : ""} });`,
      ),
      "web/index.js": strToU8(
        `export default () => ({manifest: { pluginId: '${id}', version: '${version}', targets:['web']}});`,
      ),
      "web/chunk.js": strToU8("export const value = 42;"),
    },
    { mtime: new Date("2020-01-01T00:00:00Z") },
  );
}
it("installs and restores S3 plugin archives with frozen deployment credentials through the real SDK", async () => {
  const objects = new Map<string, Buffer>();
  const requests: {
    method: string;
    path: string;
    authorization: string;
    sessionToken: string;
    ifNoneMatch?: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url!.split("?")[0]!;
    requests.push({
      method: request.method!,
      path,
      authorization: request.headers.authorization ?? "",
      sessionToken: String(request.headers["x-amz-security-token"] ?? ""),
      ifNoneMatch: request.headers["if-none-match"],
    });
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (objects.has(path)) response.statusCode = 412;
      else objects.set(path, Buffer.concat(chunks));
      response.end();
    } else if (request.method === "GET" && objects.has(path)) {
      const bytes = objects.get(path)!;
      response.setHeader("Content-Length", bytes.length);
      response.end(bytes);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test endpoint port");
    const runtime = storageRuntime({
      DOCA_FILE_STORE_ID: "cloud",
      DOCA_FILE_STORES_JSON: JSON.stringify({
        version: 1,
        stores: {
          cloud: {
            provider: "s3",
            bucket: "doca-test",
            region: "us-east-1",
            endpoint: `http://127.0.0.1:${address.port}`,
            forcePathStyle: true,
            credentials: {
              accessKeyId: "isolated-test-access",
              secretAccessKey: "isolated-test-secret",
              sessionToken: "isolated-test-session",
            },
          },
        },
      }),
    });
    const config = configuredFileStore(runtime.configuration, "cloud");
    if (config.provider !== "s3") throw new Error("Expected S3 fixture");
    const credentials = { ...config.credentials };
    expect(Object.isFrozen(config.credentials)).toBe(true);
    const files = createHostFileStore(runtime);
    const db = await database();
    const first = new PluginManager(
      await directory(),
      [],
      db,
      undefined,
      files,
    );
    const bytes = bundle();
    const hash = digest(bytes);
    const key = `host/plugin-releases/${hash}.zip`;
    expect((await first.install(bytes, "local")).restartRequired).toBe(true);
    expect(objects.get(`/doca-test/${key}`)).toEqual(Buffer.from(bytes));
    expect(
      await db
        .selectFrom("plugin_archives")
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ store_id: "cloud", object_key: key, sha256: hash });
    expect(
      await files.putImmutable(key, bytes, "application/zip"),
    ).toMatchObject({
      existed: true,
      sha256: hash,
    });
    const restarted = new PluginManager(
      await directory(),
      [],
      db,
      undefined,
      files,
    );
    expect((await restarted.prepare())[0]!.manifest.id).toBe("example.demo");
    await restarted.confirm();
    expect((await restarted.inventory()).plugins[0]!.runningVersion).toBe(
      "1.0.0",
    );
    expect(requests.map((request) => request.method)).toEqual([
      "PUT",
      "GET",
      "PUT",
      "GET",
      "GET",
    ]);
    for (const request of requests) {
      expect(request.path).toBe(`/doca-test/${key}`);
      expect(request.authorization).toContain(
        "Credential=isolated-test-access/",
      );
      expect(request.sessionToken).toBe("isolated-test-session");
      if (request.method === "PUT") expect(request.ifNoneMatch).toBe("*");
    }
    expect(objects.size).toBe(1);
    expect(config.credentials).toEqual(credentials);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
it.each(["local", "npm", "store"] as const)(
  "rejects undeclared storage through %s installation without saving the plugin or running its factory",
  async (source) => {
    const db = await database();
    const manager = new PluginManager(await directory(), [], db);
    await manager.prepare();
    await manager.confirm();
    const before = await db.selectFrom("plugin_registry").selectAll().execute();
    const files = unpack(bundle());
    const pkg = JSON.parse(new TextDecoder().decode(files["package.json"]!));
    delete pkg.doca.storage;
    files["package.json"] = strToU8(JSON.stringify(pkg));
    files["server.js"] = strToU8("throw new Error('plugin code must not run')");
    await expect(manager.install(zipSync(files), source)).rejects.toThrow(
      'doca.storage must be "host"',
    );
    expect(
      await db.selectFrom("plugin_registry").selectAll().execute(),
    ).toEqual(before);
    expect(
      await db.selectFrom("plugin_archives").selectAll().execute(),
    ).toEqual([]);
  },
);
it("rejects an old shared archive on startup without importing code or modifying persisted registry/data", async () => {
  const db = await database();
  const first = new PluginManager(await directory(), [], db);
  await first.prepare();
  await first.confirm();
  await first.install(bundle(), "local");
  const row = await db
    .selectFrom("plugin_registry")
    .selectAll()
    .executeTakeFirstOrThrow();
  const state = JSON.parse(row.state);
  const archive = await db
    .selectFrom("plugin_archives")
    .selectAll()
    .executeTakeFirstOrThrow();
  const files = unpack(
    await first.archiveStore.read(
      archive.store_id,
      archive.object_key,
      archive.size,
      archive.sha256,
    ),
  );
  const pkg = JSON.parse(new TextDecoder().decode(files["package.json"]!));
  delete pkg.doca.storage;
  files["package.json"] = strToU8(JSON.stringify(pkg));
  files["server.js"] = strToU8("throw new Error('old plugin must not run')");
  const oldBytes = zipSync(files);
  const oldHash = digest(oldBytes);
  state.desired["example.demo"].sha256 = oldHash;
  const stored = await first.archiveStore.putImmutable(
    `host/plugin-releases/${oldHash}.zip`,
    oldBytes,
    "application/zip",
  );
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("plugin_archives")
      .set({
        sha256: oldHash,
        store_id: stored.storeId,
        object_key: stored.key,
        size: stored.size,
        file_index: archiveFileIndex(oldBytes),
      })
      .where("sha256", "=", archive.sha256)
      .execute();
    await tx
      .updateTable("plugin_registry")
      .set({ state: JSON.stringify(state) })
      .where("id", "=", row.id)
      .execute();
  });
  const before = await db.selectFrom("plugin_registry").selectAll().execute();
  const archives = await db.selectFrom("plugin_archives").selectAll().execute();
  const directoryPath = await directory();
  const dataPath = join(directoryPath, ".old-business-data");
  await writeFile(dataPath, "preserved");
  const restarted = new PluginManager(directoryPath, [], db);
  await expect(restarted.prepare()).rejects.toThrow(
    'doca.storage must be "host"',
  );
  expect(await db.selectFrom("plugin_registry").selectAll().execute()).toEqual(
    before,
  );
  expect(await db.selectFrom("plugin_archives").selectAll().execute()).toEqual(
    archives,
  );
  expect(await readFile(dataPath, "utf8")).toBe("preserved");
});
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
  await db.updateTable("plugin_archives").set({ size: 1 }).execute();
  await expect(
    new PluginManager(await directory(), [], db).prepare(),
  ).rejects.toThrow();
});
it("uses a complete verified cache without fetching its shared archive again", async () => {
  const db = await database(),
    dir = await directory();
  const first = new PluginManager(dir, [], db);
  await first.install(bundle(), "local");
  await first.prepare();
  const restarted = new PluginManager(dir, [], db);
  vi.spyOn(restarted.archiveStore, "read").mockRejectedValue(
    new Error("archive backend is unavailable"),
  );
  expect(await restarted.prepare()).toHaveLength(1);
  await writeFile(
    join(dir, ".releases", digest(bundle()), "web/chunk.js"),
    "corrupt",
  );
  await expect(
    new PluginManager(dir, [], db, undefined, restarted.archiveStore).prepare(),
  ).rejects.toThrow("backend is unavailable");
});
it("upgrades without touching running code and clears the structure number on uninstall", async () => {
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
    canCancel: true,
  });
  expect(await readFile(old!.server, "utf8")).toContain('"version":"1.0.0"');
  await expect(running.install(bundle("1.2.0", "2"), "local")).rejects.toThrow(
    "Incompatible data structure for example.demo: package 1.2.0 declares 2, but the installed structure is 1.",
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
  expect(
    JSON.parse(
      (
        await db
          .selectFrom("plugin_registry")
          .select("state")
          .executeTakeFirstOrThrow()
      ).state,
    ).dataVersions,
  ).toEqual({});
  expect(
    (await emptyInstance.install(bundle("2.0.0", "2"), "local")).plugins[0],
  ).toMatchObject({
    version: "2.0.0",
    dataVersion: "2",
  });
  expect(
    await db.selectFrom("plugin_archives").selectAll().execute(),
  ).toHaveLength(3);
});
it("requires old instances to restart after reinstalling the same release and cannot cancel cleared storage", async () => {
  const db = await database();
  const installer = new PluginManager(await directory(), [], db);
  await installer.install(bundle(), "local");
  await expect(installer.change("example.demo", "cancel")).rejects.toThrow(
    "cannot be cancelled",
  );
  const old = new PluginManager(await directory(), [], db);
  await old.prepare();
  await old.confirm();
  await old.change("example.demo", "disable");
  await old.change("example.demo", "cancel");
  expect((await old.inventory()).restartRequired).toBe(false);
  await installer.change("example.demo", "remove");
  await expect(old.change("example.demo", "cancel")).rejects.toThrow(
    "cannot be cancelled",
  );
  await installer.install(bundle(), "local");
  const before = await db.selectFrom("plugin_registry").selectAll().execute();
  expect((await old.inventory()).plugins[0]).toMatchObject({
    version: "1.0.0",
    runningVersion: "1.0.0",
    pending: true,
    canCancel: false,
  });
  expect((await old.inventory()).restartRequired).toBe(true);
  await expect(old.change("example.demo", "cancel")).rejects.toThrow(
    "installation changed",
  );
  expect(await db.selectFrom("plugin_registry").selectAll().execute()).toEqual(
    before,
  );
  const restarted = new PluginManager(await directory(), [], db);
  await restarted.prepare();
  await restarted.confirm();
  expect((await restarted.inventory()).restartRequired).toBe(false);
  await restarted.change("example.demo", "disable");
  await restarted.change("example.demo", "cancel");
  expect((await restarted.inventory()).restartRequired).toBe(false);
  await restarted.change("example.demo", "disable");
  const disabled = new PluginManager(await directory(), [], db);
  await disabled.prepare();
  await disabled.confirm();
  await disabled.change("example.demo", "enable");
  expect((await disabled.inventory()).plugins[0]).toMatchObject({
    runningVersion: null,
    pending: true,
    canCancel: true,
  });
  await disabled.change("example.demo", "cancel");
  expect((await disabled.inventory()).restartRequired).toBe(false);
});
it("keeps the install when the plugin uninstall method fails", async () => {
  const db = await database();
  const manager = new PluginManager(await directory(), [], db);
  await manager.install(
    bundle(
      "1.0.0",
      "1",
      "example.demo",
      [],
      "async uninstall() { throw new Error('database busy') }",
    ),
    "local",
  );
  await manager.prepare();
  await manager.confirm();
  await expect(manager.change("example.demo", "remove")).rejects.toThrow(
    "database busy",
  );
  const state = JSON.parse(
    (
      await db
        .selectFrom("plugin_registry")
        .select("state")
        .executeTakeFirstOrThrow()
    ).state,
  );
  expect(state.desired["example.demo"].dataVersion).toBe("1");
  expect(state.dataVersions["example.demo"]).toBe("1");
});
it("defers runtime imports until startup and rejects a missing uninstall then", async () => {
  const db = await database(),
    directoryPath = await directory();
  const manager = new PluginManager(directoryPath, [], db);
  await manager.install(bundle("1.0.0", "1", "example.demo", [], ""), "local");
  const installed = await new PluginManager(
    await directory(),
    [],
    db,
  ).prepare();
  const { importInstalledPlugins } =
    await import("@server/plugins/installation.js");
  await expect(importInstalledPlugins(installed)).rejects.toThrow(
    "must implement uninstall",
  );
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
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const manager of [a, b]) {
    const save = (manager as any).save.bind(manager);
    vi.spyOn(manager as any, "save").mockImplementation(
      async (...args: unknown[]) => {
        if (++arrivals === 2) release();
        await barrier;
        return save(...args);
      },
    );
  }
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
    expect(history.json().items).toEqual([
      expect.objectContaining({
        stage: "staged",
        pluginId: "example.demo",
        version: "1.0.0",
        error: null,
        active: false,
      }),
      expect.objectContaining({
        stage: "requested",
        pluginId: "example.demo",
        version: "1.0.0",
        error: null,
        active: false,
      }),
    ]);
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
    expect(afterFailure.json().items[0]).toMatchObject({
      stage: "failed",
      pluginId: null,
      version: null,
      error: expect.any(String),
      active: false,
    });
    expect(afterFailure.json().items[0].error.length).toBeGreaterThan(0);
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
