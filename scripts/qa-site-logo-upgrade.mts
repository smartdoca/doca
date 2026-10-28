// Seed with released source, then run check with the current checkout.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { Pool } from "pg";
if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated upgrade databases only");
const source = resolve(process.env.DOCA_QA_SOURCE_ROOT ?? ".");
const output = resolve(process.env.DOCA_QA_OUTPUT!);
assert(process.env.DOCA_QA_OUTPUT);
await mkdir(output, { recursive: true });
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({ version: 1, stores: { local: { provider: "local", root: join(output, "files") } } });
const config = process.env.DOCA_QA_POSTGRES
  ? { driver: "postgres" as const, url: process.env.DOCA_QA_POSTGRES }
  : { driver: "sqlite" as const, path: join(output, "released.db") };
const load = (path: string) => import(join(source, path));
const { openDatabase } = await load("packages/db/src/connection.ts");
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
async function snapshot(db: any, tables: string[]) {
  const result: Record<string, { rows: number; hash: string }> = {};
  for (const table of tables) {
    const rows = await db.selectFrom(table).selectAll().execute();
    if (table === "schema_baseline") rows.forEach((row: any) => delete row.structure_json);
    if (table === "settings") rows.forEach((row: any) => delete row.site_logo);
    result[table] = { rows: rows.length, hash: digest(rows.map(canonical).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) };
  }
  return result;
}
const mode = process.argv[2];
assert(["seed", "check"].includes(mode!));
if (mode === "seed") {
  const db = await openDatabase(config);
  try {
    const { createUser } = await load("packages/core/src/modules/identity/passwords.ts");
    const { createContent } = await load("packages/core/src/workflows/resources.ts");
    const owner = { ...await createUser(db, { login: "logoupgrade", displayName: "Retained owner", password: "isolated-logo-upgrade-2026" }, { bootstrap: true }), admin: 1 };
    await createContent(db).create(owner, { kind: "document", format: "markdown", title: "Preserved release content", markdown: "# Released document\nKeep original content, history and permissions." });
    await db.updateTable("settings").set({ site_name: "Retained site", revision: 7, default_locale: "en", default_timezone: "UTC" }).where("id", "=", "system").execute();
    const tables = (await db.introspection.getTables()).filter((table: any) => table.schema === undefined || table.schema === "public").map((table: any) => table.name).sort();
    const settings = await db.selectFrom("settings").selectAll().executeTakeFirstOrThrow();
    assert(!Object.hasOwn(settings, "site_logo"), "Seed must use the actual preceding released structure");
    const version = JSON.parse(await readFile(join(source, "package.json"), "utf8")).version;
    assert.equal(version, "0.2.23");
    await writeFile(join(output, "before.json"), JSON.stringify({ version, tables, settings, hashes: await snapshot(db, tables) }, null, 2));
    console.log(JSON.stringify({ mode, version, engine: config.driver, retainedTables: tables.length }));
  } finally { await db.destroy(); }
} else {
  const before = JSON.parse(await readFile(join(output, "before.json"), "utf8"));
  const raw = () => new Kysely<any>({ dialect: config.driver === "postgres"
    ? new PostgresDialect({ pool: new Pool({ connectionString: config.url }) })
    : new SqliteDialect({ database: new Sqlite(config.path) }) });
  const inspect = raw();
  try {
    await inspect.schema.createTable("qa_unreviewed_logo").addColumn("id", "text").execute();
    await assert.rejects(() => openDatabase(config), /review|unknown/i);
    assert(!Object.hasOwn(await inspect.selectFrom("settings").selectAll().executeTakeFirstOrThrow(), "site_logo"), "Review rejection must not apply the otherwise approved addition");
    assert.deepEqual(await snapshot(inspect, before.tables), before.hashes);
    await inspect.schema.dropTable("qa_unreviewed_logo").execute();
  } finally { await inspect.destroy(); }
  const connections = await Promise.all([openDatabase(config), openDatabase(config)]);
  let encoded: string;
  try {
    const db = connections[0];
    assert.deepEqual(await snapshot(db, before.tables), before.hashes, "Every original table's rows must be preserved");
    const { site_logo, ...settings } = await db.selectFrom("settings").selectAll().executeTakeFirstOrThrow();
    assert.equal(site_logo, null);
    assert.deepEqual(settings, before.settings);
    const { encodeSiteLogo } = await import("../apps/server/src/services/site-logo.js");
    const sharp = (await import("sharp")).default;
    const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#357ab8" } }).png().toBuffer();
    encoded = await encodeSiteLogo("data:image/png;base64," + image.toString("base64"));
    await db.updateTable("settings").set({ site_logo: encoded }).where("id", "=", "system").execute();
  } finally { await Promise.all(connections.map(db => db.destroy())); }
  const repeated = await openDatabase(config);
  try {
    assert.equal((await repeated.selectFrom("settings").selectAll().executeTakeFirstOrThrow()).site_logo, encoded!);
    assert.deepEqual(await snapshot(repeated, before.tables), before.hashes, "Repeated startup preserves configured values and all original rows");
  } finally { await repeated.destroy(); }
  const lost = raw();
  try {
    // Deliberate loss in this synthetic fixture must be detected, never recreated.
    await lost.schema.alterTable("settings").dropColumn("site_logo").execute();
    await assert.rejects(() => openDatabase(config), /lost|missing|loss|review/i);
    assert(!Object.hasOwn(await lost.selectFrom("settings").selectAll().executeTakeFirstOrThrow(), "site_logo"));
    assert.deepEqual(await snapshot(lost, before.tables), before.hashes);
  } finally { await lost.destroy(); }
  const result = { passed: true, releasedVersion: before.version, engine: config.driver, retainedTables: before.tables.length, concurrentStartup: true, historicalLogo: null, configuredLogoRetained: true, reviewRejectedBeforeAddition: true, lostInstalledFieldRejected: true };
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
