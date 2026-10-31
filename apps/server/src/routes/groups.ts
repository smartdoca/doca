import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import { readSnapshot } from "@db/transactions.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import {
  createGroups,
  cleanupDissolvedGroups,
} from "@core/modules/groups/service.js";
import { createGroupGrants } from "@core/modules/groups/grants.js";
import { groupMemberIds } from "@core/modules/groups/access.js";
import {
  readGroupDirectoryPolicy,
  searchGroupDirectory,
  updateGroupDirectoryPolicy,
  type GroupDirectoryMode,
} from "@core/modules/groups/directory.js";
import { groupError } from "@core/modules/groups/service.js";

type Body = {
  revision: number;
  name: string;
  avatar: string | null;
  userId: string;
  accept: boolean;
  role:
    "reader" | "commenter" | "editor" | "manager" | "admin" | "member" | null;
  includeDescendants: boolean;
};
type Request = FastifyRequest<{ Params: Record<string, string>; Body: Body }>;
export function registerGroups(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  admin: (req: FastifyRequest) => Actor,
  refresh: (ids: string[]) => Promise<void>,
) {
  const groups = createGroups(db),
    grants = createGroupGrants(db);
  const uuid = Type.String({ format: "uuid" }),
    revision = Type.Integer({ minimum: 1 });
  const object = (properties: Record<string, TSchema>) =>
    Type.Object(properties, { additionalProperties: false });
  const rev = object({ revision }),
    accept = object({ accept: Type.Boolean() });
  const member = object({ revision, userId: uuid });
  const meta = {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    avatar: Type.Union([Type.Null(), Type.String({ maxLength: 400000 })]),
  };
  const mode = Type.Union([
    Type.Literal("member"),
    Type.Literal("related"),
    Type.Literal("all"),
  ]);
  api.get<{ Querystring: { q?: string; cursor?: string } }>(
    "/api/v1/groups/lookup",
    {
      schema: {
        querystring: object({
          q: Type.Optional(Type.String({ maxLength: 160 })),
          cursor: Type.Optional(Type.String({ maxLength: 2048 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      return readSnapshot(db, async (tx) =>
        searchGroupDirectory(
          tx,
          actor,
          await readGroupDirectoryPolicy(tx, actor),
          { query: req.query.q ?? "", cursor: req.query.cursor },
        ),
      );
    },
  );
  api.get<{ Querystring: { ids?: string } }>(
    "/api/v1/admin/group-directory-policy",
    {
      schema: {
        querystring: object({
          ids: Type.Optional(
            Type.String({ maxLength: 7400, pattern: "^[a-fA-F0-9,-]*$" }),
          ),
        }),
      },
    },
    async (req) => {
      admin(req);
      const ids = [
        ...new Set((req.query.ids ?? "").split(",").filter(Boolean)),
      ];
      if (
        ids.length > 200 ||
        ids.some(
          (id) =>
            !/^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(id),
        )
      )
        return groupError(400, "invalid");
      return readSnapshot(db, async (tx) => {
        const site = await tx
          .selectFrom("group_directory_policies")
          .select(["mode", "revision"])
          .where("id", "=", "system")
          .executeTakeFirst();
        if (!site?.mode) return groupError(409, "conflict");
        const overrides = ids.length
          ? await tx
              .selectFrom("group_directory_policies")
              .select(["user_id", "mode", "revision"])
              .where("user_id", "in", ids)
              .execute()
          : [];
        return { ...site, overrides };
      });
    },
  );
  api.put<{ Body: { mode: GroupDirectoryMode; revision: number } }>(
    "/api/v1/admin/group-directory-policy",
    { schema: { body: object({ mode, revision }) } },
    (req) => updateGroupDirectoryPolicy(db, admin(req), "system", req.body),
  );
  api.put<{
    Params: { id: string };
    Body: { mode: GroupDirectoryMode | null; revision: number };
  }>(
    "/api/v1/admin/users/:id/group-directory",
    {
      schema: {
        params: object({ id: uuid }),
        body: object({
          mode: Type.Union([mode, Type.Null()]),
          revision: Type.Integer({ minimum: 0 }),
        }),
      },
    },
    (req) =>
      updateGroupDirectoryPolicy(db, admin(req), req.params.id, req.body),
  );
  function add(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: TSchema | undefined,
    fn: (req: Request, actor: Actor) => Promise<unknown>,
    read = false,
  ) {
    const properties: Record<string, TSchema> = {};
    for (const match of path.matchAll(/:([A-Za-z]+)/g))
      properties[match[1]!] =
        match[1] === "token"
          ? Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" })
          : uuid;
    api.route<{ Params: Record<string, string>; Body: Body }>({
      method,
      url: `/api/v1${path}`,
      bodyLimit: 410000,
      schema: {
        tags: ["Groups"],
        ...(Object.keys(properties).length
          ? { params: object(properties) }
          : {}),
        ...(body ? { body } : {}),
      },
      handler: async (req) => {
        const actor = auth(req);
        if (read) return fn(req, actor);
        const groupId = req.params.groupId ?? req.params.id;
        const before = groupId ? await groupMemberIds(db, groupId) : [];
        const result = await fn(req, actor);
        const resultId =
          result &&
          typeof result === "object" &&
          "id" in result &&
          typeof result.id === "string"
            ? result.id
            : undefined;
        const after = await groupMemberIds(db, groupId ?? resultId ?? "");
        await refresh([
          ...new Set([
            actor.id,
            ...before,
            ...after,
            ...[req.body?.userId, req.params.userId].filter(
              (id): id is string => !!id,
            ),
          ]),
        ]);
        return result;
      },
    });
  }
  add(
    "GET",
    "/groups",
    undefined,
    (req, actor) => readSnapshot(db, (tx) => createGroups(tx).list(actor)),
    true,
  );
  add(
    "GET",
    "/groups/:id",
    undefined,
    (req, actor) =>
      readSnapshot(db, (tx) => createGroups(tx).detail(actor, req.params.id!)),
    true,
  );
  add("POST", "/groups", object(meta), (req, actor) =>
    groups.create(actor, req.body),
  );
  add("PUT", "/groups/:id", object({ ...meta, revision }), (req, actor) =>
    groups.update(actor, req.params.id!, req.body),
  );
  add("DELETE", "/groups/:id", rev, (req, actor) =>
    groups.dissolve(actor, req.params.id!, req.body.revision),
  );
  add("POST", "/groups/:id/invitations", member, (req, actor) =>
    groups.invite(actor, req.params.id!, req.body.userId, req.body.revision),
  );
  add("POST", "/groups/invitations/:invitationId", accept, (req, actor) =>
    groups.respond(actor, req.params.invitationId!, req.body.accept),
  );
  add("DELETE", "/groups/:id/invitations/:invitationId", rev, (req, actor) =>
    groups.cancelInvite(
      actor,
      req.params.id!,
      req.params.invitationId!,
      req.body.revision,
    ),
  );
  add("POST", "/groups/:id/invite-link", rev, (req, actor) =>
    groups.link(actor, req.params.id!, req.body.revision),
  );
  add("DELETE", "/groups/:id/invite-link", rev, (req, actor) =>
    groups.link(actor, req.params.id!, req.body.revision, true),
  );
  add(
    "GET",
    "/groups/join/:token",
    undefined,
    (req, actor) =>
      readSnapshot(db, (tx) =>
        createGroups(tx).previewLink(actor, req.params.token!),
      ),
    true,
  );
  add("POST", "/groups/join/:token", undefined, (req, actor) =>
    groups.join(actor, req.params.token!),
  );
  add("POST", "/groups/:id/leave", rev, (req, actor) =>
    groups.leave(actor, req.params.id!, req.body.revision),
  );
  add("POST", "/groups/:id/transfer", member, (req, actor) =>
    groups.transfer(actor, req.params.id!, req.body.userId, req.body.revision),
  );
  add(
    "PUT",
    "/groups/:id/members/:userId",
    object({
      revision,
      role: Type.Union([Type.Literal("admin"), Type.Literal("member")]),
    }),
    (req, actor) =>
      groups.member(
        actor,
        req.params.id!,
        req.params.userId!,
        req.body.revision,
        req.body.role as "admin" | "member",
      ),
  );
  add("DELETE", "/groups/:id/members/:userId", rev, (req, actor) =>
    groups.member(
      actor,
      req.params.id!,
      req.params.userId!,
      req.body.revision,
      null,
    ),
  );
  add(
    "POST",
    "/groups/:id/resource-invitations/:invitationId",
    accept,
    (req, actor) =>
      grants.respond(
        actor,
        req.params.id!,
        req.params.invitationId!,
        req.body.accept,
      ),
  );
  for (const folder of [false, true]) {
    const base = folder ? "/files/folders/:id" : "/resources/:id";
    api.get<{
      Params: { id: string; groupId: string };
      Querystring: { cursor?: string; limit?: number };
    }>(
      `/api/v1${base}/group-grants/:groupId/members`,
      {
        schema: {
          tags: ["Groups"],
          params: object({ id: uuid, groupId: uuid }),
          querystring: object({
            cursor: Type.Optional(Type.String({ maxLength: 2048 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          }),
        },
      },
      (req) => {
        const actor = auth(req);
        return readSnapshot(db, (tx) =>
          createGroupGrants(tx).members(
            actor,
            req.params.id,
            req.params.groupId,
            folder,
            req.query,
          ),
        );
      },
    );
    add(
      "GET",
      `${base}/group-grants`,
      undefined,
      (req, actor) =>
        readSnapshot(db, (tx) =>
          createGroupGrants(tx).list(actor, req.params.id!, folder),
        ),
      true,
    );
    add(
      "PUT",
      `${base}/group-grants/:groupId`,
      object({
        revision,
        role: Type.Union([
          ...(
            ["reader", "commenter", "editor", "manager", "admin"] as const
          ).map((value) => Type.Literal(value)),
          Type.Null(),
        ]),
        includeDescendants: Type.Boolean(),
      }),
      (req, actor) =>
        grants.set(actor, req.params.id!, req.params.groupId!, folder, {
          ...req.body,
          role: req.body.role as Exclude<Body["role"], "member">,
        }),
    );
  }
  let cleaning: Promise<unknown> | undefined;
  const clean = () => {
    if (!cleaning)
      cleaning = cleanupDissolvedGroups(db)
        .catch((error) => api.log.error({ err: error }, "Group cleanup failed"))
        .finally(() => {
          cleaning = undefined;
        });
  };
  const timer = setInterval(clean, 3600000);
  timer.unref();
  api.addHook("onReady", async () => {
    clean();
  });
  api.addHook("onClose", async () => {
    clearInterval(timer);
    await cleaning;
  });
}
