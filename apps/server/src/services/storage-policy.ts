import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import { open } from "node:fs/promises";

export const fileCategories = [
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "other",
] as const;
export type FileCategory = (typeof fileCategories)[number];
export const uploadLimits = {
  file: 2 * 1024 ** 3,
  asset: 20 * 1024 ** 2,
  profile: 5 * 1024 ** 2,
  multipartThreshold: 32 * 1024 ** 2,
  multipartPart: 8 * 1024 ** 2,
};
export function fileCategory(mime: string): FileCategory {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (/zip|gzip|rar|7z|tar|bzip|xz|zstd/.test(mime)) return "archive";
  if (
    mime.startsWith("text/") ||
    /pdf|officedocument|msword|ms-excel|ms-powerpoint|opendocument|rtf|json|xml|yaml/.test(
      mime,
    )
  )
    return "document";
  return "other";
}
const uuidPattern =
  "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export function objectKey(id: string, mime: string) {
  if (!new RegExp(`^${uuidPattern}$`).test(id))
    throw new Error("Invalid object ID");
  return `objects/${fileCategory(mime)}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}/original`;
}
export function derivativeKey(
  id: string,
  mime: string,
  recipe: string,
  filename: string,
) {
  if (
    !/^[a-z0-9-]{1,40}$/.test(recipe) ||
    !/^[a-z0-9-]+\.[a-z0-9]{1,8}$/.test(filename)
  )
    throw new Error("Invalid derivative path");
  return objectKey(id, mime)
    .replace(/^objects\//, "derived/")
    .replace(/original$/, `${recipe}/${filename}`);
}
export function validateObjectKey(key: string) {
  const match = new RegExp(
    `^(objects|derived)/(${fileCategories.join("|")})/([a-f0-9]{2})/([a-f0-9]{2})/(${uuidPattern})/(original|[a-z0-9-]{1,40}/[a-z0-9-]+\\.[a-z0-9]{1,8})$`,
  ).exec(key);
  if (
    !match ||
    match[3] !== match[5]!.slice(0, 2) ||
    match[4] !== match[5]!.slice(2, 4) ||
    (match[1] === "objects") !== (match[6] === "original")
  )
    throw new Error("Invalid object key");
}
export function filePolicy(mime: string, size: number) {
  const category = fileCategory(mime);
  return {
    category,
    large: size >= uploadLimits.multipartThreshold,
    upload: size >= uploadLimits.multipartThreshold ? "multipart" : "single",
    // Only implemented processors are scheduled; video/audio retain originals.
    thumbnail:
      category === "image" &&
      mime !== "image/svg+xml" &&
      size <= uploadLimits.asset,
  } as const;
}
const textMimes: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
};
function fallbackMime(sample: Buffer, filename: string) {
  // Container signatures remain useful when an archive is incomplete/unrecognized.
  if (sample.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])))
    return "application/zip";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: true,
    });
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      const ext = filename.toLowerCase().split(".").pop()!;
      if (ext === "svg" && !/<svg(?:\s|>)/i.test(text)) return "text/plain";
      return textMimes[ext] ?? "text/plain";
    }
  } catch {}
  return "application/octet-stream";
}
export async function detectBufferMime(data: Buffer, filename: string) {
  const detected = await fileTypeFromBuffer(data).catch(() => undefined);
  return detected?.mime ?? fallbackMime(data.subarray(0, 65536), filename);
}
export async function detectFileMime(path: string, filename: string) {
  const detected = await fileTypeFromFile(path).catch(() => undefined);
  if (detected) return detected.mime;
  const handle = await open(path, "r");
  try {
    const sample = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return fallbackMime(sample.subarray(0, bytesRead), filename);
  } finally {
    await handle.close();
  }
}
