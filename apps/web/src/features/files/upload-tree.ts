import { api } from "@web/shared/api.js";
import type { DroppedUpload } from "@web/features/files/file-interactions.js";

type FolderRow = { id: string; name: string };

async function ensureFolder(
  name: string,
  parentId: string | null,
  conflict: "merge" | "create-new",
) {
  if (conflict === "create-new") {
    let conflictError: unknown;
    for (let suffix = 0; suffix < 10000; suffix++) {
      const candidate = suffix
        ? `${Array.from(name).slice(0, 220).join("")} (${suffix + 1})`
        : name;
      try {
        return await api<FolderRow>("/files/folders", "POST", {
          name: candidate,
          parentId,
        });
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error;
        conflictError = error;
      }
    }
    throw conflictError;
  }
  try {
    return await api<FolderRow>("/files/folders", "POST", { name, parentId });
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    const queryType =
      parentId === "shared" || parentId === null ? "system" : "folder";
    const page = await api<{ folders: FolderRow[] }>(
      "/files?parentType=" + queryType + "&parentId=" + (parentId ?? "root"),
    );
    const existing = page.folders.find((folder) => folder.name === name);
    if (!existing) throw error;
    return existing;
  }
}

export async function uploadDroppedTree(
  entries: DroppedUpload[],
  initialParent: string | null,
  onProgress:
    ((path: string, completed: number, total: number) => void) | undefined,
  options: { rootConflict: "merge" | "create-new" },
) {
  const folderCache = new Map<string, string>();
  const tops: FolderRow[] = [];
  const seenTop = new Set<string>();
  const total = entries.filter((entry) => entry.file).length;
  let completed = 0;
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    const folderNames = entry.file ? segments.slice(0, -1) : segments;
    const filename = entry.file ? segments.at(-1) : null;
    let parentId = initialParent;
    for (let index = 0; index < folderNames.length; index++) {
      const segment = folderNames[index]!;
      const key = (parentId ?? "root") + "/" + segment;
      let folderId = folderCache.get(key);
      if (!folderId) {
        const folder = await ensureFolder(
          segment,
          parentId,
          index === 0 ? options.rootConflict : "merge",
        );
        folderId = folder.id;
        folderCache.set(key, folderId);
        if (index === 0 && !seenTop.has(folderId)) {
          seenTop.add(folderId);
          tops.push({ id: folderId, name: folder.name || segment });
        }
      }
      parentId = folderId;
    }
    if (!entry.file || !filename) continue;
    onProgress?.(entry.path, completed, total);
    const parentType = parentId && parentId !== "shared" ? "folder" : "system";
    const params = new URLSearchParams({
      filename,
      parentType,
      parentId: parentId ?? "root",
    });
    const response = await fetch("/api/v1/files/items?" + params, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: entry.file,
    });
    const text = await response.text();
    let result: { message?: string } = {};
    try {
      result = text ? JSON.parse(text) : {};
    } catch {}
    if (!response.ok)
      throw new Error(
        result.message ??
          (response.status === 413
            ? "文件超过当前上传大小限制"
            : `上传失败（${response.status}）`),
      );
    completed += 1;
    onProgress?.(entry.path, completed, total);
  }
  return { folders: tops };
}
