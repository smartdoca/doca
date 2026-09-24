import { openTestDatabase as openDatabase } from "./database.js";
import { publishIntegrationEvents } from "@core/modules/automation/events.js";
import { it, expect } from "vitest";
import {} from "@db/index.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createAccessRequests } from "@core/modules/access/requests.js";
import { notificationPage } from "@core/modules/interactions/community.js";
import { createApp } from "../apps/server/src/app/create-app.js";
it("requestable gates, approval, revocation, duplicate decisions, notifications and durable event feed", async () => {
  const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  const owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const bob = {
    ...(await createUser(
      db,
      { login: "bobby", displayName: "Bob", password: "test-password-2026" },
      { actor: owner },
    )),
    admin: 0,
  };
  const eve = {
    ...(await createUser(
      db,
      { login: "evetest", displayName: "Eve", password: "test-password-2026" },
      { actor: owner },
    )),
    admin: 0,
  };
  // This scenario starts with applications explicitly disabled, then enables them.
  await db.updateTable("distribution_settings").set({config:JSON.stringify({resourcePolicies:{document:{defaultVisibility:"invited"}}})}).where("id","=","system").execute();
  const content = createContent(db),
    service = createAccessRequests(db);
  const doc = await content.create(owner, {
    title: "Secret",
    kind: "document",
    format: "rich_text",
  });
  await expect(service.preview(bob, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(service.submit(bob, doc.id, "reader")).rejects.toMatchObject({
    status: 404,
  });
  await content.permissions(owner, doc.id, {
    version: doc.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: true,
    grants: [],
  });
  expect(await service.preview(null, doc.id)).toMatchObject({
    id: doc.id,
    title: "需要登录",
    requestable: true,
  });
  await expect(content.detail(bob, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  const q = await service.submit(bob, doc.id, "editor");
  await expect(service.submit(bob, doc.id, "editor")).rejects.toMatchObject({
    status: 409,
  });
  expect((await service.list(owner)).items).toHaveLength(1);
  expect((await service.list(eve)).items).toHaveLength(0);
  expect(
    (await notificationPage(db, owner, 0)).items.filter(
      (n) => n.type === "access.requested",
    ),
  ).toHaveLength(1);
  await expect(service.decide(eve, q.id, "approved")).rejects.toMatchObject({
    status: 403,
  });
  await expect(service.decide(bob, q.id, "approved")).rejects.toMatchObject({
    status: 403,
  });
  await service.decide(owner, q.id, "approved");
  expect((await content.detail(bob, doc.id)).resource.role).toBe("editor");
  await expect(service.decide(owner, q.id, "approved")).rejects.toMatchObject({
    status: 409,
  });
  const upgrade = await service.submit(bob, doc.id, "manager");
  await service.decide(owner, upgrade.id, "rejected");
  await db
    .insertInto("access_invitations")
    .values({
      resource_id: doc.id,
      user_id: eve.id,
      state: "pending",
      role: "manager",
    })
    .execute();
  const lowerRequest = await service.submit(eve, doc.id, "reader");
  await service.decide(owner, lowerRequest.id, "approved");
  expect((await content.detail(eve, doc.id)).resource.role).toBe("reader");
  expect(
    (await notificationPage(db, bob, 0)).items.map((n) => n.type),
  ).toContain("access.rejected");
  const latest = (await content.detail(owner, doc.id)).resource;
  await content.permissions(owner, doc.id, {
    version: latest.version,
    accessMode: "custom",
    visibility: "invited",
    requestsEnabled: false,
    grants: [],
  });
  await expect(service.preview(bob, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (await service.list(bob)).items.every((q) => q.title === "内容已不可访问"),
  ).toBe(true);
  expect(
    (await notificationPage(db, bob, 0)).items.every(
      (n) => n.title !== "Secret",
    ),
  ).toBe(true);
  await publishIntegrationEvents(db);
  const events = await db
    .selectFrom("integration_events")
    .selectAll()
    .orderBy("seq")
    .execute();
  expect(events.map((e) => e.type)).toContain("document.created");
  expect(events.map((e) => e.type)).toContain("notification.created");
  expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  const app = await createApp(db, {
    origin: "http://localhost",
    logging: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost", origin: "http://localhost" },
      payload: { login: "owner", password: "test-password-2026" },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect(
      (
        await app.inject({
          url: "/api/v1/admin/integration-events",
          headers: { host: "localhost" },
        })
      ).statusCode,
    ).toBe(401);
    const page = await app.inject({
      url: "/api/v1/admin/integration-events?after=0",
      headers: { host: "localhost", cookie },
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().items.length).toBe(events.length);
    const empty = await app.inject({
      url: `/api/v1/admin/integration-events?after=${page.json().cursor}`,
      headers: { host: "localhost", cookie },
    });
    expect(empty.json().items).toEqual([]);
  } finally {
    await app.close();
    await db.destroy();
  }
});
