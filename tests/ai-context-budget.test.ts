import { expect, it } from "vitest";
import {
  collapseOlderExchanges,
  exceedsModelInput,
  fitPromptToModelInput,
  taskStateFromMessages,
  trimToolCalls,
  trimToolResults,
} from "../apps/server/src/services/ai/context-budget.js";
import { contextParts } from "../apps/server/src/services/ai/prompt-context.js";
import { needsLlmReview } from "../apps/server/src/services/ai/delivery.js";
import { documentCapabilities, documentReadCapabilities } from "../packages/core/src/modules/ai/capabilities.js";
import { skillPrefixInstructions } from "../packages/core/src/modules/ai/skills.js";

it("keeps recent tool results and stubs older bulky payloads", () => {
  const messages = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "old",
          result: {
            resourceId: "doc-1",
            seq: 3,
            content: "x".repeat(4000),
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "err",
          result: { error: "409 版本冲突" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "new",
          result: { resourceId: "doc-1", seq: 4, content: "latest page" },
        },
      ],
    },
  ];
  const trimmed = trimToolResults(messages, 1);
  expect(trimmed[0]!.content[0]!.result).toMatchObject({
    truncated: true,
    resourceId: "doc-1",
    seq: 3,
  });
  expect(JSON.stringify(trimmed[0]!.content[0]!.result)).not.toContain(
    "x".repeat(400),
  );
  expect(String(trimmed[0]!.content[0]!.result.contentPreview).length).toBeLessThan(
    400,
  );
  expect(trimmed[1]!.content[0]!.result).toEqual({ error: "409 版本冲突" });
  expect(trimmed[2]!.content[0]!.result.content).toBe("latest page");
});

function exchange(id: string, seq: number, bulky = false) {
  const blob = bulky ? `画板${id}内容`.repeat(800) : "ok";
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: id,
          toolName: "canvas_edit",
          args: {
            resourceId: "doc-1",
            seq,
            epochId: "epoch-1",
            operations: bulky ? [{ type: "replace", text: blob }] : [{ type: "ping" }],
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          result: {
            resourceId: "doc-1",
            seq: seq + 1,
            epochId: "epoch-1",
            content: blob,
            applied: ["replace"],
          },
        },
      ],
    },
  ];
}

it("keeps recent tool-call arguments and stubs older bulky payloads", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "old",
          toolName: "canvas_edit",
          args: { resourceId: "doc-1", seq: 3, operations: [{ text: "x".repeat(4000) }] },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "new",
          toolName: "canvas_edit",
          args: { resourceId: "doc-1", seq: 4, operations: [{ text: "latest" }] },
        },
      ],
    },
  ];
  const trimmed = trimToolCalls(messages, 1);
  expect(trimmed[0]!.content[0]!.args).toMatchObject({
    truncated: true,
    resourceId: "doc-1",
    seq: 3,
  });
  expect(JSON.stringify(trimmed[0]!.content[0]!.args)).not.toContain("x".repeat(400));
  expect(trimmed[1]!.content[0]!.args.operations[0].text).toBe("latest");
});

it("collapses older completed tool exchanges and keeps the current request plus seq", () => {
  const messages = [
    { role: "system", content: "你是助手" },
    { role: "user", content: "请继续改画板" },
    ...exchange("a", 1, true),
    ...exchange("b", 2, true),
    ...exchange("c", 3, true),
  ];
  const collapsed = collapseOlderExchanges(messages, 1);
  expect(JSON.stringify(collapsed)).toContain("请继续改画板");
  expect(JSON.stringify(collapsed)).toContain("已自动压缩");
  expect(JSON.stringify(collapsed)).not.toContain("画板a内容");
  expect(JSON.stringify(collapsed)).toContain("toolCallId\":\"c\"");
  expect(taskStateFromMessages(collapsed)).toMatchObject({
    resourceId: "doc-1",
    seq: 4,
    epochId: "epoch-1",
  });
});

it("fits a long in-task prompt into a small model budget instead of aborting", () => {
  const prompt = [
    { role: "system", content: "你是 Doca 助手" },
    { role: "user", content: "都好丑，好好优化下" },
    ...exchange("a", 1, true),
    ...exchange("b", 2, true),
    ...exchange("c", 3, true),
    ...exchange("d", 4, true),
  ];
  expect(exceedsModelInput(prompt, 4000)).toBe(true);
  const fitted = fitPromptToModelInput(prompt, 4000);
  expect(exceedsModelInput(fitted, 4000)).toBe(false);
  expect(JSON.stringify(fitted)).toContain("都好丑，好好优化下");
  expect(JSON.stringify(fitted)).toContain("已自动压缩");
  expect(fitPromptToModelInput(prompt, 200000)).toBe(prompt);
});

it("archives historical prompt context and keeps the current turn intact", () => {
  expect(contextParts("当前文档：abc", true)[0]?.text).toContain("已归档");
  expect(contextParts("当前文档：abc")[0]?.text).toContain("【本轮上下文】");
});

it("skips independent LLM review when nothing was saved", () => {
  expect(needsLlmReview({ written: 0, round: 0 })).toBe(false);
  expect(needsLlmReview({ written: 1, round: 0 })).toBe(true);
  expect(
    needsLlmReview({ written: 1, plan: { mode: "clarify" }, round: 0 }),
  ).toBe(false);
  expect(
    needsLlmReview({ written: 1, plan: { mode: "deliver" }, round: 0 }),
  ).toBe(true);
});

it("gives document reads a compact first page and keeps the full manual off the prefix", () => {
  const caps = documentCapabilities("rich_text");
  expect(caps.editingGuide).toContain('type:"flowchart"');
  expect(caps.editingGuide).toContain("load_skill");
  expect(caps.editingManual).toContain("insertBlock");
  expect(documentReadCapabilities("rich_text", 1)).toEqual({});
  expect(documentReadCapabilities("rich_text", 0).loadSkill).toBe("writing");
  expect("firstEdit" in documentReadCapabilities("rich_text", 0)).toBe(false);
  expect(skillPrefixInstructions({ id: "writing", name: "文档创作" })).toContain(
    "load_skill",
  );
  expect(skillPrefixInstructions({ id: "writing", name: "文档创作" })).not.toContain(
    "insertBlock",
  );
});
