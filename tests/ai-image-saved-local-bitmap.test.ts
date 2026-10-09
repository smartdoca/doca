import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageModelProfiles } from "../packages/core/src/modules/ai/image-model-catalog.js";
import {
  composeSavedLocalBitmap,
  prepareSavedLocalBitmap,
  savedLocalBitmapFactsSchema,
  savedLocalBitmapPreview,
  savedLocalBitmapRegionSchema,
} from "../apps/server/src/services/ai/image-saved-local-bitmap.js";

const ark = imageModelProfiles.find(
  (p) => p.id === "doubao-seedream-5-0-pro-260628",
)!;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function pattern(width: number, height: number, seed = 0) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 17 + seed) % 256;
    data[i * 4 + 1] = (i * 31 + seed) % 256;
    data[i * 4 + 2] = (i * 41 + seed) % 256;
    data[i * 4 + 3] = [0, 83, 170, 255][i % 4]!;
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
async function solid(
  width: number,
  height: number,
  color = { r: 11, g: 217, b: 83, alpha: 1 },
) {
  return sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();
}
const rgba = (data: Buffer) =>
  sharp(data).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer();
const region = { left: 0.201, top: 0.252, width: 0.207, height: 0.298 };

describe("current saved-base local bitmap geometry", () => {
  it("renders the real context crop, fills a legal Ark viewport and records exact inverse coordinates", async () => {
    const base = await pattern(800, 600);
    const before = Buffer.from(base);
    const prepared = await prepareSavedLocalBitmap(base, region, ark, 11);
    const { facts } = prepared;
    expect(savedLocalBitmapFactsSchema.parse(facts)).toEqual(facts);
    const { digest, ...body } = facts;
    expect(digest).toBe(sha(Buffer.from(JSON.stringify(body))));
    expect(facts.nativeRect).toEqual({
      left: 160,
      top: 151,
      width: 167,
      height: 179,
    });
    expect(facts.contextCrop).toEqual({
      left: 149,
      top: 140,
      width: 189,
      height: 201,
    });
    expect(facts.crop).toEqual({
      width: 189,
      height: 201,
      sha256: sha(prepared.cropPNG),
    });
    const expectedCrop = await sharp(base)
      .extract(facts.contextCrop)
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(await rgba(prepared.cropPNG)).toEqual(expectedCrop);
    expect(facts.provider.sha256).toBe(sha(prepared.providerPNG));
    expect(await sharp(prepared.providerPNG).metadata()).toMatchObject({
      format: "png",
      width: facts.workspace.width,
      height: facts.workspace.height,
    });
    expect(
      facts.workspace.width * facts.workspace.height,
    ).toBeGreaterThanOrEqual(921600);
    expect(facts.workspace.width * facts.workspace.height).toBeLessThanOrEqual(
      4624220,
    );
    expect(facts.workspace.scale.x).toBeGreaterThan(1);
    expect(
      facts.workspace.contentRect.width * facts.workspace.inverseScale.x,
    ).toBe(189);
    expect(
      facts.workspace.contentRect.height * facts.workspace.inverseScale.y,
    ).toBe(201);
    expect(
      facts.workspace.padding.left +
        facts.workspace.contentRect.width +
        facts.workspace.padding.right,
    ).toBe(facts.workspace.width);
    expect(
      facts.workspace.padding.top +
        facts.workspace.contentRect.height +
        facts.workspace.padding.bottom,
    ).toBe(facts.workspace.height);
    expect(base).toEqual(before);
  });

  it("upscales a small portrait crop to fill the viewport instead of surrounding it with a large board", async () => {
    const prepared = await prepareSavedLocalBitmap(
      await solid(600, 800),
      { left: 0.25, top: 0.25, width: 0.25, height: 0.4375 },
      ark,
      0,
    );
    expect(prepared.facts.contextCrop).toEqual({
      left: 150,
      top: 200,
      width: 150,
      height: 350,
    });
    const w = prepared.facts.workspace;
    expect(
      (w.contentRect.width * w.contentRect.height) / (w.width * w.height),
    ).toBeGreaterThan(0.995);
    expect(w.scale.requested).toBeGreaterThan(4);
  });

  it("copies only the floor/ceil region back, preserving every outside RGBA pixel including transparent RGB", async () => {
    const base = await pattern(80, 60),
      before = Buffer.from(base),
      prepared = await prepareSavedLocalBitmap(base, region, ark, 5),
      actual = await solid(
        prepared.facts.workspace.width,
        prepared.facts.workspace.height,
      ),
      actualBefore = Buffer.from(actual),
      composed = await composeSavedLocalBitmap(base, actual, prepared.facts),
      b = await rgba(base),
      c = await rgba(composed.data),
      r = prepared.facts.nativeRect;
    let preserved = 0,
      edited = 0;
    for (let y = 0; y < 60; y++)
      for (let x = 0; x < 80; x++) {
        const offset = (y * 80 + x) * 4,
          inside =
            x >= r.left &&
            x < r.left + r.width &&
            y >= r.top &&
            y < r.top + r.height;
        if (inside) {
          expect([...c.subarray(offset, offset + 4)]).toEqual([
            11, 217, 83, 255,
          ]);
          edited++;
        } else {
          expect(c.subarray(offset, offset + 4)).toEqual(
            b.subarray(offset, offset + 4),
          );
          preserved++;
        }
      }
    expect(composed.result).toMatchObject({
      width: 80,
      height: 60,
      editedPixels: edited,
      preservedPixels: preserved,
    });
    expect(composed.actual.sha256).toBe(sha(actual));
    expect(composed.geometryDigest).toBe(prepared.facts.digest);
    expect(base).toEqual(before);
    expect(actual).toEqual(actualBefore);
  });

  it("removes legal-aspect padding and never gives the entire context crop edit permission", async () => {
    const base = await solid(2000, 80, { r: 51, g: 63, b: 71, alpha: 1 }),
      prepared = await prepareSavedLocalBitmap(
        base,
        { left: 0.1, top: 0.45, width: 0.8, height: 0.1 },
        ark,
        0,
      ),
      w = prepared.facts.workspace;
    expect(w.padding.top + w.padding.bottom).toBeGreaterThan(0);
    expect(w.width / w.height).toBeLessThanOrEqual(16);
    const pixels = Buffer.alloc(w.width * w.height * 4);
    for (let y = 0; y < w.height; y++)
      for (let x = 0; x < w.width; x++) {
        const i = (y * w.width + x) * 4,
          inContent =
            y >= w.contentRect.top &&
            y < w.contentRect.top + w.contentRect.height;
        pixels[i] = inContent ? 25 : 230;
        pixels[i + 1] = inContent ? 170 : 0;
        pixels[i + 2] = inContent ? 55 : 230;
        pixels[i + 3] = 255;
      }
    const actual = await sharp(pixels, {
      raw: { width: w.width, height: w.height, channels: 4 },
    })
      .png()
      .toBuffer();
    const output = await rgba(
      (await composeSavedLocalBitmap(base, actual, prepared.facts)).data,
    );
    expect([
      ...output.subarray((40 * 2000 + 600) * 4, (40 * 2000 + 600) * 4 + 4),
    ]).toEqual([25, 170, 55, 255]);
    expect([
      ...output.subarray((20 * 2000 + 600) * 4, (20 * 2000 + 600) * 4 + 4),
    ]).toEqual([51, 63, 71, 255]);
  });

  it("maps both axes from a larger actual native workspace to the selected base coordinates", async () => {
    const base = await solid(200, 160, { r: 51, g: 63, b: 71, alpha: 1 }),
      prepared = await prepareSavedLocalBitmap(base, region, ark, 5),
      w = prepared.facts.workspace,
      actualWidth = w.width * 2,
      actualHeight = w.height * 2,
      pixels = Buffer.alloc(actualWidth * actualHeight * 4);
    for (let y = 0; y < actualHeight; y++)
      for (let x = 0; x < actualWidth; x++) {
        const i = (y * actualWidth + x) * 4;
        pixels[i] =
          x < (w.contentRect.left + w.contentRect.width / 2) * 2 ? 10 : 210;
        pixels[i + 1] =
          y < (w.contentRect.top + w.contentRect.height / 2) * 2 ? 20 : 220;
        pixels[i + 2] = 37;
        pixels[i + 3] = 255;
      }
    const actual = await sharp(pixels, {
        raw: { width: actualWidth, height: actualHeight, channels: 4 },
      })
        .png()
        .toBuffer(),
      output = await rgba(
        (await composeSavedLocalBitmap(base, actual, prepared.facts)).data,
      ),
      r = prepared.facts.nativeRect;
    for (const [x, y, expected] of [
      [r.left + 2, r.top + 2, [10, 20, 37, 255]],
      [r.left + r.width - 3, r.top + 2, [210, 20, 37, 255]],
      [r.left + 2, r.top + r.height - 3, [10, 220, 37, 255]],
      [r.left + r.width - 3, r.top + r.height - 3, [210, 220, 37, 255]],
    ] as const) {
      const i = (y * 200 + x) * 4;
      expect([...output.subarray(i, i + 4)]).toEqual(expected);
    }
    const outside = ((r.top - 1) * 200 + r.left) * 4;
    expect([...output.subarray(outside, outside + 4)]).toEqual([
      51, 63, 71, 255,
    ]);
  });

  it("accepts native one-pixel aspect rounding, including the actual 1510x2000 to 1780x2357 case", async () => {
    const base = await solid(1510, 2000),
      prepared = await prepareSavedLocalBitmap(
        base,
        { left: 0, top: 0, width: 1, height: 1 },
        ark,
        0,
      ),
      actual = await solid(1780, 2357);
    expect(prepared.facts.workspace).toMatchObject({
      width: 1510,
      height: 2000,
    });
    expect(
      (await composeSavedLocalBitmap(base, actual, prepared.facts)).result,
    ).toMatchObject({ width: 1510, height: 2000, preservedPixels: 0 });
  });

  it("rejects a different native return aspect instead of stretching it into the selected face", async () => {
    const base = await solid(1510, 2000),
      prepared = await prepareSavedLocalBitmap(
        base,
        { left: 0, top: 0, width: 1, height: 1 },
        ark,
        0,
      );
    await expect(
      composeSavedLocalBitmap(base, await solid(1780, 2300), prepared.facts),
    ).rejects.toMatchObject({ code: "provider_aspect" });
    await expect(
      composeSavedLocalBitmap(base, await solid(400, 400), prepared.facts),
    ).rejects.toMatchObject({ code: "provider_dimensions" });
  });

  it("rejects oversized native context before provider preparation rather than downsampling it", async () => {
    await expect(
      prepareSavedLocalBitmap(
        await solid(2200, 2200),
        { left: 0, top: 0, width: 1, height: 1 },
        ark,
        0,
      ),
    ).rejects.toMatchObject({ code: "provider_size" });
    const accepted = await prepareSavedLocalBitmap(
      await solid(2200, 2200),
      { left: 0, top: 0, width: 0.1, height: 0.1 },
      ark,
      3,
    );
    expect(accepted.facts.contextCrop.width).toBe(223);
    expect(accepted.facts.workspace.scale.x).toBeGreaterThan(1);
  });

  it("keeps bottom/right coverage in range and clips only requested context padding at actual base edges", async () => {
    const prepared = await prepareSavedLocalBitmap(
      await solid(101, 79),
      { left: 0.901, top: 0.91, width: 0.099, height: 0.09 },
      ark,
      20,
    );
    expect(prepared.facts.nativeRect).toEqual({
      left: 91,
      top: 71,
      width: 10,
      height: 8,
    });
    expect(prepared.facts.contextCrop).toEqual({
      left: 71,
      top: 51,
      width: 30,
      height: 28,
    });
  });

  it("rejects stale bytes, tampered geometry and incomplete facts instead of repairing fields", async () => {
    const base = await pattern(80, 60),
      prepared = await prepareSavedLocalBitmap(base, region, ark, 3),
      actual = await solid(
        prepared.facts.workspace.width,
        prepared.facts.workspace.height,
      );
    await expect(
      composeSavedLocalBitmap(await pattern(80, 60, 1), actual, prepared.facts),
    ).rejects.toMatchObject({ code: "binding_changed" });
    await expect(
      composeSavedLocalBitmap(base, actual, {
        ...prepared.facts,
        nativeRect: { ...prepared.facts.nativeRect, left: 1 },
      }),
    ).rejects.toMatchObject({ code: "binding_changed" });
    const { inverseScale: _inverse, ...workspace } = prepared.facts.workspace;
    expect(
      savedLocalBitmapFactsSchema.safeParse({ ...prepared.facts, workspace })
        .success,
    ).toBe(false);
    expect(
      savedLocalBitmapFactsSchema.safeParse({ ...prepared.facts, version: 2 })
        .success,
    ).toBe(false);
  });

  it("requires current-base strict regions, explicit padding and an implemented editing profile", async () => {
    const base = await solid(80, 60);
    for (const invalid of [
      { ...region, left: -0.01 },
      { ...region, width: 0 },
      { ...region, left: 0.9 },
      { ...region, x: 0.2 },
    ])
      expect(savedLocalBitmapRegionSchema.safeParse(invalid).success).toBe(
        false,
      );
    await expect(
      prepareSavedLocalBitmap(base, region, ark, -1),
    ).rejects.toBeDefined();
    await expect(
      prepareSavedLocalBitmap(base, region, ark, undefined as never),
    ).rejects.toBeDefined();
    await expect(
      prepareSavedLocalBitmap(base, region, { ...ark, id: "unknown" }, 0),
    ).rejects.toMatchObject({ code: "provider_profile" });
    await expect(
      prepareSavedLocalBitmap(
        base,
        region,
        { ...ark, limits: { ...ark.limits, minPixels: 1 } },
        0,
      ),
    ).rejects.toMatchObject({ code: "provider_profile" });
  });

  it("renders original context and two base-coordinate coverage frames without pretending original coordinates are base coordinates", async () => {
    const original = await pattern(300, 120, 9),
      base = await pattern(80, 60),
      prepared = await prepareSavedLocalBitmap(base, region, ark, 3),
      preview = await savedLocalBitmapPreview(original, base, prepared.facts);
    expect(preview.frames.map((f) => f.role)).toEqual([
      "original-context",
      "current-base-coverage",
      "current-base-local-coverage",
    ]);
    expect(preview.frames[0]).toMatchObject({
      sourceSize: { width: 300, height: 120 },
      sourceRect: { left: 0, top: 0, width: 300, height: 120 },
      selectionCoordinateSpace: null,
    });
    expect(await rgba(preview.frames[0].data)).toEqual(await rgba(original));
    expect(preview.frames[1]).toMatchObject({
      sourceSize: { width: 80, height: 60 },
      selectionCoordinateSpace: "current-base",
    });
    expect(preview.frames[2]).toMatchObject({
      sourceSize: { width: 80, height: 60 },
      sourceRect: prepared.facts.contextCrop,
      selectionCoordinateSpace: "current-base",
    });
    for (const frame of preview.frames) {
      expect(frame.sha256).toBe(sha(frame.data));
      expect(await sharp(frame.data).metadata()).toMatchObject({
        format: "png",
        ...frame.displaySize,
      });
    }
    expect(
      preview.frames.every((f) => f.sha256 !== prepared.facts.provider.sha256),
    ).toBe(true);
  });

  it("pads a fixed-size provider viewport explicitly without shrinking native source or inventing a model default", async () => {
    const profile = imageModelProfiles.find((p) => p.id === "gpt-image-1")!;
    const prepared = await prepareSavedLocalBitmap(
      await solid(150, 350),
      { left: 0, top: 0, width: 1, height: 1 },
      profile,
      0,
    );
    expect(prepared.facts.provider.requestedSize).toBe("1024x1536");
    expect(prepared.facts.workspace.scale.x).toBeGreaterThan(4);
    expect(
      prepared.facts.workspace.padding.left +
        prepared.facts.workspace.padding.right,
    ).toBeGreaterThan(0);
  });
});
