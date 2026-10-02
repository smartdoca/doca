import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUserDirectory } from "@core/modules/discovery/users.js";
import { registerDirectorySource } from "@core/modules/discovery/directory-registry.js";
import { createContent } from "@core/workflows/resources.js";
import {
  visibleUsers,
  validateNewMentions,
} from "@core/modules/interactions/community.js";
let db: DB;
const actor = { id: "owner", display_name: "Owner", admin: 0 };
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  await db
    .insertInto("users")
    .values(
      ["owner", "a", "b", "c"].map((id) => ({
        id,
        display_name: id === "owner" ? "Owner" : "Same",
        public_id: id,
        login: id,
        status: "active",
        admin: 0,
        password_hash: "unused",
        created_at: new Date().toISOString(),
      })),
    )
    .execute();
});
afterEach(async () => {
  await db.destroy();
});
function relation(
  id: string,
  ids: string[],
  related = vi.fn(async () => ({
    items: ids.map((userId) => ({ userId, relationId: userId, revision: "1" })),
    cursor: null,
  })),
) {
  const dispose = registerDirectorySource(db, {
    id,
    schemaVersion: 1,
    related,
    async verify(_id, items) {
      return items.map((item) => item.userId);
    },
  });
  return { related, dispose };
}
it("skips sources in all/none, applies user override, binds cursors to query and policy", async () => {
  const source = relation("test.users", ["a"]);
  const directory = createUserDirectory(db);
  const first = await directory.search(actor, { query: "Same", limit: 1 });
  expect(first.items.map((user) => user.id)).toEqual(["a"]);
  expect(first.nextCursor).not.toBeNull();
  const second = await directory.search(actor, {
    query: "Same",
    limit: 1,
    cursor: first.nextCursor,
  });
  expect(second.items.map((user) => user.id)).toEqual(["b"]);
  expect(source.related).not.toHaveBeenCalled();
  await expect(
    directory.search(actor, { query: "other", cursor: first.nextCursor }),
  ).rejects.toMatchObject({ status: 400 });
  await db
    .updateTable("settings")
    .set({ directory_mode: "none" })
    .where("id", "=", "system")
    .execute();
  expect((await directory.search(actor, { query: "" })).items).toEqual([]);
  await expect(
    directory.search(actor, { query: "Same", cursor: first.nextCursor }),
  ).rejects.toMatchObject({ status: 400 });
  expect(source.related).not.toHaveBeenCalled();
  await db
    .updateTable("users")
    .set({ directory_mode: "related" })
    .where("id", "=", actor.id)
    .execute();
  expect(
    (await directory.search(actor, { query: "" })).items.map((user) => user.id),
  ).toEqual(["a"]);
  expect(source.related).toHaveBeenCalledOnce();
});
it("deduplicates sources, filters disabled users, marks partial results and checks selected IDs again", async () => {
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  const one = relation("test.one", ["a", "b"]);
  relation("test.two", ["a", "c"]);
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", "c")
    .execute();
  registerDirectorySource(db, {
    id: "test.offline",
    schemaVersion: 1,
    async related() {
      throw new Error("offline");
    },
    async verify() {
      return [];
    },
  });
  const directory = createUserDirectory(db);
  const result = await directory.search(actor, { query: "" });
  expect(result.items.map((user) => user.id)).toEqual(["a", "b"]);
  expect(result.complete).toBe(false);
  expect(await visibleUsers(db, actor, "")).toEqual(result.items);
  expect(
    (await directory.resolve(actor, { ids: ["b", "a", "owner", "a"] })).map(
      (user) => user.id,
    ),
  ).toEqual(["b", "a"]);
  await directory.validate(actor, { ids: ["b"] });
  one.dispose();
  await expect(directory.validate(actor, { ids: ["b"] })).rejects.toMatchObject(
    { status: 403 },
  );
  await expect(
    validateNewMentions(db, actor, new Set(["b"])),
  ).rejects.toMatchObject({ status: 403 });
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", actor.id)
    .execute();
  await expect(directory.search(actor, { query: "" })).rejects.toMatchObject({
    status: 401,
  });
});
it("uses current built-in document relationships and works inside content transactions", async () => {
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  const doc = await createContent(db).create(actor, {
    title: "Shared",
    kind: "document",
    format: "markdown",
  });
  await db
    .insertInto("grants")
    .values({
      resource_id: doc.id,
      user_id: "a",
      role: "reader",
      status: "active",
      source_type: "direct",
      source_id: "",
      created_by: actor.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  expect(
    (await createUserDirectory(db).search(actor, { query: "Same" })).items.map(
      (user) => user.id,
    ),
  ).toEqual(["a"]);
  await db.transaction().execute(async (tx) => {
    // Real content workflows inherit the runtime scope before mention validation.
    const { inheritDatabaseRuntimeScope } =
      await import("@db/runtime-scope.js");
    inheritDatabaseRuntimeScope(db, tx);
    await validateNewMentions(tx, actor, new Set(["a"]));
  });
  await db
    .updateTable("grants")
    .set({ status: "disabled" })
    .where("user_id", "=", "a")
    .execute();
  expect(
    (await createUserDirectory(db).search(actor, { query: "Same" })).items,
  ).toEqual([]);
});
it("does not return a removed source's in-flight candidates and propagates cancellation", async () => {
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  let dispose = () => {};
  dispose = registerDirectorySource(db, {
    id: "test.disposed",
    schemaVersion: 1,
    async related() {
      dispose();
      return {
        items: [{ userId: "a", relationId: "a", revision: "1" }],
        cursor: null,
      };
    },
    async verify() {
      return ["a"];
    },
  });
  expect(
    await createUserDirectory(db).search(actor, { query: "Same" }),
  ).toMatchObject({ items: [], complete: false });
  const controller = new AbortController();
  controller.abort();
  await expect(
    createUserDirectory(db).search(actor, { query: "" }, controller.signal),
  ).rejects.toThrow();
});
it("rejects a directory policy changed during a relationship provider call", async () => {
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  registerDirectorySource(db, {
    id: "test.race",
    schemaVersion: 1,
    async related() {
      await db
        .updateTable("settings")
        .set({ directory_mode: "none" })
        .where("id", "=", "system")
        .execute();
      return {
        items: [{ userId: "a", relationId: "a", revision: "1" }],
        cursor: null,
      };
    },
    async verify() {
      return ["a"];
    },
  });
  await expect(
    createUserDirectory(db).search(actor, { query: "" }),
  ).rejects.toMatchObject({ status: 409 });
});
it("includes only current shared-folder members and removes revoked relationships", async () => {
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  const now = new Date().toISOString();
  await db
    .insertInto("file_folders")
    .values({
      id: "folder",
      name: "Shared",
      owner_id: actor.id,
      parent_id: "shared",
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .execute();
  await db
    .insertInto("file_folder_shares")
    .values({
      folder_id: "folder",
      user_id: "a",
      role: "reader",
      version: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  expect(
    (await createUserDirectory(db).search(actor, { query: "Same" })).items.map(
      (row) => row.id,
    ),
  ).toEqual(["a"]);
  await db
    .deleteFrom("file_folder_shares")
    .where("folder_id", "=", "folder")
    .execute();
  expect(
    (await createUserDirectory(db).search(actor, { query: "Same" })).items,
  ).toEqual([]);
});
it("cancels in-flight providers even when they ignore their signal", async () => {
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  registerDirectorySource(db, {
    id: "test.hanging",
    schemaVersion: 1,
    async related() {
      started();
      return new Promise<never>(() => {});
    },
    async verify() {
      return [];
    },
  });
  const controller = new AbortController();
  const request = createUserDirectory(db).search(
    actor,
    { query: "" },
    controller.signal,
  );
  const result = expect(request).rejects.toThrow();
  await ready;
  controller.abort();
  await result;
});
