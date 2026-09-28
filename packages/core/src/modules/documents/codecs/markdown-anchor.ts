import type { MarkdownTextAnchor } from "@smartdoca/markdown";
/** JSON-safe comment metadata; CRDT bytes are arrays, never numeric-key objects. */
export function encodeMarkdownAnchor(
  anchor: MarkdownTextAnchor,
  epochId: string,
  quote = "",
) {
  return {
    ...anchor,
    epochId,
    quote: quote.slice(0, 5000),
    start: { bytes: Array.from(anchor.start.bytes) },
    end: { bytes: Array.from(anchor.end.bytes) },
  };
}
export function decodeMarkdownAnchor(
  input: any,
  epochId?: string,
): MarkdownTextAnchor {
  if (
    !input ||
    input.kind !== "markdown-text-range" ||
    typeof input.epochId !== "string" ||
    (epochId && input.epochId !== epochId)
  )
    throw Error("Markdown 评论格式不匹配");
  const bytes = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 1024 ||
      value.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      throw Error("Markdown 评论位置无效");
    return new Uint8Array(value);
  };
  if (
    !Array.isArray(input.content) ||
    !input.content.length ||
    input.content.length > 4096 ||
    input.content.some(
      (s: any) =>
        !s ||
        !Number.isSafeInteger(s.client) ||
        s.client < 0 ||
        !Number.isSafeInteger(s.clock) ||
        s.clock < 0 ||
        !Number.isSafeInteger(s.length) ||
        s.length < 1 ||
        !Number.isSafeInteger(s.clock + s.length),
    )
  )
    throw Error("Markdown 评论身份无效");
  return {
    kind: input.kind,
    start: { bytes: bytes(input.start?.bytes) },
    end: { bytes: bytes(input.end?.bytes) },
    content: input.content.map((s: any) => ({
      client: s.client,
      clock: s.clock,
      length: s.length,
    })),
  };
}
