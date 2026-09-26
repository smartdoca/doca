import { expect, it } from "vitest";
import { createToolFailureGuard } from "../apps/server/src/services/ai/tool-failure-guard.js";
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
