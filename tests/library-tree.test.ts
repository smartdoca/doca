import { afterEach, beforeEach, expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB, Resource } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";

let db: DB,
  owner: Actor,
  reader: Actor,
  outsider: Actor,
  content: ReturnType<typeof createContent>;

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
  const add = async (login: string) => ({
    ...(await createUser(
      db,
      { login, displayName: login, password: "test-password-2026" },
      { actor: owner },
    )),
    admin: 0 as const,
  });
  reader = await add("reader");
  outsider = await add("outsider");
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

async function library(title: string, visibility?: "public") {
  const created = await content.create(owner, {
    kind: "library",
    title,
    format: "rich_text",
  });
  if (visibility) {
    const row = await fresh(created.id);
    await content.permissions(owner, created.id, {
      version: row.version,
      visibility,
    });
  }
  return fresh(created.id);
}

async function document(title: string, libraryId: string, parentId?: string) {
  return content.create(owner, {
    kind: "document",
    title,
    format: "rich_text",
    libraryId,
    parentId,
  });
}

const outline = (actor: Actor | null, libraryId: string) =>
  content.list(actor, {
    scope: "all",
    libraryId,
    includeAncestors: true,
  });

it("shows a public library outline to anonymous readers and refuses search", async () => {
  const lib = await library("Public handbook", "public");
  const guide = await document("Guide", lib.id);
  const chapter = await document("Chapter", lib.id, guide.id);
  const page = await outline(null, lib.id);
  expect(page.items.map((item) => item.title).sort()).toEqual([
    "Chapter",
    "Guide",
  ]);
  expect(page.items.every((item) => item.role === "reader")).toBe(true);
  expect(page.items.find((item) => item.id === chapter.id)?.parent_id).toBe(
    guide.id,
  );
  await expect(
    content.list(null, { scope: "all", libraryId: lib.id, q: "Guide" }),
  ).rejects.toMatchObject({ status: 401 });
  await expect(content.list(null, { scope: "all" })).rejects.toMatchObject({
    status: 401,
  });
});

it("keeps library structure visible and grays documents the reader cannot open", async () => {
  const lib = await library("Private handbook");
  const guide = await document("Guide", lib.id);
  const secret = await document("Secret", lib.id, guide.id);
  const row = await fresh(lib.id);
  await content.member(owner, lib.id, reader.id, {
    revision: row.authz_revision!,
    role: "reader",
    includeDescendants: true,
  });
  const secretRow = await fresh(secret.id);
  await content.permissions(owner, secret.id, {
    version: secretRow.version,
    accessMode: "custom",
    grants: [],
  });
  const page = await outline(reader, lib.id);
  expect(page.items.find((item) => item.id === guide.id)?.role).toBe("reader");
  const hidden = page.items.find((item) => item.id === secret.id);
  expect(hidden).toMatchObject({
    title: "Secret",
    role: "none",
    parent_id: guide.id,
    owner_id: "",
    library_id: lib.id,
  });
  await expect(outline(outsider, lib.id)).rejects.toMatchObject({
    status: 404,
  });
  const shared = await fresh(guide.id);
  await content.member(owner, guide.id, outsider.id, {
    revision: shared.authz_revision!,
    role: "reader",
    includeDescendants: false,
  });
  await expect(outline(outsider, lib.id)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (await content.list(outsider, { scope: "all" })).items.map(
      (item: Resource) => item.title,
    ),
  ).not.toContain("Secret");
});

it("does not publish a private library outline to anonymous visitors", async () => {
  const lib = await library("Private handbook");
  await document("Guide", lib.id);
  await expect(outline(null, lib.id)).rejects.toMatchObject({ status: 404 });
});
