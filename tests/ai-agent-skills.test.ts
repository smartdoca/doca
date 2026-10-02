import { expect, it } from "vitest";
import { createAgentSkill } from "../apps/server/src/services/ai/agent-skills.js";

it.each(["doca.mail.skill", "doca.wechat-official.skill", "a".repeat(180)])(
  "accepts the public skill ID %s at the Mastra boundary",
  (id) => {
    const skill = createAgentSkill({
      id,
      name: "插件技能",
      description: "处理插件内容",
    });
    expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(skill.name.length).toBeLessThanOrEqual(64);
    expect(skill.instructions).toContain(id);
  },
);

it("keeps public lookup IDs intact and gives distinct stable names to dot and hyphen IDs", () => {
  const create = (id: string) =>
    createAgentSkill({ id, name: "技能", description: "处理内容" });
  expect(create("doca.mail.skill").name).not.toBe(
    create("doca-mail-skill").name,
  );
  expect(create("doca.mail.skill")).toEqual(create("doca.mail.skill"));
});
