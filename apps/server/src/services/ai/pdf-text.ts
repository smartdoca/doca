import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PdfPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; filename: string; data: Buffer };

/** Text and a rendered image for EVERY page, including vectors and text-only pages. */
export async function* extractPdfPages(body: Buffer): AsyncGenerator<PdfPart> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = dirname(
    fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
  );
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(body),
    useSystemFonts: true,
    cMapUrl: join(root, "cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts/"),
    wasmUrl: join(root, "wasm/"),
    // Missing artwork must fail parsing rather than produce an incomplete page.
    stopAtErrors: true,
  }).promise;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("")
          .trim();
        const base = page.getViewport({ scale: 1 });
        yield {
          type: "text",
          text: `## 第 ${i} 页 / 共 ${doc.numPages} 页\n页面尺寸：${base.width} × ${base.height} pt\n${text}`,
        };
        const viewport = page.getViewport({
          scale: Math.min(2, 2000 / Math.max(base.width, base.height)),
        });
        const operators = await page.getOperatorList();
        const factory = doc.canvasFactory as any;
        const target = factory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        try {
          await page.render({
            canvasContext: target.context,
            canvas: target.canvas,
            viewport,
          }).promise;
          // OPLIST and display rendering have separate image dependencies.
          // Wait for this list's resource; display completion need not resolve it.
          // PDF.js can resolve failed decoding to null despite stopAtErrors.
          for (let op = 0; op < operators.fnArray.length; op++) {
            if (
              operators.fnArray[op] !== pdfjs.OPS.paintImageXObject &&
              operators.fnArray[op] !== pdfjs.OPS.paintImageXObjectRepeat
            )
              continue;
            const imageId = operators.argsArray[op]?.[0];
            if (typeof imageId !== "string")
              throw new Error(`PDF page ${i}: invalid image resource`);
            const pool = imageId.startsWith("g_")
              ? page.commonObjs
              : page.objs;
            const image = await new Promise<unknown>((resolve) =>
              pool.get(imageId, resolve),
            );
            if (!image)
              throw new Error(`PDF page ${i}: image decoding failed`);
          }
          yield {
            type: "image",
            mime: "image/png",
            filename: `page-${i}.png`,
            data: Buffer.from(target.canvas.toBuffer("image/png")),
          };
        } finally {
          factory.destroy(target);
        }
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
}

export async function extractPdfPartsRich(body: Buffer): Promise<PdfPart[]> {
  const parts: PdfPart[] = [];
  for await (const part of extractPdfPages(body)) parts.push(part);
  return parts;
}
