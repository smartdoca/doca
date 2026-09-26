import { expect, it } from "vitest";
import {
  documentReadPayload,
  documentOutline,
} from "../packages/core/src/modules/ai/document-read.js";
import {
  documentReadCapabilities,
  editToolInputExamples,
} from "../packages/core/src/modules/ai/capabilities.js";
import { taskStateHint } from "../apps/server/src/services/ai/context-budget.js";

const sheetId = "11111111-1111-4111-8111-111111111111";
it("reports full UTF-16 text length even when a rich-text preview is clipped", () => {
  const value = [{ id: "p", type: "paragraph", children: [
    { text: "正文".repeat(80) },
    { type: "link", children: [{ text: "📄链接" }] },
  ] }];
  const outline = documentOutline("rich_text", value) as any;
  expect(outline.blocks[0].textLength).toBe(164);
  expect(outline.blocks[0].preview.length).toBeLessThan(164);
});
const spreadsheet = {
  sheetOrder: [sheetId],
  sheets: {
    [sheetId]: {
      id: sheetId,
      name: "Sheet1",
      rowCount: 1000,
      columnCount: 100,
      cellData: {
        0: { 0: { v: "销量".repeat(80), f: null }, 1: { v: 10, f: null } },
        1: { 1: { v: null, f: "=B1*2" } },
      },
    },
  },
};

it("defaults document reads to an outline with stable IDs instead of native JSON", () => {
  const blocks = [
    {
      id: "title",
      type: "heading-one",
      children: [{ text: "项目计划正文会很长".repeat(20) }],
    },
    {
      id: "table",
      type: "table",
      children: [
        {
          id: "row-1",
          type: "table-row",
          children: [
            {
              id: "cell-1",
              type: "table-cell",
              rowId: "row-1",
              columnId: "col-1",
              children: [{ text: "目标" }],
            },
          ],
        },
      ],
    },
  ];
  const result = documentReadPayload("rich_text", blocks);
  expect(result.view).toBe("outline");
  expect(result.nextOffset).toBeNull();
  expect("content" in result).toBe(false);
  expect(result.outline).toMatchObject({
    blockCount: 2,
    blocks: [
      { id: "title", type: "heading-one" },
      { id: "table", type: "table", rows: [{ id: "row-1", cells: [{ id: "cell-1" }] }] },
    ],
  });
  expect(JSON.stringify(result.outline).length).toBeLessThan(
    JSON.stringify(blocks).length,
  );
});

it("reads a rich_text region by blockId and full content when requested", () => {
  const blocks = [
    { id: "a", type: "paragraph", children: [{ text: "保留" }] },
    { id: "b", type: "paragraph", children: [{ text: "要改的段落" }] },
  ];
  const region = documentReadPayload("rich_text", blocks, { blockId: "b" });
  expect(region.view).toBe("content");
  expect(JSON.parse(region.content!)).toMatchObject({
    id: "b",
    children: [{ text: "要改的段落" }],
  });
  const missing = documentReadPayload("rich_text", blocks, { blockId: "missing" });
  expect(missing.error).toContain("blockId");
  const page = documentReadPayload("markdown", "# 标题\n\n" + "正文".repeat(8000), {
    view: "content",
    offset: 0,
    limit: 120,
  });
  expect(page.content).toHaveLength(120);
  expect(page.nextOffset).toBe(120);
});

it("keeps spreadsheet sheetOrder and presentation size on the outline", () => {
  const sheet = documentReadPayload("spreadsheet", spreadsheet);
  expect(sheet.outline).toMatchObject({
    sheetOrder: [sheetId],
    sheets: [{ sheetId, name: "Sheet1", used: { cellCount: 3 } }],
  });
  expect(JSON.stringify(sheet.outline)).not.toContain("销量".repeat(80));
  const cells = documentReadPayload("spreadsheet", spreadsheet, {
    sheetId,
    startRow: 0,
    endRow: 0,
  });
  expect(JSON.parse(cells.content!).cells["0"]["0"].v).toBe("销量".repeat(80));
  expect(JSON.parse(cells.content!).cells["1"]).toBeUndefined();

  const deck = {
    size: { width: 12191600, height: 6858000 },
    slideOrder: ["s1"],
    slides: {
      s1: {
        name: "封面",
        elementOrder: ["t1"],
        elements: {
          t1: {
            id: "t1",
            type: "text",
            paragraphs: [{ children: [{ text: "项目计划" }] }],
          },
        },
      },
    },
  };
  const outline = documentOutline("presentation", deck);
  expect(outline).toMatchObject({
    size: deck.size,
    slideOrder: ["s1"],
    slides: [{ id: "s1", name: "封面", elements: [{ id: "t1", preview: "项目计划" }] }],
  });
});

it("outlines canvas nodes and markdown headings", () => {
  expect(
    documentOutline("canvas", {
      scene: {
        children: [
          { id: "box", tag: "Rect", x: 8, y: 10, width: 40, height: 20 },
          { id: "label", tag: "Text", text: "需求评审" },
        ],
      },
    }),
  ).toMatchObject({
    childCount: 2,
    children: [
      { id: "box", tag: "Rect" },
      { id: "label", tag: "Text", text: "需求评审" },
    ],
  });
  expect(
    documentOutline("markdown", "# 目标\n\n正文\n\n## 验收\n检查"),
  ).toMatchObject({
    headings: [
      { level: 1, text: "目标" },
      { level: 2, text: "验收" },
    ],
  });
});

it("moves first-call command shapes onto edit tools and recites edit state", () => {
  expect("firstEdit" in documentReadCapabilities("rich_text", 0)).toBe(false);
  expect(documentReadCapabilities("rich_text", 0).editTool).toBe("rich_text_edit");
  const operations = editToolInputExamples("spreadsheet")[0]!.input
    .operations as { type: string }[];
  expect(operations[0]).toMatchObject({ type: "cells" });
  expect(
    taskStateHint({
      resourceId: "doc",
      seq: 4,
      epochId: "e1",
      applied: ["append"],
      plan: { goal: "写项目计划", steps: ["起草", "保存"] },
    }),
  ).toMatchObject({
    current: { resourceId: "doc", seq: 4, epochId: "e1" },
    done: ["append"],
    next: "保存",
    seq: 4,
  });
});
