import { describe, expect, it } from "vitest";
import { ASSISTANT_PROFILES } from "../apps/web/src/features/ai/assistant-profile.js";

describe("assistant visual profiles", () => {
  it("keeps personal assistant capabilities and personal memory separate", () => {
    const profile = ASSISTANT_PROFILES.personal;
    expect(profile.capabilities).toMatchObject({
      personalMemory: true,
      references: true,
      webSearch: true,
      approvals: true,
    });
  });

  it("keeps knowledge answers grounded and thread-only", () => {
    const profile = ASSISTANT_PROFILES["knowledge-answer"];
    expect(profile.capabilities).toMatchObject({
      personalMemory: false,
      feedback: true,
      references: false,
      webSearch: false,
      approvals: false,
      sourceManagement: false,
    });
  });

  it("keeps curation shared, actionable, and free of personal memory", () => {
    const profile = ASSISTANT_PROFILES["knowledge-curation"];
    expect(profile.capabilities).toMatchObject({
      personalMemory: false,
      modelPicker: true,
      humanTasks: true,
      sourceManagement: true,
      feedback: false,
    });
  });

  it("uses one visual language across assistant identities", () => {
    expect(
      new Set(Object.values(ASSISTANT_PROFILES).map((profile) => profile.accent))
        .size,
    ).toBe(1);
  });
});
