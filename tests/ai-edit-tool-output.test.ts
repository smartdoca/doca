import { expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  editToolSchema,
  validateEditOperations,
} from "@core/modules/ai/edit-schema.js";
import { editToolCallExamples } from "@core/modules/ai/tool-examples.js";
import { editToolModelOutput } from "../apps/server/src/services/ai/edit-tool-output.js";

it("advertises the native rich-text fields and validates every supplied example", () => {
  const schema = z.toJSONSchema(editToolSchema("rich_text")) as any;
  const fields = schema.properties.operations.items.properties;
  for (const key of [
    "afterId",
    "parentId",
    "rows",
    "columns",
    "tableId",
    "cellId",
    "children",
    "index",
    "deleteCount",
  ])
    expect(fields[key], key).toBeDefined();
  expect(fields.type.description).toContain("insertBlock 只用");
  expect(fields.blockId.description).toContain("不能传本字段");
  for (const example of editToolCallExamples("rich_text")) {
    const parsed = editToolSchema("rich_text").parse(example);
    expect(() =>
      validateEditOperations("rich_text", parsed.operations),
    ).not.toThrow();
  }
  expect(() =>
    validateEditOperations("rich_text", [
      {
        type: "insertBlock",
        blockId: "existing",
        block: { id: "new", type: "paragraph", children: [{ text: "内容" }] },
      },
    ]),
  ).toThrow(/Unrecognized key/);
});

it("returns an actionable array error through the installed SDK without executing the invalid edit", async () => {
  const execute = vi.fn(async () => ({ saved: true }));
  let calls = 0;
  let repairPrompt: any[] = [];
  const model = {
    specificationVersion: "v3" as const,
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    async doStream(options: any) {
      const first = calls++ === 0;
      if (!first) repairPrompt = options.prompt;
      const input = JSON.stringify({
        resourceId: "00000000-0000-4000-8000-000000000001",
        seq: 0,
        epochId: "fixture",
        operations: JSON.stringify([
          { type: "append", text: "隔离参数验证".repeat(30) },
        ]) + "}",
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            const chunks: any[] = [{ type: "stream-start", warnings: [] }];
            if (first)
              chunks.push(
                {
                  type: "tool-input-start",
                  id: "edit",
                  toolName: "rich_text_edit",
                },
                { type: "tool-input-delta", id: "edit", delta: input },
                { type: "tool-input-end", id: "edit" },
                {
                  type: "tool-call",
                  toolCallId: "edit",
                  toolName: "rich_text_edit",
                  input,
                },
              );
            chunks.push({
              type: "finish",
              finishReason: {
                unified: first ? "tool-calls" : "stop",
                raw: first ? "tool_calls" : "stop",
              },
              usage: {
                inputTokens: { total: 100 },
                outputTokens: { total: 100 },
              },
            });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
    async doGenerate() {
      throw Error("Unused fixture method");
    },
  };
  const agent = new Agent({
    id: "edit-array-error",
    name: "Edit array error",
    instructions: "Isolated SDK fixture.",
    model: model as any,
    tools: {
      rich_text_edit: createTool({
        id: "rich_text_edit",
        description: "Fixture edit.",
        inputSchema: editToolSchema("rich_text"),
        toModelOutput: editToolModelOutput,
        execute,
      }),
    },
  });
  const stream = await agent.stream("Verify the invalid array input.", {
    maxSteps: 2,
    modelSettings: { maxRetries: 0 },
  });
  for await (const _chunk of stream.fullStream) {
    /* Consume both SDK steps. */
  }
  await stream.getFullOutput();
  expect(execute).not.toHaveBeenCalled();
  const text = JSON.stringify(repairPrompt);
  expect(text).toContain("edit_operations_array_required");
  expect(text).toContain("80 限制的是操作数量");
  expect(text).not.toContain("<=80 characters");
  expect(editToolModelOutput({ saved: true, seq: 2 })).toEqual({
    type: "json",
    value: { saved: true, seq: 2 },
  });
});
