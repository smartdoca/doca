import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { clearPageState, listPageState, readPageState, writePageState } from "../services/page-state.js";

export function registerPageState(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
) {
  api.get<{ Querystring: { key?: string; prefix?: string } }>(
    "/api/v1/me/page-state",
    {
      schema: {
        querystring: Type.Object({
          key: Type.Optional(Type.String({ maxLength: 160 })),
          prefix: Type.Optional(Type.String({ maxLength: 40 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      if (req.query.key) return { item: await readPageState(db, actor.id, req.query.key) };
      if (req.query.prefix) return { items: await listPageState(db, actor.id, req.query.prefix) };
      return { items: await listPageState(db, actor.id, "ui.") };
    },
  );

  api.put<{ Body: { key: string; value: unknown; version?: number } }>(
    "/api/v1/me/page-state",
    {
      schema: {
        body: Type.Object({
          key: Type.String({ minLength: 1, maxLength: 160 }),
          value: Type.Unknown(),
          version: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    async (req) => writePageState(db, auth(req).id, req.body.key, req.body.value, req.body.version ?? 0),
  );

  api.delete<{ Querystring: { key: string } }>(
    "/api/v1/me/page-state",
    {
      schema: {
        querystring: Type.Object({ key: Type.String({ minLength: 1, maxLength: 160 }) }),
      },
    },
    async (req) => {
      await clearPageState(db, auth(req).id, req.query.key);
      return { ok: true };
    },
  );
}
