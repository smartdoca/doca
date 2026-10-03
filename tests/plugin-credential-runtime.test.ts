import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DB } from "@db/index.js";
import { openTestDatabase } from "./database.js";
import { createApp } from "@server/app/create-app.js";

const dirs: string[] = [],
  dbs: DB[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const db of dbs.splice(0)) await db.destroy();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(optional = false) {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  dbs.push(db);
  const root = await mkdtemp(join(tmpdir(), "doca-credential-runtime-"));
  dirs.push(root);
  const dir = join(root, "example.credentials");
  await mkdir(dir);
  const manifest = {
    schemaVersion: 1,
    id: "example.credentials",
    version: "1.0.0",
    sdkRange: "^0.1.8",
    displayName: "Credential acceptance",
  };
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "example-credentials",
      version: "1.0.0",
      type: "module",
      doca: {
        storage: "host",
        dataVersion: "1",
        manifest: "./manifest.json",
        server: "./server.js",
      },
    }),
  );
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  // A prebuilt plugin uses only the public token identity and lifecycle context.
  await writeFile(
    join(dir, "server.js"),
    `export default () => {
    const token = {id:'storage.credentials.v1'}; let credential;
    return {manifest:${JSON.stringify(manifest)}, injections:{${optional ? "optional" : "required"}:[token]},
      async initialize(ctx) {
        const service=ctx.injectOptional(token);
        if (${optional}) { if(service || ctx.has(token)) throw Error('Absent key exposed a fake service'); return; }
        credential=await ctx.child().inject(token).create({value:'synthetic-runtime-secret'});
      },
      async dispose(ctx) {
        if(!credential) return;
        const service=ctx.inject(token), stored=await service.get(credential.id);
        if(stored.value!=='synthetic-runtime-secret') throw Error('Credential missing during dispose');
        await service.update({id:credential.id,expectedRevision:stored.credential.revision,value:'synthetic-disposed-secret'});
      }, async uninstall() {}
    };
  };`,
  );
  return {
    db,
    options: { origin: "http://127.0.0.1:39130", pluginDirectory: root },
  };
}

it("rejects a required credential service without a master key and leaves no plaintext", async () => {
  vi.stubEnv("DOCA_CREDENTIAL_MASTER_KEY", undefined);
  const { db, options } = await fixture();
  await expect(createApp(db, options)).rejects.toThrow(
    "requires service storage.credentials.v1",
  );
  expect(
    await db.selectFrom("plugin_credentials").selectAll().execute(),
  ).toEqual([]);
});
it("permits optional credential injection without creating a key or fake service", async () => {
  vi.stubEnv("DOCA_CREDENTIAL_MASTER_KEY", undefined);
  const { db, options } = await fixture(true);
  const app = await createApp(db, options);
  await app.close();
  expect(
    await db.selectFrom("plugin_credential_keys").selectAll().execute(),
  ).toEqual([]);
});
it("keeps the cipher alive through plugin dispose and rejects a different key on restart", async () => {
  vi.stubEnv("DOCA_CREDENTIAL_MASTER_KEY", randomBytes(32).toString("hex"));
  const { db, options } = await fixture();
  const app = await createApp(db, options);
  const before = await db
    .selectFrom("plugin_credentials")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(before.revision).toBe(1);
  expect(before.sealed).not.toContain("synthetic-runtime-secret");
  await app.close();
  const after = await db
    .selectFrom("plugin_credentials")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(after.revision).toBe(2);
  vi.stubEnv("DOCA_CREDENTIAL_MASTER_KEY", randomBytes(32).toString("hex"));
  await expect(createApp(db, options)).rejects.toThrow(
    "does not match credential storage",
  );
  expect(
    await db
      .selectFrom("plugin_credentials")
      .selectAll()
      .executeTakeFirstOrThrow(),
  ).toEqual(after);
});
it("rejects malformed master key configuration without echoing it", async () => {
  const value = "invalid-key-that-must-not-be-logged";
  vi.stubEnv("DOCA_CREDENTIAL_MASTER_KEY", value);
  const { db, options } = await fixture();
  await expect(createApp(db, options)).rejects.toMatchObject({
    code: "invalid-key",
    message:
      "DOCA_CREDENTIAL_MASTER_KEY must contain exactly 64 hexadecimal characters",
  });
});
