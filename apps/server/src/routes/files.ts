import { folderInSearch } from "@core/modules/discovery/catalog.js";
import { queryResourcePage } from "@core/modules/resources/queries.js";
import { authorizeFileFolder as folderAccess, authorizeFileItem } from "@core/modules/access/file-access.js";
import { Readable } from "node:stream";
import {
  requireCapability,
  checkStorage,
} from "@core/modules/access/operation-policy.js";
import {
  objectKey,
  uploadLimits,
  filePolicy,
} from "../services/storage-policy.js";
import { stageUpload } from "../services/upload-stream.js";
import {
  registerStoredObject,
  thumbnailFor,
} from "../services/stored-objects.js";
import { sendFileContent } from "../services/file-content.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authorize } from "@core/modules/access/queries.js";
import { canChangeMemberRole, type Role } from "@core/modules/access/roles.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import {
  isCopyOnlyParent,
  normalizeFolderParentId,
  systemFolder,
} from "../services/ai/file-locations.js";
import { searchIntent } from "@core/modules/discovery/search-intent.js";
import {
  textMentionsTopic,
  topicMatchTerms,
} from "@core/modules/discovery/search-excerpts.js";
import { aiConfig } from "@core/modules/ai/config.js";
import {
  enqueueProjection,
  enqueueProjectionOnce,
  processProjections,
} from "@core/modules/automation/jobs.js";
import { enqueueKnowledge } from "@core/modules/knowledge/service.js";
import { releaseDocumentFileIfUnused } from "@core/modules/documents/live-media.js";
import {
  beginFileExtract,
  loadFileExtract,
} from "../services/ai/file-extract.js";
import { recognizeStoredFile } from "../services/ai/file-recognition.js";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  createStorage,
  storageDefaults,
  storageRuntime,
  type StorageConfig,
  type StorageRuntime,
} from "../adapters/storage.js";

const uuid = Type.String({ format: "uuid" });
const parentType = Type.Union([
  Type.Literal("system"),
  Type.Literal("folder"),
  Type.Literal("document"),
]);
type ParentType = "system" | "folder" | "document";
const folderAclRole = (role: "owner" | "admin" | "reader" | undefined): Role =>
  role === "owner"
    ? "owner"
    : role === "admin"
      ? "manager"
      : role === "reader"
        ? "reader"
        : "none";

function cleanName(value: string, fallback = "未命名") {
  const name = value.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  return (name || fallback).slice(0, 255);
}

function configOf(profile: Schema["storage_profiles"]): StorageConfig {
  return {
    ...storageDefaults,
    ...JSON.parse(profile.config),
    provider: profile.provider as StorageConfig["provider"],
  };
}

type Parent = { type: ParentType; id: string };
type FilePolicyGroup = "image" | "pdf" | "office" | "text" | "other";
type FilePolicySource = "personal" | "ai" | "documents" | "shared";
type FileRecognitionConfig = {
  enabled: boolean;
  modelId: string | null;
  ocrEnabled: boolean;
  recognitionGroups: FilePolicyGroup[];
  recognitionSources: FilePolicySource[];
  searchGroups: FilePolicyGroup[];
};
const defaultRecognitionConfig: FileRecognitionConfig = {
  enabled: false,
  modelId: null,
  ocrEnabled: false,
  recognitionGroups: ["image", "pdf", "office", "text"],
  recognitionSources: ["personal", "ai", "documents", "shared"],
  searchGroups: ["image", "pdf", "office", "text", "other"],
};
const filePolicyGroup = (mime: string): FilePolicyGroup =>
  mime.startsWith("image/")
    ? "image"
    : mime === "application/pdf"
      ? "pdf"
      : /officedocument|msword|ms-excel|ms-powerpoint/.test(mime)
        ? "office"
        : mime.startsWith("text/") || /json|xml|yaml/.test(mime)
          ? "text"
          : "other";
const filePolicySource = (parent: Parent): FilePolicySource =>
  parent.type === "document" ||
  (parent.type === "system" && parent.id === "documents")
    ? "documents"
    : parent.type === "system" && parent.id === "ai"
      ? "ai"
      : parent.type === "system" && parent.id === "shared"
        ? "shared"
        : "personal";

export function registerFiles(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  runtime: StorageRuntime = storageRuntime(),
  admin?: (req: FastifyRequest) => Actor,
  indexedSearch?: (
    query: string,
    fileIds: string[],
    mode: "keyword" | "ai",
  ) => Promise<string[] | null>,
) {
  const storage = createStorage(runtime);
  const enqueueFileSearch = (tx: DB, fileId: string) =>
    Promise.all([
      enqueueProjection(tx, "search-file", fileId, { fileId }),
      enqueueKnowledge(tx, "file", fileId),
    ]);

  async function recognizeObject(objectId: string, userId: string) {
    try {
      const row = await db
        .selectFrom("file_storage_objects as o")
        .innerJoin("file_items as f", "f.storage_object_id", "o.id")
        .selectAll("o")
        .select("f.name as file_name")
        .where("o.id", "=", objectId)
        .where("f.deleted_at", "is", null)
        .executeTakeFirst();
      const setting = await db
        .selectFrom("file_recognition_settings")
        .selectAll()
        .where("id", "=", "default")
        .executeTakeFirst();
      const config = {
        ...defaultRecognitionConfig,
        ...(setting ? JSON.parse(setting.config) : {}),
      };
      if (!row) return;
      if (!config.enabled || !config.modelId) {
        await db
          .updateTable("file_storage_objects")
          .set({ ai_status: "skipped", ai_model: null })
          .where("id", "=", objectId)
          .execute();
        return;
      }
      await db
        .updateTable("file_storage_objects")
        .set({ ai_status: "processing", ai_model: config.modelId })
        .where("id", "=", objectId)
        .execute();
      const modelConfig = (await aiConfig(db)).models.find(
        (item) => item.id === config.modelId && item.enabled && !item.embedding,
      );
      if (!modelConfig) throw new Error("识别模型不可用");
      const recognition = await recognizeStoredFile(db, {
        objectId, filename: row.file_name || row.object_key, userId,
        model: modelConfig, storage: runtime, purpose: "index",
        visualPolicy: row.mime.startsWith("image/") || config.ocrEnabled ? "auto" : "off",
      });
      if (recognition.status !== "ready")
        throw new Error(recognition.warning || "文件尚未完整识别");
      const description = recognition.text;
      await db
        .updateTable("file_storage_objects")
        .set({
          ai_description: description,
          ai_status: "ready",
          ai_model: config.modelId,
          ai_generated_at: new Date().toISOString(),
        })
        .where("id", "=", objectId)
        .execute();
      const items = await db
        .selectFrom("file_items")
        .select("id")
        .where("storage_object_id", "=", objectId)
        .where("deleted_at", "is", null)
        .execute();
      for (const item of items) await enqueueFileSearch(db, item.id);
    } catch {
      await db
        .updateTable("file_storage_objects")
        .set({ ai_status: "failed" })
        .where("id", "=", objectId)
        .execute()
        .catch(() => {});
    }
  }

  async function enqueueRecognition(objectIds: string[], userId: string) {
    for (const objectId of [...new Set(objectIds)]) {
      await db
        .updateTable("file_storage_objects")
        .set({ ai_status: "pending" })
        .where("id", "=", objectId)
        .execute();
      await enqueueProjectionOnce(db, "file-recognition", objectId, {
        objectId,
        userId,
      });
    }
  }
  let recognitionStopped = false;
  const recognitionTimer = setInterval(() => {
    if (recognitionStopped) return;
    void (async () => {
      const rows = await db
        .selectFrom("file_storage_objects as o")
        .innerJoin("file_items as f", "f.storage_object_id", "o.id")
        .select(["o.id", "f.owner_id"])
        .where("o.ai_status", "=", "pending")
        .where("f.deleted_at", "is", null)
        .limit(8)
        .execute();
      for (const row of rows)
        await enqueueProjectionOnce(db, "file-recognition", row.id, {
          objectId: row.id,
          userId: row.owner_id,
        });
      await processProjections(
        db,
        "file-recognition",
        (payload) =>
          recognizeObject(String(payload.objectId), String(payload.userId)),
        2,
        5 * 60_000,
      );
    })()
      .catch(() => {});
  }, 1500);
  recognitionTimer.unref();
  api.addHook("preClose", async () => {
    recognitionStopped = true;
    clearInterval(recognitionTimer);
  });

  api.get("/api/v1/admin/files/recognition", async (req) => {
    if (!admin) fail(500, "文件识别管理未启用");
    admin(req);
    const row = await db
      .selectFrom("file_recognition_settings")
      .selectAll()
      .where("id", "=", "default")
      .executeTakeFirst();
    const config = {
      ...defaultRecognitionConfig,
      ...(row ? JSON.parse(row.config) : {}),
    };
    const models = (await aiConfig(db)).models
      .filter((model) => model.enabled && !model.embedding)
      .map((model) => ({
        id: model.id,
        name: model.alias || model.model,
        vision: !!model.vision,
        pdf: !!model.pdf,
      }));
    return { revision: row?.revision ?? 0, config, models };
  });
  api.put<{ Body: { revision: number; config: FileRecognitionConfig } }>(
    "/api/v1/admin/files/recognition",
    {
      schema: {
        body: Type.Object({
          revision: Type.Integer({ minimum: 0 }),
          config: Type.Object({
            enabled: Type.Boolean(),
            modelId: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
            ocrEnabled: Type.Boolean(),
            recognitionGroups: Type.Array(
              Type.Union([
                Type.Literal("image"),
                Type.Literal("pdf"),
                Type.Literal("office"),
                Type.Literal("text"),
                Type.Literal("other"),
              ]),
            ),
            recognitionSources: Type.Array(
              Type.Union([
                Type.Literal("personal"),
                Type.Literal("ai"),
                Type.Literal("documents"),
                Type.Literal("shared"),
              ]),
            ),
            searchGroups: Type.Array(
              Type.Union([
                Type.Literal("image"),
                Type.Literal("pdf"),
                Type.Literal("office"),
                Type.Literal("text"),
                Type.Literal("other"),
              ]),
            ),
          }),
        }),
      },
    },
    async (req) => {
      if (!admin) fail(500, "文件识别管理未启用");
      admin(req);
      const old = await db
        .selectFrom("file_recognition_settings")
        .selectAll()
        .where("id", "=", "default")
        .executeTakeFirst();
      const revision = old?.revision ?? 0;
      if (revision !== req.body.revision)
        fail(409, "文件识别配置已变化，请刷新");
      const config = { ...defaultRecognitionConfig, ...req.body.config };
      if (config.enabled && !config.modelId)
        fail(400, "启用文件识别时必须选择模型");
      if (config.enabled && config.modelId) {
        const model = (await aiConfig(db)).models.find(
          (item) =>
            item.id === config.modelId && item.enabled && !item.embedding,
        );
        if (!model) fail(400, "所选识别模型不存在或未启用");
      }
      const next = {
        id: "default",
        config: JSON.stringify(config),
        revision: revision + 1,
      };
      if (old)
        await db
          .updateTable("file_recognition_settings")
          .set(next)
          .where("id", "=", "default")
          .where("revision", "=", revision)
          .executeTakeFirstOrThrow();
      else
        await db.insertInto("file_recognition_settings").values(next).execute();
      const indexedItems = await db
        .selectFrom("file_items")
        .select("id")
        .execute();
      for (const item of indexedItems) await enqueueFileSearch(db, item.id);
      if (config.enabled && config.modelId) {
        const pending = await db
          .selectFrom("file_storage_objects as o")
          .innerJoin("file_items as f", "f.storage_object_id", "o.id")
          .select(["o.id", "f.owner_id"])
          .where("o.ai_status", "in", ["skipped", "failed"])
          .where("f.deleted_at", "is", null)
          .execute();
        for (const item of pending)
          void enqueueRecognition([item.id], item.owner_id);
      }
      return { revision: next.revision, config };
    },
  );

  async function parentOwner(
    tx: DB,
    actor: Actor,
    parent: Parent,
    minimumRole = 3,
  ) {
    if (parent.type === "system") {
      if (parent.id === "root" || parent.id === "shared") return actor.id;
      fail(
        403,
        isCopyOnlyParent("system", parent.id)
          ? `「${systemFolder(parent.id)?.name ?? parent.id}」由系统管理，不能增删改`
          : "这个系统文件夹暂不支持直接写入",
      );
    }
    if (parent.type === "folder") {
      const access = await folderAccess(tx, actor, parent.id, minimumRole);
      return access.folder.owner_id;
    }
    const access = await authorize(tx, actor, parent.id, minimumRole);
    if (access.resource.kind !== "document")
      fail(400, "文件只能放入文档文件夹");
    return access.resource.owner_id;
  }

  async function readableItem(tx: DB, actor: Actor, id: string) {
    const row = await tx
      .selectFrom("file_items")
      .innerJoin(
        "file_storage_objects",
        "file_storage_objects.id",
        "file_items.storage_object_id",
      )
      .select([
        "file_items.id",
        "file_items.owner_id",
        "file_items.parent_type",
        "file_items.parent_id",
        "file_items.storage_object_id",
        "file_items.name",
        "file_items.mime",
        "file_items.size",
        "file_items.metadata",
        "file_items.ai_description_override",
        "file_items.locked",
        "file_items.version",
        "file_items.created_at",
        "file_items.updated_at",
        "file_items.deleted_at",
        "file_items.delete_batch",
        "file_storage_objects.profile_id",
        "file_storage_objects.object_key",
        "file_storage_objects.ai_description",
        "file_storage_objects.ai_status",
      ])
      .where("file_items.id", "=", id)
      .where("file_items.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) fail(404, "文件不存在");
    await authorizeFileItem(tx, actor, row.id);
    return row;
  }

  api.get<{
    Querystring: {
      parentType?: ParentType;
      parentId?: string;
      sessionId?: string;
    };
  }>(
    "/api/v1/files",
    {
      schema: {
        tags: ["Files"],
        summary: "读取文件夹内容",
        querystring: Type.Object({
          parentType: Type.Optional(parentType),
          parentId: Type.Optional(Type.String({ maxLength: 80 })),
          sessionId: Type.Optional(uuid),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const type = req.query.parentType ?? "system";
      const id = req.query.parentId ?? "root";
      let currentFolder: Schema["file_folders"] | null = null;
      if (type === "document") await authorize(db, actor, id, 1);
      if (type === "folder") {
        currentFolder = (await folderAccess(db, actor, id, 1)).folder;
      }
      let physicalFolders: Schema["file_folders"][] = [];
      if (type === "system" && id === "root") {
        physicalFolders = await db
          .selectFrom("file_folders")
          .selectAll()
          .where("owner_id", "=", actor.id)
          .where((eb) =>
            eb.or([
              eb("parent_id", "is", null),
              eb("parent_id", "=", ""),
              eb("parent_id", "=", "root"),
            ]),
          )
          .where("deleted_at", "is", null)
          .orderBy("name")
          .execute();
      } else if (type === "system" && id === "shared") {
        const candidates = await db
          .selectFrom("file_folders")
          .selectAll()
          .where("parent_id", "=", "shared")
          .where("deleted_at", "is", null)
          .orderBy("name")
          .execute();
        for (const candidate of candidates) {
          if (candidate.owner_id === actor.id) physicalFolders.push(candidate);
          else {
            try {
              if (await folderInSearch(db, actor, candidate.id)) physicalFolders.push(candidate);
            } catch {}
          }
        }
      } else if (type === "folder" && currentFolder) {
        physicalFolders = await db
          .selectFrom("file_folders")
          .selectAll()
          .where("owner_id", "=", currentFolder.owner_id)
          .where("parent_id", "=", id)
          .where("deleted_at", "is", null)
          .orderBy("name")
          .execute();
      }
      const virtualFolders: Array<{
        id: string;
        parent_id: string;
        name: string;
        type: ParentType;
        virtual: boolean;
        locked: boolean;
        version: number;
        icon?: string;
      }> = [];
      if (type === "system" && id === "documents") {
        virtualFolders.push(
          {
            id: "documents-personal",
            parent_id: id,
            name: "个人文档",
            type: "system",
            virtual: true,
            locked: true,
            version: 1,
          },
          {
            id: "documents-shared",
            parent_id: id,
            name: "共享文档",
            type: "system",
            virtual: true,
            locked: true,
            version: 1,
          },
          {
            id: "documents-libraries",
            parent_id: id,
            name: "知识库",
            type: "system",
            virtual: true,
            locked: true,
            version: 1,
          },
        );
      } else if (type === "system" && id === "documents-personal") {
        const docs = await db
          .selectFrom("resources")
          .selectAll()
          .where("kind", "=", "document")
          .where("owner_id", "=", actor.id)
          .where("library_id", "is", null)
          .where("deleted_at", "is", null)
          .orderBy("title")
          .execute();
        virtualFolders.push(
          ...docs.map((doc) => ({
            id: doc.id,
            parent_id: id,
            name: doc.title,
            type: "document" as const,
            virtual: true,
            locked: true,
            version: doc.version,
          })),
        );
      } else if (type === "system" && id === "documents-shared") {
        const docs = await db
          .selectFrom("resources")
          .selectAll()
          .where("kind", "=", "document")
          .where("owner_id", "!=", actor.id)
          .where("library_id", "is", null)
          .where("deleted_at", "is", null)
          .orderBy("title")
          .execute();
        for (const doc of docs) {
          try {
            await authorize(db, actor, doc.id, 1);
            virtualFolders.push({
              id: doc.id,
              parent_id: id,
              name: doc.title,
              type: "document",
              virtual: true,
              locked: true,
              version: doc.version,
            });
          } catch {}
        }
      } else if (type === "system" && id === "documents-libraries") {
        const libraries = await db
          .selectFrom("resources")
          .selectAll()
          .where("kind", "=", "library")
          .where("deleted_at", "is", null)
          .orderBy("title")
          .execute();
        for (const library of libraries) {
          try {
            await authorize(db, actor, library.id, 1);
            virtualFolders.push({
              id: "library:" + library.id,
              parent_id: id,
              name: library.title,
              type: "system",
              virtual: true,
              locked: true,
              version: library.version,
            });
          } catch {}
        }
      } else if (type === "system" && id.startsWith("library:")) {
        const libraryId = id.slice("library:".length);
        await authorize(db, actor, libraryId, 1);
        const docs = await db
          .selectFrom("resources")
          .selectAll()
          .where("kind", "=", "document")
          .where("library_id", "=", libraryId)
          .where("parent_id", "is", null)
          .where("deleted_at", "is", null)
          .orderBy("tree_order")
          .orderBy("title")
          .execute();
        virtualFolders.push(
          ...docs.map((doc) => ({
            id: doc.id,
            parent_id: id,
            name: doc.title,
            type: "document" as const,
            virtual: true,
            locked: true,
            version: doc.version,
          })),
        );
      } else if (type === "document") {
        const children = await db
          .selectFrom("resources")
          .selectAll()
          .where("kind", "=", "document")
          .where("parent_id", "=", id)
          .where("deleted_at", "is", null)
          .orderBy("tree_order")
          .orderBy("title")
          .execute();
        virtualFolders.push(
          ...children.map((doc) => ({
            id: doc.id,
            parent_id: id,
            name: doc.title,
            type: "document" as const,
            virtual: true,
            locked: true,
            version: doc.version,
          })),
        );
      }
      let files = db
        .selectFrom("file_items")
        .innerJoin(
          "file_storage_objects",
          "file_storage_objects.id",
          "file_items.storage_object_id",
        )
        .leftJoin(
          "file_extracts",
          "file_extracts.storage_object_id",
          "file_storage_objects.id",
        )
        .select([
          "file_items.id",
          "file_items.parent_type",
          "file_items.parent_id",
          "file_items.name",
          "file_items.mime",
          "file_items.size",
          "file_items.ai_description_override",
          "file_items.locked",
          "file_items.version",
          "file_items.created_at",
          "file_items.updated_at",
          "file_storage_objects.ai_description",
          "file_storage_objects.ai_status",
          "file_extracts.status as extract_status",
        ])
        .where("file_items.deleted_at", "is", null)
        .orderBy("file_items.name"); {
        files = files
          .where("file_items.parent_type", "=", type)
          .where("file_items.parent_id", "=", id);
        if (type === "folder" && currentFolder)
          files = files.where(
            "file_items.owner_id",
            "=",
            currentFolder.owner_id,
          );
        else if (type !== "document")
          files = files.where("file_items.owner_id", "=", actor.id);
      }
      if (req.query.sessionId && type === "system" && id === "ai") {
        files = files.where(
          "file_items.metadata",
          "like",
          `%"sessionId":"${req.query.sessionId}"%`,
        );
      }
      const rows = await files.execute();
      return {
        parent: { type, id },
        folders: [
          ...physicalFolders.map((folder) => ({
            id: folder.id,
            parent_id: folder.parent_id,
            name: folder.name,
            type: "folder" as const,
            virtual: false,
            locked: false,
            version: folder.version,
            created_at: folder.created_at,
            updated_at: folder.updated_at,
          })),
          ...virtualFolders,
        ],
        files: rows.map((file) => ({
          id: file.id,
          name: file.name,
          mime: file.mime,
          size: file.size,
          locked:
            !!file.locked ||
            type === "document" ||
            isCopyOnlyParent(type, id),
          version: file.version,
          created_at: file.created_at,
          updated_at: file.updated_at,
          ai_description: file.ai_description_override ?? file.ai_description,
          ai_status: file.ai_status,
          extract_status: file.extract_status,
          preview_url: `/api/v1/files/items/${file.id}/content`,
        })),
      };
    },
  );

  api.get<{
    Querystring: {
      q?: string;
      limit?: number;
      mode?: "keyword" | "ai";
      scope?: "all" | "owned" | "shared" | "personal" | "public";
      location?: "all" | "personal" | "library";
      ownerIds?: string[];
      libraryIds?: string[];
    };
  }>(
    "/api/v1/files/search",
    {
      schema: {
        tags: ["Files"],
        summary: "搜索当前用户可见文件",
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 500 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          mode: Type.Optional(
            Type.Union([Type.Literal("keyword"), Type.Literal("ai")]),
          ),
          scope: Type.Optional(
            Type.Union([
              Type.Literal("all"),
              Type.Literal("owned"),
              Type.Literal("shared"),
              Type.Literal("personal"),
              Type.Literal("public"),
            ]),
          ),
          location: Type.Optional(
            Type.Union([
              Type.Literal("all"),
              Type.Literal("personal"),
              Type.Literal("library"),
            ]),
          ),
          ownerIds: Type.Optional(Type.Array(uuid, { maxItems: 50 })),
          libraryIds: Type.Optional(Type.Array(uuid, { maxItems: 50 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const rawQuery = (req.query.q ?? "").trim();
      if (!rawQuery) return { items: [] };
      const intent = searchIntent(rawQuery);
      const topic = intent.topic || rawQuery;
      const terms = topicMatchTerms(topic).filter((term) => term.length >= 2);
      const setting = await db
        .selectFrom("file_recognition_settings")
        .select("config")
        .where("id", "=", "default")
        .executeTakeFirst();
      const policy = {
        ...defaultRecognitionConfig,
        ...(setting ? JSON.parse(setting.config) : {}),
      } as FileRecognitionConfig;
      let query = db
        .selectFrom("file_items as f")
        .innerJoin("file_storage_objects as o", "o.id", "f.storage_object_id")
        .select([
          "f.id",
          "f.storage_object_id",
          "f.name",
          "f.mime",
          "f.size",
          "f.parent_type",
          "f.parent_id",
          "f.updated_at",
          "f.ai_description_override",
          "o.ai_description",
        ])
        .where("f.deleted_at", "is", null)
        .orderBy("f.updated_at", "desc");
      if (req.query.scope === "owned")
        query = query.where("f.owner_id", "=", actor.id);
      if (req.query.scope === "shared")
        query = query.where("f.owner_id", "!=", actor.id);
      if (req.query.ownerIds?.length)
        query = query.where("f.owner_id", "in", req.query.ownerIds);
      if (req.query.mode !== "ai" && terms.length)
        query = query.where((eb) =>
          eb.or(
            terms.flatMap((term) => {
              const pattern = "%" + term.replace(/[%_]/g, "\\$&") + "%";
              return [
                eb("f.name", "like", pattern),
                eb("f.ai_description_override", "like", pattern),
                eb("o.ai_description", "like", pattern),
              ];
            }),
          ),
        );
      const rows = await query
        .limit(
          req.query.mode === "ai"
            ? 1000
            : Math.min(150, (req.query.limit ?? 30) * 5),
        )
        .execute();
      type SearchFileRow = (typeof rows)[number];
      const visible: SearchFileRow[] = [];
      const documentMedia = new Map<string, Promise<{ ids: Set<string> | null; updatedAt: string }>>();
      for (const row of rows) {
        if (!policy.searchGroups.includes(filePolicyGroup(row.mime))) continue;
        if (!(await releaseDocumentFileIfUnused(db, row.id, documentMedia))) continue;
        try {
          await readableItem(db, actor, row.id);
          if (req.query.scope === "public" && row.parent_type !== "folder" && row.parent_type !== "document") continue;
          if (row.parent_type === "folder" && !await folderInSearch(db, actor, row.parent_id, req.query.scope)) continue;
          if (row.parent_type === "document" && !(await queryResourcePage(db, actor, {matchedIds:[row.parent_id], scope:req.query.scope})).items.length) continue;
        } catch {
          continue;
        }
        if (
          (req.query.location && req.query.location !== "all") ||
          req.query.libraryIds?.length
        ) {
          if (row.parent_type !== "document") {
            if (
              req.query.location === "library" ||
              req.query.libraryIds?.length
            )
              continue;
          } else {
            const resource = await db
              .selectFrom("resources")
              .select("library_id")
              .where("id", "=", row.parent_id)
              .executeTakeFirst();
            if (req.query.location === "library" && !resource?.library_id)
              continue;
            if (req.query.location === "personal" && resource?.library_id)
              continue;
            if (
              req.query.libraryIds?.length &&
              (!resource?.library_id ||
                !req.query.libraryIds.includes(resource.library_id))
            )
              continue;
          }
        }
        visible.push(row);
      }
      const fileText = (row: SearchFileRow) =>
        [row.name, row.ai_description_override, row.ai_description]
          .filter(Boolean)
          .join("\n");
      for (let index = visible.length - 1; index >= 0; index--) {
        const row = visible[index];
        if (row && !textMentionsTopic(fileText(row), topic))
          visible.splice(index, 1);
      }
      const rankedIds =
        req.query.mode === "ai" && indexedSearch
          ? await indexedSearch(
              topic,
              visible.map((row) => row.id),
              "ai",
            )
          : null;
      const rank = rankedIds?.length
        ? new Map(rankedIds.map((id, index) => [id, index]))
        : null;
      if (rank)
        visible.sort(
          (a, b) =>
            (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
      const navigationOf = async (row: SearchFileRow) => {
        const navigation: Array<{
          type: ParentType;
          id: string;
          name: string;
        }> = [];
        let sharedRoot: { id: string; name: string } | null = null;
        if (row.parent_type === "folder") {
          const ancestors: Schema["file_folders"][] = [];
          let folderId: string | null = row.parent_id;
          while (folderId && folderId !== "shared" && ancestors.length < 100) {
            const folder = await db
              .selectFrom("file_folders")
              .selectAll()
              .where("id", "=", folderId)
              .executeTakeFirst();
            if (!folder) break;
            ancestors.unshift(folder);
            folderId = folder.parent_id;
          }
          if (ancestors[0]?.parent_id === "shared") {
            sharedRoot = { id: ancestors[0].id, name: ancestors[0].name };
            navigation.push(
              ...ancestors.map((folder) => ({
                type: "folder" as const,
                id: folder.id,
                name: folder.name,
              })),
            );
          } else {
            navigation.push(
              { type: "system", id: "root", name: "我的文件夹" },
              ...ancestors.map((folder) => ({
                type: "folder" as const,
                id: folder.id,
                name: folder.name,
              })),
            );
          }
        } else if (row.parent_type === "system") {
          navigation.push({
            type: "system",
            id: row.parent_id,
            name:
              row.parent_id === "ai"
                ? "AI 助手"
                : row.parent_id === "documents"
                  ? "文档系统"
                  : "我的文件夹",
          });
        } else if (row.parent_type === "document") {
          const resource = await db
            .selectFrom("resources")
            .select("title")
            .where("id", "=", row.parent_id)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
          if (resource)
            navigation.push({
              type: "document",
              id: row.parent_id,
              name: resource.title,
            });
        }
        return { navigation, sharedRoot };
      };
      const grouped = new Map<string, SearchFileRow[]>();
      for (const row of visible) {
        if (rank && !rank.has(row.id)) continue;
        const group = grouped.get(row.storage_object_id) ?? [];
        group.push(row);
        grouped.set(row.storage_object_id, group);
      }
      const items = [];
      for (const [storageObjectId, matchedCopies] of grouped) {
        const allCopies = await db
          .selectFrom("file_items as f")
          .innerJoin("file_storage_objects as o", "o.id", "f.storage_object_id")
          .select([
            "f.id",
            "f.storage_object_id",
            "f.name",
            "f.mime",
            "f.size",
            "f.parent_type",
            "f.parent_id",
            "f.updated_at",
            "f.ai_description_override",
            "o.ai_description",
          ])
          .where("f.storage_object_id", "=", storageObjectId)
          .where("f.deleted_at", "is", null)
          .orderBy("f.updated_at", "desc")
          .execute();
        const copies: SearchFileRow[] = [];
        for (const copy of allCopies) {
          try {
            await readableItem(db, actor, copy.id);
            copies.push(copy);
          } catch {}
        }
        if (!copies.length) continue;
        const row = matchedCopies[0] ?? copies[0]!;
        const locations = [];
        for (const copy of copies)
          locations.push({
            id: copy.id,
            name: copy.name,
            parentType: copy.parent_type,
            parentId: copy.parent_id,
            ...(await navigationOf(copy)),
          });
        const preferredDescription =
          row.ai_description_override ?? row.ai_description;
        const preferredName = row.name;
        items.push({
          storageObjectId,
          id: row.id,
          name: preferredName,
          mime: row.mime,
          size: row.size,
          parentType: row.parent_type,
          parentId: row.parent_id,
          updatedAt: row.updated_at,
          description: preferredDescription,
          locations,
        });
        if (items.length >= (req.query.limit ?? 30)) break;
      }
      return { items };
    },
  );


  api.post<{ Body: { name: string; parentId?: string | null } }>(
    "/api/v1/files/folders",
    {
      schema: {
        tags: ["Files"],
        summary: "新建文件夹",
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 255 }),
          parentId: Type.Optional(
            Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
          ),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const name = cleanName(req.body.name);
      const parentId = normalizeFolderParentId(req.body.parentId);
      let folderOwner = actor.id;
      if (parentId && parentId !== "shared") {
        folderOwner = (await folderAccess(db, actor, parentId, 3)).folder
          .owner_id;
      }
      if (parentId === "shared")
        await parentOwner(db, actor, { type: "system", id: "shared" });
      const duplicate = await db
        .selectFrom("file_folders")
        .select("id")
        .where("owner_id", "=", folderOwner)
        .$if(parentId === null, (q) =>
          q.where((eb) =>
            eb.or([
              eb("parent_id", "is", null),
              eb("parent_id", "=", ""),
              eb("parent_id", "=", "root"),
            ]),
          ),
        )
        .$if(parentId !== null, (q) => q.where("parent_id", "=", parentId))
        .where("name", "=", name)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (duplicate) fail(409, "同一文件夹下已有同名文件夹");
      const now = new Date().toISOString();
      const row: Schema["file_folders"] = {
        id: randomUUID(),
        owner_id: folderOwner,
        parent_id: parentId,
        name,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      };
      await db.insertInto("file_folders").values(row).execute();
      return { ...row, type: "folder", virtual: false, locked: false };
    },
  );

  api.post<{
    Querystring: {
      parentType?: ParentType;
      parentId?: string;
      filename: string;
    };
    Body: Buffer | Readable;
  }>(
    "/api/v1/files/items",
    {
      bodyLimit: uploadLimits.file,
      onRequest: async (req) => {
        auth(req);
      },
      schema: {
        tags: ["Files"],
        summary: "上传文件到文件夹",
        querystring: Type.Object({
          parentType: Type.Optional(parentType),
          parentId: Type.Optional(Type.String({ maxLength: 80 })),
          filename: Type.String({ minLength: 1, maxLength: 255 }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      if (!Buffer.isBuffer(req.body) && !(req.body instanceof Readable))
        fail(400, "请使用二进制文件上传");
      const parent: Parent = {
        type: req.query.parentType ?? "system",
        id: req.query.parentId ?? "root",
      };
      const filename = cleanName(req.query.filename);
      const ownerId = await parentOwner(db, actor, parent);
      await requireCapability(db, actor.id, "assets.upload");
      const maxBytes = uploadLimits.file;
      if (Number(req.headers["content-length"]) > maxBytes)
        fail(413, "文件超过上传大小限制");
      const staged = await stageUpload(
        runtime.root,
        req.body,
        filename,
        maxBytes,
      );
      let stored: { config: StorageConfig; key: string } | undefined;
      let committedKey: string | undefined;
      try {
        const { mime, sha256, size } = staged;
        const recognitionRow = await db
          .selectFrom("file_recognition_settings")
          .selectAll()
          .where("id", "=", "default")
          .executeTakeFirst();
        const recognition = {
          ...defaultRecognitionConfig,
          ...(recognitionRow ? JSON.parse(recognitionRow.config) : {}),
        };
        const recognitionEnabled =
          size <= uploadLimits.asset &&
          !!recognition.enabled &&
          !!recognition.modelId &&
          recognition.recognitionGroups.includes(filePolicyGroup(mime)) &&
          recognition.recognitionSources.includes(filePolicySource(parent));
        const profile = await db
          .selectFrom("storage_profiles")
          .selectAll()
          .where("active", "=", 1)
          .executeTakeFirstOrThrow();
        const findExisting = (tx: DB) =>
          tx
            .selectFrom("file_storage_objects")
            .selectAll()
            .where("profile_id", "=", profile.id)
            .where("sha256", "=", sha256)
            .where("size", "=", size)
            .where("mime", "=", mime)
            .executeTakeFirst();
        let candidate = await findExisting(db);
        if (!candidate) {
          const id = randomUUID(),
            key = objectKey(id, mime),
            config = configOf(profile);
          await storage.putStream(
            config,
            key,
            staged.stream(),
            size,
            mime,
            filename,
          );
          stored = { config, key };
          candidate = {
            id,
            profile_id: profile.id,
            object_key: key,
            sha256,
            size,
            mime,
            category: filePolicy(mime, size).category,
            ai_description: null,
            ai_status: recognitionEnabled ? "pending" : "skipped",
            ai_model: recognitionEnabled ? recognition.modelId : null,
            ai_generated_at: null,
            created_at: new Date().toISOString(),
          };
        }
        const result = await transact(db, async (tx) => {
          if ((await parentOwner(tx, actor, parent)) !== ownerId)
            fail(409, "目标文件夹已变化，请重新上传");
          await requireCapability(
            tx,
            actor.id,
            "assets.upload",
          );
          await checkStorage(tx, ownerId, size);
          let object = await findExisting(tx);
          if (!object) {
            object = candidate!;
            await registerStoredObject(tx, object);
          }
          if (recognitionEnabled && object.ai_status === "skipped") {
            await tx
              .updateTable("file_storage_objects")
              .set({ ai_status: "pending", ai_model: recognition.modelId })
              .where("id", "=", object.id)
              .execute();
            object = { ...object, ai_status: "pending" };
          }
          const now = new Date().toISOString();
          const row: Schema["file_items"] = {
            id: randomUUID(),
            owner_id: ownerId,
            parent_type: parent.type,
            parent_id: parent.id,
            storage_object_id: object.id,
            name: filename,
            mime,
            size,
            metadata: "{}",
            ai_description_override: null,
            locked: parent.type === "document" ? 1 : 0,
            version: 1,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            delete_batch: null,
          };
          await tx.insertInto("file_items").values(row).execute();
          await enqueueFileSearch(tx, row.id);
          if (!mime.startsWith("image/"))
            await tx
              .insertInto("file_extracts")
              .values({
                storage_object_id: object.id,
                status: "pending",
                result: "{}",
                error: null,
                updated_at: now,
              })
              .onConflict((oc) => oc.column("storage_object_id").doNothing())
              .execute();
          return { row, object };
        });
        committedKey = result.object.object_key;
        if (!mime.startsWith("image/"))
          beginFileExtract(db, result.object.id, runtime);
        if (recognitionEnabled)
          void enqueueRecognition([result.object.id], actor.id);
        return {
          ...result.row,
          ai_description: result.object.ai_description,
          ai_status: result.object.ai_status,
          extract_status: mime.startsWith("image/") ? "ready" : "pending",
          preview_url: `/api/v1/files/items/${result.row.id}/content`,
        };
      } finally {
        await staged.cleanup();
        if (stored && committedKey !== stored.key)
          await storage
            .remove(stored.config, stored.key)
            .catch(() =>
              req.log.error("Failed to clean up uncommitted upload"),
            );
      }
    },
  );

  api.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      parentType?: ParentType;
      parentId?: string;
      version: number;
    };
  }>(
    "/api/v1/files/items/:id",
    {
      schema: {
        tags: ["Files"],
        summary: "重命名或移动文件",
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
          parentType: Type.Optional(parentType),
          parentId: Type.Optional(Type.String({ maxLength: 80 })),
          version: Type.Integer({ minimum: 1 }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      await transact(db, async (tx) => {
        const item = await readableItem(tx, actor, req.params.id);
        if (
          item.locked ||
          isCopyOnlyParent(item.parent_type, item.parent_id)
        )
          fail(403, "这个文件由系统或文档管理，不能直接修改");
        if (item.parent_type === "folder")
          await folderAccess(tx, actor, item.parent_id, 3);
        if (item.version !== req.body.version)
          fail(409, "文件已变化，请刷新后重试");
        let nextParent: Parent | null = null;
        let nextOwnerId = item.owner_id;
        if (req.body.parentType || req.body.parentId) {
          nextParent = {
            type: req.body.parentType ?? item.parent_type,
            id: req.body.parentId ?? item.parent_id,
          };
          nextOwnerId = await parentOwner(tx, actor, nextParent);
        }
        await tx
          .updateTable("file_items")
          .set({
            name: req.body.name ? cleanName(req.body.name) : item.name,
            owner_id: nextOwnerId,
            parent_type: nextParent?.type ?? item.parent_type,
            parent_id: nextParent?.id ?? item.parent_id,
            updated_at: new Date().toISOString(),
            version: item.version + 1,
          })
          .where("id", "=", item.id)
          .where("version", "=", item.version)
          .executeTakeFirstOrThrow();
        await enqueueFileSearch(tx, item.id);
      });
      return { ok: true };
    },
  );

  api.get<{ Params: { id: string } }>(
    "/api/v1/files/folders/:id/shares",
    {
      schema: {
        tags: ["Files"],
        summary: "读取共享文件夹成员",
        params: Type.Object({ id: uuid }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const access = await folderAccess(db, actor, req.params.id, 1);
      if (access.folder.parent_id !== "shared")
        fail(400, "只有共享文件夹的第一层目录可以设置共享");
      const members = await db
        .selectFrom("file_folder_shares as s")
        .innerJoin("users as u", "u.id", "s.user_id")
        .select([
          "s.user_id",
          "s.role",
          "s.version",
          "u.display_name",
          "u.public_id",
        ])
        .where("s.folder_id", "=", req.params.id)
        .orderBy("u.display_name")
        .execute();
      const owner = await db
        .selectFrom("users")
        .select(["id", "display_name", "public_id"])
        .where("id", "=", access.folder.owner_id)
        .executeTakeFirst();
      const currentUser = await db
        .selectFrom("users")
        .select(["id", "display_name", "public_id"])
        .where("id", "=", actor.id)
        .executeTakeFirst();
      return {
        owner,
        currentUser,
        members,
        role: access.role,
        isOwner: access.role === "owner",
        canManage: access.role === "owner" || access.role === "admin",
      };
    },
  );

  api.get("/api/v1/files/shared-folders", async (req) => {
    const actor = auth(req);
    const candidates = await db
      .selectFrom("file_folders")
      .selectAll()
      .where("parent_id", "=", "shared")
      .where("deleted_at", "is", null)
      .orderBy("updated_at", "desc")
      .execute();
    const items = [];
    for (const folder of candidates) {
      let access: Awaited<ReturnType<typeof folderAccess>>;
      try {
        access = await folderAccess(db, actor, folder.id, 1);
        if (!await folderInSearch(db, actor, folder.id)) continue;
      } catch {
        continue;
      }
      const owner = await db
        .selectFrom("users")
        .select(["id", "display_name", "public_id"])
        .where("id", "=", folder.owner_id)
        .executeTakeFirst();
      const members = await db
        .selectFrom("file_folder_shares as s")
        .innerJoin("users as u", "u.id", "s.user_id")
        .select(["s.user_id", "s.role", "u.display_name", "u.public_id"])
        .where("s.folder_id", "=", folder.id)
        .orderBy("u.display_name")
        .execute();
      items.push({
        ...folder,
        type: "folder",
        virtual: false,
        locked: access.role === "reader",
        owner,
        members,
        role: access.role,
      });
    }
    return { items };
  });

  api.put<{
    Params: { id: string };
    Body: { userId: string; role: "admin" | "reader" };
  }>(
    "/api/v1/files/folders/:id/shares",
    {
      schema: {
        tags: ["Files"],
        summary: "新增或调整共享文件夹成员",
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          userId: Type.String({ minLength: 1, maxLength: 80 }),
          role: Type.Union([Type.Literal("admin"), Type.Literal("reader")]),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const access = await folderAccess(db, actor, req.params.id, 3);
      if (access.folder.parent_id !== "shared")
        fail(400, "只有共享文件夹的第一层目录可以设置共享");
      const target = await db
        .selectFrom("users")
        .select(["id", "status"])
        .where((eb) =>
          eb.or([
            eb("id", "=", req.body.userId),
            eb("public_id", "=", req.body.userId),
          ]),
        )
        .executeTakeFirst();
      if (!target || target.status !== "active")
        fail(404, "用户不存在或已停用");
      if (target.id === access.folder.owner_id)
        fail(400, "所有者不需要额外授权");
      const now = new Date().toISOString();
      const old = await db
        .selectFrom("file_folder_shares")
        .selectAll()
        .where("folder_id", "=", req.params.id)
        .where("user_id", "=", target.id)
        .executeTakeFirst();
      if (
        !canChangeMemberRole(
          folderAclRole(access.role),
          folderAclRole(old?.role),
          folderAclRole(req.body.role),
        )
      )
        fail(403, "只有所有者可以调整管理员权限");
      if (old) {
        await db
          .updateTable("file_folder_shares")
          .set({
            role: req.body.role,
            version: old.version + 1,
            updated_at: now,
          })
          .where("folder_id", "=", req.params.id)
          .where("user_id", "=", target.id)
          .where("version", "=", old.version)
          .executeTakeFirstOrThrow();
      } else {
        await db
          .insertInto("file_folder_shares")
          .values({
            folder_id: req.params.id,
            user_id: target.id,
            role: req.body.role,
            version: 1,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      return { ok: true };
    },
  );

  api.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/files/folders/:id/shares/:userId",
    {
      schema: {
        tags: ["Files"],
        summary: "取消共享文件夹成员",
        params: Type.Object({
          id: uuid,
          userId: Type.String({ minLength: 1, maxLength: 80 }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const access = await folderAccess(db, actor, req.params.id, 3);
      const member = await db
        .selectFrom("file_folder_shares")
        .select(["role"])
        .where("folder_id", "=", req.params.id)
        .where("user_id", "=", req.params.userId)
        .executeTakeFirst();
      if (
        !canChangeMemberRole(
          folderAclRole(access.role),
          folderAclRole(member?.role),
          null,
        )
      )
        fail(403, "只有所有者可以调整管理员权限");
      await db
        .deleteFrom("file_folder_shares")
        .where("folder_id", "=", req.params.id)
        .where("user_id", "=", req.params.userId)
        .execute();
      return { ok: true };
    },
  );

  api.get<{ Params: { id: string } }>(
    "/api/v1/files/folders/:id/share-link",
    {
      schema: {
        tags: ["Files"],
        summary: "读取共享文件夹分享链接",
        params: Type.Object({ id: uuid }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const access = await folderAccess(db, actor, req.params.id, 3);
      if (access.folder.parent_id !== "shared")
        fail(400, "只有共享文件夹根目录可以创建分享链接");
      const row = await db
        .selectFrom("file_folder_share_links")
        .selectAll()
        .where("folder_id", "=", req.params.id)
        .executeTakeFirst();
      return row
        ? {
            enabled: !!row.enabled,
            role: row.role,
            token: row.token,
            url: `#/shared-files/join?token=${row.token}`,
            isOwner: access.role === "owner",
          }
        : {
            enabled: false,
            role: "reader",
            token: null,
            url: null,
            isOwner: access.role === "owner",
          };
    },
  );

  api.put<{
    Params: { id: string };
    Body: { enabled: boolean; role: "admin" | "reader"; rotate?: boolean };
  }>(
    "/api/v1/files/folders/:id/share-link",
    {
      schema: {
        tags: ["Files"],
        summary: "设置共享文件夹分享链接",
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          enabled: Type.Boolean(),
          role: Type.Union([Type.Literal("admin"), Type.Literal("reader")]),
          rotate: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const access = await folderAccess(db, actor, req.params.id, 3);
      if (access.folder.parent_id !== "shared")
        fail(400, "只有共享文件夹根目录可以创建分享链接");
      if (req.body.role === "admin" && access.role !== "owner")
        fail(403, "只有所有者可以创建管理员分享链接");
      const old = await db
        .selectFrom("file_folder_share_links")
        .selectAll()
        .where("folder_id", "=", req.params.id)
        .executeTakeFirst();
      const token =
        !old || req.body.rotate
          ? randomBytes(32).toString("base64url")
          : old.token;
      const now = new Date().toISOString();
      const row: Schema["file_folder_share_links"] = {
        folder_id: req.params.id,
        token,
        token_hash: createHash("sha256").update(token).digest("hex"),
        role: req.body.role,
        enabled: Number(req.body.enabled),
        created_by: old?.created_by ?? actor.id,
        created_at: old?.created_at ?? now,
        updated_at: now,
      };
      await db
        .insertInto("file_folder_share_links")
        .values(row)
        .onConflict((oc) => oc.column("folder_id").doUpdateSet(row))
        .execute();
      return {
        enabled: !!row.enabled,
        role: row.role,
        token: row.token,
        url: `#/shared-files/join?token=${row.token}`,
        isOwner: access.role === "owner",
      };
    },
  );

  api.post<{ Body: { token: string } }>(
    "/api/v1/files/share/redeem",
    {
      schema: {
        tags: ["Files"],
        summary: "加入共享文件夹",
        body: Type.Object({
          token: Type.String({ minLength: 20, maxLength: 100 }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const hash = createHash("sha256").update(req.body.token).digest("hex");
      const link = await db
        .selectFrom("file_folder_share_links")
        .selectAll()
        .where("token_hash", "=", hash)
        .where("enabled", "=", 1)
        .executeTakeFirst();
      if (!link) fail(404, "分享链接不存在或已停用");
      const folder = await db
        .selectFrom("file_folders")
        .selectAll()
        .where("id", "=", link.folder_id)
        .where("parent_id", "=", "shared")
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!folder) fail(404, "共享文件夹不存在");
      if (folder.owner_id !== actor.id) {
        const old = await db
          .selectFrom("file_folder_shares")
          .selectAll()
          .where("folder_id", "=", folder.id)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        const role = old?.role === "admin" ? "admin" : link.role;
        const now = new Date().toISOString();
        const row: Schema["file_folder_shares"] = {
          folder_id: folder.id,
          user_id: actor.id,
          role,
          version: (old?.version ?? 0) + 1,
          created_at: old?.created_at ?? now,
          updated_at: now,
        };
        await db
          .insertInto("file_folder_shares")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["folder_id", "user_id"]).doUpdateSet(row),
          )
          .execute();
      }
      return { id: folder.id, name: folder.name };
    },
  );

  api.post<{
    Params: { id: string };
    Body: { parentType?: ParentType; parentId?: string; name?: string };
  }>(
    "/api/v1/files/items/:id/copy",
    {
      schema: {
        tags: ["Files"],
        summary: "复制文件信息记录",
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          parentType: Type.Optional(parentType),
          parentId: Type.Optional(Type.String({ maxLength: 80 })),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const source = await readableItem(db, actor, req.params.id);
      const parent: Parent = {
        type: req.body.parentType ?? "system",
        id: req.body.parentId ?? "root",
      };
      await parentOwner(db, actor, parent);
      const now = new Date().toISOString();
      const row: Schema["file_items"] = {
        id: randomUUID(),
        owner_id: actor.id,
        parent_type: parent.type,
        parent_id: parent.id,
        storage_object_id: source.storage_object_id,
        name: req.body.name ? cleanName(req.body.name) : source.name,
        mime: source.mime,
        size: source.size,
        metadata: source.metadata,
        ai_description_override: source.ai_description_override,
        locked: parent.type === "document" ? 1 : 0,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      };
      await db.insertInto("file_items").values(row).execute();
      await enqueueFileSearch(db, row.id);
      return { ...row, preview_url: `/api/v1/files/items/${row.id}/content` };
    },
  );

  api.post<{
    Params: { id: string };
    Body: { purpose: "attachment" | "ai_attachment"; resourceId?: string };
  }>(
    "/api/v1/files/items/:id/attach",
    {
      schema: {
        tags: ["Files"],
        summary: "从文件夹选择文件作为文档或 AI 附件",
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          purpose: Type.Union([
            Type.Literal("attachment"),
            Type.Literal("ai_attachment"),
          ]),
          resourceId: Type.Optional(uuid),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const source = await readableItem(db, actor, req.params.id);
      let ownerId = actor.id;
      if (req.body.purpose === "attachment") {
        if (!req.body.resourceId) fail(400, "文档附件需要目标文档");
        ownerId = (await authorize(db, actor, req.body.resourceId, 3)).resource
          .owner_id;
      } else if (req.body.resourceId) fail(400, "AI 对话附件不能关联文档");
      const now = new Date().toISOString();
      const assetId = randomUUID();
      await transact(db, async (tx) => {
        await tx
          .insertInto("assets")
          .values({
            id: assetId,
            owner_id: ownerId,
            resource_id: req.body.resourceId ?? null,
            purpose: req.body.purpose,
            profile_id: source.profile_id,
            object_key: source.object_key,
            filename: source.name,
            mime: source.mime,
            size: source.size,
            uploaded_by: actor.id,
            created_at: now,
            deleted_at: null,
          })
          .execute();
        const fileId = randomUUID();
        await tx
          .insertInto("file_items")
          .values({
            id: fileId,
            owner_id: ownerId,
            parent_type:
              req.body.purpose === "attachment" ? "document" : "system",
            parent_id:
              req.body.purpose === "attachment" ? req.body.resourceId! : "ai",
            storage_object_id: source.storage_object_id,
            name: source.name,
            mime: source.mime,
            size: source.size,
            metadata: JSON.stringify({
              assetId,
              resourceId: req.body.resourceId ?? null,
              copiedFrom: source.id,
            }),
            ai_description_override: source.ai_description_override,
            locked: req.body.purpose === "attachment" ? 1 : 0,
            version: 1,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            delete_batch: null,
          })
          .execute();
        await enqueueFileSearch(tx, fileId);
      });
      const extract = source.mime.startsWith("image/")
        ? { status: "ready" as const }
        : (beginFileExtract(db, source.storage_object_id, runtime),
          await loadFileExtract(db, source.storage_object_id));
      return {
        id: assetId,
        filename: source.name,
        mime: source.mime,
        size: source.size,
        extractStatus: extract?.status ?? "pending",
        preview: extract && "markdown" in extract ? extract.markdown.slice(0, 280) : undefined,
        description:
          source.ai_description_override ?? source.ai_description ?? undefined,
      };
    },
  );

  api.delete<{ Params: { id: string }; Body: { version: number } }>(
    "/api/v1/files/items/:id",
    {
      schema: {
        tags: ["Files"],
        summary: "将文件移入回收站",
        params: Type.Object({ id: uuid }),
        body: Type.Object({ version: Type.Integer({ minimum: 1 }) }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const item = await readableItem(db, actor, req.params.id);
      if (item.locked || isCopyOnlyParent(item.parent_type, item.parent_id))
        fail(403, "这个文件由系统或文档管理，不能删除");
      if (item.parent_type === "folder")
        await folderAccess(db, actor, item.parent_id, 3);
      if (item.version !== req.body.version)
        fail(409, "文件已变化，请刷新后重试");
      await db
        .updateTable("file_items")
        .set({
          deleted_at: new Date().toISOString(),
          delete_batch: randomUUID(),
          version: item.version + 1,
        })
        .where("id", "=", item.id)
        .where("version", "=", item.version)
        .executeTakeFirstOrThrow();
      await enqueueFileSearch(db, item.id);
      return { ok: true };
    },
  );

  api.patch<{
    Params: { id: string };
    Body: { name?: string; parentId?: string | null; version: number };
  }>(
    "/api/v1/files/folders/:id",
    {
      schema: {
        tags: ["Files"],
        summary: "重命名或移动文件夹",
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
          parentId: Type.Optional(
            Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
          ),
          version: Type.Integer({ minimum: 1 }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      await transact(db, async (tx) => {
        const access = await folderAccess(tx, actor, req.params.id, 3);
        const folder = access.folder;
        if (folder.version !== req.body.version)
          fail(409, "文件夹已变化，请刷新后重试");
        const parentId =
          req.body.parentId === undefined
            ? folder.parent_id
            : req.body.parentId;
        if (parentId === folder.id) fail(400, "不能把文件夹移动到自己里面");
        let nextOwnerId = folder.owner_id;
        if (parentId && parentId !== "shared") {
          const parent = (await folderAccess(tx, actor, parentId, 3)).folder;
          nextOwnerId = parent.owner_id;
          let cursor: string | null = parent.id;
          while (cursor) {
            if (cursor === folder.id)
              fail(400, "不能把文件夹移动到自己的子文件夹");
            cursor =
              (
                await tx
                  .selectFrom("file_folders")
                  .select("parent_id")
                  .where("id", "=", cursor)
                  .executeTakeFirst()
              )?.parent_id ?? null;
          }
        } else if (parentId === "shared" || parentId === null) {
          nextOwnerId = actor.id;
        }
        const allFolders = await tx
          .selectFrom("file_folders")
          .select(["id", "parent_id"])
          .where("deleted_at", "is", null)
          .execute();
        const ids = new Set<string>([folder.id]);
        for (let changed = true; changed;) {
          changed = false;
          for (const child of allFolders)
            if (
              child.parent_id &&
              ids.has(child.parent_id) &&
              !ids.has(child.id)
            ) {
              ids.add(child.id);
              changed = true;
            }
        }
        if (nextOwnerId !== folder.owner_id) {
          await tx
            .updateTable("file_folders")
            .set({ owner_id: nextOwnerId })
            .where("id", "in", [...ids])
            .execute();
          await tx
            .updateTable("file_items")
            .set({ owner_id: nextOwnerId })
            .where("parent_type", "=", "folder")
            .where("parent_id", "in", [...ids])
            .execute();
        }
        await tx
          .updateTable("file_folders")
          .set({
            name: req.body.name ? cleanName(req.body.name) : folder.name,
            parent_id: parentId,
            version: folder.version + 1,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", folder.id)
          .where("version", "=", folder.version)
          .executeTakeFirstOrThrow();
      });
      return { ok: true };
    },
  );

  api.post<{ Params: { id: string }; Body: { parentId?: string | null; name?: string } }>(
    "/api/v1/files/folders/:id/copy",
    {
      schema: {
        tags: ["Files"],
        summary: "复制文件夹及内容",
        params: Type.Object({ id: uuid }),
        body: Type.Object({
          parentId: Type.Optional(
            Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
          ),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const source = (await folderAccess(db, actor, req.params.id, 1)).folder;
      const targetParentId = req.body.parentId ?? null;
      const targetOwnerId = targetParentId
        ? targetParentId === "shared"
          ? actor.id
          : (await folderAccess(db, actor, targetParentId, 3)).folder.owner_id
        : actor.id;
      const now = new Date().toISOString();
      const copyBranch = async (
        tx: DB,
        folder: Schema["file_folders"],
        parentId: string | null,
        name = folder.name,
      ): Promise<string> => {
        const id = randomUUID();
        await tx
          .insertInto("file_folders")
          .values({
            id,
            owner_id: targetOwnerId,
            parent_id: parentId,
            name,
            version: 1,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            delete_batch: null,
          })
          .execute();
        const files = await tx
          .selectFrom("file_items")
          .selectAll()
          .where("parent_type", "=", "folder")
          .where("parent_id", "=", folder.id)
          .where("deleted_at", "is", null)
          .execute();
        for (const file of files) {
          const fileId = randomUUID();
          await tx
            .insertInto("file_items")
            .values({
              ...file,
              id: fileId,
              owner_id: targetOwnerId,
              parent_id: id,
              version: 1,
              created_at: now,
              updated_at: now,
              deleted_at: null,
              delete_batch: null,
            })
            .execute();
          await enqueueFileSearch(tx, fileId);
        }
        const children = await tx
          .selectFrom("file_folders")
          .selectAll()
          .where("parent_id", "=", folder.id)
          .where("deleted_at", "is", null)
          .execute();
        for (const child of children) await copyBranch(tx, child, id);
        return id;
      };
      const id = await transact(db, (tx) =>
        copyBranch(tx, source, targetParentId, req.body.name ? cleanName(req.body.name) : source.name),
      );
      return { id };
    },
  );

  api.delete<{ Params: { id: string }; Body: { version: number } }>(
    "/api/v1/files/folders/:id",
    {
      schema: {
        tags: ["Files"],
        summary: "将文件夹及内容移入回收站",
        params: Type.Object({ id: uuid }),
        body: Type.Object({ version: Type.Integer({ minimum: 1 }) }),
      },
    },
    async (req) => {
      const actor = auth(req);
      await transact(db, async (tx) => {
        const access = await folderAccess(tx, actor, req.params.id, 3);
        const root = access.folder;
        if (root.parent_id === "shared" && access.role !== "owner")
          fail(403, "共享管理员不能关闭共享");
        if (root.version !== req.body.version)
          fail(409, "文件夹已变化，请刷新后重试");
        const folders = await tx
          .selectFrom("file_folders")
          .selectAll()
          .where("owner_id", "=", root.owner_id)
          .where("deleted_at", "is", null)
          .execute();
        const ids = new Set([root.id]);
        for (let changed = true; changed;) {
          changed = false;
          for (const folder of folders)
            if (
              folder.parent_id &&
              ids.has(folder.parent_id) &&
              !ids.has(folder.id)
            ) {
              ids.add(folder.id);
              changed = true;
            }
        }
        const batch = randomUUID();
        const now = new Date().toISOString();
        const affectedFiles = await tx
          .selectFrom("file_items")
          .select("id")
          .where("owner_id", "=", root.owner_id)
          .where("parent_type", "=", "folder")
          .where("parent_id", "in", [...ids])
          .where("deleted_at", "is", null)
          .execute();
        await tx
          .updateTable("file_folders")
          .set({ deleted_at: now, delete_batch: batch, version: 2 })
          .where("id", "in", [...ids])
          .execute();
        await tx
          .updateTable("file_items")
          .set({ deleted_at: now, delete_batch: batch, version: 2 })
          .where("owner_id", "=", root.owner_id)
          .where("parent_type", "=", "folder")
          .where("parent_id", "in", [...ids])
          .where("deleted_at", "is", null)
          .execute();
        for (const file of affectedFiles) await enqueueFileSearch(tx, file.id);
      });
      return { ok: true };
    },
  );

  api.get<{ Params: { id: string } }>(
    "/api/v1/files/items/:id/info",
    {
      schema: {
        tags: ["Files"],
        summary: "读取文件完整信息",
        params: Type.Object({ id: uuid }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const row = await readableItem(db, actor, req.params.id);
      const object = await db
        .selectFrom("file_storage_objects")
        .selectAll()
        .where("id", "=", row.storage_object_id)
        .executeTakeFirstOrThrow();
      const derivatives = await db
        .selectFrom("file_derivatives")
        .select(["kind", "recipe", "mime", "size"])
        .where("source_id", "=", object.id)
        .execute();
      const job = await db
        .selectFrom("projection_jobs")
        .select(["attempts", "last_error", "lease_until"])
        .where("id", "=", `file-thumbnail:${object.id}`)
        .executeTakeFirst();
      return {
        category: filePolicy(object.mime, Number(object.size)).category,
        derivatives: derivatives.map((d) => ({
          ...d,
          url: `/api/v1/files/items/${row.id}/content?variant=thumbnail`,
        })),
        thumbnail_status: derivatives.some((d) => d.kind === "thumbnail")
          ? "ready"
          : job
            ? job.last_error
              ? "retrying"
              : "pending"
            : "skipped",
        id: row.id,
        owner_id: row.owner_id,
        parent_type: row.parent_type,
        parent_id: row.parent_id,
        storage_object_id: row.storage_object_id,
        name: row.name,
        mime: row.mime,
        size: row.size,
        metadata: JSON.parse(row.metadata || "{}"),
        ai_description_override: row.ai_description_override,
        locked:
          !!row.locked ||
          row.parent_type === "document" ||
          isCopyOnlyParent(row.parent_type, row.parent_id),
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        ai_description: row.ai_description_override ?? object.ai_description,
        ai_status: object.ai_status,
        extract_status: (await loadFileExtract(db, object.id))?.status,
        preview_url: `/api/v1/files/items/${row.id}/content`,
        storage: {
          profile_id: object.profile_id,
          object_key: object.object_key,
          sha256: object.sha256,
          ai_description: object.ai_description,
          ai_status: object.ai_status,
          ai_model: object.ai_model,
          ai_generated_at: object.ai_generated_at,
          created_at: object.created_at,
        },
      };
    },
  );

  api.post<{
    Body: {
      ids?: string[];
      parentType?: ParentType;
      parentId?: string;
      recursive?: boolean;
    };
  }>(
    "/api/v1/files/recognize",
    {
      schema: {
        tags: ["Files"],
        summary: "异步生成文件 AI 描述",
        body: Type.Object({
          ids: Type.Optional(Type.Array(uuid, { maxItems: 500 })),
          parentType: Type.Optional(parentType),
          parentId: Type.Optional(Type.String({ maxLength: 80 })),
          recursive: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const objectIds: string[] = [];
      const ownerByObject = new Map<string, string>();
      if (req.body.ids?.length) {
        for (const id of req.body.ids) {
          const item = await readableItem(db, actor, id);
          objectIds.push(item.storage_object_id);
          ownerByObject.set(item.storage_object_id, item.owner_id);
        }
      } else {
        const type = req.body.parentType ?? "system";
        const id = req.body.parentId ?? "root";
        if (type === "document") await authorize(db, actor, id, 1);
        let rows = db
          .selectFrom("file_items")
          .select(["storage_object_id", "owner_id"])
          .where("deleted_at", "is", null)
          .where("parent_type", "=", type);
        if (type === "system") {
          if (!["root", "ai", "shared"].includes(id))
            fail(403, "这个系统文件夹不支持批量识别");
          rows = rows.where("owner_id", "=", actor.id);
          if (id !== "root") rows = rows.where("parent_id", "=", id);
        } else if (type === "folder") {
          const folderIds = new Set<string>([id]);
          if (req.body.recursive !== false) {
            const folders = await db
              .selectFrom("file_folders")
              .select(["id", "parent_id"])
              .where("owner_id", "=", actor.id)
              .where("deleted_at", "is", null)
              .execute();
            for (let changed = true; changed;) {
              changed = false;
              for (const folder of folders)
                if (
                  folder.parent_id &&
                  folderIds.has(folder.parent_id) &&
                  !folderIds.has(folder.id)
                ) {
                  folderIds.add(folder.id);
                  changed = true;
                }
            }
          }
          rows = rows
            .where("owner_id", "=", actor.id)
            .where("parent_id", "in", [...folderIds]);
        } else {
          rows = rows.where("parent_id", "=", id);
        }
        for (const row of await rows.execute()) {
          objectIds.push(row.storage_object_id);
          ownerByObject.set(row.storage_object_id, row.owner_id);
        }
      }
      const unique = [...new Set(objectIds)];
      for (const id of unique)
        void enqueueRecognition([id], ownerByObject.get(id) ?? actor.id);
      return { accepted: true, count: unique.length };
    },
  );

  api.get("/api/v1/files/trash", async (req) => {
    const actor = auth(req);
    const folders = await db
      .selectFrom("file_folders")
      .selectAll()
      .where("owner_id", "=", actor.id)
      .where("deleted_at", "is not", null)
      .orderBy("deleted_at", "desc")
      .limit(500)
      .execute();
    const files = await db
      .selectFrom("file_items")
      .selectAll()
      .where("owner_id", "=", actor.id)
      .where("deleted_at", "is not", null)
      .orderBy("deleted_at", "desc")
      .limit(500)
      .execute();
    return {
      folders: folders.map((item) => ({
        id: item.id,
        kind: "folder",
        name: item.name,
        version: item.version,
        deletedAt: item.deleted_at,
        deleteBatch: item.delete_batch,
      })),
      files: files.map((item) => ({
        id: item.id,
        kind: "file",
        name: item.name,
        version: item.version,
        deletedAt: item.deleted_at,
        deleteBatch: item.delete_batch,
      })),
    };
  });

  api.post<{ Body: { kind: "folder" | "file"; id: string; version: number } }>(
    "/api/v1/files/trash/restore",
    {
      schema: {
        tags: ["Files"],
        summary: "恢复文件回收站内容",
        body: Type.Object({
          kind: Type.Union([Type.Literal("folder"), Type.Literal("file")]),
          id: uuid,
          version: Type.Integer({ minimum: 1 }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      await transact(db, async (tx) => {
        if (req.body.kind === "file") {
          const row = await tx
            .selectFrom("file_items")
            .selectAll()
            .where("id", "=", req.body.id)
            .where("owner_id", "=", actor.id)
            .where("deleted_at", "is not", null)
            .executeTakeFirst();
          if (!row) fail(404, "回收站文件不存在");
          if (row.version !== req.body.version)
            fail(409, "回收站内容已变化，请刷新");
          await tx
            .updateTable("file_items")
            .set({
              deleted_at: null,
              delete_batch: null,
              version: row.version + 1,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", row.id)
            .executeTakeFirstOrThrow();
          await enqueueFileSearch(tx, row.id);
          return;
        }
        const root = await tx
          .selectFrom("file_folders")
          .selectAll()
          .where("id", "=", req.body.id)
          .where("owner_id", "=", actor.id)
          .where("deleted_at", "is not", null)
          .executeTakeFirst();
        if (!root) fail(404, "回收站文件夹不存在");
        if (root.version !== req.body.version)
          fail(409, "回收站内容已变化，请刷新");
        const batch = root.delete_batch;
        await tx
          .updateTable("file_folders")
          .set({
            deleted_at: null,
            delete_batch: null,
            version: root.version + 1,
            updated_at: new Date().toISOString(),
          })
          .where("owner_id", "=", actor.id)
          .where((eb) =>
            eb.or([
              eb("id", "=", root.id),
              batch ? eb("delete_batch", "=", batch) : eb("id", "=", root.id),
            ]),
          )
          .execute();
        if (batch) {
          const restoredFiles = await tx
            .selectFrom("file_items")
            .select("id")
            .where("owner_id", "=", actor.id)
            .where("delete_batch", "=", batch)
            .execute();
          await tx
            .updateTable("file_items")
            .set({
              deleted_at: null,
              delete_batch: null,
              version: 1,
              updated_at: new Date().toISOString(),
            })
            .where("owner_id", "=", actor.id)
            .where("delete_batch", "=", batch)
            .execute();
          for (const file of restoredFiles)
            await enqueueFileSearch(tx, file.id);
        }
      });
      return { ok: true };
    },
  );

  api.post<{ Body: { kind: "folder" | "file"; id: string } }>(
    "/api/v1/files/trash/purge",
    {
      schema: {
        tags: ["Files"],
        summary: "永久删除文件回收站内容",
        body: Type.Object({
          kind: Type.Union([Type.Literal("folder"), Type.Literal("file")]),
          id: uuid,
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      await transact(db, async (tx) => {
        if (req.body.kind === "file") {
          const deleted = await tx
            .deleteFrom("file_items")
            .where("id", "=", req.body.id)
            .where("owner_id", "=", actor.id)
            .where("deleted_at", "is not", null)
            .executeTakeFirst();
          if (Number(deleted.numDeletedRows) < 1)
            fail(404, "回收站文件不存在");
          await enqueueFileSearch(tx, req.body.id);
          return;
        }
        const root = await tx
          .selectFrom("file_folders")
          .selectAll()
          .where("id", "=", req.body.id)
          .where("owner_id", "=", actor.id)
          .where("deleted_at", "is not", null)
          .executeTakeFirst();
        if (!root) fail(404, "回收站文件夹不存在");
        const rows = await tx
          .selectFrom("file_folders")
          .select(["id"])
          .where("owner_id", "=", actor.id)
          .where("deleted_at", "is not", null)
          .execute();
        const ids = new Set([root.id]);
        for (let changed = true; changed;) {
          changed = false;
          for (const row of rows)
            if (row.id !== root.id && !ids.has(row.id)) {
              const parent = await tx
                .selectFrom("file_folders")
                .select("parent_id")
                .where("id", "=", row.id)
                .executeTakeFirst();
              if (parent?.parent_id && ids.has(parent.parent_id)) {
                ids.add(row.id);
                changed = true;
              }
            }
        }
        const purgedFiles = await tx
          .selectFrom("file_items")
          .select("id")
          .where("owner_id", "=", actor.id)
          .where("parent_type", "=", "folder")
          .where("parent_id", "in", [...ids])
          .execute();
        for (const file of purgedFiles) await enqueueFileSearch(tx, file.id);
        await tx
          .deleteFrom("file_items")
          .where("owner_id", "=", actor.id)
          .where("parent_type", "=", "folder")
          .where("parent_id", "in", [...ids])
          .execute();
        await tx
          .deleteFrom("file_folders")
          .where("id", "in", [...ids])
          .where("owner_id", "=", actor.id)
          .execute();
      });
      return { ok: true };
    },
  );

  api.get<{
    Params: { id: string };
    Querystring: { download?: string; variant?: "thumbnail" };
  }>(
    "/api/v1/files/items/:id/content",
    {
      schema: {
        tags: ["Files"],
        summary: "读取或下载文件内容",
        params: Type.Object({ id: uuid }),
        querystring: Type.Object({
          download: Type.Optional(Type.Literal("1")),
          variant: Type.Optional(Type.Literal("thumbnail")),
        }),
      },
    },
    async (req, reply) => {
      const actor = auth(req);
      const row = await readableItem(db, actor, req.params.id);
      const object = await db
        .selectFrom("file_storage_objects")
        .selectAll()
        .where("id", "=", row.storage_object_id)
        .executeTakeFirstOrThrow();
      const selected =
        req.query.variant === "thumbnail"
          ? await thumbnailFor(db, object.object_key)
          : { ...object, filename: row.name };
      const profile = await db
        .selectFrom("storage_profiles")
        .selectAll()
        .where("id", "=", selected.profile_id)
        .executeTakeFirstOrThrow();
      reply.header("Cache-Control", "private, no-store");
      return sendFileContent(
        req,
        reply,
        storage,
        configOf(profile),
        selected,
        req.query.download === "1",
      );
    },
  );
}
