import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { xlsxToSnapshot } from "@smartdoca/sheet/xlsx";
import {
  exportSpreadsheetXlsx,
  importSpreadsheetXlsx,
} from "@web/features/documents/spreadsheet-xlsx.js";

function workbook(sheetXml: string, filename: string) {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
  };
  return new File([zipSync(files)], filename);
}

function workbookWithFullColumnSpan() {
  return workbook(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols><col min="1" max="16384" width="9" customWidth="1"/></cols>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>
    <row r="10000"><c r="A10000" t="inlineStr"><is><t>末行</t></is></c></row>
  </sheetData>
</worksheet>`,
    "wide-columns.xlsx",
  );
}

function workbookWithLastRow() {
  return workbook(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>
    <row r="1048576" ht="20" customHeight="1"/>
  </sheetData>
</worksheet>`,
    "last-row.xlsx",
  );
}

it("rejects a full-sheet column definition at the importer default of 256 columns", async () => {
  await expect(xlsxToSnapshot(workbookWithFullColumnSpan(), "workbook")).rejects.toThrow(
    "XLSX maxColumns exceeded (16384 > 256)",
  );
});

it("rejects a row written at Excel's last row under the importer default of 20000", async () => {
  await expect(xlsxToSnapshot(workbookWithLastRow(), "workbook")).rejects.toThrow(
    "XLSX maxRows exceeded (1048576 > 20000)",
  );
});

it(
  "imports a row definition that reaches Excel's last row",
  async () => {
    const imported = await importSpreadsheetXlsx(workbookWithLastRow(), "workbook");
    const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!];
    expect(sheet?.rowCount).toBe(1_048_576);
    expect(sheet?.cellData?.[0]?.[0]?.v).toBe("标题");
    expect(sheet?.rowData?.[1_048_575]?.h).toBeGreaterThan(0);
    const exported = await exportSpreadsheetXlsx(imported.snapshot);
    expect(exported.blob.size).toBeGreaterThan(0);
  },
  30_000,
);

it("imports a column definition that reaches Excel's last column", async () => {
  const file = workbookWithFullColumnSpan();
  const imported = await importSpreadsheetXlsx(file, "workbook");
  const sheet = imported.snapshot.sheets[imported.snapshot.sheetOrder[0]!];
  expect(sheet?.columnCount).toBe(16_384);
  expect(sheet?.cellData?.[9999]?.[0]?.v).toBe("末行");
  const exported = await exportSpreadsheetXlsx(imported.snapshot);
  expect(exported.blob.size).toBeGreaterThan(0);
});
