import { expect, it, vi } from "vitest";
import {
  imageModelProfiles,
  imageProfileForModel,
  imageProfilesForProvider,
  imageSizeForRatio,
  supportsImageOperation,
  validImageSize,
} from "@core/modules/ai/image-model-catalog.js";
import {
  imageProviderRequest,
  parseImageProviderOutput,
  invokeImageProvider,
  imageProviderPixels,
  ImageProviderHttpError,
  type ImageProviderInput,
} from "../apps/server/src/services/ai/image-provider-adapters.js";
import { fetchWebFile } from "../apps/server/src/services/ai/web-fetch.js";
import { AppError, systemErrorReason } from "@core/shared/errors.js";

it("captures one returned URL for all temporary retries without invoking a provider again", async () => {
  const original = "https://images.example/result.png?signature=fixture";
  const output = parseImageProviderOutput(
    { data: [{ url: original }] },
    "seedream-generations",
  );
  let calls = 0;
  const download = vi.fn(async (value: string, signal?: AbortSignal) => {
    expect(value).toBe(original);
    const result = await fetchWebFile(value, signal, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => {
        calls++;
        output.image.value = "https://different.example/never-requested.png";
        return {
          status: calls < 3 ? 503 : 200,
          headers: {},
          body: calls < 3 ? Buffer.alloc(0) : Buffer.from("saved bytes"),
        };
      },
    });
    return result.body;
  });
  expect(await imageProviderPixels(output, undefined, download)).toEqual(
    Buffer.from("saved bytes"),
  );
  expect(download).toHaveBeenCalledTimes(3);
});

it("revalidates the returned URL on every retry and blocks DNS becoming private before a second GET", async () => {
  let resolutions = 0;
  const get = vi.fn(async () => ({
    status: 503,
    headers: {},
    body: Buffer.alloc(0),
  }));
  const url = "https://images.example/result.png?signature=fixture";
  const output = parseImageProviderOutput(
    { data: [{ url }] },
    "seedream-generations",
  );
  const download = vi.fn(async (value: string, signal?: AbortSignal) => {
    expect(value).toBe(url);
    return (
      await fetchWebFile(value, signal, {
        resolve: async () => [
          {
            address: ++resolutions === 1 ? "93.184.216.34" : "127.0.0.1",
            family: 4,
          },
        ],
        request: get,
      })
    ).body;
  });
  await expect(
    imageProviderPixels(output, undefined, download),
  ).rejects.toThrow("内网");
  expect(download).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledTimes(1);
});
it("cancels the bounded backoff without another GET", async () => {
  const abort = new AbortController();
  const get = vi.fn(async () => ({
    status: 503,
    headers: {},
    body: Buffer.alloc(0),
  }));
  const output = parseImageProviderOutput(
    { data: [{ url: "https://images.example/result.png" }] },
    "seedream-generations",
  );
  const pending = imageProviderPixels(
    output,
    abort.signal,
    async (url, signal) =>
      (
        await fetchWebFile(url, signal, {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          request: get,
        })
      ).body,
  );
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(get).toHaveBeenCalledTimes(1);
});
it("preserves cancellation even when a downloader completes bytes after abort", async () => {
  const abort = new AbortController();
  const output = parseImageProviderOutput(
    { data: [{ url: "https://images.example/result.png" }] },
    "seedream-generations",
  );
  const download = vi.fn(async () => {
    abort.abort();
    return Buffer.from("bytes");
  });
  await expect(
    imageProviderPixels(output, abort.signal, download),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(download).toHaveBeenCalledTimes(1);
});
it.each(["unknown", "empty", "oversized"])(
  "does not redownload %s errors or returned bytes",
  async (mode) => {
    const output = parseImageProviderOutput(
      { data: [{ url: "https://images.example/result.png" }] },
      "seedream-generations",
    );
    const download = vi.fn(async () => {
      if (mode === "unknown")
        throw new AppError(502, "HTTP 503 timeout network");
      return mode === "empty"
        ? Buffer.alloc(0)
        : Buffer.alloc(20 * 1024 * 1024 + 1);
    });
    await expect(
      imageProviderPixels(output, undefined, download),
    ).rejects.toThrow();
    expect(download).toHaveBeenCalledTimes(1);
  },
);

const profile = (id: string) =>
  imageModelProfiles.find((item) => item.id === id)!;
const image = {
  data: Buffer.from("test pixels"),
  mime: "image/png",
  filename: "reference.png",
};
const input = (
  id: string,
  patch: Partial<ImageProviderInput> = {},
): ImageProviderInput => ({
  profile: profile(id),
  model: id,
  baseUrl: "https://provider.example/v1",
  apiKey: "test-key",
  operation: "generate",
  prompt: "一株竹子",
  size: profile(id).defaultSize,
  images: [],
  ...patch,
});

it("only resolves explicitly selected models within the supported connection type", () => {
  expect(
    imageProfileForModel({
      provider: "doubao",
      imageGeneration: true,
      imageProfile: "doubao-seedream-5-0-pro-260628",
    })?.adapter,
  ).toBe("seedream");
  expect(
    imageProfileForModel({
      provider: "compatible",
      imageGeneration: true,
      imageProfile: "doubao-seedream-5-0-pro-260628",
    }),
  ).toBeUndefined();
  expect(
    imageProfileForModel({
      provider: "compatible",
      imageGeneration: true,
      imageProfile: "gpt-image-1",
    })?.adapter,
  ).toBe("openai-images");
  expect(
    imageProfileForModel({ provider: "doubao", imageGeneration: true }),
  ).toBeUndefined();
  expect(
    imageProfileForModel({
      provider: "qwen",
      imageGeneration: true,
      imageProfile: "qwen-image-future",
    }),
  ).toBeUndefined();
  expect(imageProfilesForProvider("google")).toEqual([]);
  expect(new Set(imageModelProfiles.map((item) => item.id)).size).toBe(
    imageModelProfiles.length,
  );
});

it("distinguishes unified, generation-only, and editing-only models", () => {
  const model = (imageProfile: string) => ({
    provider: "qwen",
    imageGeneration: true,
    imageProfile,
  });
  expect(supportsImageOperation(model("qwen-image-3.0-pro"), "generate")).toBe(
    true,
  );
  expect(supportsImageOperation(model("qwen-image-3.0-pro"), "reference")).toBe(
    true,
  );
  expect(supportsImageOperation(model("qwen-image-max"), "edit")).toBe(false);
  expect(supportsImageOperation(model("qwen-image-edit-max"), "generate")).toBe(
    false,
  );
  expect(supportsImageOperation(model("qwen-image-edit-max"), "edit")).toBe(
    true,
  );
});

it("all declared defaults are valid and unsupported size/ratio/source requests fail", () => {
  for (const item of imageModelProfiles)
    expect(validImageSize(item, item.defaultSize), item.id).toBe(true);
  expect(validImageSize(profile("gpt-image-1"), "1536x864")).toBe(false);
  expect(imageSizeForRatio(profile("gpt-image-1"), 16 / 9)).toBeUndefined();
  expect(imageSizeForRatio(profile("gpt-image-1"), 3 / 2)).toBe("1536x1024");
  expect(imageSizeForRatio(profile("qwen-image-3.0"), 16 / 9)).toBeDefined();
  expect(
    imageSizeForRatio(profile("qwen-image-3.0"), 1, {
      width: 2500,
      height: 2500,
    }),
  ).toBeUndefined();
  expect(validImageSize(profile("qwen-image-3.0"), "1025x1024")).toBe(false);
  expect(
    validImageSize(profile("doubao-seedream-4-5-251128"), "1024x1024"),
  ).toBe(false);
  expect(validImageSize(profile("gpt-image-2"), "512x512")).toBe(false);
  expect(validImageSize(profile("gpt-image-2"), "1024x640")).toBe(true);
  expect(
    imageSizeForRatio(profile("doubao-seedream-5-0-pro-260628"), 20),
  ).toBeUndefined();
});

it("uses the configured deployment ID without inferring its model family", () => {
  const request = imageProviderRequest(
    input("doubao-seedream-5-0-pro-260628", {
      model: "ep-user-deployment",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      operation: "edit",
      images: [image],
    }),
  );
  const body = JSON.parse(request.init.body as string);
  expect(request.url).toBe(
    "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  );
  expect(body.model).toBe("ep-user-deployment");
  expect(body.image).toBe(
    "data:image/png;base64," + image.data.toString("base64"),
  );
  expect(body.output_format).toBe("png");
  expect(body).not.toHaveProperty("n");
  expect(body).not.toHaveProperty("sequential_image_generation");
  expect(request.protocol).toBe("seedream-generations");
  const single = JSON.parse(
    imageProviderRequest(input("doubao-seedream-4-5-251128")).init
      .body as string,
  );
  expect(single.sequential_image_generation).toBe("disabled");
});

it("maps OpenAI generation to JSON and references/edit/mask to multipart", () => {
  const generated = imageProviderRequest(input("gpt-image-1"));
  expect(generated.url).toBe("https://provider.example/v1/images/generations");
  expect(JSON.parse(generated.init.body as string)).not.toHaveProperty(
    "response_format",
  );
  const edited = imageProviderRequest(
    input("gpt-image-1", {
      operation: "edit",
      images: [image, image],
      mask: Buffer.from("mask"),
    }),
  );
  expect(edited.url).toBe("https://provider.example/v1/images/edits");
  const form = edited.init.body as FormData;
  expect(form.getAll("image[]")).toHaveLength(2);
  expect(form.get("mask")).toBeInstanceOf(Blob);
  expect(edited.init.headers).not.toHaveProperty("Content-Type");
  expect(edited.init.redirect).toBe("error");
});

it("maps current unified Qwen models to the JSON generations extension", () => {
  const request = imageProviderRequest(
    input("qwen-image-3.0-pro", {
      baseUrl:
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      operation: "reference",
      images: [image, image],
    }),
  );
  expect(request.url).toContain("/compatible-mode/v1/images/generations");
  expect(JSON.parse(request.init.body as string).image).toHaveLength(2);
  expect(JSON.parse(request.init.body as string).prompt_extend).toBe(false);
  expect(request.protocol).toBe("qwen-generations");
});

it("maps split Qwen models to their documented native API without changing the region", () => {
  const request = imageProviderRequest(
    input("qwen-image-edit-max", {
      baseUrl:
        "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      operation: "edit",
      images: [image],
    }),
  );
  expect(request.url).toBe(
    "https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
  const body = JSON.parse(request.init.body as string);
  expect(body.parameters.size).toBe("1024*1024");
  expect(body.input.messages[0].content[0].image).toContain(
    "data:image/png;base64,",
  );
  expect(body.input.messages[0].content[1].text).toBe("一株竹子");
  expect(() =>
    imageProviderRequest(
      input("qwen-image-edit-max", { operation: "edit", images: [image] }),
    ),
  ).toThrow("千问服务地址");
});

it("rejects unsupported operations, images, masks and sizes before making a paid request", async () => {
  const fetcher = vi.fn();
  const cases = [
    input("qwen-image-max", { operation: "edit", images: [image] }),
    input("qwen-image-edit-max"),
    input("gpt-image-1", { images: [image] }),
    input("gpt-image-1", { operation: "edit" }),
    input("qwen-image-3.0", {
      operation: "edit",
      images: [image],
      mask: Buffer.from("mask"),
    }),
    input("qwen-image-3.0", {
      operation: "reference",
      images: Array(4).fill(image),
    }),
    input("gpt-image-1", { size: "1536x864" }),
  ];
  for (const value of cases)
    await expect(
      invokeImageProvider(value, { fetch: fetcher }),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves native usage and a reported zero reference count", () => {
  const usage = {
    input_image_count: 0,
    input_tokens: 17,
    output_tokens: 25,
    image_count: 1,
  };
  const output = parseImageProviderOutput(
    { data: [{ url: "https://images.example/output.png" }], usage },
    "qwen-generations",
  );
  expect(output.inputImages).toBe(0);
  expect(output.inputTokens).toBe(17);
  expect(output.outputTokens).toBe(25);
  expect(output.usage).toBe(usage);
  const unusual = ["native vendor fact"];
  expect(
    parseImageProviderOutput(
      { data: [{ b64_json: "eA==" }], usage: unusual },
      "openai-generations",
    ).usage,
  ).toBe(unusual);
  expect(
    parseImageProviderOutput(
      { data: [{ b64_json: "eA==" }] },
      "openai-generations",
    ).inputImages,
  ).toBeUndefined();
});

it("extracts native Qwen output and refuses empty or multiple image results", () => {
  const output = parseImageProviderOutput(
    {
      request_id: "request-1",
      output: {
        choices: [
          {
            message: {
              content: [
                { text: "done" },
                { image: "https://images.example/output.png" },
              ],
            },
          },
        ],
      },
    },
    "qwen-native",
  );
  expect(output.image).toEqual({
    encoding: "url",
    value: "https://images.example/output.png",
  });
  expect(output.requestId).toBe("request-1");
  for (const body of [
    null,
    {},
    { data: [] },
    { data: [{ b64_json: "!" }] },
    { data: [{ b64_json: "abc" }] },
    { data: [{ b64_json: "eA==" }, { b64_json: "eA==" }] },
  ]) {
    expect(() =>
      parseImageProviderOutput(body, "openai-generations"),
    ).toThrow();
  }
  for (const output of [
    { choices: {} },
    { choices: [null] },
    { choices: [{ message: { content: {} } }] },
  ]) {
    expect(() => parseImageProviderOutput({ output }, "qwen-native")).toThrow(
      "唯一图片",
    );
  }
});

it("never retries a rejected or uncertain paid request", async () => {
  const rejected = vi
    .fn()
    .mockResolvedValue(new Response("no", { status: 404 }));
  await expect(
    invokeImageProvider(input("gpt-image-1"), { fetch: rejected }),
  ).rejects.toBeInstanceOf(ImageProviderHttpError);
  expect(rejected).toHaveBeenCalledTimes(1);
  const uncertain = vi.fn().mockRejectedValue(new Error("connection lost"));
  await expect(
    invokeImageProvider(input("gpt-image-1"), { fetch: uncertain }),
  ).rejects.toThrow("connection lost");
  expect(uncertain).toHaveBeenCalledTimes(1);
});

const contentRejectionCodes = [
  "InputTextSensitiveContentDetected",
  "InputImageSensitiveContentDetected",
  "content_policy_violation",
  "ContentPolicyViolation",
  "DataInspectionFailed",
] as const;
async function rejectedImageResponse(response: Response, signal?: AbortSignal) {
  const fetcher = vi.fn().mockResolvedValue(response);
  const error = await invokeImageProvider(input("gpt-image-1"), {
    fetch: fetcher,
    signal,
  }).catch((error) => error);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST" });
  expect(error).toBeInstanceOf(ImageProviderHttpError);
  return error as ImageProviderHttpError;
}

it.each(contentRejectionCodes)(
  "recognizes only static content rejection %s from complete nested or top-level JSON without disclosing private response fields",
  async (code) => {
    for (const body of [
      {
        error: {
          code,
          message: "private-message-fixture",
          url: "https://private.example/?token=private-url-fixture",
        },
      },
      {
        code,
        message: "private-message-fixture",
        request_id: "private-request-fixture",
      },
    ]) {
      const error = await rejectedImageResponse(
        Response.json(body, {
          status: 400,
          headers: { "x-request-id": "private-header-fixture" },
        }),
      );
      expect(error).toMatchObject({
        status: 502,
        upstreamStatus: 400,
        contentRejectionCode: code,
      });
      expect(systemErrorReason(error)).toEqual({
        code: "image_content_rejected",
        data: { status: 400 },
      });
      const publicError = JSON.stringify({
        error,
        message: error.message,
        reason: systemErrorReason(error),
      });
      for (const privateText of [
        "private-message-fixture",
        "private-url-fixture",
        "private-request-fixture",
        "private-header-fixture",
      ])
        expect(publicError).not.toContain(privateText);
      expect(responseFieldNames(error)).not.toContain("body");
    }
  },
);

function responseFieldNames(error: Error) {
  return Object.getOwnPropertyNames(error);
}

it.each([
  {
    error: {
      code: "unknown_rejection",
      message: "InputTextSensitiveContentDetected private-message-fixture",
    },
  },
  { message: "content_policy_violation private-message-fixture" },
  { error: { code: ["ContentPolicyViolation"] } },
  { nested: { code: "DataInspectionFailed" } },
])(
  "keeps unknown or misplaced diagnostic codes generic without inspecting their message",
  async (body) => {
    const error = await rejectedImageResponse(
      Response.json(body, { status: 400 }),
    );
    expect(error.contentRejectionCode).toBeUndefined();
    expect(systemErrorReason(error)).toEqual({
      code: "image_request_failed_http",
      data: { status: 400 },
    });
    expect(error.message).toBe("图片模型调用失败（HTTP 400）");
    expect(JSON.stringify(error)).not.toContain("private-message-fixture");
  },
);

it.each([
  '{"error":{"code":"ContentPolicyViolation"}',
  "<html>ContentPolicyViolation private-message-fixture</html>",
  "null",
])("keeps malformed or non-object error body %s generic", async (body) => {
  const error = await rejectedImageResponse(
    new Response(body, { status: 400 }),
  );
  expect(error.contentRejectionCode).toBeUndefined();
  expect(systemErrorReason(error)).toEqual({
    code: "image_request_failed_http",
    data: { status: 400 },
  });
});

it("reads complete split JSON through the exact 64KiB bound", async () => {
  const head = '{"error":{"code":"ContentPolicyViolation","message":"';
  const tail = '"}}';
  const body = Buffer.from(
    head + "x".repeat(64 * 1024 - Buffer.byteLength(head + tail)) + tail,
  );
  expect(body).toHaveLength(64 * 1024);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(body.subarray(0, 11));
        controller.enqueue(body.subarray(11));
        controller.close();
      },
    }),
    { status: 400 },
  );
  const error = await rejectedImageResponse(response);
  expect(error.contentRejectionCode).toBe("ContentPolicyViolation");
  expect(systemErrorReason(error)).toEqual({
    code: "image_content_rejected",
    data: { status: 400 },
  });
  expect(response.body!.locked).toBe(false);
});

it("does not parse an over-limit stream even when the beginning contains a complete policy object, and cancels without waiting for a stalled cancellation", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          Buffer.from('{"error":{"code":"ContentPolicyViolation"}}'),
        );
        controller.enqueue(Buffer.alloc(64 * 1024, 32));
      },
      cancel,
    }),
    { status: 400 },
  );
  const error = await rejectedImageResponse(response);
  expect(error.contentRejectionCode).toBeUndefined();
  expect(systemErrorReason(error)).toEqual({
    code: "image_request_failed_http",
    data: { status: 400 },
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body!.locked).toBe(false);
});

it("gives incomplete diagnostics a bounded deadline and keeps the known HTTP failure without resubmission", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            Buffer.from('{"error":{"code":"ContentPolicyViolation"}}'),
          );
        },
        cancel,
      }),
      { status: 400 },
    );
    const pending = rejectedImageResponse(response);
    await vi.advanceTimersByTimeAsync(2000);
    const error = await pending;
    expect(error.contentRejectionCode).toBeUndefined();
    expect(systemErrorReason(error)).toEqual({
      code: "image_request_failed_http",
      data: { status: 400 },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it.each([401, 403])(
  "prioritizes authentication at HTTP %s and never waits for a policy diagnostic body",
  async (status) => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            Buffer.from('{"error":{"code":"ContentPolicyViolation"}}'),
          );
        },
        cancel,
      }),
      { status },
    );
    const error = await rejectedImageResponse(response);
    expect(error.contentRejectionCode).toBeUndefined();
    expect(systemErrorReason(error)).toEqual({ code: "image_auth_failed" });
    expect(error.message).toBe("图片模型认证失败，请检查厂商密钥");
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it("preserves caller cancellation during a diagnostic read and does not classify partial policy text", async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(
            Buffer.from('{"error":{"code":"ContentPolicyViolation"}}'),
          );
        },
        cancel,
      }),
      { status: 400 },
    ),
  );
  const pending = invokeImageProvider(input("gpt-image-1"), {
    fetch: fetcher,
    signal: controller.signal,
  });
  const assertion = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  controller.abort();
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("preserves a known HTTP rejection when only the provider transport timeout interrupts diagnostic reading", async () => {
  const transport = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(transport.signal);
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(
          Buffer.from('{"error":{"code":"ContentPolicyViolation"}}'),
        );
      },
      cancel,
    }),
    { status: 422 },
  );
  try {
    const pending = rejectedImageResponse(response);
    await vi.waitFor(() => expect(response.body!.locked).toBe(true));
    transport.abort(new DOMException("Transport deadline", "TimeoutError"));
    const error = await pending;
    expect(error.contentRejectionCode).toBeUndefined();
    expect(error.upstreamStatus).toBe(422);
    expect(systemErrorReason(error)).toEqual({
      code: "image_request_failed_http",
      data: { status: 422 },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  } finally {
    timeout.mockRestore();
  }
});

it("validates multi-MiB base64 in bounded stack space and still rejects malformed final padding", async () => {
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 1, 137);
  const encoded = bytes.toString("base64");
  const output = parseImageProviderOutput(
    {
      data: [{ b64_json: encoded }],
      usage: { input_images: 1, generated_images: 1 },
    },
    "seedream-generations",
  );
  expect((await imageProviderPixels(output)).equals(bytes)).toBe(true);
  expect(output.inputImages).toBe(1);
  for (const invalid of [
    encoded.slice(0, -1),
    encoded.slice(0, -4) + "A===",
    "=" + encoded.slice(1),
    encoded.slice(0, -4) + "AA-=",
  ])
    expect(() =>
      parseImageProviderOutput(
        { data: [{ b64_json: invalid }] },
        "seedream-generations",
      ),
    ).toThrow("有效图片");
});

it("downloads URL outputs separately, without forwarding the provider credential", async () => {
  const output = await invokeImageProvider(
    input("qwen-image-3.0", {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }),
    {
      fetch: vi.fn().mockResolvedValue(
        Response.json(
          {
            data: [{ url: "https://images.example/output.png" }],
            usage: { input_image_count: 2 },
          },
          { headers: { "x-request-id": "request-header-1" } },
        ),
      ),
    },
  );
  const download = vi.fn().mockResolvedValue(Buffer.from("downloaded pixels"));
  expect(await imageProviderPixels(output, undefined, download)).toEqual(
    Buffer.from("downloaded pixels"),
  );
  expect(download).toHaveBeenCalledWith(
    "https://images.example/output.png",
    undefined,
  );
  expect(output.inputImages).toBe(2);
  expect(output.requestId).toBe("request-header-1");
});

it("rejects empty or oversized reference bytes before submitting", async () => {
  const fetcher = vi.fn();
  for (const data of [Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
    await expect(
      invokeImageProvider(
        input("gpt-image-1", {
          operation: "edit",
          images: [{ ...image, data }],
        }),
        { fetch: fetcher },
      ),
    ).rejects.toThrow("10 MiB");
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("honors cancellation before submitting and rejects invalid JSON responses", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn();
  await expect(
    invokeImageProvider(input("gpt-image-1"), {
      signal: controller.signal,
      fetch: fetcher,
    }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    invokeImageProvider(input("gpt-image-1"), {
      fetch: vi.fn().mockResolvedValue(new Response("invalid JSON")),
    }),
  ).rejects.toThrow("响应无效");
});
