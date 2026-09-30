import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import {
  builtinNavigation,
  resolveNavigation,
  type NavigationConfig,
  type NavigationEntry,
} from "@smartdoca/web-plugin-registry";
import { navigationConfigSchema } from "../plugins/navigation-schema.js";

export function registerNavigation(
  api: FastifyInstance,
  db: DB,
  actor: (req: FastifyRequest) => Actor,
  admin: (req: FastifyRequest) => Actor,
  plugins: NavigationEntry[],
) {
  const entries = [...builtinNavigation, ...plugins];
  async function read() {
    await db
      .insertInto("navigation_settings")
      .values({
        id: "system",
        revision: 1,
        draft: '{"rules":[]}',
        published: '{"rules":[]}',
      })
      .onConflict((c) => c.column("id").doNothing())
      .execute();
    return db
      .selectFrom("navigation_settings")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
  }
  api.get("/api/v1/navigation", async (req) => {
    const user = actor(req),
      row = await read();
    return resolveNavigation(
      entries,
      JSON.parse(row.published),
      { id: user.id, admin: !!user.admin },
      row.revision,
    );
  });
  api.get("/api/v1/admin/navigation", async (req) => {
    admin(req);
    const row = await read();
    return {
      revision: row.revision,
      draft: JSON.parse(row.draft),
      published: JSON.parse(row.published),
      entries,
    };
  });
  api.post<{
    Body: {
      revision: number;
      action: "save" | "publish" | "reset";
      config: NavigationConfig;
    };
  }>("/api/v1/admin/navigation", { bodyLimit: 256 * 1024 }, async (req) => {
    const user = admin(req),
      body = req.body;
    if (
      !body ||
      !Number.isInteger(body.revision) ||
      !["save", "publish", "reset"].includes(body.action)
    )
      fail(400, "Invalid navigation operation");
    const parsed = navigationConfigSchema.safeParse(
      body.action === "reset" ? { rules: [] } : body.config,
    );
    if (!parsed.success) fail(400, "Invalid navigation configuration");
    const config = parsed.data;
    if (new Set(config.rules.map((r) => r.id)).size !== config.rules.length)
      fail(400, "Duplicate rule id");
    for (const rule of config.rules) {
      const keys = new Set<string>();
      for (const p of rule.layout.placements) {
        const entry = entries.find((e) => e.id === p.entryId),
          key = `${p.entryId}:${p.slot}`;
        if ((entry && !entry.allowedSlots.includes(p.slot)) || keys.has(key))
          fail(400, "Unsupported or duplicate placement");
        keys.add(key);
      }
    }
    await read();
    await db.transaction().execute(async (tx) => {
      const encoded = JSON.stringify(config);
      const result = await tx
        .updateTable("navigation_settings")
        .set({
          draft: encoded,
          ...(body.action !== "save" ? { published: encoded } : {}),
          revision: body.revision + 1,
        })
        .where("id", "=", "system")
        .where("revision", "=", body.revision)
        .executeTakeFirst();
      if (!result.numUpdatedRows)
        fail(409, "Navigation changed; reload before saving");
      await tx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          actor_id: user.id,
          resource_id: null,
          action: `navigation.${body.action}`,
          created_at: new Date().toISOString(),
        })
        .execute();
    });
    return { revision: body.revision + 1 };
  });
}
