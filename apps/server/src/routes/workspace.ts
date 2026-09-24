import {
  metadata,
  profileEditable,
  identityPolicy,
  profileRequirements,
} from "@core/modules/identity/accounts.js";
import { publicEntitlements } from "@core/modules/entitlements/service.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  defaultUserCard,
  userCardUrl,
  type UserCardSettings,
} from "@core/modules/deployment/user-card.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { registerTasks } from "./access-requests.js";
import { registerDistribution } from "./discovery.js";

export const preferenceDefaults = {
  avatar_asset_id: null as string | null,
  avatar: "initials",
  theme: "light",
  density: "comfortable",
  default_sort: "updated_at",
  sort_order: "desc",
  version: 0,
};
export function registerWorkspace(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  admin: (req: FastifyRequest) => Actor,
  onlineCount?: () => number,
) {
  registerDistribution(api, db, auth, admin);
  registerTasks(api, db, auth, admin);
  const choice = (values: string[]) =>
    Type.Union(values.map((x) => Type.Literal(x)));
  const version = Type.Integer({ minimum: 0 });
  api.get("/api/v1/user-card-settings", async () => {
    const row = await db
      .selectFrom("user_card_settings")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
    return {
      ...defaultUserCard,
      ...JSON.parse(row.config),
      revision: row.revision,
    };
  });
  api.put<{ Body: UserCardSettings }>(
    "/api/v1/admin/user-card-settings",
    {
      schema: {
        body: Type.Object(
          {
            enabled: Type.Boolean(),
            text: Type.String({ minLength: 1, maxLength: 40 }),
            style: choice(["primary", "secondary", "link"]),
            url: Type.String({ maxLength: 2000 }),
            revision: version,
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      admin(req);
      const { revision, ...config } = req.body;
      if (
        (config.enabled || config.url) &&
        !userCardUrl(config.url, "sample-user", "sample-uuid")
      )
        fail(
          400,
          "跳转地址仅支持 HTTP(S) 或站内路径，变量为 {userId} 和 {uid}",
        );
      const result = await db
        .updateTable("user_card_settings")
        .set({ config: JSON.stringify(config), revision: revision + 1 })
        .where("id", "=", "system")
        .where("revision", "=", revision)
        .executeTakeFirst();
      if (!result.numUpdatedRows) fail(409, "配置已变化，请刷新重试");
      return { ...config, revision: revision + 1 };
    },
  );
  api.get("/api/v1/admin/directory-policy", async (req) => {
    admin(req);
    return db
      .selectFrom("settings")
      .select(["directory_mode as mode", "revision"])
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
  });
  api.put<{ Body: { mode: string; revision: number } }>(
    "/api/v1/admin/directory-policy",
    {
      schema: {
        body: Type.Object(
          { mode: choice(["all", "related", "none"]), revision: version },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      admin(req);
      const result = await db
        .updateTable("settings")
        .set({ directory_mode: req.body.mode, revision: req.body.revision + 1 })
        .where("id", "=", "system")
        .where("revision", "=", req.body.revision)
        .executeTakeFirst();
      if (!result.numUpdatedRows) fail(409, "配置已变化，请刷新重试");
      return { ok: true };
    },
  );
  api.put<{ Params: { id: string }; Body: { mode: string | null } }>(
    "/api/v1/admin/users/:id/directory",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object(
          {
            mode: Type.Union([choice(["all", "related", "none"]), Type.Null()]),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      admin(req);
      const result = await db
        .updateTable("users")
        .set({ directory_mode: req.body.mode })
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!result.numUpdatedRows) fail(404, "用户不存在");
      return { ok: true };
    },
  );
  const profile = Type.Object(
    {
      version,
      displayName: Type.String({ maxLength: 160 }),
      avatar: choice([
        "initials",
        "fox",
        "panda",
        "cat",
        "whale",
        "leaf",
        "sun",
      ]),
      clearSourceAvatar: Type.Optional(Type.Boolean()),
      avatarAssetId: Type.Optional(
        Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      ),
    },
    { additionalProperties: false },
  );
  const preferences = Type.Object(
    {
      version,
      theme: choice(["light", "soft"]),
      density: choice(["comfortable", "compact"]),
      defaultSort: choice(["created_at", "updated_at", "visited_at"]),
      sortOrder: choice(["asc", "desc"]),
    },
    { additionalProperties: false },
  );
  api.get(
    "/api/v1/me",
    {
      schema: {
        summary: "个人资料与偏好",
        tags: ["Account"],
        security: [{ session: [] }],
      },
    },
    async (req) => {
      const a = auth(req);
      const account = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", a.id)
        .executeTakeFirstOrThrow();
      return {
        fields:(await identityPolicy(db)).fields,
        profileName: account.display_name || account.public_id || account.login,
        needsProfile: await profileRequirements(db, a.id),
        editable: {
          displayName: await profileEditable(db, a.id, "displayName"),
          avatar: await profileEditable(db, a.id, "avatar"),
        },
        avatarUrl: metadata(account.profile_metadata).avatarUrl,
        entitlements: await publicEntitlements(db, a.id),
        user: {
          ...a,
          display_name: account.display_name || account.public_id || account.login,
          admin: !!a.admin,
          public_id: (
            await db
              .selectFrom("users")
              .select("public_id")
              .where("id", "=", a.id)
              .executeTakeFirstOrThrow()
          ).public_id,
        },
        preferences: (await db
          .selectFrom("user_preferences")
          .selectAll()
          .where("user_id", "=", a.id)
          .executeTakeFirst()) ?? { user_id: a.id, ...preferenceDefaults },
      };
    },
  );
  for (const mode of ["profile", "preferences"] as const) {
    api.put<{
      Body: {
        version: number;
        displayName?: string;
        avatar?: string;
        avatarAssetId?: string | null;
        clearSourceAvatar?: boolean;
        theme?: string;
        density?: string;
        defaultSort?: string;
        sortOrder?: string;
      };
    }>(
      "/api/v1/me/" + mode,
      {
        schema: {
          summary:
            mode === "profile" ? "修改昵称和预设头像" : "修改个人使用偏好",
          tags: ["Account"],
          security: [{ session: [] }],
          body: mode === "profile" ? profile : preferences,
        },
      },
      async (req) => {
        const a = auth(req),
          b = req.body;
        await transact(db, async (tx) => {
          await tx.updateTable("users").set(eb=>({profile_revision:eb("profile_revision","+",0)})).where("id","=",a.id).execute();
          if (
            !(await tx
              .selectFrom("users")
              .select("id")
              .where("id", "=", a.id)
              .where("status", "=", "active")
              .executeTakeFirst())
          )
            fail(401, "账号已停用");
          const old = (await tx
            .selectFrom("user_preferences")
            .selectAll()
            .where("user_id", "=", a.id)
            .executeTakeFirst()) ?? { user_id: a.id, ...preferenceDefaults };
          if (old.version !== b.version) fail(409, "个人设置已变更，请刷新");
          if (mode === "profile") {
            const u = await tx
                .selectFrom("users")
                .selectAll()
                .where("id", "=", a.id)
                .executeTakeFirstOrThrow(),
              m = metadata(u.profile_metadata);
            const nameChanged = b.displayName!.trim() !== u.display_name;
            const avatarChanged =
              !!b.clearSourceAvatar ||
              b.avatar !== old.avatar ||
              (b.avatarAssetId !== undefined &&
                b.avatarAssetId !== old.avatar_asset_id);
            if (
              (nameChanged &&
                !await profileEditable(tx, a.id, "displayName")) ||
              (avatarChanged && !await profileEditable(tx, a.id, "avatar"))
            )
              fail(403, "该资料由认证源管理，不能自行修改");
            if ((await identityPolicy(tx)).fields.displayName.required && !b.displayName!.trim()) fail(400, "昵称不能为空");
            m.overrides ??= {};
            if (nameChanged) m.overrides.displayName = false;
            if (avatarChanged) {
              m.overrides.avatar = false;
              delete m.avatarUrl;
            }
            await tx
              .updateTable("users")
              .set({
                profile_metadata: JSON.stringify(m),
                profile_revision: (u.profile_revision ?? 1) + 1,
              })
              .where("id", "=", a.id)
              .execute();
          }
          if (
            mode === "profile" &&
            b.avatarAssetId &&
            !(await tx
              .selectFrom("assets")
              .select("id")
              .where("id", "=", b.avatarAssetId)
              .where("owner_id", "=", a.id)
              .where("purpose", "=", "avatar")
              .where("deleted_at", "is", null)
              .executeTakeFirst())
          )
            fail(400, "头像文件无效");
          const row: Schema["user_preferences"] = {
            ...old,
            version: old.version + 1,
            ...(mode === "profile"
              ? {
                  avatar: b.avatar!,
                  avatar_asset_id:
                    b.avatarAssetId === undefined
                      ? (old.avatar_asset_id ?? null)
                      : b.avatarAssetId,
                }
              : {
                  theme: b.theme!,
                  density: b.density!,
                  default_sort: b.defaultSort!,
                  sort_order: b.sortOrder!,
                }),
          };
          await tx
            .insertInto("user_preferences")
            .values(row)
            .onConflict((oc) => oc.column("user_id").doUpdateSet(row))
            .execute();
          if (mode === "profile")
            await tx
              .updateTable("users")
              .set({ display_name: b.displayName!.trim() })
              .where("id", "=", a.id)
              .execute();
        });
        return { ok: true };
      },
    );
  }
  api.post(
    "/api/v1/me/heartbeat",
    {
      schema: {
        summary: "当前用户在线心跳",
        tags: ["Account"],
        security: [{ session: [] }],
      },
    },
    async (req) => {
      const a = auth(req),
        now = new Date().toISOString();
      await db
        .insertInto("user_presence")
        .values({ user_id: a.id, last_seen_at: now })
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet({ last_seen_at: now }),
        )
        .execute();
      return { ok: true };
    },
  );
  api.get(
    "/api/v1/admin/stats",
    {
      schema: {
        summary: "全站聚合统计（不返回私有内容）",
        tags: ["Administration"],
        security: [{ session: [] }],
      },
    },
    async (req) => {
      admin(req);
      const resources = await db
        .selectFrom("resources")
        .select(["kind"])
        .select((eb) => eb.fn.countAll().as("count"))
        .where("deleted_at", "is", null)
        .groupBy("kind")
        .execute();
      const users = await db
        .selectFrom("users")
        .select((eb) => eb.fn.countAll().as("count"))
        .executeTakeFirstOrThrow();
      const now = new Date().toISOString(),
        cutoff = new Date(Date.now() - 120000).toISOString();
      const online = await db
        .selectFrom("user_presence")
        .innerJoin("users", "users.id", "user_presence.user_id")
        .select("users.id")
        .where("users.status", "=", "active")
        .where("user_presence.last_seen_at", ">=", cutoff)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("sessions")
              .select("id")
              .whereRef("sessions.user_id", "=", "users.id")
              .where("expires_at", ">", now),
          ),
        )
        .execute();
      return {
        documents: Number(
          resources.find((x) => x.kind === "document")?.count ?? 0,
        ),
        libraries: Number(
          resources.find((x) => x.kind === "library")?.count ?? 0,
        ),
        users: Number(users.count),
        online: onlineCount ? onlineCount() : online.length,
        onlineWindowSeconds: onlineCount ? 0 : 120,
      };
    },
  );
}
