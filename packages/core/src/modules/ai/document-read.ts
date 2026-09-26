export type DocumentReadQuery = {
  view?: "outline" | "content";
  offset?: number;
  limit?: number;
  blockId?: string;
  slideId?: string;
  sheetId?: string;
  elementId?: string;
  startRow?: number;
  endRow?: number;
  startColumn?: number;
  endColumn?: number;
};

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function previewText(value: unknown, max = 80): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (parts.join("").length >= max) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string") parts.push(n.text);
    if (typeof n.code === "string") parts.push(n.code);
    if (typeof n.label === "string") parts.push(n.label);
    if (Array.isArray(n.children)) n.children.forEach(walk);
    if (Array.isArray(n.paragraphs)) n.paragraphs.forEach(walk);
  };
  walk(value);
  return clip(parts.join(""), max);
}

function findById(value: unknown, id: string): unknown {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findById(item, id);
      if (found) return found;
    }
    return null;
  }
  const node = value as Record<string, unknown>;
  if (node.id === id) return node;
  if (Array.isArray(node.children)) return findById(node.children, id);
  return null;
}

function richOutline(value: unknown) {
  const blocks = Array.isArray(value) ? value : [];
  return {
    blockCount: blocks.length,
    blocks: blocks.slice(0, 200).map((block: any) => {
      const node: Record<string, unknown> = {
        id: block?.id,
        type: block?.type,
        preview: previewText(block, 80),
        textLength: richTextLength(block),
      };
      if (block?.title) node.title = block.title;
      if (block?.type === "code-block") node.language = block.language;
      if (block?.type === "table")
        node.rows = (block.children ?? []).slice(0, 12).map((row: any) => ({
          id: row?.id,
          cells: (row?.children ?? []).slice(0, 12).map((cell: any) => ({
            id: cell?.id,
            rowId: cell?.rowId,
            columnId: cell?.columnId,
            preview: previewText(cell, 40),
          })),
        }));
      if (block?.type === "flowchart")
        node.nodes = (block.nodes ?? []).slice(0, 40).map((n: any) => ({
          id: n?.id,
          label: n?.label,
        }));
      if (block?.type === "mindmap")
        node.mind = {
          id: block.mindData?.nodeData?.id,
          topic: block.mindData?.nodeData?.topic,
        };
      if (block?.type === "columns")
        node.columns = (block.children ?? []).map((c: any) => ({
          id: c?.id,
          type: c?.type,
        }));
      return node;
    }),
  };
}

/** Native rich-text offsets count UTF-16 code units across text leaves, including links. */
export function richTextLength(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const node = value as { text?: unknown; children?: unknown[] };
  if (typeof node.text === "string") return node.text.length;
  return Array.isArray(node.children)
    ? node.children.reduce<number>((total, child) => total + richTextLength(child), 0)
    : 0;
}

function markdownOutline(text: string) {
  const headings: { index: number; level: number; text: string }[] = [];
  for (const match of text.matchAll(/^(#{1,6})\s+(.+)$/gm))
    headings.push({
      index: match.index ?? 0,
      level: match[1]!.length,
      text: clip(match[2]!.trim(), 80),
    });
  return { length: text.length, headings, preview: clip(text, 400) };
}

function canvasNodes(nodes: any[] | undefined, depth = 0): unknown[] {
  if (!nodes?.length || depth > 8) return [];
  return nodes.slice(0, 200).map((n) => ({
    id: n?.id,
    tag: n?.tag,
    name: n?.name,
    x: n?.x,
    y: n?.y,
    width: n?.width,
    height: n?.height,
    text: typeof n?.text === "string" ? clip(n.text, 40) : undefined,
    children: Array.isArray(n?.children)
      ? canvasNodes(n.children, depth + 1)
      : undefined,
  }));
}

function canvasOutline(value: any) {
  const children = value?.scene?.children ?? value?.children ?? [];
  return { childCount: children.length, children: canvasNodes(children) };
}

function presentationOutline(value: any) {
  const order = value?.slideOrder ?? [];
  return {
    size: value?.size,
    slideOrder: order,
    slides: order.slice(0, 40).map((id: string) => {
      const slide = value?.slides?.[id] ?? {};
      const elementOrder = slide.elementOrder ?? Object.keys(slide.elements ?? {});
      return {
        id,
        name: slide.name,
        elementOrder,
        elements: elementOrder.slice(0, 40).map((eid: string) => {
          const el = slide.elements?.[eid];
          return {
            id: eid,
            type: el?.type,
            preview: previewText(el, 60),
          };
        }),
      };
    }),
  };
}

function previewCell(cell: unknown) {
  if (!cell || typeof cell !== "object") return cell;
  const next: Record<string, unknown> = { ...(cell as Record<string, unknown>) };
  if (typeof next.v === "string") next.v = clip(next.v, 40);
  if (typeof next.f === "string") next.f = clip(next.f, 40);
  return next;
}

function usedCells(
  cellData: Record<string, Record<string, unknown>> | undefined,
  range?: {
    startRow?: number;
    endRow?: number;
    startColumn?: number;
    endColumn?: number;
  },
) {
  const cells: Record<string, Record<string, unknown>> = {};
  for (const [rowKey, cols] of Object.entries(cellData ?? {})) {
    const row = Number(rowKey);
    if (range?.startRow != null && row < range.startRow) continue;
    if (range?.endRow != null && row > range.endRow) continue;
    for (const [colKey, cell] of Object.entries(cols ?? {})) {
      const column = Number(colKey);
      if (range?.startColumn != null && column < range.startColumn) continue;
      if (range?.endColumn != null && column > range.endColumn) continue;
      if (cell == null) continue;
      cells[rowKey] ??= {};
      cells[rowKey]![colKey] = cell;
    }
  }
  return cells;
}

function spreadsheetOutline(value: any) {
  const sheetOrder = value?.sheetOrder ?? [];
  return {
    sheetOrder,
    sheets: sheetOrder.slice(0, 8).map((sheetId: string) => {
      const sheet = value?.sheets?.[sheetId] ?? {};
      const cells = usedCells(sheet.cellData);
      const positions = Object.entries(cells).flatMap(([row, cols]) =>
        Object.keys(cols ?? {}).map((column) => ({
          row: Number(row),
          column: Number(column),
        })),
      );
      const rows = positions.map((p) => p.row);
      const cols = positions.map((p) => p.column);
      return {
        sheetId,
        name: sheet.name,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        used: {
          rows: rows.length ? { min: Math.min(...rows), max: Math.max(...rows) } : null,
          columns: cols.length
            ? { min: Math.min(...cols), max: Math.max(...cols) }
            : null,
          cellCount: positions.length,
        },
        preview: Object.fromEntries(
          Object.entries(cells)
            .slice(0, 16)
            .map(([row, rowCells]) => [
              row,
              Object.fromEntries(
                Object.entries(rowCells)
                  .slice(0, 8)
                  .map(([column, cell]) => [column, previewCell(cell)]),
              ),
            ]),
        ),
      };
    }),
  };
}

export function documentOutline(format: string, value: unknown) {
  if (format === "rich_text") return richOutline(value);
  if (format === "markdown") return markdownOutline(String(value ?? ""));
  if (format === "canvas") return canvasOutline(value);
  if (format === "presentation") return presentationOutline(value);
  if (format === "spreadsheet") return spreadsheetOutline(value);
  return { preview: clip(JSON.stringify(value ?? null), 400) };
}

function regionValue(
  format: string,
  value: unknown,
  query: DocumentReadQuery,
): { value?: unknown; error?: string } {
  if (format === "rich_text" && query.blockId) {
    const block = findById(value, query.blockId);
    return block
      ? { value: block }
      : { error: `找不到 blockId ${query.blockId}。先 document_read 默认 outline。` };
  }
  if (format === "canvas" && query.elementId) {
    const scene = (value as any)?.scene?.children ?? (value as any)?.children;
    const element = findById(scene, query.elementId);
    return element
      ? { value: element }
      : {
          error: `找不到 elementId ${query.elementId}。先 document_read 默认 outline。`,
        };
  }
  if (format === "presentation" && query.slideId) {
    const doc = value as any;
    const slide = doc?.slides?.[query.slideId];
    return slide
      ? { value: { size: doc.size, slideId: query.slideId, slide } }
      : {
          error: `找不到 slideId ${query.slideId}。可用 ${JSON.stringify(doc?.slideOrder ?? [])}。`,
        };
  }
  if (format === "spreadsheet" && query.sheetId) {
    const doc = value as any;
    const sheet = doc?.sheets?.[query.sheetId];
    if (!sheet)
      return {
        error: `找不到 sheetId ${query.sheetId}。可用 sheetOrder ${JSON.stringify(doc?.sheetOrder ?? [])}。`,
      };
    return {
      value: {
        sheetId: query.sheetId,
        name: sheet.name,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        cells: usedCells(sheet.cellData, query),
      },
    };
  }
  return { value };
}

function paginate(value: unknown, offset: number, limit: number) {
  const content = JSON.stringify(value);
  return {
    content: content.slice(offset, offset + limit),
    nextOffset: offset + limit < content.length ? offset + limit : null,
  };
}

function hasRegion(query: DocumentReadQuery) {
  return Boolean(
    query.blockId || query.slideId || query.sheetId || query.elementId,
  );
}

/** Executor default is outline. Reviewer and explicit view=content still paginate native JSON. */
export function documentReadPayload(
  format: string,
  value: unknown,
  query: DocumentReadQuery = {},
): {
  view: "outline" | "content";
  outline?: unknown;
  content?: string;
  nextOffset: number | null;
  error?: string;
} {
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(30000, Math.max(100, query.limit ?? 16000));
  if (hasRegion(query)) {
    const region = regionValue(format, value, query);
    if (region.error)
      return { view: "content" as const, error: region.error, nextOffset: null };
    return {
      view: "content" as const,
      ...paginate(region.value, offset, limit),
    };
  }
  if ((query.view ?? "outline") === "outline")
    return {
      view: "outline" as const,
      outline: documentOutline(format, value),
      nextOffset: null,
    };
  return { view: "content" as const, ...paginate(value, offset, limit) };
}
