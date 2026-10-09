import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { beforeAll, expect, it, vi } from "vitest";
import {
  imageModelProfiles,
  defaultImageProfile,
  imageProfileForModel,
  imageProfilesForProvider,
  imageSizeForRatio,
  supportsImageOperation,
  validImageSize,
} from "@core/modules/ai/image-model-catalog.js";
import { aiConfig, aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import {
  imageProviderPixels,
  imageProviderRequest,
  invokeImageProvider,
  validateImageProviderInput,
  parseImageProviderOutput,
  ImageProviderHttpError,
  type ImageProviderInput,
} from "../apps/server/src/services/ai/image-provider-adapters.js";
import { rawImageCandidateSchema } from "../apps/server/src/services/ai/image-candidates.js";
import { openTestDatabase } from "./database.js";

const profileId = "wan2.7-image-pro";
const protocol = "wan-native" as const;
const origin = "https://workspace.ap-southeast-1.maas.aliyuncs.com";
const outputUrl =
  "https://images.example/opaque-object?signature=isolated-test";
const referenceCap = 10 * 1024 * 1024;
type ReferenceImage = ImageProviderInput["images"][number];
let png: ReferenceImage, jpeg: ReferenceImage, webp: ReferenceImage;
let outputPng: Buffer;

const profile = () => imageModelProfiles.find((item) => item.id === profileId)!;
const input = (
  patch: Partial<ImageProviderInput> = {},
): ImageProviderInput => ({
  profile: profile(),
  model: profileId,
  baseUrl: origin + "/compatible-mode/v1",
  apiKey: "isolated-wan-only",
  operation: "generate",
  prompt: "仅修改原页的指定人物，保留其余内容。",
  size: "2048x2048",
  images: [],
  ...patch,
});

async function raster(
  width = 240,
  height = 240,
  format: "png" | "jpeg" | "webp" = "png",
  alpha?: number,
): Promise<ReferenceImage> {
  const data = await sharp({
    create: {
      width,
      height,
      channels: alpha === undefined ? 3 : 4,
      background: {
        r: 72,
        g: 105,
        b: 137,
        ...(alpha === undefined ? {} : { alpha }),
      },
    },
  })
    .toFormat(format)
    .toBuffer();
  return { data, mime: `image/${format}`, filename: `reference.${format}` };
}

/** A complete uncompressed 24-bit BMP; this format has no Alpha channel. */
function bmp(width = 240, height = 240): ReferenceImage {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(54 + stride * height, 137);
  data.fill(0, 0, 54);
  data.write("BM", 0);
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(stride * height, 34);
  return { data, mime: "image/bmp", filename: "reference.bmp" };
}

function success() {
  return {
    request_id: "isolated-wan-request",
    output: {
      finished: true,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "image", image: outputUrl }],
          },
        },
      ],
    },
    usage: {
      image_count: 1,
      input_tokens: 12,
      output_tokens: 34,
      total_tokens: 46,
      size: "2048*2048",
      vendor_detail: { native_fact: "preserve exactly" },
    },
  };
}
type Success = ReturnType<typeof success>;

beforeAll(async () => {
  [png, jpeg, webp] = await Promise.all([
    raster(),
    raster(240, 240, "jpeg"),
    raster(240, 240, "webp"),
  ]);
  outputPng = (await raster(2048, 2048)).data;
});

it("selects Wan only through its explicit Qwen profile and exposes all three image operations", () => {
  const selected = imageProfileForModel({
    provider: "qwen",
    imageGeneration: true,
    imageProfile: profileId,
  });
  expect(selected).toBe(profile());
  expect(selected).toMatchObject({
    id: profileId,
    adapter: "wan-native",
    providers: ["qwen"],
    operations: ["generate", "reference", "edit"],
    maxReferences: 8,
    defaultSize: "2048x2048",
    limits: { minPixels: 768 * 768, maxPixels: 2048 * 2048, maxRatio: 8 },
  });
  expect(imageProfilesForProvider("qwen")).toContain(selected);
  for (const provider of ["compatible", "openai", "doubao", "google"])
    expect(
      imageProfileForModel({
        provider,
        imageGeneration: true,
        imageProfile: profileId,
      }),
    ).toBeUndefined();
  expect(
    imageProfileForModel({ provider: "qwen", imageGeneration: true }),
  ).toBeUndefined();
  expect(defaultImageProfile("qwen", profileId)).toBeUndefined();
  expect(defaultImageProfile("qwen", "qwen-image-3.0-pro")?.id).toBe(
    "qwen-image-3.0-pro",
  );
  expect(defaultImageProfile("qwen", "opaque-existing-model")?.id).toBe(
    "qwen-image-3.0-pro",
  );
  expect(
    imageProfileForModel({
      provider: "qwen",
      imageGeneration: false,
      imageProfile: profileId,
    }),
  ).toBeUndefined();
  const model = {
    provider: "qwen",
    imageGeneration: true,
    imageProfile: profileId,
  };
  expect(supportsImageOperation(model, "generate")).toBe(true);
  expect(supportsImageOperation(model, "reference")).toBe(true);
  expect(supportsImageOperation(model, "edit")).toBe(true);
});

it("requires an explicit Wan config profile and preserves the stored configuration and revision on rejection", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("isolated config test forbids provider calls"),
    );
  try {
    const original = {
      ...aiDefaults,
      imageModel: "isolated-image",
      vendors: [
        {
          id: "isolated-vendor",
          name: "Isolated",
          provider: "qwen" as const,
          baseUrl: origin + "/compatible-mode/v1",
          apiKey: "isolated-config-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "isolated-image",
          vendorId: "isolated-vendor",
          model: "qwen-image-3.0-pro",
          alias: "Isolated image",
          enabled: true,
          tools: false,
          maxInput: 32000,
          maxOutput: 1000,
          imageGeneration: true,
          imageProfile: "qwen-image-3.0-pro",
          imageSize: "2048x2048",
        },
      ],
    };
    await saveAIConfig(db, original, 0);
    const before = await aiConfig(db);
    const storedBefore = await db
      .selectFrom("account_settings")
      .selectAll()
      .where("id", "=", "ai")
      .executeTakeFirstOrThrow();
    const missing = {
      ...original,
      models: original.models.map((model) => ({
        ...model,
        model: profileId,
        imageProfile: undefined,
      })),
    };
    await expect(saveAIConfig(db, missing, before.revision)).rejects.toThrow(
      "支持清单",
    );
    expect(await aiConfig(db)).toEqual(before);
    expect(
      await db
        .selectFrom("account_settings")
        .selectAll()
        .where("id", "=", "ai")
        .executeTakeFirstOrThrow(),
    ).toEqual(storedBefore);
    const explicit = {
      ...original,
      models: original.models.map((model) => ({
        ...model,
        model: profileId,
        imageProfile: profileId,
      })),
    };
    const saved = await saveAIConfig(db, explicit, before.revision);
    expect(saved.revision).toBe(before.revision + 1);
    expect(saved.models[0]).toMatchObject({
      model: profileId,
      imageProfile: profileId,
      imageSize: "2048x2048",
    });
    expect((await aiConfig(db)).models[0]).toMatchObject({
      model: profileId,
      imageProfile: profileId,
    });
    expect(await db.selectFrom("ai_calls").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("ai_operations").select("id").execute()).toEqual(
      [],
    );
    expect(provider.mock.calls.length).toBe(0);
  } finally {
    provider.mockRestore();
    await db.destroy();
  }
});

it("enforces the 2K area and ratio bounds without requiring a size step", () => {
  for (const size of [
    "768x768",
    "2048x2048",
    "4096x1024",
    "4096x512",
    "1025x1024",
  ])
    expect(validImageSize(profile(), size), size).toBe(true);
  for (const size of [
    "767x768",
    "2049x2048",
    "4096x4096",
    "4097x512",
    "2048*2048",
  ])
    expect(validImageSize(profile(), size), size).toBe(false);
  expect(imageSizeForRatio(profile(), 8)).toBeDefined();
  expect(imageSizeForRatio(profile(), 8.01)).toBeUndefined();
});

it("maps the configured origin and explicit Wan model into a single native POST with references before text", async () => {
  const images = [png, jpeg, webp, bmp()];
  const fetcher = vi.fn().mockResolvedValue(Response.json(success()));
  const output = await invokeImageProvider(
    input({
      operation: "reference",
      images,
    }),
    { fetch: fetcher },
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe(
    origin + "/api/v1/services/aigc/multimodal-generation/generation",
  );
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  expect(init.headers).toMatchObject({
    Authorization: "Bearer isolated-wan-only",
    "Content-Type": "application/json",
  });
  expect(JSON.parse(init.body)).toEqual({
    model: profileId,
    input: {
      messages: [
        {
          role: "user",
          content: [
            ...images.map((image) => ({
              image: `data:${image.mime};base64,${image.data.toString("base64")}`,
            })),
            { text: input().prompt },
          ],
        },
      ],
    },
    parameters: {
      n: 1,
      size: "2048*2048",
      enable_sequential: false,
      watermark: false,
    },
  });
  expect(output.protocol).toBe(protocol);
  expect(output).not.toHaveProperty("inputImages");
});

it("keeps synchronous request construction independent of async reference decoding", async () => {
  const invalidPixels = { ...png, data: Buffer.from("not image pixels") };
  expect(
    imageProviderRequest(
      input({ operation: "reference", images: [invalidPixels] }),
    ).protocol,
  ).toBe(protocol);
  await expect(
    validateImageProviderInput(
      input({ operation: "reference", images: [invalidPixels] }),
    ),
  ).rejects.toThrow();
  const valid = await validateImageProviderInput(
    input({ operation: "reference", images: [png] }),
  );
  expect(valid.protocol).toBe(protocol);
  expect(valid.url).toBe(
    origin + "/api/v1/services/aigc/multimodal-generation/generation",
  );
  const fetcher = vi.fn();
  await expect(
    invokeImageProvider(
      input({ operation: "reference", images: [invalidPixels] }),
      { fetch: fetcher },
    ),
  ).rejects.toThrow();
  expect(fetcher.mock.calls.length).toBe(0);
});

it.each([
  "ftp://workspace.example/compatible-mode/v1",
  "https://workspace.example/api/v1",
  "https://workspace.example/v1",
  "https://workspace.example/nested/compatible-mode/v1",
  "https://workspace.example/compatible-mode/v1?region=other",
  "https://workspace.example/compatible-mode/v1#other",
  "https://user:password@workspace.example/compatible-mode/v1",
])(
  "rejects an unsupported configured Wan endpoint before POST: %s",
  async (baseUrl) => {
    const fetcher = vi.fn();
    await expect(
      invokeImageProvider(input({ baseUrl }), { fetch: fetcher }),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBe(0);
  },
);

it("accepts exactly eight references for reference/edit and rejects excess inputs, masks and 4K before POST", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(success()));
  await invokeImageProvider(
    input({ operation: "reference", images: Array(8).fill(png) }),
    { fetch: fetcher },
  );
  expect(
    JSON.parse(fetcher.mock.calls[0]![1].body).input.messages[0].content,
  ).toHaveLength(9);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const edit = vi.fn().mockResolvedValue(Response.json(success()));
  await invokeImageProvider(
    input({ operation: "edit", images: Array(8).fill(png) }),
    { fetch: edit },
  );
  expect(edit).toHaveBeenCalledTimes(1);
  for (const patch of [
    { operation: "reference" as const, images: Array(9).fill(png) },
    { operation: "edit" as const, images: Array(9).fill(png) },
    { operation: "reference" as const, images: [png], mask: png.data },
    { operation: "edit" as const, images: [png], mask: png.data },
    { operation: "generate" as const, images: [png] },
    { operation: "reference" as const, images: [] },
    { operation: "edit" as const, images: [] },
    { size: "4096x4096" },
    { operation: "reference" as const, images: [png], size: "4096x4096" },
    { operation: "edit" as const, images: [png], size: "4096x4096" },
    { model: "wan-user-deployment" },
  ]) {
    const rejected = vi.fn().mockResolvedValue(Response.json(success()));
    await expect(
      invokeImageProvider(input(patch), { fetch: rejected }),
    ).rejects.toThrow();
    expect(rejected.mock.calls.length).toBe(0);
  }
});

it.each(["甲".repeat(5000), " " + "甲".repeat(4998) + " ", "😀".repeat(2500)])(
  "sends the complete final 5000 UTF-16 units without truncation or normalization",
  async (prompt) => {
    expect(prompt.length).toBe(5000);
    const fetcher = vi.fn().mockResolvedValue(Response.json(success()));
    await invokeImageProvider(input({ prompt }), { fetch: fetcher });
    expect(
      JSON.parse(fetcher.mock.calls[0]![1].body).input.messages[0].content,
    ).toEqual([{ text: prompt }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each(["甲".repeat(5001), "😀".repeat(2500) + "甲"])(
  "rejects a final prompt over 5000 UTF-16 units before POST instead of truncating it",
  async (prompt) => {
    const fetcher = vi.fn();
    await expect(
      invokeImageProvider(input({ prompt }), { fetch: fetcher }),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBe(0);
  },
);

it.each([
  [240, 240],
  [240, 1920],
  [1920, 240],
  [8000, 1000],
  [1000, 8000],
])(
  "accepts reference dimension boundary %ix%i with no Alpha channel",
  async (width, height) => {
    const image = await raster(width, height);
    const fetcher = vi.fn().mockResolvedValue(Response.json(success()));
    await invokeImageProvider(
      input({ operation: "reference", images: [image] }),
      { fetch: fetcher },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [239, 240],
  [240, 239],
  [8001, 1100],
  [1100, 8001],
  [240, 1921],
  [1921, 240],
])("rejects reference dimension %ix%i before POST", async (width, height) => {
  const image = await raster(width, height);
  const fetcher = vi.fn();
  await expect(
    invokeImageProvider(input({ operation: "reference", images: [image] }), {
      fetch: fetcher,
    }),
  ).rejects.toThrow();
  expect(fetcher.mock.calls.length).toBe(0);
});

it.each([0.5, 1])(
  "rejects a PNG Alpha channel even when alpha=%s before POST",
  async (alpha) => {
    const image = await raster(240, 240, "png", alpha);
    expect((await sharp(image.data).metadata()).hasAlpha).toBe(true);
    const fetcher = vi.fn();
    await expect(
      invokeImageProvider(input({ operation: "reference", images: [image] }), {
        fetch: fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBe(0);
  },
);

it("rejects WebP Alpha and malformed BMP payloads before POST, while accepting an opaque top-down BMP", async () => {
  const translucent = await raster(240, 240, "webp", 0.5);
  expect((await sharp(translucent.data).metadata()).hasAlpha).toBe(true);
  const incomplete = bmp();
  incomplete.data = incomplete.data.subarray(0, incomplete.data.length - 1);
  const alphaBitmap = bmp();
  alphaBitmap.data.writeUInt16LE(32, 28);
  const compressed = bmp();
  compressed.data.writeUInt32LE(1, 30);
  const badSize = bmp();
  badSize.data.writeUInt32LE(badSize.data.length - 1, 2);
  for (const image of [
    translucent,
    incomplete,
    alphaBitmap,
    compressed,
    badSize,
  ]) {
    const fetcher = vi.fn().mockResolvedValue(Response.json(success()));
    await expect(
      invokeImageProvider(input({ operation: "reference", images: [image] }), {
        fetch: fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBe(0);
  }
  const topDown = bmp(241, 240);
  topDown.data.writeInt32LE(-240, 22);
  const accepted = vi.fn().mockResolvedValue(Response.json(success()));
  await invokeImageProvider(
    input({ operation: "reference", images: [topDown] }),
    { fetch: accepted },
  );
  expect(accepted).toHaveBeenCalledTimes(1);
});

it("rejects unsupported actual reference formats and retains the exact 10 MiB host cap", async () => {
  const gif = await sharp(png.data).gif().toBuffer();
  const oversized = Buffer.alloc(referenceCap + 1);
  const fetcher = vi.fn();
  for (const image of [
    { data: gif, mime: "image/gif", filename: "reference.gif" },
    { data: gif, mime: "image/png", filename: "disguised.png" },
    { ...jpeg, mime: "image/png", filename: "wrong-mime.png" },
    { ...png, data: Buffer.alloc(0) },
    { ...png, data: oversized },
  ])
    await expect(
      invokeImageProvider(input({ operation: "reference", images: [image] }), {
        fetch: fetcher,
      }),
    ).rejects.toThrow();
  expect(fetcher.mock.calls.length).toBe(0);
  const exactCap = {
    ...png,
    data: Buffer.concat([
      png.data,
      Buffer.alloc(referenceCap - png.data.length),
    ]),
  };
  expect(exactCap.data.length).toBe(referenceCap);
  fetcher.mockResolvedValue(Response.json(success()));
  await invokeImageProvider(
    input({ operation: "reference", images: [exactCap] }),
    { fetch: fetcher },
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("preserves native Wan usage and opaque signed output URLs without inventing a reference count", () => {
  const body = success();
  const output = parseImageProviderOutput(body, protocol);
  expect(output.image).toEqual({ encoding: "url", value: outputUrl });
  expect(output.usage).toBe(body.usage);
  expect(output.inputTokens).toBe(12);
  expect(output.outputTokens).toBe(34);
  expect(output.requestId).toBe(body.request_id);
  expect(output).not.toHaveProperty("inputImages");
  body.usage.input_tokens = 0;
  body.usage.output_tokens = 0;
  body.usage.total_tokens = 0;
  expect(parseImageProviderOutput(body, protocol)).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
  });
});

const invalidReplies: { name: string; mutate: (body: Success) => unknown }[] = [
  {
    name: "error code beside a complete image",
    mutate: (body) => ({ ...body, code: "InvalidParameter" }),
  },
  {
    name: "upstream error",
    mutate: () => ({
      code: "InvalidParameter",
      message: "isolated rejection",
      request_id: "failed-request",
    }),
  },
  {
    name: "unfinished output",
    mutate: (body) => ({
      ...body,
      output: { ...body.output, finished: false },
    }),
  },
  {
    name: "missing finished fact",
    mutate: (body) => {
      const value: any = body;
      delete value.output.finished;
      return value;
    },
  },
  {
    name: "two choices",
    mutate: (body) => ({
      ...body,
      output: {
        ...body.output,
        choices: [...body.output.choices, ...body.output.choices],
      },
    }),
  },
  {
    name: "empty choices",
    mutate: (body) => ({ ...body, output: { ...body.output, choices: [] } }),
  },
  {
    name: "non-stop choice",
    mutate: (body) => {
      body.output.choices[0]!.finish_reason = "length";
      return body;
    },
  },
  {
    name: "non-assistant message",
    mutate: (body) => {
      body.output.choices[0]!.message.role = "user";
      return body;
    },
  },
  {
    name: "two image parts",
    mutate: (body) => {
      body.output.choices[0]!.message.content.push({
        type: "image",
        image: outputUrl,
      });
      return body;
    },
  },
  {
    name: "text beside image",
    mutate: (body) => {
      const value: any = body;
      value.output.choices[0].message.content.push({
        type: "text",
        text: "done",
      });
      return value;
    },
  },
  {
    name: "missing image type",
    mutate: (body) => {
      const value: any = body;
      delete value.output.choices[0].message.content[0].type;
      return value;
    },
  },
  {
    name: "wrong image type",
    mutate: (body) => {
      body.output.choices[0]!.message.content[0]!.type = "text";
      return body;
    },
  },
  {
    name: "relative output URL",
    mutate: (body) => {
      body.output.choices[0]!.message.content[0]!.image = "/output.png";
      return body;
    },
  },
  {
    name: "data output URL",
    mutate: (body) => {
      body.output.choices[0]!.message.content[0]!.image =
        "data:image/png;base64,eA==";
      return body;
    },
  },
  {
    name: "FTP output URL",
    mutate: (body) => {
      body.output.choices[0]!.message.content[0]!.image =
        "ftp://images.example/image.png";
      return body;
    },
  },
  {
    name: "missing native usage",
    mutate: (body) => {
      const value: any = body;
      delete value.usage;
      return value;
    },
  },
  {
    name: "two billed images",
    mutate: (body) => {
      body.usage.image_count = 2;
      return body;
    },
  },
  {
    name: "missing image count",
    mutate: (body) => {
      const value: any = body;
      delete value.usage.image_count;
      return value;
    },
  },
  {
    name: "negative input token fact",
    mutate: (body) => {
      body.usage.input_tokens = -1;
      return body;
    },
  },
  {
    name: "fractional output token fact",
    mutate: (body) => {
      body.usage.output_tokens = 1.5;
      return body;
    },
  },
  {
    name: "missing input tokens",
    mutate: (body) => {
      const value: any = body;
      delete value.usage.input_tokens;
      return value;
    },
  },
  {
    name: "missing output tokens",
    mutate: (body) => {
      const value: any = body;
      delete value.usage.output_tokens;
      return value;
    },
  },
  {
    name: "missing total tokens",
    mutate: (body) => {
      const value: any = body;
      delete value.usage.total_tokens;
      return value;
    },
  },
  {
    name: "inconsistent total tokens",
    mutate: (body) => {
      body.usage.total_tokens = 47;
      return body;
    },
  },
  {
    name: "wrong native size separator",
    mutate: (body) => {
      body.usage.size = "2048x2048";
      return body;
    },
  },
  {
    name: "over-2K native size",
    mutate: (body) => {
      body.usage.size = "2049*2048";
      return body;
    },
  },
  {
    name: "below-minimum native size",
    mutate: (body) => {
      body.usage.size = "767*768";
      return body;
    },
  },
  {
    name: "native ratio above eight",
    mutate: (body) => {
      body.usage.size = "4097*512";
      return body;
    },
  },
  {
    name: "missing native size",
    mutate: (body) => {
      const value: any = body;
      delete value.usage.size;
      return value;
    },
  },
  {
    name: "empty request identity",
    mutate: (body) => {
      body.request_id = "";
      return body;
    },
  },
  {
    name: "missing body request identity despite header",
    mutate: (body) => {
      const value: any = body;
      delete value.request_id;
      return value;
    },
  },
  {
    name: "unsafe input token integer",
    mutate: (body) => {
      body.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1;
      return body;
    },
  },
  {
    name: "non-numeric total tokens",
    mutate: (body) => {
      const value: any = body;
      value.usage.total_tokens = "46";
      return value;
    },
  },
  {
    name: "output URL with credentials",
    mutate: (body) => {
      body.output.choices[0]!.message.content[0]!.image =
        "https://user:password@images.example/object";
      return body;
    },
  },
  {
    name: "output URL with a fragment",
    mutate: (body) => {
      body.output.choices[0]!.message.content[0]!.image =
        "https://images.example/object#result";
      return body;
    },
  },
];

it.each(invalidReplies)(
  "rejects $name after exactly one POST without fallback or resubmission",
  async ({ mutate }) => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json(mutate(success()), {
        headers: { "x-request-id": "must-not-fill-missing-wan-body-id" },
      }),
    );
    await expect(
      invokeImageProvider(input(), { fetch: fetcher }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("never retries a rejected or uncertain Wan POST, and cancellation prevents submission", async () => {
  const rejected = vi
    .fn()
    .mockResolvedValue(new Response("isolated rejection", { status: 400 }));
  await expect(
    invokeImageProvider(input(), { fetch: rejected }),
  ).rejects.toBeInstanceOf(ImageProviderHttpError);
  expect(rejected).toHaveBeenCalledTimes(1);
  const uncertain = vi
    .fn()
    .mockRejectedValue(new Error("isolated connection lost"));
  await expect(
    invokeImageProvider(input(), { fetch: uncertain }),
  ).rejects.toThrow("isolated connection lost");
  expect(uncertain).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  const cancelled = vi.fn();
  await expect(
    validateImageProviderInput(
      input({ operation: "reference", images: [png] }),
      controller.signal,
    ),
  ).rejects.toThrow();
  await expect(
    invokeImageProvider(input({ operation: "reference", images: [png] }), {
      fetch: cancelled,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(cancelled.mock.calls.length).toBe(0);
});

it("downloads an opaque URL separately and verifies its native PNG bytes before returning pixels", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(success()));
  const output = await invokeImageProvider(input(), { fetch: fetcher });
  const download = vi.fn().mockResolvedValue(outputPng);
  expect(await imageProviderPixels(output, undefined, download)).toBe(
    outputPng,
  );
  expect(download).toHaveBeenCalledWith(outputUrl, undefined);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenCalledTimes(1);
  const jpegBytes = (await raster(2048, 2048, "jpeg")).data;
  await expect(
    imageProviderPixels(
      output,
      undefined,
      vi.fn().mockResolvedValue(jpegBytes),
    ),
  ).rejects.toThrow();
  const truncated = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  await expect(
    imageProviderPixels(
      output,
      undefined,
      vi.fn().mockResolvedValue(truncated),
    ),
  ).rejects.toThrow();
  const wrongSize = (await raster(1024, 1024)).data;
  await expect(
    imageProviderPixels(
      output,
      undefined,
      vi.fn().mockResolvedValue(wrongSize),
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects truncated PNG pixels whose headers still provide valid input and output dimensions", async () => {
  const truncatedReference = {
    ...png,
    data: png.data.subarray(0, Math.floor(png.data.length / 2)),
  };
  expect(await sharp(truncatedReference.data).metadata()).toMatchObject({
    format: "png",
    width: 240,
    height: 240,
  });
  await expect(sharp(truncatedReference.data).stats()).rejects.toThrow();
  await expect(
    validateImageProviderInput(
      input({ operation: "reference", images: [truncatedReference] }),
    ),
  ).rejects.toThrow();
  const noPost = vi.fn().mockResolvedValue(Response.json(success()));
  await expect(
    invokeImageProvider(
      input({ operation: "reference", images: [truncatedReference] }),
      { fetch: noPost },
    ),
  ).rejects.toThrow();
  expect(noPost.mock.calls.length).toBe(0);
  const fetcher = vi.fn().mockResolvedValue(Response.json(success()));
  const output = await invokeImageProvider(input(), { fetch: fetcher });
  const truncatedOutput = outputPng.subarray(
    0,
    Math.floor(outputPng.length / 2),
  );
  expect(await sharp(truncatedOutput).metadata()).toMatchObject({
    format: "png",
    width: 2048,
    height: 2048,
  });
  await expect(sharp(truncatedOutput).stats()).rejects.toThrow();
  const download = vi.fn().mockResolvedValue(truncatedOutput);
  await expect(
    imageProviderPixels(output, undefined, download),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenCalledTimes(1);
});

it("accepts legal actual output dimensions that differ from the request and does not apply the input Alpha ban to output", async () => {
  const body = success();
  body.usage.size = "2047*2048";
  const fetcher = vi.fn().mockResolvedValue(Response.json(body));
  const output = await invokeImageProvider(input({ size: "2048x2048" }), {
    fetch: fetcher,
  });
  const pixels = (await raster(2047, 2048, "png", 0.5)).data;
  expect((await sharp(pixels).metadata()).hasAlpha).toBe(true);
  expect(
    await imageProviderPixels(
      output,
      undefined,
      vi.fn().mockResolvedValue(pixels),
    ),
  ).toBe(pixels);
  expect(output.usage).toEqual(body.usage);
  expect(output).not.toHaveProperty("inputImages");
  const download = vi.fn();
  const controller = new AbortController();
  controller.abort();
  await expect(
    imageProviderPixels(output, controller.signal, download),
  ).rejects.toThrow();
  expect(download.mock.calls.length).toBe(0);
});

it("keeps Qwen native response semantics separate from Wan strict completion facts", () => {
  const oldNative = {
    request_id: "qwen-native-request",
    output: {
      choices: [
        { message: { content: [{ text: "done" }, { image: outputUrl }] } },
      ],
    },
  };
  expect(parseImageProviderOutput(oldNative, "qwen-native").image).toEqual({
    encoding: "url",
    value: outputUrl,
  });
  expect(() => parseImageProviderOutput(oldNative, protocol)).toThrow();
});

it("adds only the explicit Wan protocol literal to strict raw candidate v1 receipts", () => {
  const candidate = {
    kind: "image_raw_candidate",
    version: 1,
    origin: "provider",
    state: "saved",
    generationOperationId: randomUUID(),
    providerCallId: randomUUID(),
    assetId: randomUUID(),
    profileId,
    objectKey: "isolated/wan-raw.png",
    mime: "image/png",
    size: outputPng.length,
    sha256: "a".repeat(64),
    dimensions: { width: 2048, height: 2048 },
    references: [],
    scope: { resourceId: null, jobId: null, sessionId: null },
    request: {
      modelId: "wan-configured",
      model: profileId,
      protocol,
      prompt: input().prompt,
      size: { width: 2048, height: 2048 },
      transportDimensions: [],
    },
    transform: { kind: "full" },
    nativeUsage: { state: "reported", value: success().usage },
  };
  expect(rawImageCandidateSchema.safeParse(candidate).success).toBe(true);
  expect(
    rawImageCandidateSchema.safeParse({
      ...candidate,
      request: { ...candidate.request, protocol: "wan-inferred" },
    }).success,
  ).toBe(false);
  expect(
    rawImageCandidateSchema.safeParse({ ...candidate, version: 2 }).success,
  ).toBe(false);
  const noProtocol = { ...candidate.request } as Partial<
    typeof candidate.request
  >;
  delete noProtocol.protocol;
  expect(
    rawImageCandidateSchema.safeParse({ ...candidate, request: noProtocol })
      .success,
  ).toBe(false);
});
