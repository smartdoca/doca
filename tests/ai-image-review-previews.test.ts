import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import sharp from "sharp";
import {
  globalImageReviewPrompt,
  imageReviewGlobalPreview,
} from "../apps/server/src/services/ai/image-review-previews.js";
import { nativeImageReviewPrompt } from "../apps/server/src/services/ai/image-review-views.js";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const image = (data: Buffer, mime = "image/jpeg") => ({
  type: "file",
  mediaType: mime,
  data: { type: "data", data },
});
const prompt = (...images: ReturnType<typeof image>[]) => [
  { role: "user", content: images },
];
async function source(width = 120, height = 180) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 44, g: 127, b: 209, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

it("bounds lossy composition previews, preserves aspect without enlargement, uses full chroma, and leaves original bytes untouched", async () => {
  const bytes = await source(1510, 2000),
    originalSha = sha(bytes);
  const result = await imageReviewGlobalPreview(bytes);
  const metadata = await sharp(result.data).metadata();
  expect([metadata.format, metadata.width, metadata.height]).toEqual([
    "jpeg",
    1208,
    1600,
  ]);
  expect(metadata.chromaSubsampling).toBe("4:4:4");
  expect(metadata.exif).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
  expect(result.sha256).toBe(sha(result.data));
  expect(sha(bytes)).toBe(originalSha);
  const small = await imageReviewGlobalPreview(await source(80, 120));
  expect([small.width, small.height]).toEqual([80, 120]);
});

it("normalizes orientation before preview encoding and strips EXIF rather than carrying a rotated interpretation", async () => {
  const bytes = await sharp(await source(80, 120))
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const result = await imageReviewGlobalPreview(bytes);
  expect([result.width, result.height]).toEqual([120, 80]);
  expect((await sharp(result.data).metadata()).exif).toBeUndefined();
  expect((await sharp(result.data).metadata()).orientation).toBeUndefined();
});

it("reduces high-entropy preview payload without changing dimensions or input bytes", async () => {
  const width = 640,
    height = 800,
    pixels = Buffer.alloc(width * height * 3);
  let seed = 731;
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const originalSha = sha(png);
  const preview = await imageReviewGlobalPreview(png);
  expect([preview.width, preview.height]).toEqual([width, height]);
  expect(preview.data.length).toBeLessThan(png.length * 0.85);
  expect(sha(png)).toBe(originalSha);
});

it("allows only the bound first JPEG pair and preserves every PNG reference's exact transport bytes", async () => {
  const first = await imageReviewGlobalPreview(await source()),
    second = await imageReviewGlobalPreview(await source(200, 250));
  const reference = await source(40, 60);
  const input = prompt(
    image(first.data),
    image(second.data),
    image(reference, "image/png"),
  );
  const normalizer = globalImageReviewPrompt(
    new Set([first.sha256, second.sha256]),
  );
  expect(await normalizer(input)).toBe(input);
  expect(input[0]!.content[2]!.data.data).toBe(reference);
  await expect(
    nativeImageReviewPrompt(prompt(image(first.data))),
  ).rejects.toThrow("完整PNG");
});

it("keeps PNG-only review available when there is no native follow-up plan and rejects any JPEG without current host approval", async () => {
  const png = await source(),
    jpeg = await imageReviewGlobalPreview(png);
  const normalizer = globalImageReviewPrompt(new Set());
  const input = prompt(image(png, "image/png"), image(png, "image/png"));
  expect(await normalizer(input)).toBe(input);
  await expect(normalizer(prompt(image(jpeg.data)))).rejects.toThrow(
    "宿主绑定不一致",
  );
});

it("rejects changed preview bytes and a JPEG identity/reference even if its digest is approved", async () => {
  const a = await imageReviewGlobalPreview(await source()),
    b = await imageReviewGlobalPreview(await source(60, 100));
  await expect(
    globalImageReviewPrompt(new Set([a.sha256]))(prompt(image(b.data))),
  ).rejects.toThrow("宿主绑定不一致");
  await expect(
    globalImageReviewPrompt(new Set([a.sha256]))(
      prompt(image(a.data), image(a.data), image(a.data)),
    ),
  ).rejects.toThrow("前两帧");
});

it.each(["mislabelled-png", "oversized", "exif", "truncated"])(
  "rejects a host-bound JPEG that is %s instead of converting it or lowering the native gate",
  async (mode) => {
    let data: Buffer;
    if (mode === "mislabelled-png") data = await source();
    else if (mode === "oversized")
      data = await sharp(await source(1601, 90))
        .jpeg()
        .toBuffer();
    else if (mode === "exif")
      data = await sharp(await source())
        .withMetadata({ orientation: 1 })
        .jpeg()
        .toBuffer();
    else {
      const jpeg = await sharp(await source())
        .jpeg()
        .toBuffer();
      data = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    }
    await expect(
      globalImageReviewPrompt(new Set([sha(data)]))(prompt(image(data))),
    ).rejects.toThrow("有损预览格式、尺寸或完整像素无效");
  },
);
