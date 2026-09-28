import { Editor, Element, Node, Path, Range, Text, type Point } from "slate";
import type { YjsDocument } from "@smartdoca/slate/yjs";
import {
  combineRichAnchors,
  encodeRichAnchorPart,
  type RichAnchorPart,
} from "@core/modules/documents/codecs/rich-anchor.js";

const MEDIA = new Set(["image", "video", "attachment"]);

function textOf(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function mediaPart(block: Element): RichAnchorPart {
  const record = block as unknown as Record<string, unknown>;
  const type = String(block.type);
  const quote =
    type === "attachment"
      ? textOf(record.name) || "附件"
      : type === "video"
        ? textOf(record.name) || textOf(record.alt) || "视频"
        : textOf(record.caption) || textOf(record.alt) || textOf(record.name) || "图片";
  return { kind: "block", blockId: String(block.id), quote: quote.slice(0, 200), start: "", end: "" };
}

/** One anchor per selected text block or media block, in document order. */
export function captureRichSelection(editor: Editor, runtime: YjsDocument, selection: Range, epochId?: string) {
  const parts: RichAnchorPart[] = [];
  for (const [block, path] of Editor.nodes(editor, {
    at: selection,
    voids: true,
    match: (n) =>
      Element.isElement(n) &&
      (MEDIA.has(String(n.type)) ||
        (Editor.isBlock(editor, n) && !Editor.hasBlocks(editor, n) && !Editor.isVoid(editor, n))),
  })) {
    if (!Element.isElement(block) || !block.id) continue;
    if (MEDIA.has(String(block.type))) {
      const selected = Range.isCollapsed(selection)
        ? Editor.void(editor, { at: selection })?.[0] === block
        : Boolean(Range.intersection(selection, Editor.range(editor, path)));
      if (selected) parts.push(mediaPart(block));
      continue;
    }
    if (Range.isCollapsed(selection) || Editor.isVoid(editor, block)) continue;
    const range = Range.intersection(selection, Editor.range(editor, path));
    if (!range || Range.isCollapsed(range)) continue;
    const offset = (point: Point) => {
      let n = 0, done = false;
      const walk = (node: Node, at: number[]) => {
        if (done) return;
        if (Text.isText(node)) {
          if (Path.equals(at, point.path)) { n += point.offset; done = true; }
          else n += node.text.length;
        } else if (Element.isElement(node) && (String(node.type) === "mention" || Editor.isVoid(editor, node))) n++;
        else if ("children" in node) node.children.forEach((child, i) => walk(child, [...at, i]));
      };
      walk(block, path);
      return n;
    };
    const [start, end] = Range.edges(range), from = offset(start), to = offset(end);
    if (to > from) parts.push(encodeRichAnchorPart(runtime.createCommentAnchor(block.id, from, to)));
  }
  if (!parts.length) throw Error("comment_need_selection");
  return combineRichAnchors(parts, epochId);
}
