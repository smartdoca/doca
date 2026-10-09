import { afterEach, beforeEach, expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB, Resource } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { authorize } from "@core/modules/access/queries.js";
import { permissionOverview } from "@core/modules/access/presentation.js";

let db: DB, owner: Actor, content: ReturnType<typeof createContent>;

beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  content = createContent(db);
});
afterEach(() => db.destroy());

async function fresh(id: string) {
  return db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function allowInternet(
  kind: "document" | "library",
  allowed: boolean,
) {
  const row = await db
    .selectFrom("distribution_settings")
    .selectAll()
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
  const config = JSON.parse(row.config);
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...config,
        internetPublication: {
          document: true,
          library: true,
          ...config.internetPublication,
          [kind]: allowed,
        },
      }),
      revision: row.revision + 1,
    })
    .where("id", "=", "system")
    .execute();
}

async function publish(resource: Resource) {
  const row = await fresh(resource.id);
  await content.permissions(owner, resource.id, {
    version: row.version,
    visibility: "public",
  });
}

it("keeps existing public documents readable and blocks new internet publication", async () => {
  const published = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Already public",
  });
  await publish(published);
  await authorize(db, null, published.id);
  await allowInternet("document", false);
  await authorize(db, null, published.id);
  const next = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Still private",
  });
  await expect(publish(next)).rejects.toMatchObject({ status: 403 });
  const current = await fresh(published.id);
  await content.permissions(owner, published.id, {
    version: current.version,
    publicRole: "commenter",
  });
  expect(
    (await permissionOverview(db, owner, next.id)).internetPublication,
  ).toBe(false);
  expect(
    (await permissionOverview(db, owner, published.id)).internetPublication,
  ).toBe(false);
});

it("lets an individually allowed person publish after the type is closed", async () => {
  const guest = {
    ...(await createUser(
      db,
      { login: "guest", displayName: "Guest", password: "test-password-2026" },
      { actor: owner },
    )),
    admin: 0,
  };
  await allowInternet("document", false);
  const doc = await content.create(guest, {
    kind: "document",
    format: "rich_text",
    title: "Guest document",
  });
  await expect(
    content.permissions(guest, doc.id, {
      version: doc.version,
      visibility: "public",
    }),
  ).rejects.toMatchObject({ status: 403 });
  const row = await db
    .selectFrom("distribution_settings")
    .selectAll()
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
  const config = JSON.parse(row.config);
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...config,
        internetPublicationUsers: [guest.id],
      }),
      revision: row.revision + 1,
    })
    .where("id", "=", "system")
    .execute();
  const current = await fresh(doc.id);
  await content.permissions(guest, doc.id, {
    version: current.version,
    visibility: "public",
  });
  await authorize(db, null, doc.id);
  expect(
    (await permissionOverview(db, guest, doc.id)).internetPublication,
  ).toBe(true);
  expect(
    (await permissionOverview(db, owner, doc.id)).internetPublication,
  ).toBe(false);
});

it("blocks new public libraries without changing ones already public", async () => {
  const library = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Public library",
  });
  await publish(library);
  await allowInternet("library", false);
  await authorize(db, null, library.id);
  const closed = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Closed library",
  });
  await expect(publish(closed)).rejects.toMatchObject({ status: 403 });
});
