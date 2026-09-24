const a1 = /^\$?([A-Za-z]+)\$?(\d+)$/;
const canvasTags: Record<string, string> = {
  rect: "Rect",
  rectangle: "Rect",
  square: "Rect",
  ellipse: "Ellipse",
  circle: "Ellipse",
  text: "Text",
  image: "Image",
  line: "Line",
  arrow: "Arrow",
  path: "Path",
  polygon: "Polygon",
  star: "Star",
  group: "Group",
  frame: "Frame",
};

export function parseA1(ref: string) {
  const match = ref.trim().match(a1);
  if (!match) return null;
  let column = 0;
  for (const ch of match[1]!.toUpperCase())
    column = column * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, column: column - 1 };
}

function cellValue(input: unknown) {
  if (input == null) return { v: null, f: null };
  if (typeof input !== "object") {
    const text = String(input);
    return text.startsWith("=")
      ? { v: null, f: text }
      : { v: input, f: null };
  }
  const cell = input as Record<string, unknown>;
  const formula =
    cell.f ?? cell.formula ?? (typeof cell.v === "string" && cell.v.startsWith("=")
      ? cell.v
      : null);
  const value =
    formula != null
      ? null
      : (cell.v ?? cell.value ?? cell.text ?? cell.content ?? null);
  const next: Record<string, unknown> = { v: value, f: formula };
  if (cell.s !== undefined) next.s = cell.s;
  return next;
}

function setCell(
  cells: Record<string, Record<string, unknown>>,
  row: number,
  column: number,
  value: unknown,
) {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0)
    return;
  const key = String(row);
  cells[key] ??= {};
  cells[key]![String(column)] = cellValue(value);
}

function fromA1Map(input: Record<string, unknown>) {
  const cells: Record<string, Record<string, unknown>> = {};
  let sawA1 = false;
  for (const [key, value] of Object.entries(input)) {
    const pos = parseA1(key);
    if (!pos) return null;
    sawA1 = true;
    setCell(cells, pos.row, pos.column, value);
  }
  return sawA1 ? cells : null;
}

function normalizeCells(input: unknown): unknown {
  if (Array.isArray(input)) {
    const cells: Record<string, Record<string, unknown>> = {};
    if (input.every((row) => Array.isArray(row))) {
      input.forEach((row, r) =>
        (row as unknown[]).forEach((value, c) => setCell(cells, r, c, value)),
      );
      return cells;
    }
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const pos =
        typeof row.cell === "string"
          ? parseA1(row.cell)
          : {
              row: Number(row.row ?? row.r ?? row.rowIndex),
              column: Number(row.column ?? row.col ?? row.c ?? row.columnIndex),
            };
      if (pos && Number.isInteger(pos.row) && Number.isInteger(pos.column))
        setCell(cells, pos.row, pos.column, row);
    }
    return cells;
  }
  if (!input || typeof input !== "object") return input;
  const mapped = fromA1Map(input as Record<string, unknown>);
  if (mapped) return mapped;
  const cells: Record<string, Record<string, unknown>> = {};
  for (const [row, columns] of Object.entries(input)) {
    if (!columns || typeof columns !== "object" || Array.isArray(columns))
      continue;
    for (const [column, value] of Object.entries(columns))
      setCell(cells, Number(row), Number(column), value);
  }
  return cells;
}

export function hydrateJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

const cellAliases = [
  "cells",
  "setCells",
  "writeCells",
  "setRange",
  "write",
  "updateCells",
];

export function collectEditOperations(args: Record<string, unknown>) {
  const raw = hydrateJson(args.operations);
  const operations = Array.isArray(raw) ? raw : [];
  return operations.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const op = { ...(item as Record<string, unknown>) };
    for (const key of [
      "cells",
      "values",
      "data",
      "edit",
      "input",
      "params",
      "patch",
      "block",
      "element",
    ])
      if (key in op) op[key] = hydrateJson(op[key]);
    if (cellAliases.includes(String(op.type ?? ""))) {
      op.sheetId ??= args.sheetId ?? args.sheet ?? args.sheetName;
      op.cells ??= args.cells ?? args.values ?? args.data;
      op.cells = hydrateJson(op.cells);
    }
    return op;
  });
}

function spreadsheetOperation(op: Record<string, unknown>) {
  const type = String(op.type ?? "");
  const aliased = cellAliases.includes(type) ? "cells" : type;
  if (aliased !== "cells") return { ...op, type: aliased };
  const start =
    typeof op.range === "string"
      ? parseA1(String(op.range).split(":")[0] ?? "")
      : null;
  const startRow = Number(op.startRow ?? start?.row ?? 0);
  const startColumn = Number(op.startColumn ?? start?.column ?? 0);
  let cells = hydrateJson(op.cells ?? op.values ?? op.data);
  if (Array.isArray(cells) && cells.every((row) => Array.isArray(row))) {
    const mapped: Record<string, Record<string, unknown>> = {};
    (cells as unknown[][]).forEach((row, r) =>
      row.forEach((value, c) =>
        setCell(mapped, startRow + r, startColumn + c, value),
      ),
    );
    cells = mapped;
  } else cells = normalizeCells(cells);
  return {
    ...op,
    type: "cells",
    sheetId: op.sheetId ?? op.sheet ?? op.sheetName,
    cells: cells && typeof cells === "object" ? cells : {},
  };
}

function canvasOperation(op: Record<string, unknown>) {
  const element = op.element;
  if (op.type !== "add" || !element || typeof element !== "object") return op;
  const tag = String((element as { tag?: string }).tag ?? "");
  const next = canvasTags[tag.toLowerCase()];
  return next
    ? { ...op, element: { ...(element as object), tag: next } }
    : op;
}

const mediaTypes = new Set(["image", "video", "attachment"]);

function normalizeMediaNode(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const next = { ...(node as Record<string, unknown>) };
  if (typeof next.text === "string" && next.type === undefined) return next;
  if (mediaTypes.has(String(next.type))) {
    if (typeof next.path !== "string" && typeof next.assetId === "string")
      next.path = next.assetId;
    delete next.assetId;
    delete next.resourceId;
    if (!Array.isArray(next.children) || next.children.length === 0)
      next.children = [{ text: "" }];
  }
  if (Array.isArray(next.children))
    next.children = next.children.map(normalizeMediaNode);
  return next;
}

function cellChildren(children: unknown[]) {
  return children.flatMap((child) => {
    const node = normalizeMediaNode(child) as {
      type?: string;
      children?: unknown[];
    };
    if (
      node?.type === "paragraph" &&
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      node.children.every((item) =>
        mediaTypes.has(
          String((item as { type?: string } | null)?.type ?? ""),
        ),
      )
    )
      return node.children;
    return [node];
  });
}

function richTextOperation(op: Record<string, unknown>) {
  const block = op.block as { type?: string } | undefined;
  let next = op;
  if (op.type === "insertBlock" && block?.type === "codeBlock")
    next = { ...op, block: { ...block, type: "code-block" } };
  if (next.type === "insertBlock" && next.block && typeof next.block === "object")
    next = { ...next, block: normalizeMediaNode(next.block) as Record<string, unknown> };
  if (next.type === "setCellContent" && Array.isArray(next.children))
    next = { ...next, children: cellChildren(next.children) };
  return next;
}

export function resolveSpreadsheetSheetId(
  sheetId: unknown,
  snapshot: { sheetOrder?: string[]; sheets?: Record<string, { name?: string }> },
) {
  const id = String(sheetId ?? "").trim();
  const order = snapshot.sheetOrder ?? [];
  if (!id) return order[0];
  if (order.includes(id) || snapshot.sheets?.[id]) return id;
  const named = Object.entries(snapshot.sheets ?? {}).find(
    ([, sheet]) => sheet.name?.toLowerCase() === id.toLowerCase(),
  );
  if (named) return named[0];
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(id)) return order[0] ?? id;
  return id;
}

export function normalizeEditOperations(
  format: string,
  operations: Array<Record<string, unknown>>,
  snapshot?: { sheetOrder?: string[]; sheets?: Record<string, { name?: string }> },
) {
  return operations.map((op) => {
    if (format === "spreadsheet") {
      const next = spreadsheetOperation(op);
      if (snapshot && next.type === "cells")
        next.sheetId = resolveSpreadsheetSheetId(next.sheetId, snapshot);
      return next;
    }
    if (format === "canvas") return canvasOperation(op);
    if (format === "rich_text") return richTextOperation(op);
    return op;
  });
}
