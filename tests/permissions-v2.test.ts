import { beforeEach, afterEach, it, expect } from "vitest";
import { sql } from "kysely";
import { openTestDatabase } from "./database.js";
import type { DB, Resource } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createAccessRequests } from "@core/modules/access/requests.js";
import {
  authorize,
  accessibleQuery,
} from "@core/modules/access/queries.js";
import { permissionOverview } from "@core/modules/access/presentation.js";
import { listInvitations } from "@core/modules/access/invitation-queries.js";
import {
  manageInvitation,
  respondInvitation,
} from "@core/modules/access/invitations.js";
import { createShareLinks } from "@core/modules/access/links.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import { notificationPage } from "@core/modules/interactions/community.js";
import { createApp } from "../apps/server/src/app/create-app.js";
let db: DB,
  owner: Actor,
  a: Actor,
  b: Actor,
  user: Actor,
  content: ReturnType<typeof createContent>,
  doc: Resource;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "owner",
        displayName: "Owner Secret",
        password: "test-password-2026",
      },
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
  a = await add("manager-a");
  b = await add("manager-b");
  user = await add("applicant");
  content = createContent(db);
  doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Permission test",
  });
  await acl([
    { userId: a.id, role: "manager" },
    { userId: b.id, role: "manager" },
  ]);
});
afterEach(async () => {
  await db.destroy();
});
async function acl(
  grants: {
    userId: string;
    role: "reader" | "commenter" | "editor" | "manager";
  }[],
  options: Record<string, any> = {},
) {
  const r = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await content.permissions(owner, doc.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "invited",
    grants,
    ...options,
  });
}
async function config(patch: Record<string, unknown>) {
  await db
    .updateTable("distribution_settings")
    .set({ config: JSON.stringify({ ...distributionDefaults, ...patch }) })
    .execute();
}
async function revision() {
  return (
    await db
      .selectFrom("resources")
      .select("authz_revision")
      .where("id", "=", doc.id)
      .executeTakeFirstOrThrow()
  ).authz_revision!;
}
it("four states and public roles agree in point and SQL checks; anonymous access is read-only", async () => {
  const req = createAccessRequests(db);
  await acl([], { requestsEnabled: false });
  await expect(req.preview(user, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  await config({ managerInfoVisible: true });
  await expect(permissionOverview(db, user, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  await acl([], { visibility: "requestable" });
  expect((await req.preview(user, doc.id)).requestable).toBe(true);
  await expect(authorize(db, user, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  for (const visibility of ["authenticated", "public"] as const)
    for (const role of ["reader", "commenter", "editor"] as const) {
      await acl([], { visibility, publicRole: role });
      for (const actor of [null, user])
        for (const minimum of [1, 2, 3, 4]) {
          const expected = actor
            ? { reader: 1, commenter: 2, editor: 3 }[role] >= minimum
            : visibility === "public" && minimum === 1;
          const point = await authorize(db, actor, doc.id, minimum).then(
            () => true,
            () => false,
          );
          const rows = await db
            .selectFrom("resources as r")
            .select("r.id")
            .where("r.id", "=", doc.id)
            .where(accessibleQuery(sql.ref("r.id"), actor, minimum))
            .execute();
          expect(point).toBe(expected);
          expect(!!rows.length).toBe(expected);
        }
    }
});
it("only owners change managers or delete, including bulk ACL, links and mixed-owner subtrees", async () => {
  await expect(
    content.member(a, doc.id, user.id, {
      revision: await revision(),
      role: "manager",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    content.member(a, doc.id, b.id, {
      revision: await revision(),
      role: "reader",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    content.member(owner, doc.id, owner.id, {
      revision: await revision(),
      role: "reader",
    }),
  ).rejects.toMatchObject({ status: 403 });
  const r = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await expect(
    content.permissions(a, doc.id, {
      version: r.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: a.id, role: "manager" }],
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(content.trash(a, doc.id, r.version)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    createShareLinks(db).setShare(a, doc.id, {
      enabled: true,
      role: "manager",
      version: null,
    }),
  ).rejects.toMatchObject({ status: 403 });
  const library = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Mixed owner tree",
  });
  await content.permissions(owner, library.id, {
    version: library.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: a.id, role: "manager" }],
  });
  const parent = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Parent",
    libraryId: library.id,
  });
  const child = await content.create(a, {
    kind: "document",
    format: "rich_text",
    title: "Different owner",
    parentId: parent.id,
  });
  expect((await authorize(db, owner, child.id)).rank).toBe(5);
  await content.trash(owner, parent.id, parent.version);
  expect(
    (
      await db
        .selectFrom("resources")
        .select("deleted_at")
        .where("id", "=", child.id)
        .executeTakeFirstOrThrow()
    ).deleted_at,
  ).not.toBeNull();
});
it("shared approvals, owner-only manager requests, current qualifications and single-winner decisions", async () => {
  await acl(
    [
      { userId: a.id, role: "manager" },
      { userId: b.id, role: "manager" },
    ],
    { visibility: "requestable" },
  );
  const req = createAccessRequests(db),
    q = await req.submit(user, doc.id, "editor");
  for (const manager of [owner, a, b])
    expect(
      (await req.list(manager)).items.some((i) => i.id === q.id && i.canDecide),
    ).toBe(true);
  const results = await Promise.allSettled([
    req.decide(a, q.id, "approved"),
    req.decide(b, q.id, "rejected"),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  for (const manager of [owner, a, b])
    expect((await req.list(manager)).items).toHaveLength(0);
  const upgrade = await req.submit(user, doc.id, "manager");
  expect((await req.list(a)).items).toHaveLength(0);
  await expect(req.decide(a, upgrade.id, "approved")).rejects.toMatchObject({
    status: 403,
  });
  await req.decide(user, upgrade.id, "cancelled");
  const next = await req.submit(user, doc.id, "manager");
  await req.decide(owner, next.id, "approved");
  expect((await authorize(db, user, doc.id)).rank).toBe(4);
});
it("privacy setting controls applicant, invitation, detail and notification identities, including old records", async () => {
  await acl(
    [
      { userId: a.id, role: "manager" },
      { userId: b.id, role: "manager" },
    ],
    { visibility: "requestable" },
  );
  const req = createAccessRequests(db),
    q = await req.submit(user, doc.id, "reader", "Need to read");
  expect((await permissionOverview(db, user, doc.id)).administrators).toEqual(
    [],
  );
  await req.decide(a, q.id, "approved", "Approved for review");
  expect((await req.list(user)).items[0]?.decision_message).toBe(
    "Approved for review",
  );
  const hidden = JSON.stringify((await req.list(user)).items);
  expect(hidden).not.toContain(a.id);
  expect(hidden).not.toContain(owner.id);
  expect((await content.detail(user, doc.id)).resource.owner_id).toBe("");
  expect(
    (await notificationPage(db, user, 0)).items.every((n) => !n.actor_id),
  ).toBe(true);
  await config({ managerInfoVisible: true });
  const visible = (await req.list(user)).items[0]!;
  expect(visible.administrators.map((u) => u.id)).toEqual(
    expect.arrayContaining([owner.id, a.id, b.id]),
  );
  expect(visible.decider?.id).toBe(a.id);
  await config({ managerInfoVisible: false });
  expect((await req.list(user)).items[0]?.administrators).toEqual([]);
  expect(
    (await permissionOverview(db, user, doc.id)).members.some(
      (m) => m.role === "manager" || m.role === "owner",
    ),
  ).toBe(false);
});
it("document managers see all invitations but control only their own; revocation retains old access and history", async () => {
  await acl([
    { userId: a.id, role: "manager" },
    { userId: b.id, role: "manager" },
    { userId: user.id, role: "reader" },
  ]);
  await config({ grantMode: "invite" });
  // Role changes for existing collaborators apply directly without an invitation ticket.
  await content.member(a, doc.id, user.id, {
    revision: await revision(),
    role: "editor",
  });
  expect((await authorize(db, user, doc.id)).rank).toBe(3);
  expect((await listInvitations(db, b, doc.id)).items).toHaveLength(0);
  expect(
    await db
      .selectFrom("tickets")
      .selectAll()
      .where("resource_id", "=", doc.id)
      .execute(),
  ).toHaveLength(0);
  // Users with only link access keep that access while a higher invitation waits.
  const c = {
    ...(await createUser(
      db,
      {
        login: "invitee-c",
        displayName: "invitee-c",
        password: "test-password-2026",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  const links = createShareLinks(db),
    link = await links.setShare(owner, doc.id, {
      version: null,
      enabled: true,
      role: "reader",
    });
  await links.redeem(c, link.token!);
  await content.member(a, doc.id, c.id, {
    revision: await revision(),
    role: "editor",
  });
  let i = (await listInvitations(db, b, doc.id)).items[0]!;
  expect(i.inviter?.id).toBe(a.id);
  expect(i.canCancel).toBe(false);
  await expect(
    manageInvitation(db, b, doc.id, c.id, {
      version: i.version,
      action: "cancel",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    manageInvitation(db, b, doc.id, c.id, {
      version: i.version,
      action: "resend",
      role: "reader",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await manageInvitation(db, a, doc.id, c.id, {
    version: i.version,
    action: "cancel",
  });
  await expect(
    respondInvitation(db, c, doc.id, true, i.version),
  ).rejects.toMatchObject({ status: 409 });
  expect((await authorize(db, c, doc.id)).rank).toBe(1);
  await manageInvitation(db, owner, doc.id, c.id, {
    version: i.version,
    action: "resend",
    role: "editor",
  });
  const rows = (await listInvitations(db, a, doc.id)).items;
  expect(rows.some((x) => x.state === "cancelled")).toBe(true);
  const next = rows.find((x) => x.state === "pending")!;
  expect(next.inviter?.id).toBe(a.id);
  await expect(
    respondInvitation(db, c, doc.id, true, i.version),
  ).rejects.toMatchObject({ status: 409 });
  await respondInvitation(db, c, doc.id, true, next.version);
  await expect(
    manageInvitation(db, a, doc.id, c.id, {
      version: next.version,
      action: "cancel",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("invitation expiry, issuer demotion and acceptance racing cancellation never create stale grants", async () => {
  await config({ grantMode: "invite" });
  await content.member(a, doc.id, user.id, {
    revision: await revision(),
    role: "editor",
  });
  let i = (await listInvitations(db, a, doc.id)).items[0]!;
  await db
    .updateTable("access_invitations")
    .set({ expires_at: "2000-01-01T00:00:00.000Z" })
    .where("resource_id", "=", doc.id)
    .execute();
  await expect(
    respondInvitation(db, user, doc.id, true, i.version),
  ).rejects.toMatchObject({ status: 409 });
  await manageInvitation(db, a, doc.id, user.id, {
    version: i.version,
    action: "resend",
  });
  i = (await listInvitations(db, a, doc.id)).items.find(
    (x) => x.state === "pending",
  )!;
  await content.member(owner, doc.id, a.id, {
    revision: await revision(),
    role: "reader",
  });
  await expect(
    manageInvitation(db, a, doc.id, user.id, {
      version: i.version,
      action: "cancel",
    }),
  ).rejects.toMatchObject({ status: 403 });
  const result = await Promise.allSettled([
    respondInvitation(db, user, doc.id, true, i.version),
    manageInvitation(db, owner, doc.id, user.id, {
      version: i.version,
      action: "cancel",
    }),
  ]);
  expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const row = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .where("user_id", "=", user.id)
    .executeTakeFirstOrThrow();
  expect(
    await authorize(db, user, doc.id).then(
      () => true,
      () => false,
    ),
  ).toBe(row.state === "accepted");
});
it("link expiry and disable stop admission, independent sources survive explicit revocation", async () => {
  const links = createShareLinks(db);
  let first = await links.setShare(a, doc.id, {
    enabled: true,
    role: "editor",
    version: null,
  });
  const second = await links.setShare(b, doc.id, {
    enabled: true,
    role: "reader",
    version: null,
  });
  await links.redeem(user, first.token!);
  await links.redeem(user, second.token!);
  first = await links.setShare(a, doc.id, {
    enabled: false,
    role: "editor",
    version: first.version,
  });
  expect((await authorize(db, user, doc.id)).rank).toBe(3);
  await links.revokeShare(a, doc.id, first.id, first.version);
  expect((await authorize(db, user, doc.id)).rank).toBe(1);
  await db
    .updateTable("share_links")
    .set({ expires_at: "2000-01-01T00:00:00.000Z" })
    .where("generation", "=", second.id)
    .execute();
  await expect(links.redeem(user, second.token!)).rejects.toMatchObject({
    status: 404,
  });
  expect((await authorize(db, user, doc.id)).rank).toBe(1);
  await config({ grantMode: "invite" });
  await content.member(a, doc.id, user.id, {
    revision: await revision(),
    role: "editor",
  });
  expect((await authorize(db, user, doc.id)).rank).toBe(1);
});
it("HTTP contracts restrict manager links to owners and expose privacy controls only to system admins", async () => {
  const app = await createApp(db, { origin: "http://localhost" });
  try {
    const login = async (name: string) => {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { host: "localhost", origin: "http://localhost" },
        payload: { login: name, password: "test-password-2026" },
      });
      return String(r.headers["set-cookie"]).split(";")[0]!;
    };
    const ownerCookie = await login("owner"),
      aCookie = await login("manager-a");
    const call = (cookie: string, url: string, payload: any) =>
      app.inject({
        method: "PUT",
        url: "/api/v1" + url,
        headers: { host: "localhost", origin: "http://localhost", cookie },
        payload,
      });
    expect(
      (
        await call(aCookie, `/resources/${doc.id}/share-link`, {
          enabled: true,
          role: "manager",
          version: null,
        })
      ).statusCode,
    ).toBe(403);
    const managerLink = await call(ownerCookie, `/resources/${doc.id}/share-link`, {
      enabled: true,
      role: "manager",
      version: null,
    });
    expect(managerLink.statusCode, managerLink.body).toBe(200);
    const userCookie = await login("applicant");
    const joined = await app.inject({
      method: "POST",
      url: "/api/v1/share/redeem",
      headers: { host: "localhost", origin: "http://localhost", cookie: userCookie },
      payload: { token: managerLink.json().token, accept: true },
    });
    expect(joined.statusCode, joined.body).toBe(200);
    expect((await authorize(db, user, doc.id, "manage_sharing")).rank).toBe(4);
    const settings = await app.inject({
      url: "/api/v1/admin/distribution",
      headers: { host: "localhost", cookie: ownerCookie },
    });
    expect(
      (
        await call(aCookie, "/admin/distribution", {
          ...settings.json(),
          managerInfoVisible: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(ownerCookie, "/admin/distribution", {
          ...settings.json(),
          managerInfoVisible: true,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});

it.each(["document", "library"] as const)(
  "owners can share management of a %s while managers cannot change its management links",
  async (kind) => {
    await config({ grantMode: "invite" });
    const resource = kind === "document" ? doc : await content.create(owner, {
      kind,
      format: "rich_text",
      title: "Management link library",
    });
    const links = createShareLinks(db);
    const link = await links.setShare(owner, resource.id, {
      enabled: true,
      role: "manager",
      version: null,
      includeDescendants: true,
      maxMembers: 1,
    });
    expect(await links.redeem(user, link.token!, false)).toMatchObject({
      pending: true,
      role: "manager",
    });
    await expect(authorize(db, user, resource.id)).rejects.toThrow();
    await links.redeem(user, link.token!, true);
    expect((await permissionOverview(db, user, resource.id)).role).toBe("manager");
    expect((await authorize(db, user, resource.id, "manage_sharing")).rank).toBe(4);
    if (kind === "library") {
      const child = await content.create(owner, {
        kind: "document",
        format: "rich_text",
        title: "Child",
        libraryId: resource.id,
      });
      expect((await authorize(db, user, child.id, "manage_sharing")).rank).toBe(4);
    }
    await expect(links.redeem(a, link.token!, true)).rejects.toMatchObject({ status: 403 });
    await expect(links.setShare(user, resource.id, {
      enabled: true, role: "manager", version: null,
    })).rejects.toMatchObject({ status: 403 });
    await expect(links.setShare(user, resource.id, {
      enabled: false, role: "reader", version: link.version,
    })).rejects.toMatchObject({ status: 403 });
    await expect(links.revokeShare(user, resource.id, link.id, link.version))
      .rejects.toMatchObject({ status: 403 });
    const paused = await links.setShare(owner, resource.id, {
      enabled: false, role: "manager", version: link.version,
    });
    expect((await authorize(db, user, resource.id, "manage_sharing")).rank).toBe(4);
    const downgraded = await links.setShare(owner, resource.id, {
      enabled: false, role: "reader", version: paused.version,
    });
    await expect(links.revokeShare(user, resource.id, link.id, downgraded.version))
      .rejects.toMatchObject({ status: 403 });
    expect((await authorize(db, user, resource.id, "manage_sharing")).rank).toBe(4);
    await links.revokeShare(owner, resource.id, link.id, downgraded.version);
    await expect(authorize(db, user, resource.id)).rejects.toThrow();
  },
);

it("member changes preserve requestability and structural rearrangement cannot grant managers", async () => {
  await acl(
    [
      { userId: a.id, role: "manager" },
      { userId: b.id, role: "manager" },
    ],
    { visibility: "requestable" },
  );
  await config({ grantMode: "invite" });
  await content.member(a, doc.id, user.id, {
    revision: await revision(),
    role: "reader",
  });
  expect(
    (await createAccessRequests(db).preview(user, doc.id)).requestable,
  ).toBe(true);
  const library = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Library",
  });
  await content.permissions(owner, library.id, {
    version: library.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: a.id, role: "manager" }],
  });
  // Grant directly for structural fixtures; pending mode is independently exercised above.
  await db
    .insertInto("grants")
    .values({
      resource_id: library.id,
      user_id: a.id,
      source_type: "direct",
      source_id: "",
      role: "manager",
    })
    .onConflict((oc) =>
      oc
        .columns(["resource_id", "user_id", "source_type", "source_id"])
        .doUpdateSet({ role: "manager" }),
    )
    .execute();
  const source = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Source",
    libraryId: library.id,
  });
  const target = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Target",
    libraryId: library.id,
  });
  await db
    .insertInto("grants")
    .values({ resource_id: target.id, user_id: b.id, role: "manager" })
    .execute();
  await expect(
    content.arrange(a, source.id, {
      version: source.version,
      targetId: target.id,
      placement: "inside",
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await db
        .selectFrom("resources")
        .select("parent_id")
        .where("id", "=", source.id)
        .executeTakeFirstOrThrow()
    ).parent_id,
  ).toBeNull();
});

it("custom permissions exclude unrelated ancestor members and ownership transfer preserves invitation history", async () => {
  const library = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Private group",
  });
  await content.permissions(owner, library.id, {
    version: library.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: a.id, role: "reader" }],
  });
  const child = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Public child",
    libraryId: library.id,
  });
  await content.permissions(owner, child.id, {
    version: child.version,
    accessMode: "custom",
    visibility: "public",
    grants: [],
  });
  const overview = await permissionOverview(db, owner, child.id);
  expect(overview.members.some((m) => m.id === a.id)).toBe(false);
  expect((await permissionOverview(db, a, child.id)).sources).toEqual([
    "public",
  ]);
  await config({ grantMode: "invite" });
  const transferDoc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Transfer target",
    libraryId: library.id,
  });
  await content.member(owner, transferDoc.id, user.id, {
    revision: (await content.detail(owner, transferDoc.id)).resource.authz_revision ?? 1,
    role: "editor",
  });
  const current = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", transferDoc.id)
    .executeTakeFirstOrThrow();
  await content.transfer(owner, transferDoc.id, {
    version: current.version,
    userId: user.id,
    retainAccess: true,
  });
  const history = (await listInvitations(db, user, transferDoc.id)).items;
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        user_id: user.id,
        state: "cancelled",
        historical: true,
      }),
    ]),
  );
});

it("one application switch controls every higher tier, independently of public access", async () => {
  const req = createAccessRequests(db);
  await acl([{ userId: user.id, role: "reader" }], { requestsEnabled: false });
  expect((await permissionOverview(db, user, doc.id)).requestRoles).toEqual([]);
  await expect(req.submit(user, doc.id, "editor")).rejects.toMatchObject({
    status: 403,
  });
  await acl([{ userId: user.id, role: "reader" }], { requestsEnabled: true });
  expect((await permissionOverview(db, user, doc.id)).requestRoles).toEqual([
    "commenter",
    "editor",
    "manager",
  ]);
  const q = await req.submit(user, doc.id, "manager");
  await req.decide(user, q.id, "cancelled");
  await acl([], {
    visibility: "public",
    publicRole: "editor",
    requestsEnabled: true,
  });
  expect((await permissionOverview(db, user, doc.id)).requestRoles).toEqual([
    "manager",
  ]);
  const pending = await req.submit(user, doc.id, "manager");
  await acl([], {
    visibility: "public",
    publicRole: "editor",
    requestsEnabled: false,
  });
  expect(
    (await permissionOverview(db, user, doc.id)).effectiveRequestsEnabled,
  ).toBe(false);
  await expect(req.decide(owner, pending.id, "approved")).rejects.toMatchObject(
    { status: 409 },
  );
  await req.decide(user, pending.id, "cancelled");
  expect((await authorize(db, user, doc.id)).rank).toBe(3);
  expect((await authorize(db, null, doc.id)).rank).toBe(1);
});

it.each(["direct", "invite"] as const)(
  "%s invitation and link grants survive turning off public editing",
  async (mode) => {
    await acl([], {
      visibility: "public",
      publicRole: "editor",
      requestsEnabled: false,
    });
    await config({ grantMode: mode });
    await content.member(owner, doc.id, user.id, {
      revision: await revision(),
      role: "reader",
    });
    if (mode === "invite") {
      const i = (await listInvitations(db, owner, doc.id)).items.find(
        (i) => i.state === "pending",
      )!;
      await respondInvitation(db, user, doc.id, true, i.version);
    }
    expect((await authorize(db, user, doc.id)).rank).toBe(3);
    const links = createShareLinks(db),
      link = await links.setShare(owner, doc.id, {
        version: null,
        enabled: true,
        role: "commenter",
      });
    await links.redeem(b, link.token!);
    const r = (await content.detail(owner, doc.id)).resource;
    await content.permissions(owner, doc.id, {
      version: r.version,
      accessMode: "custom",
      visibility: "invited",
      requestsEnabled: false,
    });
    expect((await authorize(db, user, doc.id)).rank).toBe(1);
    expect((await authorize(db, b, doc.id)).rank).toBe(2);
    await expect(authorize(db, a, doc.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(authorize(db, null, doc.id)).rejects.toMatchObject({
      status: 404,
    });
  },
);

it("inherited applications follow the parent switch and unrelated edits preserve it", async () => {
  const library = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Inherited library",
  });
  await content.permissions(owner, library.id, {
    version: library.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: true,
  });
  const child = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    libraryId: library.id,
    title: "Inherited",
  });
  expect(
    (await permissionOverview(db, user, child.id)).requestRoles,
  ).toHaveLength(4);
  let r = (await content.detail(owner, library.id)).resource;
  await content.permissions(owner, library.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "invited",
    historyReaders: true,
  });
  expect(
    (await permissionOverview(db, user, child.id)).effectiveRequestsEnabled,
  ).toBe(true);
  r = (await content.detail(owner, library.id)).resource;
  await content.permissions(owner, library.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: false,
  });
  await expect(
    createAccessRequests(db).submit(user, child.id, "reader"),
  ).rejects.toMatchObject({ status: 404 });
});

it("switches off all link admissions while retaining members and individual link settings", async () => {
  const links = createShareLinks(db);
  expect((await links.share(owner, doc.id)).sharingEnabled).toBe(true);
  const first = await links.setShare(owner, doc.id, {
    enabled: true,
    role: "reader",
    version: null,
    maxMembers: null,
  });
  const second = await links.setShare(owner, doc.id, {
    enabled: true,
    role: "editor",
    version: null,
  });
  await links.redeem(user, first.token!);
  await expect(links.setShareEnabled(user, doc.id, false)).rejects.toThrow();
  await links.setShareEnabled(owner, doc.id, false);
  expect((await links.share(owner, doc.id)).sharingEnabled).toBe(false);
  await expect(links.redeem(a, first.token!)).rejects.toThrow();
  await expect(links.redeem(a, second.token!)).rejects.toThrow();
  await expect(authorize(db, user, doc.id, "read_content")).resolves.toBeTruthy();
  await links.setShare(owner, doc.id, {
    enabled: false,
    role: "editor",
    version: second.version,
  });
  await links.setShareEnabled(owner, doc.id, true);
  await expect(links.redeem(b, first.token!)).resolves.toEqual({ id: doc.id });
  await expect(links.redeem(b, second.token!)).rejects.toThrow();
  expect(
    (await links.share(owner, doc.id)).items.find((l) => l.id === first.id)
      ?.token,
  ).toBe(first.token);
});

it("limits share-link admissions by generation and hides descendant scope for personal documents", async () => {
  const links = createShareLinks(db);
  const single = await links.setShare(owner, doc.id, {
    enabled: true,
    role: "reader",
    includeDescendants: true,
    version: null,
  });
  expect(single.maxMembers).toBe(1);
  expect(single.includeDescendants).toBe(false);
  await links.redeem(user, single.token!);
  await expect(links.redeem(a, single.token!)).rejects.toMatchObject({
    status: 403,
  });
  const next = await links.setShare(owner, doc.id, {
    enabled: true,
    role: "reader",
    includeDescendants: true,
    version: null,
  });
  expect(next.id).not.toBe(single.id);
  await expect(links.redeem(a, next.token!)).resolves.toEqual({ id: doc.id });
  await links.revokeShare(owner, doc.id, next.id, next.version);
  const afterRevoke = await links.setShare(owner, doc.id, {
    enabled: true,
    role: "reader",
    version: null,
  });
  await expect(links.redeem(a, afterRevoke.token!)).resolves.toEqual({
    id: doc.id,
  });
  expect(
    (await links.share(owner, doc.id)).items.find((l) => l.id === single.id),
  ).toMatchObject({ maxMembers: 1, memberCount: 1, includeDescendants: false });

  const unlimited = await links.setShare(owner, doc.id, {
    enabled: true,
    role: "reader",
    maxMembers: null,
    version: null,
  });
  await Promise.all([
    links.redeem(user, unlimited.token!),
    links.redeem(b, unlimited.token!),
  ]);
  expect(
    (await links.share(owner, doc.id)).items.find((l) => l.id === unlimited.id),
  ).toMatchObject({ maxMembers: null, memberCount: 2 });
});
