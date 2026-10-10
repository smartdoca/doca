import { expect, it } from "vitest";
import { createDocumentSkillContext } from "../apps/server/src/services/ai/document-skills.js";
import {
  defaultOfficialSkills,
  relevantSkillFormats,
} from "@core/modules/ai/skills.js";

it.each([
  ["帮我生成一个年会报告的文档模板", "writing"],
  ["创建一个会议模板", "writing"],
  ["创建预算表格", "spreadsheet"],
  ["制作三页PPT", "presentation"],
  ["创建项目画布", "canvas"],
  ["流程图样式优化一下，加一些颜色", "writing"],
  ["修改富文本中的思维导图配色", "writing"],
])(
  "provides the full enabled document manual before executing %s",
  (text, id) => {
    const context = createDocumentSkillContext(
      defaultOfficialSkills,
      relevantSkillFormats(text),
    );
    const manual = defaultOfficialSkills.find((skill) => skill.id === id)!;
    expect(
      context.promptParts.some((part) => part.text.includes(manual.content)),
    ).toBe(true);
  },
);

it("loads a shared rich-text/Markdown manual once and supplies a newly discovered format", () => {
  const context = createDocumentSkillContext(defaultOfficialSkills, [
    "markdown",
    "rich_text",
  ]);
  expect(context.promptParts).toHaveLength(1);
  expect(context.toolInstructions("rich_text")).toEqual({});
  const spreadsheet = defaultOfficialSkills.find(
    (skill) => skill.id === "spreadsheet",
  )!;
  expect(context.toolInstructions("spreadsheet")).toEqual({
    editingSkill: {
      id: spreadsheet.id,
      name: spreadsheet.name,
      instructions: spreadsheet.content,
    },
  });
  expect(context.toolInstructions("spreadsheet")).toEqual({});
});

it("uses the enabled catalog without replacing disabled or absent manuals with defaults", () => {
  const writing = defaultOfficialSkills.find(
    (skill) => skill.id === "writing",
  )!;
  const catalog = [{ ...writing, content: "当前已启用的完整手册" }];
  expect(
    createDocumentSkillContext(catalog, ["rich_text"]).promptParts[0]!.text,
  ).toContain(catalog[0]!.content);
  const disabled = createDocumentSkillContext(
    [{ ...writing, enabled: false }],
    ["rich_text"],
  );
  expect(disabled.promptParts).toEqual([]);
  expect(disabled.toolInstructions("rich_text")).toEqual({});
  expect(createDocumentSkillContext([], ["rich_text"]).promptParts).toEqual([]);
  expect(
    createDocumentSkillContext(catalog, []).toolInstructions("spreadsheet"),
  ).toEqual({});
});

it("does not preload document manuals for ordinary questions or file exports", () => {
  for (const text of ["调研一下竞品方案", "把调研报告保存为 PDF"]) {
    expect(
      createDocumentSkillContext(
        defaultOfficialSkills,
        relevantSkillFormats(text),
      ).promptParts,
    ).toEqual([]);
  }
});

it("counts explicit manual reads and keeps load state local to an execution", () => {
  const first = createDocumentSkillContext(defaultOfficialSkills, []);
  first.markLoaded("writing");
  expect(first.toolInstructions("rich_text")).toEqual({});
  const next = createDocumentSkillContext(defaultOfficialSkills, []);
  expect(next.toolInstructions("rich_text").editingSkill?.id).toBe("writing");
  expect(next.toolInstructions("unknown")).toEqual({});
});
