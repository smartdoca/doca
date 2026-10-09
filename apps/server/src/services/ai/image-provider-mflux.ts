import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { fail } from "@core/shared/errors.js";
import type { ImageProviderInput, ImageProviderOutput } from "./image-provider-adapters.js";

export const mfluxModels = {
  "mflux-flux2-klein-9b-q8-v1": "flux2-klein-9b-8bit",
  "mflux-qwen-image-edit-2511-q8-v1": "qwen-image-edit-2511-8bit",
} as const;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const dimension = z.number().int().min(128).max(2048);
const runtimeSchema = z.object({ implementation: z.literal("mflux"), implementation_version: z.literal("0.22.0"), steps: z.number().int().min(1).max(50), seed: z.number().int().min(0).max(2147483647), elapsed_seconds: z.number().finite().min(0), model_revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }).strict();
const replySchema = z.object({
  version: z.literal(1), status: z.literal("completed"),
  profile: z.enum(["mflux-flux2-klein-9b-q8-v1", "mflux-qwen-image-edit-2511-q8-v1"]),
  model: z.enum(["flux2-klein-9b-8bit", "qwen-image-edit-2511-8bit"]),
  request_id: z.string().uuid(), input_sha256: z.array(sha).max(8),
  data: z.tuple([z.object({ b64_json: z.string().min(1).max(28 * 1024 * 1024), mime: z.literal("image/png"), width: dimension, height: dimension, sha256: sha }).strict()]),
  usage: z.object({ input_images: z.number().int().min(0).max(8), generated_images: z.literal(1), runtime: runtimeSchema }).strict(),
}).strict();
function invalid(): never {
  fail(502, "图片服务响应无效", { code: "image_response_invalid" });
}

export function mfluxImageProviderRequest(input: ImageProviderInput) {
  const expected = mfluxModels[input.profile.id as keyof typeof mfluxModels];
  if (!expected || input.model !== expected)
    fail(400, "所选图片模型规格无效", { code: "image_profile_invalid" });
  if (!input.prompt.trim() || input.prompt.length > 16000)
    fail(400, "图片生成请求无效", { code: "image_mflux_request_invalid" });
  const url = new URL(input.baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    fail(400, "不支持所选图片接口", { code: "image_protocol_unsupported" });
  const [width, height] = input.size.split("x").map(Number);
  return { url: input.baseUrl.replace(/\/$/, "") + "/images", body: JSON.stringify({
    version: 1, profile: input.profile.id, model: input.model, operation: input.operation, prompt: input.prompt,
    width, height, n: 1,
    images: input.images.map((image) => ({ mime: image.mime, b64_json: image.data.toString("base64"), sha256: hash(image.data) })),
  }) };
}

export async function validateMfluxImageReferences(input: ImageProviderInput, signal?: AbortSignal) {
  for (const image of input.images) {
    signal?.throwIfAborted();
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.mime))
      fail(400, "参考图片格式不支持", { code: "image_reference_format" });
    try {
      const decoder = sharp(image.data, { limitInputPixels: 25000000, failOn: "warning" });
      const metadata = await decoder.metadata();
      if (metadata.format !== image.mime.slice(6) || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height)
        throw Error("Mismatched image type");
      const { data, info } = await decoder.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let index = 3; index < data.length; index += info.channels) if (data[index] !== 255) throw Error("Transparent reference");
    } catch {
      fail(400, "参考图片无法完整解码或格式不支持", { code: "image_reference_decode" });
    }
  }
}

export function parseMfluxImageProviderOutput(body: unknown, input?: ImageProviderInput): ImageProviderOutput {
  const parsed = replySchema.safeParse(body);
  if (!parsed.success) invalid();
  const value = parsed.data, item = value.data[0];
  if (mfluxModels[value.profile] !== value.model || value.usage.input_images !== value.input_sha256.length || value.usage.runtime.steps !== (value.model === "flux2-klein-9b-8bit" ? 4 : 30)) invalid();
  const bytes = Buffer.from(item.b64_json, "base64");
  if (bytes.length < 33 || bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== item.b64_json || hash(bytes) !== item.sha256 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== item.width || bytes.readUInt32BE(20) !== item.height) invalid();
  if (input && (value.model !== input.model || value.profile !== input.profile.id || `${item.width}x${item.height}` !== input.size ||
    JSON.stringify(value.input_sha256) !== JSON.stringify(input.images.map((image) => hash(image.data))))) invalid();
  // The worker reports real image counts and runtime facts, not text token
  // usage. These numeric placeholders follow the host's existing image DTO;
  // the unmodified native usage remains authoritative about reported facts.
  return { image: { encoding: "base64", value: item.b64_json }, protocol: "mflux-native-v1", inputTokens: 0, outputTokens: 0,
    inputImages: value.usage.input_images, requestId: value.request_id, usage: value.usage };
}

export async function validateMfluxImagePixels(pixels: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    const decoder = sharp(pixels, { limitInputPixels: 2048 * 2048, failOn: "warning" });
    const metadata = await decoder.metadata();
    if (metadata.format !== "png" || (metadata.pages ?? 1) !== 1) throw Error("Expected one PNG");
    await decoder.raw().toBuffer();
  } catch { invalid(); }
  signal?.throwIfAborted();
}
