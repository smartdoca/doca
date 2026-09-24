import { fail } from "@core/shared/errors.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const myFiles = new Set([
  "",
  "root",
  "my",
  "mine",
  "home",
  "我的文件",
  "我的文件夹",
]);
const rootQueries = /^(我的)?(文件|文件夹|目录|文件夹根目录)$|^(my )?files?$|^(my )?folders?$|^home$|^root$/i;

export type FileParentType = "system" | "folder" | "document";
export type FileParent = { type: FileParentType; id: string };

export const systemFolders = [
  {
    id: "root",
    name: "我的文件夹",
    parentId: null as string | null,
    path: "我的文件夹",
    writable: true,
    copyOnly: false,
    role: "用户个人文件根目录。用户自建文件夹默认建在这里。",
  },
  {
    id: "ai",
    name: "AI 助手",
    parentId: "root",
    path: "我的文件夹 / AI 助手",
    writable: false,
    copyOnly: true,
    role: "AI 生成的图片保存在这里。目录不能增删改；里面的文件只能复制出去，不能移动、重命名或删除。",
  },
  {
    id: "shared",
    name: "共享文件夹",
    parentId: "root",
    path: "我的文件夹 / 共享文件夹",
    writable: true,
    copyOnly: false,
    role: "对外共享的一级文件夹入口。",
  },
  {
    id: "documents",
    name: "文档系统",
    parentId: "root",
    path: "我的文件夹 / 文档系统",
    writable: false,
    copyOnly: true,
    role: "文档附件只读入口。目录不能增删改；里面的文件只能复制出去。",
  },
  {
    id: "mail",
    name: "邮箱系统",
    parentId: "root",
    path: "我的文件夹 / 系统文件 / 邮箱系统",
    writable: false,
    copyOnly: true,
    role: "邮箱附件只读入口。目录不能增删改；里面的文件只能复制出去。",
  },
] as const;

export const systemFolderIds = new Set<string>(
  systemFolders.map((folder) => folder.id),
);

export const systemLocations = systemFolders.map((folder) => ({
  type: "system" as const,
  id: folder.id,
  name: folder.name,
  writable: folder.writable,
  copyOnly: folder.copyOnly,
}));

export function isFileUuid(value: string) {
  return uuid.test(value);
}

export function requireUuid(id: string, label: string) {
  if (isFileUuid(id)) return id;
  if (looksLikeTruncatedUuid(id))
    fail(
      400,
      `${label}「${id}」不是完整 UUID。请使用工具返回的完整 id，不要截断。`,
    );
  fail(400, `${label}必须是完整 UUID。`);
}

export function looksLikeTruncatedUuid(value: string) {
  return (
    /^[0-9a-f-]{8,35}$/i.test(value) &&
    !isFileUuid(value) &&
    !systemFolderIds.has(value)
  );
}

export function isRootFolderQuery(query: string) {
  return rootQueries.test(query.trim());
}

export function isPersonalRootFolderParent(id: string | null | undefined) {
  return id == null || id === "" || id === "root";
}

export function normalizeFolderParentId(id: string | null | undefined) {
  if (id === "shared") return "shared";
  if (isPersonalRootFolderParent(id)) return null;
  return id ?? null;
}

export function folderDisplayPath(names: string[], shared = false) {
  return ["我的文件夹", ...(shared ? ["共享文件夹"] : []), ...names].join(
    " / ",
  );
}

export function systemFolder(id: string) {
  return systemFolders.find((folder) => folder.id === id) ?? null;
}

export function preferDisplayLocation<
  T extends { parentType: string; parentId?: string; inMyFilesRoot?: boolean },
>(locations: T[]) {
  return (
    locations.find((item) => item.parentType === "folder") ??
    locations.find(
      (item) => item.parentType === "system" && item.parentId === "ai",
    ) ??
    locations.find(
      (item) => item.parentType === "system" && item.parentId === "root",
    ) ??
    locations[0]
  );
}

/** Resolve a folder node id: root / ai / shared / documents / UUID. */
export function parseFolderId(id?: string | null): FileParent {
  const value = id?.trim() || "root";
  if (myFiles.has(value)) return { type: "system", id: "root" };
  if (value === "ai" || value === "AI助手" || value === "AI 助手")
    return { type: "system", id: "ai" };
  if (value === "shared" || value === "共享文件夹")
    return { type: "system", id: "shared" };
  if (
    value === "documents" ||
    value === "文档系统" ||
    value === "系统文档"
  )
    return { type: "system", id: "documents" };
  if (value === "mail" || value === "邮箱系统" || value === "邮箱")
    return { type: "system", id: "mail" };
  if (value.startsWith("mail:") && isFileUuid(value.slice(5)))
    return { type: "system", id: value };
  if (isFileUuid(value)) return { type: "folder", id: value };
  if (looksLikeTruncatedUuid(value))
    fail(
      400,
      `「${value}」不是完整文件夹 ID。系统文件夹用 root / ai / shared / documents / mail，用户文件夹用完整 UUID。`,
    );
  fail(
    400,
    `无法识别文件夹 ID「${value}」。系统文件夹用 root / ai / shared / documents / mail，用户文件夹用完整 UUID。`,
  );
}

/** Map parentType + parentId from storage or older tool args. */
export function interpretFileParent(
  parentType?: FileParentType | null,
  parentId?: string | null,
): FileParent {
  const id = parentId?.trim() ?? "";
  if (parentType === "document") {
    if (!id) fail(400, "缺少目标位置");
    if (!isFileUuid(id)) fail(400, `「${id}」不是文档 ID。`);
    return { type: "document", id };
  }
  if (parentType === "folder" && isFileUuid(id)) return { type: "folder", id };
  return parseFolderId(id);
}

export function folderRecordParentId(parent: FileParent) {
  if (parent.type === "folder") return parent.id;
  if (parent.type === "system" && parent.id === "root") return null;
  if (parent.type === "system" && parent.id === "shared") return "shared";
  const known = systemFolder(parent.id);
  fail(
    400,
    parent.type === "system"
      ? `不能在「${known?.name ?? parent.id}」下新建或移入文件夹。用户文件夹请建在 root 或某个文件夹 UUID 下。`
      : "文档不能作为文件夹父级",
  );
}

export function describeFileParent(parent: FileParent) {
  if (parent.type === "system" && parent.id.startsWith("mail:")) {
    return {
      ...parent,
      name: "邮箱",
      path: "我的文件夹 / 系统文件 / 邮箱系统",
      parentId: "mail",
      inMyFilesRoot: false,
      writable: false,
      copyOnly: true,
      special: true,
      role: "邮箱附件只读入口。",
    };
  }
  if (parent.type === "system") {
    const known = systemFolder(parent.id);
    return {
      ...parent,
      name: known?.name ?? parent.id,
      path: known?.path ?? parent.id,
      parentId: known?.parentId ?? null,
      inMyFilesRoot: parent.id === "root",
      writable: known?.writable ?? false,
      copyOnly: known?.copyOnly ?? true,
      special: true,
      role: known?.role ?? null,
    };
  }
  return {
    ...parent,
    name: parent.type === "folder" ? "文件夹" : "文档",
    path: parent.type === "folder" ? "我的文件夹 / 子文件夹" : "我的文件夹 / 文档系统",
    parentId: parent.type === "folder" ? "root" : "documents",
    inMyFilesRoot: false,
    writable: parent.type === "folder",
    copyOnly: parent.type === "document",
    special: false,
    role:
      parent.type === "document"
        ? "文档附件，只读，只能复制出去。"
        : null,
  };
}

export function howToBrowse(parent: FileParent) {
  return { folderId: parent.id };
}

export function howToWrite(parent: FileParent) {
  const info = describeFileParent(parent);
  if (!info.writable) return null;
  return { folderId: parent.id };
}

export function describeFileCopy(parentType: string, parentId: string) {
  const parent = { type: parentType as FileParentType, id: parentId };
  const info = describeFileParent(parent);
  return {
    parentType: info.type,
    parentId: info.id,
    location: info.path,
    path: info.path,
    inMyFilesRoot: info.inMyFilesRoot,
    copyOnly: info.copyOnly || info.type === "document",
    note: info.role,
  };
}

export function preferFileCopyId(
  locations: Array<{ fileId: string; parentType: string }>,
) {
  return (
    locations.find((item) => item.parentType !== "document")?.fileId ??
    locations[0]?.fileId
  );
}

export function isCopyOnlyParent(parentType: string, parentId: string) {
  if (parentType === "document") return true;
  return (
    parentType === "system" &&
    (parentId === "ai" || parentId === "documents" || parentId === "mail" || parentId.startsWith("mail:"))
  );
}

export function copyOnlyParentName(parentType: string, parentId: string) {
  if (parentType === "document") return "文档系统";
  return systemFolder(parentId)?.name ?? parentId;
}

export function copyOnlyMutationMessage(
  name: string,
  action: string,
  parentType: string,
  parentId: string,
) {
  return `「${name}」在「${copyOnlyParentName(parentType, parentId)}」中，该目录不能增删改。请用 copy 复制到其他文件夹，不要 ${action}。`;
}

export function copyOnlyDestinationMessage(parent: FileParent) {
  if (parent.type === "document")
    return "不能向文档附件目录写入。文档附件只能从文档系统复制出去。";
  const known = systemFolder(parent.id);
  return `不能向「${known?.name ?? parent.id}」写入。该目录不能增删改。`;
}

export function folderExplorerHref(input: {
  sharedRoot?: { id: string; name: string } | null;
  navigation: Array<{ type: string; id: string; name: string }>;
}) {
  if (input.sharedRoot) {
    const base = `/shared-files/${input.sharedRoot.id}?name=${encodeURIComponent(input.sharedRoot.name)}`;
    if (input.navigation.length <= 1) return base;
    return `${base}&path=${encodeURIComponent(JSON.stringify(input.navigation))}`;
  }
  return `/files?path=${encodeURIComponent(JSON.stringify(input.navigation))}`;
}

export function describeDroppedExplorerItems(
  items: Array<{
    kind: "file" | "folder";
    id: string;
    name: string;
    path: string;
    mime?: string;
  }>,
) {
  if (!items.length) return "";
  const lines = items.map((item) =>
    item.kind === "folder"
      ? `文件夹「${item.name}」folderId=${item.id}，路径：${item.path}。这只是文件夹引用，没有发送其中的文件或图片。浏览、改名、移动用这个 folderId。`
      : `文件「${item.name}」fileId=${item.id}，路径：${item.path}。${
          item.mime?.startsWith("image/")
            ? "图片已作为本轮附件发送，可以直接查看。"
            : "文件内容已作为本轮附件发送。"
        }移动、重命名、复制、删除必须使用这个 fileId，不要操作 AI 助手目录里的附件副本。`,
  );
  return `用户从文件夹拖入对话：\n${lines.join("\n")}`;
}

export function fileExplorerHref(folderHref: string, fileId: string) {
  if (!folderHref || !fileId) return folderHref;
  const sep = folderHref.includes("?") ? "&" : "?";
  return `${folderHref}${sep}focus=${encodeURIComponent(fileId)}`;
}
