import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  subscribeKnowledgeSource,
  updateKnowledgeSourceGroup,
  listKnowledgeSubscriptions,
  deleteKnowledgeSourceGroup,
} from "@core/modules/knowledge/subscriptions.js";
import { knowledgeSourceMembers } from "@core/modules/knowledge/source-members.js";
import {
  createKnowledgeStudio,
  runSourceAction,
} from "../apps/server/src/services/ai/knowledge-studio.js";
import { knowledgeInstructions } from "@core/modules/knowledge/system.js";
let db: DB, actor: Actor, library: string;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  actor = { id: randomUUID(), display_name: "Admin", admin: 0 };
  await db
    .insertInto("users")
    .values({
      ...actor,
      login: "admin",
      password_hash: "unused",
      status: "active",
      created_at: new Date().toISOString(),
    })
    .execute();
  library = (
    await createContent(db).create(actor, {
      kind: "library",
      format: "markdown",
      title: "Target",
    })
  ).id;
});
afterEach(() => db.destroy());
it("groups multiple links without losing individual provenance and rejects mixed types atomically", async () => {
  const group = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "url",
    title: "RFC",
    urls: [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/a",
    ],
  });
  expect(group.members).toHaveLength(2);
  const listed = await listKnowledgeSubscriptions(db, actor, library);
  expect(listed.groups).toHaveLength(1);
  expect(listed.items.every((x) => x.groupId === group.groupId)).toBe(true);
  await expect(
    subscribeKnowledgeSource(db, actor, library, {
      sourceKind: "url",
      urls: ["https://example.org"],
      sourceIds: [randomUUID()],
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    subscribeKnowledgeSource(db, actor, library, {
      sourceKind: "url",
      urls: ["https://valid.example.org", "not a URL"],
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (await listKnowledgeSubscriptions(db, actor, library)).items,
  ).toHaveLength(2);
});
it("deletes a source group and keeps detached subscriptions out of curation", async () => {
  const group = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "url",
    title: "RFC",
    urls: ["https://example.com/a"],
  });
  await deleteKnowledgeSourceGroup(db, actor, library, group.groupId!);
  const listed = await listKnowledgeSubscriptions(db, actor, library);
  expect(listed.groups).toHaveLength(0);
  expect(listed.items.filter((item) => item.status !== "detached")).toHaveLength(0);
  expect(listed.items).toHaveLength(1);
});
it("edits a group without erasing removed-source provenance and controls the whole group", async () => {
  const group = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "url",
    urls: ["https://example.com/a", "https://example.com/b"],
  });
  await updateKnowledgeSourceGroup(db, actor, library, group.groupId!, {
    title: "Standards",
    urls: ["https://example.com/b", "https://example.com/c"],
  });
  let listed = await listKnowledgeSubscriptions(db, actor, library);
  expect(listed.groups[0]?.title).toBe("Standards");
  expect(listed.items.filter((x) => x.status !== "detached")).toHaveLength(2);
  expect(listed.items.find((x) => x.url.endsWith("/a"))?.status).toBe(
    "detached",
  );
  await runSourceAction(db, actor, library, {
    sourceKey: group.groupId!,
    action: "pause",
    reason: "maintenance",
  });
  expect(
    (await knowledgeInstructions(db, actor, library)).settings
      .excludedSourceIds,
  ).toHaveLength(2);
  await expect(
    updateKnowledgeSourceGroup(db, actor, library, group.groupId!, {
      sourceIds: [randomUUID()],
    }),
  ).rejects.toMatchObject({ status: 400 });
});
it("recursively resolves library and node subscriptions, including future descendants and excluding denied branches", async () => {
  const resources = createContent(db),
    sourceLibrary = await resources.create(actor, {
      kind: "library",
      format: "markdown",
      title: "Internal",
    });
  const parent = await resources.create(actor, {
    kind: "document",
    format: "markdown",
    libraryId: sourceLibrary.id,
    title: "Parent",
  });
  const group = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "library",
    sourceIds: [sourceLibrary.id],
  });
  const row = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("id", "=", group.id)
    .executeTakeFirstOrThrow();
  expect(
    (await knowledgeSourceMembers(db, actor, row)).map((x) => x.id),
  ).toEqual([parent.id]);
  const child = await resources.create(actor, {
    kind: "document",
    format: "markdown",
    libraryId: sourceLibrary.id,
    parentId: parent.id,
    title: "Child",
  });
  expect(
    (await knowledgeSourceMembers(db, actor, row)).map((x) => x.id),
  ).toEqual([parent.id, child.id].sort());
  expect(await knowledgeSourceMembers(db, actor, row, [parent.id])).toEqual([]);
  const studio = createKnowledgeStudio(db);
  const catalog = await studio.executeTool(actor, library, "read_source", {
    sourceId: row.id,
  });
  expect((catalog as any).members).toHaveLength(2);
  await expect(
    studio.executeTool(actor, library, "read_source", {
      sourceId: row.id,
      memberId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 403 });
  const node = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "document",
    sourceIds: [parent.id],
  });
  const nodeRow = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("id", "=", node.id)
    .executeTakeFirstOrThrow();
  expect(await knowledgeSourceMembers(db, actor, nodeRow)).toHaveLength(2);
});
it("rolls back the entire group when one chosen internal source is unavailable", async () => {
  const doc = await createContent(db).create(actor, {
    kind: "document",
    format: "markdown",
    title: "Available",
  });
  await expect(
    subscribeKnowledgeSource(db, actor, library, {
      sourceKind: "document",
      sourceIds: [doc.id, randomUUID()],
    }),
  ).rejects.toBeDefined();
  expect((await listKnowledgeSubscriptions(db, actor, library)).items).toEqual(
    [],
  );
});
it("new members inherit the group's pause and shared guide", async () => {
  const group = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "url",
    title: "RFC",
    guide: "Read only normative sections",
    urls: ["https://example.com/a"],
  });
  await runSourceAction(db, actor, library, {
    sourceKey: group.groupId!,
    action: "pause",
    reason: "pause all",
  });
  await updateKnowledgeSourceGroup(db, actor, library, group.groupId!, {
    urls: ["https://example.com/a", "https://example.com/b"],
  });
  const bundle = await knowledgeInstructions(db, actor, library),
    rows = (await listKnowledgeSubscriptions(db, actor, library)).items;
  expect(rows).toHaveLength(2);
  expect(
    rows.every((x) => bundle.settings.excludedSourceIds.includes(x.id)),
  ).toBe(true);
  expect(
    rows.every((x) =>
      bundle.files
        .find((f) => f.path === `sources/${x.id}/SOURCE.md`)
        ?.markdown.includes("normative"),
    ),
  ).toBe(true);
});
it("scans nested folders without a depth cap and detects later additions", async () => {
  const now = new Date().toISOString(),
    first = randomUUID(),
    second = randomUUID(),
    file = randomUUID();
  for (const [id, parent] of [
    [first, null],
    [second, first],
  ])
    await db
      .insertInto("file_folders")
      .values({
        id: id!,
        owner_id: actor.id,
        name: id!,
        parent_id: parent,
        version: 1,
        deleted_at: null,
        delete_batch: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  const profile = randomUUID(),
    object = randomUUID();
  await db
    .insertInto("storage_profiles")
    .values({
      id: profile,
      provider: "local",
      config: "{}",
      active: 0,
      created_at: now,
    })
    .execute();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: object,
      profile_id: profile,
      object_key: "isolated-recursive-test",
      sha256: "fixture",
      size: 1,
      mime: "text/plain",
      created_at: now,
    })
    .execute();
  await db
    .insertInto("file_items")
    .values({
      id: file,
      owner_id: actor.id,
      name: "nested.txt",
      storage_object_id: object,
      mime: "text/plain",
      size: 1,
      metadata: "{}",
      ai_description_override: null,
      locked: 0,
      version: 1,
      deleted_at: null,
      delete_batch: null,
      parent_type: "folder",
      parent_id: second,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const group = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "folder",
    title: "Internal folders",
    sourceIds: [first],
  });
  const row = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("id", "=", group.id)
    .executeTakeFirstOrThrow();
  expect(
    (await knowledgeSourceMembers(db, actor, row)).map((x) => x.id),
  ).toEqual([file]);
  expect(await knowledgeSourceMembers(db, actor, row, [second])).toEqual([]);
});

it("clears a shared guide for existing members rather than retaining stale instructions", async () => {
  const group = await subscribeKnowledgeSource(db, actor, library, {
    sourceKind: "url",
    guide: "Outdated instructions",
    urls: ["https://example.com/a", "https://example.com/b"],
  });
  await updateKnowledgeSourceGroup(db, actor, library, group.groupId!, {
    guide: "",
  });
  const bundle = await knowledgeInstructions(db, actor, library);
  for (const member of group.members!)
    expect(
      bundle.files.find((f) => f.path === `sources/${member.id}/SOURCE.md`)
        ?.markdown,
    ).toBe("");
});
