import { permissionOverview } from "@core/modules/access/presentation.js";
import { manageInvitation } from "@core/modules/access/invitations.js";
import { listInvitations } from "@core/modules/access/invitation-queries.js";
import { createContent } from "@core/workflows/resources.js";
import { transact } from "@db/transactions.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createAccessRequests } from "@core/modules/access/requests.js";
import { publishIntegrationEvents } from "@core/modules/automation/events.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
export function registerTasks(
  api: FastifyInstance,
  db: DB,
  auth: (r: FastifyRequest) => Actor,
  admin: (r: FastifyRequest) => Actor,
) {
  const service = createAccessRequests(db);
  const params = Type.Object({ id: Type.String({ format: "uuid" }) });
  const content = createContent(db),
    uid = Type.String({ format: "uuid" }),
    role = Type.Union(
      ["reader", "commenter", "editor", "manager"].map((x) => Type.Literal(x)),
    );
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id/permission-overview",
    { schema: { params } },
    (req) => {
      let actor: Actor | null = null;
      try {
        actor = auth(req);
      } catch (e) {
        if ((e as { status?: number }).status !== 401) throw e;
      }
      return transact(db, (tx) => permissionOverview(tx, actor, req.params.id));
    },
  );
  api.put<{
    Params: { id: string; userId: string };
    Body: {
      revision: number;
      includeDescendants?: boolean;
      message?: string;
      role: "reader" | "commenter" | "editor" | "manager" | null;
    };
  }>(
    "/api/v1/resources/:id/members/:userId",
    {
      schema: {
        params: Type.Object({ id: uid, userId: uid }),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            includeDescendants: Type.Optional(Type.Boolean()),
            message: Type.Optional(Type.String({ maxLength: 1000 })),
            role: Type.Union([role, Type.Null()]),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      content.member(auth(req), req.params.id, req.params.userId, req.body),
  );
  api.put<{
    Params: { id: string; userId: string };
    Body: {
      revision: number;
      sourceType: "direct" | "link" | "parent_override";
      sourceId?: string | null;
      action: "update" | "delete";
      role?: "reader" | "commenter" | "editor" | "manager";
      includeDescendants?: boolean;
    };
  }>(
    "/api/v1/resources/:id/permission-sources/:userId",
    {
      schema: {
        params: Type.Object({ id: uid, userId: uid }),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            sourceType: Type.Union([
              Type.Literal("direct"),
              Type.Literal("link"),
              Type.Literal("parent_override"),
            ]),
            sourceId: Type.Optional(Type.Union([uid, Type.Null()])),
            action: Type.Union([Type.Literal("update"), Type.Literal("delete")]),
            role: Type.Optional(role),
            includeDescendants: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      content.source(auth(req), req.params.id, req.params.userId, req.body),
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id/invitations",
    { schema: { params } },
    (req) => listInvitations(db, auth(req), req.params.id),
  );
  api.post<{
    Params: { id: string; userId: string };
    Body: {
      version: number;
      action: "cancel" | "resend";
      role?: "reader" | "commenter" | "editor" | "manager";
      expiresAt?: string | null;
      message?: string;
    };
  }>(
    "/api/v1/resources/:id/invitations/:userId",
    {
      schema: {
        params: Type.Object({ id: uid, userId: uid }),
        body: Type.Object(
          {
            version: Type.Integer({ minimum: 1 }),
            message: Type.Optional(Type.String({ maxLength: 1000 })),
            action: Type.Union([
              Type.Literal("cancel"),
              Type.Literal("resend"),
            ]),
            role: Type.Optional(role),
            expiresAt: Type.Optional(
              Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      manageInvitation(
        db,
        auth(req),
        req.params.id,
        req.params.userId,
        req.body,
      ),
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id/access-requests",
    { schema: { params } },
    (req) => service.list(auth(req), req.params.id),
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id/access-preview",
    { schema: { params } },
    (req) => {
      let actor: Actor | null = null;
      try {
        actor = auth(req);
      } catch (e) {
        if ((e as { status?: number }).status !== 401) throw e;
      }
      return service.preview(actor, req.params.id);
    },
  );
  api.post<{
    Params: { id: string };
    Body: {
      role: "reader" | "commenter" | "editor" | "manager";
      message?: string;
    };
  }>(
    "/api/v1/resources/:id/access-requests",
    {
      schema: {
        params,
        body: Type.Object(
          {
            message: Type.Optional(Type.String({ maxLength: 1000 })),
            role: Type.Union(
              ["reader", "commenter", "editor", "manager"].map((v) =>
                Type.Literal(v),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      service.submit(auth(req), req.params.id, req.body.role, req.body.message),
  );
  api.get("/api/v1/me/access-requests", (req) => service.list(auth(req)));
  api.post<{
    Params: { id: string };
    Body: { decision: "approved" | "rejected" | "cancelled"; message?: string; role?: "reader" | "commenter" | "editor" | "manager"; includeDescendants?: boolean };
  }>(
    "/api/v1/me/access-requests/:id",
    {
      schema: {
        params,
        body: Type.Object(
          {
            message: Type.Optional(Type.String({ maxLength: 1000 })),
            role: Type.Optional(role),
            includeDescendants: Type.Optional(Type.Boolean()),
            decision: Type.Union(
              ["approved", "rejected", "cancelled"].map((v) => Type.Literal(v)),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      service.decide(
        auth(req),
        req.params.id,
        req.body.decision,
        req.body.message,
        { role: req.body.role, includeDescendants: req.body.includeDescendants },
      ),
  );
  // Durable pull stream, no outbound URL/SSRF surface. Consumers deduplicate by event ID.
  api.get<{ Querystring: { after?: number } }>(
    "/api/v1/admin/integration-events",
    {
      schema: {
        querystring: Type.Object({
          after: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    async (req) => {
      admin(req);
      await publishIntegrationEvents(db);
      let query = db.selectFrom("integration_events").selectAll();
      query = query.where("seq", ">", req.query.after ?? 0);
      const rows = await query.orderBy("seq").limit(101).execute();
      const items = rows
        .slice(0, 100)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
      const last = items.at(-1);
      return {
        items,
        cursor: last?.seq ?? req.query.after ?? 0,
        hasMore: rows.length > 100,
      };
    },
  );
}
