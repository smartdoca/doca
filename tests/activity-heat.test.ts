import { describe, expect, it } from "vitest";
import {
  activityHeatLevel,
  activityHeatLevels,
} from "../apps/web/src/features/workspace/activity-heat.js";

describe("activity calendar document-count heat", () => {
  it.each([
    [0, 0, "idle"],
    [1, 0, "read"],
    [100, 0, "read"],
    [0, 1, "edited-1"],
    [0, 2, "edited-2"],
    [0, 3, "edited-2"],
    [0, 4, "edited-3"],
    [0, 6, "edited-3"],
    [0, 7, "edited-4"],
    [0, 100, "edited-4"],
  ])("maps %i reads and %i edited documents to %s", (read, edited, level) => {
    expect(activityHeatLevel(read, edited)).toBe(level);
  });

  it("uses editing counts regardless of reading counts", () => {
    for (const count of [1, 2, 3, 4, 6, 7, 100]) {
      expect(activityHeatLevel(1000, count)).toBe(activityHeatLevel(0, count));
    }
  });

  it("only increases intensity as the document count grows", () => {
    const levels = activityHeatLevels.map((level) => level.className as string);
    let previous = 0;
    for (let count = 0; count <= 30; count++) {
      const current = levels.indexOf(activityHeatLevel(0, count));
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
