import { beforeEach, afterEach, it, expect } from "vitest";
import { sql } from "kysely";
import { openTestDatabase } from "./database.js";
import type { DB, Resource } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  authorize,
  roleQuery,
  policyFieldQuery,
} from "@core/modules/access/queries.js";
import { permissionOverview } from "@core/modules/access/presentation.js";
import { createShareLinks } from "@core/modules/access/links.js";
import { createAccessRequests } from "@core/modules/access/requests.js";
import { createTickets } from "@core/modules/tickets/service.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import { respondInvitation } from "@core/modules/access/invitations.js";
let db: DB,
  owner: Actor,
  user: Actor,
  manager: Actor,
  content: ReturnType<typeof createContent>,
  parent: Resource,
  child: Resource,
  grandchild: Resource;
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
    admin: 0,
  });
  user = await add("reader");
  manager = await add("manager");
  content = createContent(db);
  parent = await content.create(owner, {
    kind: "library",
    title: "Library",
    format: "rich_text",
  });
  child = await content.create(owner, {
    kind: "document",
    title: "Child",
    format: "rich_text",
    libraryId: parent.id,
  });
  grandchild = await content.create(owner, {
    kind: "document",
    title: "Grandchild",
    format: "rich_text",
    parentId: child.id,
  });
});
afterEach(async () => {
  await db.destroy();
});
async function settings(
  r: Resource,
  patch: Parameters<typeof content.permissions>[2] extends infer T
    ? Omit<T, "version">
    : never,
) {
  const fresh = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", r.id)
    .executeTakeFirstOrThrow();
  await content.permissions(owner, r.id, { version: fresh.version, ...patch });
}
async function member(
  r: Resource,
  role: "reader" | "commenter" | "editor" | "manager" | null,
  includeDescendants = true,
  target = user,
  actor = owner,
) {
  const fresh = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", r.id)
    .executeTakeFirstOrThrow();
  return content.member(actor, r.id, target.id, {
    revision: fresh.authz_revision!,
    role,
    includeDescendants,
  });
}
async function rank(r: Resource, expected: number, actor: Actor | null = user) {
  expect(
    await authorize(db, actor, r.id).then(
      (c) => c.rank,
      () => 0,
    ),
  ).toBe(expected);
  const row = await db
    .selectFrom("resources as r")
    .select(roleQuery(sql.ref("r.id"), actor).as("rank"))
    .where("r.id", "=", r.id)
    .executeTakeFirstOrThrow();
  expect(Number(row.rank)).toBe(expected);
}
it("local downgrade and cancellation override the whole ancestor chain, including future descendants", async () => {
  await member(parent, "editor");
  await rank(child, 3);
  await rank(grandchild, 3);
  await member(child, "reader");
  await rank(child, 1);
  await rank(grandchild, 1);
  const view = await permissionOverview(db, owner, child.id);
  expect(view.members.find((m) => m.id === user.id)).toMatchObject({
    role: "reader",
    sources: expect.arrayContaining(["direct", "parent_override"]),
    includeDescendants: true,
  });
  await member(parent, "manager");
  await rank(child, 1);
  await member(child, null);
  await rank(child, 0);
  await rank(grandchild, 0);
  const future = await content.create(owner, {
    kind: "document",
    title: "Future",
    format: "rich_text",
    parentId: grandchild.id,
  });
  await rank(future, 0);
  await member(grandchild, "commenter");
  await rank(future, 2);
  await settings(child, { accessMode: "custom" });
  await settings(child, { accessMode: "inherit" });
  await rank(child, 0);
  await member(child, "reader");
  await rank(child, 1);
});
it("current-node grants stop inherited users passing through; ownership never bypasses a closed boundary", async () => {
  await member(parent, "editor", false);
  await rank(parent, 3);
  await rank(child, 0);
  await member(parent, "editor");
  await member(child, "reader", false);
  await rank(child, 1);
  await rank(grandchild, 0);
  await member(child, "reader", true);
  await rank(grandchild, 1);
  const other = await content.create(user, {
    kind: "document",
    title: "Other owner",
    format: "rich_text",
    libraryId: parent.id,
  });
  await rank(other, 5, owner);
  await content.permissions(user, other.id, {
    version: other.version,
    accessMode: "custom",
  });
  await rank(other, 5, owner);
  await rank(other, 5, user);
});
it("each setting inherits independently, local changes and resets agree with SQL, disabling removes every parent effect", async () => {
  await settings(parent, {
    visibility: "public",
    publicRole: "editor",
    requestsEnabled: true,
    historyReaders: true,
    discoverable: true,
  });
  await rank(child, 3);
  await rank(child, 1, null);
  await expect(
    authorize(db, user, child.id, "read_history"),
  ).resolves.toBeTruthy();
  await settings(child, {
    publicRole: "reader",
    requestsEnabled: false,
    historyReaders: false,
  });
  await rank(child, 1);
  await rank(grandchild, 1);
  await expect(
    authorize(db, user, child.id, "read_history"),
  ).rejects.toMatchObject({ status: 403 });
  let view = await permissionOverview(db, owner, child.id);
  expect(view).toMatchObject({
    effectiveVisibility: "public",
    publicRole: "reader",
    effectiveRequestsEnabled: false,
    historyReaders: false,
    discoverable: true,
  });
  expect(view.inheritedFields).toContain("visibility");
  expect(view.inheritedFields).not.toContain("public_role");
  for (const [field, expected] of [
    ["public_role", "reader"],
    ["discoverable", 1],
    ["history_readers", 0],
  ] as const) {
    const row = await db
      .selectFrom("resources as r")
      .select(policyFieldQuery(sql.ref("r.id"), field).as("value"))
      .where("r.id", "=", child.id)
      .executeTakeFirstOrThrow();
    expect(row.value).toBe(expected);
  }
  await settings(child, { resetFields: ["public_role", "history_readers"] });
  await rank(child, 3);
  await settings(child, { accessMode: "custom" });
  await rank(child, 0);
  await rank(child, 0, null);
  view = await permissionOverview(db, owner, child.id);
  expect(view).toMatchObject({
    effectiveRequestsEnabled: false,
    historyReaders: false,
    discoverable: false,
  });
  await settings(child, { accessMode: "inherit" });
  await rank(child, 3);
});
it("public baseline stays independent from named overrides", async () => {
  await member(parent, "editor");
  await settings(parent, { visibility: "public", publicRole: "commenter" });
  await member(child, null);
  await rank(child, 2);
  await rank(child, 1, null);
  expect(
    (await permissionOverview(db, owner, child.id)).members.some(
      (m) => m.id === user.id,
    ),
  ).toBe(false);
});
it("share link scope is snapshotted at redemption and link switches inherit without inheriting actual links", async () => {
  const links = createShareLinks(db);
  const link = await links.setShare(owner, child.id, {
    version: null,
    enabled: true,
    role: "reader",
    includeDescendants: false,
    maxMembers: null,
  });
  await links.redeem(user, link.token!);
  await rank(child, 1);
  await rank(grandchild, 0);
  await links.setShare(owner, child.id, {
    version: link.version,
    enabled: true,
    role: "editor",
    includeDescendants: true,
  });
  await links.redeem(user, link.token!);
  await rank(child, 1);
  await rank(grandchild, 0);
  await links.redeem(manager, link.token!);
  await rank(grandchild, 3, manager);
  await settings(child, { resetFields: ["share_links_enabled"] });
  await links.setShareEnabled(owner, parent.id, false);
  expect((await links.share(owner, child.id)).sharingEnabled).toBe(false);
  await expect(links.redeem(owner, link.token!)).rejects.toThrow();
  await rank(child, 1);
  expect((await links.share(owner, grandchild.id)).items).toHaveLength(0);
});
it("keeps direct, link and parent override sources in one authorization table", async () => {
  await member(parent, "editor");
  const links = createShareLinks(db);
  const link = await links.setShare(owner, child.id, {
    version: null,
    enabled: true,
    role: "reader",
    maxMembers: null,
  });
  await links.redeem(user, link.token!);
  await member(child, "reader", false);
  const rows = await db
    .selectFrom("grants")
    .select(["source_type", "source_id", "role", "status"])
    .where("resource_id", "=", child.id)
    .where("user_id", "=", user.id)
    .orderBy("source_type")
    .execute();
  expect(rows.map((row) => row.source_type)).toEqual([
    "direct",
    "link",
    "parent_override",
  ]);
  expect(rows.every((row) => row.status === "active")).toBe(true);
  await member(child, null);
  await expect(authorize(db, user, child.id)).rejects.toMatchObject({ status: 404 });
  const blocked = await db
    .selectFrom("grants")
    .selectAll()
    .where("resource_id", "=", child.id)
    .where("user_id", "=", user.id)
    .execute();
  expect(blocked).toMatchObject([
    expect.objectContaining({ source_type: "parent_override", status: "disabled" }),
  ]);
});
it("invitations preserve scope after acceptance; editing inherited roles remains immediate", async () => {
  await member(parent, "editor");
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .execute();
  await member(child, "reader", false);
  await rank(child, 1);
  await rank(grandchild, 0);
  await member(child, "editor", false, manager);
  const invitation = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", child.id)
    .where("user_id", "=", manager.id)
    .executeTakeFirstOrThrow();
  await respondInvitation(db, manager, child.id, true, invitation.version!);
  await rank(child, 3, manager);
  await rank(grandchild, 0, manager);
});
it("approval resource operation records actual role and scope, supports new managers, and rejects stale downgrades atomically", async () => {
  await settings(parent, { requestsEnabled: true });
  const requests = createAccessRequests(db),
    tickets = createTickets(db);
  const q = await requests.submit(user, child.id, "editor", "Please review");
  await member(parent, "manager", true, manager);
  const result = await tickets.act(manager, q.id, "approve", "Read first", {
    role: "reader",
    includeDescendants: false,
  });
  expect(result).toMatchObject({
    status: "completed",
    role: "editor",
    operation: {
      type: "resource.grant",
      role: "reader",
      includeDescendants: false,
    },
  });
  expect(result.events.at(-1)).toMatchObject({
    message: "Read first",
    operation: { role: "reader", includeDescendants: false },
  });
  await rank(child, 1);
  await rank(grandchild, 0);
  const next = await requests.submit(user, child.id, "editor");
  await member(child, "editor");
  await expect(
    tickets.act(manager, next.id, "approve", "", { role: "reader" }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await tickets.detail(owner, next.id)).status).toBe("pending");
  await rank(child, 3);
  await expect(
    tickets.act(manager, next.id, "approve", "", { role: "manager" }),
  ).rejects.toMatchObject({ status: 403 });
  await member(parent, "reader", true, manager);
  await expect(tickets.act(manager, next.id, "approve")).rejects.toMatchObject({
    status: 403,
  });
});

it("HTTP parent changes immediately invalidate an open descendant session", async () => {
  const { createApp } = await import("../apps/server/src/app/create-app.js");
  await member(parent, "editor");
  const app = await createApp(db, { origin: "http://localhost" });
  let socket: import("ws").WebSocket | undefined;
  try {
    const login = async (name: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { host: "localhost", origin: "http://localhost" },
        payload: { login: name, password: "test-password-2026" },
      });
      return String(response.headers["set-cookie"]).split(";")[0]!;
    };
    const cookie = await login("reader"),
      ownerCookie = await login("owner");
    const headers = { host: "localhost", origin: "http://localhost", cookie };
    socket = await app.injectWS("/api/v1/ws", {
      headers,
      rawHeaders: Object.entries(headers).flat(),
    });
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("join timeout")), 3000);
      socket!.on("message", (raw) => {
        if (JSON.parse(String(raw)).type === "sync-response") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: "join",
        protocolVersion: 1,
        codec: "slate-kit",
        schemaVersion: 3,
        id: "inheritance-join",
        room: grandchild.id,
      }),
    );
    await joined;
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("revocation timeout")),
        3000,
      );
      socket!.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const overview = await permissionOverview(db, owner, parent.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/resources/${parent.id}/members/${user.id}`,
      headers: {
        host: "localhost",
        origin: "http://localhost",
        cookie: ownerCookie,
      },
      payload: {
        revision: overview.authzRevision,
        role: "reader",
        includeDescendants: false,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await closed).toBe(4403);
    await rank(grandchild, 0);
  } finally {
    socket?.terminate();
    await app.close();
  }
});
