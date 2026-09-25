import { expect, it } from "vitest";
import {
  collectEditOperations,
  normalizeEditOperations,
  parseA1,
  resolveSpreadsheetSheetId,
} from "../packages/core/src/modules/ai/edit-normalize.js";
import { validateEditOperations } from "../packages/core/src/modules/ai/edit-schema.js";

it("parses A1 and common spreadsheet payloads into cells", () => {
  expect(parseA1("B2")).toEqual({ row: 1, column: 1 });
  const [op] = normalizeEditOperations("spreadsheet", [
    {
      type: "setCells",
      sheet: "Sheet1",
      cells: { A1: "表头", B1: 10, C1: "=B1*2" },
    },
  ]);
  expect(op).toMatchObject({
    type: "cells",
    sheetId: "Sheet1",
    cells: {
      "0": {
        "0": { v: "表头", f: null },
        "1": { v: 10, f: null },
        "2": { v: null, f: "=B1*2" },
      },
    },
  });
  const [values] = normalizeEditOperations("spreadsheet", [
    {
      type: "cells",
      sheetId: "sheet",
      values: [
        [{ value: "A" }, { formula: "=1" }],
        ["B", 2],
      ],
    },
  ]);
  expect(values!.cells).toEqual({
    "0": { "0": { v: "A", f: null }, "1": { v: null, f: "=1" } },
    "1": { "0": { v: "B", f: null }, "1": { v: 2, f: null } },
  });
});

it("resolves Sheet1 names to the real sheet UUID", () => {
  const sheetId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  expect(
    resolveSpreadsheetSheetId("Sheet1", {
      sheetOrder: [sheetId],
      sheets: { [sheetId]: { name: "Sheet1" } },
    }),
  ).toBe(sheetId);
  expect(
    resolveSpreadsheetSheetId("换成 outline.sheetOrder[0]，不要写 Sheet1", {
      sheetOrder: [sheetId],
      sheets: { [sheetId]: { name: "Sheet1" } },
    }),
  ).toBe(sheetId);
  const normalized = normalizeEditOperations("spreadsheet", [
    { type: "write", sheetId: "Sheet1", cells: { A1: 1 } },
  ]);
  expect(() => validateEditOperations("spreadsheet", normalized)).not.toThrow();
});

it("hydrates JSON-string cells and top-level sheetId/cells onto the operation", () => {
  const [fromString] = normalizeEditOperations("spreadsheet", [
    {
      type: "cells",
      sheetId: "sheet",
      cells: JSON.stringify({ A1: "销量", B1: 10 }),
    },
  ]);
  expect(fromString!.cells).toEqual({
    "0": { "0": { v: "销量", f: null }, "1": { v: 10, f: null } },
  });
  const collected = collectEditOperations({
    sheetId: "sheet",
    cells: [{ row: 0, column: 0, v: "表头", f: null }],
    operations: [{ type: "cells" }],
  });
  const [merged] = normalizeEditOperations("spreadsheet", collected as any);
  expect(merged).toMatchObject({
    type: "cells",
    sheetId: "sheet",
    cells: { "0": { "0": { v: "表头", f: null } } },
  });
  expect(() =>
    validateEditOperations(
      "spreadsheet",
      normalizeEditOperations("spreadsheet", [
        { type: "cells", sheetId: "sheet" },
      ]),
    ),
  ).toThrow(/cells 不能为空/);
});

it("keeps sheetId and cells on the advertised tool schema", async () => {
  const { editToolSchema } = await import(
    "../packages/core/src/modules/ai/edit-schema.js"
  );
  const parsed = editToolSchema("spreadsheet").parse({
    resourceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    seq: 0,
    epochId: "e",
    sheetId: "sheet",
    operations: [
      {
        type: "cells",
        sheetId: "sheet",
        cells: [{ row: 0, column: 0, v: "表头", f: null }],
      },
    ],
  });
  expect(parsed.operations[0]).toMatchObject({
    type: "cells",
    sheetId: "sheet",
    cells: [{ row: 0, column: 0, v: "表头", f: null }],
  });
});

it("normalizes canvas tags and rich-text code blocks", () => {
  const [canvas] = normalizeEditOperations("canvas", [
    { type: "add", element: { id: "n1", tag: "rect", x: 0, y: 0 } },
  ]);
  expect(canvas!.element).toMatchObject({ tag: "Rect" });
  const [code] = normalizeEditOperations("rich_text", [
    { type: "insertBlock", block: { id: "c1", type: "codeBlock", code: "x" } },
  ]);
  expect(code!.block).toMatchObject({ type: "code-block" });
});

it("accepts image cells written with assetId or wrapped in a paragraph", () => {
  const tableId = "d800d841-c1f3-4ffa-b690-55bde37dc416";
  const border = "020c271d-e108-43cd-921c-42c6b8efd82f";
  const husky = "1385f180-f8b0-4f65-ba2e-72a327f0a192";
  const [direct, wrapped] = normalizeEditOperations("rich_text", [
    {
      type: "setCellContent",
      tableId,
      cellId: "b7a56b16-3a0b-4ba0-b89c-62db1289636f",
      children: [{ id: "img-border-collie", type: "image", assetId: border }],
    },
    {
      type: "setCellContent",
      tableId,
      cellId: "fc19d3f4-78bb-4f7c-ba1d-e4ca0e45cf00",
      children: [
        {
          id: "cell-paragraph-1",
          type: "paragraph",
          children: [{ id: "img-husky", type: "image", assetId: husky }],
        },
      ],
    },
  ]);
  expect(direct!.children).toEqual([
    {
      id: "img-border-collie",
      type: "image",
      path: border,
      children: [{ text: "" }],
    },
  ]);
  expect(wrapped!.children).toEqual([
    {
      id: "img-husky",
      type: "image",
      path: husky,
      children: [{ text: "" }],
    },
  ]);
  expect(() =>
    validateEditOperations("rich_text", [direct!, wrapped!]),
  ).not.toThrow();
});
