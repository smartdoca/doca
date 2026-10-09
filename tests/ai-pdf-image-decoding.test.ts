import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { extractPdfPages, type PdfPart } from "@server/services/ai/pdf-text.js";

const lifecycle = vi.hoisted(() => ({
  decoratePage: undefined as undefined | ((page: any) => void),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...actual,
    getDocument: (options: Parameters<typeof actual.getDocument>[0]) => {
      const task = actual.getDocument(options);
      return {
        promise: task.promise.then((doc) => {
          const getPage = doc.getPage.bind(doc);
          doc.getPage = async (pageNumber) => {
            const page = await getPage(pageNumber);
            lifecycle.decoratePage?.(page);
            return page;
          };
          return doc;
        }),
      };
    },
  };
});
afterEach(() => { lifecycle.decoratePage = undefined; });

async function readParts(body: Buffer) {
  const parts: PdfPart[] = [];
  for await (const part of extractPdfPages(body)) parts.push(part);
  return parts;
}

it.each(["data", "null"] as const)("waits for the real scan PDF's late OPLIST resource and strictly checks its resolved %s", async result => {
  const body = await readFile(new URL("./fixtures/ai-recognition/scan.pdf", import.meta.url));
  const baseline = await readParts(body);
  const baselineImage = baseline.find(part => part.type === "image");
  if (!baselineImage || baselineImage.type !== "image") throw Error("Missing baseline scan image");
  const events: string[] = [];
  let publications = 0;
  lifecycle.decoratePage = page => {
    // PDF.js 5.7's OPLIST image is img_p0_1; display independently uses img_p0_2.
    // Hold only the first publication, without changing decoding or render bytes.
    const imageId = "img_p0_1", pool = page.objs;
    const resolve = pool.resolve.bind(pool), get = pool.get.bind(pool);
    let held: unknown, published = false, waiting = false, rendered = false, released = false;
    const release = () => {
      if (!published || !waiting || !rendered || released) return;
      released = true;
      events.push("resource-resolved");
      resolve(imageId, result === "null" ? null : held);
      publications++;
    };
    pool.resolve = (id: string, data: unknown) => {
      if (id !== imageId) return resolve(id, data);
      held = data;
      published = true;
      if (waiting) queueMicrotask(release);
    };
    pool.get = (id: string, callback?: (data: unknown) => void) => {
      const value = get(id, callback);
      if (id === imageId && callback) {
        events.push("resource-awaited");
        waiting = true;
        queueMicrotask(release);
      }
      return value;
    };
    const render = page.render.bind(page);
    page.render = (options: any) => {
      const task = render(options);
      return { promise: task.promise.then(() => {
        expect(pool.has(imageId)).toBe(false);
        expect(pool.has("img_p0_2")).toBe(true);
        expect(Buffer.from(options.canvas.toBuffer("image/png"))).toEqual(baselineImage.data);
        rendered = true;
        events.push("display-completed");
      }) };
    };
  };
  const parts: PdfPart[] = [];
  const read = (async () => { for await (const part of extractPdfPages(body)) parts.push(part); })();
  if (result === "null") {
    await expect(read).rejects.toThrow("PDF page 1: image decoding failed");
    expect(parts.map(part => part.type)).toEqual(["text"]);
  } else {
    await read;
    expect(parts).toEqual(baseline);
  }
  expect(events).toEqual(["display-completed", "resource-awaited", "resource-resolved"]);
  expect(publications).toBe(1);
});

/** A well-formed PDF page with independent text and one visible image XObject. */
function imagePage(kind: "rgb" | "broken-jpeg") {
  const content = Buffer.from(
    "BT /F1 12 Tf 16 112 Td (Readable page text.) Tj ET\n" +
      "q 48 0 0 48 16 16 cm /Im1 Do Q\n",
  );
  const image =
    kind === "rgb" ? Buffer.from([220, 35, 20]) : Buffer.from([0, 1, 2, 3]);
  const imageProperties =
    "/ColorSpace /DeviceRGB /BitsPerComponent 8" +
    (kind === "broken-jpeg" ? " /Filter /DCTDecode" : "");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 128] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("endstream"),
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ${imageProperties} /Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from("\nendstream"),
    ]),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(chunks.reduce((length, chunk) => length + chunk.length, 0));
    chunks.push(
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    );
  }
  const startxref = chunks.reduce((length, chunk) => length + chunk.length, 0);
  chunks.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
        offsets
          .slice(1)
          .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
          .join("") +
        `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

it("renders the visible artwork in Mozilla's real JBIG2 fixture", async () => {
  const body = await readFile(
    new URL(
      "./fixtures/ai-pdf-image-decoding/jbig2-symbol-offset.pdf",
      import.meta.url,
    ),
  );
  expect(body.includes(Buffer.from("/JBIG2Decode"))).toBe(true);
  const parts = await readParts(body);
  expect(parts.map((part) => part.type)).toEqual(["text", "image"]);
  const image = parts.find((part) => part.type === "image");
  if (!image || image.type !== "image") throw Error("Missing page image");
  expect(image.filename).toBe("page-1.png");
  // The fixture's only content is the image at x=48, y=550, w=500, h=53 pt.
  // A decoder that silently drops it returns an entirely white crop.
  const { data, info } = await sharp(image.data)
    .extract({ left: 96, top: 478, width: 1000, height: 104 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let darkPixels = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i]! < 64 && data[i + 1]! < 64 && data[i + 2]! < 64) darkPixels++;
  expect(darkPixels).toBeGreaterThan(5_000);
  expect(darkPixels).toBeLessThan(70_000);
});

it("renders a valid XObject and retains the page's independent readable text", async () => {
  const parts = await readParts(imagePage("rgb"));
  expect(parts[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Readable page text."),
  });
  const image = parts.find((part) => part.type === "image");
  if (!image || image.type !== "image") throw Error("Missing page image");
  const { data, info } = await sharp(image.data)
    .extract({ left: 40, top: 136, width: 80, height: 80 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let redPixels = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i]! > 180 && data[i + 1]! < 70 && data[i + 2]! < 70) redPixels++;
  expect(redPixels).toBe(80 * 80);
});

it("rejects a well-formed page with a corrupt JPEG XObject instead of returning an incomplete image", async () => {
  const parts: PdfPart[] = [];
  await expect(
    (async () => {
      for await (const part of extractPdfPages(imagePage("broken-jpeg")))
        parts.push(part);
    })(),
  ).rejects.toThrow();
  expect(parts[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Readable page text."),
  });
  expect(parts.some((part) => part.type === "image")).toBe(false);
});
