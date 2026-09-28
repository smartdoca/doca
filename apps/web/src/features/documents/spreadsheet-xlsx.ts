import {
  snapshotToXlsx,
  xlsxToSnapshot,
  type XlsxExportResult,
  type XlsxImportResult,
  type XlsxOptions,
} from "@smartdoca/sheet/xlsx";

/**
 * 导入预检的默认值是 2 万行、256 列。Excel 最后一行是 1048576，最后一列是 XFD（16384）。
 * 整表列定义 `<col max="16384">`，以及写到最后一行的 `<row r="1048576">`，都会在建模型前被拒绝。
 * 在线表格的结构容量就是这两个数。轴数量要盖住单表初始化后的行数加列数，否则预检通过后仍会因 maxAxisEntries 失败。
 */
export const SPREADSHEET_XLSX_LIMITS = {
  maxRows: 1_048_576,
  maxColumns: 16_384,
  maxAxisEntries: 1_048_576 + 16_384,
} as const;

export function spreadsheetXlsxOptions(): XlsxOptions {
  return { limits: { ...SPREADSHEET_XLSX_LIMITS } };
}

export function importSpreadsheetXlsx(
  file: Blob,
  workbookId: string,
): Promise<XlsxImportResult> {
  const fileName = file instanceof File ? file.name : undefined;
  return xlsxToSnapshot(file, workbookId, { ...spreadsheetXlsxOptions(), fileName });
}

export function exportSpreadsheetXlsx(
  snapshot: XlsxImportResult["snapshot"],
): Promise<XlsxExportResult> {
  return snapshotToXlsx(snapshot, spreadsheetXlsxOptions());
}
