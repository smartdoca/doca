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
