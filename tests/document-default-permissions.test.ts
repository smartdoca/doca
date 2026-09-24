import { afterEach, beforeEach, expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { distributionPolicy } from "@core/modules/deployment/policies.js";
import { createShareLinks } from "@core/modules/access/links.js";
import { createAccessRequests } from "@core/modules/access/requests.js";
import { authorize } from "@core/modules/access/queries.js";
let db: DB,
  owner: Actor,
  reader: Actor,
  content: ReturnType<typeof createContent>;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "owner",
        displayName: "Owner",
        password: "default-test-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  reader = {
    ...(await createUser(
      db,
      {
        login: "reader",
        displayName: "Reader",
        password: "default-test-password",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  content = createContent(db);
});
afterEach(async () => {
  await db.destroy();
});
it("creates each document format private and requestable, with sharing enabled and discovery/history disabled", async () => {
  expect((await distributionPolicy(db, "document")).defaultVisibility).toBe(
    "requestable",
  );
  expect((await distributionPolicy(db, "library")).defaultVisibility).toBe(
    "invited",
  );
  for (const format of [
    "rich_text",
    "markdown",
    "spreadsheet",
    "canvas",
    "presentation",
  ] as const) {
    const doc = await content.create(owner, {
      kind: "document",
      format,
      title: "New document",
    });
    expect(doc).toMatchObject({
      visibility: "invited",
      requests_enabled: 1,
      share_links_enabled: 1,
      discoverable: 0,
      history_readers: 0,
    });
    const links = await createShareLinks(db).share(owner, doc.id);
    expect(links.sharingEnabled).toBe(true);
    expect(links.items).toHaveLength(0);
    await expect(
      authorize(db, reader, doc.id, "read_content"),
    ).rejects.toThrow();
    expect(
      (await createAccessRequests(db).preview(reader, doc.id)).requestable,
    ).toBe(true);
    await content.permissions(owner, doc.id, {
      version: doc.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: reader.id, role: "reader" }],
    });
    await expect(
      authorize(db, reader, doc.id, "read_content"),
    ).resolves.toBeDefined();
    await expect(
      authorize(db, reader, doc.id, "read_history"),
    ).rejects.toThrow();
  }
});
it("respects an explicit document default and preserves knowledge-base inheritance", async () => {
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        resourcePolicies: { document: { defaultVisibility: "invited" } },
      }),
    })
    .where("id", "=", "system")
    .execute();
  const lib = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Private library",
  });
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Child",
    libraryId: lib.id,
  });
  expect(doc).toMatchObject({
    access_mode: "inherit",
    requests_enabled: 0,
    share_links_enabled: 1,
    discoverable: 0,
    history_readers: 0,
  });
});
it("copies a document without inheriting its public discovery or reader-history settings", async () => {
  const original = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Original",
  });
  await content.permissions(owner, original.id, {
    version: original.version,
    accessMode: "custom",
    visibility: "public",
    discoverable: true,
    historyReaders: true,
    grants: [],
  });
  const copy = await content.copy(owner, original.id);
  const row = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", copy.id)
    .executeTakeFirstOrThrow();
  expect(row).toMatchObject({
    visibility: "invited",
    requests_enabled: 1,
    share_links_enabled: 1,
    discoverable: 0,
    history_readers: 0,
  });
});
