import { createHash } from "node:crypto";

export interface ContentBlock {
  /** Content-addressed identity; changed text is a replacement, not an edit-in-place. */
  blockId: string;
  fingerprint: string;
  title: string;
  text: string;
  order: number;
  anchor: { blockId: string; heading: string };
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const maxBlockLength = 2000;

/** Independent paragraphs keep insertion in one paragraph from regrouping later ones.
 * Long paragraphs are split without dropping their tail or splitting surrogate pairs.
 */
function* pieces(text: string) {
  for (const paragraph of text.split(/\n[\t ]*\n+/u)) {
    let remaining = paragraph.trim();
    while (remaining.length > maxBlockLength) {
      const prefix = remaining.slice(0, maxBlockLength);
      let end = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
      if (end < maxBlockLength / 2) end = maxBlockLength;
      // A high surrogate at the boundary must stay with its low surrogate.
      if (/[\uD800-\uDBFF]/u.test(remaining[end - 1]!)) end--;
      yield remaining.slice(0, end);
      remaining = remaining.slice(end).trimStart();
    }
    if (remaining) yield remaining;
  }
}

/** Shared readable content projection. Does not use persisted search index IDs,
 * source-wide revision numbers, or mutable ordinal positions as block identity.
 * Duplicate identical blocks use their occurrence within that identical content.
 */
export function contentBlocks(title: string, body: string): ContentBlock[] {
  const normalized = body.replace(/\r\n?/g, "\n").trim();
  const blocks: ContentBlock[] = [];
  const occurrences = new Map<string, number>();
  const headings: string[] = [];
  for (const text of pieces(normalized || title)) {
    const header = /^(#{1,6})[\t ]+([^\n]+)/u.exec(text);
    if (header) {
      headings.length = header[1]!.length - 1;
      headings.push(header[2]!.trim());
    }
    const heading = headings.filter(Boolean).join(" / ") || title;
    const hash = digest(["content-block-v1", text]);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    const blockId = `cb_${hash}_${occurrence}`;
    blocks.push({
      blockId,
      fingerprint: digest(["content-fingerprint-v1", title, heading, text]),
      title,
      text,
      order: blocks.length,
      anchor: { blockId, heading },
    });
  }
  return blocks;
}
