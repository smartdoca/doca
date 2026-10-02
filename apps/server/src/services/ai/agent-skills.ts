import { createHash } from "node:crypto";
import { createSkill } from "@mastra/core/skills";
import { skillPrefixInstructions } from "@core/modules/ai/skills.js";

/** Public Doca IDs are namespaced; Mastra names have a separate, stricter syntax. */
export function createAgentSkill(skill: {
  id: string;
  name: string;
  description: string;
}) {
  return createSkill({
    // Stable across catalog ordering and distinct for dot/hyphen namespaces.
    name: `skill-${createHash("sha256").update(skill.id).digest("hex").slice(0, 58)}`,
    description: skill.description,
    instructions: skillPrefixInstructions(skill),
  });
}
