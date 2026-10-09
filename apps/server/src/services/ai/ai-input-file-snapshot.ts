import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { readSnapshot } from "@db/transactions.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { authorize } from "@core/modules/access/queries.js";
import {
  authorizeFileFolder,
  authorizeFileItem,
} from "@core/modules/access/file-access.js";
import { folderInSearch } from "@core/modules/discovery/catalog.js";
import { AppError, fail } from "@core/shared/errors.js";
import {
  knowledgeFolderKind,
  projectKnowledgeSessionFiles,
  requireKnowledgeFolder,
} from "@core/modules/knowledge/file-folders.js";
import {
  aiSessionIdFromFolderId,
  isFileUuid,
  systemFolders,
} from "./file-locations.js";
import {
  projectAISessionFiles,
  requireAISessionFolder,
} from "./session-file-folders.js";

const referenceSchema = z
  .object({
    kind: z.enum(["file", "folder"]),
    id: z.string().min(1).max(80),
  })
  .strict();
const associations = z.array(referenceSchema).min(1);
export const aiInputFileSnapshotSchema = z
  .object({
    version: z.literal(1),
    references: z.array(referenceSchema),
    folders: z.array(
      z
        .object({
          folderId: z.string().min(1).max(80),
          parentType: z.enum(["system", "folder", "document"]),
          version: z.number().int().min(1),
          filename: z.string(),
          inputReferences: associations,
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          fileId: z.uuid(),
          storageObjectId: z.uuid(),
          version: z.number().int().min(1),
          mime: z.string().min(1),
          filename: z.string(),
          inputReferences: associations,
        })
        .strict(),
    ),
  })
  .strict();
export type AIInputFileSnapshot = z.infer<typeof aiInputFileSnapshotSchema>;
export type AIInputFileReference = z.infer<typeof referenceSchema> & {
  name?: string;
};
type Reference = z.infer<typeof referenceSchema>;
type Folder = {
  id: string;
  type: "system" | "folder" | "document";
  name: string;
  version: number;
  ownerId?: string;
};
const referenceKey = (reference: Reference) =>
  `${reference.kind}:${reference.id}`;
const compareReference = (a: Reference, b: Reference) =>
  referenceKey(a).localeCompare(referenceKey(b));
const inaccessible = (error: unknown) =>
  error instanceof AppError && [401, 403, 404].includes(error.status);
const documentRoots = new Set([
  "documents",
  "documents-personal",
  "documents-shared",
  "documents-libraries",
]);

function inputReferences(refs: readonly AIInputFileReference[]): Reference[] {
  const unique = new Map<string, Reference>();
  for (const input of refs) {
    // Client display names are not a source of file facts.
    const reference = referenceSchema.parse({ kind: input.kind, id: input.id });
    if (reference.kind === "file" && !isFileUuid(reference.id))
      fail(400, "文件引用必须使用完整文件 ID。");
    unique.set(referenceKey(reference), reference);
  }
  return [...unique.values()].sort(compareReference);
}

async function requireFolder(
  db: DB,
  actor: Actor,
  id: string,
): Promise<Folder> {
  {}
  if (id.startsWith("ai-session:")) {
    const folder = await requireAISessionFolder(db, actor.id, id);
    return { id, type: "system", name: folder.name, version: folder.version };
  }
  const system = systemFolders.find((folder) => folder.id === id);
  if (system) return { id, type: "system", name: system.name, version: 1 };
  if (documentRoots.has(id)) {
    const names: Record<string, string> = {
      "documents-personal": "个人文档",
      "documents-shared": "共享文档",
      "documents-libraries": "知识库",
    };
    return { id, type: "system", name: names[id]!, version: 1 };
  }
  if (id.startsWith("library:")) {
    const libraryId = id.slice("library:".length);
    if (!isFileUuid(libraryId)) fail(400, "知识库引用必须使用完整知识库 ID。");
    const { resource } = await authorize(db, actor, libraryId, 1);
    if (resource.kind !== "library") fail(400, "目录引用不是知识库。");
    return {
      id,
      type: "system",
      name: resource.title,
      version: resource.version,
    };
  }
  if (!isFileUuid(id)) fail(400, `不支持的文件夹引用：${id}`);
  const physical = await db
    .selectFrom("file_folders")
    .select("id")
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const document = await db
    .selectFrom("resources")
    .select("id")
    .where("id", "=", id)
    .where("kind", "=", "document")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (physical && document) fail(409, "文件夹与文档引用 ID 冲突。");
  if (physical) {
    const { folder } = await authorizeFileFolder(db, actor, id, 1);
    return {
      id,
      type: "folder",
      name: folder.name,
      version: folder.version,
      ownerId: folder.owner_id,
    };
  }
  if (document) {
    const { resource } = await authorize(db, actor, id, 1);
    return {
      id,
      type: "document",
      name: resource.title,
      version: resource.version,
    };
  }
  fail(404, "文件夹不存在或无权访问。");
}

/** Full host-owned enumeration. Run in the submission transaction, before storing a new job. */
export async function captureAIInputFileSnapshot(
  db: DB,
  actor: Actor,
  refs: readonly AIInputFileReference[],
): Promise<AIInputFileSnapshot> {
  if (!db.isTransaction)
    return readSnapshot(db, (tx) =>
      captureAIInputFileSnapshot(tx, actor, refs),
    );
  const references = inputReferences(refs);
  const files = new Map<string, AIInputFileSnapshot["files"][number]>();
  const folders = new Map<string, AIInputFileSnapshot["folders"][number]>();
  async function addFile(
    candidate: Schema["file_items"],
    reference: Reference,
  ) {
    const file = await authorizeFileItem(db, actor, candidate.id);
    const object = await db
      .selectFrom("file_storage_objects")
      .select("id")
      .where("id", "=", file.storage_object_id)
      .executeTakeFirst();
    if (!object) fail(409, "引用文件的原始存储对象不存在。");
    const fact = {
      fileId: file.id,
      storageObjectId: file.storage_object_id,
      version: file.version,
      mime: file.mime,
      filename: file.name,
      inputReferences: [reference],
    };
    const old = files.get(file.id);
    if (old) {
      if (
        old.storageObjectId !== fact.storageObjectId ||
        old.version !== fact.version ||
        old.mime !== fact.mime ||
        old.filename !== fact.filename
      )
        fail(409, "文件在记录任务来源时发生变化，请重新提交。");
      if (
        !old.inputReferences.some(
          (ref) => referenceKey(ref) === referenceKey(reference),
        )
      )
        old.inputReferences.push(reference);
    } else files.set(file.id, fact);
  }
  async function browse(
    id: string,
    reference: Reference,
    visited: Set<string>,
    ancestors = new Set<string>(),
  ) {
    const folder = await requireFolder(db, actor, id),
      key = `${folder.type}:${id}`;
    if (ancestors.has(key))
      fail(409, "来源文件夹层级存在循环，不能记录完整快照。");
    if (visited.has(key)) return;
    visited.add(key);
    ancestors.add(key);
    const old = folders.get(key);
    if (old) {
      if (
        !old.inputReferences.some(
          (ref) => referenceKey(ref) === referenceKey(reference),
        )
      )
        old.inputReferences.push(reference);
    } else
      folders.set(key, {
        folderId: id,
        parentType: folder.type,
        version: folder.version,
        filename: folder.name,
        inputReferences: [reference],
      });
    const children: string[] = [];
    let selected: Schema["file_items"][] = [];
    const knowledgeKind =
      folder.type === "system" ? knowledgeFolderKind(id) : null;
    const aiSessionId =
      folder.type === "system" ? aiSessionIdFromFolderId(id) : null;
    if (id === "ai" || aiSessionId) {
      const rows = await db
        .selectFrom("file_items")
        .selectAll()
        .where("owner_id", "=", actor.id)
        .where("parent_type", "=", "system")
        .where("parent_id", "=", "ai")
        .where("deleted_at", "is", null)
        .orderBy("id")
        .execute();
      const projection = await projectAISessionFiles(db, actor.id, rows);
      selected = aiSessionId
        ? (projection.sessionFiles.get(aiSessionId) ?? [])
        : projection.rootFiles;
      if (!aiSessionId)
        children.push(...projection.folders.map((item) => item.id));
    } else {
      let query = db
        .selectFrom("file_items")
        .selectAll()
        .where("deleted_at", "is", null)
        .where("parent_type", "=", folder.type)
        .where("parent_id", "=", id);
      if (folder.type === "folder")
        query = query.where("owner_id", "=", folder.ownerId!);
      else if (folder.type === "system")
        query = query.where("owner_id", "=", actor.id);
      selected = await query.orderBy("id").execute();
      if (folder.type === "folder" || id === "root") {
        let query = db
          .selectFrom("file_folders")
          .select("id")
          .where("deleted_at", "is", null)
          .where(
            "owner_id",
            "=",
            folder.type === "folder" ? folder.ownerId! : actor.id,
          );
        query =
          folder.type === "folder"
            ? query.where("parent_id", "=", id)
            : query.where((eb) =>
                eb.or([
                  eb("parent_id", "is", null),
                  eb("parent_id", "=", ""),
                  eb("parent_id", "=", "root"),
                ]),
              );
        children.push(
          ...(await query.orderBy("id").execute()).map((item) => item.id),
        );
        if (id === "root")
          children.push(
            ...systemFolders
              .filter((item) => item.id !== "root")
              .map((item) => item.id),
          );
      } else if (id === "shared") {
        const candidates = await db
          .selectFrom("file_folders")
          .select(["id", "owner_id"])
          .where("parent_id", "=", "shared")
          .where("deleted_at", "is", null)
          .orderBy("id")
          .execute();
        for (const candidate of candidates) {
          try {
            if (
              candidate.owner_id === actor.id ||
              (await folderInSearch(db, actor, candidate.id))
            )
              children.push(candidate.id);
          } catch (error) {
            if (!inaccessible(error)) throw error;
          }
        }
      } else if (id === "documents") {
        children.push(
          "documents-personal",
          "documents-shared",
          "documents-libraries",
        );
      } else if (
        id === "documents-personal" ||
        id === "documents-shared" ||
        id === "documents-libraries"
      ) {
        let query = db
          .selectFrom("resources")
          .select("id")
          .where("deleted_at", "is", null)
          .where(
            "kind",
            "=",
            id === "documents-libraries" ? "library" : "document",
          );
        if (id !== "documents-libraries")
          query = query
            .where("library_id", "is", null)
            .where(
              "owner_id",
              id === "documents-personal" ? "=" : "!=",
              actor.id,
            );
        for (const resource of await query.orderBy("id").execute()) {
          try {
            await authorize(db, actor, resource.id, 1);
            children.push(
              id === "documents-libraries"
                ? `library:${resource.id}`
                : resource.id,
            );
          } catch (error) {
            if (!inaccessible(error)) throw error;
          }
        }
      } else if (id.startsWith("library:") || folder.type === "document") {
        let query = db
          .selectFrom("resources")
          .select("id")
          .where("kind", "=", "document")
          .where("deleted_at", "is", null);
        if (folder.type === "document")
          query = query.where("parent_id", "=", id);
        else {
          const libraryId = id.slice("library:".length);
          query = query
            .where("library_id", "=", libraryId)
            .where("parent_id", "is", null);

        }
        for (const resource of await query.orderBy("id").execute()) {
          try {
            await authorize(db, actor, resource.id, 1);
            children.push(resource.id);
          } catch (error) {
            if (!inaccessible(error)) throw error;
          }
        }
      }
    }
    for (const file of selected) await addFile(file, reference);
    for (const child of children.sort())
      await browse(child, reference, visited, ancestors);
    ancestors.delete(key);
  }
  for (const reference of references) {
    if (reference.kind === "file")
      await addFile(
        await authorizeFileItem(db, actor, reference.id),
        reference,
      );
    else await browse(reference.id, reference, new Set());
  }
  for (const fact of [...files.values(), ...folders.values()])
    fact.inputReferences.sort(compareReference);
  return aiInputFileSnapshotSchema.parse({
    version: 1,
    references,
    folders: [...folders.values()].sort((a, b) =>
      `${a.parentType}:${a.folderId}`.localeCompare(
        `${b.parentType}:${b.folderId}`,
      ),
    ),
    files: [...files.values()].sort((a, b) => a.fileId.localeCompare(b.fileId)),
  });
}

/** Verify frozen members only; never recapture an old job or include new directory members. */
export async function verifyAIInputFileSnapshot(
  db: DB,
  actor: Actor,
  refs: readonly AIInputFileReference[],
  value: unknown,
): Promise<AIInputFileSnapshot> {
  if (!db.isTransaction)
    return readSnapshot(db, (tx) =>
      verifyAIInputFileSnapshot(tx, actor, refs, value),
    );
  const parsed = aiInputFileSnapshotSchema.safeParse(value);
  if (!parsed.success)
    fail(
      409,
      "任务缺少完整的 version:1 文件来源快照，不能继续；请重新提交新任务。",
    );
  const snapshot = parsed.data,
    references = inputReferences(refs);
  if (JSON.stringify(snapshot.references) !== JSON.stringify(references))
    fail(409, "任务来源引用与冻结快照不一致。");
  const keys = new Set(references.map(referenceKey)),
    fileIds = new Set<string>(),
    folderIds = new Set<string>();
  function checkAssociations(items: Reference[]) {
    const seen = new Set<string>();
    for (const ref of items) {
      const key = referenceKey(ref);
      if (!keys.has(key) || seen.has(key))
        fail(409, "文件来源快照包含无效或重复的原始引用。");
      seen.add(key);
    }
  }
  for (const folder of snapshot.folders) {
    checkAssociations(folder.inputReferences);
    const key = `${folder.parentType}:${folder.folderId}`;
    if (
      folderIds.has(key) ||
      folder.inputReferences.some((ref) => ref.kind !== "folder")
    )
      fail(409, "文件夹来源快照关联无效。");
    folderIds.add(key);
    const current = await requireFolder(db, actor, folder.folderId);
    if (current.type !== folder.parentType)
      fail(409, "来源目录类型发生变化，请重新提交任务。");
  }
  for (const fact of snapshot.files) {
    checkAssociations(fact.inputReferences);
    if (
      fileIds.has(fact.fileId) ||
      fact.inputReferences.some(
        (ref) => ref.kind === "file" && ref.id !== fact.fileId,
      )
    )
      fail(409, "文件来源快照关联无效。");
    fileIds.add(fact.fileId);
    const file = await authorizeFileItem(db, actor, fact.fileId);
    if (
      file.storage_object_id !== fact.storageObjectId ||
      file.version !== fact.version ||
      file.mime !== fact.mime ||
      file.name !== fact.filename
    )
      fail(409, "任务引用文件已发生变化，请重新提交新任务。");
    if (
      !(await db
        .selectFrom("file_storage_objects")
        .select("id")
        .where("id", "=", fact.storageObjectId)
        .executeTakeFirst())
    )
      fail(409, "引用文件的原始存储对象不存在。");
  }
  for (const reference of references) {
    if (reference.kind === "file") {
      if (
        !snapshot.files.some(
          (file) =>
            file.fileId === reference.id &&
            file.inputReferences.some(
              (ref) => referenceKey(ref) === referenceKey(reference),
            ),
        )
      )
        fail(409, "文件引用未包含在完整来源快照中。");
    } else if (
      !snapshot.folders.some(
        (folder) =>
          folder.folderId === reference.id &&
          folder.inputReferences.some(
            (ref) => referenceKey(ref) === referenceKey(reference),
          ),
      )
    )
      fail(409, "文件夹引用未包含在完整来源快照中。");
  }
  return snapshot;
}
