import { expect, it } from "vitest";
import {
  searchExcerpt,
  textMatches,
  textMentionsTopic,
} from "@core/modules/discovery/search-excerpts.js";
it("selects a matching paragraph after a long introduction and returns exact highlight ranges", () => {
  const body =
    "这里是完全无关的介绍。".repeat(100) +
    "\n员工可以申请高铁费用报销，报销需要发票。\n其他说明。";
  const result = searchExcerpt(body, "费用报销");
  expect(result.summary).toContain("高铁费用报销");
  expect(result.summary).not.toContain("无关的介绍");
  expect(
    result.summaryMatches.map((m) =>
      result.summary.slice(m.start, m.start + m.length),
    ),
  ).toContain("费用报销");
});
it("segments Chinese multiword queries and highlights literal punctuation safely", () => {
  const result = searchExcerpt(
    "没有内容\n编辑器支持协作，文档支持批量导出。",
    "协作导出",
  );
  expect(result.summary).toContain("编辑器");
  expect(
    result.summaryMatches.map((m) =>
      result.summary.slice(m.start, m.start + m.length),
    ),
  ).toEqual(["协作", "导出"]);
  expect(textMatches("使用 C++ 编程与 React 组件", "C++")).toEqual([
    { start: 3, length: 3 },
  ]);
  expect(textMatches("REACT react", "React")).toEqual([
    { start: 0, length: 5 },
    { start: 6, length: 5 },
  ]);
});
it("bounds excerpts around late hits and handles empty content", () => {
  const result = searchExcerpt(
    "序言".repeat(300) + "向量模型升级需要验证维度。",
    "向量模型",
    160,
  );
  expect(result.summary.length).toBeLessThanOrEqual(162);
  expect(result.summary).toContain("向量模型");
  expect(searchExcerpt("", "查询")).toEqual({
    summary: "",
    summaryMatches: [],
  });
});
it("handles long paragraphs with many repeated matches", () => {
  const result = searchExcerpt("关键词与背景。".repeat(10000), "关键词");
  expect(result.summary.length).toBeLessThanOrEqual(362);
  expect(result.summaryMatches.length).toBeGreaterThan(1);
});
it("requires the topic itself rather than related animals", () => {
  expect(textMentionsTopic("一只阳光下的橘色猫", "猫猫")).toBe(true);
  expect(textMentionsTopic("一只阳光下的橘色猫", "狗狗")).toBe(false);
});
