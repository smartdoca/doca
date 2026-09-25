import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { DB } from "@db/index.js";
import { knowledgeGenerator } from "../apps/server/src/services/ai/knowledge-curation.js";
import { knowledgeSettingsSchema, type CurationGenerator } from "@core/modules/knowledge/system.js";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../apps/server/src/services/ai/model.js", () => ({ meteredModel: async () => ({ doGenerate: generate }) }));
vi.mock("@core/modules/ai/config.js", () => ({
  aiConfig: async () => ({ defaultModel: "test" }),
  requireModel: async () => ({ model: { maxInput: 128000 } }),
}));
const sourceId = randomUUID(), entryId = randomUUID();
const input = {
  bundle: { settings: knowledgeSettingsSchema.parse({}), files: [], hash: "test" },
  materials: [{ subscriptionId: sourceId, version: "2", title: "Source", text: "Revised fact" }],
  existing: [{ id: entryId, title: "Knowledge", markdown: "Human amendment", origin: "human_revised", status: "published", sourceIds: [sourceId] }],
  humanChanges: [],
} as unknown as Parameters<CurationGenerator>[0];
const candidate = { title: "Knowledge", markdown: "Proposed fact", reason: "Conflicting evidence", sourceIds: [sourceId], replacesId: entryId };
function respond(output: unknown) {
  return { finishReason: { unified: "stop" }, content: [{ type: "text", text: JSON.stringify(output) }] };
}
beforeEach(() => generate.mockReset());
it("repairs a conflict assessment that omitted its linked revision", async () => {
  generate.mockResolvedValueOnce(respond({ entries: [], notes: "Conflict", assessments: [{ entryId, decision: "revise", reason: "Equal weights" }] }))
    .mockResolvedValueOnce(respond({ entries: [candidate], notes: "Await review", assessments: [{ entryId, decision: "revise", reason: "Equal weights" }] }));
  const result = await knowledgeGenerator({} as DB, "user", "job")(input);
  expect(result.entries[0]?.replacesId).toBe(entryId);
  expect(generate).toHaveBeenCalledTimes(2);
});
it("rejects repeated omission of existing source knowledge rather than accepting duplicate drafts", async () => {
  generate.mockResolvedValue(respond({ entries: [{ ...candidate, replacesId: undefined }], notes: "Conflict", assessments: [] }));
  await expect(knowledgeGenerator({} as DB, "user", "job")(input)).rejects.toThrow("有效的整理结构");
  expect(generate).toHaveBeenCalledTimes(2);
});
it("allows an explained unchanged assessment without manufacturing a revision", async () => {
  generate.mockResolvedValue(respond({ entries: [], notes: "No change", assessments: [{ entryId, decision: "unchanged", reason: "Published knowledge still agrees with this source" }] }));
  expect((await knowledgeGenerator({} as DB, "user", "job")(input)).entries).toEqual([]);
  expect(generate).toHaveBeenCalledTimes(1);
});

it("preserves omitted safety settings when the assistant updates only structure or link visibility", async () => {
  const { knowledgeSettingsPatchSchema, mergeKnowledgeSettings } = await import("@core/modules/knowledge/system.js");
  const current = knowledgeSettingsSchema.parse({ modelId: "existing-model", redactContacts: true, redactedTerms: ["private"], sourcePolicies: { [sourceId]: { redactContacts: true, redactedTerms: ["secret"], linkAccess: "follow" } } });
  const patch = knowledgeSettingsPatchSchema.parse({ maxDocumentDepth: 4, sourcePolicies: { [sourceId]: { linkAccess: "closed" } } });
  const merged = mergeKnowledgeSettings(current, patch);
  expect(merged.modelId).toBe("existing-model");
  expect(merged.redactContacts).toBe(true);
  expect(merged.redactedTerms).toEqual(["private"]);
  expect(merged.sourcePolicies[sourceId]).toMatchObject({ redactContacts: true, redactedTerms: ["secret"], linkAccess: "closed" });
});
