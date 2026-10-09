import { expect, it } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { zipSync, unzipSync, strToU8 } from "fflate";
import {
  extractFilePartsAsync,
  extractFileParts,
} from "../apps/server/src/services/ai/extract-content.js";
import { createExportFile } from "../apps/server/src/services/ai/office-files.js";

function bookPdf(pages: number) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 1; i <= pages; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (i - 1) * 2} 0 R >>`,
    );
    const content = `q 1 0 0 rg 20 20 100 60 re f Q\nBT /F1 12 Tf 20 130 Td (BOOK-PAGE-${i}) Tj ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  let body = "%PDF-1.4\n",
    offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
it("preserves every page beyond the former 16-image and 50-page caps, including vector artwork", async () => {
  const parts = await extractFilePartsAsync("story.pdf", bookPdf(51));
  const images = parts.filter((part) => part.type === "image");
  expect(images).toHaveLength(51);
  expect(parts.at(-2)).toMatchObject({
    type: "text",
    text: expect.stringContaining("BOOK-PAGE-51"),
  });
  expect(images.at(-1)?.filename).toBe("page-51.png");
  const pixels = await sharp(images.at(-1)!.data)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let i = 0; i < pixels.data.length; i += 3)
    if (
      pixels.data[i]! > 240 &&
      pixels.data[i + 1]! < 10 &&
      pixels.data[i + 2]! < 10
    )
      red++;
  expect(red).toBeGreaterThan(1000);
});
it.each(["word", "excel"] as const)(
  "renders %s layout while retaining source text and structures",
  async (format) => {
    const file = createExportFile(format, {
      content: "# 故事书\n\n妈妈讲故事\n\n|角色|页数|\n|---|---|\n|宝宝|12|",
    });
    const parts = await extractFilePartsAsync(
      format === "word" ? "book.docx" : "book.xlsx",
      file.body,
    );
    expect(parts.some((part) => part.type === "image")).toBe(true);
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(text).toContain("宝宝");
    expect(text).toContain("Office 源文件文字");
    expect(text).toContain("结构与样式");
  },
);
it("preserves mixed XML node order and rejects external resources before Office conversion", () => {
  const document =
    "<w:document><w:p><w:r><w:t>前</w:t><w:br/><w:t>后</w:t></w:r></w:p></w:document>";
  const basic = { "word/document.xml": strToU8(document) };
  expect(extractFileParts("book.docx", Buffer.from(zipSync(basic)))).toEqual([
    { type: "text", text: "前" },
    { type: "text", text: "后" },
  ]);
  const external = Buffer.from(
    zipSync({
      ...basic,
      "word/_rels/settings.xml.rels": strToU8(
        '<Relationships><Relationship Id="remote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" TargetMode="External" Target="https://invalid.test/template.dotm"/></Relationships>',
      ),
    }),
  );
  expect(() => extractFileParts("book.docx", external)).toThrow(
    "office_external_resource_unsupported",
  );
});
it("retains Excel formulas and cached values even outside a printed page", () => {
  const file = createExportFile("excel", {
    content: "|A|B|\n|---|---|\n|2|4|",
  });
  const packed = unzipSync(file.body);
  const sheet = Object.keys(packed).find((key) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(key),
  )!;
  packed[sheet] = strToU8(
    '<worksheet><sheetData><row r="99"><c r="Z99"><f>SUM(A1:A98)</f><v>2709</v></c></row></sheetData></worksheet>',
  );
  const text = extractFileParts("formulas.xlsx", Buffer.from(zipSync(packed)))
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(text).toContain("Z99: 2709 [公式: SUM(A1:A98)]");
});
it("renders PowerPoint slide artwork and retains speaker notes", async () => {
  const parts = await extractFilePartsAsync(
    "story.pptx",
    await readFile(
      new URL("./fixtures/ai-recognition/story.pptx", import.meta.url),
    ),
  );
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(text).toContain("PPT_STYLE_MARKER");
  expect(text).toContain("NOTE_MARKER");
  expect(
    parts.some(
      (part) => part.type === "image" && part.filename === "page-1.png",
    ),
  ).toBe(true);
});
