import { metadata } from "@core/modules/identity/accounts.js";
import { fail } from "@core/shared/errors.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

type Authenticated = (request: FastifyRequest) => Actor;

export function registerProfiles(
  api: FastifyInstance,
  db: DB,
  authenticated: Authenticated,
) {
  api.get<{ Params: { id: string } }>(
    "/api/v1/users/:id/profile",
    {
      schema: {
        summary: "协作者公开资料（登录后）",
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
      },
    },
    async (req) => {
      authenticated(req);
      const u = await db
        .selectFrom("users")
        .leftJoin("user_preferences", "user_preferences.user_id", "users.id")
        .select([
          "users.id",
          "users.display_name",
          "users.public_id",
          "user_preferences.avatar",
          "user_preferences.avatar_asset_id",
          "users.profile_metadata",
        ])
        .where("users.id", "=", req.params.id)
        .executeTakeFirst();
      if (!u) fail(404, "用户不存在");
      const { profile_metadata, ...profile } = u;
      return { ...profile, avatarUrl: metadata(profile_metadata).avatarUrl };
    },
  );
}
