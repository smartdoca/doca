import {
  restoreDocument,
  b64,
} from "@core/modules/collaboration/documents.js";
import { restoreMarkdown } from "@core/modules/documents/codecs/markdown.js";
import { restoreSurface } from "@core/modules/documents/codecs/surfaces.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import {
  blockDocument,
  decideCase,
  moderationAction,
  moderationConfig,
  moderationSnapshot,
  reportDocument,
} from "@core/modules/moderation/service.js";
import { fail } from "@core/shared/errors.js";
import { createModerationWorker } from "../jobs/moderation-worker.js";
import type { StorageRuntime } from "../adapters/storage.js";
import type { ModerationRuntime } from "../adapters/moderation.js";
export function registerModeration(
  api: FastifyInstance,
  db: DB,
  access: {
    admin(r: FastifyRequest): Actor;
    auth(r: FastifyRequest): Actor;
    limit(key: string, max?: number): void;
  },
  storage: StorageRuntime,
  enforce: () => Promise<void>,
  runtime?: ModerationRuntime,
) {
  const worker = createModerationWorker(db, storage, runtime, enforce);
  const params = Type.Object({ id: Type.String({ format: "uuid" }) });
  const reason = Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" });
  api.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/api/v1/resources/:id/reports",
    {
      schema: {
        params,
        body: Type.Object({ reason }, { additionalProperties: false }),
      },
    },
    async (req) => {
      const a = access.auth(req);
      access.limit(`report:${a.id}`, 10);
      return reportDocument(db, a, req.params.id, req.body.reason);
    },
  );
  api.get("/api/v1/admin/moderation/settings", async (req) => {
    access.admin(req);
    const config = await moderationConfig(db);
    const row = await db
      .selectFrom("moderation_settings")
      .select("revision")
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
    return {
      ...config,
      secretKey: "",
      secretKeyConfigured: !!config.secretKey,
      revision: row.revision,
    };
  });
  api.put<{
    Body: {
      enabled: boolean;
      region: string;
      secretId: string;
      secretKey?: string;
      textBizType: string;
      imageBizType: string;
      delaySeconds: number;
      revision: number;
    };
  }>(
    "/api/v1/admin/moderation/settings",
    {
      schema: {
        body: Type.Object(
          {
            enabled: Type.Boolean(),
            region: Type.String({
              minLength: 1,
              maxLength: 80,
              pattern: "^[a-z0-9-]+$",
            }),
            secretId: Type.String({ maxLength: 200 }),
            secretKey: Type.Optional(Type.String({ maxLength: 200 })),
            textBizType: Type.String({ maxLength: 200 }),
            imageBizType: Type.String({ maxLength: 200 }),
            delaySeconds: Type.Integer({ minimum: 10, maximum: 3600 }),
            revision: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const a = access.admin(req);
      await transact(db, async (tx) => {
        const old = await moderationConfig(tx),
          { revision, ...input } = req.body;
        const config = {
          ...old,
          ...input,
          secretKey: input.secretKey || old.secretKey,
          provider: "tencent" as const,
        };
        if (
          config.enabled &&
          (!config.secretId.trim() || !config.secretKey.trim())
        )
          fail(400, "开启审核前请配置云服务密钥");
        const result = await tx
          .updateTable("moderation_settings")
          .set({ config: JSON.stringify(config), revision: revision + 1 })
          .where("id", "=", "system")
          .where("revision", "=", revision)
          .executeTakeFirst();
        if (!result.numUpdatedRows) fail(409, "设置已变更，请刷新");
        await moderationAction(tx, {
          actor_id: a.id,
          action: "settings.updated",
          reason: config.enabled ? "开启云审核" : "关闭云审核",
        });
      });
      return { ok: true };
    },
  );
  api.get<{ Querystring: { status?: string; kind?: string; offset?: number } }>(
    "/api/v1/admin/moderation/cases",
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(Type.String({ maxLength: 20 })),
          kind: Type.Optional(Type.String({ maxLength: 20 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    async (req) => {
      access.admin(req);
      const q = req.query;
      let query = db
        .selectFrom("moderation_cases")
        .select([
          "id",
          "resource_id",
          "asset_id",
          "subject_user_id",
          "kind",
          "status",
          "reason",
          "title",
          "created_at",
        ]);
      if (q.status) query = query.where("status", "=", q.status);
      if (q.kind) query = query.where("kind", "=", q.kind);
      const items = await query
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(51)
        .offset(q.offset ?? 0)
        .execute();
      return {
        items: items.slice(0, 50),
        nextOffset: items.length > 50 ? (q.offset ?? 0) + 50 : null,
      };
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/moderation/cases/:id",
    { schema: { params } },
    async (req) => {
      const a = access.admin(req),
        row = await db
          .selectFrom("moderation_cases")
          .selectAll()
          .where("id", "=", req.params.id)
          .executeTakeFirst();
      if (!row) fail(404, "审核记录不存在");
      await moderationAction(db, {
        actor_id: a.id,
        case_id: row.id,
        resource_id: row.resource_id,
        action: "evidence.viewed",
        reason: "管理员查看审核证据",
      });
      const actions = await db
        .selectFrom("moderation_actions")
        .selectAll()
        .where("case_id", "=", row.id)
        .orderBy("created_at")
        .execute();
      const publicIdentity = (id: string) =>
        db
          .selectFrom("users")
          .select(["id", "public_id", "display_name", "status", "admin"])
          .where("id", "=", id)
          .executeTakeFirst();
      return {
        ...row,
        actions,
        subject: await publicIdentity(row.subject_user_id),
        reporter: row.reporter_id
          ? await publicIdentity(row.reporter_id)
          : null,
      };
    },
  );
  api.post<{
    Params: { id: string };
    Body: {
      decision: "dismiss" | "block_document" | "block_user" | "approve_image";
      reason: string;
    };
  }>(
    "/api/v1/admin/moderation/cases/:id/decide",
    {
      schema: {
        params,
        body: Type.Object(
          {
            decision: Type.Union(
              ["dismiss", "block_document", "block_user", "approve_image"].map(
                (x) => Type.Literal(x),
              ),
            ),
            reason,
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      await decideCase(
        db,
        access.admin(req),
        req.params.id,
        req.body.decision,
        req.body.reason,
      );
      await enforce();
      return { ok: true };
    },
  );
  api.get<{ Querystring: { q?: string; blocked?: string; offset?: number } }>(
    "/api/v1/admin/moderation/documents",
    {
      schema: {
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 160 })),
          blocked: Type.Optional(Type.Literal("1")),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    async (req) => {
      access.admin(req);
      const q = req.query;
      let query = db
        .selectFrom("resources")
        .select([
          "id",
          "title",
          "format",
          "owner_id",
          "moderation_status",
          "moderation_hold",
          "version",
          "updated_at",
        ])
        .where("kind", "=", "document");
      if (q.q) query = query.where("title", "like", `%${q.q}%`);
      if (q.blocked) query = query.where("moderation_status", "=", "blocked");
      const rows = await query
        .orderBy("updated_at", "desc")
        .orderBy("id")
        .limit(51)
        .offset(q.offset ?? 0)
        .execute();
      return {
        items: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? (q.offset ?? 0) + 50 : null,
      };
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/moderation/documents/:id",
    { schema: { params } },
    async (req) => {
      const a = access.admin(req),
        snapshot = await moderationSnapshot(db, req.params.id);
      await moderationAction(db, {
        actor_id: a.id,
        resource_id: req.params.id,
        action: "document.inspected",
        reason: "管理员审计查看文档",
      });
      const assets = await db
        .selectFrom("assets")
        .select(["id", "filename", "mime", "moderation_status"])
        .where("resource_id", "=", req.params.id)
        .where("deleted_at", "is", null)
        .execute();
      return { ...snapshot, assets };
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/moderation/documents/:id/preview",
    { schema: { params } },
    async (req) => {
      const a = access.admin(req);
      return transact(db, async (tx) => {
        const r = await tx
          .selectFrom("resources")
          .selectAll()
          .where("id", "=", req.params.id)
          .executeTakeFirst();
        if (!r || r.kind !== "document") fail(404, "文档不存在");
        await moderationAction(tx, {
          actor_id: a.id,
          resource_id: r.id,
          action: "document.previewed",
          reason: "管理员审计预览",
        });
        const state = await tx
          .selectFrom("document_states")
          .select("resource_id")
          .where("resource_id", "=", r.id)
          .executeTakeFirst();
        if (!state) return { empty: true };
        if (r.format === "markdown") {
          const loaded = await restoreMarkdown(tx, r.id);
          try {
            return { markdown: loaded.doc.getText("markdown").toString() };
          } finally {
            loaded.destroy();
          }
        }
        if (r.format !== "rich_text") {
          const loaded = await restoreSurface(tx, r.id, r.format);
          return {
            surface: {
              format: r.format,
              epochId: loaded.epochId,
              baseline: loaded.baseline,
              update: b64(loaded.update),
            },
          };
        }
        const loaded = await restoreDocument(tx, r.id);
        try {
          return { value: loaded.runtime.getValue() };
        } finally {
          loaded.destroy();
        }
      });
    },
  );
  api.post<{
    Params: { id: string };
    Body: { blocked: boolean; reason: string; version: number };
  }>(
    "/api/v1/admin/moderation/documents/:id/block",
    {
      schema: {
        params,
        body: Type.Object(
          {
            blocked: Type.Boolean(),
            reason,
            version: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const a = access.admin(req);
      await transact(db, async (tx) => {
        const r = await tx
          .selectFrom("resources")
          .select("version")
          .where("id", "=", req.params.id)
          .executeTakeFirst();
        if (!r || r.version !== req.body.version)
          fail(409, "文档已变更，请刷新");
        await blockDocument(
          tx,
          req.params.id,
          req.body.blocked,
          a.id,
          req.body.reason,
        );
      });
      await enforce();
      return { ok: true };
    },
  );
  let running: Promise<void> | null = null,
    stopped = false;
  const tick = () => {
    if (!stopped && !running)
      running = worker
        .tick()
        .catch(() => api.log.error("Content moderation worker failed"))
        .finally(() => {
          running = null;
        });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  api.addHook("preClose", async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  });
  return worker;
}
