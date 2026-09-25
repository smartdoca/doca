import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDocumentsPlugin } from "../packages/plugin-documents/src/index.js";
import { createFilesPlugin } from "../packages/plugin-files/src/index.js";
import type { DocumentsServiceV1 } from "../packages/documents-capability/src/index.js";
import type { FilesServiceV1 } from "../packages/files-capability/src/index.js";
import { PluginHost } from "../packages/plugin-host/src/index.js";
import { createMailPlugin } from "../packages/plugin-mail/src/index.js";
import {
  definePlugin,
  defineService,
} from "../packages/plugin-sdk/src/index.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { openTestDatabase } from "./database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("orders adapter plugins and disposes their effects in reverse", async () => {
  const runtimeToken = defineService<{ name: string }>("test.server.runtime");
  const searchToken = defineService<{ name: string }>("test.server.search");
  const filesService = {
    version: 1,
  } as FilesServiceV1;
  const documentsService = {
    version: 1,
    files: { version: 1 },
  } as DocumentsServiceV1;
  const events: string[] = [];
  const adapter = (name: string) => async () => {
    events.push(`mount:${name}`);
    return () => {
      events.push(`dispose:${name}`);
    };
  };
  const host = new PluginHost();
  host.register(
    definePlugin({
      manifest: {
        schemaVersion: 1,
        id: "doca.server-runtime",
        version: "0.1.0",
        displayName: "Runtime",
      },
      discover(context) {
        context.provide(runtimeToken, { name: "runtime" });
      },
    }),
  );
  host.register(
    definePlugin({
      manifest: {
        schemaVersion: 1,
        id: "doca.search",
        version: "0.1.0",
        displayName: "Search",
        dependencies: [
          { id: "doca.server-runtime", range: "^0.1.0" },
        ],
      },
      discover(context) {
        context.provide(searchToken, { name: "search" });
      },
    }),
  );
  host.register(
    createDocumentsPlugin({
      runtimeToken,
      searchToken,
      service: documentsService,
      unload: "app-close",
      mount: adapter("documents"),
    }),
  );
  host.register(
    definePlugin({
      manifest: {
        schemaVersion: 1,
        id: "doca.ai",
        version: "0.1.0",
        displayName: "AI",
        dependencies: [
          { id: "doca.documents", range: "^0.1.0" },
        ],
      },
    }),
  );
  host.register(
    createFilesPlugin({
      runtimeToken,
      searchToken,
      service: filesService,
      unload: "app-close",
      mount: adapter("files"),
    }),
  );
  host.register(
    createMailPlugin({
      runtimeToken,
      unload: "app-close",
      mount: adapter("mail"),
    }),
  );

  expect(host.order).toEqual([
    "doca.server-runtime",
    "doca.search",
    "doca.files",
    "doca.documents",
    "doca.ai",
    "doca.mail",
  ]);
  await host.start();
  expect(events).toEqual([
    "mount:files",
    "mount:documents",
    "mount:mail",
  ]);
  await host.dispose();
  expect(events.slice(-3)).toEqual([
    "dispose:mail",
    "dispose:documents",
    "dispose:files",
  ]);
});

it("publishes active plugin versions and can disable only mail", async () => {
  const origin = "http://localhost:39240";
  const create = async (mail: boolean | undefined) => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "doca-server-plugins-"),
    );
    directories.push(directory);
    const db = await openTestDatabase({
      driver: "sqlite",
      path: join(directory, "test.db"),
    });
    const app = await createApp(db, {
      origin,
      storage: {
        root: join(directory, "uploads"),
        credentials: {},
        endpointHosts: [],
        cdnKeyPairId: undefined,
        cdnPrivateKey: undefined,
      },
      ...(mail === undefined ? {} : { plugins: { mail } }),
    });
    return { app, db };
  };

  const enabled = await create(undefined);
  try {
    const response = await enabled.app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { host: "localhost:39240" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().plugins).toEqual([
      { id: "doca.server-runtime", version: "0.1.0" },
      { id: "doca.search", version: "0.1.0" },
      { id: "doca.files", version: "0.1.0" },
      { id: "doca.documents", version: "0.1.0" },
      { id: "doca.ai", version: "0.1.0" },
      { id: "doca.mail", version: "0.1.0" },
    ]);
    expect(
      enabled.app.hasRoute({ method: "GET", url: "/api/v1/mail" }),
    ).toBe(true);
  } finally {
    await enabled.app.close();
    await enabled.db.destroy();
  }

  const disabled = await create(false);
  try {
    expect(
      disabled.app.hasRoute({ method: "GET", url: "/api/v1/mail" }),
    ).toBe(false);
    expect(
      disabled.app.hasRoute({
        method: "GET",
        url: "/api/v1/files",
      }),
    ).toBe(true);
  } finally {
    await disabled.app.close();
    await disabled.db.destroy();
  }
});
