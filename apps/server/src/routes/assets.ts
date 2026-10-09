import { enqueueProjection } from "@core/modules/automation/jobs.js";
import {
  objectKey,
  detectBufferMime,
  uploadLimits,
} from "../services/storage-policy.js";
import { readUploadBuffer } from "../services/upload-stream.js";
import { uploadAIAttachment } from "../services/ai/upload-attachment.js";
import { userUploadLimits } from "@core/modules/ai/upload-policy.js";
import { Readable } from "node:stream";
import {
  registerStoredObject,
  thumbnailFor,
} from "../services/stored-objects.js";
import { sendFileContent } from "../services/file-content.js";
import { attachmentMime } from "../services/ai/attachments.js";
import {
  beginFileExtract,
  loadFileExtract,
  storageObjectIdForAsset,
} from "../services/ai/file-extract.js";
import {
  requireCapability,
  checkStorage,
} from "@core/modules/access/operation-policy.js";
import { profileEditable } from "@core/modules/identity/accounts.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { authorize } from "@core/modules/access/queries.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import { authorizeKnowledgeAsset } from "@core/modules/knowledge/file-folders.js";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  createStorage,
  storageConfigForProfile,
  type StorageConfig,
  type StorageRuntime,
} from "../adapters/storage.js";

const uuid = Type.String({ format: "uuid" });
export function registerAssets(
  api: FastifyInstance,
  db: DB,
  auth: (r: FastifyRequest) => Actor,
  actor: (r: FastifyRequest) => Actor | null,
  admin: (r: FastifyRequest) => Actor,
  runtime: StorageRuntime,
  limit?: (key: string, max?: number) => Promise<void>,
) {
  const storage = createStorage(runtime);
  const decode = (p: Schema["storage_profiles"]) =>
    storageConfigForProfile(runtime, p);
  async function access(
    tx: DB,
    a: Actor | null,
    id: string,
    min: number,
    trashPreview = false,
  ) {
    const { resource } = await authorize(tx, a, id, min, trashPreview);
    if (trashPreview && (!a || !resource.deleted_at))
      fail(404, "内容不存在或无权访问");
    return resource;
  }
  async function lock(tx: DB, a: Actor) {
    if (
      !(await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", a.id)
        .where("status", "=", "active")
        .executeTakeFirst())
    )
      fail(401, "账号已停用");
  }
  api.get(
    "/api/v1/admin/storage",
    { schema: { tags: ["Storage"], summary: "当前上传存储配置（不含密钥）" } },
    async (req) => {
      admin(req);
      const p = await db
        .selectFrom("storage_profiles")
        .selectAll()
        .where("active", "=", 1)
        .executeTakeFirstOrThrow();
      return {
        id: p.id,
        config: (() => {
          const { root, cdnPrivateKey, cdnKeyPairId, ...publicConfig } =
            decode(p);
          return publicConfig;
        })(),
        managedBy: "environment",
        credentialRefs: Object.keys(runtime.credentials),
        cdnSigningReady: !!runtime.cdnKeyPairId && !!runtime.cdnPrivateKey,
        maxUploadBytes: 20 * 1024 * 1024,
      };
    },
  );
  api.put("/api/v1/admin/storage", async (req) => {
    admin(req);
    fail(
      405,
      "File storage is managed through deployment environment variables",
    );
  });
  api.addContentTypeParser("application/octet-stream", (req, payload, done) => {
    if (req.routeOptions.url === "/api/v1/files/items" || req.routeOptions.url === "/api/v1/knowledge/conversations/:id/files")
      return done(null, payload);
    if (
      new URL(req.url, "http://localhost").searchParams.get("purpose") ===
      "ai_attachment"
    )
      return done(null, payload);
    void readUploadBuffer(payload, uploadLimits.asset).then(
      (body) => done(null, body),
      done,
    );
  });
  let concurrent = 0;
  const uploads = new WeakSet<FastifyRequest>();
  api.addHook("onResponse", async (req) => {
    if (uploads.delete(req)) concurrent--;
  });
  api.post<{
    Querystring: {
      purpose:
        "avatar" | "cover" | "attachment" | "comment_image" | "ai_attachment";
      resourceId?: string;
      filename: string;
    };
    Body: Buffer | Readable;
  }>(
    "/api/v1/assets",
    {
      bodyLimit: Number.MAX_SAFE_INTEGER,
      onRequest: async (req) => {
        const a = auth(req);
        if (
          new URL(req.url, "http://localhost").searchParams.get("purpose") !==
          "ai_attachment"
        )
          await limit?.(`upload:${a.id}`, 60);
        if (concurrent >= 4) fail(429, "上传繁忙，请稍后重试");
        concurrent++;
        uploads.add(req);
      },
      schema: {
        tags: ["Storage"],
        summary: "上传文件（二进制 body）；头像/封面最大 5MB，附件最大 20MB",
        querystring: Type.Object(
          {
            purpose: Type.Union([
              Type.Literal("avatar"),
              Type.Literal("cover"),
              Type.Literal("attachment"),
              Type.Literal("comment_image"),
              Type.Literal("ai_attachment"),
            ]),
            resourceId: Type.Optional(uuid),
            filename: Type.String({ minLength: 1, maxLength: 255 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const a = auth(req),
        q = req.query;
      if (q.purpose === "ai_attachment") {
        const maxBytes = (await userUploadLimits(db, a.id)).maxFileBytes;
        if (maxBytes && Number(req.headers["content-length"]) > maxBytes)
          fail(413, "upload_file_size_exceeded");
        if (q.resourceId) fail(400, "对话附件不能关联文档");
        if (!Buffer.isBuffer(req.body) && !(req.body instanceof Readable))
          fail(400, "upload_body_invalid");
        const row = await uploadAIAttachment(
          db,
          a.id,
          q.filename,
          req.body,
          runtime,
        );
        return reply.code(201).send(row);
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        fail(400, "请上传非空文件");
      if (q.purpose !== "avatar" && !q.resourceId)
        fail(400, "请指定所属文档或知识库");
      if (q.purpose === "avatar" && q.resourceId) fail(400, "头像不属于文档");
      const recent = await db
        .selectFrom("assets")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("owner_id", "=", a.id)
        .where("created_at", ">", new Date(Date.now() - 600000).toISOString())
        .executeTakeFirstOrThrow();
      if (Number(recent.count) >= 60) fail(429, "上传过于频繁，请稍后重试");
      if (q.resourceId) {
        const r = await access(
          db,
          a,
          q.resourceId,
          q.purpose === "cover" ? 4 : q.purpose === "comment_image" ? 2 : 3,
        );
        if (
          q.purpose !== "comment_image" &&
          (q.purpose === "cover") !== (r.kind === "library")
        )
          fail(400, "封面只用于知识库，附件只用于文档");
      }
      const p = await db
        .selectFrom("storage_profiles")
        .selectAll()
        .where("active", "=", 1)
        .executeTakeFirstOrThrow();
      const c = decode(p),
        id = randomUUID();
      let key = "";
      let stored = false,
        committed = false;
      try {
        let body = req.body,
          mime = "application/octet-stream",
          filename = Array.from(q.filename.replace(/[\x00-\x1f\x7f/\\]/g, "_"))
            .slice(0, 240)
            .join("");
        const imageRequired = q.purpose !== "attachment";
        const raster =
          body
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          body.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
          (body.toString("ascii", 0, 4) === "RIFF" &&
            body.toString("ascii", 8, 12) === "WEBP") ||
          ["GIF87a", "GIF89a"].includes(body.toString("ascii", 0, 6));
        if (imageRequired && (body.length > uploadLimits.profile || !raster))
          fail(400, "头像和封面仅支持 5MB 以内的 PNG、JPEG、WebP、GIF 图片");
        if (imageRequired) {
          try {
            body = await sharp(body, {
              limitInputPixels: 25000000,
              animated: false,
            })
              .rotate()
              .resize(
                q.purpose === "avatar"
                  ? 512
                  : q.purpose === "cover"
                    ? 1600
                    : 2400,
                q.purpose === "avatar" ? 512 : undefined,
                {
                  fit: q.purpose === "avatar" ? "cover" : "inside",
                  withoutEnlargement: true,
                },
              )
              .webp({ quality: 85 })
              .toBuffer();
          } catch {
            fail(400, "图片无法解析，或分辨率过大");
          }
          mime = "image/webp";
          filename = filename.replace(/\.[^.]*$/, "") + ".webp";
        } else if (raster) {
          try {
            await sharp(body, {
              limitInputPixels: 25000000,
              animated: false,
            }).metadata();
          } catch {
            fail(400, "图片无法解析，或分辨率过大");
          }
        }
        mime = await detectBufferMime(body, filename);
        key = objectKey(id, mime);
        await storage.put(c, key, body, mime, filename);
        stored = true;
        const row: Schema["assets"] = {
          uploaded_by: a.id,
          id,
          owner_id: a.id,
          resource_id: q.resourceId ?? null,
          purpose: q.purpose,
          profile_id: p.id,
          object_key: key,
          filename,
          mime,
          size: body.length,
          created_at: new Date().toISOString(),
          deleted_at: null,
        };
        await transact(db, async (tx) => {
          await lock(tx, a);
          if (q.resourceId)
            await access(
              tx,
              a,
              q.resourceId,
              q.purpose === "cover" ? 4 : q.purpose === "comment_image" ? 2 : 3,
            );
          await requireCapability(tx, a.id, "assets.upload");
          if (q.purpose === "avatar") {
            const u = await tx
              .selectFrom("users")
              .select("profile_metadata")
              .where("id", "=", a.id)
              .executeTakeFirstOrThrow();
            if (!(await profileEditable(tx, a.id, "avatar")))
              fail(403, "头像由认证源管理");
          }
          if (q.resourceId) {
            const r = await tx
              .selectFrom("resources")
              .select("owner_id")
              .where("id", "=", q.resourceId)
              .executeTakeFirstOrThrow();
            row.owner_id = r.owner_id;
          }
          await checkStorage(tx, row.owner_id, body.length);
          await tx.insertInto("assets").values(row).execute();
          {
            const recognitionRow = await tx
              .selectFrom("file_recognition_settings")
              .selectAll()
              .where("id", "=", "default")
              .executeTakeFirst();
            const recognition = recognitionRow
              ? (JSON.parse(recognitionRow.config) as {
                  enabled?: boolean;
                  modelId?: string | null;
                })
              : {};
            const fileObject: Schema["file_storage_objects"] = {
              id: row.id,
              profile_id: row.profile_id,
              object_key: row.object_key,
              sha256: createHash("sha256").update(body).digest("hex"),
              size: body.length,
              mime: row.mime,
              ai_description: null,
              ai_status:
                recognition.enabled && recognition.modelId
                  ? "pending"
                  : "skipped",
              ai_model:
                recognition.enabled && recognition.modelId
                  ? recognition.modelId
                  : null,
              ai_generated_at: null,
              created_at: row.created_at,
            };
            await registerStoredObject(tx, fileObject);
            if (q.purpose === "attachment") {
              const fileId = randomUUID();
              await tx
                .insertInto("file_items")
                .values({
                  id: fileId,
                  owner_id: row.owner_id,
                  parent_type: "document",
                  parent_id: q.resourceId!,
                  storage_object_id: fileObject.id,
                  name: row.filename,
                  mime: row.mime,
                  size: row.size,
                  metadata: JSON.stringify({
                    assetId: row.id,
                    resourceId: q.resourceId ?? null,
                  }),
                  ai_description_override: null,
                  locked: q.purpose === "attachment" ? 1 : 0,
                  version: 1,
                  created_at: row.created_at,
                  updated_at: row.created_at,
                  deleted_at: null,
                  delete_batch: null,
                })
                .execute();
              await enqueueProjection(tx, "search-file", fileId, { fileId });
            }
            if (!row.mime.startsWith("image/"))
              await tx
                .insertInto("file_extracts")
                .values({
                  storage_object_id: fileObject.id,
                  status: "pending",
                  result: "{}",
                  error: null,
                  updated_at: row.created_at,
                })
                .onConflict((oc) => oc.column("storage_object_id").doNothing())
                .execute();
          }
          await tx
            .insertInto("audit_events")
            .values({
              id: randomUUID(),
              actor_id: a.id,
              resource_id: q.resourceId ?? null,
              action: "asset.uploaded",
              created_at: row.created_at,
            })
            .execute();
        });
        committed = true;
        const extractStatus = mime.startsWith("image/") ? "ready" : "pending";
        if (extractStatus === "pending") beginFileExtract(db, id, runtime);
        return reply.code(201).send({
          id,
          filename,
          mime,
          size: body.length,
          url: `/api/v1/assets/${id}/content`,
          extractStatus,
        });
      } catch (e) {
        if (stored && !committed)
          await storage
            .remove(c, key)
            .catch(() =>
              req.log.error("Failed to clean up uncommitted upload"),
            );
        throw e;
      }
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/assets/:id/extract",
    {
      schema: {
        tags: ["Storage"],
        summary: "查询对话附件的解析状态",
        params: Type.Object({ id: uuid }),
      },
    },
    async (req) => {
      const a = auth(req);
      const asset = await db
        .selectFrom("assets")
        .selectAll()
        .where("id", "=", req.params.id)
        .where("owner_id", "=", a.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!asset) fail(404, "附件不存在或无权访问");
      await authorizeKnowledgeAsset(db, a, asset.id);
      if (asset.mime.startsWith("image/"))
        return { status: "ready", imageCount: 0 };
      const objectId = await storageObjectIdForAsset(db, asset);
      beginFileExtract(db, objectId, runtime);
      const extract = await loadFileExtract(db, objectId);
      const object = await db
        .selectFrom("file_storage_objects")
        .select(["ai_description", "ai_status"])
        .where("id", "=", objectId)
        .executeTakeFirst();
      const markdown = extract?.markdown?.trim() ?? "";
      return {
        status: extract?.status ?? "pending",
        error: extract?.error,
        imageCount:
          extract?.parts.filter((part) => part.type === "image").length ?? 0,
        preview: markdown ? markdown.slice(0, 280) : extract?.error,
        description: object?.ai_description?.trim() || undefined,
        aiStatus: object?.ai_status ?? undefined,
      };
    },
  );
  api.get<{
    Params: { id: string };
    Querystring: {
      download?: string;
      trashPreview?: string;
      audit?: string;
      variant?: "thumbnail";
    };
  }>(
    "/api/v1/assets/:id/content",
    {
      schema: {
        tags: ["Storage"],
        summary: "鉴权后读取文件，或跳转到 60 秒有效的签名 CDN 链接",
        params: Type.Object({ id: uuid }),
        querystring: Type.Object({
          download: Type.Optional(Type.Literal("1")),
          trashPreview: Type.Optional(Type.Literal("1")),
          audit: Type.Optional(Type.Literal("1")),
          variant: Type.Optional(Type.Literal("thumbnail")),
        }),
      },
    },
    async (req, reply) => {
      const a = actor(req),
        asset = await db
          .selectFrom("assets")
          .selectAll()
          .where("id", "=", req.params.id)
          .$if(req.query.audit !== "1", (q) =>
            q.where("deleted_at", "is", null),
          )
          .executeTakeFirst();
      if (
        !asset ||
        ![
          "avatar",
          "cover",
          "attachment",
          "comment_image",
          "ai_attachment",
        ].includes(asset.purpose)
      )
        fail(404, "文件不存在");
      const audit = req.query.audit === "1";
      if (audit) fail(404, "文件不存在");
      if (req.query.trashPreview || audit)
        reply.header("Cache-Control", "private, no-store");
      if (!audit && asset.resource_id) {
        await access(
          db,
          a,
          asset.resource_id,
          req.query.trashPreview ? 4 : 1,
          !!req.query.trashPreview,
        );
        if (asset.purpose === "cover" && asset.owner_id !== a?.id) {
          const linked = await db
            .selectFrom("resources")
            .select("id")
            .where("cover_asset_id", "=", asset.id)
            .executeTakeFirst();
          if (!linked) fail(404, "文件不存在");
        }
      } else if (!audit && asset.owner_id !== a?.id) {
        if (
          !a ||
          asset.purpose !== "avatar" ||
          !(await db
            .selectFrom("user_preferences")
            .select("user_id")
            .where("avatar_asset_id", "=", asset.id)
            .executeTakeFirst())
        )
          fail(404, "文件不存在");
      }
      const selected =
        req.query.variant === "thumbnail"
          ? await thumbnailFor(db, asset.object_key)
          : asset;
      const p = await db
          .selectFrom("storage_profiles")
          .selectAll()
          .where("id", "=", selected.profile_id)
          .executeTakeFirstOrThrow(),
        c = decode(p);
      const cdn = storage.cdnUrl(c, selected.object_key);
      if (asset.purpose === "ai_attachment")
        reply.header("Cache-Control", "private, no-store");
      if (asset.purpose === "ai_attachment" && a) await authorizeKnowledgeAsset(db, a, asset.id);
      if (
        cdn &&
        !asset.resource_id &&
        !audit &&
        asset.purpose !== "ai_attachment" &&
        req.query.download !== "1"
      )
        return reply.redirect(cdn);
      reply
        .header(
          "Content-Disposition",
          `${asset.mime === "image/webp" && req.query.download !== "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        )
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
      return sendFileContent(
        req,
        reply,
        storage,
        c,
        selected,
        !/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(selected.mime) ||
          req.query.download === "1",
      );
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/resources/:id/assets",
    {
      schema: {
        tags: ["Storage"],
        summary: "文档附件列表",
        params: Type.Object({ id: uuid }),
      },
    },
    async (req) => {
      await access(db, actor(req), req.params.id, 1);
      return {
        items: await db
          .selectFrom("assets")
          .select(["id", "filename", "mime", "size", "created_at"])
          .where("resource_id", "=", req.params.id)
          .where("purpose", "=", "attachment")
          .where("deleted_at", "is", null)
          .orderBy("created_at", "desc")
          .limit(200)
          .execute(),
      };
    },
  );
  api.put<{
    Params: { id: string };
    Body: { version: number; assetId: string | null };
  }>(
    "/api/v1/resources/:id/cover",
    {
      schema: {
        tags: ["Storage"],
        summary: "设置或移除知识库封面",
        params: Type.Object({ id: uuid }),
        body: Type.Object(
          {
            version: Type.Integer({ minimum: 1 }),
            assetId: Type.Union([uuid, Type.Null()]),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const a = auth(req);
      return transact(db, async (tx) => {
        await lock(tx, a);
        const r = await access(tx, a, req.params.id, 4);
        if (r.kind !== "library") fail(400, "只有知识库可以设置封面");
        if (r.version !== req.body.version)
          fail(409, "知识库已变更，请刷新后重试");
        if (
          req.body.assetId &&
          !(await tx
            .selectFrom("assets")
            .select("id")
            .where("id", "=", req.body.assetId)
            .where("resource_id", "=", r.id)
            .where("purpose", "=", "cover")
            .where("deleted_at", "is", null)
            .executeTakeFirst())
        )
          fail(400, "封面文件无效");
        await tx
          .updateTable("resources")
          .set({
            cover_asset_id: req.body.assetId,
            version: r.version + 1,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", r.id)
          .execute();
        return { ok: true };
      });
    },
  );
}
