/** Placeholder IDs are schema-valid. Models must replace them with values from the latest tool result. */
export const SAMPLE = {
  doc: "11111111-1111-4111-8111-111111111111",
  asset: "22222222-2222-4222-8222-222222222222",
  file: "33333333-3333-4333-8333-333333333333",
  folder: "44444444-4444-4444-8444-444444444444",
  note: "66666666-6666-4666-8666-666666666666",
  sheet: "77777777-7777-4777-8777-777777777777",
};

const editBase = {
  resourceId: SAMPLE.doc,
  seq: 1,
  epochId: "换成 document_read 的 epochId",
};

export const TOOL_EXAMPLES: Record<string, Record<string, unknown>[]> = {
  load_skill: [{ id: "writing" }, { id: "spreadsheet" }],
  web_fetch: [
    { url: "https://example.com/page", offset: 0, limit: 12000 },
  ],
  web_search: [{ query: "公开技术文档" }],
  http_request: [
    {
      method: "GET",
      url: "https://api.example.com/v1/status",
      headers: { Authorization: "Bearer {{PASSWORD}}" },
    },
    {
      method: "POST",
      url: "https://api.example.com/v1/accounts",
      headers: {
        Authorization: "Bearer 用户提供的令牌",
        "Content-Type": "application/json",
      },
      body: '{"name":"demo"}',
    },
  ],
  note_write: [
    {
      content: "## 常用\n- 报告用中文，先写结论\n- 工单接口令牌：{{PASSWORD}}\n",
    },
  ],
  secret_write: [{ key: "PASSWORD", value: "用户本轮给出的密码" }],
  secret_delete: [{ key: "PASSWORD" }],
  document_request_access: [
    {
      resourceId: SAMPLE.doc,
      role: "reader",
      reason: "用户要求读取这份文档",
    },
  ],
  image_insert: [
    {
      assetId: SAMPLE.asset,
      resourceId: SAMPLE.doc,
      sheetId: SAMPLE.sheet,
      row: 0,
      column: 0,
    },
    {
      assetId: SAMPLE.asset,
      resourceId: SAMPLE.doc,
      sheetId: null,
      row: null,
      column: null,
    },
  ],
  image_generate: [{ prompt: "蓝色几何图标，白底，无文字" }],
  image_show: [{}, { assetId: SAMPLE.asset }],
  ask_user: [
    {
      title: "文档用哪种格式？",
      options: ["富文本", "Markdown", "表格"],
    },
  ],
  task_plan: [
    {
      goal: "写一份项目计划并保存",
      steps: ["读取文档", "按段落写入", "保存"],
      criteria: ["含目标和验收", "已保存到指定文档"],
      mode: "deliver",
    },
  ],
  knowledge_search: [{ query: "项目计划", mode: "auto", offset: 0 }],
  document_exists: [{ ids: [SAMPLE.doc] }],
  file_read: [{ fileId: SAMPLE.file, offset: 0, limit: 12000 }],
  file_browse: [{ folderId: "root" }, { fileId: SAMPLE.file }],
  file_search: [{ query: "预算表格", folderId: "root", limit: 20 }],
  file_manage: [
    { action: "rename", fileId: SAMPLE.file, name: "新文件名.png" },
    { action: "move", fileIds: [SAMPLE.file], parentId: "root" },
    { action: "copy", fileIds: [SAMPLE.file], parentId: SAMPLE.folder },
    { action: "delete", fileIds: [SAMPLE.file] },
  ],
  file_folder_manage: [
    { action: "create", name: "项目资料", parentId: "root" },
    { action: "rename", folderId: SAMPLE.folder, name: "新名称" },
    { action: "move", folderId: SAMPLE.folder, parentId: "root" },
    { action: "copy", folderId: SAMPLE.folder, parentId: "root" },
    { action: "delete", folderId: SAMPLE.folder },
  ],
  file_download: [
    {
      url: "https://example.com/a.pdf",
      destination: "folder",
      parentId: "root",
      name: "a.pdf",
    },
    {
      url: "https://example.com/a.pdf",
      destination: "local",
      parentId: "root",
    },
  ],
  file_create: [
    {
      format: "markdown",
      name: "周报",
      parentId: "root",
      content: "# 周报\n本周完成…",
      download: false,
    },
    {
      format: "excel",
      name: "预算",
      parentId: "root",
      content: "",
      rows: [
        ["项目", "金额"],
        ["差旅", "1200"],
      ],
      download: false,
    },
  ],
  page_state: [
    { action: "get", key: "ui.filesView" },
    { action: "set", key: "ui.filesView", value: "list" },
    { action: "set", key: "ui.locale", value: "en" },
    {
      action: "set",
      key: "ui.notesFloat",
      value: { open: true, collapsed: false, x: 24, y: 80, width: 380, height: 560 },
    },
    { action: "set", key: "ai.model", value: "model-id" },
  ],
  document_read: [
    { resourceId: SAMPLE.doc },
    { resourceId: SAMPLE.doc, blockId: "已读取的块ID" },
    {
      resourceId: SAMPLE.doc,
      sheetId: SAMPLE.sheet,
      startRow: 0,
      endRow: 20,
      startColumn: 0,
      endColumn: 5,
    },
    { resourceId: SAMPLE.doc, slideId: "已读取的 slideOrder[0]" },
    { resourceId: SAMPLE.doc, elementId: "已读取的画板元素ID" },
    { resourceId: SAMPLE.doc, view: "content", offset: 0, limit: 16000 },
  ],
  review_document_read: [
    { resourceId: SAMPLE.doc, offset: 0, limit: 20000 },
  ],
  submit_review: [
    {
      verdict: "pass",
      summary: "已保存且覆盖用户要求",
      checks: [
        {
          requirement: "内容已写入",
          criterionIndex: 0,
          passed: true,
          evidence: "document_read 回读到目标段落",
        },
      ],
    },
  ],
  quick_note_read: [{ noteId: SAMPLE.note, offset: 0, limit: 6000 }],
  document_create: [
    { title: "项目计划", kind: "document", format: "rich_text" },
    { title: "预算表", kind: "document", format: "spreadsheet" },
    {
      title: "说明",
      kind: "document",
      format: "markdown",
      markdown: "# 说明\n正文",
    },
  ],
  resource_manage: [
    {
      action: "rename",
      resourceId: SAMPLE.doc,
      version: 1,
      title: "新标题",
    },
    {
      action: "move",
      resourceId: SAMPLE.doc,
      version: 1,
      libraryId: null,
      parentId: null,
    },
  ],
  rich_text_edit: [
    {
      ...editBase,
      operations: [{ type: "append", text: "第一段\n第二段" }],
    },
    {
      ...editBase,
      operations: [
        {
          type: "insertBlock",
          block: {
            id: "新唯一ID",
            type: "heading-two",
            children: [{ text: "章节标题" }],
          },
        },
      ],
    },
    {
      ...editBase,
      operations: [
        {
          type: "insertBlock",
          afterId: "已读取的块ID",
          block: {
            id: "新唯一ID",
            type: "paragraph",
            children: [{ text: "内容" }],
          },
        },
      ],
    },
    {
      ...editBase,
      operations: [
        {
          type: "text",
          blockId: "已读取的块ID",
          index: 0,
          deleteCount: 2,
          text: "替换",
        },
      ],
    },
    {
      ...editBase,
      operations: [
        {
          type: "link",
          blockId: "已读取的块ID",
          index: 0,
          length: 4,
          url: "https://example.com",
        },
      ],
    },
    {
      ...editBase,
      operations: [
        {
          type: "setCellContent",
          tableId: "已读取的表格ID",
          cellId: "已读取的单元格ID",
          children: [
            {
              id: "新唯一ID",
              type: "image",
              path: SAMPLE.asset,
              alt: "图片",
              width: 240,
              children: [{ text: "" }],
            },
          ],
        },
      ],
    },
  ],
  markdown_edit: [
    {
      ...editBase,
      operations: [{ type: "append", text: "\n\n## 标题\n正文" }],
    },
    {
      ...editBase,
      operations: [
        { type: "text", index: 0, deleteCount: 4, text: "新开头" },
      ],
    },
  ],
  canvas_edit: [
    {
      ...editBase,
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
    },
    {
      ...editBase,
      operations: [
        {
          type: "add",
          element: {
            id: "新唯一ID",
            tag: "Text",
            x: 96,
            y: 176,
            width: 128,
            height: 32,
            text: "开始",
            fill: "#1f2937",
          },
        },
      ],
    },
  ],
  presentation_edit: [
    {
      ...editBase,
      operations: [
        { type: "formatText", slideId: "已读取的页面ID", ids: ["已读取的文字元素ID"], marks: { color: "#2563eb", fontSize: 32 } },
        { type: "slideProperty", slideId: "已读取的页面ID", field: "background", value: "#ffffff" },
      ],
    },
    {
      ...editBase,
      operations: [{ type: "remove", slideId: "已读取的页面ID", ids: ["用户要求移除的元素ID"] }],
    },
    {
      ...editBase,
      operations: [{ type: "addSlide" }],
    },
    {
      ...editBase,
      operations: [
        {
          type: "insert",
          slideId: "已读取的 slideOrder[0]",
          element: {
            id: "新唯一ID",
            type: "text",
            transform: {
              x: 1000000,
              y: 1500000,
              width: 9000000,
              height: 1000000,
              rotation: 0,
            },
            fill: "#202124",
            paragraphs: [
              {
                type: "paragraph",
                children: [
                  { text: "标题", fontSize: 36, bold: true, color: "#202124" },
                ],
              },
            ],
          },
        },
      ],
    },
  ],
  spreadsheet_edit: [
    {
      ...editBase,
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
    },
    {
      ...editBase,
      operations: [
        {
          type: "structure",
          edit: {
            sheetId: "Sheet1",
            axis: "row",
            action: "insert",
            index: 1,
            count: 1,
          },
        },
      ],
    },
  ],
};

export function toolExamples(id: string) {
  const examples = TOOL_EXAMPLES[id];
  if (!examples?.length) throw new Error(`缺少工具调用例：${id}`);
  return examples;
}

/** OpenAI-compatible models only see the description; inputExamples is Anthropic-only. */
export function withCallExamples(id: string, description: string) {
  const examples = toolExamples(id);
  return {
    description: `${description} 调用例：${examples.map((input) => JSON.stringify(input)).join("；")}`,
    inputExamples: examples.map((input) => ({ input })),
  };
}

export function editToolCallExamples(format: string) {
  return toolExamples(`${format}_edit`);
}
