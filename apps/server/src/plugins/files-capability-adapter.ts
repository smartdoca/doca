import { pluginServices } from "@core/shared/plugin-services.js";
import { createHash, randomUUID } from "node:crypto";
import {
  createFilesProviderV1,
  stableId,
  type FileBindingOperationsV1,
  type FileByteRange,
  type FileFolder,
  type FileId,
  type FileRecord,
  type FileUpload,
  type FilesRequestContext,
  type FilesServiceV1,
} from "@doca/files-capability";
import { authorize } from "@core/modules/access/queries.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { fail } from "@core/shared/errors.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  createStorage,
  storageDefaults,
  type StorageConfig,
  type StorageRuntime,
} from "../adapters/storage.js";
import { storeUserFile } from "../services/ai/file-write.js";

interface PendingUpload {
  readonly principalId: string;
  readonly id: string;
  readonly filename: string;
  readonly mime?: string;
  readonly declaredSize?: number;
  readonly checksum?: string;
  readonly createdAt: string;
  bytes: Buffer;
  state: FileUpload["state"];
  completedAt?: string;
}

const cleanName = (value: string) => {
  const name = value.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  return (name || "未命名").slice(0, 255);
};

const folderRecord = (row: Schema["file_folders"]): FileFolder => ({
  id: stableId(row.id, "folder"),
  parentId: row.parent_id ? stableId(row.parent_id, "folder") : null,
  name: row.name,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const fileRecord = (row: Schema["file_items"]): FileRecord => ({
  id: stableId(row.id, "file"),
  folderId:
    row.parent_type === "folder" ? stableId(row.parent_id, "folder") : null,
  name: row.name,
  mime: row.mime,
  size: Number(row.size),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const uploadRecord = (upload: PendingUpload): FileUpload => ({
  id: stableId(upload.id, "file-upload"),
  filename: upload.filename,
  ...(upload.mime ? { declaredMime: upload.mime } : {}),
  ...(upload.declaredSize === undefined
    ? {}
    : { declaredSize: upload.declaredSize }),
  receivedBytes: upload.bytes.byteLength,
  state: upload.state,
  createdAt: upload.createdAt,
  ...(upload.completedAt ? { completedAt: upload.completedAt } : {}),
});

async function actorFor(db: DB, context: FilesRequestContext): Promise<Actor> {
  if (!context.principalId) fail(401, "需要登录");
  const actor = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", context.principalId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) fail(401, "账号不可用");
  context.signal?.throwIfAborted();
  return actor;
}

async function folderAccess(
  db: DB,
  actor: Actor,
  folderId: string,
  write = false,
) {
  const folder = await db
    .selectFrom("file_folders")
    .selectAll()
    .where("id", "=", folderId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!folder) fail(404, "文件夹不存在");
  if (folder.owner_id === actor.id) return folder;
  let root = folder;
  const seen = new Set<string>();
  while (root.parent_id && root.parent_id !== "shared") {
    if (seen.has(root.id)) fail(409, "文件夹层级无效");
    seen.add(root.id);
    const parent = await db
      .selectFrom("file_folders")
      .selectAll()
      .where("id", "=", root.parent_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!parent) fail(404, "文件夹不存在");
    root = parent;
  }
  const share = await db
    .selectFrom("file_folder_shares")
    .selectAll()
    .where("folder_id", "=", root.id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  if (!share || (write && share.role !== "admin"))
    fail(404, "文件夹不存在");
  return folder;
}

async function fileAccess(
  db: DB,
  actor: Actor,
  fileId: string,
  write = false,
) {
  const file = await db
    .selectFrom("file_items")
    .selectAll()
    .where("id", "=", fileId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!file) fail(404, "文件不存在");
  if (file.parent_type === "document") {
    await authorize(db, actor, file.parent_id, write ? 3 : 1);
  } else if (file.parent_type === "folder") {
    await folderAccess(db, actor, file.parent_id, write);
  } else if (file.owner_id !== actor.id) {
    fail(404, "文件不存在");
  }
  return file;
}

function assertVersion(actual: number, expected: number) {
  if (actual !== expected) fail(409, "版本已变化，请刷新后重试");
}

export function createServerFilesCapability(
  db: DB,
  runtime: StorageRuntime,
): FilesServiceV1 {
  const uploads = new Map<string, PendingUpload>();
  const bindings: FileBindingOperationsV1 = {
    async bind(context, input) {
      const actor = await actorFor(db, context);
      await fileAccess(db, actor, input.fileId, true);
      const existing = await db
        .selectFrom("file_bindings")
        .selectAll()
        .where("file_id", "=", input.fileId)
        .where("owner_plugin", "=", input.owner.ownerPlugin)
        .where("owner_type", "=", input.owner.ownerType)
        .where("owner_id", "=", input.owner.ownerId)
        .where("role", "=", input.owner.role)
        .executeTakeFirst();
      const row =
        existing ??
        ({
          id: randomUUID(),
          file_id: input.fileId,
          owner_plugin: input.owner.ownerPlugin,
          owner_type: input.owner.ownerType,
          owner_id: input.owner.ownerId,
          role: input.owner.role,
          created_at: new Date().toISOString(),
        } satisfies Schema["file_bindings"]);
      if (!existing)
        await db
          .insertInto("file_bindings")
          .values(row)
          .onConflict((conflict) =>
            conflict
              .columns([
                "file_id",
                "owner_plugin",
                "owner_type",
                "owner_id",
                "role",
              ])
              .doNothing(),
          )
          .execute();
      return {
        id: stableId(row.id, "file-binding"),
        fileId: stableId(row.file_id, "file"),
        ownerPlugin: row.owner_plugin,
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        role: row.role,
        createdAt: row.created_at,
      };
    },
    async unbind(context, input) {
      const actor = await actorFor(db, context);
      await fileAccess(db, actor, input.fileId, true);
      const result = await db
        .deleteFrom("file_bindings")
        .where("file_id", "=", input.fileId)
        .where("owner_plugin", "=", input.owner.ownerPlugin)
        .where("owner_type", "=", input.owner.ownerType)
        .where("owner_id", "=", input.owner.ownerId)
        .where("role", "=", input.owner.role)
        .executeTakeFirst();
      return { removed: result.numDeletedRows > 0n };
    },
    async list(context, input) {
      const actor = await actorFor(db, context);
      let rows: Schema["file_bindings"][];
      if (input.fileId) {
        await fileAccess(db, actor, input.fileId);
        rows = await db
          .selectFrom("file_bindings")
          .selectAll()
          .where("file_id", "=", input.fileId)
          .execute();
      } else {
        const owner = input.owner;
        if (!owner) fail(400, "需要文件绑定筛选条件");
        let query = db
          .selectFrom("file_bindings as b")
          .innerJoin("file_items as f", "f.id", "b.file_id")
          .selectAll("b")
          .where("f.owner_id", "=", actor.id)
          .where("f.deleted_at", "is", null);
        if (owner.ownerPlugin)
          query = query.where(
            "b.owner_plugin",
            "=",
            owner.ownerPlugin,
          );
        if (owner.ownerType)
          query = query.where("b.owner_type", "=", owner.ownerType);
        if (owner.ownerId)
          query = query.where("b.owner_id", "=", owner.ownerId);
        if (owner.role)
          query = query.where("b.role", "=", owner.role);
        rows = await query.execute();
      }
      return rows.map((row) => ({
        id: stableId(row.id, "file-binding"),
        fileId: stableId(row.file_id, "file"),
        ownerPlugin: row.owner_plugin,
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        role: row.role,
        createdAt: row.created_at,
      }));
    },
  };

  const contentRow = async (
    context: FilesRequestContext,
    fileId: FileId,
    bindingId?: string,
  ) => {
    const actor = await actorFor(db, context);
    let file;
    if (bindingId) {
      const binding = await db.selectFrom("file_bindings").selectAll().where("id", "=", bindingId).where("file_id", "=", fileId).executeTakeFirst();
      if (!binding) fail(404, "File binding unavailable");
      const source = pluginServices(db).permissions.get(`${binding.owner_plugin}.${binding.owner_type}`);
      if (!source || !await source.authorize(actor.id, binding.owner_id, "file.read")) fail(404, "File binding unavailable");
      file = await db.selectFrom("file_items").selectAll().where("id", "=", fileId).where("deleted_at", "is", null).executeTakeFirst();
      if (!file) fail(404, "File unavailable");
    } else file = await fileAccess(db, actor, fileId);
    const object = await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", file.storage_object_id)
      .executeTakeFirstOrThrow();
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("id", "=", object.profile_id)
      .executeTakeFirstOrThrow();
    const config = {
      ...storageDefaults,
      ...JSON.parse(profile.config),
      provider: profile.provider,
    } as StorageConfig;
    return { file, object, config };
  };

  return createFilesProviderV1({
    folders: {
      async create(context, input) {
        const actor = await actorFor(db, context);
        const parent = input.parentId
          ? await folderAccess(db, actor, input.parentId, true)
          : undefined;
        const now = new Date().toISOString();
        const row: Schema["file_folders"] = {
          id: randomUUID(),
          owner_id: parent?.owner_id ?? actor.id,
          parent_id: input.parentId,
          name: cleanName(input.name),
          version: 1,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          delete_batch: null,
        };
        await db.insertInto("file_folders").values(row).execute();
        return folderRecord(row);
      },
      async get(context, input) {
        const actor = await actorFor(db, context);
        return folderRecord(await folderAccess(db, actor, input.folderId));
      },
      async list(context, input) {
        const actor = await actorFor(db, context);
        if (input.parentId) await folderAccess(db, actor, input.parentId);
        const limit = Math.min(200, Math.max(1, input.limit ?? 50));
        let query = db
          .selectFrom("file_folders")
          .selectAll()
          .where("owner_id", "=", actor.id)
          .where("deleted_at", "is", null)
          .orderBy("id")
          .limit(limit + 1);
        query =
          input.parentId === null
            ? query.where((eb) =>
                eb.or([
                  eb("parent_id", "is", null),
                  eb("parent_id", "=", ""),
                  eb("parent_id", "=", "root"),
                ]),
              )
            : query.where("parent_id", "=", input.parentId);
        if (input.cursor) query = query.where("id", ">", input.cursor);
        const rows = await query.execute();
        return {
          items: rows.slice(0, limit).map(folderRecord),
          cursor: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      },
      async update(context, input) {
        const actor = await actorFor(db, context);
        const row = await folderAccess(db, actor, input.folderId, true);
        assertVersion(row.version, input.expectedVersion);
        if (input.parentId) await folderAccess(db, actor, input.parentId, true);
        const updated = {
          ...row,
          ...(input.name === undefined
            ? {}
            : { name: cleanName(input.name) }),
          ...(input.parentId === undefined
            ? {}
            : { parent_id: input.parentId }),
          version: row.version + 1,
          updated_at: new Date().toISOString(),
        };
        await db
          .updateTable("file_folders")
          .set(updated)
          .where("id", "=", row.id)
          .where("version", "=", row.version)
          .executeTakeFirstOrThrow();
        return folderRecord(updated);
      },
      async delete(context, input) {
        const actor = await actorFor(db, context);
        const row = await folderAccess(db, actor, input.folderId, true);
        assertVersion(row.version, input.expectedVersion);
        if (!input.recursive) {
          const child = await db
            .selectFrom("file_folders")
            .select("id")
            .where("parent_id", "=", row.id)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
          if (child) fail(409, "文件夹非空");
        }
        await db
          .updateTable("file_folders")
          .set({
            deleted_at: new Date().toISOString(),
            delete_batch: randomUUID(),
            version: row.version + 1,
          })
          .where("id", "=", row.id)
          .where("version", "=", row.version)
          .execute();
      },
    },
    files: {
      async create(context, input) {
        const actor = await actorFor(db, context);
        const parent = input.folderId
          ? await folderAccess(db, actor, input.folderId, true)
          : undefined;
        if ("sourceFileId" in input && input.sourceFileId) {
          const source = await fileAccess(db, actor, input.sourceFileId);
          const now = new Date().toISOString();
          const row: Schema["file_items"] = {
            ...source,
            id: randomUUID(),
            owner_id: parent?.owner_id ?? actor.id,
            parent_type: input.folderId ? "folder" : "system",
            parent_id: input.folderId ?? "root",
            name: cleanName(input.name),
            version: 1,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            delete_batch: null,
          };
          await db.insertInto("file_items").values(row).execute();
          await enqueueProjection(db, "search-file", row.id, {
            fileId: row.id,
          });
          return fileRecord(row);
        }
        const uploadId = input.uploadId;
        if (!uploadId) fail(400, "需要已完成的上传");
        const upload = uploads.get(uploadId);
        if (
          !upload ||
          upload.principalId !== actor.id ||
          upload.state !== "completed"
        )
          fail(409, "上传尚未完成或已失效");
        const row = await storeUserFile(db, {
          actorId: actor.id,
          ownerId: parent?.owner_id ?? actor.id,
          parentType: input.folderId ? "folder" : "system",
          parentId: input.folderId ?? "root",
          filename: input.name,
          mime: upload.mime ?? "application/octet-stream",
          body: upload.bytes,
          storage: runtime,
        });
        uploads.delete(upload.id);
        return fileRecord(row);
      },
      async get(context, input) {
        const actor = await actorFor(db, context);
        return fileRecord(await fileAccess(db, actor, input.fileId));
      },
      async list(context, input) {
        const actor = await actorFor(db, context);
        if (input.folderId) await folderAccess(db, actor, input.folderId);
        const limit = Math.min(200, Math.max(1, input.limit ?? 50));
        let query = db
          .selectFrom("file_items")
          .selectAll()
          .where("owner_id", "=", actor.id)
          .where("deleted_at", "is", null)
          .where(
            "parent_type",
            "=",
            input.folderId ? "folder" : "system",
          )
          .where("parent_id", "=", input.folderId ?? "root")
          .orderBy("id")
          .limit(limit + 1);
        if (input.cursor) query = query.where("id", ">", input.cursor);
        const rows = await query.execute();
        return {
          items: rows.slice(0, limit).map(fileRecord),
          cursor: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      },
      async update(context, input) {
        const actor = await actorFor(db, context);
        const row = await fileAccess(db, actor, input.fileId, true);
        assertVersion(row.version, input.expectedVersion);
        if (input.folderId) await folderAccess(db, actor, input.folderId, true);
        const updated = {
          ...row,
          ...(input.name === undefined
            ? {}
            : { name: cleanName(input.name) }),
          ...(input.folderId === undefined
            ? {}
            : {
                parent_type: input.folderId ? ("folder" as const) : ("system" as const),
                parent_id: input.folderId ?? "root",
              }),
          version: row.version + 1,
          updated_at: new Date().toISOString(),
        };
        await db
          .updateTable("file_items")
          .set(updated)
          .where("id", "=", row.id)
          .where("version", "=", row.version)
          .executeTakeFirstOrThrow();
        await enqueueProjection(db, "search-file", row.id, {
          fileId: row.id,
        });
        return fileRecord(updated);
      },
      async delete(context, input) {
        const actor = await actorFor(db, context);
        const row = await fileAccess(db, actor, input.fileId, true);
        assertVersion(row.version, input.expectedVersion);
        await db
          .updateTable("file_items")
          .set({
            deleted_at: new Date().toISOString(),
            delete_batch: randomUUID(),
            version: row.version + 1,
          })
          .where("id", "=", row.id)
          .where("version", "=", row.version)
          .execute();
        await enqueueProjection(db, "search-file", row.id, {
          fileId: row.id,
        });
      },
    },
    uploads: {
      async begin(context, input) {
        const actor = await actorFor(db, context);
        if (input.size !== undefined && input.size > 20 * 1024 * 1024)
          fail(413, "文件超过上传大小限制");
        const upload: PendingUpload = {
          principalId: actor.id,
          id: randomUUID(),
          filename: cleanName(input.filename),
          ...(input.mime ? { mime: input.mime } : {}),
          ...(input.size === undefined ? {} : { declaredSize: input.size }),
          ...(input.checksum ? { checksum: input.checksum } : {}),
          createdAt: new Date().toISOString(),
          bytes: Buffer.alloc(0),
          state: "open",
        };
        uploads.set(upload.id, upload);
        return uploadRecord(upload);
      },
      async write(context, input) {
        const actor = await actorFor(db, context);
        const upload = uploads.get(input.uploadId);
        if (
          !upload ||
          upload.principalId !== actor.id ||
          upload.state !== "open"
        )
          fail(404, "上传会话不存在");
        if (input.offset !== upload.bytes.byteLength)
          fail(409, "上传偏移不连续");
        if (upload.bytes.byteLength + input.bytes.byteLength > 20 * 1024 * 1024)
          fail(413, "文件超过上传大小限制");
        upload.bytes = Buffer.concat([upload.bytes, Buffer.from(input.bytes)]);
        return uploadRecord(upload);
      },
      async complete(context, input) {
        const actor = await actorFor(db, context);
        const upload = uploads.get(input.uploadId);
        if (
          !upload ||
          upload.principalId !== actor.id ||
          upload.state !== "open"
        )
          fail(404, "上传会话不存在");
        if (
          upload.declaredSize !== undefined &&
          upload.declaredSize !== upload.bytes.byteLength
        )
          fail(409, "上传大小与声明不一致");
        const checksum = input.checksum ?? upload.checksum;
        if (
          checksum &&
          createHash("sha256").update(upload.bytes).digest("hex") !== checksum
        )
          fail(409, "上传校验和不一致");
        upload.state = "completed";
        upload.completedAt = new Date().toISOString();
        return {
          ...uploadRecord(upload),
          state: "completed" as const,
          completedAt: upload.completedAt,
        };
      },
      async abort(context, input) {
        const actor = await actorFor(db, context);
        const upload = uploads.get(input.uploadId);
        if (upload?.principalId === actor.id) uploads.delete(input.uploadId);
      },
      async get(context, input) {
        const actor = await actorFor(db, context);
        const upload = uploads.get(input.uploadId);
        return upload?.principalId === actor.id ? uploadRecord(upload) : null;
      },
    },
    bindings,
    content: {
      async read(context, input) {
        const { file, object, config } = await contentRow(
          context,
          input.fileId,
          input.bindingId,
        );
        const bytes = await createStorage(runtime).read(
          config,
          object.object_key,
        );
        const range: FileByteRange | undefined = input.range;
        const start = Math.max(0, range?.start ?? 0);
        const end = Math.min(
          bytes.byteLength - 1,
          range?.end ?? bytes.byteLength - 1,
        );
        if (start > end || start >= bytes.byteLength)
          fail(416, "文件范围无效");
        const selected = bytes.subarray(start, end + 1);
        return {
          file: fileRecord(file),
          body: (async function* () {
            context.signal?.throwIfAborted();
            yield selected;
          })(),
          ...(range
            ? { range: { start, end, total: bytes.byteLength } }
            : {}),
        };
      },
      async resolveContent(context, input) {
        const { file } = await contentRow(context, input.fileId, input.bindingId);
        return {
          fileId: stableId(file.id, "file"),
          href: input.bindingId ? `/api/v1/plugin-file-bindings/${encodeURIComponent(input.bindingId)}/content` : `/api/v1/files/items/${encodeURIComponent(file.id)}/content`,
          method: "GET" as const,
          filename: file.name,
          mime: file.mime,
          size: Number(file.size),
          disposition: "inline" as const,
        };
      },
      async resolveDownload(context, input) {
        const { file } = await contentRow(context, input.fileId, input.bindingId);
        const filename = input.filename ?? file.name;
        return {
          fileId: stableId(file.id, "file"),
          href: input.bindingId ? `/api/v1/plugin-file-bindings/${encodeURIComponent(input.bindingId)}/content?download=1` : `/api/v1/files/items/${encodeURIComponent(file.id)}/content?download=1&filename=${encodeURIComponent(filename)}`,
          method: "GET" as const,
          filename,
          mime: file.mime,
          size: Number(file.size),
          disposition: "attachment" as const,
        };
      },
    },
  });
}
