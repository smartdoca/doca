import { expect, it } from "vitest";
import { referenceTextParts } from "../apps/web/src/features/ai/ai-reference-text.js";

it("renders mentioned content once at its position in the sentence", () => {
  const label = "一只可爱的猫 · 画布区域 · 1 个元素";
  expect(referenceTextParts(`将 @【${label}】 再调整下`, [label])).toEqual([
    { text: "将 " },
    { referenceIndex: 0 },
    { text: " 再调整下" },
  ]);
});
it("preserves multiple, repeated and unrecognized mentions", () => {
  expect(
    referenceTextParts("@【甲】 对比 @【乙】 与 @【甲】 @【未授权】", [
      "甲",
      "乙",
    ]),
  ).toEqual([
    { referenceIndex: 0 },
    { text: " 对比 " },
    { referenceIndex: 1 },
    { text: " 与 " },
    { referenceIndex: 0 },
    { text: " @【未授权】" },
  ]);
});
