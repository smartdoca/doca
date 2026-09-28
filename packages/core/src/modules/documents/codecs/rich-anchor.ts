import type { YjsDocument, CommentAnchor } from "@smartdoca/slate/yjs";

export type RichAnchorPart = {
  blockId: string;
  quote: string;
  start: string;
  end: string;
  kind?: "block";
};
export type RichAnchor = RichAnchorPart & { epochId?: string; segments?: RichAnchorPart[] };
export type ResolvedRichAnchor = {
  blockId: string;
  start: number;
  end: number;
  orphaned: boolean;
  kind?: "block";
};
type Runtime = Pick<YjsDocument, "createCommentAnchor" | "resolveCommentAnchor" | "getValue">;
const MEDIA_TYPES = new Set(["image", "video", "attachment"]);
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

function textOf(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function findContentBlock(value: unknown, blockId: string) {
  const seen = new Set<unknown>();
  const walk = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    if (record.id === blockId) return record;
    return Array.isArray(record.children) ? walk(record.children) : null;
  };
  return walk(value);
}

function mediaQuote(node: Record<string, unknown>) {
  const type = String(node.type ?? "");
  const label =
    type === "attachment"
      ? textOf(node.name) || "附件"
      : type === "video"
        ? textOf(node.name) || textOf(node.alt) || "视频"
        : textOf(node.caption) || textOf(node.alt) || textOf(node.name) || "图片";
  return label.slice(0, 200);
}

export function encodeRichAnchorPart(a: CommentAnchor): RichAnchorPart {
  return { blockId: a.blockId, quote: a.quote, start: encode(a.start), end: encode(a.end) };
}

export function richAnchorParts(value: unknown): RichAnchorPart[] {
  const a = value as RichAnchor | null;
  if (!a || typeof a !== "object") throw Error("文字选区无效");
  const parts = a.segments === undefined ? [a] : a.segments;
  if (!Array.isArray(parts) || !parts.length || parts.length > 200) throw Error("文字选区过大或无效");
  for (const part of parts) {
    const block = part?.kind === "block";
    if (
      !part ||
      typeof part.blockId !== "string" ||
      !part.blockId ||
      part.blockId.length > 256 ||
      typeof part.quote !== "string" ||
      part.quote.length > 5000 ||
      (part.kind !== undefined && part.kind !== "block") ||
      typeof part.start !== "string" ||
      typeof part.end !== "string" ||
      part.start.length > 1400 ||
      part.end.length > 1400 ||
      (!block && (!part.start.length || !part.end.length))
    )
      throw Error("文字选区无效");
  }
  if (new Set(parts.map((p) => p.blockId)).size !== parts.length) throw Error("文字选区重复");
  if (parts.map((p) => p.quote).join("\n").length > 5000) throw Error("选中文字不能超过 5000 字");
  return parts;
}

export function combineRichAnchors(parts: RichAnchorPart[], epochId?: string): RichAnchor {
  const value = {
    ...parts[0]!,
    quote: parts.map((p) => p.quote).join("\n"),
    ...(parts.length > 1 ? { segments: parts } : {}),
    ...(epochId ? { epochId } : {}),
  };
  richAnchorParts(value);
  return value;
}

export function resolveRichAnchor(runtime: Runtime, value: unknown): ResolvedRichAnchor[] {
  return richAnchorParts(value).flatMap((part) => {
    if (part.kind === "block") {
      const node = findContentBlock(runtime.getValue(), part.blockId);
      if (!node || !MEDIA_TYPES.has(String(node.type))) return [];
      return [{ blockId: part.blockId, start: 0, end: 0, orphaned: false, kind: "block" as const }];
    }
    const resolved = runtime.resolveCommentAnchor({
      ...part,
      start: decode(part.start),
      end: decode(part.end),
    });
    return !resolved.orphaned && resolved.end > resolved.start ? [resolved] : [];
  });
}

export function quotedRichAnchor(runtime: Runtime, part: ResolvedRichAnchor) {
  if (part.kind === "block") {
    const node = findContentBlock(runtime.getValue(), part.blockId);
    return node ? mediaQuote(node) : "";
  }
  return runtime.createCommentAnchor(part.blockId, part.start, part.end).quote;
}

/** Rebuild quotes from authorized server content; never trust submitted text. */
export function canonicalRichAnchor(runtime: Runtime, value: unknown): RichAnchor {
  const parts = richAnchorParts(value);
  const resolved = resolveRichAnchor(runtime, value);
  if (resolved.length !== parts.length) throw Error("选区已变化，请重新选择");
  return combineRichAnchors(
    resolved.map((part) => {
      if (part.kind === "block") {
        const node = findContentBlock(runtime.getValue(), part.blockId);
        if (!node) throw Error("选区已变化，请重新选择");
        return { kind: "block" as const, blockId: part.blockId, quote: mediaQuote(node), start: "", end: "" };
      }
      return encodeRichAnchorPart(runtime.createCommentAnchor(part.blockId, part.start, part.end));
    }),
  );
}
