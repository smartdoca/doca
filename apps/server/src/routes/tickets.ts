import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { DB } from "@db/index.js";
import type { AccountContext } from "../app/account-context.js";
import { createTickets } from "@core/modules/tickets/service.js";
export function registerTickets(
  api: FastifyInstance,
  db: DB,
  ctx: AccountContext,
) {
  const tickets = createTickets(db);
  const uuid = Type.String({ format: "uuid" });
  api.get<{
    Querystring: {
      kind?: string;
      status?: string;
      onlyMine?: boolean;
      resourceId?: string;
      resourceKind?: "document" | "library";
      offset?: number;
    };
  }>(
    "/api/v1/tickets",
    {
      schema: {
        querystring: Type.Object(
          {
            kind: Type.Optional(
              Type.Union(["access", "invitation"].map((x) => Type.Literal(x))),
            ),
            status: Type.Optional(
              Type.String({
                pattern:
                  "^(pending|completed|rejected|cancelled|expired)(,(pending|completed|rejected|cancelled|expired))*$",
                maxLength: 100,
              }),
            ),
            onlyMine: Type.Optional(Type.Boolean()),
            resourceId: Type.Optional(uuid),
            resourceKind: Type.Optional(
              Type.Union([Type.Literal("document"), Type.Literal("library")]),
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
      return tickets.list(ctx.authenticated(req), req.query);
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/tickets/:id",
    { schema: { params: Type.Object({ id: uuid }) } },
    async (req) => {
      return tickets.detail(ctx.authenticated(req), req.params.id);
    },
  );
  api.post<{
    Params: { id: string };
    Body: { action: string; message?: string; role?: "reader" | "commenter" | "editor" | "manager"; includeDescendants?: boolean };
  }>(
    "/api/v1/tickets/:id/actions",
    {
      schema: {
        params: Type.Object({ id: uuid }),
        body: Type.Object(
          {
            action: Type.Union(
              ["approve", "reject", "accept", "cancel", "remind"].map((x) =>
                Type.Literal(x),
              ),
            ),
            role: Type.Optional(Type.Union(["reader", "commenter", "editor", "manager"].map(x => Type.Literal(x)))),
            includeDescendants: Type.Optional(Type.Boolean()),
            message: Type.Optional(Type.String({ maxLength: 1000 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const actor = ctx.authenticated(req);
      await ctx.limit(`ticket:${actor.id}`, 60);
      return tickets.act(
        actor,
        req.params.id,
        req.body.action,
        req.body.message,
        { role: req.body.role, includeDescendants: req.body.includeDescendants },
      );
    },
  );
}
