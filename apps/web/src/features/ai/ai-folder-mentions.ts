import type { FileDelivery, FolderDelivery } from "@core/modules/ai/progress.js";

export type AnswerSegment =
  | { type: "text"; text: string }
  | { type: "folder"; folder: FolderDelivery }
  | { type: "file"; file: FileDelivery };

const SESSION = /^[a-f0-9-]{36}$/i;

export function keepsAssistantSession(route: string) {
  const path = route.replace(/^#/, "").split("?")[0] ?? "";
  return (
    path === "/ai" ||
    path.startsWith("/r/") ||
    path === "/files" ||
    path.startsWith("/shared-files/") ||
    false
  );
}

export function withSessionHash(href: string, sessionId?: string | null) {
  const raw = href.trim().replace(/^#/, "");
  const split = raw.indexOf("?");
  const path = split === -1 ? raw : raw.slice(0, split);
  const params = new URLSearchParams(split === -1 ? "" : raw.slice(split + 1));
  if (sessionId && SESSION.test(sessionId)) params.set("session", sessionId);
  else params.delete("session");
  const query = params.toString();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}${query ? `?${query}` : ""}`;
}

export function aiSessionFolderHref(
  session: { id: string; title: string },
  assistantName: string,
) {
  const params = new URLSearchParams({
    path: JSON.stringify([
      { type: "system", id: "ai", name: assistantName },
      { type: "system", id: `ai-session:${session.id}`, name: session.title },
    ]),
  });
  return withSessionHash(`/files?${params}`, session.id);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function folderExplorerHash(href: string) {
  const trimmed = href.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#")) return trimmed;
  return trimmed.startsWith("/") ? `#${trimmed}` : `#/${trimmed}`;
}

export function isFolderExplorerHref(href: string) {
  const hash = folderExplorerHash(href);
  return (
    hash.startsWith("#/files") ||
    /^#\/shared-files\/(?!join(?:\?|$))/.test(hash)
  );
}

export function navigationHref(href: string) {
  const raw = href.trim().replace(/^#/, "");
  const split = raw.indexOf("?");
  const path = new URLSearchParams(split === -1 ? "" : raw.slice(split + 1)).get("path");
  if (path == null) return true;
  try {
    const value = JSON.parse(path) as unknown;
    return (
      Array.isArray(value) &&
      value.every(
        (item) =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string" &&
          typeof (item as { type?: unknown }).type === "string",
      )
    );
  } catch {
    return false;
  }
}

export function resolveExplorerClick(
  href: string,
  files: FileDelivery[],
  label = "",
) {
  if (navigationHref(href)) return href;
  const text = label.trim();
  const named = files.find(
    (file) => file.href && (text === file.name || text.endsWith(file.name)),
  );
  if (named?.href) return named.href;
  if (files.length === 1 && files[0]?.href) return files[0].href;
  return "";
}

const MARK = "(?:`{1,3}|\\*{1,2}|_{1,2})";

function pathPatterns(path: string, icons: string) {
  const escaped = escapeRegExp(path);
  return [
    new RegExp(
      `(?:${icons})\\s*${MARK}?${escaped}${MARK}?|${MARK}${escaped}${MARK}`,
      "g",
    ),
    new RegExp(`(?:^|\\n)${MARK}?${escaped}${MARK}?(?=\\n|$)`, "g"),
  ];
}

function namedLinkPatterns(name: string) {
  return [new RegExp(`\\[${escapeRegExp(name)}\\]\\([^)\\n]+\\)`, "g")];
}

function hrefPatterns(href: string) {
  const hrefs = [
    href,
    folderExplorerHash(href),
    href.replace(/^\//, "#/"),
  ].filter((value, index, all) => value && all.indexOf(value) === index);
  if (!hrefs.length) return [];
  return [
    new RegExp(
      `\\[[^\\]]*\\]\\((?:${hrefs.map(escapeRegExp).join("|")})\\)`,
      "g",
    ),
  ];
}

type HitBody =
  | { type: "folder"; folder: FolderDelivery }
  | { type: "file"; file: FileDelivery };
type Hit = HitBody & { start: number; end: number };

function collectHits(
  text: string,
  folders: FolderDelivery[],
  files: FileDelivery[],
) {
  const hits: Hit[] = [];
  const overlaps = (start: number, end: number) =>
    hits.some((hit) => start < hit.end && end > hit.start);
  const add = (pattern: RegExp, hit: HitBody) => {
    for (const match of text.matchAll(pattern)) {
      let start = match.index ?? 0;
      let end = start + match[0].length;
      if (match[0].startsWith("\n")) start += 1;
      if (!overlaps(start, end)) hits.push({ ...hit, start, end } as Hit);
    }
  };
  const orderedFolders = [...folders]
    .filter((folder) => folder.href)
    .sort((a, b) => (b.path?.length ?? b.name.length) - (a.path?.length ?? a.name.length));
  const orderedFiles = [...files]
    .filter((file) => file.href || file.path || file.name)
    .sort((a, b) => (b.path?.length ?? b.name.length) - (a.path?.length ?? a.name.length));
  for (const folder of orderedFolders) {
    if (folder.path) {
      for (const pattern of pathPatterns(folder.path, "📁|📂")) add(pattern, { type: "folder", folder });
    }
    for (const pattern of hrefPatterns(folder.href)) add(pattern, { type: "folder", folder });
  }
  for (const file of orderedFiles) {
    if (file.path) {
      for (const pattern of pathPatterns(file.path, "📄|📎")) add(pattern, { type: "file", file });
    }
    if (file.href) {
      for (const pattern of hrefPatterns(file.href)) add(pattern, { type: "file", file });
    }
    if (file.name && (file.name.includes(".") || file.name.length >= 4)) {
      for (const pattern of namedLinkPatterns(file.name))
        add(pattern, { type: "file", file });
    }
  }
  for (const match of text.matchAll(/\[[^\]]*下载[^\]]*\]\([^)\n]+\)/gi)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(start, end)) continue;
    const file =
      orderedFiles.find((item) => match[0].includes(item.name)) ??
      (orderedFiles.length === 1 ? orderedFiles[0] : undefined);
    if (file) hits.push({ type: "file", file, start, end });
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

export function answerSegments(
  text: string,
  folders: FolderDelivery[] = [],
  options: { ensureCards?: boolean; files?: FileDelivery[] } = {},
): AnswerSegment[] {
  const files = options.files ?? [];
  if (!text && !folders.length && !files.length) return [];
  if (!folders.length && !files.length) return text ? [{ type: "text", text }] : [];
  const hits = collectHits(text, folders, files);
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  const usedFolders = new Set<string>();
  const usedFiles = new Set<string>();
  for (const hit of hits) {
    if (hit.start > cursor) {
      const chunk = text.slice(cursor, hit.start);
      if (chunk.trim() || segments.length)
        segments.push({ type: "text", text: chunk });
    }
    const last = segments.at(-1);
    if (hit.type === "folder") {
      if (!(last?.type === "folder" && last.folder.id === hit.folder.id)) {
        segments.push({ type: "folder", folder: hit.folder });
        usedFolders.add(hit.folder.id);
      }
    } else if (!(last?.type === "file" && last.file.id === hit.file.id)) {
      segments.push({ type: "file", file: hit.file });
      usedFiles.add(hit.file.id);
    }
    cursor = hit.end;
  }
  if (cursor < text.length) {
    const chunk = text.slice(cursor);
    if (chunk.trim() || segments.length)
      segments.push({ type: "text", text: chunk });
  }
  if (!segments.length && text) segments.push({ type: "text", text });
  if (options.ensureCards) {
    for (const folder of folders) {
      if (folder.href && !usedFolders.has(folder.id)) segments.push({ type: "folder", folder });
    }
    for (const file of files) {
      if (!usedFiles.has(file.id)) segments.push({ type: "file", file });
    }
  }
  return segments;
}
