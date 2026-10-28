import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB, Schema } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { authorize } from "@core/modules/access/queries.js";
import { authorizeFileItem } from "@core/modules/access/file-access.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import {
  userHandoverInventory,
  previewUserHandover,
  executeUserHandover,
} from "@core/modules/identity/resource-handover.js";
import { createApp } from "@server/app/create-app.js";

let db: DB,
  admin: Actor,
  source: Actor,
  target: Actor,
  other: Actor,
  content: ReturnType<typeof createContent>;
const password = "isolated-handover-2026";
const now = "2026-10-28T00:00:00.000Z";
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  admin = {
    ...(await createUser(
      db,
      { login: "handover-admin", displayName: "Administrator", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const add = async (login: string) => ({
    ...(await createUser(
      db,
      { login, displayName: login, password },
      { actor: admin },
    )),
    admin: 0,
  });
  source = await add("handover-source");
  target = await add("handover-target");
  other = await add("handover-other");
  content = createContent(db);
});
afterEach(async () => {
  await db.destroy();
});
const disable = () =>
  db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", source.id)
    .execute();
async function document(
  title: string,
  owner = source,
  parentId?: string,
  libraryId?: string,
) {
  return content.create(owner, {
    title,
    kind: "document",
    format: "rich_text",
    ...(parentId ? { parentId } : {}),
    ...(libraryId ? { libraryId } : {}),
  });
}
async function folder(
  name: string,
  parent: string | null = null,
  owner = source,
) {
  const row: Schema["file_folders"] = {
    id: randomUUID(),
    owner_id: owner.id,
    parent_id: parent,
    name,
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    delete_batch: null,
  };
  await db.insertInto("file_folders").values(row).execute();
  return row;
}
async function file(
  name: string,
  parentType: "system" | "folder" | "document" = "system",
  parentId = "root",
  metadata = "{}",
) {
  const id = randomUUID(),
    objectId = randomUUID(),
    profile = randomUUID();
  await db
    .insertInto("storage_profiles")
    .values({ id: profile, active: 0, created_at: now })
    .execute();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profile,
      object_key: randomUUID(),
      sha256: "a".repeat(64),
      size: 123,
      mime: "text/plain",
      created_at: now,
    })
    .execute();
  const row: Schema["file_items"] = {
    id,
    owner_id: source.id,
    parent_type: parentType,
    parent_id: parentId,
    storage_object_id: objectId,
    name,
    mime: "text/plain",
    size: 123,
    metadata,
    ai_description_override: null,
    locked: 0,
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    delete_batch: null,
  };
  await db.insertInto("file_items").values(row).execute();
  return { ...row, profile };
}
async function grant(
  id: string,
  user = source,
  role: "reader" | "commenter" | "editor" | "manager" = "reader",
  scope = 1,
  extra: Partial<Schema["grants"]> = {},
) {
  await db
    .insertInto("grants")
    .values({
      resource_id: id,
      user_id: user.id,
      role,
      include_descendants: scope,
      source_type: "direct",
      source_id: "",
      status: "active",
      ...extra,
    })
    .execute();
}
async function handover(keys: string[]) {
  const input = { targetUserId: target.id, keys };
  const preview = await previewUserHandover(db, admin, source.id, input);
  expect(preview.conflicts).toEqual([]);
  await executeUserHandover(db, admin, source.id, {
    ...input,
    fingerprint: preview.fingerprint,
  });
  return preview;
}
async function facts() {
  return {
    pendingEvents: await db
      .selectFrom("pending_integration_events")
      .selectAll()
      .orderBy("id")
      .execute(),
    events: await db
      .selectFrom("integration_events")
      .selectAll()
      .orderBy("id")
      .execute(),
    invitations: await db
      .selectFrom("access_invitations")
      .selectAll()
      .orderBy("resource_id")
      .execute(),
    folderInvitations: await db
      .selectFrom("file_folder_invitations")
      .selectAll()
      .orderBy("id")
      .execute(),
    resources: await db
      .selectFrom("resources")
      .selectAll()
      .orderBy("id")
      .execute(),
    grants: await db
      .selectFrom("grants")
      .selectAll()
      .orderBy("resource_id")
      .orderBy("user_id")
      .execute(),
    folders: await db
      .selectFrom("file_folders")
      .selectAll()
      .orderBy("id")
      .execute(),
    files: await db
      .selectFrom("file_items")
      .selectAll()
      .orderBy("id")
      .execute(),
    audits: await db
      .selectFrom("security_audit")
      .selectAll()
      .orderBy("id")
      .execute(),
  };
}

it("requires an active administrator, a disabled source, and a different active recipient", async () => {
  await expect(userHandoverInventory(db, admin, source.id)).rejects.toThrow(
    "handover_source_disabled",
  );
  await disable();
  await expect(userHandoverInventory(db, target, source.id)).rejects.toThrow(
    "handover_forbidden",
  );
  await expect(
    userHandoverInventory(db, { ...other, admin: 1 }, source.id),
  ).rejects.toThrow("handover_forbidden");
  await expect(
    previewUserHandover(db, admin, source.id, {
      targetUserId: source.id,
      keys: ["resource:" + randomUUID()],
    }),
  ).rejects.toThrow("handover_target_active");
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", target.id)
    .execute();
  await expect(
    previewUserHandover(db, admin, source.id, {
      targetUserId: target.id,
      keys: ["resource:" + randomUUID()],
    }),
  ).rejects.toThrow("handover_target_active");
});

it("transfers only selected ownership trees and attachments, preserving history, authors, links and physical objects", async () => {
  const root = await content.create(source, {
    title: "Selected library",
    kind: "library",
    format: "rich_text",
  });
  const child = await document("Child", source, undefined, root.id);
  const retained = await document("Keep with source");
  const foreign = await document(
    "Another owner's document",
    source,
    undefined,
    root.id,
  );
  await db
    .updateTable("resources")
    .set({ owner_id: other.id })
    .where("id", "=", foreign.id)
    .execute();
  const attached = await file("attachment.txt", "document", child.id);
  await db
    .updateTable("file_items")
    .set({ locked: 1 })
    .where("id", "=", attached.id)
    .execute();
  const object = await db
    .selectFrom("file_storage_objects")
    .selectAll()
    .where("id", "=", attached.storage_object_id)
    .executeTakeFirstOrThrow();
  const assetId = randomUUID();
  await db
    .insertInto("assets")
    .values({
      id: assetId,
      owner_id: source.id,
      uploaded_by: source.id,
      resource_id: child.id,
      purpose: "attachment",
      profile_id: attached.profile,
      object_key: object.object_key,
      filename: attached.name,
      mime: attached.mime,
      size: attached.size,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  const history = await db
    .selectFrom("document_versions")
    .selectAll()
    .execute();
  await disable();
  const preview = await handover([`resource:${root.id}`]);
  expect(preview.changes.map((c) => c.id).sort()).toEqual(
    [root.id, child.id, attached.id].sort(),
  );
  expect(preview.bytes).toBe(123);
  expect(preview.changes.find((c) => c.id === child.id)?.path).toEqual([
    root.title,
  ]);
  expect(preview.changes.find((c) => c.id === attached.id)?.path).toEqual([
    root.title,
    child.title,
  ]);
  expect(preview.retained).toContainEqual({
    id: foreign.id,
    kind: "resource",
    name: foreign.title,
  });
  expect((await authorize(db, target, child.id, 5)).resource.owner_id).toBe(
    target.id,
  );
  expect(
    (
      await db
        .selectFrom("resources")
        .selectAll()
        .where("id", "=", retained.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
  ).toBe(source.id);
  expect(
    (
      await db
        .selectFrom("resources")
        .selectAll()
        .where("id", "=", foreign.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
  ).toBe(other.id);
  expect(
    await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", assetId)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({
    owner_id: target.id,
    uploaded_by: source.id,
    object_key: object.object_key,
  });
  expect(
    await db
      .selectFrom("file_items")
      .selectAll()
      .where("id", "=", attached.id)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({
    owner_id: target.id,
    parent_id: child.id,
    storage_object_id: object.id,
  });
  expect(
    await db.selectFrom("document_versions").selectAll().execute(),
  ).toEqual(history);
  expect(
    await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", object.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(object);
  expect(
    (
      await db
        .selectFrom("users")
        .select("status")
        .where("id", "=", source.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe("disabled");
  const audit = await db
    .selectFrom("security_audit")
    .selectAll()
    .where("action", "=", "user.resources_handed_over")
    .executeTakeFirstOrThrow();
  expect(audit.actor_id).toBe(admin.id);
  expect(audit.user_id).toBe(source.id);
  expect(JSON.parse(audit.details).targetUserId).toBe(target.id);
});

it("includes deleted resources without restoring them, and keeps protected personal/system files in the inventory", async () => {
  const doc = await document("Deleted document");
  await content.trash(source, doc.id, doc.version);
  const ai = await file(
    "Personal AI",
    "system",
    "ai",
    JSON.stringify({
      aiSessionFolder: { sessionId: randomUUID(), title: "Private" },
    }),
  );
  const retired = await file(
    "Retired binding",
    "system",
    "root",
    '{"knowledgeSessionFolder":{}}',
  );
  await disable();
  const inventory = await userHandoverInventory(db, admin, source.id);
  expect(inventory.items.find((e) => e.id === ai.id)).toMatchObject({
    selectable: false,
    reason: "system_file",
  });
  expect(inventory.items.find((e) => e.id === retired.id)).toMatchObject({
    selectable: false,
    reason: "system_file",
  });
  await handover([`resource:${doc.id}`]);
  expect(
    await db
      .selectFrom("resources")
      .selectAll()
      .where("id", "=", doc.id)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ owner_id: target.id, deleted_at: expect.any(String) });
  expect(
    (
      await db
        .selectFrom("file_items")
        .select("owner_id")
        .where("id", "=", retired.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
  ).toBe(source.id);
});

it("moves a selected nested folder and its eligible descendants to the recipient root, leaving siblings intact", async () => {
  const parent = await folder("Parent"),
    chosen = await folder("Selected", parent.id),
    child = await folder("Nested", chosen.id),
    sibling = await folder("Sibling", parent.id);
  const nested = await file("Nested file", "folder", child.id);
  await disable();
  const p = await handover([`folder:${chosen.id}`]);
  expect(p.changes.find((c) => c.id === chosen.id)?.destination).toBe(
    "personal_root",
  );
  expect(
    await db
      .selectFrom("file_folders")
      .selectAll()
      .where("id", "=", chosen.id)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ owner_id: target.id, parent_id: null });
  expect(
    await db
      .selectFrom("file_folders")
      .selectAll()
      .where("id", "=", child.id)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ owner_id: target.id, parent_id: chosen.id });
  expect(
    (
      await db
        .selectFrom("file_folders")
        .select("owner_id")
        .where("id", "=", sibling.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
  ).toBe(source.id);
  expect((await authorizeFileItem(db, target, nested.id)).owner_id).toBe(
    target.id,
  );
});

it("moves a standalone selected file out of an unselected source folder", async () => {
  const parent = await folder("Not selected"),
    selected = await file("Selected.txt", "folder", parent.id);
  await disable();
  await handover([`file:${selected.id}`]);
  expect(await authorizeFileItem(db, target, selected.id)).toMatchObject({
    owner_id: target.id,
    parent_type: "system",
    parent_id: "root",
  });
});

it("hands direct and link permissions over as audited direct grants, preserving the recipient's higher role", async () => {
  const library = await content.create(other, {
    title: "Shared library",
    kind: "library",
    format: "rich_text",
  });
  const parent = await document("Shared parent", other, undefined, library.id),
    child = await document("Inherited child", other, parent.id);
  await grant(parent.id, source, "editor", 1, {
    source_type: "link",
    source_id: randomUUID(),
  });
  await grant(parent.id, target, "manager");
  await disable();
  await handover([`resource_access:${parent.id}`]);
  expect((await authorize(db, target, child.id, 4)).rank).toBe(4);
  expect(
    await db
      .selectFrom("grants")
      .selectAll()
      .where("user_id", "=", source.id)
      .where("resource_id", "=", parent.id)
      .execute(),
  ).toEqual([]);
  expect(
    await db
      .selectFrom("grants")
      .selectAll()
      .where("user_id", "=", target.id)
      .where("resource_id", "=", child.id)
      .execute(),
  ).toEqual([]);
  expect(
    (
      await db
        .selectFrom("grants")
        .selectAll()
        .where("user_id", "=", target.id)
        .where("resource_id", "=", parent.id)
        .executeTakeFirstOrThrow()
    ).role,
  ).toBe("manager");
});

it("preserves node-only scope, without copying unrelated inherited rights", async () => {
  const library = await content.create(other, {
    title: "Library",
    kind: "library",
    format: "rich_text",
  });
  const root = await document("Root", other, undefined, library.id),
    chosen = await document("Chosen", other, root.id),
    child = await document("Child", other, chosen.id);
  await grant(root.id, source, "editor");
  await grant(chosen.id, source, "reader", 0);
  await disable();
  await handover([`resource_access:${chosen.id}`]);
  await authorize(db, target, chosen.id, 1);
  await expect(authorize(db, target, child.id, 1)).rejects.toThrow();
});

it("rejects broadening a subtree across source blocks and preserves all rows on rejection", async () => {
  const library = await content.create(other, {
    title: "Library",
    kind: "library",
    format: "rich_text",
  });
  const root = await document("Root", other, undefined, library.id),
    child = await document("Blocked child", other, root.id);
  await grant(root.id, source, "editor");
  await grant(child.id, source, "reader", 1, {
    source_type: "parent_override",
    status: "disabled",
  });
  await disable();
  const before = await facts(),
    input = { targetUserId: target.id, keys: [`resource_access:${root.id}`] };
  const p = await previewUserHandover(db, admin, source.id, input);
  expect(p.conflicts).toContainEqual({
    id: child.id,
    name: child.title,
    code: "permission_scope",
  });
  await expect(
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: p.fingerprint,
    }),
  ).rejects.toThrow("handover_conflict");
  expect(await facts()).toEqual(before);
});

it("rejects incompatible node/subtree roles and recipient restrictions instead of silently widening permissions", async () => {
  const root = await document("Different scopes", other);
  await grant(root.id, source, "reader");
  await grant(root.id, target, "manager", 0);
  await disable();
  expect(
    (
      await previewUserHandover(db, admin, source.id, {
        targetUserId: target.id,
        keys: [`resource_access:${root.id}`],
      })
    ).conflicts.some((c) => c.code === "grant_shape"),
  ).toBe(true);
  await db.deleteFrom("grants").where("user_id", "=", target.id).execute();
  await grant(root.id, target, "reader", 1, {
    source_type: "parent_override",
    status: "disabled",
  });
  expect(
    (
      await previewUserHandover(db, admin, source.id, {
        targetUserId: target.id,
        keys: [`resource_access:${root.id}`],
      })
    ).conflicts.some((c) => c.code === "permission_restricted"),
  ).toBe(true);
});

it("hands shared-folder permissions over without downgrading the recipient", async () => {
  const shared = await folder("Shared", "shared", other);
  for (const [user, role] of [
    [source, "reader"],
    [target, "admin"],
  ] as const)
    await db
      .insertInto("file_folder_shares")
      .values({
        folder_id: shared.id,
        user_id: user.id,
        role,
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
  await disable();
  await handover([`folder_access:${shared.id}`]);
  expect(
    await db
      .selectFrom("file_folder_shares")
      .selectAll()
      .where("folder_id", "=", shared.id)
      .execute(),
  ).toMatchObject([{ user_id: target.id, role: "admin", version: 2 }]);
});

it("invalidates stale confirmation, account reactivation and repeated execution without partial writes", async () => {
  const doc = await document("Original");
  await disable();
  const input = { targetUserId: target.id, keys: [`resource:${doc.id}`] },
    p = await previewUserHandover(db, admin, source.id, input);
  await db
    .updateTable("resources")
    .set({ title: "Changed", version: 2 })
    .where("id", "=", doc.id)
    .execute();
  const before = await facts();
  await expect(
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: p.fingerprint,
    }),
  ).rejects.toThrow("handover_changed");
  expect(await facts()).toEqual(before);
  const next = await previewUserHandover(db, admin, source.id, input);
  await db
    .updateTable("users")
    .set({ status: "active" })
    .where("id", "=", source.id)
    .execute();
  await expect(
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: next.fingerprint,
    }),
  ).rejects.toThrow("handover_source_disabled");
  await disable();
  await executeUserHandover(db, admin, source.id, {
    ...input,
    fingerprint: next.fingerprint,
  });
  await expect(
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: next.fingerprint,
    }),
  ).rejects.toThrow("handover_changed");
});

it("rolls the entire batch back when recipient admission rejects a later resource", async () => {
  const first = await document("First"),
    second = await document("Second");
  await disable();
  const input = {
      targetUserId: target.id,
      keys: [`resource:${first.id}`, `resource:${second.id}`],
    },
    p = await previewUserHandover(db, admin, source.id, input),
    before = await facts();
  let checks = 0;
  pluginServices(db).policies.set("test.admission", {
    id: "test.admission",
    async check(ctx) {
      if (ctx.action === "resources.transfer" && ++checks === 2)
        throw Error("quota_rejected");
    },
  });
  await expect(
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: p.fingerprint,
    }),
  ).rejects.toThrow("quota_rejected");
  expect(checks).toBe(2);
  expect(await facts()).toEqual(before);
});

it("protects all HTTP endpoints and validates exact confirmation", async () => {
  const doc = await document("HTTP handover");
  await disable();
  const app = await createApp(db, { origin: "http://localhost:39130" });
  try {
    const path = `/api/v1/admin/users/${source.id}/resource-handover`;
    expect(
      (await app.inject({ url: path, headers: { host: "localhost:39130" } }))
        .statusCode,
    ).toBe(401);
    const login = async (user: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { host: "localhost:39130", origin: "http://localhost:39130" },
        payload: { login: user, password },
      });
      expect(response.statusCode).toBe(200);
      return {
        host: "localhost:39130",
        origin: "http://localhost:39130",
        cookie: String(response.headers["set-cookie"]).split(";")[0]!,
      };
    };
    const regularHeaders = await login("handover-target"),
      adminHeaders = await login("handover-admin");
    const input = { targetUserId: target.id, keys: [`resource:${doc.id}`] };
    for (const suffix of ["", "/preview", "/execute"])
      expect(
        (
          await app.inject({
            method: suffix ? "POST" : "GET",
            url: path + suffix,
            headers: regularHeaders,
            ...(suffix
              ? {
                  payload: {
                    ...input,
                    ...(suffix === "/execute"
                      ? { fingerprint: "a".repeat(64) }
                      : {}),
                  },
                }
              : {}),
          })
        ).statusCode,
      ).toBe(403);
    const preview = await app.inject({
      method: "POST",
      url: path + "/preview",
      headers: adminHeaders,
      payload: input,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const invalid = await app.inject({
      method: "POST",
      url: path + "/execute",
      headers: adminHeaders,
      payload: { ...input, fingerprint: "bad" },
    });
    expect(invalid.statusCode).toBe(400);
    const result = await app.inject({
      method: "POST",
      url: path + "/execute",
      headers: adminHeaders,
      payload: { ...input, fingerprint: preview.json().fingerprint },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect((await authorize(db, target, doc.id, 5)).rank).toBe(5);
  } finally {
    await app.close();
  }
});

it("lists retained folder contents and invalidates preview when a different owner's file changes", async () => {
  const root = await folder("Shared", "shared"),
    foreign = await folder("Other owner's directory", root.id, other);
  const retained = await file("Other owner's file", "folder", foreign.id),
    chosen = await file("Source file", "folder", foreign.id);
  await db
    .updateTable("file_items")
    .set({ owner_id: other.id })
    .where("id", "=", retained.id)
    .execute();
  await disable();
  const input = { targetUserId: target.id, keys: [`folder:${root.id}`] },
    p = await previewUserHandover(db, admin, source.id, input);
  expect(p.retained).toEqual(
    expect.arrayContaining([
      { id: foreign.id, kind: "folder", name: foreign.name },
      { id: retained.id, kind: "file", name: retained.name },
    ]),
  );
  expect(p.changes.find((c) => c.id === chosen.id)?.destination).toBe(
    "personal_root",
  );
  await db
    .updateTable("file_items")
    .set({ name: "Renamed", version: 2 })
    .where("id", "=", retained.id)
    .execute();
  const before = await facts();
  await expect(
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: p.fingerprint,
    }),
  ).rejects.toThrow("handover_changed");
  expect(await facts()).toEqual(before);
  await handover(input.keys);
  expect(
    (
      await db
        .selectFrom("file_items")
        .selectAll()
        .where("id", "=", retained.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
  ).toBe(other.id);
  expect(await authorizeFileItem(db, target, chosen.id)).toMatchObject({
    owner_id: target.id,
    parent_type: "system",
    parent_id: "root",
  });
});

it("cancels pending source/recipient invitations and preserves their history, leaving unrelated invitations intact", async () => {
  const doc = await document("Owned"),
    shared = await folder("Shared", "shared");
  for (const user of [source, target, other]) {
    await db
      .insertInto("access_invitations")
      .values({
        resource_id: doc.id,
        user_id: user.id,
        role: "editor",
        state: "pending",
        version: 1,
        invited_by: admin.id,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("file_folder_invitations")
      .values({
        id: randomUUID(),
        folder_id: shared.id,
        user_id: user.id,
        role: "reader",
        state: "pending",
        invited_by: admin.id,
        message: "",
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  await disable();
  const p = await handover([`resource:${doc.id}`, `folder:${shared.id}`]);
  expect(p.cancelledInvitations).toBe(4);
  expect(
    (await db.selectFrom("access_invitations").selectAll().execute()).map(
      (i) => i.user_id,
    ),
  ).toEqual([other.id]);
  expect(
    await db.selectFrom("invitation_history").selectAll().execute(),
  ).toHaveLength(2);
  for (const i of await db
    .selectFrom("invitation_history")
    .selectAll()
    .execute())
    expect(i).toMatchObject({ state: "cancelled", decided_by: admin.id });
  for (const i of await db
    .selectFrom("file_folder_invitations")
    .selectAll()
    .where("user_id", "in", [source.id, target.id])
    .execute())
    expect(i.state).toBe("cancelled");
  expect(
    await db
      .selectFrom("tickets")
      .selectAll()
      .where("status", "=", "cancelled")
      .execute(),
  ).toHaveLength(4);
});

it("allows only one concurrent confirmation of the same batch", async () => {
  const doc = await document("Concurrent");
  await disable();
  const input = { targetUserId: target.id, keys: [`resource:${doc.id}`] },
    p = await previewUserHandover(db, admin, source.id, input);
  const attempts = await Promise.allSettled([
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: p.fingerprint,
    }),
    executeUserHandover(db, admin, source.id, {
      ...input,
      fingerprint: p.fingerprint,
    }),
  ]);
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(
    await db
      .selectFrom("security_audit")
      .selectAll()
      .where("action", "=", "user.resources_handed_over")
      .execute(),
  ).toHaveLength(1);
});
