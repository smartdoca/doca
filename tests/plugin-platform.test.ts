import { afterEach, beforeEach, expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import { createApp } from "@server/app/create-app.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import { directoryIds } from "@core/modules/discovery/directory.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { fail } from "@core/shared/errors.js";
import type { DB } from "@db/index.js";
let db: DB;
beforeEach(async () => { db = await openTestDatabase({ driver: "sqlite", path: ":memory:" }); });
afterEach(async () => { await db.destroy(); });
it("merges live plugin relations only in related mode and isolates host instances", async () => {
  const user = { ...await createUser(db, { login: "owner", displayName: "Owner", password: "test-password-2026" }, { bootstrap: true }), admin: 1 };
  await db.updateTable("settings").set({ directory_mode: "related" }).where("id", "=", "system").execute();
  pluginServices(db).directories.set("test.mail", { id: "test.mail", schemaVersion: 1, async related() { return { items: [{ userId: "colleague", relationId: "shared", revision: "1" }], cursor: null }; }, async verify(_id, candidates) { return candidates.map(c => c.userId); } });
  expect(await directoryIds(db, user)).toContain("colleague");
  pluginServices(db).directories.delete("test.mail");
  expect(await directoryIds(db, user)).not.toContain("colleague");
  pluginServices(db).directories.set("test.mail", { id: "test.mail", schemaVersion: 1, async related() { throw Error("offline"); }, async verify() { return []; } });
  expect(await directoryIds(db, user)).not.toContain("colleague");
  await db.updateTable("settings").set({ directory_mode: "none" }).where("id", "=", "system").execute();
  expect(await directoryIds(db, user)).toEqual(new Set());
  const other = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try { expect(pluginServices(other).directories.size).toBe(0); } finally { await other.destroy(); }
});
it("runs plugin operation policy inside resource transactions and rolls back denied creation", async () => {
  const user = { ...await createUser(db, { login: "owner", displayName: "Owner", password: "test-password-2026" }, { bootstrap: true }), admin: 1 };
  pluginServices(db).policies.set("test.membership", { id: "test.membership", async check(input) { if (input.action === "resources.create") fail(403, "Policy rejected"); } });
  await expect(createContent(db).create(user, { title: "Denied", kind: "document", format: "markdown" })).rejects.toMatchObject({ status: 403 });
  expect(await db.selectFrom("resources").selectAll().execute()).toEqual([]);
  pluginServices(db).policies.clear();
  await expect(createContent(db).create(user, { title: "Allowed", kind: "document", format: "markdown" })).resolves.toHaveProperty("id");
});
it("has no built-in membership or content-review endpoints", async () => {
  const tables = (await db.introspection.getTables()).map(table => table.name);
  for (const name of ["membership_grants", "membership_events", "quota_usage", "ai_grants", "moderation_reports"])
    expect(tables).not.toContain(name);
  const app = await createApp(db, { origin: "http://localhost:39130", pluginDirectory: "/tmp/doca-no-installed-plugins" });
  try {
    for (const url of ["/api/v1/admin/entitlements", "/api/v1/admin/moderation/settings", "/api/v1/admin/ai/credits"])
      expect((await app.inject({ url, headers: { host: "localhost:39130" } })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it("pages plugin relations and rejects revoked candidates and repeated cursors", async () => {
  const user = { ...await createUser(db, { login: "page-owner", displayName: "Owner", password: "test-password-2026" }, { bootstrap: true }), admin: 1 };
  await db.updateTable("settings").set({ directory_mode: "related" }).where("id", "=", "system").execute();
  let revoked = false, repeated = false;
  pluginServices(db).directories.set("test.pages", {
    id: "test.pages", schemaVersion: 1,
    async related(_id, input) { return { items: [{ userId: input.cursor ? "second" : "first", relationId: "shared", revision: "1" }], cursor: repeated || !input.cursor ? "next" : null }; },
    async verify(_id, items) { return revoked ? [] : items.map(item => item.userId); },
  });
  expect((await directoryIds(db, user))?.has("first")).toBe(true);
  expect((await directoryIds(db, user))?.has("second")).toBe(true);
  revoked = true;
  expect((await directoryIds(db, user))?.has("second")).toBe(false);
  revoked = false; repeated = true;
  expect((await directoryIds(db, user))?.has("first")).toBe(false);
});
