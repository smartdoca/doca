import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sql } from "kysely";
import type { DB, Resource } from "@db/index.js";
import { openTestDatabase } from "./database.js";
import {
  createGroups,
  cleanupDissolvedGroups,
} from "@core/modules/groups/service.js";
import { createGroupGrants } from "@core/modules/groups/grants.js";
import { createUserDirectory } from "@core/modules/discovery/users.js";
import { createContent } from "@core/workflows/resources.js";
import { authorize, roleQuery } from "@core/modules/access/queries.js";
import { authorizeFileFolder } from "@core/modules/access/file-access.js";
import { folderInSearch } from "@core/modules/discovery/catalog.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import {
  searchGroupDirectory,
  readGroupDirectoryPolicy,
  updateGroupDirectoryPolicy,
  validateGroupSelection,
} from "@core/modules/groups/directory.js";
import { permissionOverview } from "@core/modules/access/presentation.js";
import {
  executeUserHandover,
  previewUserHandover,
  userHandoverInventory,
} from "@core/modules/identity/resource-handover.js";

let db: DB,
  groups: ReturnType<typeof createGroups>,
  grants: ReturnType<typeof createGroupGrants>,
  content: ReturnType<typeof createContent>;
const owner = { id: randomUUID(), display_name: "Group owner", admin: 1 };
const admin = { id: randomUUID(), display_name: "Administrator", admin: 0 };
const member = { id: randomUUID(), display_name: "Member", admin: 0 };
const other = { id: randomUUID(), display_name: "Other", admin: 0 };
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  await db
    .insertInto("users")
    .values(
      [owner, admin, member, other].map((u, i) => ({
        ...u,
        public_id: `group-user-${i}`,
        login: `group-user-${i}`,
        password_hash: "unused",
        status: "active",
        created_at: new Date().toISOString(),
      })),
    )
    .execute();
  groups = createGroups(db);
  grants = createGroupGrants(db);
  content = createContent(db);
});
afterEach(async () => {
  await db.destroy();
});
async function makeGroup() {
  return (await groups.create(owner, { name: "研发组", avatar: null })).id;
}
async function revision(id: string) {
  return (
    await db
      .selectFrom("user_groups")
      .select("revision")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).revision;
}
async function invite(id: string, target = member, issuer = owner) {
  return groups.invite(issuer, id, target.id, await revision(id));
}
async function join(id: string, target = member) {
  const i = await invite(id, target);
  await groups.respond(target, i.id, true);
}
async function grant(
  id: string,
  resource: Resource,
  role: "reader" | "commenter" | "editor" | "manager" | null,
  descendants = true,
) {
  const r = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", resource.id)
    .executeTakeFirstOrThrow();
  return grants.set(owner, r.id, id, false, {
    revision: r.authz_revision!,
    role,
    includeDescendants: descendants,
  });
}
async function check(
  resource: Resource,
  user: typeof member,
  expected: number,
) {
  if (expected)
    expect((await authorize(db, user, resource.id)).rank).toBe(expected);
  else
    await expect(authorize(db, user, resource.id)).rejects.toMatchObject({
      status: 404,
    });
  const row = await db
    .selectFrom("resources as r")
    .select(roleQuery(sql.ref("r.id"), user).as("rank"))
    .where("r.id", "=", resource.id)
    .executeTakeFirstOrThrow();
  expect(Number(row.rank)).toBe(expected);
}

it("requires consent even in direct mode, obeys the user directory and adds only current same-group relationships", async () => {
  const id = await makeGroup();
  await db
    .updateTable("settings")
    .set({ directory_mode: "none" })
    .where("id", "=", "system")
    .execute();
  await expect(invite(id)).rejects.toMatchObject({
    message: "group_directory",
  });
  await db
    .updateTable("settings")
    .set({ directory_mode: "all" })
    .where("id", "=", "system")
    .execute();
  const i = await invite(id);
  expect((await groups.detail(owner, id)).members).toHaveLength(1);
  await expect(groups.detail(member, id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(groups.respond(other, i.id, true)).rejects.toMatchObject({
    status: 404,
  });
  await groups.respond(member, i.id, true);
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  expect(
    (
      await createUserDirectory(db).resolve(owner, {
        ids: [member.id, other.id],
      })
    ).map((u) => u.id),
  ).toEqual([member.id]);
  await db
    .updateTable("settings")
    .set({ directory_mode: "none" })
    .where("id", "=", "system")
    .execute();
  expect((await groups.detail(member, id)).members).toHaveLength(2);
  expect(
    (await createUserDirectory(db).search(member, { query: "" })).items,
  ).toEqual([]);
  await groups.leave(member, id, await revision(id));
  await db
    .updateTable("settings")
    .set({ directory_mode: "related" })
    .where("id", "=", "system")
    .execute();
  expect(
    await createUserDirectory(db).resolve(owner, { ids: [member.id] }),
  ).toEqual([]);
});

it("enforces owner/admin/member boundaries, stale revisions and a single owner during transfer", async () => {
  const id = await makeGroup();
  await join(id, admin);
  await join(id);
  await groups.member(owner, id, admin.id, await revision(id), "admin");
  await join(id, other);
  await groups.member(owner, id, other.id, await revision(id), "admin");
  await expect(
    groups.member(admin, id, other.id, await revision(id), null),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    groups.member(admin, id, owner.id, await revision(id), null),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    groups.member(admin, id, member.id, await revision(id), "admin"),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    groups.dissolve(admin, id, await revision(id)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    groups.leave(owner, id, await revision(id)),
  ).rejects.toMatchObject({ message: "group_owner" });
  await expect(
    groups.invite(member, id, other.id, await revision(id)),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    groups.member(owner, id, member.id, 1, "admin"),
  ).rejects.toMatchObject({ status: 409 });
  await groups.member(admin, id, member.id, await revision(id), null);
  await groups.transfer(owner, id, admin.id, await revision(id));
  expect((await groups.detail(admin, id)).role).toBe("owner");
  expect((await groups.detail(owner, id)).role).toBe("member");
  expect(
    await db
      .selectFrom("user_group_members")
      .selectAll()
      .where("group_id", "=", id)
      .where("role", "=", "owner")
      .execute(),
  ).toHaveLength(1);
});

it("supports signed-in link consent, revocation, expiration and rechecking the issuer's role", async () => {
  const id = await makeGroup();
  const link = await groups.link(owner, id, await revision(id)),
    token = new URL(link.url, "http://localhost").hash.split("token=")[1]!;
  expect((await groups.previewLink(member, token)).name).toBe("研发组");
  expect(
    await db.selectFrom("user_group_invite_links").selectAll().execute(),
  ).not.toContainEqual(expect.objectContaining({ token }));
  expect((await groups.detail(owner, id)).inviteLink).toEqual({
    expiresAt: link.expiresAt,
  });
  await groups.join(member, token);
  expect((await groups.detail(member, id)).inviteLink).toBeNull();
  await groups.join(member, token);
  expect((await groups.detail(owner, id)).members).toHaveLength(2);
  await groups.link(owner, id, await revision(id), true);
  await expect(groups.join(other, token)).rejects.toMatchObject({
    status: 404,
  });
  await groups.member(owner, id, member.id, await revision(id), "admin");
  const peerLink = await groups.link(member, id, await revision(id));
  await groups.member(owner, id, member.id, await revision(id), "member");
  await expect(
    groups.join(other, peerLink.url.split("token=")[1]!),
  ).rejects.toMatchObject({ status: 404 });
});

it("dynamically grants every member access, keeps individual ACLs intact and immediately revokes on leave", async () => {
  const id = await makeGroup();
  await join(id);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Group only",
  });
  await grant(id, doc, "editor");
  await check(doc, member, 3);
  expect(
    await db
      .selectFrom("grants")
      .selectAll()
      .where("resource_id", "=", doc.id)
      .execute(),
  ).toEqual([]);
  await join(id, admin);
  await check(doc, admin, 3);
  const overview = await permissionOverview(db, owner, doc.id);
  expect(overview.members.find((m) => m.id === member.id)?.sources).toContain(
    "group",
  );
  expect(overview.members.find((m) => m.id === member.id)).toMatchObject({
    canAdjust: true,
    personalRole: null,
    role: "editor",
  });
  await content.member(owner, doc.id, member.id, {
    revision: overview.authzRevision,
    role: "reader",
    includeDescendants: false,
  });
  let personalView = await permissionOverview(db, owner, doc.id);
  expect(personalView.members.find((m) => m.id === member.id)).toMatchObject({
    role: "editor",
    personalRole: "reader",
    personalIncludeDescendants: false,
  });
  await content.member(owner, doc.id, member.id, {
    revision: personalView.authzRevision,
    role: null,
  });
  personalView = await permissionOverview(db, owner, doc.id);
  expect(personalView.members.find((m) => m.id === member.id)).toMatchObject({
    role: "editor",
    personalRole: null,
    canAdjust: true,
  });
  await check(doc, member, 3);
  await groups.leave(member, id, await revision(id));
  await check(doc, member, 0);
  await check(doc, admin, 3);
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", admin.id)
    .execute();
  await expect(authorize(db, admin, doc.id)).rejects.toMatchObject({
    status: 401,
  });
});

it("keeps each group's inheritance separate from individual blocks, scope and public reading", async () => {
  const id = await makeGroup();
  await join(id);
  const library = await content.create(owner, {
    kind: "library",
    format: "markdown",
    title: "Root",
  });
  const child = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Child",
    libraryId: library.id,
  });
  const grandchild = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Next",
    parentId: child.id,
  });
  await grant(id, library, "editor");
  await check(grandchild, member, 3);
  await content.member(owner, child.id, member.id, {
    revision: (
      await db
        .selectFrom("resources")
        .select("authz_revision")
        .where("id", "=", child.id)
        .executeTakeFirstOrThrow()
    ).authz_revision!,
    role: null,
  });
  await check(grandchild, member, 3);
  await grant(id, child, "reader", false);
  await check(child, member, 1);
  expect((await grants.list(owner, child.id, false)).items).toContainEqual(
    expect.objectContaining({
      groupId: id,
      role: "reader",
      includeDescendants: false,
      canAdjust: true,
    }),
  );
  await check(grandchild, member, 0);
  await grant(id, child, null);
  await check(child, member, 0);
  await grant(id, grandchild, "commenter");
  await check(grandchild, member, 2);
  const second = await makeGroup();
  await join(second);
  await grant(second, library, "editor");
  await check(child, member, 3);
  await grant(second, library, "manager", false);
  await check(grandchild, member, 4);
  await grant(second, child, null);
  expect((await grants.list(owner, child.id, false)).items).toContainEqual(
    expect.objectContaining({
      groupId: second,
      role: "manager",
      inherited: true,
      canAdjust: false,
    }),
  );
  expect((await grants.list(owner, library.id, false)).items).toContainEqual(
    expect.objectContaining({ groupId: second, canAdjust: true }),
  );
  expect((await grants.list(member, library.id, false)).items).toContainEqual(
    expect.objectContaining({ groupId: second, canAdjust: false }),
  );
  await grant(id, child, "manager", true);
  const inheritedChild = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Inherited",
    parentId: child.id,
  });
  expect(
    (await grants.list(owner, inheritedChild.id, false)).items,
  ).toContainEqual(
    expect.objectContaining({
      groupId: id,
      role: "manager",
      inherited: true,
      canAdjust: true,
    }),
  );
});

it("keeps group resource invitations pending until an authorized group manager accepts, and rechecks the issuer", async () => {
  const id = await makeGroup();
  await join(id);
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .where("id", "=", "system")
    .execute();
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Invitation",
  });
  const result = await grant(id, doc, "editor");
  expect(result.pending).toBe(true);
  await check(doc, member, 0);
  const i = (await groups.detail(owner, id)).resourceInvitations[0]!;
  await expect(grants.respond(member, id, i.id, true)).rejects.toMatchObject({
    status: 403,
  });
  await grants.respond(owner, id, i.id, true);
  await check(doc, member, 3);
  await expect(grants.respond(owner, id, i.id, true)).rejects.toMatchObject({
    status: 404,
  });
});

it("authorizes shared folders and descendants and includes group access in shared-folder discovery", async () => {
  const id = await makeGroup();
  await join(id);
  const folderId = randomUUID(),
    childId = randomUUID(),
    time = new Date().toISOString();
  await db
    .insertInto("file_folders")
    .values([
      {
        id: folderId,
        owner_id: owner.id,
        parent_id: "shared",
        name: "Shared",
        version: 1,
        created_at: time,
        updated_at: time,
        deleted_at: null,
        delete_batch: null,
      },
      {
        id: childId,
        owner_id: owner.id,
        parent_id: folderId,
        name: "Child",
        version: 1,
        created_at: time,
        updated_at: time,
        deleted_at: null,
        delete_batch: null,
      },
    ])
    .execute();
  await grants.set(owner, folderId, id, true, {
    revision: 1,
    role: "reader",
    includeDescendants: true,
  });
  expect((await authorizeFileFolder(db, member, childId)).role).toBe("reader");
  expect(await folderInSearch(db, member, folderId, "personal")).toBe(true);
  await expect(
    authorizeFileFolder(db, member, folderId, 3),
  ).rejects.toMatchObject({ status: 403 });
  await groups.dissolve(owner, id, await revision(id));
  await expect(authorizeFileFolder(db, member, childId)).rejects.toMatchObject({
    status: 404,
  });
});

it("dissolves immediately, cleans associations later and preserves resources, personal grants and audit", async () => {
  const id = await makeGroup();
  await join(id);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Retain",
  });
  await grant(id, doc, "editor");
  await db
    .insertInto("grants")
    .values({ resource_id: doc.id, user_id: member.id, role: "reader" })
    .execute();
  const before = await db.selectFrom("grants").selectAll().execute();
  await groups.dissolve(owner, id, await revision(id));
  await check(doc, member, 1);
  expect(await cleanupDissolvedGroups(db)).toBe(0);
  expect(
    await cleanupDissolvedGroups(db, new Date(Date.now() + 1000).toISOString()),
  ).toBe(1);
  expect(
    await cleanupDissolvedGroups(db, new Date(Date.now() + 1000).toISOString()),
  ).toBe(0);
  expect(
    await db.selectFrom("resource_group_grants").selectAll().execute(),
  ).toEqual([]);
  expect(await db.selectFrom("grants").selectAll().execute()).toEqual(before);
  expect(
    await db
      .selectFrom("resources")
      .selectAll()
      .where("id", "=", doc.id)
      .executeTakeFirst(),
  ).toBeDefined();
  expect(
    await db
      .selectFrom("security_audit")
      .selectAll()
      .where("action", "=", "group.dissolved")
      .execute(),
  ).toHaveLength(1);
});

it("allows an effective group collaborator to receive ownership without copying group access into personal grants", async () => {
  const id = await makeGroup();
  await join(id);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Transfer",
  });
  await grant(id, doc, "editor");
  const fresh = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await content.transfer(owner, doc.id, {
    version: fresh.version,
    userId: member.id,
    retainAccess: false,
  });
  await check(doc, owner, 3);
  await check(doc, member, 5);
  expect(await db.selectFrom("grants").selectAll().execute()).toEqual([]);
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", member.id)
    .execute();
  const inventory = await userHandoverInventory(db, owner, member.id);
  expect(inventory.items.some((i) => i.kind === "resource_access")).toBe(false);
  const preview = await previewUserHandover(db, owner, member.id, {
    targetUserId: other.id,
    keys: [`resource:${doc.id}`],
  });
  expect(preview.changes).toEqual(
    expect.arrayContaining([expect.objectContaining({ action: "ownership" })]),
  );
});

it("hands a disabled group owner's group to an existing active member and invalidates a stale preview", async () => {
  const id = await makeGroup();
  await join(id, admin);
  await join(id, other);
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", owner.id)
    .execute();
  await db
    .updateTable("users")
    .set({ admin: 1 })
    .where("id", "=", admin.id)
    .execute();
  const administrator = { ...admin, admin: 1 };
  const inventory = await userHandoverInventory(db, administrator, owner.id);
  expect(inventory.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "group", id })]),
  );
  const conflict = await previewUserHandover(db, administrator, owner.id, {
    targetUserId: member.id,
    keys: [`group:${id}`],
  });
  expect(conflict.conflicts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "group_membership" }),
    ]),
  );
  const input = { targetUserId: other.id, keys: [`group:${id}`] };
  const preview = await previewUserHandover(db, administrator, owner.id, input);
  await groups.leave(other, id, await revision(id));
  await expect(
    executeUserHandover(db, administrator, owner.id, {
      ...input,
      fingerprint: preview.fingerprint,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await db
    .insertInto("user_group_members")
    .values({
      group_id: id,
      user_id: other.id,
      role: "member",
      joined_at: new Date().toISOString(),
    })
    .execute();
  const next = await previewUserHandover(db, administrator, owner.id, input);
  await executeUserHandover(db, administrator, owner.id, {
    ...input,
    fingerprint: next.fingerprint,
  });
  expect((await groups.detail(other, id)).role).toBe("owner");
  expect(
    (
      await db
        .selectFrom("users")
        .select("status")
        .where("id", "=", owner.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe("disabled");
});

it("searches groups in member/related/all scopes without exposing a foreign roster or treating public access as a relationship", async () => {
  const own = await makeGroup();
  const related = (
    await groups.create(other, { name: "关联团队", avatar: null })
  ).id;
  const hidden = (
    await groups.create(other, { name: "外部团队", avatar: null })
  ).id;
  const doc = await content.create(other, {
    kind: "document",
    format: "markdown",
    title: "Intersection",
  });
  const fresh = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await grants.set(other, doc.id, related, false, {
    revision: fresh.authz_revision!,
    role: "editor",
    includeDescendants: false,
  });
  const current = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await content.member(other, doc.id, owner.id, {
    revision: current.authz_revision!,
    role: "reader",
  });
  const publicDoc = await content.create(other, {
    kind: "document",
    format: "markdown",
    title: "Public alone",
  });
  await grants.set(other, publicDoc.id, hidden, false, {
    revision: (
      await db
        .selectFrom("resources")
        .select("authz_revision")
        .where("id", "=", publicDoc.id)
        .executeTakeFirstOrThrow()
    ).authz_revision!,
    role: "reader",
    includeDescendants: false,
  });
  await db
    .updateTable("resources")
    .set({ visibility: "public" })
    .where("id", "=", publicDoc.id)
    .execute();
  const search = async (mode: "member" | "related" | "all") =>
    (
      await searchGroupDirectory(
        db,
        owner,
        { mode, revision: "test" },
        { query: "" },
      )
    ).items
      .map((g) => g.id)
      .sort();
  expect(await search("member")).toEqual([own]);
  expect(await search("related")).toEqual([own, related].sort());
  expect(await search("all")).toEqual([own, related, hidden].sort());
  await expect(groups.detail(owner, related)).rejects.toMatchObject({
    status: 404,
  });
  const page = await searchGroupDirectory(
    db,
    owner,
    { mode: "all", revision: "1" },
    { query: "", limit: 1 },
  );
  await expect(
    searchGroupDirectory(
      db,
      owner,
      { mode: "member", revision: "2" },
      { query: "", cursor: page.nextCursor! },
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it("recognizes a group intersection on an inherited descendant and respects a closed inheritance boundary", async () => {
  const groupId = (
    await groups.create(other, { name: "下级交集团队", avatar: null })
  ).id;
  const library = await content.create(other, {
    kind: "library",
    format: "markdown",
    title: "Group library",
  });
  const child = await content.create(other, {
    kind: "document",
    format: "markdown",
    title: "Only child",
    libraryId: library.id,
  });
  await grants.set(other, library.id, groupId, false, {
    revision: (
      await db
        .selectFrom("resources")
        .select("authz_revision")
        .where("id", "=", library.id)
        .executeTakeFirstOrThrow()
    ).authz_revision!,
    role: "reader",
    includeDescendants: true,
  });
  await content.member(other, child.id, owner.id, {
    revision: (
      await db
        .selectFrom("resources")
        .select("authz_revision")
        .where("id", "=", child.id)
        .executeTakeFirstOrThrow()
    ).authz_revision!,
    role: "reader",
  });
  expect(
    (
      await searchGroupDirectory(
        db,
        owner,
        { mode: "related", revision: "test" },
        { query: "" },
      )
    ).items.map((g) => g.id),
  ).toContain(groupId);
  await db
    .updateTable("resources")
    .set({ access_mode: "custom" })
    .where("id", "=", child.id)
    .execute();
  expect(
    (
      await searchGroupDirectory(
        db,
        owner,
        { mode: "related", revision: "test" },
        { query: "" },
      )
    ).items.map((g) => g.id),
  ).not.toContain(groupId);
});

it("uses the approved member default and administrator per-user overrides, with revisioned resets and server-side selection checks", async () => {
  const own = await makeGroup(),
    foreign = (await groups.create(other, { name: "外部组", avatar: null })).id;
  expect(await readGroupDirectoryPolicy(db, owner)).toEqual({
    mode: "member",
    revision: "1:0",
  });
  await validateGroupSelection(db, owner, own);
  await expect(
    validateGroupSelection(db, owner, foreign),
  ).rejects.toMatchObject({ status: 403, message: "group_scope" });
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Scope guard",
  });
  await expect(grant(foreign, doc, "reader")).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    updateGroupDirectoryPolicy(db, member, "system", {
      mode: "all",
      revision: 1,
    }),
  ).rejects.toMatchObject({ status: 403 });
  await updateGroupDirectoryPolicy(db, owner, "system", {
    mode: "all",
    revision: 1,
  });
  await expect(
    updateGroupDirectoryPolicy(db, owner, "system", {
      mode: "related",
      revision: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await validateGroupSelection(db, owner, foreign);
  await updateGroupDirectoryPolicy(db, owner, owner.id, {
    mode: "member",
    revision: 0,
  });
  await expect(
    validateGroupSelection(db, owner, foreign),
  ).rejects.toMatchObject({ status: 403 });
  await updateGroupDirectoryPolicy(db, owner, owner.id, {
    mode: null,
    revision: 1,
  });
  expect(await readGroupDirectoryPolicy(db, owner)).toEqual({
    mode: "all",
    revision: "2:2",
  });
  await expect(
    updateGroupDirectoryPolicy(db, owner, owner.id, {
      mode: "member",
      revision: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await grant(foreign, doc, "reader");
  await updateGroupDirectoryPolicy(db, owner, "system", {
    mode: "member",
    revision: 2,
  });
  // A scope change restricts new selections, while managers can revoke existing grants.
  await grant(foreign, doc, null);
  await db
    .deleteFrom("group_directory_policies")
    .where("id", "=", "system")
    .execute();
  await expect(readGroupDirectoryPolicy(db, owner)).rejects.toMatchObject({
    status: 409,
  });
});

it("discovers a related group through explicit shared-folder permissions and drops the relationship immediately on revocation", async () => {
  const foreign = (
    await groups.create(other, { name: "文件协作组", avatar: null })
  ).id;
  const folderId = randomUUID(),
    time = new Date().toISOString();
  await db
    .insertInto("file_folders")
    .values({
      id: folderId,
      owner_id: other.id,
      parent_id: "shared",
      name: "共享资料",
      version: 1,
      created_at: time,
      updated_at: time,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  await grants.set(other, folderId, foreign, true, {
    revision: 1,
    role: "reader",
    includeDescendants: true,
  });
  await db
    .insertInto("file_folder_shares")
    .values({
      folder_id: folderId,
      user_id: owner.id,
      role: "reader",
      version: 1,
      created_at: time,
      updated_at: time,
    })
    .execute();
  const search = () =>
    searchGroupDirectory(
      db,
      owner,
      { mode: "related", revision: "1" },
      { query: "" },
    );
  expect((await search()).items.map((g) => g.id)).toContain(foreign);
  await db
    .deleteFrom("file_folder_shares")
    .where("folder_id", "=", folderId)
    .execute();
  expect((await search()).items.map((g) => g.id)).not.toContain(foreign);
});

it("allows a resource manager to cancel an existing pending group invitation after search scope narrows", async () => {
  const foreign = (
    await groups.create(other, { name: "Pending external group", avatar: null })
  ).id;
  await updateGroupDirectoryPolicy(db, owner, "system", {
    mode: "all",
    revision: 1,
  });
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .where("id", "=", "system")
    .execute();
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Pending selection",
  });
  expect((await grant(foreign, doc, "reader")).pending).toBe(true);
  await updateGroupDirectoryPolicy(db, owner, "system", {
    mode: "member",
    revision: 2,
  });
  await grant(foreign, doc, null);
  expect(
    (
      await db
        .selectFrom("group_resource_invitations")
        .select("state")
        .where("group_id", "=", foreign)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("cancelled");
  await check(doc, other, 0);
});

it("rejects group invitation acceptance when the issuing resource manager has lost access", async () => {
  const id = await makeGroup();
  await join(id, admin);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Issuer changed",
  });
  await content.member(owner, doc.id, admin.id, {
    revision: (
      await db
        .selectFrom("resources")
        .select("authz_revision")
        .where("id", "=", doc.id)
        .executeTakeFirstOrThrow()
    ).authz_revision!,
    role: "manager",
  });
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .where("id", "=", "system")
    .execute();
  let fresh = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await grants.set(admin, doc.id, id, false, {
    revision: fresh.authz_revision!,
    role: "reader",
    includeDescendants: false,
  });
  const invitation = (await groups.detail(owner, id)).resourceInvitations[0]!;
  fresh = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await content.member(owner, doc.id, admin.id, {
    revision: fresh.authz_revision!,
    role: null,
  });
  await expect(
    grants.respond(owner, id, invitation.id, true),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (
      await db
        .selectFrom("group_resource_invitations")
        .select("state")
        .where("id", "=", invitation.id)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("pending");
  await check(doc, admin, 0);
});

it("pages only minimal active member identities for an active group grant and rechecks revocation", async () => {
  const id = await makeGroup();
  for (const target of [admin, member, other]) await join(id, target);
  await db
    .updateTable("user_group_members")
    .set({ joined_at: "2026-10-31T00:00:00.000Z" })
    .where("group_id", "=", id)
    .execute();
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Member preview",
  });
  await grant(id, doc, "reader");
  const preview = await grants.members(owner, doc.id, id, false, { limit: 3 });
  expect(preview.total).toBe(4);
  expect(preview.items).toHaveLength(3);
  expect(preview.nextCursor).toBeTruthy();
  expect(Object.keys(preview.items[0]!).sort()).toEqual([
    "avatar",
    "avatar_asset_id",
    "display_name",
    "id",
    "public_id",
  ]);
  const rest = await grants.members(owner, doc.id, id, false, {
    cursor: preview.nextCursor!,
  });
  expect(rest.items).toHaveLength(1);
  expect(rest.nextCursor).toBeNull();
  expect([...preview.items, ...rest.items].map((row) => row.id)).toEqual(
    [owner.id, admin.id, member.id, other.id].sort(),
  );
  await expect(grants.members(member, doc.id, id, false)).rejects.toMatchObject(
    { status: 403 },
  );
  await expect(
    grants.members(owner, doc.id, id, false, { limit: 0 }),
  ).rejects.toMatchObject({ status: 400 });
  const second = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Other resource",
  });
  await grant(id, second, "reader");
  await expect(
    grants.members(owner, second.id, id, false, {
      cursor: preview.nextCursor!,
    }),
  ).rejects.toMatchObject({ status: 400 });
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", other.id)
    .execute();
  expect(
    (await grants.members(owner, doc.id, id, false)).items.map((row) => row.id),
  ).not.toContain(other.id);
  await grant(id, doc, null);
  await expect(
    grants.members(owner, doc.id, id, false, { cursor: preview.nextCursor! }),
  ).rejects.toMatchObject({ status: 404 });
  await groups.dissolve(owner, id, await revision(id));
  await expect(
    grants.members(owner, second.id, id, false),
  ).rejects.toMatchObject({ status: 404 });
});

it("permits resource managers to read inherited group collaborators without opening foreign groups or pending invitations", async () => {
  const foreign = (
    await groups.create(other, { name: "External preview group", avatar: null })
  ).id;
  const invite = await groups.invite(
    other,
    foreign,
    member.id,
    await revision(foreign),
  );
  await groups.respond(member, invite.id, true);
  const library = await content.create(owner, {
    kind: "library",
    format: "markdown",
    title: "Preview inheritance",
  });
  const child = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Inherited group",
    libraryId: library.id,
  });
  await updateGroupDirectoryPolicy(db, owner, "system", {
    mode: "all",
    revision: 1,
  });
  await grant(foreign, library, "reader");
  await expect(groups.detail(owner, foreign)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (await grants.members(owner, child.id, foreign, false)).items
      .map((row) => row.id)
      .sort(),
  ).toEqual([other.id, member.id].sort());
  const unassociated = await makeGroup();
  await expect(
    grants.members(owner, child.id, unassociated, false),
  ).rejects.toMatchObject({ status: 404 });
  await grant(foreign, child, null);
  await expect(
    grants.members(owner, child.id, foreign, false),
  ).rejects.toMatchObject({ status: 404 });
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .where("id", "=", "system")
    .execute();
  const pendingDoc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Pending group preview",
  });
  await grant(foreign, pendingDoc, "reader");
  await expect(
    grants.members(owner, pendingDoc.id, foreign, false),
  ).rejects.toMatchObject({ status: 404 });
  const pending = (await groups.detail(other, foreign)).resourceInvitations[0]!;
  await grants.respond(other, foreign, pending.id, true);
  expect(
    (await grants.members(owner, pendingDoc.id, foreign, false)).total,
  ).toBe(2);
});

it("requires shared-folder management and a current group association for member previews", async () => {
  const id = await makeGroup();
  await join(id);
  const folderId = randomUUID(),
    at = new Date().toISOString();
  await db
    .insertInto("file_folders")
    .values({
      id: folderId,
      owner_id: owner.id,
      parent_id: "shared",
      name: "Member preview folder",
      version: 1,
      created_at: at,
      updated_at: at,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  await grants.set(owner, folderId, id, true, {
    revision: 1,
    role: "reader",
    includeDescendants: true,
  });
  expect((await grants.members(owner, folderId, id, true)).total).toBe(2);
  await expect(
    grants.members(member, folderId, id, true),
  ).rejects.toMatchObject({ status: 403 });
  await grants.set(owner, folderId, id, true, {
    revision: (
      await db
        .selectFrom("file_folders")
        .select("version")
        .where("id", "=", folderId)
        .executeTakeFirstOrThrow()
    ).version,
    role: null,
    includeDescendants: true,
  });
  await expect(grants.members(owner, folderId, id, true)).rejects.toMatchObject(
    { status: 404 },
  );
});
