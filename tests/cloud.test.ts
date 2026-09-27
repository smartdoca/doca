import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { storageDefaults } from "../apps/server/src/adapters/storage.js";
import { type DB, type Resource } from "@db/index.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  createUser,
  hashPassword,
  type Actor,
} from "@core/modules/identity/passwords.js";

const origin = "http://localhost:39130",
  password = "test-only-password-2026";
let db: DB, app: Awaited<ReturnType<typeof createApp>>, directory: string;
let alice: string,
  bob: string,
  adminCookie: string,
  aliceId: string,
  bobId: string;
async function request(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  cookie = "",
  payload?: object,
) {
  return app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host: "localhost:39130", origin, cookie },
    ...(payload ? { payload } : {}),
  });
}
async function login(name: string) {
  const r = await request("POST", "/auth/login", "", { login: name, password });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers["set-cookie"]).split(";")[0]!;
}
async function create(
  cookie = alice,
  fields: Partial<{
    title: string;
    kind: string;
    format: string;
    libraryId: string;
    parentId: string;
  }> = {},
) {
  const r = await request("POST", "/resources", cookie, {
    title: "私有记录",
    kind: "document",
    format: "rich_text",
    ...fields,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<Resource>();
}
async function detail(id: string, cookie = alice) {
  const r = await request("GET", "/resources/" + id, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function acl(
  id: string,
  grants: { userId: string; role: string }[] = [],
  visibility = "invited",
  cookie = alice,
) {
  const d = await detail(id, cookie);
  const r = await request("PUT", `/resources/${id}/permissions`, cookie, {
    version: d.resource.version,
    accessMode: "custom",
    visibility,
    grants,
  });
  expect(r.statusCode, r.body).toBe(200);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "doca-test-"));
  db = await openDatabase({
    driver: "sqlite",
    path: join(directory, "test.db"),
  });
  const admin = await createUser(
    db,
    { login: "admin", displayName: "管理员", password },
    { bootstrap: true },
  );
  const actor: Actor = { ...admin, admin: 1 };
  aliceId = (
    await createUser(
      db,
      { login: "alice", displayName: "Alice", password },
      { actor },
    )
  ).id;
  bobId = (
    await createUser(
      db,
      { login: "bob", displayName: "Bob", password },
      { actor },
    )
  ).id;
  app = await createApp(db, {
    origin,
    storage: {
      root: join(directory, "uploads"),
      credentials: {},
      endpointHosts: [],
      cdnKeyPairId: undefined,
      cdnPrivateKey: undefined,
    },
  });
  adminCookie = await login("admin");
  alice = await login("alice");
  bob = await login("bob");
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("cloud baseline", () => {
  it("keeps private documents out of other users, administrator and anonymous views", async () => {
    const r = await create();
    for (const cookie of [bob, adminCookie, ""]) {
      expect(
        (await request("GET", "/resources/" + r.id, cookie)).statusCode,
      ).toBe(404);
    }
    const list = await request("GET", "/resources?scope=all&q=私有", bob);
    expect(list.json().total).toBe(0);
    expect((await detail(r.id)).resource.role).toBe("owner");
  });
  it("supports public/authenticated visibility without allowing anonymous mutations", async () => {
    const r = await create();
    await acl(r.id, [], "authenticated");
    expect((await detail(r.id, bob)).resource.role).toBe("reader");
    expect((await request("GET", "/resources/" + r.id)).statusCode).toBe(404);
    await acl(r.id, [], "public");
    expect((await detail(r.id, "")).resource.role).toBe("reader");
    expect(
      (
        await request("POST", `/resources/${r.id}/comments`, "", {
          richBody: {
            version: 1,
            blocks: [
              { type: "paragraph", children: [{ type: "text", text: "no" }] },
            ],
          },
          parentId: null,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await request("PATCH", "/resources/" + r.id, bob, {
          title: "no",
          version: 3,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("inherits library permissions, permits private overrides and masks private ancestors", async () => {
    const lib = await create(alice, { kind: "library", title: "机密知识库" });
    const parent = await create(alice, {
      libraryId: lib.id,
      title: "机密父节点",
    });
    const child = await create(alice, {
      parentId: parent.id,
      title: "单独分享",
    });
    await acl(lib.id, [{ userId: bobId, role: "editor" }]);
    expect((await detail(child.id, bob)).resource.role).toBe("editor");
    await acl(parent.id);
    expect(
      (await request("GET", "/resources/" + child.id, bob)).statusCode,
    ).toBe(404);
    await acl(child.id, [{ userId: bobId, role: "reader" }]);
    expect((await detail(child.id, bob)).resource.parent_id).toBeNull();
    await acl(lib.id);
    expect((await detail(child.id, bob)).resource.library_id).toBeNull();
    expect(
      (
        await request("PUT", `/me/entries/${child.id}`, bob, {
          state: "joined",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/resources?scope=all", bob))
        .json()
        .items.map((r: Resource) => r.id),
    ).toEqual([child.id]);
  });
  it("enforces metadata versions and owner-only transfer", async () => {
    const r = await create();
    await acl(r.id, [{ userId: bobId, role: "manager" }]);
    expect(
      (
        await request("PATCH", "/resources/" + r.id, alice, {
          title: "过期修改",
          version: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request("POST", `/resources/${r.id}/transfer`, bob, {
          userId: bobId,
          retainAccess: false,
          version: 2,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("POST", `/resources/${r.id}/transfer`, alice, {
          userId: bobId,
          retainAccess: false,
          version: 2,
        })
      ).statusCode,
    ).toBe(200);
    expect((await detail(r.id, bob)).resource.role).toBe("owner");
    expect((await request("GET", "/resources/" + r.id, alice)).statusCode).toBe(
      404,
    );
  });
  it("blocks directory cycles and preserves authorization when moving subtrees", async () => {
    const sourceLibrary = await create(alice, { kind: "library" }),
      parent = await create(alice, { libraryId: sourceLibrary.id }),
      child = await create(alice, { parentId: parent.id });
    expect(
      (
        await request("POST", `/resources/${parent.id}/move`, alice, {
          version: 1,
          parentId: child.id,
          libraryId: null,
        })
      ).statusCode,
    ).toBe(400);
    await acl(parent.id, [{ userId: bobId, role: "reader" }], "public");
    const lib = await create(alice, { kind: "library" });
    expect(
      (
        await request("POST", `/resources/${parent.id}/move`, alice, {
          version: 2,
          parentId: null,
          libraryId: lib.id,
        })
      ).statusCode,
    ).toBe(200);
    const moved = await detail(child.id);
    expect(moved.resource.library_id).toBe(lib.id);
    expect(moved.resource.visibility).toBe("requestable");
    expect(
      (await request("GET", "/resources/" + child.id, bob)).statusCode,
    ).toBe(200);
  });
  it("restores only the matching deletion batch and keeps older deletions in trash", async () => {
    const library = await create(alice, { kind: "library" }),
      parent = await create(alice, { libraryId: library.id }),
      old = await create(alice, { parentId: parent.id }),
      live = await create(alice, { parentId: parent.id });
    expect(
      (
        await request("POST", `/resources/${old.id}/trash`, alice, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("POST", `/resources/${parent.id}/trash`, alice, {
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/resources/" + live.id, alice)).statusCode,
    ).toBe(404);
    expect(
      (
        await request("POST", `/resources/${live.id}/restore`, alice, {
          version: 2,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request("POST", `/resources/${parent.id}/restore`, alice, {
          version: 2,
        })
      ).statusCode,
    ).toBe(200);
    await detail(live.id);
    expect(
      (await request("GET", "/resources/" + old.id, alice)).statusCode,
    ).toBe(404);
  });
  it("creates independent copies without ACLs or reactions", async () => {
    const lib = await create(alice, { kind: "library" }),
      child = await create(alice, { libraryId: lib.id });
    await acl(lib.id, [{ userId: bobId, role: "reader" }]);
    await request("PUT", `/resources/${child.id}/reaction`, bob, {
      kind: "favorite",
      enabled: true,
    });
    const copy = await request("POST", `/resources/${lib.id}/copy`, bob);
    expect(copy.statusCode, copy.body).toBe(200);
    const d = await detail(copy.json().id, bob);
    expect(d.resource.owner_id).toBe(bobId);
    expect(d.grants).toEqual([]);
    expect(
      (await request("GET", "/resources/" + d.resource.id, alice)).statusCode,
    ).toBe(404);
    const list = (
      await request("GET", `/resources?libraryId=${d.resource.id}`, bob)
    ).json();
    expect(list.total).toBe(1);
    expect(list.items[0].id).not.toBe(child.id);
    expect((await detail(list.items[0].id, bob)).favorite).toBe(false);
  });
  it("handles comments, idempotent reactions, and user-scoped notification reads", async () => {
    const r = await create();
    await acl(r.id, [{ userId: bobId, role: "commenter" }]);
    const comment = await request("POST", `/resources/${r.id}/comments`, bob, {
      richBody: {
        version: 1,
        blocks: [
          { type: "paragraph", children: [{ type: "text", text: "有帮助" }] },
        ],
      },
      parentId: null,
    });
    expect(comment.statusCode, comment.body).toBe(200);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request("PUT", `/resources/${r.id}/reaction`, bob, {
            kind: "like",
            enabled: true,
          })
        ).statusCode,
      ).toBe(200);
    expect((await detail(r.id)).likes).toBe(1);
    const comments = (await detail(r.id)).comments;
    expect(
      (
        await request(
          "PATCH",
          `/resources/${r.id}/comments/${comments[0].id}`,
          alice,
          {
            version: 1,
            richBody: {
              version: 1,
              blocks: [
                {
                  type: "paragraph",
                  children: [{ type: "text", text: "替别人改" }],
                },
              ],
            },
          },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          "PATCH",
          `/resources/${r.id}/comments/${comments[0].id}`,
          bob,
          {
            version: 1,
            richBody: {
              version: 1,
              blocks: [
                {
                  type: "paragraph",
                  children: [{ type: "text", text: "更新" }],
                },
              ],
            },
          },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          "PATCH",
          `/resources/${r.id}/comments/${comments[0].id}`,
          bob,
          { version: 1, deleted: true },
        )
      ).statusCode,
    ).toBe(409);
    const notices = (await request("GET", "/notifications", alice)).json();
    expect(notices.unread).toBe(2);
    await request("POST", "/notifications/read", bob, {
      ids: notices.items.map((n: { id: string }) => n.id),
    });
    expect((await request("GET", "/notifications", alice)).json().unread).toBe(
      2,
    );
    await request("POST", "/notifications/read", alice, {
      ids: notices.items.map((n: { id: string }) => n.id),
    });
    expect((await request("GET", "/notifications", alice)).json().unread).toBe(
      0,
    );
  });
  it("checks host, origin, schemas and closed registration", async () => {
    expect(
      (await app.inject({ url: "/health", headers: { host: "evil.example" } }))
        .statusCode,
    ).toBe(421);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/logout",
          headers: {
            host: "localhost:39130",
            origin: "http://evil.example",
            cookie: alice,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("POST", "/resources", alice, {
          title: "x",
          kind: "document",
          format: "rich_text",
          owner_id: bobId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("POST", "/auth/register", "", {
          login: "newuser",
          password,
          displayName: "新用户",
        })
      ).statusCode,
    ).toBe(403);
    expect((await request("GET", "/admin/users", bob)).statusCode).toBe(403);
    const settings = (
      await request("GET", "/admin/settings", adminCookie)
    ).json();
    expect(
      (
        await request("PUT", "/admin/settings", adminCookie, {
          revision: settings.revision,
          siteName: "Test",
          registrationEnabled: true,
          defaultLocale: settings.default_locale,
          defaultTimezone: settings.default_timezone,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("POST", "/auth/register", "", {
          login: "newuser",
          password,
          displayName: "新用户",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("PATCH", "/admin/users/" + bobId, adminCookie, {
          status: "disabled",
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", "/resources", bob)).statusCode).toBe(401);
  });
  it("validates and persists site defaults with admin and revision protection", async () => {
    const initial = (
      await request("GET", "/admin/settings", adminCookie)
    ).json();
    expect(initial).toMatchObject({
      default_locale: "zh",
      default_timezone: "Asia/Shanghai",
    });
    const payload = {
      revision: initial.revision,
      siteName: "Site",
      registrationEnabled: false,
      defaultLocale: "en",
      defaultTimezone: "America/Los_Angeles",
    };
    expect(
      (await request("PUT", "/admin/settings", bob, payload)).statusCode,
    ).toBe(403);
    expect(
      (
        await request("PUT", "/admin/settings", adminCookie, {
          ...payload,
          defaultTimezone: "Invalid/Zone",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("PUT", "/admin/settings", adminCookie, {
          ...payload,
          defaultLocale: "invalid",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await request("PUT", "/admin/settings", adminCookie, payload))
        .statusCode,
    ).toBe(200);
    expect((await request("GET", "/bootstrap")).json()).toMatchObject({
      defaultLocale: "en",
      defaultTimezone: "America/Los_Angeles",
    });
    expect(
      (await request("PUT", "/admin/settings", adminCookie, payload))
        .statusCode,
    ).toBe(409);
  });
  it("allows an existing short test password without weakening new password rules", async () => {
    await db
      .updateTable("users")
      .set({ password_hash: await hashPassword("admin") })
      .where("id", "=", aliceId)
      .execute();
    const r = await request("POST", "/auth/login", "", {
      login: "alice",
      password: "admin",
    });
    expect(r.statusCode).toBe(200);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    expect(
      (await request("POST", "/auth/reauth", cookie, { password: "admin" }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await request("POST", "/auth/password", cookie, {
          newPassword: "short",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("POST", "/auth/password", cookie, {
          newPassword: password + "-changed",
        })
      ).statusCode,
    ).toBe(200);
  });
  it("revokes sessions on password changes and logout", async () => {
    expect(
      (await request("POST", "/auth/reauth", alice, { password })).statusCode,
    ).toBe(200);
    expect(
      (
        await request("POST", "/auth/password", alice, {
          newPassword: password + "-new",
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", "/resources", alice)).statusCode).toBe(401);
    expect((await request("POST", "/auth/logout", bob)).statusCode).toBe(200);
    expect((await request("GET", "/resources", bob)).statusCode).toBe(401);
  });
  it("tracks actual visits per user and hides revoked resources from history", async () => {
    const first = await create(),
      second = await create(alice, { format: "spreadsheet" });
    expect(
      (await request("GET", "/resources?scope=recent", alice)).json().total,
    ).toBeNull();
    await request("POST", `/resources/${first.id}/visit`, alice);
    expect(
      (await request("GET", "/resources?scope=recent", alice))
        .json()
        .items.map((r: Resource) => r.id),
    ).toEqual([first.id]);
    expect(
      (await request("POST", `/resources/${first.id}/visit`, bob)).statusCode,
    ).toBe(404);
    await acl(first.id, [{ userId: bobId, role: "reader" }]);
    await request("POST", `/resources/${first.id}/visit`, bob);
    expect(
      (await request("GET", "/resources?scope=recent", bob)).json().items,
    ).toHaveLength(1);
    await acl(first.id);
    expect(
      (await request("GET", "/resources?scope=recent", bob)).json().items,
    ).toHaveLength(0);
    await db
      .updateTable("resources")
      .set({
        created_at: "2020-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
      })
      .where("id", "=", first.id)
      .execute();
    await db
      .updateTable("resources")
      .set({
        created_at: "2021-01-01T00:00:00.000Z",
        updated_at: "2021-01-01T00:00:00.000Z",
      })
      .where("id", "=", second.id)
      .execute();
    expect(
      (
        await request(
          "GET",
          "/resources?scope=owned&sort=created_at&order=desc",
          alice,
        )
      ).json().items[0].id,
    ).toBe(second.id);
    expect(
      (
        await request(
          "GET",
          "/resources?scope=owned&sort=updated_at&order=desc",
          alice,
        )
      ).json().items[0].id,
    ).toBe(first.id);
    expect(
      (await request("GET", "/resources?scope=owned&format=spreadsheet", alice))
        .json()
        .items.map((r: Resource) => r.id),
    ).toEqual([second.id]);
    expect(
      (await request("GET", "/resources?sort=invalid", alice)).statusCode,
    ).toBe(400);
  });
  it("saves private profile/preferences with optimistic version checking", async () => {
    const initial = (await request("GET", "/me", alice)).json();
    expect(initial.preferences.version).toBe(0);
    expect(
      (
        await request("PUT", "/me/profile", alice, {
          version: 0,
          displayName: "Alice 新昵称",
          avatar: "dragon",
        })
      ).statusCode,
    ).toBe(200);
    const me = (await request("GET", "/me", alice)).json();
    expect(me.user.display_name).toBe("Alice 新昵称");
    expect(me.preferences.avatar).toBe("dragon");
    expect(
      (
        await request("PUT", "/me/preferences", alice, {
          version: 0,
          theme: "soft",
          density: "compact",
          defaultSort: "created_at",
          sortOrder: "asc",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request("PUT", "/me/preferences", alice, {
          version: 1,
          theme: "soft",
          density: "compact",
          defaultSort: "created_at",
          sortOrder: "asc",
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", "/me", bob)).json().preferences.theme).toBe(
      "light",
    );
    expect(
      (await request("GET", "/me", alice)).json().preferences.density,
    ).toBe("compact");
    expect(
      (
        await request("PUT", "/me/profile", alice, {
          version: 2,
          displayName: "wrong",
          avatar: "https://evil.example/a.png",
        })
      ).statusCode,
    ).toBe(400);
    expect((await request("GET", "/me", "")).statusCode).toBe(401);
  });
  it("reports admin-only stats and does not count HTTP heartbeats as online sockets", async () => {
    await create();
    await create(alice, { kind: "library" });
    expect((await request("GET", "/admin/stats", alice)).statusCode).toBe(403);
    expect(
      (await request("GET", "/admin/online-users", alice)).statusCode,
    ).toBe(403);
    expect(
      (await request("GET", "/admin/stats", adminCookie)).json(),
    ).toMatchObject({ documents: 1, libraries: 1, users: 3, online: 0 });
    expect(
      (await request("GET", "/admin/online-users", adminCookie)).json(),
    ).toEqual({ items: [], nextOffset: null });
    await request("POST", "/me/heartbeat", alice);
    expect(
      (await request("GET", "/admin/stats", adminCookie)).json().online,
    ).toBe(0);
    await request("POST", "/auth/logout", alice);
    expect(
      (await request("GET", "/admin/stats", adminCookie)).json().online,
    ).toBe(0);
  });
  it("persists data across restart and serves the actual OpenAPI contract", async () => {
    const r = await create();
    const spec = await app.inject({
      url: "/api/openapi.json",
      headers: { host: "localhost:39130" },
    });
    expect(spec.statusCode, spec.body).toBe(200);
    expect(
      spec.json().paths["/api/v1/resources/{id}/permissions"].put,
    ).toBeTruthy();
    expect(JSON.stringify(spec.json().paths)).not.toContain("/spaces");
    await app.close();
    await db.destroy();
    db = await openDatabase({
      driver: "sqlite",
      path: join(directory, "test.db"),
    });
    app = await createApp(db, { origin });
    expect((await detail(r.id)).resource.owner_id).toBe(aliceId);
  });
});

describe("uploads and storage", () => {
  const png = () =>
    sharp({
      create: { width: 32, height: 24, channels: 3, background: "#3370ff" },
    })
      .png()
      .toBuffer();
  const upload = (
    cookie: string,
    purpose: string,
    body: Buffer,
    resourceId?: string,
    filename = "test.png",
  ) =>
    app.inject({
      method: "POST",
      url:
        "/api/v1/assets?" +
        new URLSearchParams({
          purpose,
          filename,
          ...(resourceId ? { resourceId } : {}),
        }),
      headers: {
        host: "localhost:39130",
        origin,
        cookie,
        "content-type": "application/octet-stream",
      },
      payload: body,
    });
  it("sanitizes avatar images, protects drafts, and validates avatar ownership", async () => {
    const res = await upload(alice, "avatar", await png());
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id;
    const content = await request("GET", "/assets/" + id + "/content", alice);
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/webp");
    const download = await request(
      "GET",
      "/assets/" + id + "/content?download=1",
      alice,
    );
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect(
      (await request("GET", "/assets/" + id + "/content?download=1", bob))
        .statusCode,
    ).toBe(404);
    const meta = await sharp(content.rawPayload).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(
      (await request("GET", "/assets/" + id + "/content", bob)).statusCode,
    ).toBe(404);
    expect(
      (
        await request("PUT", "/me/profile", bob, {
          version: 0,
          displayName: "Bob",
          avatar: "initials",
          avatarAssetId: id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("PUT", "/me/profile", alice, {
          version: 0,
          displayName: "Alice",
          avatar: "initials",
          avatarAssetId: id,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/assets/" + id + "/content", bob)).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/assets/" + id + "/content")).statusCode,
    ).toBe(404);
    expect(
      (
        await request("PUT", "/me/profile", alice, {
          version: 1,
          displayName: "Alice",
          avatar: "initials",
          avatarAssetId: null,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/assets/" + id + "/content", bob)).statusCode,
    ).toBe(404);
  });
  it("rejects disguised images, unauthenticated and oversized uploads", async () => {
    expect((await upload("", "avatar", await png())).statusCode).toBe(401);
    expect(
      (await upload(alice, "avatar", Buffer.from('<svg onload="alert(1)"/>')))
        .statusCode,
    ).toBe(400);
    expect(
      (await upload(alice, "avatar", Buffer.alloc(6 * 1024 * 1024))).statusCode,
    ).toBe(400);
    expect(
      (await upload(alice, "attachment", Buffer.alloc(21 * 1024 * 1024)))
        .statusCode,
    ).toBe(413);
    expect((await upload(alice, "avatar", await png())).statusCode).toBe(201);
  });
  it("allows commenters to upload sanitized comment images, but not document attachments", async () => {
    const doc = await create();
    await acl(doc.id, [{ userId: bobId, role: "commenter" }]);
    const image = await upload(bob, "comment_image", await png(), doc.id);
    expect(image.statusCode, image.body).toBe(201);
    expect(
      (await upload(bob, "attachment", Buffer.from("text"), doc.id)).statusCode,
    ).toBe(403);
    const comment = await request(
      "POST",
      `/resources/${doc.id}/comments`,
      bob,
      {
        parentId: null,
        richBody: {
          version: 1,
          blocks: [{ type: "image", assetId: image.json().id }],
        },
      },
    );
    expect(comment.statusCode, comment.body).toBe(200);
    expect((await detail(doc.id)).comments[0].body_json).toContain(
      image.json().id,
    );
    await acl(doc.id, [{ userId: bobId, role: "reader" }]);
    expect(
      (await upload(bob, "comment_image", await png(), doc.id)).statusCode,
    ).toBe(403);
  });
  it("requires editor upload permissions and immediately follows document access changes", async () => {
    const doc = await create();
    expect(
      (await upload(bob, "attachment", Buffer.from("private"), doc.id))
        .statusCode,
    ).toBe(404);
    const res = await upload(
      alice,
      "attachment",
      Buffer.from("<html>not executable</html>"),
      doc.id,
      "../../hello.html",
    );
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id;
    expect(
      (await request("GET", "/assets/" + id + "/content", adminCookie))
        .statusCode,
    ).toBe(404);
    await acl(doc.id, [{ userId: bobId, role: "reader" }]);
    expect(
      (await upload(bob, "attachment", Buffer.from("test"), doc.id)).statusCode,
    ).toBe(403);
    const read = await request("GET", "/assets/" + id + "/content", bob);
    expect(read.statusCode).toBe(200);
    expect(read.headers["content-type"]).toBe("application/octet-stream");
    const svg = await upload(
      alice,
      "attachment",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"></svg>',
      ),
      doc.id,
      "icon.svg",
    );
    expect(svg.statusCode, svg.body).toBe(201);
    const painted = await request(
      "GET",
      "/assets/" + svg.json().id + "/content",
      bob,
    );
    expect(painted.statusCode).toBe(200);
    expect(painted.headers["content-type"]).toContain("image/svg+xml");
    expect(painted.headers["content-disposition"]).toContain("inline;");
    expect(painted.headers["content-security-policy"]).toContain("sandbox");
    expect(painted.headers["x-content-type-options"]).toBe("nosniff");
    expect(read.headers["content-disposition"]).toContain("attachment;");
    expect(read.headers["content-security-policy"]).toContain("sandbox");
    expect(
      (await request("GET", "/resources/" + doc.id + "/assets", bob)).json()
        .items,
    ).toHaveLength(2);
    await acl(doc.id);
    expect(
      (await request("GET", "/assets/" + id + "/content", bob)).statusCode,
    ).toBe(404);
  });
  it("trash preview requires management, purge revokes attachments without breaking copies", async () => {
    const doc = await create();
    const asset = (
      await upload(
        alice,
        "attachment",
        Buffer.from("preserve copied bytes"),
        doc.id,
        "note.txt",
      )
    ).json();
    await acl(doc.id, [{ userId: bobId, role: "reader" }]);
    const copy = (
      await request("POST", `/resources/${doc.id}/copy`, bob)
    ).json();
    const copiedAsset = (
      await request("GET", `/resources/${copy.id}/assets`, bob)
    ).json().items[0];
    const latest = (await request("GET", `/resources/${doc.id}`, alice)).json()
      .resource;
    expect(
      (
        await request("POST", `/resources/${doc.id}/trash`, alice, {
          version: latest.version,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", `/assets/${asset.id}/content`, alice)).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          "GET",
          `/assets/${asset.id}/content?trashPreview=1`,
          alice,
        )
      ).body,
    ).toBe("preserve copied bytes");
    expect(
      (await request("GET", `/assets/${asset.id}/content?trashPreview=1`, bob))
        .statusCode,
    ).toBe(403);
    expect(
      (await request("GET", `/assets/${asset.id}/content?trashPreview=1`))
        .statusCode,
    ).toBe(404);
    expect(
      (await request("GET", `/resources/${doc.id}/trash-preview`, bob))
        .statusCode,
    ).toBe(403);
    expect(
      (await request("GET", `/resources/${doc.id}/trash-preview`, alice))
        .statusCode,
    ).toBe(200);
    const targets = (await request("GET", "/resources?scope=trash", alice))
      .json()
      .items.map(({ id, version }: { id: string; version: number }) => ({
        id,
        version,
      }));
    expect(
      (await request("POST", "/trash/purge", bob, { targets })).statusCode,
    ).toBe(403);
    const purge = await request("POST", "/trash/purge", alice, { targets });
    expect(purge.statusCode, purge.body).toBe(200);
    expect(
      (
        await request(
          "GET",
          `/assets/${asset.id}/content?trashPreview=1`,
          alice,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await request("GET", `/assets/${copiedAsset.id}/content`, bob)).body,
    ).toBe("preserve copied bytes");
  });
  it("binds covers to their knowledge base and uses optimistic versions", async () => {
    const lib = await create(alice, { kind: "library" }),
      other = await create(alice, { kind: "library" });
    const uploaded = await upload(alice, "cover", await png(), lib.id);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const id = uploaded.json().id;
    expect(
      (
        await request("PUT", "/resources/" + other.id + "/cover", alice, {
          version: 1,
          assetId: id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("PUT", "/resources/" + lib.id + "/cover", alice, {
          version: 1,
          assetId: id,
        })
      ).statusCode,
    ).toBe(200);
    expect((await detail(lib.id)).resource.cover_asset_id).toBe(id);
    expect(
      (
        await request("PUT", "/resources/" + lib.id + "/cover", alice, {
          version: 1,
          assetId: null,
        })
      ).statusCode,
    ).toBe(409);
    await acl(lib.id, [], "public");
    expect(
      (await request("GET", "/assets/" + id + "/content")).statusCode,
    ).toBe(200);
    await acl(lib.id);
    expect(
      (await request("GET", "/assets/" + id + "/content")).statusCode,
    ).toBe(404);
  });
  it("keeps old uploads readable after switching profiles and restricts storage administration", async () => {
    const asset = (await upload(alice, "avatar", await png())).json();
    expect((await request("GET", "/admin/storage", alice)).statusCode).toBe(
      403,
    );
    const settings = (
      await request("GET", "/admin/storage", adminCookie)
    ).json();
    expect(settings.config.provider).toBe("local");
    expect(
      (
        await request("PUT", "/admin/storage", adminCookie, {
          expectedId: settings.id,
          config: { ...storageDefaults, provider: "s3", bucket: "doca-test" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("PUT", "/admin/storage", adminCookie, {
          expectedId: settings.id,
          config: storageDefaults,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("PUT", "/admin/storage", adminCookie, {
          expectedId: settings.id,
          config: storageDefaults,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await request("GET", "/assets/" + asset.id + "/content", alice))
        .statusCode,
    ).toBe(200);
    expect(
      await db.selectFrom("storage_profiles").selectAll().execute(),
    ).toHaveLength(2);
  });
  it("copies assets with independent authorization and preserves the bytes", async () => {
    const doc = await create();
    const id = (
      await upload(
        alice,
        "attachment",
        Buffer.from("keep me"),
        doc.id,
        "note.txt",
      )
    ).json().id;
    await acl(doc.id, [{ userId: bobId, role: "reader" }]);
    const copied = await request("POST", "/resources/" + doc.id + "/copy", bob);
    expect(copied.statusCode, copied.body).toBe(200);
    const list = (
      await request("GET", "/resources/" + copied.json().id + "/assets", bob)
    ).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).not.toBe(id);
    await acl(doc.id);
    expect(
      (await request("GET", "/assets/" + id + "/content", bob)).statusCode,
    ).toBe(404);
    expect(
      (await request("GET", "/assets/" + list.items[0].id + "/content", bob))
        .body,
    ).toBe("keep me");
  });
  it("home document filtering excludes visited and favorited knowledge bases before counting", async () => {
    const lib = await create(alice, { kind: "library" }),
      doc = await create(alice, { libraryId: lib.id });
    for (const r of [lib, doc]) {
      await request("POST", "/resources/" + r.id + "/visit", alice);
      expect(
        (
          await request("PUT", "/resources/" + r.id + "/reaction", alice, {
            kind: "favorite",
            enabled: true,
          })
        ).statusCode,
      ).toBe(200);
    }
    for (const scope of ["recent", "owned", "favorites"]) {
      const list = (
        await request("GET", "/resources?kind=document&scope=" + scope, alice)
      ).json();
      expect(list.total).toBe(scope === "recent" ? null : 1);
      expect(list.items[0].id).toBe(doc.id);
    }
  });
});

describe("document-only search", () => {
  it("returns only documents, including when the query is empty or matches a knowledge base title", async () => {
    const lib = await create(alice, { kind: "library", title: "项目知识" });
    const personal = await create(alice, { title: "项目记录" });
    const inside = await create(alice, {
      title: "项目计划",
      libraryId: lib.id,
    });
    for (const path of ["/search/documents", "/search/documents?q=项目"]) {
      const res = await request("GET", path, alice);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().total).toBe(2);
      expect(
        res
          .json()
          .items.map((r: Resource) => r.id)
          .sort(),
      ).toEqual([personal.id, inside.id].sort());
      expect(
        res.json().items.every((r: Resource) => r.kind === "document"),
      ).toBe(true);
    }
    expect(
      (await request("GET", "/search/documents?q=知识", alice)).json().total,
    ).toBe(0);
    expect(
      (await request("GET", "/resources?q=知识", alice)).json().total,
    ).toBe(0);
    expect((await request("GET", "/search/documents")).statusCode).toBe(401);
  });
  it("combines multi-library OR with ownership, favorites, recent visits and type filters using AND", async () => {
    const first = await create(alice, { kind: "library" }),
      second = await create(alice, { kind: "library" });
    const a = await create(alice, { libraryId: first.id, title: "工作文档" });
    const b = await create(alice, {
      libraryId: second.id,
      title: "工作表格",
      format: "spreadsheet",
    });
    await acl(first.id, [{ userId: bobId, role: "editor" }]);
    const other = await create(bob, { libraryId: first.id, title: "工作共享" });
    await request("PUT", "/resources/" + a.id + "/reaction", alice, {
      kind: "favorite",
      enabled: true,
    });
    await request("POST", "/resources/" + b.id + "/visit", alice);
    const base =
      "/search/documents?location=library&libraryIds=" +
      first.id +
      "&libraryIds=" +
      second.id;
    const all = await request("GET", base, alice);
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().total).toBe(3);
    const ids = async (suffix: string) => {
      const res = await request("GET", base + suffix, alice);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().items.map((r: Resource) => r.id);
    };
    expect((await ids("&scope=owned")).sort()).toEqual([a.id, b.id].sort());
    // Whole-library access is not a directly shared document.
    expect(await ids("&scope=shared")).toEqual([]);
    expect(await ids("&scope=favorites")).toEqual([a.id]);
    expect(await ids("&scope=recent")).toEqual([b.id]);
    expect(await ids("&format=spreadsheet&q=工作")).toEqual([b.id]);
    const one = await request(
      "GET",
      "/search/documents?libraryIds=" + second.id,
      alice,
    );
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().items[0].id).toBe(b.id);
  });
  it("distinguishes personal and library documents and rejects contradictory filters", async () => {
    const lib = await create(alice, { kind: "library" }),
      personal = await create(),
      inside = await create(alice, { libraryId: lib.id });
    expect(
      (await request("GET", "/search/documents?location=personal", alice))
        .json()
        .items.map((r: Resource) => r.id),
    ).toEqual([personal.id]);
    expect(
      (await request("GET", "/search/documents?location=library", alice))
        .json()
        .items.map((r: Resource) => r.id),
    ).toEqual([inside.id]);
    expect(
      (
        await request(
          "GET",
          "/search/documents?location=personal&libraryIds=" + lib.id,
          alice,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await request("GET", "/search/documents?libraryIds=bad-id", alice))
        .statusCode,
    ).toBe(400);
    expect(
      (await request("GET", "/search/documents?kind=library", alice))
        .statusCode,
    ).toBe(400);
  });
  it("does not expose inaccessible knowledge base membership or private children", async () => {
    const lib = await create(alice, { kind: "library" }),
      privateDoc = await create(alice, { libraryId: lib.id }),
      sharedDoc = await create(alice, { libraryId: lib.id });
    await acl(sharedDoc.id, [{ userId: bobId, role: "reader" }]);
    expect(
      (
        await request("PUT", `/me/entries/${sharedDoc.id}`, bob, {
          state: "joined",
        })
      ).statusCode,
    ).toBe(200);
    const all = (
      await request("GET", "/search/documents?location=library", bob)
    ).json();
    expect(all.items.map((r: Resource) => r.id)).toEqual([sharedDoc.id]);
    expect(all.items[0].libraryName).toBeNull();
    expect(all.items[0].library_id).toBeNull();
    expect(
      (await request("GET", "/search/documents?libraryIds=" + lib.id, bob))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          "GET",
          "/search/documents?libraryIds=" + lib.id,
          adminCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          "GET",
          "/search/documents?libraryIds=" + privateDoc.id,
          alice,
        )
      ).statusCode,
    ).toBe(400);
  });
});
