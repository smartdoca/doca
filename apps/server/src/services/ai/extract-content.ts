import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { fail } from "@core/shared/errors.js";
import { extractPdfPages } from "./pdf-text.js";
import { officePdf } from "./office-render.js";

export const textExtensions = /\.(txt|md|csv|json|log|yaml|yml)$/i;
export const officeExtensions = /\.(docx|xlsx|pptx)$/i;

export type ExtractedPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; filename: string; data: Buffer };

export function attachmentMime(filename: string, body: Buffer): string {
  if (/\.pdf$/i.test(filename) && body.subarray(0, 5).toString() === "%PDF-")
    return "application/pdf";
  if (officeExtensions.test(filename) && body[0] === 0x50 && body[1] === 0x4b)
    return "application/vnd.openxmlformats-officedocument";
  if (textExtensions.test(filename) && !body.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
      return "text/plain";
    } catch {}
  }
  return fail(
    400,
    "支持 UTF-8 文本、Markdown、CSV、JSON、Word、Excel、PPT、PDF 和 PNG/JPEG/WebP/GIF 图片",
  );
}

function sniffImage(data: Buffer) {
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)))
    return "image/gif";
  return "";
}

function resolveZipPath(relsFile: string, target: string) {
  const base = relsFile.replace(/_rels\/[^/]+$/, "");
  const out: string[] = [];
  for (const part of (base + target.replace(/^\.\//, "")).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function extractOfficeParts(body: Buffer): ExtractedPart[] {
  let total = 0,
    count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(body, {
      filter: (file) => {
        if (++count > 2048) throw Error("Too many entries");
        if (file.name.endsWith("/")) return false;
        if (/(?:vbaProject\.bin|activeX\/|embeddings\/)/i.test(file.name))
          throw Error("Active Office content unsupported");
        const include =
          /^(?:(?:word|ppt|xl)\/(?:.*\.(?:xml|rels)$|media\/)|_rels\/.*\.rels$)/.test(
            file.name,
          );
        if (
          include &&
          (file.originalSize > 64 * 1024 * 1024 ||
            (total += file.originalSize) > 256 * 1024 * 1024)
        )
          throw Error("Expanded file too large");
        return include;
      },
    });
  } catch {
    return fail(400, "Office 文件损坏或解压后过大");
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: true,
  });
  const parse = (bytes: Uint8Array) => {
    const xml = strFromU8(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail(400, "不支持包含外部实体的文档");
    return parser.parse(xml);
  };
  const texts = (v: any, key: string): string[] => {
    if (!v || typeof v !== "object") return [];
    return Object.entries(v).flatMap(([k, x]) =>
      k === key
        ? (Array.isArray(x) ? x : [x]).map((t) =>
            String(typeof t === "object" ? (t["#text"] ?? "") : t),
          )
        : Array.isArray(x)
          ? x.flatMap((t) => texts(t, key))
          : texts(x, key),
    );
  };
  const parts: ExtractedPart[] = [];
  const pushText = (value: string) => {
    if (value.trim()) parts.push({ type: "text", text: value });
  };
  const pushImage = (path: string) => {
    const data = files[path];
    if (!data) return;
    const mime = sniffImage(Buffer.from(data));
    if (!mime) return;
    parts.push({
      type: "image",
      mime,
      filename: path.split("/").pop() || "image",
      data: Buffer.from(data),
    });
  };
  const relsOf = (name: string) => {
    const xml = files[name];
    const map: Record<string, string> = {};
    if (!xml) return map;
    const rels = parse(xml).Relationships?.Relationship ?? [];
    for (const rel of Array.isArray(rels) ? rels : [rels]) {
      const id = rel["@_Id"],
        target = rel["@_Target"];
      if (
        rel["@_TargetMode"] === "External" &&
        !/(?:\/hyperlink)$/.test(String(rel["@_Type"]))
      )
        fail(400, "office_external_resource_unsupported");
      if (id && target && rel["@_TargetMode"] !== "External")
        map[id] = resolveZipPath(name, String(target));
    }
    return map;
  };
  for (const name of Object.keys(files).filter((name) =>
    name.endsWith(".rels"),
  ))
    relsOf(name);
  const ordered = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    preserveOrder: true,
  });
  const parseOrdered = (bytes: Uint8Array) => {
    const xml = strFromU8(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail(400, "不支持包含外部实体的文档");
    return ordered.parse(xml);
  };
  const walk = (node: any, rels: Record<string, string>) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, rels);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "w:t" || key === "a:t") {
        pushText(
          Array.isArray(value)
            ? value.map((item) => item["#text"] ?? "").join("")
            : String(value ?? ""),
        );
        continue;
      }
      if (key === "a:blip") {
        const embed = node[":@"]?.["@_r:embed"] ?? "";
        if (embed && rels[embed]) pushImage(rels[embed]!);
        continue;
      }
      if (key.startsWith("@_") || key === "#text") continue;
      walk(value, rels);
    }
  };

  if (files["word/document.xml"])
    walk(
      parseOrdered(files["word/document.xml"]!),
      relsOf("word/_rels/document.xml.rels"),
    );
  for (const name of Object.keys(files)
    .filter((name) =>
      /^word\/(?:header|footer|footnotes|endnotes|comments).*\.xml$/.test(name),
    )
    .sort()) {
    pushText(`## ${name}`);
    walk(
      parseOrdered(files[name]!),
      relsOf(name.replace("word/", "word/_rels/") + ".rels"),
    );
  }
  for (const name of Object.keys(files)
    .filter((item) => /^ppt\/slides\/slide\d+\.xml$/.test(item))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    walk(
      parseOrdered(files[name]!),
      relsOf(name.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels"),
    );
  }
  const sharedData = files["xl/sharedStrings.xml"]
    ? (parse(files["xl/sharedStrings.xml"]).sst?.si ?? [])
    : [];
  const shared = (Array.isArray(sharedData) ? sharedData : [sharedData]).map(
    (si) => texts(si, "t").join(""),
  );
  const excel: string[] = [];
  for (const name of Object.keys(files)
    .filter((item) => item.startsWith("xl/worksheets/"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const value = parse(files[name]!);
    const data = value.worksheet?.sheetData?.row ?? [];
    excel.push(name);
    for (const row of Array.isArray(data) ? data : [data]) {
      const cells = row.c ?? [];
      excel.push(
        (Array.isArray(cells) ? cells : [cells])
          .map(
            (c: any) =>
              `${c["@_r"] ?? ""}: ${c["@_t"] === "s" ? (shared[Number(c.v)] ?? "") : (c.v ?? texts(c.is, "t").join(""))}${c.f ? ` [公式: ${c.f}]` : ""}`,
          )
          .join(" | "),
      );
    }
  }
  if (excel.length) pushText(excel.join("\n"));
  for (const name of Object.keys(files)
    .filter((item) => item.startsWith("xl/media/"))
    .sort())
    pushImage(name);
  for (const name of Object.keys(files)
    .filter((name) =>
      /(?:styles|theme\d*|drawing\d*|chart\d*|workbook|presentation|notesSlide\d*)\.xml$/.test(
        name,
      ),
    )
    .sort()) {
    pushText(`## 结构与样式：${name}\n${JSON.stringify(parse(files[name]!))}`);
  }
  if (!files["word/document.xml"] && !files["ppt/presentation.xml"] && !files["xl/workbook.xml"])
    fail(400, "office_package_invalid");
  return parts;
}

export function extractFileParts(
  filename: string,
  body: Buffer,
): ExtractedPart[] {
  attachmentMime(filename, body);
  if (textExtensions.test(filename))
    return [
      {
        type: "text",
        text: new TextDecoder("utf-8", { fatal: true }).decode(body),
      },
    ];
  if (/\.pdf$/i.test(filename)) fail(400, "pdf_requires_async_parser");
  if (!officeExtensions.test(filename)) fail(400, "此文件需要模型原生读取");
  return extractOfficeParts(body);
}

export async function* extractFilePartsStream(
  filename: string,
  body: Buffer,
): AsyncGenerator<ExtractedPart> {
  attachmentMime(filename, body);
  if (/\.pdf$/i.test(filename)) {
    yield* extractPdfPages(body);
    return;
  }
  if (officeExtensions.test(filename)) {
    const native = extractOfficeParts(body);
    const pdf = await officePdf(filename, body);
    yield* extractPdfPages(pdf);
    yield {
      type: "text",
      text: "## Office 源文件文字、公式与结构（包含打印区域之外的内容）",
    };
    yield* native;
    return;
  }
  yield* extractFileParts(filename, body);
}

export async function extractFilePartsAsync(
  filename: string,
  body: Buffer,
): Promise<ExtractedPart[]> {
  const parts: ExtractedPart[] = [];
  for await (const part of extractFilePartsStream(filename, body))
    parts.push(part);
  return parts;
}

export function extractAttachmentText(filename: string, body: Buffer) {
  const parts = extractFileParts(filename, body);
  const text = parts
    .filter(
      (part): part is ExtractedPart & { type: "text" } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text) return text;
  const images = parts.filter((part) => part.type === "image").length;
  return images
    ? `文件含 ${images} 张图片，已按顺序提取。`
    : "未能从该文件提取到可复制文字。";
}
