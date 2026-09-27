import { openTestDatabase as openDatabase } from "./database.js";
import { it, expect } from "vitest";
import {} from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createApp } from "../apps/server/src/app/create-app.js";

it("configures Meilisearch only as admin, indexes documents, filters stale/private hits and falls back safely", async () => {
  const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  const admin: Actor = {
    ...(await createUser(
      db,
      {
        login: "admin",
        displayName: "Admin",
        password: "search-test-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const alice: Actor = {
    ...(await createUser(
      db,
      {
        login: "alice",
        displayName: "Alice",
        password: "search-test-password",
      },
      { actor: admin },
    )),
    admin: 0,
  };
  const content = createContent(db);
  const own = await content.create(alice, {
    kind: "document",
    format: "rich_text",
    title: "搜索测试",
  });
  const secret = await content.create(admin, {
    kind: "document",
    format: "rich_text",
    title: "搜索测试机密",
  });
  const library = await content.create(alice, {
    kind: "library",
    format: "rich_text",
    title: "搜索测试知识库",
  });
  const calls: { path: string; body: any }[] = [];
  let broken = false;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, body });
    if (broken) return new Response("down", { status: 503 });
    if (url.pathname.endsWith("/search"))
      return Response.json({
        hits: [
          { id: secret.id, title: "MUST NOT LEAK" },
          { id: own.id },
          { id: library.id },
        ],
        estimatedTotalHits: 999999,
      });
    if (url.pathname.startsWith("/tasks/"))
      return Response.json({ status: "succeeded" });
    if (init?.method === "PATCH" || init?.method === "POST")
      return Response.json({ taskUid: 1 });
    return Response.json({ status: "available" });
  };
  const origin = "http://localhost:39130";
  const app = await createApp(db, {
    origin,
    search: {
      allowedOrigins: ["http://127.0.0.1:7700"],
      apiKey: "server-only-secret",
      fetch: mockFetch,
    },
  });
  const login = async (name: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39130", origin },
      payload: { login: name, password: "search-test-password" },
    });
    return String(r.headers["set-cookie"]).split(";")[0]!;
  };
  try {
    const adminHeaders = {
      host: "localhost:39130",
      origin,
      cookie: await login("admin"),
    };
    const aliceHeaders = {
      host: "localhost:39130",
      origin,
      cookie: await login("alice"),
    };
    const search = () =>
      app.inject({
        url: "/api/v1/search/documents?q=搜索",
        headers: aliceHeaders,
      });
    const before = await search();
    expect(before.json().engine).toBe("database");
    expect(before.json().total).toBe(1);
    expect(
      (await app.inject({ url: "/api/v1/admin/search", headers: aliceHeaders }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/search",
          headers: adminHeaders,
          payload: {
            enabled: true,
            endpoint: "http://169.254.169.254",
            indexName: "doca",
            imageRecognitionEnabled: false,
            reconcileIntervalHours: 6,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/search",
          headers: adminHeaders,
          payload: {
            enabled: true,
            endpoint: "http://127.0.0.1:7700",
            indexName: "doca",
            imageRecognitionEnabled: false,
            reconcileIntervalHours: 6,
          },
        })
      ).statusCode,
    ).toBe(200);
    for (let i = 0; i < 100; i++) {
      const s = await app.inject({
        url: "/api/v1/admin/search",
        headers: adminHeaders,
      });
      expect(s.body).not.toContain("server-only-secret");
      if (!s.json().indexing) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      calls.some(
        (c) =>
          c.path === "/indexes/doca/documents" &&
          c.body.some((d: any) => d.id === own.id),
      ),
    ).toBe(true);
    const indexed = await search();
    expect(indexed.json()).toMatchObject({ engine: "meilisearch", total: 1 });
    expect(indexed.body).not.toContain(secret.id);
    expect(indexed.body).not.toContain(library.id);
    expect(indexed.body).not.toContain("MUST NOT LEAK");
    const settings = () =>
      app.inject({ url: "/api/v1/admin/search", headers: adminHeaders });
    expect((await settings()).json()).toMatchObject({
      image_recognition_enabled: false,
      imageRecognitionAvailable: false,
      reconcile_interval_hours: 6,
    });
    // Background projection updates may continue; a full rebuild reconfigures indexes.
    const writesBefore = calls.filter((c) =>
      c.path.endsWith("/settings"),
    ).length;
    const preferences = {
      enabled: true,
      endpoint: "http://127.0.0.1:7700",
      indexName: "doca",
      imageRecognitionEnabled: true,
      reconcileIntervalHours: 12,
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/search",
          headers: aliceHeaders,
          payload: preferences,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/search",
          headers: adminHeaders,
          payload: preferences,
        })
      ).statusCode,
    ).toBe(200);
    expect((await settings()).json()).toMatchObject({
      image_recognition_enabled: true,
      image_policy_version: 2,
      reconcile_interval_hours: 12,
      indexing: false,
    });
    expect(calls.filter((c) => c.path.endsWith("/settings")).length).toBe(
      writesBefore,
    );
    expect(
      await db
        .selectFrom("search_settings")
        .selectAll()
        .where("id", "=", "system")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      image_recognition_enabled: 1,
      reconcile_interval_hours: 12,
    });
    for (const reconcileIntervalHours of [0, 169, 1.5])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/admin/search",
            headers: adminHeaders,
            payload: { ...preferences, reconcileIntervalHours },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/search/reconcile",
          headers: aliceHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/search/reconcile",
          headers: adminHeaders,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/search",
          headers: adminHeaders,
          payload: { ...preferences, imageRecognitionEnabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect((await settings()).json()).toMatchObject({
      image_recognition_enabled: false,
      image_policy_version: 3,
    });
    broken = true;
    const fallback = await search();
    expect(fallback.json()).toMatchObject({ engine: "database", total: 1 });
    expect(fallback.json().notice).toBeTruthy();
    expect(
      (await app.inject({ url: "/api/v1/admin/search", headers: adminHeaders }))
        .statusCode,
    ).toBe(200);
    await db.deleteFrom("search_reconciliation").execute();
    await db.deleteFrom("search_embedding_task").execute();
    expect(
      (await app.inject({ url: "/api/v1/admin/search", headers: adminHeaders }))
        .statusCode,
    ).toBe(200);
    // Cost controls remain editable even when the search service is down.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/search",
          headers: adminHeaders,
          payload: { ...preferences, imageRecognitionEnabled: false },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    await db.destroy();
  }
});
