import { createUser } from "@core/modules/identity/passwords.js";
import { AppError } from "@core/shared/errors.js";
import { expect, it } from "vitest";
import {
  builtinNavigation,
  resolveNavigation,
  isAdminNavigationPath,
  supportedPlacements,
  type NavigationConfig,
  type NavigationEntry,
} from "../packages/web-plugin-registry/src/index.js";
import { registerNavigation } from "@server/routes/navigation.js";
import { openTestDatabase } from "./database.js";
import Fastify from "fastify";
import {
  pluginNavigationSchema,
  navigationConfigSchema,
} from "@server/plugins/navigation-schema.js";
it("uses one global layout, preserves admin boundaries and does not mutate published configuration during overflow", () => {
  const entries: NavigationEntry[] = Array.from({ length: 8 }, (_, i) => ({
    id: `example.p${i}`,
    pluginId: "example",
    title: { en: "Demo", zh: "示例" },
    icon: "mail",
    webPath: "/plugins/example/inbox",
    mobile: true,
    allowedSlots: ["web.more", "mobile.bottom", "mobile.more"],
    defaults: ["mobile.bottom"],
    order: i,
  }));
  const config: NavigationConfig = {
    schemaVersion: 1,
    layout: {
      placements: [
        { entryId: "doca.files", slot: "web.left", order: 1, hidden: true },
      ],
    },
  };
  const before = JSON.stringify(config);
  const user = resolveNavigation([...builtinNavigation, ...entries], config, {
    id: "u",
    admin: false,
  });
  expect(user.entries.some((e) => e.id === "doca.admin")).toBe(false);
  expect(
    user.layout.placements.filter((p) => p.slot === "mobile.bottom"),
  ).toHaveLength(4);
  expect(user.layout.placements.some((p) => p.slot === "mobile.more")).toBe(
    true,
  );
  expect(JSON.stringify(config)).toBe(before);
  expect(
    resolveNavigation(builtinNavigation, config, {
      id: "a",
      admin: true,
    }).layout.placements.some((p) => p.entryId === "doca.files"),
  ).toBe(false);
});
it("keeps drafts private and uses revision checks across service instances", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" }),
    app = Fastify();
  app.setErrorHandler((error, _req, reply) =>
    reply.code(error instanceof AppError ? error.status : 500).send({
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  const created = await createUser(
    db,
    {
      login: "nav-admin",
      displayName: "Admin",
      password: "test-navigation-123",
    },
    { bootstrap: true },
  );
  const actor = { id: created.id, display_name: "Admin", admin: 1 };
  registerNavigation(
    app,
    db,
    () => actor,
    () => actor,
    [],
  );
  try {
    const before = (
      await app.inject({ url: "/api/v1/admin/navigation" })
    ).json();
    const config = {
      schemaVersion: 1,
      layout: {
        placements: [
          { entryId: "doca.ai", slot: "web.left", order: 1, hidden: true },
          { entryId: "doca.home", slot: "web.leftMore", order: 2 },
        ],
      },
    };
    for (const placements of [
      [{ entryId: "doca.home", slot: "web.admin", order: 1 }],
      [{ entryId: "doca.admin.users", slot: "web.left", order: 1 }],
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/admin/navigation",
        payload: {
          revision: before.revision,
          action: "save",
          config: { schemaVersion: 1, layout: { placements } },
        },
      });
      expect(invalid.statusCode).toBe(400);
    }
    const multiple = await app.inject({
      method: "POST",
      url: "/api/v1/admin/navigation",
      payload: {
        revision: before.revision,
        action: "save",
        config: {
          rules: [],
        },
      },
    });
    expect(multiple.statusCode).toBe(400);
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/admin/navigation",
      payload: { revision: before.revision, action: "save", config },
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/navigation" }))
        .json()
        .layout.placements.some((p: any) => p.entryId === "doca.ai"),
    ).toBe(true);
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/admin/navigation",
      payload: { revision: saved.json().revision, action: "publish", config },
    });
    expect(published.statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/navigation" }))
        .json()
        .layout.placements.some((p: any) => p.entryId === "doca.ai"),
    ).toBe(false);
    expect(
      (await app.inject({ url: "/api/v1/navigation" }))
        .json()
        .layout.placements.filter((p: any) => p.entryId === "doca.home")
        .map((p: any) => p.slot),
    ).toEqual(["web.leftMore"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/navigation",
          payload: { revision: before.revision, action: "publish", config },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
    await db.destroy();
  }
});

it("treats an admin plugin path as an admin page", () => {
  const admin: NavigationEntry = {
    id: "doca.mail.admin",
    pluginId: "doca.mail",
    title: { en: "Mail administration", zh: "邮箱管理" },
    icon: "mail",
    webPath: "/plugins/doca.mail/admin",
    allowedSlots: ["web.admin"],
    defaults: ["web.admin"],
    order: 71,
    adminOnly: true,
  };
  const inbox: NavigationEntry = {
    ...admin,
    id: "doca.mail.inbox",
    webPath: "/plugins/doca.mail/inbox",
    allowedSlots: ["web.left"],
    defaults: ["web.left"],
    adminOnly: false,
  };
  expect(
    isAdminNavigationPath([admin, inbox], "/plugins/doca.mail/admin"),
  ).toBe(true);
  expect(
    isAdminNavigationPath([admin, inbox], "/plugins/doca.mail/inbox"),
  ).toBe(false);
});

it("drops a placement the current entry no longer allows", () => {
  const admin: NavigationEntry = {
    id: "doca.mail.admin",
    pluginId: "doca.mail",
    title: { en: "Mail administration", zh: "邮箱管理" },
    icon: "mail",
    webPath: "/plugins/doca.mail/admin",
    allowedSlots: ["web.admin"],
    defaults: ["web.admin"],
    order: 71,
    adminOnly: true,
  };
  expect(
    supportedPlacements(
      [admin],
      [
        {
          entryId: "doca.mail.admin",
          slot: "web.user",
          order: 71,
          hidden: true,
        },
        { entryId: "doca.mail.inbox", slot: "web.topRight", order: 70 },
      ],
    ),
  ).toEqual([{ entryId: "doca.mail.inbox", slot: "web.topRight", order: 70 }]);
});

it("uses More only when no visible placement exists on the same platform", () => {
  const entry: NavigationEntry = {
    id: "example.mail",
    pluginId: "example.mail",
    title: { en: "Mail", zh: "邮箱" },
    icon: "mail",
    webPath: "/mail",
    mobile: true,
    allowedSlots: ["web.left", "web.more", "mobile.more"],
    defaults: ["web.left"],
    order: 1,
  };
  const resolve = (config: NavigationConfig) =>
    resolveNavigation([entry], config, { id: "u", admin: false }).layout
      .placements;
  expect(resolve({ schemaVersion: 1, layout: { placements: [] } })).toEqual([
    { entryId: entry.id, slot: "web.left", order: 1 },
    { entryId: entry.id, slot: "mobile.more", order: 1 },
  ]);
  const configured = resolve({
    schemaVersion: 1,
    layout: {
      placements: [
        { entryId: entry.id, slot: "web.left", order: 1 },
        { entryId: entry.id, slot: "web.more", order: 2 },
      ],
    },
  });
  expect(configured.some((p) => p.slot === "web.more")).toBe(false);
  const fallback = resolve({
    schemaVersion: 1,
    layout: {
      placements: [
        { entryId: entry.id, slot: "web.left", order: 1, hidden: true },
      ],
    },
  });
  expect(fallback.some((p) => p.slot === "web.more")).toBe(true);
});

it("keeps sidebar More opt-in and independently configures both More surfaces", () => {
  const entry: NavigationEntry = {
    id: "example.tools.home",
    pluginId: "example.tools",
    title: { en: "Tools", zh: "工具" },
    icon: "menu",
    webPath: "/plugins/example.tools/home",
    allowedSlots: ["web.left", "web.more", "web.leftMore"],
    defaults: ["web.more"],
    order: 1,
  };
  const resolve = (placements: NavigationConfig["layout"]["placements"]) =>
    resolveNavigation(
      [entry],
      { schemaVersion: 1, layout: { placements } },
      { id: "u", admin: false },
    ).layout.placements;
  expect(resolve([]).map((p) => p.slot)).toEqual(["web.more"]);
  expect(
    resolve([{ entryId: entry.id, slot: "web.leftMore", order: 1 }]).map(
      (p) => p.slot,
    ),
  ).toEqual(["web.leftMore"]);
  expect(
    resolve([
      { entryId: entry.id, slot: "web.more", order: 1 },
      { entryId: entry.id, slot: "web.leftMore", order: 2 },
    ]).map((p) => p.slot),
  ).toEqual(["web.more", "web.leftMore"]);
  // An old plugin does not acquire new placement permissions from the host.
  expect(
    resolveNavigation(
      [{ ...entry, allowedSlots: ["web.more"] }],
      {
        schemaVersion: 1,
        layout: {
          placements: [{ entryId: entry.id, slot: "web.leftMore", order: 1 }],
        },
      },
      { id: "u", admin: false },
    ).layout.placements.map((p) => p.slot),
  ).toEqual(["web.more"]);
  const { pluginId, ...manifestEntry } = entry;
  expect(pluginNavigationSchema.safeParse([manifestEntry]).success).toBe(true);
  expect(
    navigationConfigSchema.safeParse({
      schemaVersion: 1,
      layout: {
        placements: [{ entryId: entry.id, slot: "web.leftMore", order: 1 }],
      },
    }).success,
  ).toBe(true);
});
