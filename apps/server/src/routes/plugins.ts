import { downloadNpm } from "../plugins/npm.js";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import type { PluginManager } from "../plugins/manager.js";
import { MAX_PLUGIN_BYTES, StoreCursorExpired } from "../plugins/store.js";
import { unpack } from "../plugins/archive.js";

function archiveIdentity(bytes: Uint8Array) {
  try {
    const files = unpack(bytes);
    const pkg = JSON.parse(Buffer.from(files["package.json"]!).toString());
    const manifest = JSON.parse(
      Buffer.from(
        files[String(pkg.doca.manifest).replace(/^\.\//, "")]!,
      ).toString(),
    );
    return {
      pluginId: typeof manifest.id === "string" ? manifest.id : undefined,
      version:
        typeof manifest.version === "string" ? manifest.version : undefined,
    };
  } catch {
    return {};
  }
}

export function registerPluginManagement(
  api: FastifyInstance,
  db: DB,
  admin: (req: FastifyRequest) => Actor,
  manager: PluginManager,
) {
  const base = "/api/v1/admin/plugins";
  const activeOperations = new Set<string>();
  api.get(`${base}/operations`, async (req) => {
    admin(req);
    const items = await db
      .selectFrom("security_audit")
      .select(["id", "created_at", "details"])
      .where("action", "=", "plugins.operation.v1")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(100)
      .execute();
    return {
      items: items.map(({ details, ...item }) => {
        const parsed = JSON.parse(details);
        return {
          ...item,
          ...parsed,
          version: typeof parsed.version === "string" ? parsed.version : null,
          error: typeof parsed.error === "string" ? parsed.error : null,
          active:
            parsed.stage === "requested" &&
            activeOperations.has(parsed.operationId),
        };
      }),
    };
  });
  const audit = async (
    actor: Actor,
    operationId: string,
    operation: string,
    stage: "requested" | "staged" | "failed",
    metadata: { pluginId?: string; packageName?: string; version?: string },
    error?: string,
  ) => {
    await db
      .insertInto("security_audit")
      .values({
        id: randomUUID(),
        actor_id: actor.id,
        user_id: null,
        action: "plugins.operation.v1",
        created_at: new Date().toISOString(),
        details: JSON.stringify({
          schemaVersion: 1,
          operationId,
          operation,
          stage,
          pluginId: metadata.pluginId ?? null,
          packageName: metadata.packageName ?? null,
          version: metadata.version ?? null,
          error: stage === "failed" ? (error ?? null) : null,
        }),
      })
      .execute();
  };
  async function operation<T>(
    actor: Actor,
    action: string,
    run: () => Promise<T>,
    metadata: { pluginId?: string; packageName?: string; version?: string } = {},
  ) {
    const operationId = randomUUID();
    activeOperations.add(operationId);
    try {
      await audit(actor, operationId, action, "requested", metadata);
      const result = await run();
      await audit(actor, operationId, action, "staged", metadata);
      return result;
    } catch (error) {
      api.log.warn({ err: error }, "Plugin management operation failed");
      const message =
        error instanceof Error ? error.message : "Plugin operation failed";
      await audit(
        actor,
        operationId,
        action,
        "failed",
        metadata,
        message.slice(0, 500),
      );
      fail(400, message);
    } finally {
      activeOperations.delete(operationId);
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
      if (error instanceof StoreCursorExpired)
        fail(410, "Plugin store cursor expired");
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
    async (req) => {
      const metadata = {
        packageName: req.body.name,
        version: req.body.version,
        pluginId: undefined as string | undefined,
      };
      return operation(
        admin(req),
        "npm",
        async () => {
          const result = await downloadNpm(req.body.name, req.body.version);
          metadata.pluginId = archiveIdentity(result.bytes).pluginId;
          return manager.install(result.bytes, "npm", undefined, result.npm);
        },
        metadata,
      );
    },
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
      operation(
        admin(req),
        "install",
        async () => {
          const { bytes, release } = await manager.store.download(
            req.body.id,
            req.body.version,
          );
          return manager.install(bytes, "store", { id: req.body.id, release });
        },
        { pluginId: req.body.id, version: req.body.version },
      ),
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
        operation(
          admin(req),
          "upload",
          () => manager.install(req.body, "local"),
          archiveIdentity(req.body),
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
      operation(
        admin(req),
        req.body.action,
        () => manager.change(req.params.id, req.body.action),
        { pluginId: req.params.id },
      ),
  );
}
