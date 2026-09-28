import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { z } from "zod";
import {
  knowledgePermissionOverview,
  updateKnowledgePermission,
  updateKnowledgeMember,
  updateKnowledgePermissionSource,
  knowledgeShareLinks,
  enableKnowledgeSharing,
  saveKnowledgeShareLink,
  revokeKnowledgeShareLink,
} from "@core/modules/knowledge/permissions.js";
export function registerKnowledgePermissions(
  api: FastifyInstance,
  db: DB,
  auth: (r: FastifyRequest) => Actor,
) {
  const root = "/api/v1/knowledge/assistants/:id";
  type Params = { id: string; userId: string; linkId: string };
  api.get<{ Params: Params }>(`${root}/permission-overview`, (req) =>
    knowledgePermissionOverview(db, auth(req), req.params.id),
  );
  api.put<{ Params: Params }>(`${root}/permissions`, (req) =>
    updateKnowledgePermission(db, auth(req), req.params.id, req.body),
  );
  api.put<{ Params: Params }>(`${root}/members/:userId`, (req) =>
    updateKnowledgeMember(
      db,
      auth(req),
      req.params.id,
      req.params.userId,
      req.body,
    ),
  );
  api.put<{ Params: Params }>(`${root}/permission-sources/:userId`, (req) =>
    updateKnowledgePermissionSource(
      db,
      auth(req),
      req.params.id,
      req.params.userId,
      req.body,
    ),
  );
  api.get<{ Params: Params }>(`${root}/share-link`, (req) =>
    knowledgeShareLinks(db, auth(req), req.params.id),
  );
  api.put<{ Params: Params }>(`${root}/share-links/enabled`, (req) =>
    enableKnowledgeSharing(
      db,
      auth(req),
      req.params.id,
      z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled,
    ),
  );
  api.put<{ Params: Params }>(`${root}/share-link`, (req) =>
    saveKnowledgeShareLink(db, auth(req), req.params.id, req.body),
  );
  api.post<{ Params: Params }>(`${root}/share-links/:linkId/revoke`, (req) =>
    revokeKnowledgeShareLink(
      db,
      auth(req),
      req.params.id,
      req.params.linkId,
      z.object({ version: z.string().uuid() }).strict().parse(req.body).version,
    ),
  );
}
