import { expect, it } from "vitest";
import {
  normalizeNotesFloat,
  normalizePageStateValue,
  parsePageStateKey,
} from "../packages/core/src/modules/page-state.js";

it("stores the quick-notes float with the same page-state key as other UI preferences", () => {
  expect(parsePageStateKey("ui.notesFloat")).toBe("ui.notesFloat");
  expect(parsePageStateKey("ui.secret")).toBeNull();
  const value = normalizePageStateValue("ui.notesFloat", {
    open: true,
    collapsed: 1,
    x: 12.5,
    y: "40",
    width: 10,
    height: 5000,
    extra: "drop",
  });
  expect(value).toEqual({
    open: true,
    collapsed: false,
    x: 12.5,
    y: 40,
    width: 280,
    height: 960,
  });
  expect(normalizeNotesFloat(null)).toMatchObject({ open: false, collapsed: false });
});
