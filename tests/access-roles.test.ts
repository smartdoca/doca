import { describe, expect, it } from "vitest";
import { canChangeMemberRole } from "@core/modules/access/roles.js";

describe("shared access role semantics", () => {
  it("uses the same owner and manager boundary for every ACL adapter", () => {
    expect(canChangeMemberRole("manager", "reader", "reader")).toBe(true);
    expect(canChangeMemberRole("manager", null, "reader")).toBe(true);
    expect(canChangeMemberRole("manager", "manager", "reader")).toBe(false);
    expect(canChangeMemberRole("manager", "reader", "manager")).toBe(false);
    expect(canChangeMemberRole("owner", "manager", "reader")).toBe(true);
    expect(canChangeMemberRole("reader", "reader", null)).toBe(false);
  });
});
