import { expect, it } from "vitest";
import { createToolFailureGuard, toolResultFailed } from "../apps/server/src/services/ai/tool-failure-guard.js";
it("stops identical failures across intervening reads but allows corrected input and successful recovery", () => {
  const guard = createToolFailureGuard();
  expect(guard("spreadsheet_edit", { cells: null, sheetId: "s" }, true)).toBe(
    false,
  );
  expect(guard("document_read", { id: "d" }, false)).toBe(false);
  expect(guard("spreadsheet_edit", { sheetId: "s", cells: null }, true)).toBe(
    false,
  );
  expect(
    guard(
      "spreadsheet_edit",
      { cells: [{ row: 0, column: 0, v: 20 }], sheetId: "s" },
      false,
    ),
  ).toBe(false);
  expect(guard("spreadsheet_edit", { cells: null, sheetId: "s" }, true)).toBe(
    true,
  );
  expect(guard("spreadsheet_edit", { cells: null, sheetId: "s" }, false)).toBe(
    false,
  );
  expect(guard("spreadsheet_edit", { cells: null, sheetId: "s" }, true)).toBe(
    false,
  );
});

it("distinguishes a failed tool invocation from a successful read of a failed business task", () => {
  expect(toolResultFailed("tool-result", undefined, { status: "failed", error: "model timed out" })).toBe(false);
  expect(toolResultFailed("tool-result", undefined, { error: true, code: "fresh_view_required" })).toBe(true);
  expect(toolResultFailed("tool-error", undefined, undefined)).toBe(true);
  expect(toolResultFailed("tool-result", true, {})).toBe(true);
});
