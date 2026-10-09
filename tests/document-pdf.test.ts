import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { renderDocumentPdf } from "@server/services/document-pdf.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { importEditablePdf, pdfTextBlocks } from "@web/features/documents/pdf-import.js";
import { createEditorDocument, createTableBlock, type EditorValue } from "@smartdoca/slate/headless";
import { exportDocument, importDocument } from "@smartdoca/slate/conversion";
import { strFromU8, unzipSync } from "fflate";
import { validateImport } from "@core/modules/documents/import.js";

it("recognizes headings, native emphasis, spacing between runs and repeated table columns", () => {
  const runs = [
    { text: "Title", x: 270, y: 790, width: 55, size: 24, font: "Arial-Bold" },
    ...Array.from({ length: 6 }, (_, r) => ({ text: "Normal body text with sufficient weight", x: 60, y: 720 - r * 20, width: 220, size: 12, font: "Arial" })),
    ...Array.from({ length: 3 }, (_, r) => [
      { text: "Item", x: 60, y: 500 - r * 20, width: 30, size: 12, font: "Arial-Bold" },
      { text: "Value", x: 260, y: 500 - r * 20, width: 35, size: 12, font: "Arial-Italic" },
    ]).flat(),
  ];
  const blocks = pdfTextBlocks(runs, 595).map(entry => entry.block);
  expect(blocks[0]).toMatchObject({ title: "h1", align: "center", children: [{ text: "Title", bold: true, fontSize: 32 }] });
  expect(blocks.at(-1)).toMatchObject({ type: "table", children: expect.any(Array) });
  expect(JSON.stringify(blocks.at(-1))).toContain('"italic":true');
  expect(() => validateImport(createEditorDocument(blocks))).not.toThrow();
});

it("renders selectable Chinese text and imports a real PDF as editable headings, emphasis and tables", async () => {
  const font = await readFile(new URL("../apps/web/src/features/documents/assets/NotoSansSC-Regular.ttf", import.meta.url));
  const html = `<style>@font-face{font-family:CJK;src:url(data:font/ttf;base64,${font.toString("base64")})}body{font-family:Arial,CJK;font-size:16px;padding:48px}h1{font-size:32px;color:#245bdb}table{border-collapse:collapse;width:600px}td{border:1px solid #aaa;padding:8px}</style><h1>中文标题 Editable PDF</h1><p>Editable body text that remains searchable and editable.</p><p><b>Bold emphasis</b> and <i>Italic emphasis</i></p><table>${["Name", "First", "Second"].map((name, i) => `<tr><td>${name}</td><td>Value ${i}</td></tr>`).join("")}</table>`;
  const bytes = await renderDocumentPdf(html, 794);
  const pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const page = await pdf.getPage(1), text = await page.getTextContent();
    expect(text.items.map(item => "str" in item ? item.str : "").join("").normalize("NFKC")).toContain("中文标题");
  } finally { await pdf.destroy(); }
  const imported = await importEditablePdf(new File([new Uint8Array(bytes)], "editable.pdf", { type: "application/pdf" }));
  const model = createEditorDocument(imported.initialValue);
  expect(() => validateImport(model)).not.toThrow();
  expect(imported.initialValue[0]).toMatchObject({ title: "h1", children: expect.arrayContaining([expect.objectContaining({ color: "#245bdb" })]) });
  expect(JSON.stringify(imported.initialValue)).toContain('"bold":true');
  expect(JSON.stringify(imported.initialValue)).toContain('"italic":true');
  expect(imported.initialValue.some(block => "type" in block && block.type === "table")).toBe(true);
  expect(imported.markdown.normalize("NFKC")).toContain("# 中文标题");
  expect(imported.markdown).toContain("**Bold emphasis**");
}, 30_000);

it("keeps native Word run styles, paragraph alignment and table marks on real DOCX roundtrip", async () => {
  const table = createTableBlock(1, 1);
  const row = table.children[0] as any;
  row.children[0].children = [{ text: "Styled cell", bold: true, color: "#112233", fontSize: 20 }];
  const value: EditorValue = [{ id: "p", type: "paragraph", align: "center", children: [{ text: "Styled body", fontSize: 24, fontFamily: '"Songti SC", serif', color: "#245bdb", backgroundColor: "#ffeeaa", bold: true }] }, table];
  const result = await exportDocument(value, { format: "docx", filename: "styles" });
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const xml = strFromU8(files["word/document.xml"]!);
  expect(xml).toContain('<w:jc w:val="center"/>');
  expect(xml).toContain('<w:sz w:val="36"/>');
  expect(xml).toContain('<w:color w:val="245bdb"/>');
  expect(xml).toContain('<w:shd w:val="clear" w:fill="ffeeaa"/>');
  const imported = await importDocument(result.blob, { filename: result.filename });
  expect(imported.initialValue[0]).toMatchObject({ align: "center", children: [{ text: "Styled body", fontSize: 24, fontFamily: "Songti SC", color: "#245bdb", backgroundColor: "#ffeeaa", bold: true }] });
  expect(JSON.stringify(imported.initialValue[1])).toContain('"color":"#112233"');
  expect(value[0]).toMatchObject({ children: [{ fontFamily: '"Songti SC", serif' }] });
});

it("blocks active content and remote image loads instead of exporting missing images", async () => {
  const bytes = await renderDocumentPdf('<p>Safe text</p><script>document.body.innerHTML="Executed"</script><iframe src="file:///etc/passwd"></iframe>', 794);
  const pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => "str" in item ? item.str : "").join("");
    expect(text).toContain("Safe text"); expect(text).not.toContain("Executed");
  } finally { await pdf.destroy(); }
  await expect(renderDocumentPdf('<img src="https://example.com/private.png">', 794)).rejects.toThrow();
});
