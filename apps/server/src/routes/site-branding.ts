import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { securityAudit } from "@core/modules/identity/accounts.js";
import { fail } from "@core/shared/errors.js";
import {
  encodeSiteLogo,
  readSiteLogo,
  SITE_LOGO_UPLOAD_BYTES,
} from "../services/site-logo.js";

export function registerSiteBranding(
  api: FastifyInstance,
  db: DB,
  admin: (req: FastifyRequest) => Actor,
) {
  api.get(
    "/api/v1/site-logo",
    { schema: { summary: "读取公开站点 Logo", tags: ["Administration"] } },
    async (req, reply) => {
      const row = await db
        .selectFrom("settings")
        .select("site_logo")
        .where("id", "=", "system")
        .executeTakeFirstOrThrow();
      const logo = await readSiteLogo(row.site_logo);
      if (!logo)
        return reply.code(404).header("Cache-Control", "no-store").send();
      const etag = `"${logo.hash}"`;
      reply
        .header("Cache-Control", "public, no-cache")
        .header("ETag", etag)
        .header("X-Content-Type-Options", "nosniff");
      if (req.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply.type("image/png").send(logo.bytes);
    },
  );
  api.put<{ Body: { revision: number; image: string | null } }>(
    "/api/v1/admin/site-logo",
    {
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        summary: "修改或恢复系统 Logo",
        tags: ["Administration"],
        security: [{ session: [] }],
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            image: Type.Union([
              Type.Null(),
              Type.String({
                maxLength: Math.ceil(SITE_LOGO_UPLOAD_BYTES / 3) * 4 + 100,
              }),
            ]),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const actor = admin(req);
      const logo =
        req.body.image === null ? null : await encodeSiteLogo(req.body.image);
      await transact(db, async (tx) => {
        const current = await tx
          .selectFrom("settings")
          .select(["site_logo", "revision"])
          .where("id", "=", "system")
          .executeTakeFirstOrThrow();
        if (current.revision !== req.body.revision)
          fail(409, "site_logo_conflict", { code: "site_logo_conflict" });
        await readSiteLogo(current.site_logo);
        const changed = await tx
          .updateTable("settings")
          .set({ site_logo: logo, revision: req.body.revision + 1 })
          .where("id", "=", "system")
          .where("revision", "=", req.body.revision)
          .executeTakeFirst();
        if (!changed.numUpdatedRows)
          fail(409, "site_logo_conflict", { code: "site_logo_conflict" });
        await securityAudit(tx, actor.id, null, "site.logo_updated", {
          reset: logo === null,
        });
      });
      return { ok: true };
    },
  );
}
