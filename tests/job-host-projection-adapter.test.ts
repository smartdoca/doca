import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectionJobSchedulerAdapter,
  enqueueProjection,
  enqueueRuntimeJob,
  processProjections,
} from "../packages/core/src/modules/automation/jobs.js";
import { openDatabase, type DB } from "../packages/db/src/index.js";
import { JobHost } from "../packages/job-host/src/index.js";

describe("durable projection job adapter", () => {
  let db: DB;

  beforeEach(async () => {
    db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("persists retries and dead letters while redacting failure secrets", async () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    await enqueueRuntimeJob(db, {
      id: "plugin-job",
      kind: "documents.export",
      pluginId: "doca.documents",
      maxAttempts: 2,
      availableAt: now.toISOString(),
      payload: { documentId: "document-1" },
    });
    const host = new JobHost({
      scheduler: createProjectionJobSchedulerAdapter(db, {
        kinds: ["documents.export"],
      }),
      context: undefined,
      now: () => now,
      retryDelayMs: () => 0,
    });
    host.register({
      kind: "documents.export",
      pluginId: "doca.documents",
      run() {
        throw new Error("offline Bearer very-secret-token");
      },
    });

    expect((await host.runOnce()).state).toBe("retry");
    expect((await host.runOnce()).state).toBe("dead-letter");
    const row = await db
      .selectFrom("projection_jobs")
      .selectAll()
      .where("id", "=", "plugin-job")
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("dead-letter");
    expect(row.attempts).toBe(2);
    expect(row.last_error).toContain("Bearer ***");
    expect(row.last_error).not.toContain("very-secret-token");
    expect(await host.runOnce()).toMatchObject({ state: "idle" });
  });

  it("records missing plugin ownership and processes core projection jobs", async () => {
    const now = "2026-09-25T00:00:00.000Z";
    await enqueueRuntimeJob(db, {
      id: "missing-plugin-job",
      kind: "mail.sync",
      pluginId: "doca.mail",
      availableAt: now,
      payload: {},
    });
    const host = new JobHost({
      scheduler: createProjectionJobSchedulerAdapter(db, {
        kinds: ["mail.sync"],
      }),
      context: undefined,
      now: () => new Date(now),
    });

    expect((await host.runOnce()).state).toBe("blocked-plugin-missing");
    expect(
      await db
        .selectFrom("projection_jobs")
        .select("status")
        .where("id", "=", "missing-plugin-job")
        .executeTakeFirst(),
    ).toEqual({ status: "blocked-plugin-missing" });

    await enqueueProjection(db, "core-test", "one", { value: 1 });
    const seen: unknown[] = [];
    expect(
      await processProjections(db, "core-test", async (payload) => {
        seen.push(payload.value);
      }),
    ).toBe(1);
    expect(seen).toEqual([1]);
  });

  it("preserves newer coalesced work when the active lease completes", async () => {
    const now = "2026-09-25T00:00:00.000Z";
    await enqueueRuntimeJob(db, {
      id: "coalesced-job",
      kind: "documents.refresh",
      pluginId: "doca.documents",
      availableAt: now,
      payload: { revision: 1 },
    });
    const host = new JobHost({
      scheduler: createProjectionJobSchedulerAdapter(db, {
        kinds: ["documents.refresh"],
      }),
      context: undefined,
      now: () => new Date(now),
    });
    const seen: number[] = [];
    host.register({
      kind: "documents.refresh",
      pluginId: "doca.documents",
      async run(payload) {
        const revision = Number((payload as { revision: number }).revision);
        seen.push(revision);
        if (revision === 1)
          await enqueueRuntimeJob(db, {
            id: "coalesced-job",
            kind: "documents.refresh",
            pluginId: "doca.documents",
            availableAt: now,
            payload: { revision: 2 },
          });
      },
    });

    expect((await host.runOnce()).state).toBe("completed");
    expect((await host.runOnce()).state).toBe("completed");
    expect(seen).toEqual([1, 2]);
    expect(
      await db
        .selectFrom("projection_jobs")
        .select("id")
        .where("id", "=", "coalesced-job")
        .executeTakeFirst(),
    ).toBeUndefined();
  });
});
