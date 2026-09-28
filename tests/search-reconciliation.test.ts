import { it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerSearch } from "../apps/server/src/routes/search.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  createSearchReconciler,
  resetSearchReconciliation,
  searchDocument,
} from "@core/modules/discovery/search-reconciliation.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";

async function setup(db: DB) {
  const actor: Actor = {
    ...(await createUser(
      db,
      {
        login: "scan-admin",
        displayName: "Scan admin",
        password: "isolated-search-test-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const content = createContent(db);
  const create = (title: string) =>
    content.create(actor, { kind: "document", format: "rich_text", title });
  await db
    .updateTable("search_settings")
    .set({ enabled: 1 })
    .where("id", "=", "system")
    .execute();
  return { actor, content, create };
}
const config = (db: DB) =>
  db
    .selectFrom("search_settings")
    .selectAll()
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
const projection = async (db: DB, id: string) => {
  const row = await db
    .selectFrom("resources as r")
    .leftJoin("document_states as s", "s.resource_id", "r.id")
    .select(["r.id", "r.title", "s.text"])
    .where("r.id", "=", id)
    .executeTakeFirstOrThrow();
  return searchDocument(row);
};

it("runs the HTTP worker end to end, recreates a missing index and skips redundant writes", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const app = Fastify();
  try {
    const { actor, create } = await setup(db);
    const doc = await create("后台恢复测试");
    await db.deleteFrom("projection_jobs").execute();
    let exists = false,
      writes = 0;
    const remote = new Map<string, unknown>();
    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input)),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname.startsWith("/tasks/"))
        return Response.json({ status: "succeeded" });
      if (url.pathname === "/indexes" && init?.method === "POST") {
        exists = true;
        return Response.json({ taskUid: 1 });
      }
      if (!exists) return new Response("missing", { status: 404 });
      if (url.pathname.endsWith("/settings"))
        return Response.json({ taskUid: 1 });
      if (url.pathname.endsWith("/documents")) {
        if (init?.method === "POST") {
          writes++;
          for (const value of body) remote.set(value.id, value);
          return Response.json({ taskUid: 1 });
        }
        expect(url.searchParams.get("fields")).toBe("id,content_hash");
        const offset = Number(url.searchParams.get("offset")),
          limit = Number(url.searchParams.get("limit"));
        return Response.json({
          results: [...remote.values()].slice(offset, offset + limit),
        });
      }
      if (url.pathname.includes("/documents/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        if (init?.method === "DELETE") {
          remote.delete(id);
          return Response.json({ taskUid: 1 });
        }
        return remote.has(id)
          ? Response.json(remote.get(id))
          : new Response("missing", { status: 404 });
      }
      return Response.json({});
    };
    vi.useFakeTimers();
    await registerSearch(app, db, () => actor, {
      allowedOrigins: ["http://127.0.0.1:7700"],
      fetch: mockFetch,
    });
    await app.ready();
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(remote.get(doc.id)).toEqual(await projection(db, doc.id));
    expect(writes).toBe(1);
    const first = (await app.inject({ url: "/api/v1/admin/search" })).json();
    expect(first.reconciliation).toMatchObject({
      phase: "idle",
      pending: 0,
      differences: 1,
    });
    // A redundant source event does not result in another document/embedding write.
    await db
      .insertInto("projection_jobs")
      .values({
        id: `search:${doc.id}`,
        kind: "search",
        payload: JSON.stringify({ resourceId: doc.id }),
        revision: 1,
        attempts: 0,
        available_at: new Date().toISOString(),
        last_error: null,
      })
      .execute();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toBe(1);
    // Out-of-band loss and permanent-deletion residue are reconciled by the actual worker.
    remote.delete(doc.id);
    remote.set("orphan".repeat(40), { id: "orphan".repeat(40) });
    await app.inject({ method: "POST", url: "/api/v1/admin/search/reconcile" });
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1000);
    expect([...remote.keys()]).toEqual([doc.id]);
    expect(writes).toBe(2);
    expect(
      (await app.inject({ url: "/api/v1/admin/search" })).json().reconciliation,
    ).toMatchObject({ phase: "idle", differences: 2, pending: 0 });
  } finally {
    await app.close();
    vi.useRealTimers();
    await db.destroy();
  }
});

it("repairs missed changes, missing documents and multi-page orphans without reindexing unchanged content", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const { actor, content, create } = await setup(db);
    const own = await create("保持不变"),
      stale = await create("更新后的标题"),
      missing = await create("漏入队");
    const deleted = await create("已删除");
    await db
      .updateTable("resources")
      .set({ deleted_at: new Date().toISOString() })
      .where("id", "=", deleted.id)
      .execute();
    const library = await content.create(actor, {
      kind: "library",
      format: "rich_text",
      title: "知识库不是文档",
    });
    const remote = new Map<string, { id: string; content_hash: string | null }>(
      [
        [own.id, await projection(db, own.id)],
        [
          stale.id,
          searchDocument({ id: stale.id, title: "旧标题", text: "旧正文" }),
        ],
        [deleted.id, await projection(db, deleted.id)],
        [library.id, { id: library.id, content_hash: null }],
        ...Array.from(
          { length: 5 },
          (_, i) =>
            [`orphan-${i}`, { id: `orphan-${i}`, content_hash: null }] as const,
        ),
      ],
    );
    await db.deleteFrom("projection_jobs").execute(); // Simulate lost event delivery.
    const offsets: number[] = [];
    const reconciler = createSearchReconciler(db, {
      pageSize: 2,
      list: async (_, offset, limit) => {
        offsets.push(offset);
        expect(
          await db.selectFrom("projection_jobs").selectAll().execute(),
        ).toHaveLength(0);
        return { results: [...remote.values()].slice(offset, offset + limit) };
      },
    });
    const c = await config(db);
    for (let i = 0; i < 40 && !(await reconciler.status()).checkedAt; i++)
      await reconciler.tick(c);
    expect(offsets).toEqual([0, 2, 4, 6, 8]);
    expect(await reconciler.status()).toMatchObject({
      phase: "waiting",
      scanned: 3,
      differences: 9,
      pending: 9,
      completedAt: null,
    });
    const jobs = await db.selectFrom("projection_jobs").selectAll().execute();
    expect(jobs.some((job) => job.id === `search:${own.id}`)).toBe(false);
    // Simulate a queue item being lost after enumeration. Waiting phase must re-create it.
    await db
      .deleteFrom("projection_jobs")
      .where("id", "=", `search:${missing.id}`)
      .execute();
    for (let i = 0; i < 6; i++) await reconciler.tick(c);
    expect(
      await db.selectFrom("projection_jobs").selectAll().execute(),
    ).toHaveLength(9);
    await processProjections(db, "search", async (payload) => {
      const id = String(payload.resourceId),
        receipt = await reconciler.repairToken(id);
      const row = await db
        .selectFrom("resources")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row || row.deleted_at || row.kind !== "document") remote.delete(id);
      else remote.set(id, await projection(db, id));
      await reconciler.completeRepair(c, id, receipt);
    });
    await reconciler.tick(c);
    expect(await reconciler.status()).toMatchObject({
      phase: "idle",
      pending: 0,
    });
    expect((await reconciler.status()).completedAt).toBeTruthy();
    expect([...remote.keys()].sort()).toEqual(
      [own.id, stale.id, missing.id].sort(),
    );
    await reconciler.schedule();
    for (let i = 0; i < 12; i++) await reconciler.tick(c);
    expect(await reconciler.status()).toMatchObject({
      phase: "idle",
      differences: 0,
      pending: 0,
    });
    expect(
      await db.selectFrom("projection_jobs").selectAll().execute(),
    ).toHaveLength(0);
  } finally {
    await db.destroy();
  }
});

it("resumes a persisted inventory cursor after reopening the database and waits for an abandoned lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doca-search-restart-"));
  const path = join(dir, "test.sqlite");
  let db = await openTestDatabase({ driver: "sqlite", path });
  try {
    await setup(db);
    const c = await config(db);
    let clock = Date.now();
    const offsets: number[] = [];
    const list = async (_: unknown, offset: number, limit: number) => {
      offsets.push(offset);
      return {
        results: [
          { id: "orphan-a" },
          { id: "orphan-b" },
          { id: "orphan-c" },
        ].slice(offset, offset + limit),
      };
    };
    await createSearchReconciler(db, {
      pageSize: 2,
      list,
      now: () => clock,
    }).tick(c);
    await db
      .updateTable("search_reconciliation")
      .set({
        lease_token: "crashed-worker",
        lease_until: new Date(clock + 60000).toISOString(),
      })
      .where("id", "=", "system")
      .execute();
    await db.destroy();
    db = await openTestDatabase({ driver: "sqlite", path });
    const resumed = createSearchReconciler(db, {
      pageSize: 2,
      list,
      now: () => clock,
    });
    await resumed.tick(c);
    expect(offsets).toEqual([0]);
    clock += 61000;
    await resumed.tick(c);
    expect(offsets).toEqual([0, 2]);
    expect(
      await db.selectFrom("search_reconcile_entries").selectAll().execute(),
    ).toHaveLength(3);
    for (let i = 0; i < 4; i++) await resumed.tick(c);
    expect(await resumed.status()).toMatchObject({
      phase: "waiting",
      pending: 3,
    });
  } finally {
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

it("fences concurrent workers and discards inventory fetched for an obsolete configuration", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    await setup(db);
    const c = await config(db);
    let release!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const old = createSearchReconciler(db, {
      list: async () => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const work = old.tick(c);
    await started;
    let competingCalls = 0;
    await createSearchReconciler(db, {
      list: async () => {
        competingCalls++;
        return { results: [] };
      },
    }).tick(c);
    expect(competingCalls).toBe(0);
    await transact(db, async (tx) => {
      await tx
        .updateTable("search_settings")
        .set({ generation: c.generation + 1, index_name: "new-index" })
        .where("id", "=", "system")
        .execute();
      await resetSearchReconciliation(tx, c.generation + 1);
    });
    release({ results: [{ id: "obsolete" }] });
    await work;
    expect(
      await db.selectFrom("search_reconcile_entries").selectAll().execute(),
    ).toHaveLength(0);
    expect(await old.status()).toMatchObject({ phase: "idle", scanned: 0 });
  } finally {
    await db.destroy();
  }
});

it("persists retry state, rejects malformed inventory, respects disabled search and preserves delayed work", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const { create } = await setup(db);
    const doc = await create("延迟任务");
    const due = new Date(Date.now() + 1800000).toISOString();
    await db
      .updateTable("projection_jobs")
      .set({ available_at: due, revision: 7, attempts: 2 })
      .where("id", "=", `search:${doc.id}`)
      .execute();
    let malformed = true,
      calls = 0;
    const reconciler = createSearchReconciler(db, {
      list: async () => {
        calls++;
        return malformed ? {} : { results: [] };
      },
    });
    const c = await config(db);
    await db
      .updateTable("search_settings")
      .set({ enabled: 0 })
      .where("id", "=", "system")
      .execute();
    await reconciler.tick(c);
    expect(calls).toBe(0);
    await db
      .updateTable("search_settings")
      .set({ enabled: 1 })
      .where("id", "=", "system")
      .execute();
    await reconciler.tick(c);
    expect((await reconciler.status()).lastError).toBeTruthy();
    await reconciler.tick(c);
    expect(calls).toBe(1);
    malformed = false;
    await reconciler.schedule();
    for (let i = 0; i < 6; i++) await reconciler.tick(c);
    expect(await reconciler.status()).toMatchObject({
      phase: "waiting",
      pending: 1,
      lastError: null,
    });
    expect(
      await db
        .selectFrom("projection_jobs")
        .selectAll()
        .where("id", "=", `search:${doc.id}`)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ available_at: due, revision: 7, attempts: 2 });
    const receipt = await reconciler.repairToken(doc.id);
    await reconciler.completeRepair(
      { ...c, generation: c.generation + 1 },
      doc.id,
      receipt,
    );
    expect((await reconciler.status()).pending).toBe(1);
  } finally {
    await db.destroy();
  }
});
