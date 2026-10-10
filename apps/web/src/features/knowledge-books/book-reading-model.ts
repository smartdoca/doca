import { fromMarkdown } from "mdast-util-from-markdown";
import type { BookArtifact } from "@core/modules/knowledge-books/protocol.js";

export type BookPage = BookArtifact["pages"][number];
interface MarkdownNode {
  type: string;
  value?: string;
  alt?: string | null;
  depth?: number;
  children?: MarkdownNode[];
  position?: { start: { line: number; offset?: number } };
}
export interface BookPageNode {
  key: string;
  title: string;
  page?: BookPage;
  children?: BookPageNode[];
}

/** Shared tree order for the directory and previous/next navigation. */
export function bookPageTree(pages: BookPage[]): BookPageNode[] {
  const root: BookPageNode[] = [];
  for (const page of pages) {
    let children = root;
    const labels: string[] = [];
    for (const title of page.path) {
      labels.push(title);
      const key = `folder:${JSON.stringify(labels)}`;
      let node = children.find((item) => item.key === key);
      if (!node) {
        node = { key, title, children: [] };
        children.push(node);
      }
      children = node.children!;
    }
    children.push({ key: page.id, title: page.title, page });
  }
  return root;
}

export function orderedBookPages(pages: BookPage[]): BookPage[] {
  const visit = (nodes: BookPageNode[]): BookPage[] =>
    nodes.flatMap((node) =>
      node.page ? [node.page] : visit(node.children ?? []),
    );
  return visit(bookPageTree(pages));
}

function text(node: MarkdownNode): string {
  if (node.value !== undefined) return node.value;
  if (node.type === "image" || node.type === "imageReference")
    return node.alt ?? "";
  return node.children?.map(text).join("") ?? "";
}

export interface BookOutlineEntry {
  id: string;
  label: string;
  depth: number;
  line: number;
  localLine: number;
  paragraphId: string;
}

/** Navigation is derived from the immutable Markdown, never written to a release. */
export function bookReadingModel(page: BookPage) {
  const markdown = page.paragraphs
    .map((paragraph) => paragraph.markdown)
    .join("\n\n");
  const headings: BookOutlineEntry[] = [];
  const starts: { paragraphId: string; offset: number; line: number }[] = [];
  let startLine = 1;
  let startOffset = 0;
  for (const paragraph of page.paragraphs) {
    starts.push({
      paragraphId: paragraph.id,
      offset: startOffset,
      line: startLine,
    });
    startLine += paragraph.markdown.split("\n").length + 1;
    startOffset += paragraph.markdown.length + 2;
  }
  const visit = (node: MarkdownNode) => {
    if (node.type === "heading") {
      const position = node.position!.start;
      const start = starts.findLast((item) => item.offset <= position.offset!)!;
      headings.push({
        id: `book-reading-${page.id}-heading-${position.offset}`,
        label: text(node).trim(),
        depth: node.depth!,
        line: position.line,
        localLine: position.line - start.line + 1,
        paragraphId: start.paragraphId,
      });
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  return {
    markdown,
    outline: headings,
    headings: headings.length > 0,
  };
}
