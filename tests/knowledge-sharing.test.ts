import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  saveKnowledgeAssistant,
  knowledgeAssistantAccess,
} from "@core/modules/knowledge/system.js";
import {
  knowledgePermissionOverview,
  enableKnowledgeSharing,
  saveKnowledgeShareLink,
  knowledgeShareLinks,
  redeemKnowledgeShare,
  revokeKnowledgeShareLink,
  updateKnowledgeMember,
  updateKnowledgePermission,
} from "@core/modules/knowledge/permissions.js";
import { authorize } from "@core/modules/access/queries.js";
let db: DB, owner: Actor, bob: Actor, eve: Actor, id: string, library: string;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const users = ["owner", "bob", "eve"].map((login) => ({
    id: randomUUID(),
    login,
    display_name: login,
    password_hash: "unused",
    admin: 0,
    status: "active",
    created_at: new Date().toISOString(),
  }));
  await db.insertInto("users").values(users).execute();
  owner = users[0]!;
  bob = users[1]!;
  eve = users[2]!;
  library = (
    await createContent(db).create(owner, {
      kind: "library",
      format: "markdown",
      title: "Private",
    })
  ).id;
  id = (
    await saveKnowledgeAssistant(db, owner, {
      title: "Bot",
      libraryIds: [library],
      memberIds: [],
      managerIds: [],
      enabled: true,
      expectedRevision: 0,
    })
  ).id;
});
afterEach(async () => db.destroy());
const link = async (maxMembers: number | null = 1) => {
  await enableKnowledgeSharing(db, owner, id, true);
  return saveKnowledgeShareLink(db, owner, id, {
    version: null,
    enabled: true,
    role: "reader",
    includeDescendants: false,
    maxMembers,
  });
};
const accessible = async (actor: Actor) =>
  knowledgeAssistantAccess(
    db,
    actor,
    await db
      .selectFrom("knowledge_assistants")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );
it("link preview does not grant access; joining grants bot access only and enforces capacity", async () => {
  const l = await link();
  expect(await redeemKnowledgeShare(db, bob, l.token!, false)).toMatchObject({
    pending: true,
    kind: "assistant",
  });
  expect((await accessible(bob)).accessible).toBe(false);
  await redeemKnowledgeShare(db, bob, l.token!, true);
  expect((await accessible(bob)).accessible).toBe(true);
  await expect(authorize(db, bob, library, 1)).rejects.toThrow();
  await expect(redeemKnowledgeShare(db, eve, l.token!, true)).rejects.toThrow(
    /人数/,
  );
  expect((await knowledgeShareLinks(db, owner, id)).items[0]?.memberCount).toBe(
    1,
  );
});
it("pausing blocks new joins, revocation removes link access but preserves direct members", async () => {
  const l = await link(null);
  await redeemKnowledgeShare(db, bob, l.token!, true);
  await enableKnowledgeSharing(db, owner, id, false);
  await expect(redeemKnowledgeShare(db, eve, l.token!, true)).rejects.toThrow(
    /失效/,
  );
  expect((await accessible(bob)).accessible).toBe(true);
  const overview = await knowledgePermissionOverview(db, owner, id);
  await updateKnowledgeMember(db, owner, id, bob.id, {
    revision: overview.version,
    role: "reader",
  });
  const current = (await knowledgeShareLinks(db, owner, id)).items[0]!;
  await revokeKnowledgeShareLink(db, owner, id, current.id, current.version);
  // A direct invitation is still present, and must be accepted independently.
  expect(
    (await knowledgePermissionOverview(db, owner, id)).members.find(
      (m) => m.id === bob.id,
    )?.sourceDetails,
  ).toHaveLength(1);
  expect((await knowledgeShareLinks(db, owner, id)).revokedItems).toHaveLength(
    1,
  );
});
it("revocation and member removal invalidate accepted link grants", async () => {
  const l = await link(null);
  await redeemKnowledgeShare(db, bob, l.token!, true);
  const current = (await knowledgeShareLinks(db, owner, id)).items[0]!;
  await revokeKnowledgeShareLink(db, owner, id, current.id, current.version);
  expect((await accessible(bob)).accessible).toBe(false);
  const other = await link(null);
  await redeemKnowledgeShare(db, bob, other.token!, true);
  await updateKnowledgeMember(db, owner, id, bob.id, {
    revision: (await knowledgePermissionOverview(db, owner, id)).version,
    role: null,
  });
  expect((await accessible(bob)).accessible).toBe(false);
});
it("expired and stale links reject writes; non-managers cannot inspect or configure links", async () => {
  const l = await link();
  await expect(knowledgeShareLinks(db, bob, id)).rejects.toThrow();
  await expect(enableKnowledgeSharing(db, bob, id, true)).rejects.toThrow();
  await expect(
    saveKnowledgeShareLink(db, owner, id, {
      version: l.version,
      enabled: true,
      role: "manager",
    }),
  ).rejects.toThrow();
  await db
    .updateTable("knowledge_bot_share_links")
    .set({ expires_at: "2000-01-01T00:00:00.000Z" })
    .where("id", "=", l.id)
    .execute();
  await expect(redeemKnowledgeShare(db, bob, l.token!, true)).rejects.toThrow(
    /失效/,
  );
  await expect(
    revokeKnowledgeShareLink(db, owner, id, l.id, randomUUID()),
  ).rejects.toThrow(/修改/);
});
it("public settings and invitations enforce revision and protect the owner", async () => {
  const state = await knowledgePermissionOverview(db, owner, id);
  await updateKnowledgePermission(db, owner, id, {
    version: state.version,
    visibility: "authenticated",
  });
  await expect(
    updateKnowledgePermission(db, owner, id, {
      version: state.version,
      visibility: "public",
    }),
  ).rejects.toThrow(/修改/);
  const next = await knowledgePermissionOverview(db, owner, id);
  await expect(
    updateKnowledgeMember(db, owner, id, owner.id, {
      revision: next.version,
      role: null,
    }),
  ).rejects.toThrow(/所有者/);
});
it("concurrent claims cannot exceed a one-person limit", async () => {
  const l = await link();
  const results = await Promise.allSettled([
    redeemKnowledgeShare(db, bob, l.token!, true),
    redeemKnowledgeShare(db, eve, l.token!, true),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await knowledgeShareLinks(db, owner, id)).items[0]?.memberCount).toBe(
    1,
  );
});
it("shared HTTP redemption directs bot links to the Q&A page and permission routes use the common contract", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerExperience } =
    await import("../apps/server/src/routes/experience.js");
  const { registerKnowledgePermissions } =
    await import("../apps/server/src/routes/knowledge-permissions.js");
  const app = Fastify();
  let actor = owner;
  app.setErrorHandler((error: any, _req, reply) =>
    reply.code(error.status ?? 400).send({ message: error.message }),
  );
  registerExperience(
    app,
    db,
    () => actor,
    () => actor,
  );
  registerKnowledgePermissions(app, db, () => actor);
  try {
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/knowledge/assistants/${id}/permission-overview`,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      canManage: true,
      hasParent: false,
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/knowledge/assistants/${id}/share-links/enabled`,
      payload: { enabled: true },
    });
    const created = await app.inject({
      method: "PUT",
      url: `/api/v1/knowledge/assistants/${id}/share-link`,
      payload: {
        version: null,
        enabled: true,
        role: "reader",
        includeDescendants: false,
        maxMembers: 1,
      },
    });
    expect(created.statusCode).toBe(200);
    actor = bob;
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/share/redeem",
      payload: { token: created.json().token, accept: false },
    });
    expect(preview.json()).toMatchObject({
      pending: true,
      kind: "assistant",
      id,
    });
    const joined = await app.inject({
      method: "POST",
      url: "/api/v1/share/redeem",
      payload: { token: created.json().token, accept: true },
    });
    expect(joined.json()).toMatchObject({ kind: "assistant", id });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/knowledge/assistants/${id}/share-link`,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
it("owners can manage sharing on disabled bots but readers cannot redeem them", async () => {
  const l = await link();
  await db
    .updateTable("knowledge_assistants")
    .set({ enabled: 0 })
    .where("id", "=", id)
    .execute();
  expect((await knowledgePermissionOverview(db, owner, id)).canManage).toBe(
    true,
  );
  await expect(redeemKnowledgeShare(db, bob, l.token!, true)).rejects.toThrow();
});
