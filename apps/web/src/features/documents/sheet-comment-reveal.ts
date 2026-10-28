import type { SpreadsheetEditorHandle } from "@smartdoca/sheet";

/** Native scrollToCell subtracts frozen *indices*. Hidden or differently sized
 * rows/columns make that origin land underneath the frozen pane. Scroll using
 * the current pane's pixel dimensions instead; this is a view command only. */
export async function revealSheetComment(
  handle: SpreadsheetEditorHandle,
  anchor: Parameters<SpreadsheetEditorHandle["revealCommentAnchor"]>[0],
) {
  const range = handle.revealCommentAnchor(anchor);
  if (!range) return;
  const api = handle.getRuntime()?.univerAPI;
  const sheet = api?.getActiveWorkbook()?.getWorkbook?.()?.getSheetBySheetId(range.sheetId);
  if (!api || !sheet) return;
  const freeze = sheet.getConfig().freeze;
  const params: {
    sheetViewStartRow?: number;
    sheetViewStartColumn?: number;
    offsetX?: number;
    offsetY?: number;
  } = {};
  if (freeze.ySplit > 0 && range.startRow >= freeze.startRow) {
    let height = 0;
    for (let row = freeze.startRow - freeze.ySplit; row < freeze.startRow; row++)
      if (sheet.getRowVisible(row)) height += sheet.getRowHeight(row);
    params.sheetViewStartRow = range.startRow;
    params.offsetY = -height;
  }
  if (freeze.xSplit > 0 && range.startColumn >= freeze.startColumn) {
    let width = 0;
    for (let column = freeze.startColumn - freeze.xSplit; column < freeze.startColumn; column++)
      if (sheet.getColVisible(column)) width += sheet.getColumnWidth(column);
    params.sheetViewStartColumn = range.startColumn;
    params.offsetX = -width;
  }
  if (Object.keys(params).length)
    await api.executeCommand("sheet.command.scroll-view", params);
}
