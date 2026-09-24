import { fail } from "../../../shared/errors.js";

/** Ephemeral coordinates, not persisted workbook commands or comment anchors. */
export function cellSelection(value: Record<string, unknown>) {
  if (
    typeof value.sheetId !== "string" ||
    !value.sheetId ||
    value.sheetId.length > 160
  )
    fail(400, "工作表标识无效");
  for (const [key, limit] of [
    ["startRow", 1048576],
    ["endRow", 1048576],
    ["startColumn", 16384],
    ["endColumn", 16384],
  ] as const) {
    if (
      !Number.isSafeInteger(value[key]) ||
      Number(value[key]) < 0 ||
      Number(value[key]) >= limit
    )
      fail(400, "单元格选区无效");
  }
  if (
    Number(value.startRow) > Number(value.endRow) ||
    Number(value.startColumn) > Number(value.endColumn)
  )
    fail(400, "单元格选区无效");
  return {
    kind: "cells" as const,
    sheetId: value.sheetId,
    startRow: Number(value.startRow),
    endRow: Number(value.endRow),
    startColumn: Number(value.startColumn),
    endColumn: Number(value.endColumn),
    editing: value.editing === true,
  };
}
