import { createUser } from "@core/modules/identity/passwords.js";
import { AppError } from "@core/shared/errors.js";
import { expect, it } from "vitest";
import {
  builtinNavigation,
  resolveNavigation,
  type NavigationConfig,
  type NavigationEntry,
} from "../packages/web-plugin-registry/src/index.js";
import { registerNavigation } from "@server/routes/navigation.js";
import { openTestDatabase } from "./database.js";
import Fastify from "fastify";
it("selects rules, preserves admin boundaries and does not mutate published configuration during overflow", () => {
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
    rules: [
      { id: "all", priority: 0, audience: "all", layout: { placements: [] } },
      {
        id: "admin",
        priority: 10,
        audience: "admin",
        layout: {
          placements: [
            { entryId: "doca.files", slot: "web.left", order: 1, hidden: true },
          ],
        },
      },
    ],
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
    reply
      .code(error instanceof AppError ? error.status : 500)
      .send({
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
      rules: [
        {
          id: "everyone",
          priority: 1,
          audience: "all",
          layout: {
            placements: [
              { entryId: "doca.ai", slot: "web.left", order: 1, hidden: true },
            ],
          },
        },
      ],
    };
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
