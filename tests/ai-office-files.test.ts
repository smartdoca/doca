import { expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { relevantSkillFormats } from "@core/modules/ai/skills.js";
import { extractAttachmentText } from "../apps/server/src/services/ai/attachments.js";
import { extractFileParts, extractFilePartsAsync } from "../apps/server/src/services/ai/extract-content.js";
import {
  createExportFile,
  parseTable,
  withExportExtension,
} from "../apps/server/src/services/ai/office-files.js";

it("loads editing skills only when the request actually needs them", () => {
  expect([...relevantSkillFormats("调研一下竞品方案")]).toEqual([]);
  expect(relevantSkillFormats("帮我写一份周报").has("rich_text")).toBe(true);
  expect(relevantSkillFormats("把调研报告保存为 PDF").has("rich_text")).toBe(
    false,
  );
  expect(relevantSkillFormats("在表格里写公式").has("spreadsheet")).toBe(true);
  expect(
    relevantSkillFormats("总结一下", ["spreadsheet"]).has("spreadsheet"),
  ).toBe(true);
});

it("creates Word, Markdown, Excel and PDF files from report text", async () => {
  expect(withExportExtension("调研报告", "pdf")).toBe("调研报告.pdf");
  expect(withExportExtension("notes.TXT", "markdown")).toBe("notes.md");
  const markdown = createExportFile("markdown", { content: "# 结论\n已完成" });
  expect(markdown.body.toString("utf8")).toContain("已完成");
  const word = createExportFile("word", { content: "调研结论\n第二段" });
  expect(extractAttachmentText("report.docx", word.body)).toContain("调研结论");
  const report = createExportFile("word", {
    content:
      "# 平台概况\n\n- 开发者规模\n\n|项目|说明|\n|---|---|\n|定价|订阅|\n\n见 [官网](https://github.com/pricing)",
  });
  const packed = unzipSync(report.body);
  const documentXml = new TextDecoder().decode(packed["word/document.xml"]);
  const rels = new TextDecoder().decode(packed["word/_rels/document.xml.rels"]);
  expect(documentXml).toContain("Heading1");
  expect(documentXml).toContain("w:tbl");
  expect(documentXml).not.toContain("# 平台概况");
  expect(rels).toContain("https://github.com/pricing");
  expect(packed["word/styles.xml"]).toBeTruthy();
  expect(extractAttachmentText("report.docx", report.body)).toContain(
    "平台概况",
  );
  expect(extractAttachmentText("report.docx", report.body)).toContain("订阅");
  expect(parseTable("|项目|金额|\n|---|---|\n|差旅|1200|")).toEqual([
    ["项目", "金额"],
    ["差旅", "1200"],
  ]);
  const excel = createExportFile("excel", {
    content: "|项目|金额|\n|---|---|\n|差旅|1200|",
  });
  const sheet = extractAttachmentText("report.xlsx", excel.body);
  expect(sheet).toContain("差旅");
  expect(sheet).toContain("1200");
  const pdf = createExportFile("pdf", { content: "调研结论" });
  expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
  const pdfParts = await extractFilePartsAsync("report.pdf", pdf.body);
  expect(pdfParts.filter(part => part.type === "text").map(part => part.text).join("\n")).toContain("调研结论");
  expect(
    extractAttachmentText("blank.pdf", Buffer.from("%PDF-1.7\nfixture")),
  ).toContain("未能从该 PDF");
  const payload = Buffer.from("BT /F1 12 Tf 10 100 Td (Flate Hello) Tj ET");
  const compressed = deflateSync(payload);
  const flate = Buffer.concat([
    Buffer.from(
      "%PDF-1.1\n1 0 obj<< /Length " +
        compressed.length +
        " /Filter /FlateDecode >>\nstream\n",
    ),
    compressed,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  expect(extractAttachmentText("zip.pdf", flate)).toContain("Flate Hello");
});

it("keeps embedded Office and PDF images in document order", async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#c44" },
  })
    .png()
    .toBuffer();
  const word = Buffer.from(
    zipSync({
      "word/document.xml": strToU8(
        '<w:document><w:p><w:r><w:t>封面前</w:t></w:r><w:r><w:drawing><a:blip r:embed="rId4"/></w:drawing></w:r><w:r><w:t>封面后</w:t></w:r></w:p></w:document>',
      ),
      "word/_rels/document.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId4" Target="media/image1.png"/></Relationships>',
      ),
      "word/media/image1.png": png,
    }),
  );
  const office = extractFileParts("plan.docx", word);
  expect(office.map((part) => part.type)).toEqual(["text", "image", "text"]);
  expect(office[0]).toMatchObject({ type: "text", text: "封面前" });
  expect(office[1]).toMatchObject({ type: "image", mime: "image/png" });
  expect(office[2]).toMatchObject({ type: "text", text: "封面后" });
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#24a" },
  })
    .jpeg()
    .toBuffer();
  const payload = Buffer.from("BT /F1 12 Tf 10 100 Td (Before image) Tj ET");
  const compressed = deflateSync(payload);
  const pdf = Buffer.concat([
    Buffer.from(
      "%PDF-1.1\n1 0 obj<< /Length " +
        compressed.length +
        " /Filter /FlateDecode >>\nstream\n",
    ),
    compressed,
    Buffer.from(
      "\nendstream\nendobj\n2 0 obj<< /Length " +
        jpeg.length +
        " /Filter /DCTDecode >>\nstream\n",
    ),
    jpeg,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const pages = extractFileParts("scan.pdf", pdf);
  expect(pages[0]).toMatchObject({ type: "text", text: "Before image" });
  expect(pages.some((part) => part.type === "image")).toBe(true);
});

it.each([
  ["生成一份调研报告", "rich_text"],
  ["创建一份文档", "rich_text"],
  ["优化文档样式", "rich_text"],
  ["文档样式优化", "rich_text"],
  ["制作三页PPT", "presentation"],
  ["创建项目画布", "canvas"],
  ["制作预算表格", "spreadsheet"],
  ["生成 Markdown 文档", "markdown"],
])("suggests an editing manual for %s", (text, format) => {
  expect([...relevantSkillFormats(text)]).toContain(format);
});
