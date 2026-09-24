import { listInvitations } from "@core/modules/access/invitation-queries.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { respondInvitation } from "@core/modules/access/invitations.js";
import {
  distributionPolicy,
  type Distribution,
} from "@core/modules/deployment/policies.js";
import { setEntry } from "@core/modules/discovery/entries.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import { createContent } from "@core/workflows/resources.js";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
export function registerDistribution(
  api: FastifyInstance,
  db: DB,
  auth: (r: FastifyRequest) => Actor,
  admin: (r: FastifyRequest) => Actor,
) {
  const choice = (values: string[]) =>
    Type.Union(values.map((v) => Type.Literal(v)));
  api.get("/api/v1/discovery/policy", async (req) => {
    auth(req);
    const policy = await distributionPolicy(db);
    return {
      publicDiscovery: policy.publicDiscovery,
      normalSearch: policy.normalSearch,
    };
  });
  api.get("/api/v1/admin/distribution", async (req) => {
    admin(req);
    return distributionPolicy(db);
  });
  api.put<{ Body: Distribution }>(
    "/api/v1/admin/distribution",
    {
      schema: {
        body: Type.Object(
          {
            resourcePolicies: Type.Optional(
              Type.Object(
                Object.fromEntries(
                  ["document", "library"].map((kind) => [
                    kind,
                    Type.Optional(
                      Type.Object(
                        {
                          grantMode: Type.Optional(
                            choice(["direct", "invite"]),
                          ),
                          managerInfoVisible: Type.Optional(Type.Boolean()),
                          autoCollectOpened: Type.Optional(Type.Boolean()),
                          defaultVisibility: Type.Optional(
                            choice([
                              "invited",
                              "requestable",
                              "authenticated",
                              "public",
                            ]),
                          ),
                          ticketReviewers: Type.Optional(
                            Type.Object(
                              {
                                access: Type.Boolean(),
                                invitation: Type.Boolean(),
                              },
                              { additionalProperties: false },
                            ),
                          ),
                        },
                        { additionalProperties: false },
                      ),
                    ),
                  ]),
                ),
                { additionalProperties: false },
              ),
            ),
            revision: Type.Integer({ minimum: 0 }),
            grantMode: choice(["direct", "invite"]),
            sharedDocuments: choice(["granted", "interacted"]),
            libraryMembers: choice(["granted", "interacted"]),
            publicLibraries: Type.Boolean(),
            publicDiscovery: Type.Optional(Type.Boolean()),
            managerInfoVisible: Type.Optional(Type.Boolean()),
            ticketReviewers: Type.Optional(
              Type.Object(
                {
                  access: Type.Boolean(),
                  invitation: Type.Boolean(),
                },
                { additionalProperties: false },
              ),
            ),
            autoCollectOpened: Type.Optional(Type.Boolean()),
            normalSearch: Type.Optional(choice(["joined", "accessible"])),
            defaultVisibility: Type.Optional(
              choice(["invited", "requestable", "authenticated", "public"]),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      admin(req);
      const { revision, ...config } = req.body;
      const result = await db
        .updateTable("distribution_settings")
        .set({ config: JSON.stringify(config), revision: revision + 1 })
        .where("id", "=", "system")
        .where("revision", "=", revision)
        .executeTakeFirst();
      if (!result.numUpdatedRows) fail(409, "设置已变化，请刷新后重试");
      return { ...config, revision: revision + 1 };
    },
  );
  api.get("/api/v1/me/invitations", (req) => listInvitations(db, auth(req)));
  api.post<{
    Params: { id: string };
    Body: { accept: boolean; version: number };
  }>(
    "/api/v1/me/invitations/:id",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object(
          {
            accept: Type.Boolean(),
            version: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const actor = auth(req),
        id = req.params.id;
      return respondInvitation(
        db,
        actor,
        id,
        req.body.accept,
        req.body.version,
      );
    },
  );
  api.put<{ Params: { id: string }; Body: { state: "joined" | "hidden" } }>(
    "/api/v1/me/entries/:id",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object(
          {
            state: Type.Union([Type.Literal("joined"), Type.Literal("hidden")]),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      transact(db, (tx) =>
        setEntry(tx, auth(req), req.params.id, req.body.state),
      ),
  );
  const content = createContent(db);
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id/references",
    {
      schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) },
    },
    (req) => {
      let actor: Actor | null = null;
      try {
        actor = auth(req);
      } catch (e) {
        if ((e as { status?: number }).status !== 401) throw e;
      }
      return content.references(actor, req.params.id);
    },
  );
}
