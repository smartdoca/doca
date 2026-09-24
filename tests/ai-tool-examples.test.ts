import { expect, it } from "vitest";
import { documentFormats } from "../packages/core/src/modules/ai/edit-schema.js";
import {
  TOOL_EXAMPLES,
  withCallExamples,
  editToolCallExamples,
} from "../packages/core/src/modules/ai/tool-examples.js";
import { editToolInputExamples } from "../packages/core/src/modules/ai/capabilities.js";
import { shouldSkipWebSearch } from "../packages/core/src/modules/ai/search-policy.js";

const required = [
  "load_skill",
  "web_fetch",
  "web_search",
  "http_request",
  "note_write",
  "secret_write",
  "secret_delete",
  "document_request_access",
  "image_insert",
  "image_generate",
  "image_show",
  "ask_user",
  "task_plan",
  "knowledge_search",
  "document_exists",
  "file_browse",
  "file_search",
  "file_manage",
  "file_folder_manage",
  "file_download",
  "file_create",
  "mail_browse",
  "mail_search",
  "mail_read",
  "mail_compose",
  "mail_send",
  "mail_manage",
  "document_read",
  "review_document_read",
  "submit_review",
  "quick_note_read",
  "document_create",
  "resource_manage",
  ...documentFormats.map((format) => `${format}_edit`),
];

it("gives every tool complete first-call examples in the description small models actually see", () => {
  for (const id of required) {
    const examples = TOOL_EXAMPLES[id];
    expect(examples?.length, id).toBeGreaterThanOrEqual(1);
    const { description, inputExamples } = withCallExamples(id, `${id} 说明`);
    expect(description).toContain("调用例：");
    expect(inputExamples).toHaveLength(examples!.length);
    for (const example of examples!) {
      expect(description).toContain(JSON.stringify(example));
    }
  }
});

it("covers the fields that usually fail on the first edit/file/image call", () => {
  const sheet = editToolCallExamples("spreadsheet")[0] as {
    resourceId: string;
    seq: number;
    epochId: string;
    operations: { type: string; sheetId: string; cells: unknown }[];
  };
  expect(sheet).toMatchObject({
    resourceId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ),
    seq: 1,
  });
  expect(sheet.operations[0]).toMatchObject({
    type: "cells",
    sheetId: "Sheet1",
  });
  expect(sheet.operations[0]!.cells).toEqual(
    expect.arrayContaining([
      { row: 0, column: 0, v: "费用类别" },
      { row: 2, column: 1, f: "=B2" },
    ]),
  );
  expect(JSON.stringify(sheet.operations[0]!.cells)).not.toContain("f:null");
  expect(JSON.stringify(sheet.operations[0]!.cells)).not.toContain("null");
  expect(
    editToolInputExamples("rich_text").map((item) => item.input.operations),
  ).toEqual(
    expect.arrayContaining([
      [{ type: "append", text: "第一段\n第二段" }],
      expect.arrayContaining([
        expect.objectContaining({ type: "insertBlock", afterId: expect.any(String) }),
      ]),
    ]),
  );
  expect(TOOL_EXAMPLES.image_insert).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        assetId: expect.any(String),
        resourceId: expect.any(String),
        sheetId: expect.any(String),
        row: 0,
        column: 0,
      }),
      expect.objectContaining({ sheetId: null, row: null, column: null }),
    ]),
  );
  expect(TOOL_EXAMPLES.file_manage.map((item) => item.action).sort()).toEqual([
    "copy",
    "delete",
    "move",
    "rename",
  ]);
  expect(TOOL_EXAMPLES.file_folder_manage.map((item) => item.action)).toEqual([
    "create",
    "rename",
    "move",
    "copy",
    "delete",
  ]);
  expect(TOOL_EXAMPLES.resource_manage[0]).toMatchObject({
    action: "rename",
    version: 1,
    title: "新标题",
  });
  expect(TOOL_EXAMPLES.submit_review[0]).toMatchObject({
    verdict: "pass",
    checks: [{ criterionIndex: 0, passed: true }],
  });
});

it("does not search again when the user only asks to fix document formatting", () => {
  expect(shouldSkipWebSearch("需要富文本样式，现在插入的是markdown原文")).toBe(true);
  expect(shouldSkipWebSearch("查一下富文本格式的最新规范")).toBe(false);
  expect(shouldSkipWebSearch("用富文本写一份 RAG 方案")).toBe(false);
});
