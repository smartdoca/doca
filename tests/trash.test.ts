import { openTestDatabase as openDatabase } from "./database.js";
import { publishIntegrationEvents } from "@core/modules/automation/events.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { type DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createDocuments } from "./editor-client.js";
import { listTime } from "../apps/web/src/shared/utils/list-time.js";
let db: DB,
  owner: Actor,
  guest: Actor,
  content: ReturnType<typeof createContent>;
const commentBody = (text: string) => ({
  version: 1 as const,
  blocks: [
    { type: "paragraph" as const, children: [{ type: "text" as const, text }] },
  ],
});
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  guest = {
    ...(await createUser(
      db,
      { login: "guest", displayName: "Guest", password: "test-password-2026" },
      { actor: owner },
    )),
    admin: 0,
  };
  content = createContent(db);
});
afterEach(() => db.destroy());
const make = (title = "Trash test") =>
  content.create(owner, { kind: "document", format: "rich_text", title });
const targets = async () =>
  (await content.list(owner, { scope: "trash" })).items.map(
    ({ id, version }) => ({ id, version }),
  );

it("previews deleted rich text only for managers without recreating or editing state", async () => {
  const r = await make();
  await createDocuments(db).exchange(owner, r.id, {});
  const before = await db.selectFrom("document_states").selectAll().execute();
  await content.trash(owner, r.id, r.version);
  const preview = await content.trashPreview(owner, r.id);
  expect(preview.value).toBeDefined();
  expect(await db.selectFrom("document_states").selectAll().execute()).toEqual(
    before,
  );
  await expect(content.trashPreview(guest, r.id)).rejects.toThrow();
  await expect(content.detail(owner, r.id)).rejects.toThrow();
  const [target] = await targets();
  await content.trash(owner, r.id, target!.version, true);
  await expect(content.trashPreview(owner, r.id)).rejects.toThrow("已恢复");
});
it("previews spreadsheet baseline and original Yjs updates without joining or changing it", async () => {
  const r = await content.create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "Sheet",
  });
  const live = await createDocuments(db).exchange(owner, r.id, {});
  await content.trash(owner, r.id, r.version);
  const preview = await content.trashPreview(owner, r.id);
  expect(preview.surface).toMatchObject({
    epochId: live.epochId,
    baseline: (live as any).baseline,
    update: live.update,
  });
});
it("purges a complete library subtree and related rows but preserves unrelated files and audit", async () => {
  const lib = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Library",
  });
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Child",
    libraryId: lib.id,
  });
  const keep = await make("Keep");
  await createDocuments(db).exchange(owner, doc.id, {});
  await content.visit(owner, doc.id);
  await content.comment(owner, doc.id, commentBody("comment"), null);
  await content.reaction(owner, doc.id, "like", true);
  await content.trash(owner, lib.id, lib.version);
  const preview = await content.trashPreview(owner, lib.id);
  expect(preview.children).toEqual([{ id: doc.id, title: "Child" }]);
  await expect(
    content.purgeTrash(
      owner,
      (await targets()).filter((r) => r.id === lib.id),
    ),
  ).rejects.toThrow("子文档");
  const result = await content.purgeTrash(owner, await targets());
  expect(result.count).toBe(2);
  expect(
    (await db.selectFrom("resources").select("id").execute()).map((r) => r.id),
  ).toEqual([keep.id]);
  expect(await db.selectFrom("comments").selectAll().execute()).toHaveLength(0);
  expect(
    await db.selectFrom("document_states").selectAll().execute(),
  ).toHaveLength(0);
  await publishIntegrationEvents(db);
  expect(
    await db
      .selectFrom("integration_events")
      .selectAll()
      .where("type", "=", "resource.purged")
      .execute(),
  ).toHaveLength(2);
  expect(
    await db
      .selectFrom("audit_events")
      .selectAll()
      .where("resource_id", "is", null)
      .execute(),
  ).not.toHaveLength(0);
});
it("purges one trashed root together with already trashed descendants", async () => {
  const lib = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Library",
  });
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Child",
    libraryId: lib.id,
  });
  const now = new Date().toISOString();
  await db
    .insertInto("quick_note_compilations")
    .values({
      id: "compile-1",
      owner_id: owner.id,
      sources: "[]",
      request_hash: "hash",
      instruction: "note",
      model_id: "model",
      status: "done",
      markdown: "",
      error: "",
      document_id: doc.id,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await content.trash(owner, lib.id, lib.version);
  const root = (await content.list(owner, { scope: "trash" })).items.find(
    (item) => item.id === lib.id,
  )!;
  const result = await content.purgeDeleted(owner, root.id, root.version);
  expect(result.count).toBe(2);
  expect(await db.selectFrom("resources").selectAll().execute()).toHaveLength(
    0,
  );
  expect(
    await db
      .selectFrom("quick_note_compilations")
      .select("document_id")
      .executeTakeFirst(),
  ).toEqual({ document_id: null });
});
it("refuses to purge a trashed parent that still has a live child", async () => {
  const lib = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Library",
  });
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Child",
    libraryId: lib.id,
  });
  await content.trash(owner, lib.id, lib.version);
  await db
    .updateTable("resources")
    .set({ deleted_at: null, delete_batch: null })
    .where("id", "=", doc.id)
    .execute();
  const root = (await content.list(owner, { scope: "trash" })).items.find(
    (item) => item.id === lib.id,
  )!;
  await expect(
    content.purgeDeleted(owner, root.id, root.version),
  ).rejects.toThrow("子文档");
  expect(await db.selectFrom("resources").selectAll().execute()).toHaveLength(
    2,
  );
});
it("rejects unauthorized, duplicate, active, stale or restored purge targets atomically", async () => {
  const a = await make("A"),
    b = await make("B");
  await expect(
    content.purgeTrash(owner, [{ id: a.id, version: a.version }]),
  ).rejects.toThrow();
  await content.trash(owner, a.id, a.version);
  await content.trash(owner, b.id, b.version);
  const selected = await targets();
  await expect(content.purgeTrash(guest, selected)).rejects.toThrow();
  await expect(
    content.purgeTrash(owner, [selected[0]!, selected[0]!]),
  ).rejects.toThrow();
  const bv = selected.find((r) => r.id === b.id)!;
  await content.trash(owner, b.id, bv.version, true);
  await expect(content.purgeTrash(owner, selected)).rejects.toThrow();
  expect(await db.selectFrom("resources").selectAll().execute()).toHaveLength(
    2,
  );
});
it("formats list times at day boundaries with invalid fallbacks", () => {
  const now = new Date(2026, 8, 11, 15, 0).getTime();
  expect(listTime(new Date(now - 1000).toISOString(), now)).toBe("刚刚");
  expect(listTime(new Date(now - 120000).toISOString(), now)).toBe("2 分钟前");
  expect(listTime(new Date(now - 7200000).toISOString(), now)).toBe("2 小时前");
  expect(listTime(new Date(2026, 8, 11, 8, 0).toISOString(), now)).toBe(
    "今天 08:00",
  );
  expect(listTime(new Date(2026, 8, 10, 8, 0).toISOString(), now)).toBe(
    "昨天 08:00",
  );
  expect(listTime(new Date(2026, 8, 1).toISOString(), now)).toBe("2026/09/01");
  expect(listTime("invalid", now)).toBe("—");
  expect(listTime(undefined, now)).toBe("—");
});
