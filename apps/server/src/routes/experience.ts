
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createDocuments } from "@core/modules/collaboration/documents.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createExperience } from "@core/workflows/experience.js";
import type { DB } from "@db/index.js";
export function registerExperience(
  api: FastifyInstance,
  db: DB,
  actor: (r: FastifyRequest) => Actor | null,
  authenticated: (r: FastifyRequest) => Actor,
) {
  const service = createExperience(db),
    id = Type.String({ format: "uuid" }),
    params = Type.Object({ id }),
    query = Type.Object(
      {
        cursor: Type.Optional(Type.String({ maxLength: 2048 })),
        tab: Type.Optional(
          Type.Union(["stats", "visits", "audit"].map((x) => Type.Literal(x))),
        ),
      },
      { additionalProperties: false },
    );
  for (const kind of ["likes", "info", "versions"] as const)
    api.get<{
      Params: { id: string };
      Querystring: { cursor?: string; tab?: string };
    }>(
      `/api/v1/resources/:id/${kind}`,
      { schema: { params, querystring: query } },
      (req) =>
        kind === "info"
          ? service.info(
              actor(req),
              req.params.id,
              req.query.tab ?? "stats",
              req.query.cursor,
            )
          : service[kind](
              actor(req),
              req.params.id,
              req.query.cursor,
            ),
    );
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id/share-link",
    { schema: { params } },
    (req) => service.share(authenticated(req), req.params.id),
  );
  api.put<{
    Params: { id: string };
    Body: { enabled: boolean };
  }>(
    "/api/v1/resources/:id/share-links/enabled",
    {
      schema: {
        params,
        body: Type.Object(
          { enabled: Type.Boolean() },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      service.setShareEnabled(
        authenticated(req),
        req.params.id,
        req.body.enabled,
      ),
  );
  api.put<{
    Params: { id: string };
    Body: Parameters<typeof service.setShare>[2];
  }>(
    "/api/v1/resources/:id/share-link",
    {
      schema: {
        params,
        body: Type.Object(
          {
            enabled: Type.Boolean(),
            includeDescendants: Type.Optional(Type.Boolean()),
            maxMembers: Type.Optional(
              Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
            ),
            expiresAt: Type.Optional(
              Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
            ),
            role: Type.Union(
              ["reader", "commenter", "editor", "manager"].map((x) => Type.Literal(x)),
            ),
            version: Type.Union([id, Type.Null()]),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) => service.setShare(authenticated(req), req.params.id, req.body),
  );
  api.post<{
    Params: { id: string; linkId: string };
    Body: { version: string };
  }>(
    "/api/v1/resources/:id/share-links/:linkId/revoke",
    {
      schema: {
        params: Type.Object({ id, linkId: id }),
        body: Type.Object({ version: id }, { additionalProperties: false }),
      },
    },
    (req) =>
      service.revokeShare(
        authenticated(req),
        req.params.id,
        req.params.linkId,
        req.body.version,
      ),
  );
  api.post<{ Body: { token: string; accept?: boolean; consume?: boolean } }>(
    "/api/v1/share/redeem",
    {
      schema: {
        body: Type.Object(
          {
            token: Type.String({
              minLength: 43,
              maxLength: 43,
              pattern: "^[A-Za-z0-9_-]+$",
            }),
            accept: Type.Optional(Type.Boolean()),
            consume: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) =>
      service.redeem(
        authenticated(req),
        req.body.token,
        req.body.accept ?? true,
        req.body.consume ?? false,
      ),
  );
  api.post<{ Params: { id: string } }>(
    "/api/v1/resources/:id/versions",
    { schema: { params } },
    (req) => service.snapshot(authenticated(req), req.params.id),
  );
  api.get<{ Params: { id: string; versionId: string } }>(
    "/api/v1/resources/:id/versions/:versionId",
    { schema: { params: Type.Object({ id, versionId: id }) } },
    (req) => service.version(actor(req), req.params.id, req.params.versionId),
  );
  api.post<{
    Params: { id: string; versionId: string };
    Body: { expectedSeq: number };
  }>(
    "/api/v1/resources/:id/versions/:versionId/restore",
    {
      schema: {
        params: Type.Object({ id, versionId: id }),
        body: Type.Object(
          { expectedSeq: Type.Integer({ minimum: 0 }) },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      createDocuments(db).exchange(authenticated(req), req.params.id, {
        restoreVersion: req.params.versionId,
        expectedSeq: req.body.expectedSeq,
      }),
  );
}
