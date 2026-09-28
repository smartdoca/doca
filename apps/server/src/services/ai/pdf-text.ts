import { inflateRawSync, inflateSync } from "node:zlib";

const MAX_STREAMS = 2048;
const MAX_INFLATED = 20 * 1024 * 1024;

export type PdfPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; filename: string; data: Buffer };

function inflatePdf(data: Buffer) {
  for (const fn of [inflateSync, inflateRawSync]) {
    try {
      const out = fn(data);
      if (out.length <= MAX_INFLATED) return out;
    } catch {}
    if (data.length) {
      try {
        const out = fn(data.subarray(0, -1));
        if (out.length <= MAX_INFLATED) return out;
      } catch {}
    }
  }
  return Buffer.alloc(0);
}

function decodeLiteral(raw: string) {
  const escapes: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
  };
  return raw.replace(/\\([0-7]{1,3})|\\(.)/g, (_, octal: string, ch: string) =>
    octal
      ? String.fromCharCode(parseInt(octal, 8))
      : (escapes[ch] ?? ch),
  );
}

function decodeHex(hex: string) {
  const clean = hex.replace(/\s/g, "");
  if (!clean || clean.length % 2) return "";
  const bytes = Buffer.from(clean, "hex");
  const utf16 =
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes.length >= 4 &&
      bytes.length % 2 === 0 &&
      bytes.filter((_, i) => i % 2 === 0 && bytes[i] === 0).length >=
        bytes.length / 4);
  if (!utf16) return bytes.toString("latin1");
  const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
  const swapped = Buffer.alloc(bytes.length - start);
  for (let i = start; i + 1 < bytes.length; i += 2) {
    swapped[i - start] = bytes[i + 1]!;
    swapped[i - start + 1] = bytes[i]!;
  }
  return swapped.toString("utf16le");
}

function stringsFrom(content: string) {
  const parts: string[] = [];
  const src = content.replace(/\\\r?\n/g, "");
  for (const match of src.matchAll(
    /\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f \t\r\n]+)>/g,
  )) {
    if (match[1] != null) {
      const text = decodeHex(match[1]);
      if (text.trim()) parts.push(text);
      continue;
    }
    const text = decodeLiteral(match[0].slice(1, -1));
    if (text.trim()) parts.push(text);
  }
  return parts;
}

function streamFilter(dict: string) {
  return (
    dict.match(/\/Filter\s*\/(\w+)/)?.[1] ??
    dict.match(/\/Filter\s*\[\s*\/(\w+)/)?.[1] ??
    ""
  );
}

function pdfStreams(body: Buffer) {
  const streams: { filter: string; data: Buffer }[] = [];
  let pos = 0;
  while (streams.length < MAX_STREAMS) {
    const start = body.indexOf("stream", pos);
    if (start < 0) break;
    const before = start === 0 ? 0 : body[start - 1];
    if (before && !/[<\s]/.test(String.fromCharCode(before))) {
      pos = start + 6;
      continue;
    }
    let dataStart = start + 6;
    if (body[dataStart] === 0x0d) dataStart++;
    if (body[dataStart] === 0x0a) dataStart++;
    const dictFrom = body.lastIndexOf("<<", start);
    const dict = body
      .subarray(dictFrom < 0 ? Math.max(0, start - 800) : dictFrom, start)
      .toString("latin1");
    const filter = streamFilter(dict);
    const declared = Number(dict.match(/\/Length\s+(\d+)/)?.[1] ?? 0);
    let data: Buffer;
    if (declared > 0 && dataStart + declared <= body.length) {
      data = body.subarray(dataStart, dataStart + declared);
      pos = dataStart + declared;
    } else {
      const end = body.indexOf("endstream", dataStart);
      if (end < 0) break;
      data = body.subarray(dataStart, end);
      if (filter !== "DCTDecode") {
        if (data.length && data[data.length - 1] === 0x0a)
          data = data.subarray(0, -1);
        if (data.length && data[data.length - 1] === 0x0d)
          data = data.subarray(0, -1);
      }
      pos = end + 9;
    }
    if (filter === "FlateDecode") data = inflatePdf(data);
    if (data.length) streams.push({ filter, data });
    if (declared > 0) {
      const end = body.indexOf("endstream", pos);
      pos = end < 0 ? pos + 1 : end + 9;
    }
  }
  return streams;
}

/** Turn a PDF into ordered text and embedded JPEG parts. */
export function extractPdfParts(body: Buffer): PdfPart[] {
  if (body.subarray(0, 5).toString() !== "%PDF-") return [];
  const parts: PdfPart[] = [];
  let images = 0;
  for (const stream of pdfStreams(body)) {
    if (
      stream.filter === "DCTDecode" &&
      stream.data[0] === 0xff &&
      stream.data[1] === 0xd8
    ) {
      parts.push({
        type: "image",
        mime: "image/jpeg",
        filename: `embedded-${++images}.jpg`,
        data: stream.data,
      });
      continue;
    }
    const texts = stringsFrom(stream.data.toString("latin1"));
    if (texts.length) parts.push({ type: "text", text: texts.join("\n") });
  }
  return parts;
}

function pdfTextOf(parts: PdfPart[]) {
  return parts
    .filter((part): part is PdfPart & { type: "text" } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Turn a PDF into markdown the chat/recognition models can read. */
export function extractPdfMarkdown(body: Buffer) {
  return pdfTextOf(extractPdfParts(body));
}

/** Shared parser for attachments, folder indexing and file_read. Never interpret compressed bytes as text. */
export async function extractPdfPartsRich(body: Buffer): Promise<PdfPart[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(body), useSystemFonts: true,
    cMapUrl: join(root, "cmaps/"), cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts/"),
  }).promise;
  const parts: PdfPart[] = [];
  let rendered = 0;
  try {
    const count = Math.min(doc.numPages, 50);
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item
        ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      parts.push({type:"text", text:`## 第 ${i} 页\n${text}`});
      const ops = await page.getOperatorList();
      const hasImage = ops.fnArray.some(op => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject].includes(op));
      if ((text.length < 40 || hasImage) && rendered < 16) {
        const base = page.getViewport({scale:1});
        const viewport = page.getViewport({scale:Math.min(2,1600/Math.max(base.width,base.height))});
        const factory = doc.canvasFactory as any;
        const target = factory.create(Math.ceil(viewport.width),Math.ceil(viewport.height));
        try {
          await page.render({canvasContext:target.context,canvas:target.canvas,viewport}).promise;
          parts.push({type:"image",mime:"image/png",filename:`page-${i}.png`,data:Buffer.from(target.canvas.toBuffer("image/png"))});
          rendered++;
        } finally { factory.destroy(target); }
      } else if (text.length < 40 || hasImage) {
        parts.push({type:"text",text:"[页面图像超过16页上限，此页视觉内容未识别]"});
      }
      page.cleanup();
    }
    if (doc.numPages > count) parts.push({type:"text",text:`[共${doc.numPages}页，仅解析前${count}页，后文未识别]`});
    return parts;
  } finally { await doc.destroy(); }
}
