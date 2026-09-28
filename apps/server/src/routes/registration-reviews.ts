import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { DB } from "@db/index.js";
import type { AccountContext } from "../app/account-context.js";
import { decideRegistration } from "@core/modules/identity/registration-reviews.js";
export function registerRegistrationReviews(
  api: FastifyInstance,
  db: DB,
  ctx: Pick<AccountContext, "admin">,
) {
  api.get<{
    Querystring: {
      status?: "pending" | "approved" | "rejected";
      offset?: number;
    };
  }>(
    "/api/v1/admin/registration-reviews",
    {
      schema: {
        querystring: Type.Object(
          {
            status: Type.Optional(
              Type.Union([
                Type.Literal("pending"),
                Type.Literal("approved"),
                Type.Literal("rejected"),
              ]),
            ),
            offset: Type.Optional(
              Type.Integer({ minimum: 0, maximum: 100000 }),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      ctx.admin(req);
      let q = db
        .selectFrom("registration_reviews as r")
        .innerJoin("users as u", "u.id", "r.user_id")
        .leftJoin("users as reviewer", "reviewer.id", "r.reviewer_id")
        .selectAll("r")
        .select([
          "u.public_id",
          "u.display_name",
          "reviewer.display_name as reviewerName",
        ]);
      if (req.query.status) q = q.where("r.status", "=", req.query.status);
      const offset = req.query.offset ?? 0,
        rows = await q
          .orderBy("r.created_at", "desc")
          .orderBy("r.user_id")
          .offset(offset)
          .limit(31)
          .execute();
      return {
        items: rows.slice(0, 30),
        nextOffset: rows.length > 30 ? offset + 30 : null,
      };
    },
  );
  api.post<{
    Params: { id: string };
    Body: { decision: "approved" | "rejected"; message?: string };
  }>(
    "/api/v1/admin/registration-reviews/:id",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object(
          {
            decision: Type.Union([
              Type.Literal("approved"),
              Type.Literal("rejected"),
            ]),
            message: Type.Optional(Type.String({ maxLength: 1000 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      decideRegistration(
        db,
        ctx.admin(req),
        req.params.id,
        req.body.decision,
        req.body.message?.trim(),
      ),
  );
}
