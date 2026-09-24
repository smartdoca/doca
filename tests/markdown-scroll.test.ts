import { expect, it } from "vitest";
import {
  markdownScrollTarget,
  type ScrollRange,
} from "../apps/web/src/features/documents/markdown-scroll.js";

const outer: ScrollRange = { top: 0, height: 700, contentHeight: 1200 };
const pane: ScrollRange = { top: 0, height: 660, contentHeight: 3000 };

it.each(["edit", "preview", "split-source", "split-preview"])(
  "%s stays in the active pane until the end",
  () => {
    expect(markdownScrollTarget(60, outer, [pane])).toBe("native");
    expect(markdownScrollTarget(60, outer, [{ ...pane, top: 2340 }])).toBe(
      "outer",
    );
  },
);
it("returns the outer viewport before scrolling the text upward", () => {
  expect(markdownScrollTarget(-60, { ...outer, top: 180 }, [pane])).toBe(
    "outer",
  );
  expect(markdownScrollTarget(-60, outer, [{ ...pane, top: 2340 }])).toBe(
    "native",
  );
  expect(markdownScrollTarget(60, { ...outer, top: 180 }, [pane])).toBe(
    "outer",
  );
});
it("short documents hand off immediately without requiring an artificial text scroll", () => {
  expect(
    markdownScrollTarget(60, outer, [{ ...pane, contentHeight: 660 }]),
  ).toBe("outer");
});
it("nested scroll areas and fractional positions do not reveal discussion prematurely", () => {
  expect(
    markdownScrollTarget(60, outer, [
      { ...pane, top: 2340 },
      { top: 20, height: 100, contentHeight: 300 },
    ]),
  ).toBe("native");
  expect(markdownScrollTarget(60, outer, [{ ...pane, top: 2339.5 }])).toBe(
    "outer",
  );
});
it("does not intercept invalid deltas or pages without an outer scroll range", () => {
  for (const delta of [0, NaN, Infinity])
    expect(markdownScrollTarget(delta, outer, [pane])).toBe("native");
  expect(markdownScrollTarget(60, { ...outer, contentHeight: 700 }, [])).toBe(
    "native",
  );
});
