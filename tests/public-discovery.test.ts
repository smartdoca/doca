import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import { authorize, roleQuery } from "@core/modules/access/queries.js";
import { authorizeFileFolder } from "@core/modules/access/file-access.js";
import {
  catalogPage,
  collectPublicResource,
  folderInSearch,
} from "@core/modules/discovery/catalog.js";
import {
  distributionDefaults,
  type PublicMode,
} from "@core/modules/deployment/policies.js";
import {
  knowledgeAssistantAccess,
  listKnowledgeAssistants,
  visitKnowledgeAssistant,
} from "@core/modules/knowledge/system.js";
let db: DB;
const owner = { id: randomUUID(), display_name: "Owner", admin: 0 },
  reader = { id: randomUUID(), display_name: "Reader", admin: 0 };
let content: ReturnType<typeof createContent>;
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
  content = createContent(db);
});
afterEach(() => db.destroy());
async function policy(
  modes: Partial<
    Record<"document" | "library" | "assistant" | "folder", PublicMode>
  >,
) {
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...distributionDefaults,
        autoCollectOpened: true,
        publicModes: {
          document: "link",
          library: "link",
          assistant: "link",
          folder: "link",
          ...modes,
        },
      }),
    })
    .execute();
}
async function resource(
  kind: "document" | "library",
  title: string,
  libraryId?: string,
) {
  const r = await content.create(owner, {
    kind,
    title,
    format: "rich_text",
    libraryId,
  });
  if (!libraryId)
    await content.permissions(owner, r.id, {
      version: r.version,
      visibility: "public",
    });
  return r;
}
const ids = (page: { items: { id: string }[] }) => page.items.map((r) => r.id);
it("independently gates each resource type and never discovers private resources", async () => {
  const doc = await resource("document", "Visible doc"),
    lib = await resource("library", "Visible library");
  await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Private",
  });
  await policy({ library: "discover" });
  expect(ids(await catalogPage(db, reader, {}))).toEqual([lib.id]);
  expect(ids(await content.list(reader, {}))).toEqual([]);
  await policy({ document: "search" });
  expect(ids(await catalogPage(db, reader, {}))).toEqual([doc.id]);
  expect(ids(await content.list(reader, {}))).toEqual([doc.id]);
  expect(ids(await content.list(reader, { scope: "personal" }))).toEqual([]);
  await policy({});
  expect((await catalogPage(db, reader, {})).total).toBe(0);
  expect(ids(await content.list(reader, { scope: "discover" }))).toEqual([]);
});
it("visits never collect, explicit collection is searchable and removable", async () => {
  await policy({});
  const doc = await resource("document", "Document");
  await content.visit(reader, doc.id);
  expect(ids(await content.list(reader, {}))).toEqual([]);
  expect(ids(await content.list(reader, { scope: "recent" }))).toEqual([
    doc.id,
  ]);
  await collectPublicResource(db, reader, "document", doc.id, true);
  expect(ids(await content.list(reader, {}))).toEqual([doc.id]);
  expect(ids(await catalogPage(db, reader, { collected: true }))).toEqual([
    doc.id,
  ]);
  await collectPublicResource(db, reader, "document", doc.id, false);
  await content.visit(reader, doc.id);
  expect(ids(await content.list(reader, {}))).toEqual([]);
  await expect(authorize(db, reader, doc.id)).resolves.toBeTruthy();
});
it("a library collection covers future pages, public reading survives local inheritance switches, and revocation takes effect", async () => {
  await policy({});
  const lib = await resource("library", "Library");
  await collectPublicResource(db, reader, "library", lib.id, true);
  const child = await resource("document", "Future page", lib.id);
  await content.permissions(owner, child.id, {
    version: child.version,
    accessMode: "custom",
  });
  expect(ids(await content.list(reader, { kind: "document" }))).toEqual([
    child.id,
  ]);
  expect((await authorize(db, null, child.id)).rank).toBe(1);
  const rank = await db
    .selectFrom("resources as r")
    .select(roleQuery(sql.ref("r.id"), null).as("rank"))
    .where("r.id", "=", child.id)
    .executeTakeFirstOrThrow();
  expect(Number(rank.rank)).toBe(1);
  const current = (await content.detail(owner, child.id)).resource;
  await expect(
    content.permissions(owner, child.id, {
      version: current.version,
      visibility: "invited",
    }),
  ).rejects.toMatchObject({ status: 400 });
  const currentLib = (await content.detail(owner, lib.id)).resource;
  await content.permissions(owner, lib.id, {
    version: currentLib.version,
    visibility: "invited",
  });
  expect(ids(await content.list(reader, { kind: "document" }))).toEqual([]);
  await expect(authorize(db, reader, child.id)).rejects.toMatchObject({
    status: 404,
  });
});
it("library search policy governs contained pages and discovery searches only titles", async () => {
  await policy({ library: "search", document: "link" });
  const lib = await resource("library", "Handbook");
  const child = await resource("document", "Chapter", lib.id);
  await db
    .insertInto("document_states")
    .values({
      resource_id: child.id,
      codec: "test",
      checkpoint: "",
      checkpoint_seq: 0,
      seq: 0,
      text: "body-only-secret",
      updated_at: new Date().toISOString(),
    })
    .execute();
  expect(ids(await content.list(reader, { q: "body-only-secret" }))).toEqual([
    child.id,
  ]);
  expect(ids(await catalogPage(db, reader, {}))).toEqual([lib.id]);
  expect(
    ids(
      await content.list(reader, { scope: "discover", q: "body-only-secret" }),
    ),
  ).toEqual([]);
  await policy({ document: "search", library: "link" });
  expect(ids(await content.list(reader, { q: "body-only-secret" }))).toEqual(
    [],
  );
});
async function folder(parentId: string | null = "shared") {
  const row = {
    id: randomUUID(),
    owner_id: owner.id,
    parent_id: parentId,
    name: "Folder",
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    delete_batch: null,
  };
  await db.insertInto("file_folders").values(row).execute();
  return row;
}
it("folder publication and collection include future descendants without granting management", async () => {
  await policy({ folder: "discover" });
  const root = await folder();
  await db
    .insertInto("folder_publications")
    .values({ folder_id: root.id, enabled: 1, revision: 1 })
    .execute();
  expect(ids(await catalogPage(db, reader, {}))).toEqual([root.id]);
  expect(await folderInSearch(db, reader, root.id)).toBe(false);
  await collectPublicResource(db, reader, "folder", root.id, true);
  const child = await folder(root.id);
  expect(await folderInSearch(db, reader, child.id)).toBe(true);
  await expect(
    authorizeFileFolder(db, reader, child.id, 3),
  ).rejects.toMatchObject({ status: 403 });
  await collectPublicResource(db, reader, "folder", root.id, false);
  expect(await folderInSearch(db, reader, child.id)).toBe(false);
  await policy({ folder: "search" });
  expect(await folderInSearch(db, reader, child.id)).toBe(true);
  expect(await folderInSearch(db, reader, child.id, "personal")).toBe(false);
  await db.updateTable("folder_publications").set({ enabled: 0 }).execute();
  await expect(authorizeFileFolder(db, reader, child.id)).rejects.toMatchObject(
    { status: 404 },
  );
});
it("public folder readers do not lose their existing management grant", async () => {
  const root = await folder();
  await db
    .insertInto("folder_publications")
    .values({ folder_id: root.id, enabled: 1, revision: 1 })
    .execute();
  await db
    .insertInto("file_folder_shares")
    .values({
      folder_id: root.id,
      user_id: reader.id,
      role: "admin",
      version: 1,
      created_at: root.created_at,
      updated_at: root.updated_at,
    })
    .execute();
  expect((await authorizeFileFolder(db, reader, root.id)).role).toBe("admin");
});
it("Q&A collection adds search candidates without changing the connection preference", async () => {
  await policy({ assistant: "discover" });
  const bot = {
    id: randomUUID(),
    owner_id: owner.id,
    title: "Public Q&A",
    revision: 1,
    library_ids: "[]",
    member_ids: "[]",
    enabled: 1,
    visibility: "public",
    updated_at: new Date().toISOString(),
  };
  await db.insertInto("knowledge_assistants").values(bot).execute();
  expect(ids(await catalogPage(db, reader, {}))).toEqual([bot.id]);
  await visitKnowledgeAssistant(db, reader, bot.id);
  expect((await knowledgeAssistantAccess(db, reader, bot)).connected).toBe(
    false,
  );
  await collectPublicResource(db, reader, "assistant", bot.id, true);
  expect(await knowledgeAssistantAccess(db, reader, bot)).toMatchObject({
    connected: false,
    collected: true,
  });
  expect(
    (await listKnowledgeAssistants(db, reader))
      .filter((bot) => bot.connected || (bot.collected && bot.accessible))
      .map((bot) => bot.id),
  ).toContain(bot.id);
  await collectPublicResource(db, reader, "assistant", bot.id, false);
  expect((await knowledgeAssistantAccess(db, reader, bot)).connected).toBe(
    false,
  );
});
it("catalog paginates stable results and escapes wildcard characters", async () => {
  await policy({ document: "discover" });
  for (let i = 0; i < 52; i++) await resource("document", `Page ${i}`);
  const first = await catalogPage(db, reader, {}),
    second = await catalogPage(db, reader, { offset: 50 });
  expect(first.total).toBe(52);
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(2);
  expect(new Set([...ids(first), ...ids(second)]).size).toBe(52);
  expect((await catalogPage(db, reader, { q: "%" })).items).toHaveLength(0);
});

it("HTTP policy validates four independent modes and hides discovery when all are link-only", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerDistribution } = await import("@server/routes/discovery.js");
  const app = Fastify();
  registerDistribution(
    app,
    db,
    () => reader,
    () => owner,
  );
  try {
    const config = (
      await app.inject({ url: "/api/v1/admin/distribution" })
    ).json();
    const modes = {
      document: "link",
      library: "link",
      assistant: "link",
      folder: "link",
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/distribution",
      payload: { ...config, publicModes: modes },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/discovery/policy" })).json(),
    ).toMatchObject({ publicDiscovery: false, publicModes: modes });
    const doc = await resource("document", "Collect over HTTP");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/discovery/entries/document/${doc.id}`,
          payload: { collected: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ url: "/api/v1/discovery/resources?collected=true" })
      ).json().items[0].id,
    ).toBe(doc.id);
    const next = {
      ...saved.json(),
      publicModes: { ...modes, folder: "discover" },
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/distribution",
          payload: next,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/discovery/policy" })).json()
        .publicDiscovery,
    ).toBe(true);
    expect(
      (await app.inject({ url: "/api/v1/discovery/resources?kind=unknown" }))
        .statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

it("collects own and already-authorized public resources without changing their original search eligibility", async () => {
  await policy({ document: "discover" });
  const doc = await resource("document", "Own and shared public document");
  expect(ids(await catalogPage(db, owner, {}))).toContain(doc.id);
  await collectPublicResource(db, owner, "document", doc.id, true);
  await collectPublicResource(db, owner, "document", doc.id, true);
  expect(ids(await catalogPage(db, owner, { collected: true }))).toEqual([
    doc.id,
  ]);
  expect(
    await db
      .selectFrom("resource_collections")
      .selectAll()
      .where("user_id", "=", owner.id)
      .execute(),
  ).toHaveLength(1);
  await collectPublicResource(db, owner, "document", doc.id, false);
  expect(ids(await content.list(owner, { scope: "personal" }))).toContain(
    doc.id,
  );

  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...distributionDefaults,
        sharedDocuments: "granted",
        publicModes: { document: "discover" },
      }),
    })
    .execute();
  const current = (await content.detail(owner, doc.id)).resource;
  await content.permissions(owner, doc.id, {
    version: current.version,
    grants: [{ userId: reader.id, role: "reader" }],
  });
  const grantsBefore = await db
    .selectFrom("grants")
    .selectAll()
    .where("user_id", "=", reader.id)
    .execute();
  await collectPublicResource(db, reader, "document", doc.id, true);
  expect(ids(await catalogPage(db, reader, { collected: true }))).toEqual([
    doc.id,
  ]);
  await collectPublicResource(db, reader, "document", doc.id, false);
  expect(ids(await content.list(reader, { scope: "personal" }))).toContain(
    doc.id,
  );
  expect(
    await db
      .selectFrom("grants")
      .selectAll()
      .where("user_id", "=", reader.id)
      .execute(),
  ).toEqual(grantsBefore);
});

it("collection does not overwrite Q&A connection preferences or automatically import connections", async () => {
  const { saveKnowledgeAssistantConnection } =
    await import("@core/modules/knowledge/system.js");
  await policy({ assistant: "discover" });
  const bot = {
    id: randomUUID(),
    owner_id: owner.id,
    title: "Connected public bot",
    revision: 1,
    library_ids: "[]",
    member_ids: "[]",
    enabled: 1,
    visibility: "public",
    updated_at: new Date().toISOString(),
  };
  await db.insertInto("knowledge_assistants").values(bot).execute();
  await saveKnowledgeAssistantConnection(db, reader, bot.id, "enabled", 0);
  expect(ids(await catalogPage(db, reader, { collected: true }))).toEqual([]);
  await collectPublicResource(db, reader, "assistant", bot.id, true);
  await collectPublicResource(db, reader, "assistant", bot.id, false);
  expect(await knowledgeAssistantAccess(db, reader, bot)).toMatchObject({
    connected: true,
    preference: "enabled",
    preferenceRevision: 1,
  });
  await collectPublicResource(db, owner, "assistant", bot.id, true);
  expect(ids(await catalogPage(db, owner, { collected: true }))).toEqual([
    bot.id,
  ]);
});

it("allows collecting accessible private folders and bots, keeping collection separate from their access", async () => {
  const root = await folder();
  await collectPublicResource(db, owner, "folder", root.id, true);
  expect(ids(await catalogPage(db, owner, { collected: true }))).toEqual([
    root.id,
  ]);
  await collectPublicResource(db, owner, "folder", root.id, false);
  expect(await folderInSearch(db, owner, root.id)).toBe(true);
  const bot = {
    id: randomUUID(),
    owner_id: owner.id,
    title: "Private bot",
    revision: 1,
    library_ids: "[]",
    member_ids: "[]",
    enabled: 1,
    visibility: "invited",
    updated_at: new Date().toISOString(),
  };
  await db.insertInto("knowledge_assistants").values(bot).execute();
  await collectPublicResource(db, owner, "assistant", bot.id, true);
  expect(ids(await catalogPage(db, owner, { collected: true }))).toEqual([
    bot.id,
  ]);
  await expect(
    collectPublicResource(db, reader, "assistant", bot.id, true),
  ).rejects.toMatchObject({ status: 404 });
});
