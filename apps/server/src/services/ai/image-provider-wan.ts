import sharp from "sharp";
import { fail } from "@core/shared/errors.js";
import {
  imageModelProfiles,
  validImageSize,
} from "@core/modules/ai/image-model-catalog.js";
import type {
  ImageProviderInput,
  ImageProviderOutput,
} from "./image-provider-adapters.js";

const profile = imageModelProfiles.find(
  (value) => value.id === "wan2.7-image-pro",
)!;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function invalidResponse(): never {
  fail(502, "图片服务响应无效", { code: "image_response_invalid" });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The configured origin is authoritative; there is exactly one native route. */
export function wanImageProviderRequest(input: ImageProviderInput) {
  if (input.model !== profile.id || input.profile.id !== profile.id)
    fail(400, "请选择支持的图片模型规格", { code: "image_profile_invalid" });
  if (!input.prompt.length || input.prompt.length > 5000)
    fail(400, "图片提示词必须为 1 到 5000 个字符，不会自动截断", {
      code: "image_request_failed",
    });
  let url: URL;
  try {
    url = new URL(input.baseUrl.replace(/\/+$/, ""));
  } catch {
    fail(400, "千问兼容模式服务地址必须以 /compatible-mode/v1 结尾", {
      code: "image_qwen_endpoint_invalid",
    });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/compatible-mode/v1"
  )
    fail(400, "千问兼容模式服务地址必须以 /compatible-mode/v1 结尾", {
      code: "image_qwen_endpoint_invalid",
    });
  url.pathname = "/api/v1/services/aigc/multimodal-generation/generation";
  return {
    url: url.href,
    body: JSON.stringify({
      model: input.model,
      input: {
        messages: [
          {
            role: "user",
            content: [
              ...input.images.map((image) => ({
                image: `data:${image.mime};base64,${image.data.toString("base64")}`,
              })),
              { text: input.prompt },
            ],
          },
        ],
      },
      // Explicit dimensions avoid the preset's last-reference aspect ratio.
      parameters: {
        size: input.size.replace("x", "*"),
        n: 1,
        enable_sequential: false,
        watermark: false,
      },
    }),
  };
}

// libvips does not decode BMP in the host runtime. Accept only an opaque,
// uncompressed 24-bit bitmap whose complete row payload matches its header.
function opaqueBmpSize(data: Buffer) {
  if (data.length < 54 || data.toString("ascii", 0, 2) !== "BM") return;
  const header = data.readUInt32LE(14);
  if (header < 40 || header > 124 || 14 + header > data.length) return;
  const width = data.readInt32LE(18),
    height = Math.abs(data.readInt32LE(22));
  const offset = data.readUInt32LE(10);
  if (
    width <= 0 ||
    !height ||
    data.readUInt32LE(2) !== data.length ||
    data.readUInt16LE(26) !== 1 ||
    data.readUInt16LE(28) !== 24 ||
    data.readUInt32LE(30) !== 0 ||
    offset < 14 + header
  )
    return;
  const bytes = Math.ceil((width * 3) / 4) * 4 * height;
  const reported = data.readUInt32LE(34);
  if (offset + bytes !== data.length || (reported !== 0 && reported !== bytes))
    return;
  return { width, height };
}

function supportedReferenceSize(value: { width: number; height: number }) {
  return (
    value.width >= 240 &&
    value.height >= 240 &&
    value.width <= 8000 &&
    value.height <= 8000 &&
    Math.max(value.width / value.height, value.height / value.width) <= 8
  );
}

/** Validate actual transport bytes before any provider submission. */
export async function validateWanImageReferences(
  input: ImageProviderInput,
  signal?: AbortSignal,
) {
  for (const image of input.images) {
    signal?.throwIfAborted();
    let dimensions: { width: number; height: number } | undefined;
    if (image.mime === "image/bmp") {
      dimensions = opaqueBmpSize(image.data);
    } else {
      try {
        const meta = await sharp(image.data, {
          limitInputPixels: 8000 * 8000,
        }).metadata();
        const mime = {
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        };
        if (
          image.mime === mime[meta.format as keyof typeof mime] &&
          !meta.hasAlpha &&
          (meta.pages ?? 1) === 1 &&
          supportedReferenceSize(meta.autoOrient)
        ) {
          await sharp(image.data, { limitInputPixels: 8000 * 8000 }).stats();
          dimensions = meta.autoOrient;
        }
      } catch {
        // Invalid bytes never become a best-effort input or an API trial.
      }
    }
    signal?.throwIfAborted();
    if (!dimensions || !supportedReferenceSize(dimensions))
      fail(400, "参考图片格式、透明通道、尺寸或比例不受所选模型支持", {
        code: "image_reference_size_unsupported",
      });
  }
}

/** Strict Wan success, without Qwen response aliases or missing-usage defaults. */
export function parseWanImageProviderOutput(
  body: unknown,
): ImageProviderOutput {
  const value = record(body),
    output = record(value?.output),
    usage = record(value?.usage);
  if (
    !value ||
    "code" in value ||
    output?.finished !== true ||
    !Array.isArray(output.choices) ||
    output.choices.length !== 1
  )
    invalidResponse();
  const choice = record(output.choices[0]),
    message = record(choice?.message);
  if (
    choice?.finish_reason !== "stop" ||
    message?.role !== "assistant" ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  )
    invalidResponse();
  const part = record(message.content[0]);
  if (part?.type !== "image" || typeof part.image !== "string")
    invalidResponse();
  let imageUrl: URL;
  try {
    imageUrl = new URL(part.image);
  } catch {
    invalidResponse();
  }
  if (
    !["http:", "https:"].includes(imageUrl.protocol) ||
    imageUrl.username ||
    imageUrl.password ||
    imageUrl.hash
  )
    invalidResponse();
  if (
    !usage ||
    usage.image_count !== 1 ||
    !count(usage.input_tokens) ||
    !count(usage.output_tokens) ||
    !count(usage.total_tokens) ||
    !Number.isSafeInteger(usage.input_tokens + usage.output_tokens) ||
    usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
    typeof usage.size !== "string" ||
    !/^\d{2,4}\*\d{2,4}$/.test(usage.size) ||
    !validImageSize(profile, usage.size.replace("*", "x")) ||
    typeof value.request_id !== "string" ||
    !value.request_id.trim()
  )
    invalidResponse();
  if ("input_images" in usage && !count(usage.input_images)) invalidResponse();
  return {
    protocol: "wan-native",
    image: { encoding: "url", value: part.image },
    usage: value.usage as ImageProviderOutput["usage"],
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(count(usage.input_images) ? { inputImages: usage.input_images } : {}),
    requestId: value.request_id,
  };
}

export async function validateWanImagePixels(
  output: ImageProviderOutput,
  pixels: Buffer,
  signal?: AbortSignal,
) {
  const usage = record(output.usage);
  if (!pixels.subarray(0, pngSignature.length).equals(pngSignature))
    invalidResponse();
  try {
    const meta = await sharp(pixels, {
      limitInputPixels: 2048 * 2048,
    }).metadata();
    if (
      meta.format !== "png" ||
      (meta.pages ?? 1) !== 1 ||
      `${meta.width}*${meta.height}` !== usage?.size
    )
      invalidResponse();
    await sharp(pixels, { limitInputPixels: 2048 * 2048 }).stats();
  } catch {
    invalidResponse();
  }
  signal?.throwIfAborted();
}
