import { AppError, fail } from "@core/shared/errors.js";
import {
  validImageSize,
  type ImageModelProfile,
  type ImageOperation,
} from "@core/modules/ai/image-model-catalog.js";
import { fetchWebFile, isRetryableWebFileFailure } from "./web-fetch.js";
import { setTimeout as backoff } from "node:timers/promises";
import type { z } from "zod";
import {
  parseWanImageProviderOutput,
  validateWanImagePixels,
  validateWanImageReferences,
  wanImageProviderRequest,
} from "./image-provider-wan.js";
import { mfluxImageProviderRequest, parseMfluxImageProviderOutput, validateMfluxImageReferences, validateMfluxImagePixels } from "./image-provider-mflux.js";
import { mfluxFetch } from "./image-mflux-transport.js";
type NativeUsage = z.infer<ReturnType<typeof z.json>>;

export type ImageProviderProtocol =
  | "openai-generations"
  | "openai-edits"
  | "seedream-generations"
  | "qwen-generations"
  | "qwen-native"
  | "wan-native"
  | "mflux-native-v1";
export type ImageProviderInput = {
  profile: ImageModelProfile;
  model: string;
  baseUrl: string;
  apiKey: string;
  operation: ImageOperation;
  prompt: string;
  size: string;
  images: { data: Buffer; mime: string; filename: string }[];
  mask?: Buffer;
};
export type ImageProviderOutput = {
  image: { encoding: "base64" | "url"; value: string };
  protocol: ImageProviderProtocol;
  /** Unmodified native usage, including null or an unexpected JSON shape. */
  usage?: NativeUsage;
  inputTokens: number;
  outputTokens: number;
  inputImages?: number;
  requestId?: string;
};
const imageContentRejectionCodes = [
  "InputTextSensitiveContentDetected",
  "InputImageSensitiveContentDetected",
  "content_policy_violation",
  "ContentPolicyViolation",
  "DataInspectionFailed",
] as const;
export type ImageContentRejectionCode =
  (typeof imageContentRejectionCodes)[number];

/** Preserve the upstream status so the host can distinguish rejection from uncertainty. */
export class ImageProviderHttpError extends AppError {
  readonly contentRejectionCode?: ImageContentRejectionCode;
  constructor(
    readonly upstreamStatus: number,
    contentRejectionCode?: ImageContentRejectionCode,
  ) {
    const authentication = [401, 403].includes(upstreamStatus);
    super(
      502,
      authentication
        ? "图片模型认证失败，请检查厂商密钥"
        : contentRejectionCode
          ? "图片请求被厂商内容审核拒绝，请检查输入文字和参考图片"
          : `图片模型调用失败（HTTP ${upstreamStatus}）`,
      authentication
        ? { code: "image_auth_failed" }
        : {
            code: contentRejectionCode
              ? "image_content_rejected"
              : "image_request_failed_http",
            data: { status: upstreamStatus },
          },
    );
    this.contentRejectionCode = authentication
      ? undefined
      : contentRejectionCode;
  }
}

/** Diagnostic codes alone are public; arbitrary response text never leaves this reader. */
async function imageErrorCode(
  response: Response,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<ImageContentRejectionCode | undefined> {
  callerSignal?.throwIfAborted();
  if (!response.body) return;
  if (signal.aborted) {
    void response.body.cancel().catch(() => {});
    return;
  }
  const reader = response.body.getReader();
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<undefined>((resolve, reject) => {
      timer = setTimeout(() => resolve(undefined), 2000);
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const reading = (async () => {
      const parts: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) {
          completed = true;
          break;
        }
        bytes += part.value.byteLength;
        if (bytes > 64 * 1024) return;
        parts.push(part.value);
      }
      const body = record(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(parts),
          ),
        ),
      );
      for (const candidate of [record(body?.error)?.code, body?.code]) {
        const code = imageContentRejectionCodes.find(
          (known) => known === candidate,
        );
        if (code) return code;
      }
    })();
    const code = await Promise.race([reading, stopped]);
    callerSignal?.throwIfAborted();
    return code;
  } catch {
    // Headers already establish this HTTP rejection. A transport timeout while
    // reading diagnostics must not turn it into an unknown paid outcome.
    callerSignal?.throwIfAborted();
    return;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function imageProviderRequest(input: ImageProviderInput) {
  const { profile, images, operation } = input;
  if (!profile.operations.includes(operation))
    fail(400, "模型适配器不支持这项图片操作", {
      code: "image_operation_unsupported",
    });
  if (operation === "generate" && images.length)
    fail(400, "文生图不能传参考图，请使用参考图生图或图片编辑工具", {
      code: "image_generate_references",
    });
  if (operation !== "generate" && !images.length)
    fail(400, "参考图生图和图片编辑必须提供图片", {
      code: "image_edit_original_missing",
    });
  if (images.length > profile.maxReferences)
    fail(400, "参考图片数量超过所选模型支持范围", {
      code: "image_reference_limit",
      data: { count: profile.maxReferences },
    });
  if (!validImageSize(profile, input.size))
    fail(400, "图片尺寸超出所选模型支持范围", { code: "image_size_invalid" });
  if (input.mask && (operation !== "edit" || profile.editMechanism !== "mask"))
    fail(400, "所选模型没有原生蒙版编辑能力", {
      code: "image_mask_unsupported",
    });
  if (
    images.some(
      (image) => !image.data.length || image.data.length > 10 * 1024 * 1024,
    )
  )
    fail(400, "参考图片文件为空或超过 10 MiB", {
      code: "image_reference_file_large",
    });
  const base = input.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
  };
  const references = images.map(
    (image) => `data:${image.mime};base64,${image.data.toString("base64")}`,
  );
  const fields = {
    model: input.model,
    prompt: input.prompt,
    n: 1,
    size: input.size,
  };
  let url: string;
  let protocol: ImageProviderProtocol;
  let body: string | FormData;
  switch (profile.adapter) {
    case "mflux-native-v1": {
      protocol = "mflux-native-v1";
      const request = mfluxImageProviderRequest(input);
      url = request.url; body = request.body;
      break;
    }
    case "wan-native": {
      protocol = "wan-native";
      const request = wanImageProviderRequest(input);
      url = request.url;
      body = request.body;
      break;
    }
    case "openai-images": {
      if (operation === "generate") {
        protocol = "openai-generations";
        url = base + "/images/generations";
        body = JSON.stringify(fields);
      } else {
        protocol = "openai-edits";
        url = base + "/images/edits";
        const form = new FormData();
        for (const [key, value] of Object.entries(fields))
          form.set(key, String(value));
        for (const image of images)
          form.append(
            images.length === 1 ? "image" : "image[]",
            new Blob([new Uint8Array(image.data)], { type: image.mime }),
            image.filename,
          );
        if (input.mask)
          form.set(
            "mask",
            new Blob([new Uint8Array(input.mask)], { type: "image/png" }),
            "edit-mask.png",
          );
        body = form;
      }
      break;
    }
    case "seedream": {
      protocol = "seedream-generations";
      url = base + "/images/generations";
      body = JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        size: input.size,
        watermark: false,
        response_format: "b64_json",
        ...([
          "doubao-seedream-4-0-250828",
          "doubao-seedream-4-5-251128",
          "doubao-seedream-5-0-lite-260128",
        ].includes(profile.id)
          ? { sequential_image_generation: "disabled" }
          : {}),
        ...([
          "doubao-seedream-5-0-lite-260128",
          "doubao-seedream-5-0-pro-260628",
          "doubao-seedream-5-0-flash-260915",
        ].includes(profile.id)
          ? { output_format: "png" }
          : {}),
        ...(references.length
          ? { image: references.length === 1 ? references[0] : references }
          : {}),
      });
      break;
    }
    case "qwen-images": {
      protocol = "qwen-generations";
      url = base + "/images/generations";
      if (!/\/compatible-mode\/v1$/.test(base))
        fail(400, "千问兼容模式服务地址必须以 /compatible-mode/v1 结尾", {
          code: "image_qwen_endpoint_invalid",
        });
      body = JSON.stringify({
        ...fields,
        watermark: false,
        prompt_extend: false,
        ...(references.length
          ? { image: references.length === 1 ? references[0] : references }
          : {}),
      });
      break;
    }
    case "qwen-native": {
      protocol = "qwen-native";
      // The vendor's configured origin/region stays authoritative. Only a documented
      // API prefix is accepted; no hard-coded region or trial endpoint is substituted.
      if (!/\/(?:compatible-mode\/v1|api\/v1)$/.test(base))
        fail(400, "千问服务地址必须以 /compatible-mode/v1 或 /api/v1 结尾", {
          code: "image_qwen_endpoint_invalid",
        });
      url = base.replace(
        /\/(?:compatible-mode\/v1|api\/v1)$/,
        "/api/v1/services/aigc/multimodal-generation/generation",
      );
      body = JSON.stringify({
        model: input.model,
        input: {
          messages: [
            {
              role: "user",
              content: [
                ...references.map((image) => ({ image })),
                { text: input.prompt },
              ],
            },
          ],
        },
        parameters: {
          n: 1,
          size: input.size.replace("x", "*"),
          watermark: false,
          prompt_extend: false,
        },
      });
      break;
    }
  }
  if (typeof body === "string") headers["Content-Type"] = "application/json";
  return {
    url,
    protocol,
    init: { method: "POST", headers, body, redirect: "error" } as RequestInit,
  };
}

function reportedCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nativeQwenImages(body: Record<string, unknown>) {
  const choices = record(body.output)?.choices;
  if (!Array.isArray(choices)) return undefined;
  const images: { url: string }[] = [];
  for (const choice of choices) {
    const content = record(record(choice)?.message)?.content;
    if (!Array.isArray(content)) return undefined;
    for (const part of content) {
      const image = record(part)?.image;
      if (typeof image === "string") images.push({ url: image });
    }
  }
  return images;
}

function validImageBase64(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || value.length % 4)
    return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  // A repeated-group regexp exhausts the JS regexp stack on real multi-MiB
  // PNG responses. Validate once in constant stack space, including padding.
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    ))
      return false;
  }
  return true;
}

export function parseImageProviderOutput(
  body: unknown,
  protocol: ImageProviderProtocol,
): ImageProviderOutput {
  if (protocol === "wan-native") return parseWanImageProviderOutput(body);
  if (protocol === "mflux-native-v1") return parseMfluxImageProviderOutput(body);
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail(502, "图片服务响应无效", { code: "image_response_invalid" });
  const value = body as Record<string, unknown>;
  const images =
    protocol === "qwen-native" ? nativeQwenImages(value) : value.data;
  if (
    !Array.isArray(images) ||
    images.length !== 1 ||
    !images[0] ||
    typeof images[0] !== "object"
  )
    fail(502, "图片服务没有返回唯一图片", { code: "image_response_invalid" });
  const item = images[0] as Record<string, unknown>;
  const image = validImageBase64(item.b64_json)
    ? { encoding: "base64" as const, value: item.b64_json }
    : typeof item.url === "string" && item.url.length
      ? { encoding: "url" as const, value: item.url }
      : undefined;
  if (!image)
    fail(502, "图片服务没有返回有效图片", { code: "image_response_invalid" });
  const usage = record(value.usage);
  const inputImages = reportedCount(
    usage?.input_images ?? usage?.input_image_count,
  );
  return {
    image,
    protocol,
    ...("usage" in value ? { usage: value.usage as NativeUsage } : {}),
    inputTokens: reportedCount(usage?.input_tokens) ?? 0,
    outputTokens: reportedCount(usage?.output_tokens) ?? 0,
    ...(inputImages !== undefined ? { inputImages } : {}),
    ...(typeof value.request_id === "string"
      ? { requestId: value.request_id }
      : {}),
  };
}

/** Byte validation is awaited before a host reserves its paid attempt. */
export async function validateImageProviderInput(
  input: ImageProviderInput,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const request = imageProviderRequest(input);
  if (request.protocol === "wan-native")
    await validateWanImageReferences(input, signal);
  if (request.protocol === "mflux-native-v1")
    await validateMfluxImageReferences(input, signal);
  signal?.throwIfAborted();
  return request;
}

/** One paid submission, with no protocol fallback, resubmission, or implicit retry. */
export async function invokeImageProvider(
  input: ImageProviderInput,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(input.profile.adapter === "mflux-native-v1" ? 900000 : 180000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const request = await validateImageProviderInput(input, signal);
  const response = await (options.fetch ?? (request.protocol === "mflux-native-v1" ? mfluxFetch : fetch))(request.url, {
    ...request.init,
    signal,
  });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      options.signal?.throwIfAborted();
      throw new ImageProviderHttpError(response.status);
    }
    const code = await imageErrorCode(response, signal, options.signal);
    throw new ImageProviderHttpError(response.status, code);
  }
  if (!response.body)
    fail(502, "图片服务返回空响应", { code: "image_empty_response" });
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 28 * 1024 * 1024) {
        await reader.cancel();
        fail(502, "图片响应超过大小限制", { code: "image_response_large" });
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    fail(502, "图片服务响应无效", { code: "image_response_invalid" });
  }
  const output = request.protocol === "mflux-native-v1" ? parseMfluxImageProviderOutput(body, input) : parseImageProviderOutput(body, request.protocol);
  const requestId = response.headers.get("x-request-id");
  return !output.requestId && requestId ? { ...output, requestId } : output;
}

export async function imageProviderPixels(
  output: ImageProviderOutput,
  signal?: AbortSignal,
  download: (url: string, signal?: AbortSignal) => Promise<Buffer> = async (
    url,
    abort,
  ) => (await fetchWebFile(url, abort)).body,
) {
  signal?.throwIfAborted();
  const returnedUrl = output.image.value;
  const downloadReturnedUrl = async () => {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const pixels = await download(returnedUrl, signal);
        signal?.throwIfAborted();
        return pixels;
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt >= 2 || !isRetryableWebFileFailure(error)) throw error;
        await backoff(attempt === 0 ? 250 : 500, undefined, { signal });
      }
    }
  };
  const pixels =
    output.image.encoding === "base64"
      ? Buffer.from(output.image.value, "base64")
      : await downloadReturnedUrl();
  if (!pixels.length || pixels.length > 20 * 1024 * 1024)
    fail(502, "图片文件为空或超过大小限制", { code: "image_file_large" });
  if (output.protocol === "wan-native")
    await validateWanImagePixels(output, pixels, signal);
  if (output.protocol === "mflux-native-v1")
    await validateMfluxImagePixels(pixels, signal);
  return pixels;
}
