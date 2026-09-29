import { recentActivity, recordActivity, setAssistantFavorite } from "@core/modules/workspace/activity.js";
import { homeOverview } from "@core/modules/workspace/home.js";
import { authorizeFileItem } from "@core/modules/access/file-access.js";
import {
  catalogPage,
  collectPublicResource,
} from "@core/modules/discovery/catalog.js";
import { authorizeFileFolder } from "@core/modules/access/file-access.js";
import { checkPublication } from "@core/modules/access/operation-policy.js";
import { listInvitations } from "@core/modules/access/invitation-queries.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { respondInvitation } from "@core/modules/access/invitations.js";
import {
  distributionDefaults,
  distributionPolicy,
  publicMode,
  publicResourceKinds,
  resourceDistribution,
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
  api.get("/api/v1/workspace/overview", req => homeOverview(db, auth(req)));
  api.get<{Querystring:{kind?:string;publicOnly?:boolean;q?:string;offset?:number}}>("/api/v1/workspace/recent", {schema:{querystring:Type.Object({kind:Type.Optional(Type.Union(["document","library","assistant","folder","file"].map(k=>Type.Literal(k)))),publicOnly:Type.Optional(Type.Boolean()),q:Type.Optional(Type.String({maxLength:200})),offset:Type.Optional(Type.Integer({minimum:0,maximum:1000000}))},{additionalProperties:false})}}, req=>recentActivity(db,auth(req),req.query));
  api.post<{Params:{id:string}}>("/api/v1/workspace/files/:id/visit",{schema:{params:Type.Object({id:Type.String({format:"uuid"})})}},async req=>{const actor=auth(req);await authorizeFileItem(db,actor,req.params.id);await recordActivity(db,actor.id,"file",req.params.id);return {ok:true};});
  api.put<{Params:{id:string};Body:{favorite:boolean}}>("/api/v1/workspace/assistants/:id/favorite",{schema:{params:Type.Object({id:Type.String({format:"uuid"})}),body:Type.Object({favorite:Type.Boolean()},{additionalProperties:false})}},req=>setAssistantFavorite(db,auth(req),req.params.id,req.body.favorite));
  const choice = (values: string[]) =>
    Type.Union(values.map((v) => Type.Literal(v)));
  const kindSchema = choice([...publicResourceKinds]);
  api.get<{
    Querystring: {
      kind?: (typeof publicResourceKinds)[number];
      collected?: boolean;
      q?: string;
      offset?: number;
    };
  }>(
    "/api/v1/discovery/resources",
    {
      schema: {
        querystring: Type.Object(
          {
            kind: Type.Optional(kindSchema),
            collected: Type.Optional(Type.Boolean()),
            q: Type.Optional(Type.String({ maxLength: 200 })),
            offset: Type.Optional(
              Type.Integer({ minimum: 0, maximum: 1000000 }),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req) => catalogPage(db, auth(req), req.query),
  );
  api.put<{
    Params: { kind: (typeof publicResourceKinds)[number]; id: string };
    Body: { collected: boolean };
  }>(
    "/api/v1/discovery/entries/:kind/:id",
    {
      schema: {
        params: Type.Object({
          kind: kindSchema,
          id: Type.String({ format: "uuid" }),
        }),
        body: Type.Object(
          { collected: Type.Boolean() },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      collectPublicResource(
        db,
        auth(req),
        req.params.kind,
        req.params.id,
        req.body.collected,
      ),
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/files/folders/:id/publication",
    {
      schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) },
    },
    async (req) => {
      await authorizeFileFolder(db, auth(req), req.params.id);
      const row = await db
        .selectFrom("folder_publications")
        .selectAll()
        .where("folder_id", "=", req.params.id)
        .executeTakeFirst();
      const entry = await db
        .selectFrom("resource_collections")
        .select("resource_id")
        .where("resource_kind", "=", "folder")
        .where("resource_id", "=", req.params.id)
        .where("user_id", "=", auth(req).id)
        .executeTakeFirst();
      return {
        enabled: !!row?.enabled,
        revision: row?.revision ?? 0,
        collected: !!entry,
      };
    },
  );
  api.put<{
    Params: { id: string };
    Body: { enabled: boolean; revision: number };
  }>(
    "/api/v1/files/folders/:id/publication",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object(
          { enabled: Type.Boolean(), revision: Type.Integer({ minimum: 0 }) },
          { additionalProperties: false },
        ),
      },
    },
    (req) =>
      transact(db, async (tx) => {
        const actor = auth(req);
        const { folder } = await authorizeFileFolder(
          tx,
          actor,
          req.params.id,
          3,
        );
        if (req.body.enabled)
          await checkPublication(
            tx,
            actor.id,
            folder.owner_id,
            "authenticated",
          );
        const old = await tx
          .selectFrom("folder_publications")
          .selectAll()
          .where("folder_id", "=", folder.id)
          .executeTakeFirst();
        if ((old?.revision ?? 0) !== req.body.revision)
          fail(409, "设置已变化，请刷新");
        const row = {
          folder_id: folder.id,
          enabled: Number(req.body.enabled),
          revision: req.body.revision + 1,
        };
        await tx
          .insertInto("folder_publications")
          .values(row)
          .onConflict((oc) => oc.column("folder_id").doUpdateSet(row))
          .execute();
        return { enabled: !!row.enabled, revision: row.revision };
      }),
  );
  api.get("/api/v1/discovery/policy", async (req) => {
    auth(req);
    const policy = await distributionPolicy(db);
    return {
      publicDiscovery: publicResourceKinds.some(
        (kind) => publicMode(policy, kind) !== "link",
      ),
      publicModes: Object.fromEntries(
        publicResourceKinds.map((kind) => [kind, publicMode(policy, kind)]),
      ),
      normalSearch: policy.normalSearch,
    };
  });
  const publicationPeople = async (
    policy: Awaited<ReturnType<typeof distributionPolicy>>,
  ) => {
    const ids = policy.internetPublicationUsers;
    const people = ids.length
      ? await db
          .selectFrom("users")
          .select(["id", "display_name", "public_id"])
          .where("id", "in", ids)
          .execute()
      : [];
    return {
      ...policy,
      internetPublicationPeople: ids.map(
        (id) => people.find((person) => person.id === id) ?? { id, display_name: id, public_id: "" },
      ),
    };
  };
  api.get("/api/v1/admin/distribution", async (req) => {
    admin(req);
    return publicationPeople(await distributionPolicy(db));
  });
  api.put<{ Body: Distribution }>(
    "/api/v1/admin/distribution",
    {
      schema: {
        body: Type.Object(
          {
            publicModes: Type.Optional(
              Type.Object(
                Object.fromEntries(
                  publicResourceKinds.map((kind) => [
                    kind,
                    choice(["link", "discover", "search"]),
                  ]),
                ),
                { additionalProperties: false },
              ),
            ),
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
            internetPublication: Type.Optional(
              Type.Object(
                {
                  document: Type.Boolean(),
                  library: Type.Boolean(),
                  assistant: Type.Boolean(),
                },
                { additionalProperties: false },
              ),
            ),
            internetPublicationUsers: Type.Optional(
              Type.Array(Type.String({ format: "uuid" }), { maxItems: 200 }),
            ),
            internetPublicationPeople: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.String(),
                  display_name: Type.String(),
                  public_id: Type.Optional(Type.String()),
                }),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      admin(req);
      const {
        revision,
        internetPublicationPeople: _people,
        ...config
      } = req.body as Distribution & { internetPublicationPeople?: unknown };
      const merged = {
        ...distributionDefaults,
        ...config,
        internetPublication: {
          ...distributionDefaults.internetPublication,
          ...config.internetPublication,
        },
        internetPublicationUsers: [
          ...new Set(config.internetPublicationUsers ?? []),
        ],
        revision,
      } satisfies Distribution;
      if (merged.internetPublicationUsers.length) {
        const found = await db
          .selectFrom("users")
          .select("id")
          .where("id", "in", merged.internetPublicationUsers)
          .where("status", "=", "active")
          .execute();
        if (found.length !== merged.internetPublicationUsers.length)
          fail(400, "放行用户不存在或已停用");
      }
      for (const kind of ["document", "library"] as const)
        if (
          resourceDistribution(merged, kind).defaultVisibility === "public" &&
          !merged.internetPublication[kind]
        )
          fail(400, "已关闭公网公开时，新建默认范围不能设为全网公开");
      config.internetPublicationUsers = merged.internetPublicationUsers;
      const result = await db
        .updateTable("distribution_settings")
        .set({ config: JSON.stringify(config), revision: revision + 1 })
        .where("id", "=", "system")
        .where("revision", "=", revision)
        .executeTakeFirst();
      if (!result.numUpdatedRows) fail(409, "设置已变化，请刷新后重试");
      return publicationPeople(await distributionPolicy(db));
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
