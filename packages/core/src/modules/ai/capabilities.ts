import { defaultOfficialSkills } from "./skills.js";
import { richBlockTypes } from "./edit-schema.js";
import { editToolCallExamples } from "./tool-examples.js";
// SDK command documentation stays separate from administrator-authored workflow skills.
// Updating a custom skill must not hide the host's actual supported operations.
const commands = {
  markdown: ["append", "text"],
  rich_text: [
    "append",
    "text",
    "link",
    "formatText",
    "insertBlock",
    "setBlock",
    "moveBlock",
    "deleteBlock",
    "insertTable",
    "insertRows",
    "insertColumns",
    "deleteRows",
    "deleteColumns",
    "merge",
    "split",
    "setCellContent",
    "setCellStyle",
    "setTextStyle",
    "resizeRow",
    "resizeColumn",
    "clearCells",
    "paste",
    "deleteTable",
    "insertColumnsLayout",
    "insertColumn",
    "deleteColumn",
  ],
  canvas: ["add", "patch", "remove", "place", "group", "ungroup", "text"],
  presentation: [
    "addSlide",
    "deleteSlide",
    "insert",
    "add",
    "patch",
    "remove",
    "moveSlide",
    "slideProperty",
    "align",
    "table",
    "replaceText",
    "formatText",
    "paragraphFormat",
    "pageSize",
    "distribute",
    "arrange",
    "group",
    "ungroup",
    "duplicate",
    "duplicateSlides",
    "setSlidesHidden",
    "createSection",
    "renameSection",
    "deleteSection",
    "assignSection",
  ],
  spreadsheet: [
    "cells",
    "structure",
    "mutation",
    "putFloatingObject",
    "updateFloatingGeometry",
    "removeFloatingObject",
  ],
};
function compactEditingGuide(format: string, skillId?: string) {
  const ops = commands[format as keyof typeof commands] ?? [];
  const extra =
    format === "rich_text"
      ? "删除块用 {type:\"deleteBlock\",blockId}，不要用 remove。替换文字用 text，deleteCount 用读取到的 textLength（UTF-16，一个汉字算 1），不能猜。改表格文字用 setCellContent，cellId 用 cells[].id；局部修改才用 text，blockId 用该格 paragraphId。原生图用 insertBlock type:\"flowchart\" 或 mindmap，不要编造 node/graphic。改图先按 blockId 读取完整块，不能用 outline.nodes 的短预览重建。流程图 setBlock properties.nodes 保留节点 ID/坐标/尺寸，节点填充=fillColor、边框=color、文字=textColor；连线用 properties.edges 的 color/thickness，保留端点/端口/vertices。图块顶层不接受 color/backgroundColor/style，图内不能用 formatText 或画板 fill/stroke。思维导图改完整 properties.mindData，节点 color/style；保留层级/ID/direction。不要手写 previewSvg/previewVersion。单元格图片用 setCellContent，children 直接是 {type:\"image\",path:\"资产ID\",children:[{text:\"\"}]}，不要套 paragraph，不要写 assetId。"
      : format === "spreadsheet"
        ? "cells 必须带 sheetId。用 sheetOrder[0]；写 Sheet1 也会解析。常量只写 v，公式只写 f，不要写 f:null。"
        : format === "presentation"
          ? '删除元素用 {type:"remove",slideId,ids:[元素ID]}；样式用 {type:"formatText",slideId,ids:[元素ID],marks:{color:"#2563eb"}}；背景用 {type:"slideProperty",slideId,field:"background",value:"#ffffff"}。改正文用 {type:"replaceText",slideId,id,query:"原段落准确文字",text:"新文字"}；query 不跨段落。禁止 patch.paragraphs，SDK 不支持；省略 slideId/id 会全稿替换。不要用 blockId、elementId 或 params 代替 ids/marks。'
          : "";
  return `editTool=${format}_edit。可用命令：${ops.join("、")}。${extra}完整手册 load_skill id=${skillId ?? format}。`.trim();
}

export function documentCapabilities(format: string) {
  const key = format as keyof typeof commands;
  const skill = defaultOfficialSkills.find((s) =>
    (s.formats as readonly string[]).includes(format),
  );
  return {
    format,
    editTool: `${format}_edit`,
    loadSkill: skill?.id,
    operations: commands[key] ?? [],
    nativeDiagrams: format === "rich_text" ? ["flowchart", "mindmap"] : [],
    ...(format === "spreadsheet" ? {
      imageInsert: "已生成图片使用 image_insert，必须传 assetId、resourceId、sheetId、row、column（零基）。非表格把后三项传 null。工具会创建目标文档有权访问的图片引用。",
      floatingImageExample: {
        type: "putFloatingObject",
        input: {
          kind: "image", assetId: "已绑定此文档的资产ID", name: "图片名称",
          anchor: { sheetId: "已读取的工作表ID", startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
          width: 320, height: 240, offsetX: 8, offsetY: 8,
        },
      },
    } : {}),
    ...(format === "rich_text"
      ? {
          elementTypes: richBlockTypes,
          codeBlockExample: {
            type: "insertBlock",
            block: {
              id: "new-unique-id",
              type: "code-block",
              language: "go",
              code: "package main\n",
              children: [{ text: "" }],
            },
          },
          linkExample: {
            type: "link",
            blockId: "已读取的块ID",
            index: 0,
            length: 4,
            url: "https://example.com",
          },
        }
      : {}),
    editingGuide: compactEditingGuide(format, skill?.id),
    editingManual: skill?.content ?? "此资源不是可编辑文档。",
    firstEdit: firstEditShape(format),
    note: "命令以本工具返回的实际能力为准；不要猜命令名。完整命令手册用 load_skill。操作失败应读取错误并按规范修正，不能据此断言编辑器不支持该能力。",
  };
}

/** First page of a read: IDs and allowed commands. Call shapes live on *_edit inputExamples. */
export function documentReadCapabilities(
  format: string,
  offset: number,
  value?: unknown,
) {
  if (offset !== 0) return {};
  const caps = documentCapabilities(format);
  return {
    editTool: caps.editTool,
    operations: caps.operations,
    nativeDiagrams: caps.nativeDiagrams,
    loadSkill: caps.loadSkill,
    note: caps.note,
    editingGuide: caps.editingGuide,
    spreadsheetHint:
      format === "spreadsheet" ? spreadsheetReadHint(value as any) : undefined,
  };
}

export function editToolInputExamples(format: string) {
  return editToolCallExamples(format).map((input) => ({ input }));
}

/** Concrete first-call shape. IDs must still come from document_read. */
export function firstEditShape(format: string) {
  if (format === "spreadsheet")
    return {
      tool: "spreadsheet_edit",
      doNotSubmitAsIs: true,
      operations: [
        {
          type: "cells",
          sheetId: "Sheet1",
          cells: [
            { row: 0, column: 0, v: "费用类别" },
            { row: 0, column: 1, v: "金额" },
            { row: 1, column: 0, v: "人力成本" },
            { row: 1, column: 1, v: 300000 },
            { row: 2, column: 0, v: "合计" },
            { row: 2, column: 1, f: "=B2" },
          ],
        },
      ],
      notes: [
        "sheetId 优先用 document_read 的 sheetOrder[0]，写 Sheet1 也会解析成第一张表",
        "常量只写 v，公式只写 f，不要写 f:null、省略号或 placeholder",
        "A1 是 row:0,column:0；同一条 cells 写完整块",
      ],
    };
  if (format === "rich_text")
    return {
      tool: "rich_text_edit",
      doNotSubmitAsIs: true,
      operations: [{ type: "append", text: "第一段\n第二段" }],
    };
  if (format === "markdown")
    return {
      tool: "markdown_edit",
      doNotSubmitAsIs: true,
      operations: [{ type: "append", text: "\n\n## 标题\n正文" }],
    };
  if (format === "canvas")
    return {
      tool: "canvas_edit",
      doNotSubmitAsIs: true,
      operations: [
        {
          type: "add",
          element: {
            id: "新唯一ID",
            tag: "Rect",
            x: 80,
            y: 160,
            width: 160,
            height: 64,
            fill: "#E8F1FE",
          },
        },
      ],
    };
  if (format === "presentation")
    return {
      tool: "presentation_edit",
      doNotSubmitAsIs: true,
      operations: [{ type: "addSlide" }],
    };
  return null;
}

export function spreadsheetReadHint(value: {
  sheetOrder?: string[];
  sheets?: Record<string, { name?: string }>;
}) {
  const sheetId = value.sheetOrder?.[0];
  const name = sheetId ? value.sheets?.[sheetId]?.name : undefined;
  if (!sheetId) return null;
  return {
    activeSheet: { sheetId, name: name ?? "Sheet1" },
    firstCellsCall: {
      type: "cells",
      sheetId,
      cells: [
        { row: 0, column: 0, v: "费用类别" },
        { row: 0, column: 1, v: "金额" },
        { row: 1, column: 1, f: "=B2" },
      ],
    },
    notes: [
      `sheetId 用 ${sheetId}。写 ${name ?? "Sheet1"} 也会解析成这张表。常量只写 v，公式只写 f，不要写 f:null。`,
      "这是命令形状。把要填的格子一次写全，不要原样提交示例，也不要写省略号。",
      "表格插图必须调用 image_insert，五个参数都要传：assetId、resourceId、sheetId、row、column；不要嵌套 spreadsheet，不要把对话图片 ID 写进 cells 或 putFloatingObject",
    ],
    imageInsertCall: {
      tool: "image_insert",
      assetId: "已生成图片的 assetId",
      resourceId: "当前文档 resourceId",
      sheetId,
      row: 0,
      column: 0,
    },
  };
}
