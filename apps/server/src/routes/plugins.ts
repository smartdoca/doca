import { downloadNpm } from "../plugins/npm.js";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import type { PluginManager } from "../plugins/manager.js";
import { MAX_PLUGIN_BYTES, StoreCursorExpired } from "../plugins/store.js";

export function registerPluginManagement(
  api: FastifyInstance,
  db: DB,
  admin: (req: FastifyRequest) => Actor,
  manager: PluginManager,
) {
  const base = "/api/v1/admin/plugins";
  const audit = async (actor: Actor, action: string) => {
    await db
      .insertInto("audit_events")
      .values({
        id: randomUUID(),
        actor_id: actor.id,
        resource_id: null,
        action: `plugins.${action}`.slice(0, 64),
        created_at: new Date().toISOString(),
      })
      .execute();
  };
  async function operation<T>(
    actor: Actor,
    action: string,
    run: () => Promise<T>,
  ) {
    await audit(actor, `requested.${action}`);
    try {
      const result = await run();
      await audit(actor, `staged.${action}`);
      return result;
    } catch (error) {
      api.log.warn({ err: error }, "Plugin management operation failed");
      await audit(actor, `failed.${action}`);
      fail(
        400,
        error instanceof Error ? error.message : "Plugin operation failed",
      );
    }
  }
  api.get(base, async (req) => {
    admin(req);
    return manager.inventory();
  });
  api.get(`${base}/catalog`, async (req) => {
    admin(req);
    try {
      return await manager.store.catalog(req.query);
    } catch (error) {
      if (error instanceof StoreCursorExpired) fail(410, "Plugin store cursor expired");
      api.log.warn({ err: error }, "Plugin store unavailable");
      fail(502, "Plugin store unavailable");
    }
  });
  api.get(`${base}/categories`, async (req) => {
    admin(req);
    return manager.store.categories((req.query as { locale?: string }).locale);
  });
  api.get<{ Params: { id: string }; Querystring: { locale?: string } }>(
    `${base}/detail/:id`,
    async (req) => {
      admin(req);
      return manager.store.detail(req.params.id, req.query.locale);
    },
  );
  api.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    `${base}/releases/:id`,
    async (req) => {
      admin(req);
      return manager.store.releases(req.params.id, req.query.cursor);
    },
  );
  api.get(`${base}/updates`, async (req) => {
    admin(req);
    const inventory = await manager.inventory();
    return manager.store.updates(
      inventory.plugins
        .filter((p) => !p.removing)
        .map((p) => ({
          id: p.id,
          version: p.version,
          dataVersion: p.dataVersion,
          ...(p.npm
            ? { npm: { name: p.npm.name, registry: p.npm.registry } }
            : {}),
        })),
    );
  });
  api.post<{ Body: { name: string; version: string } }>(
    `${base}/npm`,
    async (req) =>
      operation(admin(req), "npm", async () => {
        const result = await downloadNpm(req.body.name, req.body.version);
        return manager.install(result.bytes, "npm", undefined, result.npm);
      }),
  );
  api.post<{ Body: { id: string; version: string } }>(
    `${base}/install`,
    {
      schema: {
        body: Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 100 }),
            version: Type.String({ minLength: 1, maxLength: 100 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      operation(admin(req), `install.${req.body.id}`, async () => {
        const { bytes, release } = await manager.store.download(
          req.body.id,
          req.body.version,
        );
        return manager.install(bytes, "store", { id: req.body.id, release });
      }),
  );
  // Scoped parser: no change to content handling in the rest of the host.
  api.register(async (upload) => {
    upload.addContentTypeParser(
      "application/zip",
      { parseAs: "buffer", bodyLimit: MAX_PLUGIN_BYTES },
      (_req, body, done) => done(null, body),
    );
    upload.post<{ Body: Buffer }>(
      `${base}/upload`,
      {
        bodyLimit: MAX_PLUGIN_BYTES,
        onRequest: async (req) => {
          admin(req);
        },
      },
      async (req) =>
        operation(admin(req), "upload", () =>
          manager.install(req.body, "local"),
        ),
    );
  });
  api.post<{
    Params: { id: string };
    Body: { action: "enable" | "disable" | "remove" | "cancel" };
  }>(
    `${base}/:id`,
    {
      schema: {
        params: Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100 }),
        }),
        body: Type.Object(
          {
            action: Type.Union(
              ["enable", "disable", "remove", "cancel"].map((x) =>
                Type.Literal(x),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      operation(admin(req), `${req.body.action}.${req.params.id}`, () =>
        manager.change(req.params.id, req.body.action),
      ),
  );
}
