import { it, expect } from "vitest";
import { visibleToolbarCount } from "../apps/web/src/shared/utils/toolbar-layout.js";
import { findTextOffsets } from "../apps/web/src/shared/utils/find-text.js";
it("keeps tools compact and reserves overflow space on narrow screens", () => {
  const widths = [30, 30, 10, 78, 52, 30, 30, 30, 30];
  expect(visibleToolbarCount(1500, widths)).toBe(widths.length);
  for (const width of [40, 90, 180, 250, 310]) {
    const count = visibleToolbarCount(width, widths);
    expect(
      widths.slice(0, count).reduce((a, b) => a + b, 0) + count * 2 + 32,
    ).toBeLessThanOrEqual(width);
    expect(count).toBeLessThan(widths.length);
  }
});
it("finds literal text without changing offsets or interpreting regexp syntax", () => {
  expect(findTextOffsets("Abc abc ABC", "abc")).toEqual([0, 4, 8]);
  expect(findTextOffsets("甲乙甲乙", "甲乙")).toEqual([0, 2]);
  expect(findTextOffsets("x [a].* y [a].*", "[a].*")).toEqual([2, 10]);
  expect(findTextOffsets("😀Ab", "ab")).toEqual([2]);
  expect(findTextOffsets("abc", "")).toEqual([]);
});
