import { afterEach, describe, expect, it } from "vitest";
import {
  createRealtimeCluster,
  type RealtimeCluster,
} from "../apps/server/src/services/realtime/cluster.js";

const clusters: RealtimeCluster[] = [];
afterEach(async () => {
  await Promise.allSettled(
    clusters.splice(0).map((cluster) => cluster.close()),
  );
});

describe("realtime cluster adapters", () => {
  it("keeps the zero-configuration adapter local and bounded", async () => {
    const cluster = await createRealtimeCluster({
      instanceId: "local-a",
      presenceTtlMs: 20,
    });
    clusters.push(cluster);
    const events: string[] = [];
    cluster.subscribe((event) => {
      events.push(event.type);
    });
    await cluster.upsert({
      connectionId: "connection-a",
      userId: "user-a",
      name: "A",
      color: "#000",
      room: "room-a",
      selection: null,
    });
    await cluster.publish({
      type: "connections.changed",
      originInstanceId: cluster.instanceId,
    });
    expect(events).toEqual(["connections.changed"]);
    expect(await cluster.connections()).toHaveLength(1);
    expect(await cluster.consumeRateLimit("login:a", 1, 1000)).toBe(true);
    expect(await cluster.consumeRateLimit("login:a", 1, 1000)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await cluster.connections()).toEqual([]);
  });

  it("fails a configured but unavailable Redis dependency", async () => {
    await expect(
      createRealtimeCluster({
        redisUrl: "redis://127.0.0.1:1",
        connectTimeoutMs: 50,
      }),
    ).rejects.toThrow("Redis startup connection timed out");
  });

  const redisIt = process.env.DOCA_TEST_REDIS_URL ? it : it.skip;
  redisIt("shares events, presence and rate limits through Redis", async () => {
    const prefix = `doca-test-${crypto.randomUUID()}`;
    const a = await createRealtimeCluster({
      redisUrl: process.env.DOCA_TEST_REDIS_URL,
      prefix,
      instanceId: "redis-a",
    });
    const b = await createRealtimeCluster({
      redisUrl: process.env.DOCA_TEST_REDIS_URL,
      prefix,
      instanceId: "redis-b",
    });
    clusters.push(a, b);
    const received = new Promise<string>((resolve) =>
      b.subscribe((event) => resolve(event.type)),
    );
    await a.upsert({
      connectionId: "connection-a",
      userId: "user-a",
      name: "A",
      color: "#123",
      room: "room-a",
      selection: { anchor: 1 },
    });
    await a.publish({
      type: "connections.changed",
      originInstanceId: a.instanceId,
    });
    expect(await received).toBe("connections.changed");
    expect((await b.connections()).map((item) => item.connectionId)).toEqual([
      "connection-a",
    ]);
    expect(await a.consumeRateLimit("login:shared", 1, 1000)).toBe(true);
    expect(await b.consumeRateLimit("login:shared", 1, 1000)).toBe(false);
  });
});
