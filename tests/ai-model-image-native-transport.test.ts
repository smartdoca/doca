import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modelPromptImages } from "../apps/server/src/services/ai/model-image.js";

const width = 41,
  height = 27;
let png: Buffer, pixels: Buffer;
const file = (data: unknown, mediaType = "image/png") => ({
  type: "file",
  mediaType,
  filename: "same-safe-label.png",
  data: { type: "data", data },
});
const prompt = (...parts: any[]) => [
  {
    role: "user",
    content: [{ type: "text", text: "native detail" }, ...parts],
  },
];
const decode = async (data: Buffer) =>
  sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
beforeEach(async () => {
  pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels.set([x * 5, y * 7, (x + y) * 3, x % 3 ? 255 : 43], i);
    }
  png = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("No network"))),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("retains all three trusted native PNG frames and their exact RGBA, byte and data-object identities", async () => {
  const frames = [
    file(png),
    file(new Uint8Array(png)),
    file(png.toString("base64")),
  ];
  const value = await modelPromptImages(
    prompt(...frames),
    new Set(frames.map((frame) => frame.data)),
  );
  expect(value[0]!.content[0]).toEqual({ type: "text", text: "native detail" });
  for (const [index, frame] of frames.entries()) {
    const result = value[0]!.content[index + 1];
    expect(result).toBe(frame);
    expect(result.data).toBe(frame.data);
    expect(result.mediaType).toBe("image/png");
    const bytes =
      typeof result.data.data === "string"
        ? Buffer.from(result.data.data, "base64")
        : Buffer.from(result.data.data);
    expect(bytes.equals(png)).toBe(true);
    const decoded = await decode(bytes);
    expect([
      decoded.info.width,
      decoded.info.height,
      decoded.info.channels,
    ]).toEqual([width, height, 4]);
    expect(decoded.data.equals(pixels)).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("does not trust identical public labels or a copied data object carrying identical pixels", async () => {
  const trusted = file(png),
    copied = file(png);
  const value = await modelPromptImages(
    prompt(trusted, copied),
    new Set([trusted.data]),
  );
  expect(value[0]!.content[1]).toBe(trusted);
  expect(value[0]!.content[2]).not.toBe(copied);
  expect(value[0]!.content[2].mediaType).toBe("image/jpeg");
  expect(value[0]!.content[2].data).not.toBe(copied.data);
  const transformed = await decode(value[0]!.content[2].data.data);
  expect(transformed.data.equals(pixels)).toBe(false);
  expect(transformed.data[3]).toBe(255);
});

it("accepts the exact one-million-pixel limit without resizing or changing bytes", async () => {
  const data = await sharp({
    create: {
      width: 1000,
      height: 1000,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const native = file(data);
  const result = await modelPromptImages(
    prompt(native),
    new Set([native.data]),
  );
  expect(result[0]!.content[1]).toBe(native);
  expect(result[0]!.content[1].data.data).toBe(data);
  expect((await sharp(data).metadata()).width).toBe(1000);
});

it("validates a real high-entropy native PNG with over 4MiB of base64 in linear space and rejects malformed long tails", async () => {
  const data = await sharp(randomBytes(1000 * 1000 * 4), {
    raw: { width: 1000, height: 1000, channels: 4 },
  })
    .png()
    .toBuffer();
  const base64 = data.toString("base64");
  expect(base64.length).toBeGreaterThan(4 * 1024 * 1024);
  const native = file(base64);
  const value = await modelPromptImages(prompt(native), new Set([native.data]));
  expect(value[0]!.content[1]).toBe(native);
  expect(value[0]!.content[1].data.data).toBe(base64);
  expect(
    Buffer.from(value[0]!.content[1].data.data, "base64").equals(data),
  ).toBe(true);
  for (const invalid of [
    base64.slice(0, -1),
    base64.slice(0, -1) + "!",
    base64.slice(0, -4) + "=AAA",
    base64.slice(0, -4) + "A===",
  ]) {
    const malformed = file(invalid);
    await expect(
      modelPromptImages(prompt(malformed), new Set([malformed.data])),
    ).rejects.toMatchObject({ status: 422 });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [1025, 1],
  [1024, 1000],
  [1, 1025],
])(
  "rejects an explicitly trusted oversize %i×%i frame instead of fitting it",
  async (w, h) => {
    const data = await sharp({
      create: { width: w, height: h, channels: 4, background: "#789abc" },
    })
      .png()
      .toBuffer();
    const native = file(data);
    await expect(
      modelPromptImages(prompt(native), new Set([native.data])),
    ).rejects.toMatchObject({ status: 422 });
    expect(native.data.data).toBe(data);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("rejects non-PNG bytes, a wrong MIME, or non-file parts carrying the trusted object", async () => {
  const jpeg = await sharp(png).jpeg().toBuffer();
  for (const native of [
    file(jpeg),
    file(png, "image/jpeg"),
    { ...file(png), type: "image" },
  ]) {
    await expect(
      modelPromptImages(prompt(native), new Set([native.data])),
    ).rejects.toMatchObject({ status: 422 });
  }
});

it("rejects remote or malformed data instead of reading a URL or silently converting it", async () => {
  const values = [
    {
      ...file(png),
      data: { type: "url", url: "https://fixture.invalid/image.png" },
    },
    file("https://fixture.invalid/image.png"),
    file("data:image/png;base64," + png.toString("base64")),
    file(png.toString("base64") + "!"),
    file(Array.from(png)),
  ];
  for (const native of values)
    await expect(
      modelPromptImages(prompt(native), new Set([native.data])),
    ).rejects.toMatchObject({ status: 422 });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects incomplete and animated PNG structure and corrupt compressed pixels before transport", async () => {
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0);
  animation.write("acTL", 4, "ascii");
  animation.writeUInt32BE(2, 8);
  const animated = Buffer.concat([
    png.subarray(0, 33),
    animation,
    png.subarray(33),
  ]);
  const corrupted = Buffer.from(png);
  for (let offset = 8; offset + 12 <= corrupted.length;) {
    const length = corrupted.readUInt32BE(offset);
    if (corrupted.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      corrupted[offset + 8] = 0xff;
      break;
    }
    offset += length + 12;
  }
  for (const data of [png.subarray(0, png.length - 12), animated, corrupted]) {
    const native = file(data);
    await expect(
      modelPromptImages(prompt(native), new Set([native.data])),
    ).rejects.toMatchObject({ status: 422 });
    expect(native.data.data).toBe(data);
  }
});

it("rejects orientation metadata which would change the declared native coordinates", async () => {
  const data = await sharp(png)
    .withMetadata({ orientation: 6 })
    .png()
    .toBuffer();
  expect((await sharp(data).metadata()).orientation).toBe(6);
  const native = file(data);
  await expect(
    modelPromptImages(prompt(native), new Set([native.data])),
  ).rejects.toMatchObject({ status: 422 });
});

it("continues normal compression for ordinary images and keeps existing small JPEG transport", async () => {
  const ordinary = file(
    await sharp({
      create: {
        width: 1700,
        height: 1400,
        channels: 4,
        background: { r: 5, g: 70, b: 200, alpha: 0.3 },
      },
    })
      .png()
      .toBuffer(),
  );
  const jpeg = file(
    await sharp(png).flatten({ background: "#fff" }).jpeg().toBuffer(),
    "image/jpeg",
  );
  const value = await modelPromptImages(prompt(ordinary, jpeg));
  const compressed = value[0]!.content[1];
  expect(compressed.mediaType).toBe("image/jpeg");
  const metadata = await sharp(compressed.data.data).metadata();
  expect([metadata.width, metadata.height]).toEqual([1600, 1318]);
  expect(metadata.hasAlpha).toBe(false);
  expect(value[0]!.content[2]).toBe(jpeg);
});
