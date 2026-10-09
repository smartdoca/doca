import sharp from "sharp";
import { fail } from "@core/shared/errors.js";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function localPNGBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value);
  if (typeof value === "string" && value.length > 0 && value.length % 4 === 0) {
    // A repeated-group regexp can exhaust the stack on a native 1MP PNG.
    // Check the alphabet and terminal padding in one bounded linear pass.
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const end = value.length - padding;
    for (let index = 0; index < end; index++) {
      const code = value.charCodeAt(index);
      if (!(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      ))
        fail(422, "原生细节图必须是本地PNG字节，不读取远程地址或转换数据");
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") === value) return bytes;
  }
  fail(422, "原生细节图必须是本地PNG字节，不读取远程地址或转换数据");
}
async function validateNativePNG(part: any) {
  if (
    part.type !== "file" ||
    part.mediaType !== "image/png" ||
    part.data?.type !== "data"
  )
    fail(422, "运行时绑定的细节图必须是本地PNG文件");
  const bytes = localPNGBytes(part.data.data);
  if (bytes.length < 20 || !bytes.subarray(0, 8).equals(pngSignature))
    fail(422, "运行时绑定的细节图不是完整PNG");
  // APNG control/data chunks are rejected independently of decoder support.
  let offset = 8,
    complete = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      next = offset + 12 + length,
      type = bytes.toString("ascii", offset + 4, offset + 8);
    if (next > bytes.length || ["acTL", "fcTL", "fdAT"].includes(type))
      fail(422, "原生细节图必须是完整单帧PNG");
    if (type === "IEND") {
      if (length !== 0 || next !== bytes.length)
        fail(422, "原生细节图必须是完整单帧PNG");
      complete = true;
      break;
    }
    offset = next;
  }
  if (!complete) fail(422, "原生细节图必须是完整单帧PNG");
  try {
    const image = sharp(bytes, {
      limitInputPixels: 1_000_000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 1024 ||
      metadata.height > 1024 ||
      metadata.width * metadata.height > 1_000_000 ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation !== undefined && metadata.orientation !== 1)
    )
      fail(422, "原生细节图必须为单帧PNG，每边最多1024且不超过100万像素");
    // Decode the complete frame to reject corrupt/truncated IDAT data. The
    // decoded bytes are never substituted for the bound transport bytes.
    await image.raw().toBuffer();
  } catch {
    fail(422, "原生细节图无效或超过1024边/100万像素限制，本次不缩小或转码");
  }
}

/** Complete visual preview for model transport; durable source pixels remain lossless. */
export async function modelImage(data: Buffer) {
  const image = await sharp(data, { limitInputPixels: 25000000 })
    .rotate()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#fff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { data: image, mime: "image/jpeg" };
}

/** Keep image transport bounded even when resuming a checkpoint with full PNGs. */
export async function modelPromptImages(
  prompt: any[],
  preservedData?: ReadonlySet<object>,
) {
  return Promise.all(
    prompt.map(async (message) => {
      if (message.role !== "user" || !Array.isArray(message.content))
        return message;
      return {
        ...message,
        content: await Promise.all(
          message.content.map(async (part: any) => {
            if (
              part.data !== null &&
              typeof part.data === "object" &&
              preservedData?.has(part.data)
            ) {
              await validateNativePNG(part);
              return part;
            }
            if (
              part.type !== "file" ||
              !part.mediaType?.startsWith("image/") ||
              part.data?.type !== "data"
            )
              return part;
            const raw =
              typeof part.data.data === "string"
                ? Buffer.from(part.data.data, "base64")
                : Buffer.from(part.data.data);
            if (part.mediaType === "image/jpeg" && raw.length < 512000)
              return part;
            const preview = await modelImage(raw);
            return {
              ...part,
              mediaType: preview.mime,
              data: { type: "data", data: preview.data },
            };
          }),
        ),
      };
    }),
  );
}
