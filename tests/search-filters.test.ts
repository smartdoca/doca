import { expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createApp } from "../apps/server/src/app/create-app.js";

it("combines owner, library, current-user visits and reactions in both Meilisearch and fallback search", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const actor = {
    ...(await createUser(
      db,
      {
        login: "filterqa",
        displayName: "Filter",
        password: "search-filter-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const other = {
    ...(await createUser(
      db,
      {
        login: "otherqa",
        displayName: "Other",
        password: "search-filter-password",
      },
      { actor },
    )),
    admin: 0,
  };
  const content = createContent(db);
  const library = await content.create(actor, {
    kind: "library",
    format: "rich_text",
    title: "测试知识库",
  });
  const recent = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "目标文档",
    libraryId: library.id,
  });
  const old = await content.create(actor, {
    kind: "document",
    format: "markdown",
    title: "历史文档",
  });
  const secret = await content.create(other, {
    kind: "document",
    format: "markdown",
    title: "私有文档",
  });
  for (const [user, document, days] of [
    [actor, recent, 2],
    [actor, old, 40],
    [other, old, 1],
  ] as const)
    await db
      .insertInto("resource_visits")
      .values({
        user_id: user.id,
        resource_id: document.id,
        visited_at: new Date(Date.now() - days * 86400000).toISOString(),
      })
      .execute();
  for (const [user, document, kind] of [
    [actor, recent, "like"],
    [actor, recent, "favorite"],
    [other, old, "like"],
  ] as const)
    await db
      .insertInto("reactions")
      .values({ user_id: user.id, resource_id: document.id, kind })
      .execute();
  let broken = false;
  const requests: any[] = [];
  await db
    .updateTable("search_settings")
    .set({ enabled: 1 })
    .where("id", "=", "system")
    .execute();
  const origin = "http://localhost:39130";
  const app = await createApp(db, {
    origin,
    search: {
      allowedOrigins: ["http://127.0.0.1:7700"],
      fetch: async (url, init) => {
        if (broken) return new Response("offline", { status: 503 });
        if (String(url).endsWith("/search")) {
          requests.push(JSON.parse(String(init?.body)));
          return Response.json({
            hits: [old, secret, recent].map((d) => ({ id: d.id })),
          });
        }
        if (String(url).endsWith("/documents"))
          return Response.json({ results: [], total: 0 });
        return Response.json({ status: "succeeded", taskUid: 1 });
      },
    },
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39130", origin },
      payload: { login: "filterqa", password: "search-filter-password" },
    });
    const headers = {
      host: "localhost:39130",
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    };
    const search = (params: string) =>
      app.inject({ url: "/api/v1/search/documents?q=文档&" + params, headers });
    const combined = `ownerIds=${actor.id}&libraryIds=${library.id}&visitedWithinDays=7&likedOnly=true&favoritesOnly=true`;
    const found = await search(combined);
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json().items.map((r: any) => r.id)).toEqual([recent.id]);
    expect(requests.at(-1).filter).toContain(recent.id);
    expect(requests.at(-1).filter).not.toContain(old.id);
    expect(requests.at(-1).filter).not.toContain(secret.id);
    expect((await search("visitedWithinDays=1")).json().total).toBe(0);
    expect(
      (await search("likedOnly=true")).json().items.map((r: any) => r.id),
    ).toEqual([recent.id]);
    for (const invalid of [
      "visitedWithinDays=0",
      "visitedWithinDays=3651",
      "visitedWithinDays=1.5",
      "likedOnly=invalid",
      "ownerIds=not-a-uuid",
    ])
      expect((await search(invalid)).statusCode).toBe(400);
    broken = true;
    const fallback = await search(combined);
    expect(fallback.json().engine).toBe("database");
    expect(fallback.json().items.map((r: any) => r.id)).toEqual([recent.id]);
    expect((await search(`ownerIds=${other.id}`)).json().total).toBe(0);
  } finally {
    await app.close();
    await db.destroy();
  }
});
