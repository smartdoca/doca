import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import { recentActivity, recordActivity } from "@core/modules/workspace/activity.js";
import { homeOverview } from "@core/modules/workspace/home.js";
import { collectPublicResource } from "@core/modules/discovery/catalog.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import {
  createKnowledgeBook,
  listKnowledgeBooks,
} from "@core/modules/knowledge-books/management.js";

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

it("keeps knowledge books out of library tabs and the home library count", async () => {
  const content = createContent(db);
  const library = await content.create(owner, {
    kind: "library",
    format: "markdown",
    title: "Team library",
  });
  const book = await createKnowledgeBook(db, owner, "Team book");
  for (const resource of [library, book]) {
    const row = await db
      .selectFrom("resources")
      .select("authz_revision")
      .where("id", "=", resource.id)
      .executeTakeFirstOrThrow();
    await content.member(owner, resource.id, reader.id, {
      revision: row.authz_revision!,
      role: "reader",
      includeDescendants: true,
    });
    for (const actor of [owner, reader]) {
      await db
        .insertInto("reactions")
        .values({
          resource_id: resource.id,
          user_id: actor.id,
          kind: "favorite",
          created_at: new Date().toISOString(),
        })
        .execute();
      await collectPublicResource(db, actor, "library", resource.id, true);
    }
  }
  for (const actor of [owner, reader]) {
    for (const scope of [
      "libraries",
      "all",
      "favorites",
      "collected",
      actor === owner ? "owned" : "shared",
    ]) {
      const page = await content.list(actor, { scope, kind: "library" });
      expect(page.items.map((item) => item.id), scope).toEqual([library.id]);
      expect(page.total, scope).toBe(1);
    }
    const libraries = await content.list(actor, { scope: "libraries" });
    expect(libraries.items.map((item) => item.id)).toEqual([library.id]);
    expect(libraries.total).toBe(1);
    expect((await homeOverview(db, actor)).libraries).toBe(1);
    expect((await listKnowledgeBooks(db, actor)).map((item) => item.id)).toEqual([
      book.id,
    ]);
    expect((await content.detail(actor, book.id)).resource.knowledgeBook).toBe(
      true,
    );
  }
});

it("counts and paginates libraries after excluding knowledge books", async () => {
  const content = createContent(db);
  await createKnowledgeBook(db, owner, "Generated book");
  const libraryIds: string[] = [];
  for (let index = 0; index < 101; index++) {
    const library = await content.create(owner, {
      kind: "library",
      format: "markdown",
      title: `Library ${index}`,
    });
    libraryIds.push(library.id);
  }
  const query = {
    scope: "libraries",
    kind: "library",
    sort: "created_at",
    order: "asc",
  };
  const first = await content.list(owner, query);
  expect(first.total).toBe(101);
  expect(first.items).toHaveLength(100);
  expect(first.nextCursor).toBeTruthy();
  const second = await content.list(owner, {
    ...query,
    cursor: first.nextCursor!,
  });
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
    libraryIds.sort(),
  );
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
