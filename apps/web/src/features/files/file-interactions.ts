export const FILE_DRAG_TYPE = "application/x-doca-files";
export const FILE_DRAG_TEXT_PREFIX = "doca-files:";

export type FileDragItem = {
  kind: "folder" | "file";
  id: string;
  version: number;
  name?: string;
  locked?: boolean;
  mime?: string;
  size?: number;
  folderType?: string;
};

export type NamedEntry = {
  kind: "folder" | "file";
  id: string;
  name: string;
  version: number;
  locked?: boolean;
};

export type NameConflict = {
  item: FileDragItem;
  existing: NamedEntry;
};

export type Rect = { left: number; top: number; right: number; bottom: number };

let internalDrag: FileDragItem[] | null = null;

export function beginInternalFileDrag(items: FileDragItem[]) {
  internalDrag = items;
}

export function endInternalFileDrag() {
  internalDrag = null;
}

export function currentInternalFileDrag() {
  return internalDrag;
}

export function serializeFileDrag(items: FileDragItem[]) {
  return JSON.stringify(items);
}

export function parseFileDragItems(raw: string | null | undefined): FileDragItem[] | null {
  if (!raw) return null;
  const text = raw.startsWith(FILE_DRAG_TEXT_PREFIX) ? raw.slice(FILE_DRAG_TEXT_PREFIX.length) : raw;
  try {
    const value = JSON.parse(text) as FileDragItem[];
    if (!Array.isArray(value) || !value.every((item) => item && (item.kind === "folder" || item.kind === "file") && typeof item.id === "string")) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function writeFileDrag(dataTransfer: DataTransfer, items: FileDragItem[]) {
  const raw = serializeFileDrag(items);
  dataTransfer.effectAllowed = "copyMove";
  dataTransfer.setData(FILE_DRAG_TYPE, raw);
  dataTransfer.setData("text/plain", FILE_DRAG_TEXT_PREFIX + raw);
  beginInternalFileDrag(items);
}

export function readFileDrag(dataTransfer: DataTransfer): FileDragItem[] | null {
  return parseFileDragItems(dataTransfer.getData(FILE_DRAG_TYPE))
    ?? parseFileDragItems(dataTransfer.getData("text/plain"))
    ?? currentInternalFileDrag();
}

export function dataTransferTypes(dataTransfer: { types: ArrayLike<string> }) {
  return Array.from(dataTransfer.types as ArrayLike<string> as string[]);
}

export function isInternalFileDrag(dataTransfer: { types: ArrayLike<string> }) {
  if (currentInternalFileDrag()) return true;
  return dataTransferTypes(dataTransfer).includes(FILE_DRAG_TYPE);
}

export function isExternalFileDrag(dataTransfer: { types: ArrayLike<string> }) {
  if (currentInternalFileDrag()) return false;
  const types = dataTransferTypes(dataTransfer);
  if (types.includes(FILE_DRAG_TYPE)) return false;
  return types.includes("Files");
}

export function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function idsInMarquee(marquee: Rect, entries: Array<{ id: string; rect: Rect }>) {
  return entries.filter((entry) => rectsIntersect(marquee, entry.rect)).map((entry) => entry.id);
}

export function orderedRange(ids: string[], anchorId: string | null, targetId: string) {
  if (!anchorId) return [targetId];
  const start = ids.indexOf(anchorId);
  const end = ids.indexOf(targetId);
  if (start < 0 || end < 0) return [targetId];
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return ids.slice(from, to + 1);
}

export function toggleSelectedId(ids: Iterable<string>, id: string) {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function splitFileName(name: string, kind: "folder" | "file") {
  if (kind === "folder") return { base: name, ext: "" };
  const index = name.lastIndexOf(".");
  if (index <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, index), ext: name.slice(index) };
}

export function nextAvailableName(name: string, taken: Iterable<string>, kind: "folder" | "file") {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const { base, ext } = splitFileName(name, kind);
  const stripped = base.replace(/ (\d+)$/, "") || base;
  let n = 2;
  let candidate = `${stripped} ${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stripped} ${n}${ext}`;
  }
  return candidate;
}

export function destinationEntries(page: { folders: Array<{ id: string; name: string; version: number; locked?: boolean; virtual?: boolean }>; files: Array<{ id: string; name: string; version: number; locked?: boolean }> }): NamedEntry[] {
  return [
    ...page.folders
      .filter((folder) => !folder.virtual)
      .map((folder) => ({ kind: "folder" as const, id: folder.id, name: folder.name, version: folder.version, locked: folder.locked })),
    ...page.files.map((file) => ({ kind: "file" as const, id: file.id, name: file.name, version: file.version, locked: file.locked })),
  ];
}

export function findNameConflicts(items: FileDragItem[], entries: NamedEntry[], copy: boolean): NameConflict[] {
  const conflicts: NameConflict[] = [];
  for (const item of items) {
    if (!item.name) continue;
    const existing = entries.find((entry) => entry.name === item.name && (copy || entry.id !== item.id));
    if (existing) conflicts.push({ item, existing });
  }
  return conflicts;
}

export function trailAfterRemovedFolders<T extends { id: string }>(
  trail: T[],
  removedFolderIds: Iterable<string>,
): { kind: "unchanged" } | { kind: "leave-root" } | { kind: "parent"; trail: T[] } {
  const removed = new Set(removedFolderIds);
  const cutIndex = trail.findIndex((item) => removed.has(item.id));
  if (cutIndex < 0) return { kind: "unchanged" };
  if (cutIndex === 0) return { kind: "leave-root" };
  return { kind: "parent", trail: trail.slice(0, cutIndex) };
}

export type ColumnLocation = { type: string; id: string };

export function locationKey(item: ColumnLocation) {
  return `${item.type}:${item.id}`;
}

export function trailKey(trail: ColumnLocation[]) {
  return trail.map(locationKey).join("/");
}

export function sameTrail(a: ColumnLocation[], b: ColumnLocation[]) {
  return a.length === b.length && a.every((item, index) => locationKey(item) === locationKey(b[index]!));
}

export function reusedColumnPrefix<T extends { location: ColumnLocation }>(
  trail: ColumnLocation[],
  columns: T[],
): T[] {
  const reused: T[] = [];
  for (let index = 0; index < trail.length; index++) {
    const existing = columns[index];
    if (!existing || locationKey(existing.location) !== locationKey(trail[index]!)) break;
    reused.push(existing);
  }
  return reused;
}

export type DroppedUpload = {
  path: string;
  file?: File;
  directory?: boolean;
};

type DropEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (
    success: (file: File) => void,
    error?: (error: DOMException) => void,
  ) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: DropEntry[]) => void,
      error?: (error: DOMException) => void,
    ) => void;
  };
};

export type CapturedExternalDrop = {
  entries: DropEntry[];
  files: DroppedUpload[];
};

export function captureExternalDrop(
  dataTransfer: DataTransfer,
): CapturedExternalDrop {
  const entries: DropEntry[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => DropEntry | null }
    ).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  const files = Array.from(dataTransfer.files ?? []).map((file) => ({
    file,
    path:
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name,
  }));
  return { entries, files };
}

function entryFile(entry: DropEntry) {
  return new Promise<File>((resolve, reject) => {
    if (!entry.file) {
      reject(new Error("无法读取文件"));
      return;
    }
    entry.file(resolve, reject);
  });
}

async function entryChildren(entry: DropEntry) {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const children: DropEntry[] = [];
  while (true) {
    const batch = await new Promise<DropEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) break;
    children.push(...batch);
  }
  return children;
}

async function walkDropEntry(
  entry: DropEntry,
  prefix: string,
  out: DroppedUpload[],
) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isDirectory) {
    const children = await entryChildren(entry);
    out.push({ path, directory: true });
    for (const child of children) await walkDropEntry(child, path, out);
    return;
  }
  if (!entry.isFile || entry.name === ".DS_Store") return;
  out.push({ path, file: await entryFile(entry) });
}

export async function materializeExternalDrop(
  captured: CapturedExternalDrop,
): Promise<DroppedUpload[]> {
  if (captured.entries.length) {
    const out: DroppedUpload[] = [];
    for (const entry of captured.entries) await walkDropEntry(entry, "", out);
    if (out.length) return out;
  }
  return captured.files.filter((item) => !item.path.endsWith("/.DS_Store"));
}

export function replaceColumnPage<T extends { location: ColumnLocation; page: unknown }>(
  columns: T[],
  location: ColumnLocation,
  page: T["page"],
): T[] {
  const index = columns.findIndex((column) => locationKey(column.location) === locationKey(location));
  if (index < 0) return columns;
  const next = columns.slice();
  next[index] = { ...next[index]!, page };
  return next;
}
