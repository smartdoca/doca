import { expect, it } from "vitest";
import { ImageRepairStrategy } from "../apps/server/src/services/ai/image-repair-strategy.js";

it("switches from repeated failed generations to comparison, then stops a bounded unsuccessful repair run", () => {
  const state = new ImageRepairStrategy();
  state.observe("page", "first", "criteria", false);
  state.observe("page", "first", "criteria", false);
  expect(state.beforePaid("page", "criteria")).toBeNull();
  state.observe("page", "second", "criteria", false);
  state.observe("page", "third", "criteria", false);
  expect(state.beforePaid("page", "criteria")).toEqual({
    action: "compare",
    failedAssetIds: ["first", "second", "third"],
  });
  state.selected("page", "criteria", "first");
  expect(state.beforePaid("page", "criteria")?.action).toBe("replan");
  state.observe("page", "fourth", "criteria", false);
  expect(state.beforePaid("page", "criteria")?.action).toBe("compare");
  state.selected("page", "criteria", "second");
  state.observe("page", "fifth", "criteria", false);
  expect(state.beforePaid("page", "criteria")?.action).toBe("compare");
  state.selected("page", "criteria", "third");
  expect(state.beforePaid("page", "criteria")?.action).toBe("stop");
});

it("does not reopen the final comparison because the older chosen candidate also fails", () => {
  const state = new ImageRepairStrategy();
  for (const id of ["one", "two", "three", "four", "five"])
    state.observe("page", id, "criteria", false);
  expect(state.beforePaid("page", "criteria")?.action).toBe("compare");
  state.selected("page", "criteria", "historical-candidate");
  state.observe("page", "historical-candidate", "criteria", false);
  expect(state.beforePaid("page", "criteria")?.action).toBe("stop");
  state.observe("page", "historical-candidate", "criteria", true);
  expect(state.beforePaid("page", "criteria")).toBeNull();
});

it("stops repairing a passed first candidate and isolates pages and changed official requirements", () => {
  const state = new ImageRepairStrategy();
  for (const id of ["one", "two", "three"])
    state.observe("page", id, "original", false);
  expect(state.beforePaid("other-page", "original")).toBeNull();
  expect(state.beforePaid("page", "new-official-criteria")).toBeNull();
  state.observe("page", "one", "original", true);
  expect(state.beforePaid("page", "original")).toBeNull();
});
