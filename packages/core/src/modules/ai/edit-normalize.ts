import { randomUUID } from "node:crypto";

const a1 = /^\$?([A-Za-z]+)\$?(\d+)$/;
const EMU_PER_PX = 9525;
const pptShapeKinds = new Set([
  "rect",
  "roundRect",
  "ellipse",
  "triangle",
  "rtTriangle",
  "diamond",
  "parallelogram",
  "trapezoid",
  "pentagon",
  "hexagon",
  "octagon",
  "plus",
  "star5",
  "star6",
  "star8",
  "heart",
  "teardrop",
  "wedgeRectCallout",
  "rightArrow",
  "leftArrow",
  "upArrow",
  "downArrow",
  "leftRightArrow",
  "chevron",
  "homePlate",
]);
const pptKindAliases: Record<string, string> = {
  title: "text",
  textbox: "text",
  body: "text",
  rectangle: "rect",
  circle: "ellipse",
  oval: "ellipse",
};
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

function spreadsheetOperation(
  op: Record<string, unknown>,
): Record<string, unknown> & { type: string } {
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
  // Some models use the generic tool payload name for a native patch.
  // Only accept the unambiguous alias; conflicting payloads still fail validation.
  if (op.type === "patch" && op.patch === undefined && op.params &&
      typeof op.params === "object" && !Array.isArray(op.params)) {
    const { params, ...rest } = op;
    return { ...rest, patch: params };
  }
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
    if (!Array.isArray(next.children) || next.children.length === 0)
      next.children = [{ text: "" }];
  }
  if (Array.isArray(next.children))
    next.children = next.children.map(normalizeMediaNode);
  return next;
}

function normalizePptTransform(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const transform = { ...(value as Record<string, unknown>) };
  if (typeof transform.rotation !== "number") transform.rotation = 0;
  const numbers = ["x", "y", "width", "height"]
    .map((key) => transform[key])
    .filter((item): item is number => typeof item === "number");
  // A slide is millions of EMU wide. Values under 20,000 are CSS pixels.
  if (numbers.length && Math.max(...numbers.map((item) => Math.abs(item))) < 20000)
    for (const key of ["x", "y", "width", "height"])
      if (typeof transform[key] === "number")
        transform[key] = Math.round(transform[key] * EMU_PER_PX);
  return transform;
}

function textParagraphs(element: Record<string, unknown>) {
  if (Array.isArray(element.paragraphs) && element.paragraphs.length)
    return element.paragraphs;
  const raw =
    typeof element.paragraphs === "string"
      ? element.paragraphs
      : typeof element.text === "string"
        ? element.text
        : typeof element.content === "string"
          ? element.content
          : undefined;
  if (raw === undefined) return undefined;
  const leaf: Record<string, unknown> = { text: raw };
  for (const key of ["fontSize", "bold", "italic", "color", "fontFamily"])
    if (element[key] !== undefined) leaf[key] = element[key];
  return [{ type: "paragraph", children: [leaf] }];
}

function normalizePptElement(element: unknown) {
  if (!element || typeof element !== "object" || Array.isArray(element))
    return element;
  const next = { ...(element as Record<string, unknown>) };
  if (typeof next.id !== "string" || !next.id) next.id = randomUUID();
  if (next.transform) next.transform = normalizePptTransform(next.transform);
  const shape = pptShapeKinds.has(String(next.type)) ? String(next.type) : undefined;
  if (shape) {
    next.shape ??= shape;
    next.type = "shape";
  }
  if (next.type === "text") {
    const paragraphs = textParagraphs(next);
    if (paragraphs) next.paragraphs = paragraphs;
  }
  if (typeof next.text === "string") delete next.text;
  for (const key of ["content", "fontSize", "fontFamily", "bold", "italic", "underline"])
    delete next[key];
  return next;
}

function presentationOperation(op: Record<string, unknown>) {
  const next = { ...op };
  if (typeof next.kind === "string" && pptKindAliases[next.kind])
    next.kind = pptKindAliases[next.kind];
  if (next.type === "insert") next.element = normalizePptElement(next.element);
  if (
    next.type === "addSlide" &&
    next.slide &&
    typeof next.slide === "object" &&
    !Array.isArray(next.slide)
  ) {
    const slide = { ...(next.slide as Record<string, unknown>) };
    if (slide.elements && typeof slide.elements === "object" && !Array.isArray(slide.elements))
      slide.elements = Object.fromEntries(
        Object.entries(slide.elements as Record<string, unknown>).map(([id, element]) => [
          id,
          normalizePptElement(
            element && typeof element === "object"
              ? { id, ...(element as Record<string, unknown>) }
              : element,
          ),
        ]),
      );
    next.slide = slide;
  }
  if (next.type === "patch" && next.patch && typeof next.patch === "object") {
    const patch = { ...(next.patch as Record<string, unknown>) };
    if (patch.transform) patch.transform = normalizePptTransform(patch.transform);
    next.patch = patch;
  }
  return next;
}

const codeBlockTypes = new Set(["code", "codeBlock", "code_block", "pre", "code-block"]);

function leafText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as { text?: unknown; children?: unknown };
  if (typeof record.text === "string" && record.text) return record.text;
  if (!Array.isArray(record.children)) return "";
  return record.children.map(leafText).filter(Boolean).join("\n");
}

function normalizeCodeBlock(node: Record<string, unknown>) {
  if (!codeBlockTypes.has(String(node.type))) return node;
  const next: Record<string, unknown> = { ...node, type: "code-block" };
  if (typeof next.lang === "string" && typeof next.language !== "string") {
    next.language = next.lang;
    delete next.lang;
  }
  if (typeof next.code !== "string") next.code = leafText({ children: next.children });
  next.children = [{ text: "" }];
  return next;
}

function normalizeRichBlock(node: unknown): unknown {
  const media = normalizeMediaNode(node);
  if (!media || typeof media !== "object" || Array.isArray(media)) return media;
  const next = normalizeCodeBlock(media as Record<string, unknown>);
  if (next.type !== "code-block" && Array.isArray(next.children))
    next.children = next.children.map(normalizeRichBlock);
  return next;
}

function richTextOperation(op: Record<string, unknown>) {
  let next = op;
  if (next.type === "insertBlock" && next.block && typeof next.block === "object")
    next = { ...next, block: normalizeRichBlock(next.block) as Record<string, unknown> };
  if (next.type === "setCellContent" && Array.isArray(next.children))
    next = { ...next, children: next.children.map(normalizeRichBlock) };
  return next;
}

const fencedBlock = /^```([A-Za-z0-9_+-]*)\n([\s\S]*?)\n```$/;

/** Host-side repair after a model save. Invalid code blocks become native
 * blocks, and a sentence that starts immediately after inline code gets a space. */
export function repairRichTextValue(value: unknown): { value: any[]; changed: boolean } {
  if (!Array.isArray(value)) return { value: [], changed: false };
  const next = structuredClone(value);
  let changed = false;
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "paragraph" && Array.isArray(node.children) && node.children.length === 1) {
      const only = node.children[0];
      const fenced = typeof only?.text === "string" ? only.text.trim().match(fencedBlock) : null;
      if (fenced) {
        node.type = "code-block";
        node.language = fenced[1] || "text";
        node.code = fenced[2] ?? "";
        node.children = [{ text: "" }];
        delete node.title;
        delete node.list;
        changed = true;
        return;
      }
    }
    if (codeBlockTypes.has(String(node.type)) && node.type !== "code-block") {
      node.type = "code-block";
      changed = true;
    }
    if (node.type === "code-block") {
      if (typeof node.code !== "string") {
        node.code = leafText(node);
        changed = true;
      }
      if (
        !Array.isArray(node.children) ||
        node.children.length !== 1 ||
        node.children[0]?.text !== "" ||
        node.children[0]?.type
      ) {
        node.children = [{ text: "" }];
        changed = true;
      }
      return;
    }
    if (!Array.isArray(node.children)) return;
    for (let i = 0; i < node.children.length; i++) {
      const leaf = node.children[i];
      if (!leaf || typeof leaf.text !== "string" || leaf.code !== true) continue;
      const version = leaf.text.match(/^(.*\d)\.([A-Z].*)$/);
      if (version?.[1] && version[2]) {
        leaf.text = version[1];
        node.children.splice(i + 1, 0, { text: `. ${version[2]}` });
        changed = true;
        continue;
      }
      const following = node.children[i + 1];
      if (!following || typeof following.text !== "string" || following.type) continue;
      if (/^[A-Za-z\u4e00-\u9fff]/.test(following.text)) {
        following.text = ` ${following.text}`;
        changed = true;
      } else if (/^\.[A-Za-z\u4e00-\u9fff]/.test(following.text)) {
        following.text = following.text.replace(/^\./, ". ");
        changed = true;
      }
    }
    node.children.forEach(visit);
  };
  next.forEach(visit);
  return { value: next, changed };
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
  operations: Array<{ type: string; [key: string]: any }>,
  snapshot?: { sheetOrder?: string[]; sheets?: Record<string, { name?: string }> },
): Array<{ type: string; [key: string]: any }> {
  return operations.map((op) => {
    if (format === "spreadsheet") {
      const next: Record<string, unknown> & { type: string } =
        spreadsheetOperation(op);
      if (snapshot && next.type === "cells")
        next.sheetId = resolveSpreadsheetSheetId(next.sheetId, snapshot);
      return next;
    }
    if (format === "canvas")
      return canvasOperation(op) as { type: string; [key: string]: any };
    if (format === "rich_text")
      return richTextOperation(op) as { type: string; [key: string]: any };
    if (format === "presentation")
      return presentationOperation(op) as { type: string; [key: string]: any };
    return op;
  });
}
