import { openTestDatabase as openDatabase } from "./database.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type DB, type Resource } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { treePlacement } from "../apps/web/src/features/documents/tree-order.js";
let db: DB,
  actor: Actor,
  peer: Actor,
  content: ReturnType<typeof createContent>,
  lib: Resource;
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  actor = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  peer = {
    ...(await createUser(
      db,
      { login: "peer", displayName: "Peer", password: "test-password-2026" },
      { actor },
    )),
    admin: 0,
  };
  content = createContent(db);
  lib = await content.create(actor, {
    kind: "library",
    format: "rich_text",
    title: "Library",
  });
});
afterEach(() => db.destroy());
const create = (title: string, parentId?: string, libraryId: string = lib.id) =>
  content.create(actor, {
    kind: "document",
    format: "rich_text",
    title,
    parentId,
    libraryId,
  });
const ordered = async (parent: string | null, library: string | null = null) =>
  (await db.selectFrom("resources").selectAll().execute())
    .filter(
      (r) =>
        r.parent_id === parent &&
        r.library_id === library &&
        r.kind === "document",
    )
    .sort((a, b) => a.tree_order! - b.tree_order!)
    .map((r) => r.id);
it.each([false, true])(
  "copies a document beside its source and retains its subtree (nested=%s)",
  async (nested) => {
    const parent = nested ? await create("Parent") : null;
    const source = await create("Source", parent?.id);
    const first = await create("First", source.id);
    const second = await create("Second", source.id);
    const grandchild = await create("Grandchild", second.id);
    await content.arrange(actor, second.id, {
      version: second.version,
      targetId: first.id,
      placement: "before",
    });
    const before = await db.selectFrom("resources").selectAll().execute();

    const copied = await content.copy(actor, source.id, {
      parentId: source.parent_id,
      libraryId: source.library_id,
      includeChildren: true,
    });

    const rows = await db.selectFrom("resources").selectAll().execute();
    const copies = rows.filter((r) => !before.some((old) => old.id === r.id));
    expect(copies).toHaveLength(4);
    expect(copies.every((r) => r.library_id === lib.id)).toBe(true);
    expect(copies.every((r) => r.access_mode === "inherit")).toBe(true);
    expect(copies.find((r) => r.id === copied.id)).toMatchObject({
      parent_id: parent?.id ?? null,
      title: "Source 副本",
    });
    expect(await ordered(parent?.id ?? null, lib.id)).toEqual([
      source.id,
      copied.id,
    ]);
    const copiedFirst = copies.find((r) => r.title === "First")!;
    const copiedSecond = copies.find((r) => r.title === "Second")!;
    expect(await ordered(copied.id, lib.id)).toEqual([
      copiedSecond.id,
      copiedFirst.id,
    ]);
    expect(copies.find((r) => r.title === "Grandchild")).toMatchObject({
      parent_id: copiedSecond.id,
    });
    expect(before.map((r) => rows.find((row) => row.id === r.id))).toEqual(before);
    expect(copies.some((r) => r.id === grandchild.id)).toBe(false);
  },
);
it.each([false, true])(
  "requires write access to the copy destination (nested=%s)",
  async (nested) => {
    const parent = nested ? await create("Parent") : null;
    const source = await create("Source", parent?.id);
    const child = await create("Child", source.id);
    await content.permissions(actor, lib.id, {
      version: lib.version,
      accessMode: "custom",
      grants: [{ userId: peer.id, role: "reader" }],
    });
    const input = {
      parentId: source.parent_id,
      libraryId: source.library_id,
      includeChildren: true,
    };
    const before = await db.selectFrom("resources").selectAll().execute();
    await expect(content.copy(peer, source.id, input)).rejects.toMatchObject({
      status: 403,
    });
    expect(await db.selectFrom("resources").selectAll().execute()).toEqual(before);

    const latest = (await content.detail(actor, lib.id)).resource;
    await content.permissions(actor, lib.id, {
      version: latest.version,
      grants: [{ userId: peer.id, role: "editor" }],
    });
    const copied = await content.copy(peer, source.id, input);
    expect((await content.detail(actor, copied.id)).resource).toMatchObject({
      parent_id: parent?.id ?? null,
      library_id: lib.id,
      owner_id: peer.id,
    });
    const children = await ordered(copied.id, lib.id);
    expect(children).toHaveLength(1);
    expect(children[0]).not.toBe(child.id);
  },
);
it.each(["inherit", "custom"] as const)(
  "drag preserves %s access mode and follows the new parent only when inherited",
  async (accessMode) => {
    const first = await create("原父级"),
      second = await create("新父级"),
      child = await create("移动文档", first.id);
    await content.permissions(actor, first.id, {
      version: first.version,
      visibility: "invited",
      accessMode: "custom",
      grants: [{ userId: peer.id, role: "reader" }],
    });
    await content.permissions(actor, second.id, {
      version: second.version,
      visibility: "invited",
      accessMode: "custom",
      grants: [{ userId: peer.id, role: "editor" }],
    });
    await content.permissions(actor, child.id, {
      version: child.version,
      visibility: "invited",
      accessMode,
      grants:
        accessMode === "custom" ? [{ userId: peer.id, role: "reader" }] : [],
    });
    const before = (await content.detail(actor, child.id)).resource;
    expect((await content.detail(peer, child.id)).resource.role).toBe("reader");
    await content.arrange(actor, child.id, {
      version: before.version,
      targetId: second.id,
      placement: "inside",
    });
    expect((await content.detail(actor, child.id)).resource.access_mode).toBe(
      accessMode,
    );
    expect((await content.detail(peer, child.id)).resource.role).toBe(
      accessMode === "inherit" ? "editor" : "reader",
    );
  },
);
it("uses predictable edge and middle drop zones, including small rows", () => {
  expect(treePlacement(101, 100, 36)).toBe("before");
  expect(treePlacement(109, 100, 36)).toBe("inside");
  expect(treePlacement(126, 100, 36)).toBe("inside");
  expect(treePlacement(128, 100, 36)).toBe("after");
  expect(treePlacement(112, 100, 24)).toBe("inside");
});
it.each(["after", "inside"] as const)(
  "moves a subtree with retained trash (%s) and restores it beneath the same parent",
  async (placement) => {
    const parent = await create("Old parent"),
      source = await create("Source", parent.id),
      target = await create("Target");
    const live = await create("Live child", source.id);
    const deleted = await content.create(actor, {
      kind: "document",
      format: "markdown",
      title: "Retained trash",
      libraryId: lib.id,
      parentId: source.id,
      markdown: "# Retained content\nDo not lose this text.",
    });
    const grandchild = await create("Deleted grandchild", deleted.id);
    await content.permissions(actor, deleted.id, {
      version: deleted.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: peer.id, role: "reader" }],
    });
    const latest = (await content.detail(actor, deleted.id)).resource;
    await content.trash(actor, deleted.id, latest.version);
    const rows = await db
      .selectFrom("resources")
      .selectAll()
      .where("id", "in", [live.id, deleted.id, grandchild.id])
      .orderBy("id")
      .execute();
    const states = await db
      .selectFrom("document_states")
      .selectAll()
      .orderBy("resource_id")
      .execute();
    const grants = await db
      .selectFrom("grants")
      .selectAll()
      .orderBy("resource_id")
      .orderBy("user_id")
      .execute();
    await content.arrange(actor, source.id, {
      version: source.version,
      targetId: target.id,
      placement,
    });
    expect((await content.detail(actor, source.id)).resource.parent_id).toBe(
      placement === "inside" ? target.id : null,
    );
    expect(
      await db
        .selectFrom("resources")
        .selectAll()
        .where("id", "in", [live.id, deleted.id, grandchild.id])
        .orderBy("id")
        .execute(),
    ).toEqual(rows);
    expect(
      await db
        .selectFrom("document_states")
        .selectAll()
        .orderBy("resource_id")
        .execute(),
    ).toEqual(states);
    expect(
      await db
        .selectFrom("grants")
        .selectAll()
        .orderBy("resource_id")
        .orderBy("user_id")
        .execute(),
    ).toEqual(grants);
    const trashed = rows.find((r) => r.id === deleted.id)!;
    await content.trash(actor, deleted.id, trashed.version, true);
    expect((await content.detail(actor, deleted.id)).resource).toMatchObject({
      parent_id: source.id,
      deleted_at: null,
    });
    expect((await content.detail(actor, grandchild.id)).resource).toMatchObject(
      { parent_id: deleted.id, deleted_at: null },
    );
    expect((await content.detail(peer, deleted.id)).resource.role).toBe(
      "reader",
    );
    expect(
      await db
        .selectFrom("document_states")
        .select("text")
        .where("resource_id", "=", deleted.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      text: expect.stringContaining("Do not lose this text."),
    });
  },
);

it.each([false, true])(
  "still rejects moving descendants without management permission (trashed=%s)",
  async (trashed) => {
    const parent = await create("Parent"),
      source = await create("Source", parent.id),
      child = await create("Restricted", source.id),
      target = await create("Target");
    await content.permissions(actor, lib.id, {
      version: lib.version,
      visibility: "invited",
      grants: [{ userId: peer.id, role: "editor" }],
    });
    await content.permissions(actor, source.id, {
      version: source.version,
      visibility: "invited",
      accessMode: "custom",
      grants: [{ userId: peer.id, role: "manager" }],
    });
    await content.permissions(actor, child.id, {
      version: child.version,
      visibility: "invited",
      accessMode: "custom",
      grants: [{ userId: peer.id, role: "reader" }],
    });
    if (trashed) await content.trash(actor, child.id, child.version + 1);
    const before = await db
      .selectFrom("resources")
      .selectAll()
      .orderBy("id")
      .execute();
    await expect(
      content.arrange(peer, source.id, {
        version: source.version + 1,
        targetId: target.id,
        placement: "after",
      }),
    ).rejects.toThrow("需要管理整个子树");
    expect(
      await db.selectFrom("resources").selectAll().orderBy("id").execute(),
    ).toEqual(before);
  },
);
it("keeps creation order through rename, appends new siblings and persists drag order", async () => {
  const a = await create("Z"),
    b = await create("A"),
    c = await create("M");
  await content.rename(actor, a.id, "0", a.version);
  expect(await ordered(null, lib.id)).toEqual([a.id, b.id, c.id]);
  await content.arrange(actor, b.id, {
    version: b.version,
    targetId: c.id,
    placement: "after",
  });
  const d = await create("1");
  expect(await ordered(null, lib.id)).toEqual([a.id, c.id, b.id, d.id]);
  await expect(
    content.arrange(actor, b.id, {
      version: b.version,
      targetId: a.id,
      placement: "before",
    }),
  ).rejects.toThrow();
});
it("nests at the end without clearing explicit grants and prevents cycles and cross-library moves", async () => {
  const a = await create("A"),
    child = await create("child", a.id),
    b = await create("B");
  await content.permissions(actor, b.id, {
    version: b.version,
    visibility: "invited",
    accessMode: "custom",
    grants: [{ userId: peer.id, role: "reader" }],
  });
  const latest = (await content.detail(actor, b.id)).resource;
  await content.arrange(actor, b.id, {
    version: latest.version,
    targetId: a.id,
    placement: "inside",
  });
  expect(await ordered(a.id, lib.id)).toEqual([child.id, b.id]);
  expect((await content.detail(peer, b.id)).resource.role).toBe("reader");
  await expect(
    content.arrange(actor, a.id, {
      version: a.version,
      targetId: b.id,
      placement: "inside",
    }),
  ).rejects.toThrow();
  await expect(
    content.arrange(peer, b.id, {
      version: latest.version + 1,
      targetId: child.id,
      placement: "after",
    }),
  ).rejects.toThrow();
  const other = await content.create(actor, {
    kind: "library",
    format: "rich_text",
    title: "Other Library",
  });
  const doc = await create("other library doc", undefined, other.id);
  await expect(
    content.arrange(actor, a.id, {
      version: a.version,
      targetId: doc.id,
      placement: "after",
    }),
  ).rejects.toThrow();
  const second = await create("second");
  await content.arrange(actor, second.id, {
    version: second.version,
    targetId: a.id,
    placement: "before",
  });
  expect(await ordered(null, lib.id)).toEqual([second.id, a.id]);
});
