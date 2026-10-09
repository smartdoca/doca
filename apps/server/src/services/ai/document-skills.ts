import { skillByFormat } from "@core/modules/ai/skills.js";

type Skill = {
  id: string;
  name: string;
  content: string;
  formats: readonly string[];
  enabled?: boolean;
};

/** Full editing manuals belong to the current request, outside the cached prefix. */
export function createDocumentSkillContext(
  catalog: readonly Skill[],
  formats: Iterable<string>,
) {
  const provided = new Set<string>();
  const find = (format: string) => {
    const id = skillByFormat(format)?.id;
    return catalog.find(
      (skill) =>
        skill.id === id &&
        skill.enabled !== false &&
        skill.formats.includes(format),
    );
  };
  const manuals = new Map<string, Skill>();
  for (const format of formats) {
    const skill = find(format);
    if (skill) manuals.set(skill.id, skill);
  }
  const selected = [...manuals.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  selected.forEach((skill) => provided.add(skill.id));

  return {
    promptParts: selected.map((skill) => ({
      type: "text" as const,
      text: `【本轮已自动加载的文档编辑 skill：${skill.id}（${skill.name}）】\n${skill.content}\n按 document_read 返回的实际 format 选择命令；加载手册不代表用户授权编辑。`,
    })),
    markLoaded(id: string) {
      provided.add(id);
    },
    // A newly created/read document can reveal a format absent from the request.
    // Supply its enabled manual before the model's next edit, once per execution.
    toolInstructions(format: string) {
      const skill = find(format);
      if (!skill || provided.has(skill.id)) return {};
      provided.add(skill.id);
      return {
        editingSkill: {
          id: skill.id,
          name: skill.name,
          instructions: skill.content,
        },
      };
    },
  };
}
