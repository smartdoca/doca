import { z } from "zod";
import { CANVAS_ELEMENT_PROPERTIES } from "@smartdoca/canvas/model";
import { fail } from "../../shared/errors.js";

export const documentFormats = [
  "rich_text",
  "markdown",
  "canvas",
  "presentation",
  "spreadsheet",
] as const;
export type DocumentFormat = (typeof documentFormats)[number];
const id = z.string().min(1).max(200),
  ids = z.array(id).min(1).max(1000);
const index = z.number().int().nonnegative(),
  count = z.number().int().positive().max(10000);
const json = z.record(z.string(), z.unknown());
const optionalId = id.optional();
const position = { parentId: optionalId, afterId: optionalId };
const op = (type: string, fields: z.ZodRawShape = {}) =>
  z.strictObject({ type: z.literal(type), ...fields });
export const richBlockTypes = [
  "paragraph",
  "code-block",
  "formula",
  "divider",
  "image",
  "video",
  "attachment",
  "card",
  "table",
  "table-row",
  "table-cell",
  "columns",
  "column",
  "flowchart",
  "mindmap",
  "link",
] as const;
const block = z
  .object({ id, type: z.enum(richBlockTypes), children: z.array(json).min(1) })
  .catchall(z.unknown());
const canvas = z
  .object({
    id: optionalId,
    tag: z.enum([
      "Rect",
      "Ellipse",
      "Text",
      "Image",
      "Line",
      "Arrow",
      "Path",
      "Polygon",
      "Star",
      "Group",
      "Frame",
    ]),
  })
  .catchall(z.unknown());
const pptKinds = [
  "text",
  "line",
  "table",
  "chart",
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
] as const;
const pptElement = z
  .object({
    id,
    type: z.enum(["text", "shape", "image", "line", "table", "chart"]),
    transform: z.strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
      rotation: z.number(),
    }),
  })
  .catchall(z.unknown());
const textEdit = { index, deleteCount: index, text: z.string() };
const textStyle = z.strictObject({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  code: z.boolean().optional(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
});
const table = { tableId: id };
const range = z.strictObject({
  sheetId: id,
  startRow: index,
  endRow: index,
  startColumn: index,
  endColumn: index,
});
const floatBase = {
  id: optionalId,
  anchor: range,
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  width: z.number().positive(),
  height: z.number().positive(),
};
const schemas = {
  markdown: z.union([op("append", { text: z.string() }), op("text", textEdit)]),
  rich_text: z.union([
    op("append", { text: z.string() }),
    op("text", { blockId: id, ...textEdit }),
    op("link", {
      blockId: id,
      index,
      length: count,
      url: z.string().min(1).max(2000),
    }),
    op("formatText", {
      blockId: id,
      index,
      length: count,
      style: textStyle,
      unset: z.array(z.string()).optional(),
    }),
    op("insertBlock", { ...position, block }),
    op("setBlock", {
      blockId: id,
      properties: json,
      unset: z.array(z.string()).optional(),
    }),
    op("moveBlock", { blockId: id, ...position }),
    op("deleteBlock", { blockId: id }),
    op("insertTable", { rows: count, columns: count, ...position }),
    op("insertColumnsLayout", {
      count: z.union([z.literal(2), z.literal(3), z.literal(4)]),
      ...position,
    }),
    ...["insertRows", "insertColumns"].map((t) =>
      op(t, {
        ...table,
        count,
        referenceId: optionalId,
        side: z.enum(["before", "after"]).optional(),
      }),
    ),
    ...["deleteRows", "deleteColumns"].map((t) => op(t, { ...table, ids })),
    op("merge", { ...table, rowIds: ids, columnIds: ids }),
    op("split", { ...table, mergeIds: ids }),
    ...["resizeRow", "resizeColumn"].map((t) =>
      op(t, { ...table, id, size: z.number().positive() }),
    ),
    op("setCellStyle", {
      ...table,
      cellIds: ids,
      style: z.strictObject({
        align: z.enum(["left", "center", "right"]).optional(),
        verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
        backgroundColor: z.string().optional(),
      }),
    }),
    op("setTextStyle", {
      ...table,
      cellIds: ids,
      style: textStyle,
      unset: z.array(z.string()).optional(),
    }),
    op("clearCells", { ...table, cellIds: ids }),
    op("setCellContent", {
      ...table,
      cellId: id,
      children: z.array(block).min(1),
    }),
    op("paste", { ...table, rowId: id, columnId: id, payload: json }),
    op("deleteTable", table),
    op("insertColumn", {
      layoutId: id,
      columnId: id,
      side: z.enum(["before", "after"]),
    }),
    op("deleteColumn", { layoutId: id, columnId: id }),
  ]),
  canvas: z.union([
    op("add", { element: canvas, parentId: optionalId }),
    op("patch", { id, patch: json }),
    op("remove", { ids }),
    op("place", {
      id,
      parentId: id.nullable().optional(),
      beforeId: optionalId,
    }),
    op("group", { ids }),
    op("ungroup", { id }),
    op("text", { id, ...textEdit }),
  ]),
  presentation: z.union([
    op("addSlide", { after: optionalId, slide: json.optional() }),
    op("deleteSlide", { slideId: id }),
    op("insert", { slideId: id, element: pptElement }),
    op("add", { slideId: id, kind: z.enum(pptKinds) }),
    op("patch", { slideId: id, id, patch: json }),
    op("remove", { slideId: id, ids }),
    op("moveSlide", { slideId: id, before: id.nullable().optional() }),
    op("slideProperty", {
      slideId: id,
      field: z.enum(["background", "notes", "name"]),
      value: z.string(),
    }),
    op("align", {
      slideId: id,
      ids,
      axis: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
    }),
    op("table", {
      slideId: id,
      id,
      command: z.union([
        z.strictObject({
          kind: z.literal("cell"),
          row: id,
          column: id,
          value: z.string(),
          expected: z.string().optional(),
        }),
        z.strictObject({
          kind: z.enum(["insert-row", "insert-column"]),
          after: id.nullable(),
        }),
        z.strictObject({
          kind: z.enum(["delete-row", "delete-column"]),
          target: id,
        }),
      ]),
    }),
    op("replaceText", {
      query: z.string().min(1),
      text: z.string(),
      slideId: optionalId,
      id: optionalId,
    }),
    op("formatText", { slideId: id, ids, marks: json }),
    op("paragraphFormat", { slideId: id, ids, format: json }),
    op("pageSize", {
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    op("distribute", {
      slideId: id,
      ids,
      axis: z.enum(["horizontal", "vertical"]),
    }),
    op("arrange", {
      slideId: id,
      ids,
      action: z.enum(["front", "back", "forward", "backward"]),
    }),
    ...["group", "ungroup", "duplicate"].map((t) =>
      op(t, { slideId: id, ids }),
    ),
    op("duplicateSlides", { ids }),
    op("setSlidesHidden", { ids, hidden: z.boolean() }),
    op("createSection", { name: id, ids }),
    op("renameSection", { id, name: id }),
    op("deleteSection", { id }),
    op("assignSection", { ids, sectionId: id.nullable() }),
  ]),
  spreadsheet: z.union([
    op("cells", {
      sheetId: id,
      cells: z.record(
        z.string().regex(/^\d+$/),
        z.record(z.string().regex(/^\d+$/), json.nullable()),
      ),
    }),
    op("structure", {
      edit: z.strictObject({
        sheetId: id,
        axis: z.enum(["row", "column"]),
        action: z.enum(["insert", "delete"]),
        index,
        count,
      }),
    }),
    op("mutation", { id, params: json }),
    op("putFloatingObject", {
      input: z.union([
        z.strictObject({
          ...floatBase,
          kind: z.literal("image"),
          assetId: id,
          name: z.string(),
        }),
        z.strictObject({
          ...floatBase,
          kind: z.literal("chart"),
          type: z.enum(["line", "column", "bar", "pie"]),
          title: z.string(),
          source: range,
          colors: z.array(z.string()).optional(),
        }),
      ]),
    }),
    op("updateFloatingGeometry", {
      id,
      patch: z.strictObject({
        offsetX: z.number().optional(),
        offsetY: z.number().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
      }),
    }),
    op("removeFloatingObject", { id }),
  ]),
};

const wireOperation = z
  .object({
    type: z.string().min(1).max(60),
    sheetId: z.string().min(1).max(200).optional(),
    sheet: z.string().min(1).max(200).optional(),
    sheetName: z.string().min(1).max(200).optional(),
    cells: z.any().optional(),
    values: z.any().optional(),
    data: z.any().optional(),
    edit: z.any().optional(),
    id: z.string().optional(),
    params: z.any().optional(),
    input: z.any().optional(),
    patch: z.any().optional(),
    text: z.string().optional(),
    blockId: z.string().optional(),
    block: z.any().optional(),
    element: z.any().optional(),
  })
  .passthrough();

const wireCells = z
  .union([
    z
      .array(
        z
          .object({
            row: index,
            column: index,
            v: z
              .union([z.string(), z.number(), z.boolean(), z.null()])
              .optional(),
            f: z.string().nullable().optional(),
            s: z
              .object({
                bl: z.number().optional(),
                n: z.object({ pattern: z.string() }).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .min(1),
    z.record(z.string(), z.record(z.string(), json.nullable())),
  ])
  .describe(
    '必须提供实际单元格数据。优先使用 [{row:0,column:0,v:"表头"},{row:1,column:0,f:"=SUM(B2:B4)"}]。零基坐标，禁止 null 或空数组。',
  );

export function editToolSchema(format: DocumentFormat) {
  const operation =
    format === "spreadsheet"
      ? wireOperation.extend({ cells: wireCells.optional() })
      : wireOperation;
  // Keep union checks out of the wire schema: Mastra reports those as a bare
  // "Invalid input". Named fields still have to be listed, otherwise providers
  // drop sheetId/cells and the model only retries with type.
  return z
    .object({
      resourceId: z.string().uuid(),
      seq: index,
      epochId: id,
      sheetId: z.string().min(1).max(200).optional(),
      cells: (format === "spreadsheet" ? wireCells : z.any()).optional(),
      operations: z.array(operation).min(1).max(80),
    })
    .passthrough();
}
const fields: Record<string, string[]> = {
  paragraph: ["title", "list", "checked", "quote", "indentation", "listOrder"],
  "code-block": ["language", "code"],
  formula: ["source"],
  image: ["path", "alt", "width", "caption", "showCaption", "displayStyle"],
  video: ["path", "name", "mimeType", "width"],
  attachment: ["name", "path", "size", "mimeType"],
  card: ["color", "icon"],
  table: ["columns", "merges"],
  "table-row": ["height"],
  "table-cell": ["rowId", "columnId", "backgroundColor", "verticalAlign"],
  columns: ["showDividers"],
  column: ["width"],
  link: ["url"],
  flowchart: [
    "width",
    "aspectRatio",
    "nodes",
    "edges",
    "contentWidth",
    "contentHeight",
    "previewSvg",
    "previewVersion",
  ],
  mindmap: [
    "width",
    "aspectRatio",
    "mindData",
    "contentWidth",
    "contentHeight",
    "previewSvg",
    "previewVersion",
  ],
};
const assert = (ok: unknown, message: string) => {
  if (!ok) fail(400, message);
};
// Same URL policy as the editor's insertLink: http(s)/mailto/tel/site paths only.
export const LINK_URL_PATTERN = /^(https?:\/\/|mailto:|tel:|\/|#)/i;
export function assertLinkUrl(url: unknown) {
  assert(
    typeof url === "string" && url.length <= 2000 && LINK_URL_PATTERN.test(url),
    "链接必须是 http(s)、mailto、tel 或站内地址",
  );
}
export function validateRichNode(
  node: any,
  seen = new Set<string>(),
  depth = 0,
) {
  assert(
    depth < 64 && node && typeof node === "object" && !Array.isArray(node),
    "富文本节点结构无效",
  );
  if (typeof node.text === "string" && node.type === undefined) {
    assert(
      Object.keys(node).every((k) => k === "text" || k in textStyle.shape),
      "文字叶子包含未知属性",
    );
    const { text: _, ...style } = node;
    assert(textStyle.safeParse(style).success, "文字样式值无效");
    return;
  }
  assert(
    richBlockTypes.includes(node.type),
    `不支持富文本类型 ${String(node.type)}；代码块必须用 code-block，code 保存源码，children:[{text:""}]`,
  );
  assert(
    typeof node.id === "string" && node.id && !seen.has(node.id),
    "块 ID 缺失或重复",
  );
  seen.add(node.id);
  const allowed = new Set([
    "id",
    "type",
    "align",
    "children",
    ...(fields[node.type] ?? []),
  ]);
  assert(
    Object.keys(node).every((k) => allowed.has(k)),
    `${node.type} 包含未知属性，请遵循原生元素格式`,
  );
  assert(
    Array.isArray(node.children) && node.children.length,
    "块必须包含 children",
  );
  if (node.type === "code-block") {
    assert(
      typeof node.code === "string",
      "code-block 必须把源码放在 code 字符串，不能放在 children 中",
    );
    assert(
      node.children.length === 1 && node.children[0].text === "",
      'code-block 的 children 必须是 [{text:""}]',
    );
    assert(
      node.language === undefined || typeof node.language === "string",
      "代码语言必须是字符串",
    );
  }
  if (["image", "video", "attachment"].includes(node.type))
    assert(
      typeof node.path === "string" && node.path,
      "媒体元素必须使用已授权资源 path",
    );
  if (node.type === "formula")
    assert(typeof node.source === "string", "公式必须提供 source");
  if (node.type === "link") assertLinkUrl(node.url);
  if (node.type === "flowchart") {
    assert(
      Array.isArray(node.nodes) && Array.isArray(node.edges),
      "流程图必须提供 nodes 和 edges",
    );
    const shapes = new Set(
      "process decision terminator database document multiple-documents data subprocess manual-input preparation delay display storage connector off-page-connector merge card paper-tape actor use-case class object interface component package state activity lifeline boundary control entity group note text mind-topic".split(
        " ",
      ),
    );
    const nodeIds = new Set<string>();
    for (const n of node.nodes) {
      assert(
        n &&
          typeof n.id === "string" &&
          n.id &&
          !nodeIds.has(n.id) &&
          typeof n.label === "string" &&
          Number.isFinite(n.x) &&
          Number.isFinite(n.y),
        "流程图节点需要唯一 id、label 和数值坐标",
      );
      assert(
        n.shape === undefined || shapes.has(n.shape),
        `未知流程图节点形状 ${n.shape}`,
      );
      nodeIds.add(n.id);
    }
    const edgeIds = new Set<string>();
    for (const e of node.edges) {
      assert(
        e &&
          typeof e.id === "string" &&
          e.id &&
          !edgeIds.has(e.id) &&
          nodeIds.has(e.source) &&
          nodeIds.has(e.target),
        "流程图连线必须使用唯一 id，并连接现有节点",
      );
      assert(
        e.lineType === undefined ||
          ["smoothstep", "straight", "bezier", "step"].includes(e.lineType),
        "未知流程图连线类型",
      );
      assert(
        e.arrow === undefined || ["none", "end", "both"].includes(e.arrow),
        "未知流程图箭头类型",
      );
      edgeIds.add(e.id);
    }
  }
  if (node.type === "mindmap")
    assert(
      node.mindData?.nodeData?.id &&
        typeof node.mindData.nodeData.topic === "string",
      "思维导图必须提供 mindData.nodeData",
    );
  node.children.forEach((n: any) => validateRichNode(n, seen, depth + 1));
}
export function validateEditOperations(format: string, operations: any[]) {
  assert(
    documentFormats.includes(format as DocumentFormat),
    "当前资源不是可编辑文档",
  );
  const schema = schemas[format as DocumentFormat];
  for (const operation of operations) {
    const command = schema.options.find(
      (option) => option.shape.type.value === operation?.type,
    );
    assert(
      command,
      typeof operation?.type === "string"
        ? `不支持 ${format} 命令 ${String(operation.type)}，${format === "rich_text" && operation.type === "remove" ? '删除块请用 {type:"deleteBlock",blockId:"已读取的块ID"}；' : ""}请读取 capabilities.operations`
        : `${format} 命令缺少 type 字段，请读取 capabilities.operations`,
    );
    const parsed = command!.safeParse(operation);
    assert(
      parsed.success,
      `${format} 的 ${String(operation.type)} 参数不合法：${(
        parsed.error?.issues ?? []
      )
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "参数"} ${issue.message}`)
        .join("；")
        .slice(
          0,
          1500,
        )}；该命令字段：${Object.keys(command!.shape).join("、")}；请按 capabilities 中该命令的参数重试`,
    );
    if (format === "spreadsheet" && operation.type === "cells") {
      const cells = (parsed.data as { cells?: Record<string, unknown> }).cells;
      assert(
        cells &&
          Object.values(cells).some(
            (row) => row && typeof row === "object" && Object.keys(row).length,
          ),
        'cells 不能为空。请传入 [{row:0,column:0,v:"表头"},{row:0,column:1,f:"=A1"}]，常量只写 v，公式只写 f，不要写 f:null 或省略号。',
      );
    }
    if (format === "rich_text") {
      if (operation.type === "insertBlock") validateRichNode(operation.block);
      if (operation.type === "setCellContent")
        operation.children.forEach((n: any) => validateRichNode(n));
      if (operation.type === "setBlock") {
        assert(
          !("id" in operation.properties) &&
            !("children" in operation.properties),
          "setBlock 不能更换 id 或 children；请使用文字/结构命令",
        );
        assert(
          !(operation.unset ?? []).some((k: string) =>
            ["id", "type", "children"].includes(k),
          ),
          "不能移除节点身份或类型",
        );
      }
    }
    if (format === "canvas") {
      const check = (element: any, partial = false) => {
        assert(element && typeof element === "object", "画板元素无效");
        assert(
          Object.keys(element).every(
            (k) =>
              CANVAS_ELEMENT_PROPERTIES.includes(k) ||
              k === "text" ||
              (!partial && ["id", "children"].includes(k)),
          ),
          "画板元素包含未知属性",
        );
        if (element.tag !== undefined || !partial)
          assert(canvas.safeParse(element).success, "未知画板元素类型");
        if (partial) {
          assert(
            element.tag === undefined && element.name === undefined,
            "patch 不能改变画板元素类型或原生工具分类",
          );
        } else if (element.name) {
          const names: Record<string, string[]> = {
            Rect: ["rect", "square"],
            Ellipse: ["ellipse", "circle"],
            Text: ["text"],
            Image: ["image"],
            Line: ["line", "arrow"],
            Arrow: ["arrow"],
            Path: ["path", "special-shape", "eraser"],
            Polygon: ["polygon"],
            Star: ["star"],
            Group: ["group"],
            Frame: ["frame"],
          };
          assert(
            names[element.tag]?.includes(element.name),
            "name 必须是匹配 tag 的原生工具分类；可省略由系统补齐，不能填写描述性名称",
          );
        }
        element.children?.forEach((n: any) => check(n));
      };
      if (operation.type === "add") check(operation.element);
      if (operation.type === "patch") check(operation.patch, true);
    }
  }
}
