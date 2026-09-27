import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import {
  recentActivity,
  recordActivity,
  setAssistantFavorite,
} from "@core/modules/workspace/activity.js";
import { homeOverview } from "@core/modules/workspace/home.js";
import { collectPublicResource } from "@core/modules/discovery/catalog.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import {
  knowledgeAssistantAccess,
  visitKnowledgeAssistant,
} from "@core/modules/knowledge/system.js";
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
          assistant: "link",
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
          assistant: "search",
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
it("merges folder and assistant visits and removes revoked access, without changing assistant integration", async () => {
  const now = new Date().toISOString(),
    folder = randomUUID(),
    bot = randomUUID();
  await db
    .insertInto("file_folders")
    .values({
      id: folder,
      name: "Published folder",
      version: 1,
      owner_id: owner.id,
      parent_id: "shared",
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .execute();
  await db
    .insertInto("folder_publications")
    .values({ folder_id: folder, enabled: 1, revision: 1 })
    .execute();
  await db
    .insertInto("knowledge_assistants")
    .values({
      id: bot,
      owner_id: owner.id,
      title: "Public bot",
      revision: 1,
      library_ids: "[]",
      member_ids: "[]",
      manager_ids: "[]",
      visibility: "public",
      enabled: 1,
      config: "{}",
      updated_at: now,
    })
    .execute();
  await recordActivity(db, reader.id, "folder", folder);
  await visitKnowledgeAssistant(db, reader, bot);
  expect(
    (await recentActivity(db, reader, { publicOnly: true })).items
      .map((x) => x.kind)
      .sort(),
  ).toEqual(["assistant", "folder"]);
  await setAssistantFavorite(db, reader, bot, true);
  const row = await db
    .selectFrom("knowledge_assistants")
    .selectAll()
    .where("id", "=", bot)
    .executeTakeFirstOrThrow();
  expect((await knowledgeAssistantAccess(db, reader, row)).favorite).toBe(true);
  expect((await knowledgeAssistantAccess(db, reader, row)).connected).toBe(
    false,
  );
  await db.updateTable("folder_publications").set({ enabled: 0 }).execute();
  await db
    .updateTable("knowledge_assistants")
    .set({ visibility: "invited" })
    .execute();
  expect((await recentActivity(db, reader)).items).toEqual([]);
});
it("shows only current maintainers their human decisions and removes resolved work", async () => {
  const c = createContent(db),
    lib = await c.create(owner, {
      kind: "library",
      format: "markdown",
      title: "Managed library",
    });
  await db
    .updateTable("resources")
    .set({ ai_curated: 1 })
    .where("id", "=", lib.id)
    .execute();
  const { createKnowledgeConversation } =
    await import("@core/modules/knowledge/conversations.js");
  const { upsertHumanTask, closeHumanTask } =
    await import("@core/modules/knowledge/human-tasks.js");
  const conversation = await createKnowledgeConversation(
    db,
    owner,
    lib.id,
    "curation",
    "Review",
  );
  const task = await upsertHumanTask(db, owner, lib.id, conversation.id, {
    key: "decision",
    kind: "decision",
    title: "Choose a policy",
    detail: { reason: "manual_decision" },
  });
  expect(
    (await homeOverview(db, reader)).todos.flatMap((x) => x.items),
  ).toEqual([]);
  const overview = await homeOverview(db, owner);
  expect(
    overview.todos.find((x) => x.kind === "curation")?.items.map((x) => x.id),
  ).toContain(task.id);
  await closeHumanTask(db, owner, lib.id, task.id, task.revision, "done");
  expect((await homeOverview(db, owner)).todos.flatMap((x) => x.items)).toEqual(
    [],
  );
});
