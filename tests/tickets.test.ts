import { afterEach, beforeEach, expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createAccessRequests } from "@core/modules/access/requests.js";
import { createTickets } from "@core/modules/tickets/service.js";
import { manageInvitation } from "@core/modules/access/invitations.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import { createApp } from "../apps/server/src/app/create-app.js";
let db: DB, owner: Actor, applicant: Actor, manager: Actor, stranger: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "ticket-owner",
        displayName: "Hidden Owner",
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
  applicant = await add("applicant");
  manager = await add("hidden-manager");
  stranger = await add("stranger");
});
afterEach(async () => {
  await db.destroy();
});
it("keeps a stable workflow link, hides reviewers only from applicant, authorizes actions and sends ticket notifications", async () => {
  const content = createContent(db),
    tickets = createTickets(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Private ticket document",
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: true,
    grants: [{ userId: manager.id, role: "manager" }],
  });
  const q = await createAccessRequests(db).submit(
    applicant,
    doc.id,
    "editor",
    "Please approve",
  );
  const self = await tickets.detail(applicant, q.id);
  expect(self.processorsHidden).toBe(true);
  expect(JSON.stringify(self)).not.toContain(owner.id);
  expect(JSON.stringify(self)).not.toContain(manager.id);
  expect(
    (await tickets.detail(manager, q.id)).processors.map((p) => p!.id),
  ).toContain(owner.id);
  await expect(tickets.detail(stranger, q.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(tickets.act(applicant, q.id, "approve")).rejects.toMatchObject({
    status: 403,
  });
  await tickets.act(applicant, q.id, "remind");
  await expect(tickets.act(applicant, q.id, "remind")).rejects.toMatchObject({
    status: 429,
  });
  const done = await tickets.act(manager, q.id, "approve", "Reviewed");
  expect(done.status).toBe("completed");
  expect((await content.detail(applicant, doc.id)).resource.role).toBe(
    "editor",
  );
  const history = await tickets.detail(applicant, q.id);
  expect(history.events).toHaveLength(2);
  expect(history.events[1]!.actor).toBeNull();
  expect(
    (
      await tickets.list(applicant, { resourceId: doc.id, status: "completed" })
    ).items.map((t) => t.id),
  ).toContain(q.id);
  expect(
    (await tickets.list(manager, { status: "completed" })).items.map(
      (t) => t.id,
    ),
  ).toContain(q.id);
  expect(
    await db
      .selectFrom("notifications")
      .selectAll()
      .where("ticket_id", "=", q.id)
      .where("type", "=", "ticket.reminded")
      .execute(),
  ).toHaveLength(2);
});
it("archives replaced invitations as separate closed tickets and retains recipient history", async () => {
  const d = structuredClone(distributionDefaults);
  d.grantMode = "invite";
  await db
    .updateTable("distribution_settings")
    .set({ config: JSON.stringify(d) })
    .execute();
  const content = createContent(db),
    tickets = createTickets(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Invite work",
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: applicant.id, role: "reader" }],
  });
  const t = (await tickets.list(applicant, { kind: "invitation" })).items[0]!;
  const i = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await manageInvitation(db, owner, doc.id, applicant.id, {
    action: "resend",
    version: i.version!,
  });
  expect((await tickets.detail(applicant, t.id)).status).toBe("cancelled");
  const next = (
    await tickets.list(applicant, { kind: "invitation", status: "pending" })
  ).items[0]!;
  expect(next.id).not.toBe(t.id);
  await tickets.act(applicant, next.id, "accept");
  expect(
    (await tickets.list(applicant, { status: "completed" })).items,
  ).toHaveLength(1);
});
it("keeps registration review in the admin backend without granting tickets or sessions", async () => {
  await db
    .updateTable("settings")
    .set({ registration: 1, registration_review: 1 })
    .where("id", "=", "system")
    .execute();
  const app = await createApp(db, { origin: "http://localhost:39130" });
  const headers = { host: "localhost:39130", origin: "http://localhost:39130" };
  const req = (method: any, url: string, payload?: object, cookie = "") =>
    app.inject({
      method,
      url: "/api/v1" + url,
      headers: { ...headers, cookie },
      ...(payload ? { payload } : {}),
    });
  const registered = await req("POST", "/auth/register", {
    login: "new-person",
    displayName: "New Person",
    password: "test-password-2026",
  });
  expect(registered.json()).toEqual({ status: "pending" });
  expect(registered.cookies).toHaveLength(0);
  expect((await req("GET", "/tickets")).statusCode).toBe(401);
  expect((await req("GET", "/admin/registration-reviews")).statusCode).toBe(
    401,
  );
  const login = await req("POST", "/auth/login", {
    login: "ticket-owner",
    password: "test-password-2026",
  });
  const session = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const list = await req(
    "GET",
    "/admin/registration-reviews?status=pending",
    undefined,
    session,
  );
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().items).toHaveLength(1);
  const id = list.json().items[0].user_id;
  expect((await createTickets(db).list(owner)).items).toHaveLength(0);
  expect(
    (await req("PATCH", `/admin/users/${id}`, { status: "active" }, session))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await req(
        "POST",
        `/admin/registration-reviews/${id}`,
        { decision: "approved" },
        "",
      )
    ).statusCode,
  ).toBe(401);
  const ordinary = await req("POST", "/auth/login", {
    login: "applicant",
    password: "test-password-2026",
  });
  const ordinaryCookie = ordinary.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  expect(
    (
      await req(
        "POST",
        `/admin/registration-reviews/${id}`,
        { decision: "approved" },
        ordinaryCookie,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await req(
        "POST",
        `/admin/registration-reviews/${id}`,
        { decision: "approved", message: "Employee verified" },
        session,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await req(
        "POST",
        `/admin/registration-reviews/${id}`,
        { decision: "rejected" },
        session,
      )
    ).statusCode,
  ).toBe(409);
  const result = await req(
    "GET",
    "/admin/registration-reviews?status=approved",
    undefined,
    session,
  );
  expect(result.json().items[0].message).toBe("Employee verified");
  expect(
    (
      await req("POST", "/auth/login", {
        login: "new-person",
        password: "test-password-2026",
      })
    ).json().user,
  ).toBeTruthy();
  await app.close();
});

it("uses per-scenario admin visibility and never retroactively exposes a hidden approval step", async () => {
  const content = createContent(db),
    tickets = createTickets(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Visibility policy",
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: true,
    grants: [{ userId: manager.id, role: "manager" }],
  });
  const hidden = await createAccessRequests(db).submit(
    applicant,
    doc.id,
    "reader",
  );
  await tickets.act(applicant, hidden.id, "cancel");
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...distributionDefaults,
        ticketReviewers: {
          access: true,
          invitation: false,
        },
      }),
    })
    .execute();
  expect((await tickets.detail(applicant, hidden.id)).processorsHidden).toBe(
    true,
  );
  const open = await createAccessRequests(db).submit(
    applicant,
    doc.id,
    "reader",
  );
  expect(
    (await tickets.detail(applicant, open.id)).processors.map((p) => p!.id),
  ).toContain(owner.id);
  await db
    .updateTable("distribution_settings")
    .set({ config: JSON.stringify(distributionDefaults) })
    .execute();
  expect((await tickets.detail(applicant, open.id)).processorsHidden).toBe(
    true,
  );
  expect((await tickets.detail(manager, open.id)).processorsHidden).toBe(false);
});

it("filters multiple statuses before pagination and only includes the current eligible processor", async () => {
  const content = createContent(db),
    tickets = createTickets(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Filter document",
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: true,
    grants: [{ userId: manager.id, role: "manager" }],
  });
  const requests = createAccessRequests(db);
  const q = await requests.submit(
    applicant,
    doc.id,
    "editor",
    "Please help review\nFor the project",
  );
  expect((await tickets.detail(applicant, q.id)).events[0]!.message).toBe(
    "Please help review\nFor the project",
  );
  expect(
    (await tickets.list(manager, { onlyMine: true })).items.map((t) => t.id),
  ).toEqual([q.id]);
  expect((await tickets.list(applicant, { onlyMine: true })).items).toEqual([]);
  await tickets.act(manager, q.id, "reject", "Please add project context");
  expect((await tickets.detail(applicant, q.id)).events.at(-1)!.message).toBe(
    "Please add project context",
  );
  expect((await tickets.list(manager, { onlyMine: true })).items).toEqual([]);
  const ownerOnly = await requests.submit(applicant, doc.id, "manager");
  expect((await tickets.list(manager, { onlyMine: true })).items).toEqual([]);
  await expect(
    tickets.act(manager, ownerOnly.id, "approve"),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await tickets.list(owner, { onlyMine: true })).items.map((t) => t.id),
  ).toEqual([ownerOnly.id]);
  expect(
    (await tickets.list(applicant, { status: ["pending", "rejected"] })).items,
  ).toHaveLength(2);
  expect((await tickets.list(applicant, { status: [] })).items).toHaveLength(2);
  expect(
    (await tickets.list(applicant, { status: "completed,cancelled" })).items,
  ).toHaveLength(0);
  // A qualifying old ticket must not disappear behind a page of unrelated finished tickets.
  const base = await db
    .selectFrom("tickets")
    .selectAll()
    .where("id", "=", q.id)
    .executeTakeFirstOrThrow();
  const { randomUUID } = await import("node:crypto");
  for (let i = 0; i < 32; i++)
    await db
      .insertInto("tickets")
      .values({
        ...base,
        id: randomUUID(),
        source_key: randomUUID(),
        created_at: "2099-01-01T00:00:00.000Z",
      })
      .execute();
  expect(
    (await tickets.list(owner, { onlyMine: true })).items.map((t) => t.id),
  ).toEqual([ownerOnly.id]);
  await db
    .updateTable("tickets")
    .set({ expires_at: "2000-01-01T00:00:00.000Z" })
    .where("id", "=", ownerOnly.id)
    .execute();
  expect((await tickets.list(owner, { onlyMine: true })).items).toEqual([]);
  const page = await tickets.list(applicant, {
    status: ["expired", "rejected"],
  });
  expect(page.items).toHaveLength(30);
  const rest = await tickets.list(applicant, {
    status: ["expired", "rejected"],
    offset: page.nextOffset!,
  });
  expect(rest.items).toHaveLength(4);
  expect(rest.items.map((t) => t.id)).toContain(ownerOnly.id);
});

it("assigns invitations to recipients and preserves optional notes on each decision", async () => {
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .execute();
  const content = createContent(db),
    tickets = createTickets(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Invitation notes",
  });
  await content.member(owner, doc.id, applicant.id, {
    revision: (
      await db
        .selectFrom("resources")
        .select("authz_revision")
        .where("id", "=", doc.id)
        .executeTakeFirstOrThrow()
    ).authz_revision!,
    role: "reader",
    message: "Please review\nChapter one",
  });
  const t = (await tickets.list(applicant, { onlyMine: true })).items[0]!;
  expect(t.message).toBe("Please review\nChapter one");
  expect(t.events[0]!.message).toBe(t.message);
  expect((await tickets.list(owner, { onlyMine: true })).items).toEqual([]);
  await tickets.act(applicant, t.id, "reject", "Not available this week");
  expect((await tickets.detail(owner, t.id)).events.at(-1)!.message).toBe(
    "Not available this week",
  );
  const invite = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await manageInvitation(db, owner, doc.id, applicant.id, {
    action: "resend",
    version: invite.version!,
    message: "Try next week",
  });
  const next = (await tickets.list(applicant, { onlyMine: true })).items[0]!;
  await tickets.act(owner, next.id, "cancel", "Project postponed");
  expect(
    (await tickets.detail(applicant, next.id)).events.at(-1)!.message,
  ).toBe("Project postponed");
  const latest = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await manageInvitation(db, owner, doc.id, applicant.id, {
    action: "resend",
    version: latest.version!,
  });
  const accepted = (await tickets.list(applicant, { onlyMine: true }))
    .items[0]!;
  await tickets.act(applicant, accepted.id, "accept", "Happy to help");
  expect(
    (await tickets.detail(owner, accepted.id)).events.at(-1)!.message,
  ).toBe("Happy to help");
  expect((await tickets.list(applicant, { onlyMine: true })).items).toEqual([]);
});

it("uses current resource permissions for visibility and approvals without storing processor memberships", async () => {
  const content = createContent(db),
    tickets = createTickets(db),
    requests = createAccessRequests(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Dynamic resource",
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: true,
    grants: [{ userId: manager.id, role: "manager" }],
  });
  const q = await requests.submit(applicant, doc.id, "editor");
  await db
    .deleteFrom("grants")
    .where("resource_id", "=", doc.id)
    .where("user_id", "=", manager.id)
    .execute();
  await expect(tickets.detail(manager, q.id)).rejects.toMatchObject({
    status: 404,
  });
  await db
    .insertInto("grants")
    .values({ resource_id: doc.id, user_id: stranger.id, role: "reader" })
    .execute();
  expect((await tickets.detail(stranger, q.id)).actions).not.toContain(
    "approve",
  );
  await db
    .updateTable("grants")
    .set({ role: "manager" })
    .where("resource_id", "=", doc.id)
    .where("user_id", "=", stranger.id)
    .execute();
  expect((await tickets.detail(stranger, q.id)).actions).toContain("approve");
  expect(
    (
      await tickets.list(stranger, {
        onlyMine: true,
        resourceId: doc.id,
        resourceKind: "document",
      })
    ).items.map((t) => t.id),
  ).toContain(q.id);
  expect(
    (await tickets.list(stranger, { resourceKind: "library" })).items,
  ).toHaveLength(0);
  const detail = await tickets.act(stranger, q.id, "approve");
  expect(detail.resourceKind).toBe("document");
  expect(detail.resourceId).toBe(doc.id);
  expect(detail.processorRule).toBe("resource_managers");
  expect((await content.detail(applicant, doc.id)).resource.role).toBe(
    "editor",
  );
});
