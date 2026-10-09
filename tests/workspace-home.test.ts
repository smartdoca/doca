import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import { recentActivity, recordActivity } from "@core/modules/workspace/activity.js";
import { homeOverview } from "@core/modules/workspace/home.js";
import { collectPublicResource } from "@core/modules/discovery/catalog.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";

let db: DB;
const owner = { id: randomUUID(), display_name: "Owner", admin: 0 },
  reader = { id: randomUUID(), display_name: "Reader", admin: 0 };
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  for (const u of [owner, reader])
    await db
      .insertInto("users")
      .values({
        ...u,
        login: u.id,
        password_hash: "",
        status: "active",
        created_at: new Date().toISOString(),
      })
      .execute();
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...distributionDefaults,
        publicModes: {
          document: "link",
          library: "link",

          folder: "link",
        },
      }),
    })
    .execute();
});
afterEach(() => db.destroy());
it("keeps viewed public documents out of search until collected or favorited, and rechecks visibility", async () => {
  const content = createContent(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Reference",
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    visibility: "public",
  });
  await content.visit(reader, doc.id);
  expect(
    (await recentActivity(db, reader, { publicOnly: true })).items.map(
      (x) => x.id,
    ),
  ).toEqual([doc.id]);
  expect((await content.list(reader, { scope: "personal" })).items).toEqual([]);
  await collectPublicResource(db, reader, "document", doc.id, true);
  expect(
    (await content.list(reader, { scope: "collected", kind: "document" }))
      .items[0]?.collected,
  ).toBe(true);
  await collectPublicResource(db, reader, "document", doc.id, false);
  await db
    .insertInto("reactions")
    .values({
      resource_id: doc.id,
      user_id: reader.id,
      kind: "favorite",
      created_at: new Date().toISOString(),
    })
    .execute();
  expect(
    (await content.list(reader, { scope: "personal" })).items.map((x) => x.id),
  ).toEqual([doc.id]);
  const current = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await content.permissions(owner, doc.id, {
    version: current.version,
    visibility: "invited",
  });
  expect((await recentActivity(db, reader)).items).toEqual([]);
  expect((await content.list(reader, { scope: "personal" })).items).toEqual([]);
});
it("does not put globally public libraries into the personal catalogue", async () => {
  const c = createContent(db);
  const lib = await c.create(owner, {
    kind: "library",
    format: "markdown",
    title: "Company",
  });
  await c.permissions(owner, lib.id, {
    version: lib.version,
    visibility: "public",
  });
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...distributionDefaults,
        publicModes: {
          document: "search",
          library: "search",

          folder: "search",
        },
      }),
    })
    .execute();
  expect((await c.list(reader, { scope: "libraries" })).items).toEqual([]);
  await collectPublicResource(db, reader, "library", lib.id, true);
  expect(
    (await c.list(reader, { scope: "libraries" })).items.map((x) => x.id),
  ).toEqual([lib.id]);
  expect(
    (await c.list(reader, { scope: "shared", kind: "library" })).items,
  ).toEqual([]);
});


it("returns document formats and permission-checked library sources", async () => {
  const content = createContent(db);
  const library = await content.create(owner, {
    kind: "library", format: "markdown", title: "Team knowledge",
  });
  const document = await content.create(owner, {
    kind: "document", format: "spreadsheet", title: "Budget", libraryId: library.id,
  });
  await content.visit(owner, document.id);
  expect((await recentActivity(db, owner)).items.find(x => x.id === document.id))
    .toMatchObject({ format: "spreadsheet", inLibrary: true, libraryName: "Team knowledge" });
  await content.permissions(owner, document.id, {
    version: document.version, visibility: "public", accessMode: "custom",
  });
  await content.visit(reader, document.id);
  expect((await recentActivity(db, reader)).items.find(x => x.id === document.id))
    .toMatchObject({ format: "spreadsheet", inLibrary: true, libraryName: null });
});
