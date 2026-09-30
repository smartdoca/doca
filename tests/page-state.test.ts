import { expect, it } from "vitest";
import { normalizePageStateValue, parsePageStateKey } from "../packages/core/src/modules/page-state.js";
it("keeps supported UI preferences and rejects removed note state", () => {
  expect(parsePageStateKey("ui.notesFloat")).toBeNull();
  expect(parsePageStateKey("ui.secret")).toBeNull();
  expect(parsePageStateKey("ui.filesView")).toBe("ui.filesView");
  expect(normalizePageStateValue("ui.filesView", "list")).toBe("list");
  expect(() => normalizePageStateValue("ui.filesView", "invalid")).toThrow();
});
