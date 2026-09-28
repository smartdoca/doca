import {
  Editor,
  Element,
  Text,
  Transforms,
  type Path,
  type Point,
  type Range,
} from "slate";
import { findTextOffsets } from "@web/shared/utils/find-text.js";
type Match =
  | { range: Range }
  | { path: Path; start: number; length: number; code: string };
// Adapter over the editor model, never DOM writes. Inline atomic objects are boundaries.
export function richTextMatches(editor: Editor, query: string): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  const walk = (node: import("slate").Node, path: Path) => {
    if (Text.isText(node)) return;
    if (Element.isElement(node) && editor.isVoid(node)) return;
    if (Element.isElement(node) && node.type === "code-block") {
      for (const start of findTextOffsets(node.code ?? "", query))
        matches.push({
          path,
          start,
          length: query.length,
          code: node.code ?? "",
        });
      return;
    }
    let leaves: { text: string; path: Path }[] = [];
    const flush = () => {
      const text = leaves.map((l) => l.text).join("");
      const point = (offset: number): Point => {
        for (const l of leaves) {
          if (offset <= l.text.length) return { path: l.path, offset };
          offset -= l.text.length;
        }
        return {
          path: leaves[leaves.length - 1]!.path,
          offset: leaves[leaves.length - 1]!.text.length,
        };
      };
      for (const start of findTextOffsets(text, query))
        matches.push({
          range: { anchor: point(start), focus: point(start + query.length) },
        });
      leaves = [];
    };
    const inline = (child: import("slate").Node, p: Path) => {
      if (Text.isText(child)) leaves.push({ text: child.text, path: p });
      else if (
        Element.isElement(child) &&
        editor.isInline(child) &&
        !editor.isVoid(child)
      )
        child.children.forEach((c, i) => inline(c, [...p, i]));
      else {
        flush();
        walk(child, p);
      }
    };
    node.children.forEach((child, i) => inline(child, [...path, i]));
    flush();
  };
  walk(editor, []);
  return matches;
}
export function replaceRichText(
  editor: Editor,
  query: string,
  replacement: string,
  all: boolean,
  index = 0,
): number {
  const found = richTextMatches(editor, query);
  const targets = all ? found : found[index] ? [found[index]!] : [];
  Editor.withoutNormalizing(editor, () => {
    for (const match of [...targets].reverse()) {
      if ("range" in match)
        Transforms.insertText(editor, replacement, { at: match.range });
      else {
        const node = Editor.node(editor, match.path)[0] as { code: string };
        Transforms.setNodes(
          editor,
          {
            code:
              node.code.slice(0, match.start) +
              replacement +
              node.code.slice(match.start + match.length),
          },
          { at: match.path },
        );
      }
    }
  });
  return targets.length;
}
