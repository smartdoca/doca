import type { DB, Schema } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { enqueueKnowledge } from "@core/modules/knowledge/service.js";
import { isRetiredKnowledgeSessionFile, readKnowledgeSessionFolder } from "@core/modules/knowledge/file-folders.js";
import {
  aiSessionFolderId,
  aiSessionIdFromFolderId,
  folderExplorerHref,
  isFileUuid,
} from "./file-locations.js";

type SessionFolderBinding =
  { sessionId: null; title: null } | { sessionId: string; title: string };

export const pendingAISessionFolder: SessionFolderBinding = {
  sessionId: null,
  title: null,
};

/** The explicit marker is written only for new AI entries. Old entries stay flat. */
export function readAISessionFolder(
  metadata: string,
): SessionFolderBinding | null {
  const value = JSON.parse(metadata).aiSessionFolder;
  if (value === undefined) return null;
  if (value?.sessionId === null && value?.title === null)
    return pendingAISessionFolder;
  if (
    typeof value?.sessionId === "string" &&
    isFileUuid(value.sessionId) &&
    typeof value.title === "string" &&
    value.title.length > 0
  )
    return { sessionId: value.sessionId, title: value.title };
  fail(500, "fileManager.invalidSessionBinding");
}

function describeSessionFolder(
  session: Pick<
    Schema["ai_sessions"],
    "id" | "title" | "revision" | "created_at" | "updated_at"
  >,
) {
  return {
    id: aiSessionFolderId(session.id),
    parent_id: "ai",
    name: session.title,
    type: "system" as const,
    virtual: true,
    locked: true,
    version: session.revision,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

export async function requireAISessionFolder(
  db: DB,
  userId: string,
  folderId: string,
) {
  const sessionId = aiSessionIdFromFolderId(folderId);
  if (!sessionId) fail(400, "fileManager.invalidSessionFolder");
  const session = await db
    .selectFrom("ai_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!session) fail(404, "fileManager.sessionFolderMissing");
  return describeSessionFolder(session);
}

export function aiSessionFolderLocation(
  folder: ReturnType<typeof describeSessionFolder>,
) {
  const navigation = [
    { type: "system" as const, id: "ai", name: "AI 助手" },
    { type: "system" as const, id: folder.id, name: folder.name },
  ];
  const path = `我的文件夹 / AI 助手 / ${folder.name}`;
  return {
    parentType: "system" as const,
    parentId: folder.id,
    parent_id: folder.id,
    name: folder.name,
    folderName: folder.name,
    location: path,
    path,
    navigation,
    href: folderExplorerHref({ navigation }),
    inMyFilesRoot: false,
    writable: false,
    copyOnly: true,
  };
}

export async function aiFileFolderLocation(
  db: DB,
  userId: string,
  file: {
    parent_type: string;
    parent_id: string;
    metadata: string;
  },
) {
  if (file.parent_type !== "system" || file.parent_id !== "ai") return null;
  const binding = readAISessionFolder(file.metadata);
  if (!binding?.sessionId) return null;
  return aiSessionFolderLocation(
    await requireAISessionFolder(
      db,
      userId,
      aiSessionFolderId(binding.sessionId),
    ),
  );
}

export async function projectAISessionFiles<T extends { metadata: string }>(
  db: DB,
  userId: string,
  files: T[],
) {
  const rootFiles: T[] = [];
  const sessionFiles = new Map<string, T[]>();
  for (const file of files) {
    if (isRetiredKnowledgeSessionFile(file.metadata) || readKnowledgeSessionFolder(file.metadata)) continue;
    const binding = readAISessionFolder(file.metadata);
    if (!binding?.sessionId) rootFiles.push(file);
    else {
      const entries = sessionFiles.get(binding.sessionId) ?? [];
      entries.push(file);
      sessionFiles.set(binding.sessionId, entries);
    }
  }
  const sessions = sessionFiles.size
    ? await db
        .selectFrom("ai_sessions")
        .selectAll()
        .where("id", "in", [...sessionFiles.keys()])
        .where("user_id", "=", userId)
        .orderBy("title")
        .execute()
    : [];
  return {
    rootFiles,
    sessionFiles,
    folders: sessions.map((session) => ({
      ...describeSessionFolder(session),
      fileCount: sessionFiles.get(session.id)!.length,
    })),
  };
}

/** Caller holds the AI user lock and submits the first turn atomically. */
export async function bindAISessionAttachments(
  db: DB,
  userId: string,
  session: { id: string; title: string },
  assetIds: string[],
) {
  if (!assetIds.length) return;
  const entries = await db
    .selectFrom("file_items")
    .select(["id", "metadata"])
    .where("owner_id", "=", userId)
    .where("parent_type", "=", "system")
    .where("parent_id", "=", "ai")
    .where("deleted_at", "is", null)
    .where("metadata", "like", '%"aiSessionFolder":%')
    .execute();
  const selected = new Set(assetIds);
  for (const entry of entries) {
    const metadata = JSON.parse(entry.metadata);
    const binding = readAISessionFolder(entry.metadata);
    if (
      !binding ||
      binding.sessionId !== null ||
      !selected.has(metadata.assetId)
    )
      continue;
    await db
      .updateTable("file_items")
      .set({
        metadata: JSON.stringify({
          ...metadata,
          aiSessionFolder: { sessionId: session.id, title: session.title },
        }),
      })
      .where("id", "=", entry.id)
      .execute();
  }
}

export async function aiJobSessionFolder(
  db: DB,
  userId: string,
  jobId?: string,
) {
  if (!jobId) return pendingAISessionFolder;
  const session = await db
    .selectFrom("ai_jobs as j")
    .innerJoin("ai_sessions as s", "s.id", "j.session_id")
    .select(["s.id", "s.title"])
    .where("j.id", "=", jobId)
    .where("j.user_id", "=", userId)
    .where("s.user_id", "=", userId)
    .executeTakeFirst();
  if (!session) fail(404, "fileManager.sessionFolderMissing");
  return { sessionId: session.id, title: session.title };
}

/** Remove only the new session-owned references; copied entries and physical objects remain. */
export async function deleteAISessionFiles(
  db: DB,
  userId: string,
  sessionId: string,
) {
  const entries = await db
    .selectFrom("file_items")
    .select(["id", "metadata"])
    .where("owner_id", "=", userId)
    .where("parent_type", "=", "system")
    .where("parent_id", "=", "ai")
    .where("metadata", "like", '%"aiSessionFolder":%')
    .execute();
  const selected = entries.filter(
    (entry) => readAISessionFolder(entry.metadata)?.sessionId === sessionId,
  );
  for (const entry of selected) {
    const { assetId } = JSON.parse(entry.metadata);
    if (typeof assetId === "string")
      await db
        .updateTable("assets")
        .set({ deleted_at: new Date().toISOString() })
        .where("id", "=", assetId)
        .where("owner_id", "=", userId)
        .where("purpose", "=", "ai_attachment")
        .where("resource_id", "is", null)
        .execute();
    await db.deleteFrom("file_items").where("id", "=", entry.id).execute();
    await db
      .deleteFrom("workspace_activity")
      .where("resource_kind", "=", "file")
      .where("resource_id", "=", entry.id)
      .execute();
    await enqueueProjection(db, "search-file", entry.id, { fileId: entry.id });
    await enqueueKnowledge(db, "file", entry.id);
  }
}
