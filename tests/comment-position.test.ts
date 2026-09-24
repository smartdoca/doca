import { describe, expect, it } from "vitest";
import {
  placeCommentCards,
  commentRailHeight,
} from "../apps/web/src/features/comments/comment-position.js";

describe("ordered comment cards", () => {
  it("keeps sparse comments scrollable to the bottom of a long source", () => {
    const height = commentRailHeight(120, 4000, 600, 56);
    expect(height).toBe(4544);
    expect(height + 56 - 600).toBe(4000);
    expect(commentRailHeight(4800, 4000, 600, 56)).toBe(4800);
  });
  it("follows source order, not creation order", () => {
    expect(
      placeCommentCards([
        { id: "last", order: 90, target: 500, height: 80 },
        { id: "first", order: 2, target: 20, height: 100 },
      ]),
    ).toEqual([
      { id: "first", top: 20 },
      { id: "last", top: 500 },
    ]);
  });
  it("stacks overlapping anchors and growing replies without overlap", () => {
    expect(
      placeCommentCards([
        { id: "a", order: 5, target: 50, height: 220 },
        { id: "b", order: 5, target: 50, height: 100 },
        { id: "c", order: 6, target: 60, height: 60 },
      ]).map((c) => c.top),
    ).toEqual([50, 286, 402]);
  });
  it("handles scrolled-offscreen anchors and invalid coordinates", () => {
    expect(
      placeCommentCards([
        { id: "a", order: 1, target: -500, height: 40 },
        { id: "b", order: 2, target: NaN, height: 40 },
      ]).map((c) => c.top),
    ).toEqual([0, 56]);
  });
});
