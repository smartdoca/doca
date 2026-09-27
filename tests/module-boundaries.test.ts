import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { type DB, type Resource } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { createContent } from "@core/workflows/resources.js";
import { createExperience } from "@core/workflows/experience.js";
import { createDocuments } from "@core/modules/collaboration/documents.js";
import {
  accessContext,
  authorize,
  roleQuery,
  accessibleQuery,
} from "@core/modules/access/queries.js";
import { permission } from "@core/modules/access/policy.js";
import { respondInvitation } from "@core/modules/access/invitations.js";
import { setEntry } from "@core/modules/discovery/entries.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import {
  enqueueProjection,
  processProjections,
} from "@core/modules/automation/jobs.js";
import { publishIntegrationEvents } from "@core/modules/automation/events.js";
import { createVisitBuffer } from "@core/modules/interactions/visits.js";
import { directoryIds } from "@core/modules/discovery/directory.js";
let db: DB, content: ReturnType<typeof createContent>;
const users = Array.from({ length: 4 }, (_, i) => ({
  id: randomUUID(),
  display_name: `User ${i}`,
  admin: i === 3 ? 1 : 0,
}));
const [owner, member, outsider, admin] = users as [
  (typeof users)[number],
  (typeof users)[number],
  (typeof users)[number],
  (typeof users)[number],
];
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  for (const [i, u] of users.entries())
    await db
      .insertInto("users")
      .values({
        ...u,
        login: `user${i}`,
        public_id: `user${i}`,
        status: "active",
        password_hash: "",
        created_at: new Date().toISOString(),
      })
      .execute();
  content = createContent(db);
});
afterEach(async () => {
  await db.destroy();
});
const create = (
  actor = owner,
  extra: Partial<Parameters<typeof content.create>[1]> = {},
) =>
  content.create(actor, {
    title: "Document",
    kind: "document",
    format: "rich_text",
    ...extra,
  });
async function acl(
  id: string,
  grants: {
    userId: string;
    role: "reader" | "commenter" | "editor" | "manager";
  }[],
  extra: Partial<Parameters<typeof content.permissions>[2]> = {},
) {
  const r = (await content.detail(owner, id)).resource;
  return content.permissions(owner, id, {
    version: r.version,
    accessMode: "custom",
    visibility: "invited",
    grants,
    ...extra,
  });
}
it("SQL collection predicates match target authorization across governance, inheritance, public access, link generations and deletion", async () => {
  const lib = await create(owner, { kind: "library" });
  await acl(lib.id, [{ userId: member.id, role: "editor" }], {
    visibility: "public",
  });
  const parent = await create(owner, { libraryId: lib.id });
  const privateChild = await create(owner, { parentId: parent.id });
  await acl(privateChild.id, [{ userId: outsider.id, role: "commenter" }], {visibility:undefined});
  const nested = await create(outsider, { parentId: parent.id }).catch(() =>
    create(owner, { parentId: privateChild.id }),
  );
  const explicit = await create(owner, { parentId: privateChild.id });
  await acl(explicit.id, [{ userId: member.id, role: "reader" }], {
    accessMode: "inherit", visibility:undefined,
  });
  const ownChild = await create(member, { libraryId: lib.id });
  await db
    .updateTable("resources")
    .set({ access_mode: "custom", visibility: "invited" })
    .where("id", "=", ownChild.id)
    .execute();
  const link = createExperience(db);
  const shared = await link.setShare(owner, explicit.id, {
    enabled: true,
    role: "editor",
    version: null,
  });
  await link.redeem(member, shared.token!);
  expect((await authorize(db, member, explicit.id)).rank).toBe(3);
  expect((await authorize(db, owner, ownChild.id)).rank).toBe(5);
  expect((await authorize(db, null, parent.id)).rank).toBe(1);
  expect((await authorize(db, admin, privateChild.id)).rank).toBe(1);
  for (const actor of [...users, null]) {
    const all = await db.selectFrom("resources").selectAll().execute();
    const context = await accessContext(
      db,
      actor,
      all.map((r) => r.id),
    );
    const rows = await db
      .selectFrom("resources as r")
      .select("r.id")
      .select(roleQuery(sql.ref("r.id"), actor).as("rank"))
      .execute();
    for (const row of rows)
      expect(Number(row.rank), `${actor?.id}:${row.id}`).toBe(
        permission(
          all.find((r) => r.id === row.id)!,
          actor,
          context.resources,
          context.grants,
        ),
      );
  }
  await link.revokeShare(owner, explicit.id, shared.id, shared.version);
  expect((await authorize(db, member, explicit.id)).rank).toBe(1);
  await content.trash(
    owner,
    parent.id,
    (await content.detail(owner, parent.id)).resource.version,
  );
  const visible = await db
    .selectFrom("resources as r")
    .select("r.id")
    .where(accessibleQuery(sql.ref("r.id"), member))
    .execute();
  expect(visible.some((r) => r.id === explicit.id)).toBe(false);
  const scoped = await accessContext(db, owner, [ownChild.id]);
  expect(scoped.resources.map((r) => r.id).sort()).toEqual(
    [ownChild.id, lib.id].sort(),
  );
});
it("existing collaborator upgrades apply directly while pending invitations still gate newcomers and stale invites cannot accept a replacement", async () => {
  const doc = await create();
  await acl(doc.id, [{ userId: member.id, role: "reader" }]);
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .execute();
  await acl(doc.id, [{ userId: member.id, role: "editor" }]);
  expect((await authorize(db, member, doc.id)).rank).toBe(3);
  expect(
    await db
      .selectFrom("access_invitations")
      .selectAll()
      .where("resource_id", "=", doc.id)
      .execute(),
  ).toHaveLength(0);
  await acl(doc.id, [
    { userId: member.id, role: "editor" },
    { userId: outsider.id, role: "editor" },
  ]);
  const invitation = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await expect(authorize(db, outsider, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  await respondInvitation(db, outsider, doc.id, false, invitation.version!);
  await expect(authorize(db, outsider, doc.id)).rejects.toMatchObject({
    status: 404,
  });
  await acl(doc.id, [
    { userId: member.id, role: "editor" },
    { userId: outsider.id, role: "manager" },
  ]);
  await expect(
    respondInvitation(db, outsider, doc.id, true, invitation.version!),
  ).rejects.toMatchObject({ status: 409 });
  const replacement = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await respondInvitation(db, outsider, doc.id, true, replacement.version!);
  await respondInvitation(db, outsider, doc.id, true, replacement.version!);
  expect((await authorize(db, outsider, doc.id)).rank).toBe(4);
});
it("discovery, joins, visits and hiding remain independent from authoritative access", async () => {
  const lib = await create(owner, { kind: "library" });
  const doc = await create(owner, { libraryId: lib.id });
  await acl(lib.id, [], { visibility: "public", discoverable: true });
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...distributionDefaults,
        publicDiscovery: true,
        publicLibraries: true,
        autoCollectOpened: true,
      }),
    })
    .execute();
  expect(
    (await content.list(member, { scope: "libraries" })).items.map((r) => r.id),
  ).toEqual([lib.id]);
  await transact(db, (tx) => setEntry(tx, member, lib.id, "hidden"));
  await content.visit(member, lib.id);
  expect((await content.list(member, { scope: "libraries" })).items.map(r=>r.id)).toEqual([lib.id]);
  expect((await content.detail(member, doc.id)).resource.role).toBe("reader");
  expect((await content.list(member, { scope: "personal" })).items).toEqual([]);
  expect(
    (await content.list(member, { scope: "discover" })).items.map((r) => r.id).sort(),
  ).toEqual([lib.id]);
  await transact(db, (tx) => setEntry(tx, member, lib.id, "joined"));
  expect(
    (await content.list(member, { scope: "all", kind: "document" })).items.map(
      (r) => r.id,
    ),
  ).toEqual([doc.id]);
  await expect(acl(doc.id, [])).rejects.toMatchObject({status:400});
  expect((await content.list(member, {scope:"all",kind:"document"})).items.map(r=>r.id)).toEqual([doc.id]);
  await acl(lib.id, []);
  expect((await content.list(member, { scope: "libraries" })).items).toEqual(
    [],
  );
  expect(
    await db
      .selectFrom("resource_collections")
      .selectAll()
      .where("user_id", "=", member.id)
      .execute(),
  ).toHaveLength(1);
});
it("pagination is stable for tied timestamps, binds its scope, and filters before slicing", async () => {
  const now = new Date().toISOString();
  for (let offset = 0; offset < 205; offset++) {
    const id = `00000000-0000-4000-8000-${String(offset).padStart(12, "0")}`;
    await db
      .insertInto("resources")
      .values({
        id,
        owner_id: offset % 2 ? owner.id : outsider.id,
        kind: "document",
        format: "rich_text",
        title: "item",
        parent_id: null,
        library_id: null,
        access_mode: "custom",
        visibility: "invited",
        version: 1,
        deleted_at: null,
        delete_batch: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  const first = await content.list(owner, { scope: "owned" });
  expect(first.items).toHaveLength(100);
  expect(first.total).toBe(102);
  const second = await content.list(owner, {
    scope: "owned",
    cursor: first.nextCursor!,
  });
  expect(second.items).toHaveLength(2);
  expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(
    102,
  );
  await expect(
    content.list(member, { scope: "owned", cursor: first.nextCursor! }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    content.list(owner, { scope: "recent", cursor: first.nextCursor! }),
  ).rejects.toMatchObject({ status: 400 });
});
it("coalesced projections retain newer work during delivery, retry failures and publish committed events once", async () => {
  await transact(db, (tx) =>
    enqueueProjection(tx, "test", "document", { value: 1 }),
  );
  const seen: number[] = [];
  await processProjections(
    db,
    "test",
    async (payload) => {
      seen.push(Number(payload.value));
      await transact(db, (tx) =>
        enqueueProjection(tx, "test", "document", { value: 2 }),
      );
    },
    1,
  );
  await processProjections(db, "test", async (payload) => {
    seen.push(Number(payload.value));
  });
  expect(seen).toEqual([1, 2]);
  await transact(db, (tx) =>
    enqueueProjection(tx, "test", "document", { value: 3 }),
  );
  await processProjections(db, "test", async () => {
    throw Error("offline");
  });
  const failed = await db
    .selectFrom("projection_jobs")
    .selectAll()
    .where("kind", "=", "test")
    .executeTakeFirstOrThrow();
  expect(failed.attempts).toBe(1);
  expect(failed.lease_token).toBeNull();
  await db
    .updateTable("projection_jobs")
    .set({ available_at: "2000-01-01T00:00:00.000Z" })
    .where("id", "=", failed.id)
    .execute();
  await processProjections(db, "test", async (payload) => {
    seen.push(Number(payload.value));
  });
  expect(seen).toEqual([1, 2, 3]);
  await create();
  expect(await publishIntegrationEvents(db)).toBeGreaterThan(0);
  expect(await publishIntegrationEvents(db)).toBe(0);
  const events = await db
    .selectFrom("integration_events")
    .selectAll()
    .execute();
  expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
});
it("recent visits coalesce and tolerate failure without rolling timestamps backwards", async () => {
  const doc = await create();
  const buffer = createVisitBuffer(
    (actor, id, stamp) => content.visit(actor, id, stamp),
    60000,
  );
  try {
    buffer.record(owner, doc.id, new Date("2026-09-13T10:00:00Z"));
    buffer.record(owner, doc.id, new Date("2026-09-13T09:00:00Z"));
    buffer.record(member, doc.id);
    await buffer.flush();
    await content.visit(owner, doc.id, new Date("2026-09-13T08:00:00Z"));
    const rows = await db.selectFrom("resource_visits").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visited_at).toBe("2026-09-13T10:00:00.000Z");
  } finally {
    await buffer.close();
  }
});
it("public reading does not reveal history, and historical surface previews retain their original baseline", async () => {
  const doc = await create(owner, { format: "spreadsheet" });
  await createDocuments(db).exchange(owner, doc.id, {
    codec: "exlsx-cell-registers",
    schemaVersion: 6,
    protocolVersion: 1,
  });
  const history = createExperience(db),
    version = await history.snapshot(owner, doc.id);
  const saved = await db
    .selectFrom("document_versions")
    .selectAll()
    .where("id", "=", version.id)
    .executeTakeFirstOrThrow();
  const recovery = JSON.parse(saved.recovery_json!);
  await acl(doc.id, [], { visibility: "public" });
  await expect(history.version(null, doc.id, version.id)).rejects.toMatchObject(
    { status: 403 },
  );
  await expect(history.versions(member, doc.id)).rejects.toMatchObject({
    status: 403,
  });
  await acl(doc.id, [], { visibility: "public", historyReaders: true });
  const epoch = await db
    .selectFrom("editor_epochs")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .executeTakeFirstOrThrow();
  const next = JSON.parse(epoch.baseline!);
  next.snapshot.name = "current baseline changed";
  await db
    .updateTable("editor_epochs")
    .set({ baseline: JSON.stringify(next) })
    .where("resource_id", "=", doc.id)
    .execute();
  const preview = await history.version(null, doc.id, version.id);
  expect(preview.surface?.baseline).toEqual(recovery.baseline);
  expect(preview.surface?.epochId).toBe(recovery.epochId);
});
it("pending or public-only relationships do not populate the restricted user directory", async () => {
  const doc = await create();
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({ ...distributionDefaults, grantMode: "invite" }),
    })
    .execute();
  await acl(doc.id, [{ userId: member.id, role: "reader" }], {
    visibility: "public",
  });
  await db.updateTable("settings").set({ directory_mode: "related" }).execute();
  expect([...(await directoryIds(db, member))!]).toEqual([]);
  const invitation = await db
    .selectFrom("access_invitations")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .executeTakeFirstOrThrow();
  await respondInvitation(db, member, doc.id, true, invitation.version!);
  expect([...(await directoryIds(db, member))!].sort()).toEqual(
    [owner.id, member.id].sort(),
  );
  expect([...(await directoryIds(db, outsider))!]).toEqual([]);
});

it.skipIf(!process.env.DOCA_TEST_POSTGRES)(
  "retries a concurrent content transaction against revoked permission before committing",
  async () => {
    const doc = await create();
    await acl(doc.id, [{ userId: member.id, role: "editor" }]);
    let ready!: () => void,
      release!: () => void,
      attempts = 0;
    const authorized = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const editing = transact(db, async (tx) => {
      await authorize(tx, member, doc.id, "edit_content");
      if (++attempts === 1) {
        ready();
        await proceed;
      }
      await tx
        .updateTable("resources")
        .set({ title: "must not commit after retry" })
        .where("id", "=", doc.id)
        .execute();
    });
    const result = editing.then(
      () => ({ status: "committed" as const }),
      (error) => ({ status: "rejected" as const, error }),
    );
    await authorized;
    try {
      await acl(doc.id, []);
    } finally {
      release();
    }
    const outcome = await result;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected")
      expect(outcome.error).toMatchObject({ status: 404 });
    expect((await content.detail(owner, doc.id)).resource.title).toBe(
      "Document",
    );
    await expect(
      authorize(db, member, doc.id, "edit_content"),
    ).rejects.toMatchObject({ status: 404 });
  },
);
it("parallel metadata requests resolve through versions without losing an update", async () => {
  const doc = await create();
  const outcomes = await Promise.allSettled([
    content.rename(owner, doc.id, "First", doc.version),
    content.rename(owner, doc.id, "Second", doc.version),
  ]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = outcomes.find((r) => r.status === "rejected");
  expect(failed?.status === "rejected" && failed.reason.status).toBe(409);
  const detail = await content.detail(owner, doc.id);
  expect(detail.resource.version).toBe(doc.version + 1);
});

it("core modules depend on domain contracts rather than HTTP or workflow composition", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");
  const root = resolve("packages/core/src/modules");
  async function inspect(dir: string): Promise<void> {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, file.name);
      if (file.isDirectory()) await inspect(path);
      else if (file.name.endsWith(".ts")) {
        const source = await readFile(path, "utf8");
        for (const match of source.matchAll(
          /(?:from\s+|import\()\s*["']([^"']+)["']/g,
        ))
          expect(match[1], path).not.toMatch(
            /workflows\/|apps\/server|fastify/,
          );
      }
    }
  }
  await inspect(root);
});

it("application source stays grouped by runtime and responsibility", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");
  const webRoot = resolve("apps/web/src");
  const serverRoot = resolve("apps/server/src");
  const webGroups = new Set(["app", "features", "plugins", "shared", "styles"]);
  const serverGroups = new Set([
    "adapters",
    "app",
    "bootstrap",
    "jobs",
    "plugins",
    "routes",
    "services",
  ]);
  for (const entry of await readdir(webRoot, { withFileTypes: true })) {
    if (entry.name.endsWith(".d.ts")) continue;
    expect(entry.isDirectory(), entry.name).toBe(true);
    expect(webGroups.has(entry.name), entry.name).toBe(true);
  }
  for (const entry of await readdir(serverRoot, { withFileTypes: true })) {
    if (entry.name === "main.ts" || entry.name.endsWith(".d.ts")) continue;
    expect(entry.isDirectory(), entry.name).toBe(true);
    expect(serverGroups.has(entry.name), entry.name).toBe(true);
  }
  const inspectWeb = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await inspectWeb(file);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) {
        const source = await readFile(file, "utf8");
        expect(source, file).not.toMatch(/\.\.\/\.\.\/\.\.\/packages\//);
      }
    }
  };
  await inspectWeb(webRoot);
});
