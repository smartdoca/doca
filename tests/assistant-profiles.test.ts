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

  it("shows one personal assistant profile", () => { expect(Object.keys(ASSISTANT_PROFILES)).toEqual(["personal"]); });

  it("uses one visual language across assistant identities", () => {
    expect(
      new Set(Object.values(ASSISTANT_PROFILES).map((profile) => profile.accent))
        .size,
    ).toBe(1);
  });
});
