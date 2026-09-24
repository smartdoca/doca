import type { FileDelivery, FolderDelivery, MailDelivery } from "@core/modules/ai/progress.js";

export type AnswerSegment =
  | { type: "text"; text: string }
  | { type: "folder"; folder: FolderDelivery }
  | { type: "file"; file: FileDelivery }
  | { type: "mail"; mail: MailDelivery };

const SESSION = /^[a-f0-9-]{36}$/i;

export function keepsAssistantSession(route: string) {
  const path = route.replace(/^#/, "").split("?")[0] ?? "";
  return (
    path === "/ai" ||
    path.startsWith("/r/") ||
    path === "/files" ||
    path.startsWith("/shared-files/") ||
    path === "/mail" ||
    path.startsWith("/mail/")
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

export function isMailHref(href: string) {
  const hash = folderExplorerHash(href);
  return hash === "#/mail" || hash.startsWith("#/mail/");
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
  | { type: "file"; file: FileDelivery }
  | { type: "mail"; mail: MailDelivery };
type Hit = HitBody & { start: number; end: number };

function collectHits(
  text: string,
  folders: FolderDelivery[],
  files: FileDelivery[],
  mails: MailDelivery[] = [],
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
  }
  for (const mail of mails) {
    if (!mail.href) continue;
    for (const pattern of hrefPatterns(mail.href)) add(pattern, { type: "mail", mail });
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

export function answerSegments(
  text: string,
  folders: FolderDelivery[] = [],
  options: { ensureCards?: boolean; files?: FileDelivery[]; mails?: MailDelivery[] } = {},
): AnswerSegment[] {
  const files = options.files ?? [];
  const mails = options.mails ?? [];
  if (!text && !folders.length && !files.length && !mails.length) return [];
  if (!folders.length && !files.length && !mails.length) return text ? [{ type: "text", text }] : [];
  const hits = collectHits(text, folders, files, mails);
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  const usedFolders = new Set<string>();
  const usedFiles = new Set<string>();
  const usedMails = new Set<string>();
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
    } else if (hit.type === "mail") {
      const key = `${hit.mail.mailboxId}:${hit.mail.id}`;
      if (!(last?.type === "mail" && last.mail.mailboxId === hit.mail.mailboxId && last.mail.id === hit.mail.id)) {
        segments.push({ type: "mail", mail: hit.mail });
        usedMails.add(key);
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
    for (const mail of mails) {
      const key = `${mail.mailboxId}:${mail.id}`;
      if (mail.href && !usedMails.has(key)) segments.push({ type: "mail", mail });
    }
  }
  return segments;
}
