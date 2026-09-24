import type {
  CommentBody,
  CommentInline,
} from "@core/modules/interactions/community.js";
/** Only known, complete @tokens become mentions; ordinary text remains plain text. */
export function composeComment(
  text: string,
  mentions: Record<string, Extract<CommentInline, { type: "mention" }>>,
  images: Extract<CommentBody["blocks"][number], { type: "image" }>[] = [],
): CommentBody {
  const children: CommentInline[] = [];
  const pattern = /(^|\s)(@[^\s]+)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[2]!,
      mention = mentions[token];
    if (!mention) continue;
    const start = match.index! + match[1]!.length;
    if (start > offset)
      children.push({ type: "text", text: text.slice(offset, start) });
    children.push(mention);
    offset = start + token.length;
  }
  if (offset < text.length)
    children.push({ type: "text", text: text.slice(offset) });
  return { version: 1, blocks: [{ type: "paragraph", children }, ...images] };
}
