import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "@db/index.js";
import {
  openWebhookDatabase,
  webhookDatabaseConfig,
} from "@db/webhook-database.js";
import { emitIntegrationEvent } from "@core/modules/automation/events.js";
import {
  webhookAttemptLimit,
  type ClaimedWebhook,
} from "@core/modules/automation/webhooks.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { resolveWebhookAddress } from "../apps/server/src/services/webhooks/http.js";
import { dispatchWebhooks } from "../apps/server/src/services/webhooks/dispatch.js";
import { openTestDatabase } from "./database.js";

const resolvePublic = async () => [{ address: "1.1.1.1", family: 4 }];

it("keeps webhook subscriptions in a separate database and ignores an older baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "doca-webhooks-"));
  const mainPath = join(directory, "doca.db");
  const main = await openDatabase({ driver: "sqlite", path: mainPath });
  const config = webhookDatabaseConfig({ driver: "sqlite", path: mainPath });
  const hooks = await openWebhookDatabase(config);
  try {
    expect(config).toMatchObject({ driver: "sqlite", path: join(directory, "webhooks.db") });
    const mainTables = (await main.introspection.getTables()).map((table) => table.name);
    const hookTables = (await hooks.introspection.getTables()).map((table) => table.name);
    expect(mainTables).not.toContain("webhook_endpoints");
    expect(hookTables).toContain("webhook_endpoints");
    expect(hookTables).not.toContain("users");
    await hooks
      .updateTable("webhook_meta")
      .set({ value: "webhooks-old" })
      .where("id", "=", "baseline")
      .execute();
  } finally {
    await hooks.destroy();
    await main.destroy();
  }
  await expect(openWebhookDatabase(config)).rejects.toThrow(/baseline/i);
  await rm(directory, { recursive: true, force: true });
});

it("accepts loopback and private webhook targets, and still rejects a bad URL", async () => {
  await expect(resolveWebhookAddress("http://127.0.0.1/hook")).resolves.toMatchObject({
    address: { address: "127.0.0.1" },
  });
  await expect(resolveWebhookAddress("http://10.1.1.1/hook")).resolves.toMatchObject({
    address: { address: "10.1.1.1" },
  });
  await expect(
    resolveWebhookAddress("http://localhost:8080/hook", async () => [
      { address: "127.0.0.1", family: 4 },
    ]),
  ).resolves.toMatchObject({ address: { address: "127.0.0.1" } });
  await expect(
    resolveWebhookAddress("https://internal.example/hook", async () => [
      { address: "10.0.0.8", family: 4 },
    ]),
  ).resolves.toMatchObject({ address: { address: "10.0.0.8" } });
  await expect(resolveWebhookAddress("ftp://10.1.1.1/hook")).rejects.toMatchObject({
    status: 400,
  });
});

it("posts matching events asynchronously and does not call the network from the business write", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const hooks = await openWebhookDatabase({ driver: "sqlite", path: ":memory:" });
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const post = async (input: (typeof posts)[number]) => {
    posts.push(input);
    return { status: input.url.endsWith("/fail") ? 500 : 200 };
  };
  const app = await createApp(db, {
    origin: "http://localhost",
    logging: false,
    webhookDatabase: hooks,
    webhookResolve: resolvePublic,
    webhookPost: post,
  });
  try {
    const owner = await createUser(
      db,
      { login: "hook-admin", displayName: "Hook Admin", password: "test-password-2026" },
      { bootstrap: true },
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost", origin: "http://localhost" },
      payload: { login: "hook-admin", password: "test-password-2026" },
    });
    const cookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const headers = { host: "localhost", cookie, origin: "http://localhost" };
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/webhooks", headers: { host: "localhost" } }))
        .statusCode,
    ).toBe(401);
    const member = await createUser(
      db,
      { login: "hook-member", displayName: "Member", password: "test-password-2026" },
      { actor: { ...owner, admin: 1 } },
    );
    const memberLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost", origin: "http://localhost" },
      payload: { login: "hook-member", password: "test-password-2026" },
    });
    const memberCookie = memberLogin.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/webhooks",
          headers: { host: "localhost", cookie: memberCookie, origin: "http://localhost" },
          payload: {
            name: "Nope",
            url: "https://hooks.example/nope",
            events: ["user.created"],
          },
        })
      ).statusCode,
    ).toBe(403);
    const local = await app.inject({
      method: "POST",
      url: "/api/v1/admin/webhooks",
      headers,
      payload: {
        name: "Local",
        url: "http://127.0.0.1/hook",
        events: ["user.created"],
      },
    });
    expect(local.statusCode, local.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/admin/webhooks/${local.json().id}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);

    await emitIntegrationEvent(db, "user.created", { userId: "old" });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/webhooks",
      headers,
      payload: {
        name: "Users",
        url: "https://hooks.example/users",
        events: ["user.created"],
        headers: [{ name: "Authorization", value: "Bearer service-token" }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().secret).toBeUndefined();
    const documents = await app.inject({
      method: "POST",
      url: "/api/v1/admin/webhooks",
      headers,
      payload: {
        name: "Docs",
        url: "https://hooks.example/fail",
        events: ["document.created"],
      },
    });
    expect(documents.statusCode, documents.body).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/webhooks",
      headers,
    });
    expect(listed.json().items.map((item: { name: string }) => item.name)).toEqual([
      "Users",
      "Docs",
    ]);
    expect(JSON.stringify(listed.json())).toContain("Bearer service-token");

    await dispatchWebhooks(db, hooks, { post });
    expect(posts).toEqual([]);

    await emitIntegrationEvent(db, "user.created", { userId: "new" });
    await emitIntegrationEvent(db, "document.created", { resourceId: "doc" });
    expect(posts).toEqual([]);
    await dispatchWebhooks(db, hooks, { post });
    expect(posts.map((item) => item.url).sort()).toEqual([
      "https://hooks.example/fail",
      "https://hooks.example/users",
    ]);
    const userCall = posts.find((item) => item.url.endsWith("/users"))!;
    const payload = JSON.parse(userCall.body) as { type: string; data: { userId: string } };
    expect(payload.type).toBe("user.created");
    expect(payload.data.userId).toBe("new");
    expect(userCall.headers.authorization ?? userCall.headers.Authorization).toBe(
      "Bearer service-token",
    );
    expect(userCall.headers["x-doca-signature"]).toBeUndefined();
    expect(userCall.headers["content-type"]).toBe("application/json");

    await hooks
      .updateTable("webhook_deliveries")
      .set({ available_at: new Date(0).toISOString() })
      .where("status", "=", "pending")
      .execute();
    const before = posts.length;
    await dispatchWebhooks(db, hooks, { post });
    expect(posts.length).toBe(before + 1);
    for (let attempt = 2; attempt < webhookAttemptLimit; attempt++) {
      await hooks
        .updateTable("webhook_deliveries")
        .set({ available_at: new Date(0).toISOString() })
        .where("status", "=", "pending")
        .execute();
      await dispatchWebhooks(db, hooks, { post });
    }
    const failed = await hooks
      .selectFrom("webhook_deliveries")
      .select(["status", "attempts"])
      .where("event_type", "=", "document.created")
      .executeTakeFirstOrThrow();
    expect(failed).toMatchObject({ status: "failed", attempts: webhookAttemptLimit });
    const delivered = await hooks
      .selectFrom("webhook_deliveries")
      .select("status")
      .where("event_type", "=", "user.created")
      .executeTakeFirstOrThrow();
    expect(delivered.status).toBe("delivered");
    expect(member.id).toBeTruthy();
  } finally {
    await app.close();
    await hooks.destroy();
    await db.destroy();
  }
});

it("retries a failed delivery without treating the lease token as optional", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const hooks = await openWebhookDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const { createWebhookEndpoint } = await import(
      "@core/modules/automation/webhooks.js"
    );
    await createWebhookEndpoint(db, hooks, {
      name: "Retry",
      url: "https://hooks.example/retry",
      events: ["user.updated"],
    });
    await emitIntegrationEvent(db, "user.updated", { userId: "u" });
    let calls = 0;
    await dispatchWebhooks(db, hooks, {
      post: async () => {
        calls += 1;
        return { status: calls === 1 ? 503 : 204 };
      },
    });
    expect(calls).toBe(1);
    await hooks
      .updateTable("webhook_deliveries")
      .set({ available_at: new Date(0).toISOString() })
      .execute();
    await dispatchWebhooks(db, hooks, {
      post: async () => {
        calls += 1;
        return { status: 204 };
      },
    });
    const row = await hooks
      .selectFrom("webhook_deliveries")
      .select(["status", "attempts", "lease_token"])
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(2);
    expect(row.lease_token).toBeNull();
    const stale: Pick<ClaimedWebhook, "id" | "leaseToken" | "attempts"> = {
      id: "missing",
      leaseToken: "stale",
      attempts: 1,
    };
    expect(stale.leaseToken).toBe("stale");
  } finally {
    await hooks.destroy();
    await db.destroy();
  }
});
