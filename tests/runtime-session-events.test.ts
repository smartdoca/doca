import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AISessionEventDigestMismatchError,
  AISessionEventSequenceError,
  createAISessionEventStore,
  openDatabase,
  type DB,
} from "../packages/db/src/index.js";
import { createSessionEvent } from "../packages/ai-host/src/index.js";

describe("durable AI session events", () => {
  let db: DB;

  beforeEach(async () => {
    db = await openDatabase({ driver: "sqlite", path: ":memory:" });
    const now = "2026-09-25T00:00:00.000Z";
    await db
      .insertInto("users")
      .values({
        id: "user-1",
        login: "runtime-events",
        display_name: "Runtime Events",
        password_hash: "unused",
        admin: 0,
        status: "active",
        created_at: now,
      })
      .execute();
    await db
      .insertInto("ai_sessions")
      .values({
        id: "session-1",
        user_id: "user-1",
        title: "Runtime",
        model_id: null,
        resource_ids: "[]",
        archived: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("commits monotonic events and replays a consistent ordered stream", async () => {
    const store = createAISessionEventStore(db);
    const first = createSessionEvent({
      sessionId: "session-1",
      sequence: 0,
      timestamp: "2026-09-25T00:00:01.000Z",
      type: "turn.started",
      data: { turnId: "turn-1" },
    });
    const second = createSessionEvent({
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-09-25T00:00:02.000Z",
      type: "turn.completed",
      data: { turnId: "turn-1" },
    });

    expect(await store.append(first)).toMatchObject({
      delivery: "committed",
      sequence: 0,
      id: first.id,
    });
    await store.append(second);

    const events = await store.readCommitted("session-1");
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(
      await store.replay("session-1", [] as string[], (types, event) => [
        ...types,
        event.type,
      ]),
    ).toEqual(["turn.started", "turn.completed"]);
  });

  it("makes stable event IDs idempotent and rejects digest mismatches", async () => {
    const store = createAISessionEventStore(db);
    const event = {
      sessionId: "session-1",
      eventId: "evt-stable",
      type: "tool.progress",
      payload: { nested: { second: 2, first: 1 } },
      createdAt: "2026-09-25T00:00:01.000Z",
    };
    const committed = await store.append(event);
    const retried = await store.append({
      ...event,
      payload: { nested: { first: 1, second: 2 } },
      createdAt: "later-retry-time",
    });

    expect(retried).toEqual(committed);
    expect(await store.read("session-1")).toHaveLength(1);
    await expect(
      store.append({
        ...event,
        payload: { nested: { first: 99, second: 2 } },
      }),
    ).rejects.toBeInstanceOf(AISessionEventDigestMismatchError);
  });

  it("rejects caller-supplied sequence gaps without writing them", async () => {
    const store = createAISessionEventStore(db);
    await expect(
      store.append({
        sessionId: "session-1",
        eventId: "evt-gap",
        sequence: 2,
        type: "turn.started",
        payload: { turnId: "turn-1" },
      }),
    ).rejects.toBeInstanceOf(AISessionEventSequenceError);
    expect(await store.read("session-1")).toEqual([]);
  });

  it("retains committed events across database restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doca-session-events-"));
    const path = join(directory, "runtime.sqlite");
    try {
      const durable = await openDatabase({ driver: "sqlite", path });
      const now = "2026-09-25T00:00:00.000Z";
      await durable
        .insertInto("users")
        .values({
          id: "durable-user",
          login: "durable-runtime-events",
          display_name: "Durable Runtime Events",
          password_hash: "unused",
          admin: 0,
          status: "active",
          created_at: now,
        })
        .execute();
      await durable
        .insertInto("ai_sessions")
        .values({
          id: "durable-session",
          user_id: "durable-user",
          title: "Durable Runtime",
          model_id: null,
          resource_ids: "[]",
          archived: 0,
          revision: 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await createAISessionEventStore(durable).append({
        sessionId: "durable-session",
        eventId: "evt-durable",
        type: "turn.started",
        payload: { turnId: "turn-durable" },
      });
      await durable.destroy();

      const reopened = await openDatabase({ driver: "sqlite", path });
      expect(
        await createAISessionEventStore(reopened).read("durable-session"),
      ).toMatchObject([
        {
          delivery: "committed",
          id: "evt-durable",
          sequence: 0,
          data: { turnId: "turn-durable" },
        },
      ]);
      await reopened.destroy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
