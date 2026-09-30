import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import { openTestDatabase } from "./database.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import {
  registerActivitySource,
  workspaceActivity,
  pluginActivityTarget,
} from "@core/modules/workspace/plugin-activity.js";
import { createContent } from "@core/workflows/resources.js";
import {
  activityServiceToken,
  type ActivityEntry,
  type ActivitySource,
} from "@smartdoca/plugin-sdk/platform";
import { definePlugin } from "@smartdoca/plugin-sdk";
import { runPluginContractHarness } from "@smartdoca/plugin-sdk/testing";
import { scopeInstalledPlugin } from "@server/plugins/scope.js";

let db: DB;
const user = { id: randomUUID(), display_name: "Owner", admin: 0 };
const other = { id: randomUUID(), display_name: "Other", admin: 0 };
const stamp = "2026-01-01T00:00:00.000Z";
function entry(id: string, visitedAt = stamp): ActivityEntry {
  return { id, title: `Item ${id}`, visitedAt, path: `/mail/${id}` };
}
function source(
  id: string,
  rows: ActivityEntry[],
  visible: (id: string) => boolean = () => true,
): ActivitySource {
  const result: ActivitySource = {
    id: `example.${id}.items`,
    pluginId: `example.${id}`,
    schemaVersion: 1,
    resourceType: "item",
    title: { en: id, zh: id },
    icon: "mail",
    async list(context, { until, after, limit }) {
      if (context.principalId !== user.id) return { items: [], hasMore: false };
      const filtered = rows
        .filter(
          (row) =>
            visible(row.id) &&
            row.visitedAt <= until &&
            (!after ||
              row.visitedAt < after.visitedAt ||
              (row.visitedAt === after.visitedAt && row.id > after.id)),
        )
        .sort((a, b) =>
          a.visitedAt > b.visitedAt
            ? -1
            : a.visitedAt < b.visitedAt
              ? 1
              : a.id < b.id
                ? -1
                : a.id > b.id
                  ? 1
                  : 0,
        );
      return {
        items: filtered.slice(0, limit),
        hasMore: filtered.length > limit,
      };
    },
    async get(context, id) {
      return context.principalId === user.id
        ? (rows.find((row) => row.id === id && visible(id)) ?? null)
        : null;
    },
  };
  pluginServices(db).permissions.set(`${result.pluginId}.item`, {
    pluginId: result.pluginId,
    resourceType: "item",
    async authorize(principal, id, action) {
      return principal === user.id && visible(id) && action === "activity.read";
    },
  });
  return result;
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  for (const u of [user, other])
    await db
      .insertInto("users")
      .values({
        ...u,
        login: u.id,
        password_hash: "",
        status: "active",
        created_at: stamp,
      })
      .execute();
});
afterEach(() => db.destroy());

it("merges interleaved sources and existing documents across tied timestamps without duplicates or omissions", async () => {
  const a = Array.from({ length: 80 }, (_, i) =>
    entry(
      String(i).padStart(3, "0"),
      i % 2 ? stamp : "2026-01-02T00:00:00.000Z",
    ),
  );
  const b = Array.from({ length: 75 }, (_, i) =>
    entry(
      String(i).padStart(3, "0"),
      i % 3 ? stamp : "2026-01-03T00:00:00.000Z",
    ),
  );
  registerActivitySource(db, source("a", a));
  registerActivitySource(db, source("b", b));
  const content = createContent(db);
  const doc = await content.create(user, {
    kind: "document",
    format: "markdown",
    title: "Existing document",
  });
  await content.visit(user, doc.id);
  await db.updateTable("resource_visits").set({ visited_at: stamp }).execute();
  const actual: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 10; count++) {
    const page = await workspaceActivity(db, user, { cursor });
    expect(page.unavailableSources).toEqual([]);
    actual.push(
      ...page.items.map((i) =>
        i.kind === "plugin"
          ? `${i.sourceId}:${i.id}`
          : `doca:${i.kind}:${i.id}`,
      ),
    );
    if (!page.nextCursor) break;
    expect(page.items).toHaveLength(50);
    cursor = page.nextCursor;
  }
  const expected = [
    ...a.map((i) => ({ key: `example.a.items:${i.id}`, time: i.visitedAt })),
    ...b.map((i) => ({ key: `example.b.items:${i.id}`, time: i.visitedAt })),
    { key: `doca:document:${doc.id}`, time: stamp },
  ]
    .sort((a, b) =>
      a.time > b.time ? -1 : a.time < b.time ? 1 : a.key < b.key ? -1 : 1,
    )
    .map((i) => i.key);
  expect(actual).toEqual(expected);
  expect(
    (await workspaceActivity(db, user, { kind: "document" })).items.map(
      (i) => i.id,
    ),
  ).toEqual([doc.id]);
  expect(
    (
      await workspaceActivity(db, user, { source: "example.a.items" })
    ).items.every(
      (i) => i.kind === "plugin" && i.sourceId === "example.a.items",
    ),
  ).toBe(true);
});

it("refills short provider pages and permission-filtered batches", async () => {
  const rows = Array.from({ length: 65 }, (_, i) =>
    entry(String(i).padStart(3, "0")),
  );
  const s = source("short", rows);
  const list = s.list;
  s.list = (ctx, input) =>
    list(ctx, { ...input, limit: Math.min(input.limit, 7) });
  pluginServices(db).permissions.get("example.short.item")!.authorize = async (
    _user,
    id,
  ) => Number(id) >= 10;
  registerActivitySource(db, s);
  const first = await workspaceActivity(db, user);
  expect(first.items).toHaveLength(50);
  expect(first.items[0]?.id).toBe("010");
  const second = await workspaceActivity(db, user, {
    cursor: first.nextCursor!,
  });
  expect(second.items.map((i) => i.id)).toEqual([
    "060",
    "061",
    "062",
    "063",
    "064",
  ]);
  expect(second.nextCursor).toBeNull();
});

it("handles deletion, revoked permission, cross-user reads and source disposal without storing plugin visits", async () => {
  const rows = [entry("1"), entry("2")];
  let allowed = true;
  const s = source("mail", rows, () => allowed);
  const dispose = registerActivitySource(db, s);
  expect((await workspaceActivity(db, other)).items).toEqual([]);
  expect(await pluginActivityTarget(db, user, s.id, "1")).toBe("/mail/1");
  await expect(
    pluginActivityTarget(db, other, s.id, "1"),
  ).rejects.toMatchObject({ status: 404 });
  rows.shift();
  expect((await workspaceActivity(db, user)).items.map((i) => i.id)).toEqual([
    "2",
  ]);
  await expect(pluginActivityTarget(db, user, s.id, "1")).rejects.toMatchObject(
    { status: 404 },
  );
  allowed = false;
  expect((await workspaceActivity(db, user)).items).toEqual([]);
  await expect(pluginActivityTarget(db, user, s.id, "2")).rejects.toMatchObject(
    { status: 404 },
  );
  allowed = true;
  dispose();
  expect((await workspaceActivity(db, user)).sources).toEqual([]);
  await expect(pluginActivityTarget(db, user, s.id, "2")).rejects.toMatchObject(
    { status: 404 },
  );
  expect(
    await db.selectFrom("workspace_activity").selectAll().execute(),
  ).toEqual([]);
  expect(rows).toHaveLength(1);
});

it("isolates invalid, failing and timed-out sources, and retries only after refresh", async () => {
  registerActivitySource(
    db,
    source(
      "good",
      Array.from({ length: 55 }, (_, i) => entry(String(i).padStart(3, "0"))),
    ),
  );
  const broken = source("broken", []);
  broken.list = async () => {
    throw new Error("offline");
  };
  registerActivitySource(db, broken);
  const unordered = source("unordered", []);
  unordered.list = async () => ({
    items: [entry("z"), entry("a")],
    hasMore: false,
  });
  registerActivitySource(db, unordered);
  const unsafe = source("unsafe", [{ ...entry("1"), path: "//evil.test" }]);
  registerActivitySource(db, unsafe);
  let aborted = false;
  const slow = source("slow", []);
  slow.list = (ctx) =>
    new Promise(() =>
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      }),
    );
  const disposeSlow = registerActivitySource(db, slow);
  const page = await workspaceActivity(db, user);
  expect(page.items).toHaveLength(50);
  expect(page.unavailableSources.sort()).toEqual(
    [broken.id, slow.id, unordered.id, unsafe.id].sort(),
  );
  expect(aborted).toBe(true);
  disposeSlow();
  broken.list = async () => ({ items: [entry("1")], hasMore: false });
  const next = await workspaceActivity(db, user, { cursor: page.nextCursor! });
  expect(next.items).toHaveLength(5);
  expect(next.unavailableSources).toContain(broken.id);
  expect(
    (await workspaceActivity(db, user)).items.some(
      (i) => i.kind === "plugin" && i.sourceId === broken.id,
    ),
  ).toBe(true);
});

it("rejects wrong-user/filter cursors, malformed sources, missing authorizers and cancelled requests", async () => {
  const s = source(
    "valid",
    Array.from({ length: 55 }, (_, i) => entry(String(i).padStart(3, "0"))),
  );
  registerActivitySource(db, s);
  expect(() => registerActivitySource(db, s)).toThrow();
  expect(() =>
    registerActivitySource(db, { ...s, id: "another.source" }),
  ).toThrow();
  const page = await workspaceActivity(db, user);
  await expect(
    workspaceActivity(db, other, { cursor: page.nextCursor! }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    workspaceActivity(db, user, { cursor: page.nextCursor!, kind: "document" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    workspaceActivity(db, user, { cursor: "garbage" }),
  ).rejects.toMatchObject({ status: 400 });
  pluginServices(db).permissions.clear();
  expect((await workspaceActivity(db, user)).unavailableSources).toEqual([
    s.id,
  ]);
  await expect(
    pluginActivityTarget(db, user, s.id, "000"),
  ).rejects.toMatchObject({ status: 404 });
  const controller = new AbortController();
  controller.abort();
  await expect(
    workspaceActivity(db, user, { signal: controller.signal }),
  ).rejects.toThrow();
  const isolated = await openTestDatabase({
    driver: "sqlite",
    path: ":memory:",
  });
  try {
    expect(pluginServices(isolated).activities.size).toBe(0);
  } finally {
    await isolated.destroy();
  }
});

it("scopes SDK registrations to the injected plugin and cleans them up with the lifecycle", async () => {
  const s = source("scope", []);
  await runPluginContractHarness(
    scopeInstalledPlugin(
      definePlugin({
        manifest: {
          schemaVersion: 1,
          id: "example.scope",
          version: "1.0.0",
          displayName: "Activity",
        },
        injections: { required: [activityServiceToken] },
        async mount(context) {
          const service = context.inject(activityServiceToken);
          expect(() =>
            service.register({ ...s, pluginId: "other.plugin" }),
          ).toThrow("namespace");
          expect(() =>
            service.register({ ...s, id: "other.plugin.items" }),
          ).toThrow("namespace");
          service.register(s);
          expect(pluginServices(db).activities.has(s.id)).toBe(true);
        },
      }),
    ),
    {
      services: [
        {
          token: activityServiceToken,
          value: {
            register: (s: ActivitySource) => registerActivitySource(db, s),
          },
        },
      ],
    },
  );
  expect(pluginServices(db).activities.size).toBe(0);
});

it("loads an installed provider through the public service and serves authenticated activity and open routes", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("@server/app/create-app.js");
  const { createUser } = await import("@core/modules/identity/passwords.js");
  const root = await mkdtemp(join(tmpdir(), "doca-activity-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const pkg = join(root, "example.activity");
    await mkdir(pkg);
    const manifest = {
      schemaVersion: 1,
      id: "example.activity",
      version: "1.0.0",
      displayName: "Activity",
      sdkRange: "^0.1.0",
    };
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "example-activity",
        version: "1.0.0",
        type: "module",
        doca: {
          dataVersion: "1",
          manifest: "./manifest.json",
          server: "./server.js",
        },
      }),
    );
    await writeFile(join(pkg, "manifest.json"), JSON.stringify(manifest));
    await writeFile(
      join(pkg, "server.js"),
      `export default () => ({ manifest: ${JSON.stringify(manifest)}, injections: {required:[{id:'activity.v1'},{id:'permissions.v1'}]}, mount(ctx) {
      ctx.inject({id:'permissions.v1'}).register({pluginId:'example.activity',resourceType:'message',async authorize(user,id,action){return user===id && action==='activity.read'}});
      const make = id => ({id,title:'Plugin-owned message',visitedAt:'2026-01-01T00:00:00.000Z',path:'/mail/'+id});
      ctx.inject({id:'activity.v1'}).register({id:'example.activity.messages',pluginId:'example.activity',schemaVersion:1,resourceType:'message',title:{en:'Mail',zh:'邮件'},icon:'mail',async list(ctx,input){return {items:input.after?[]:[make(ctx.principalId)],hasMore:false}},async get(ctx,id){return id===ctx.principalId?make(id):null}});
    }});`,
    );
    const account = await createUser(
      db,
      {
        login: "activity-http",
        displayName: "HTTP",
        password: "test-password-2026",
      },
      { bootstrap: true },
    );
    const origin = "http://localhost:39133";
    app = await createApp(db, { origin, pluginDirectory: root });
    const headers = { host: "localhost:39133", origin };
    expect(
      (await app.inject({ url: "/api/v1/workspace/activity", headers }))
        .statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers,
      payload: { login: "activity-http", password: "test-password-2026" },
    });
    expect(login.statusCode, login.body).toBe(200);
    const authenticated = {
      ...headers,
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    };
    const response = await app.inject({
      url: "/api/v1/workspace/activity",
      headers: authenticated,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          id: account.id,
          kind: "plugin",
          title: "Plugin-owned message",
          sourceId: "example.activity.messages",
          icon: "mail",
        },
      ],
      nextCursor: null,
      unavailableSources: [],
    });
    const open = await app.inject({
      url: response.json().items[0].href,
      headers: authenticated,
    });
    expect(open.statusCode, open.body).toBe(303);
    expect(open.headers.location).toBe(`/#/mail/${account.id}`);
    expect(
      (
        await app.inject({
          url: "/api/v1/workspace/activity/open?source=example.activity.messages&id=other",
          headers: authenticated,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/workspace/activity?kind=plugin",
          headers: authenticated,
        })
      ).statusCode,
    ).toBe(400);
    // Public discovery still contains only supported collectable core resource types.
    expect(
      (
        await app.inject({
          url: "/api/v1/workspace/recent?publicOnly=true",
          headers: authenticated,
        })
      ).json().items,
    ).toEqual([]);
    await app.close();
    app = undefined;
    expect(pluginServices(db).activities.size).toBe(0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps builtin keyset paging stable when records disappear between pages", async () => {
  const content = createContent(db);
  const docs = [];
  for (let i = 0; i < 57; i++) {
    const doc = await content.create(user, {
      kind: "document",
      format: "markdown",
      title: `Document ${i}`,
    });
    await content.visit(user, doc.id);
    docs.push(doc.id);
  }
  await db.updateTable("resource_visits").set({ visited_at: stamp }).execute();
  const first = await workspaceActivity(db, user);
  expect(first.items).toHaveLength(50);
  // Removing the boundary record must not shift the next page or require a lookup of it.
  await db
    .deleteFrom("resource_visits")
    .where("resource_id", "=", first.items[49]!.id)
    .execute();
  const second = await workspaceActivity(db, user, {
    cursor: first.nextCursor!,
  });
  expect(second.items).toHaveLength(7);
  expect([...first.items, ...second.items].map((i) => i.id)).toEqual(
    docs.sort(),
  );
  expect(second.nextCursor).toBeNull();
});

it("discards a source stopped while another source is still being queried", async () => {
  const quick = source("quick", [entry("1")]);
  const dispose = registerActivitySource(db, quick);
  const slow = source("wait", []);
  slow.list = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    dispose();
    return { items: [], hasMore: false };
  };
  registerActivitySource(db, slow);
  const page = await workspaceActivity(db, user);
  expect(page.items).toEqual([]);
  expect(page.unavailableSources).toContain(quick.id);
});
