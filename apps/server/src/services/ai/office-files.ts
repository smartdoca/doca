import { zipSync, strToU8 } from "fflate";
import { fail } from "@core/shared/errors.js";

export type ExportFormat = "word" | "markdown" | "excel" | "pdf";

const mimeByFormat: Record<ExportFormat, string> = {
  word: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  markdown: "text/markdown",
  excel:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};
const extByFormat: Record<ExportFormat, string> = {
  word: "docx",
  markdown: "md",
  excel: "xlsx",
  pdf: "pdf",
};

export function exportMime(format: ExportFormat) {
  return mimeByFormat[format];
}

export function withExportExtension(name: string, format: ExportFormat) {
  const ext = extByFormat[format];
  const trimmed = name.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim() || "未命名";
  return /\.[a-z0-9]{1,8}$/i.test(trimmed)
    ? trimmed.replace(/\.[a-z0-9]{1,8}$/i, `.${ext}`)
    : `${trimmed}.${ext}`;
}

function xml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colName(index: number) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    n--;
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26);
  }
  return name;
}

export function parseTable(content: string): string[][] {
  const lines = content.split(/\r?\n/);
  const table = lines.filter((line) => line.trim().startsWith("|"));
  if (table.length >= 2)
    return table
      .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line))
      .map((line) =>
        line
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim()),
      )
      .filter((row) => row.some((cell) => cell.length > 0));
  const rows = lines.map((line) => [line]).filter((row) => row[0]!.length);
  return rows.length ? rows : [[""]];
}

function zip(files: Record<string, string>) {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
      ),
    ),
  );
}

function paragraphs(content: string) {
  const parts = content.replace(/\r\n/g, "\n").split(/\n/);
  return parts.length ? parts : [""];
}

function wordDocument(content: string) {
  const body = paragraphs(content)
    .map(
      (line) =>
        `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`,
    )
    .join("");
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  });
}

function excelDocument(rows: string[][]) {
  const limited = rows.slice(0, 500).map((row) => row.slice(0, 50));
  const values = limited.length ? limited : [[""]];
  const shared: string[] = [];
  const indexOf = (value: string) => {
    const found = shared.indexOf(value);
    if (found >= 0) return found;
    shared.push(value);
    return shared.length - 1;
  };
  const sheetRows = values
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => {
          const ref = `${colName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" t="s"><v>${indexOf(cell)}</v></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const strings = shared
    .map((value) => `<si><t xml:space="preserve">${xml(value)}</t></si>`)
    .join("");
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${strings}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

function utf16BeHex(text: string) {
  const bytes = [0xfe, 0xff];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const extra = cp - 0x10000;
      const hi = 0xd800 + (extra >> 10);
      const lo = 0xdc00 + (extra & 0x3ff);
      bytes.push(hi >> 8, hi & 255, lo >> 8, lo & 255);
    } else bytes.push(cp >> 8, cp & 255);
  }
  return Buffer.from(bytes).toString("hex").toUpperCase();
}

function wrapPdfLine(line: string) {
  const parts: string[] = [];
  let current = "";
  for (const ch of line) {
    current += ch;
    if (current.length >= 32) {
      parts.push(current);
      current = "";
    }
  }
  if (current || !parts.length) parts.push(current);
  return parts;
}

function pdfDocument(content: string) {
  const lines = paragraphs(content).flatMap(wrapPdfLine).slice(0, 2000);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 40)
    pages.push(lines.slice(i, i + 40));
  if (!pages.length) pages.push([""]);
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  const fontId = 3;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("placeholder");
  add(
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H >>",
  );
  for (const page of pages) {
    const stream = [
      "BT",
      "/F1 12 Tf",
      "16 TL",
      "72 760 Td",
      ...page.map((line, index) => {
        const cmd = `<${utf16BeHex(line)}> Tj`;
        return index ? `T* ${cmd}` : cmd;
      }),
      "ET",
    ].join("\n");
    contentIds.push(
      add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    );
  }
  for (let i = 0; i < pages.length; i++)
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
      ),
    );
  objects[1] =
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(chunks.join("")));
    chunks.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const startxref = Buffer.byteLength(chunks.join(""));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= objects.length; i++)
    chunks.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  chunks.push(
    `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
  );
  return Buffer.from(chunks.join(""));
}

export function createExportFile(
  format: ExportFormat,
  input: { content: string; rows?: string[][] },
) {
  const content = input.content ?? "";
  if (!content.trim() && !(input.rows && input.rows.some((row) => row.some((cell) => cell.trim()))))
    fail(400, "需要文件正文或表格内容");
  if (format === "markdown")
    return { body: Buffer.from(content, "utf8"), mime: mimeByFormat.markdown };
  if (format === "word")
    return { body: wordDocument(content), mime: mimeByFormat.word };
  if (format === "excel")
    return {
      body: excelDocument(input.rows?.length ? input.rows : parseTable(content)),
      mime: mimeByFormat.excel,
    };
  return { body: pdfDocument(content), mime: mimeByFormat.pdf };
}
