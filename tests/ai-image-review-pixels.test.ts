import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import sharp from "sharp";
import { imageReviewPixelInspection } from "../apps/server/src/services/ai/image-review-pixels.js";

const identity = {
  sourceRef: randomUUID(),
  candidateAssetId: randomUUID(),
};
const sha256 = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");

it("compares decoded sRGB RGBA rather than PNG encoding or missing alpha", async () => {
  const sourcePixels = Buffer.from([12, 34, 56, 78, 90, 123]);
  const source = await sharp(sourcePixels, {
    raw: { width: 2, height: 1, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const rgba = Buffer.from([12, 34, 56, 255, 78, 90, 123, 255]);
  const candidate = await sharp(rgba, {
    raw: { width: 2, height: 1, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  expect(source.equals(candidate)).toBe(false);
  const inspection = await imageReviewPixelInspection(
    source,
    candidate,
    identity,
  );
  expect(inspection).toMatchObject({
    nonCitable: true,
    ...identity,
    decodedPixels: "orientation-normalized sRGB RGBA",
    rgbaExact: true,
    source: {
      width: 2,
      height: 1,
      channels: 4,
      bytes: 8,
      sha256: sha256(rgba),
    },
    candidate: {
      width: 2,
      height: 1,
      channels: 4,
      bytes: 8,
      sha256: sha256(rgba),
    },
  });
  expect(inspection.applicationRule).toContain("遗漏修改必须不通过");
});

it.each(["red", "alpha"])(
  "detects a single pixel %s difference without trusting dimensions or file origin",
  async (channel) => {
    const sourcePixels = Buffer.from([12, 34, 56, 255, 78, 90, 123, 255]);
    const candidatePixels = Buffer.from(sourcePixels);
    candidatePixels[channel === "red" ? 4 : 7]! -= 1;
    const encode = (data: Buffer) =>
      sharp(data, { raw: { width: 2, height: 1, channels: 4 } })
        .png()
        .toBuffer();
    const [source, candidate] = await Promise.all([
      encode(sourcePixels),
      encode(candidatePixels),
    ]);
    const inspection = await imageReviewPixelInspection(
      source,
      candidate,
      identity,
    );
    expect(inspection.rgbaExact).toBe(false);
    expect(inspection.source.sha256).toBe(sha256(sourcePixels));
    expect(inspection.candidate.sha256).toBe(sha256(candidatePixels));
    expect(inspection.source.sha256).not.toBe(inspection.candidate.sha256);
  },
);

it("rejects different dimensions even when the actual RGBA byte streams match", async () => {
  const pixels = Buffer.from([12, 34, 56, 255, 78, 90, 123, 255]);
  const encode = (width: number, height: number) =>
    sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  const inspection = await imageReviewPixelInspection(
    await encode(1, 2),
    await encode(2, 1),
    identity,
  );
  expect(inspection.source.sha256).toBe(inspection.candidate.sha256);
  expect(inspection.source.bytes).toBe(inspection.candidate.bytes);
  expect(inspection.source).toMatchObject({ width: 1, height: 2, channels: 4 });
  expect(inspection.candidate).toMatchObject({
    width: 2,
    height: 1,
    channels: 4,
  });
  expect(inspection.rgbaExact).toBe(false);
});

it("uses the orientation-normalized canvas without resizing or cropping", async () => {
  const sourcePixels = Buffer.from([12, 34, 56, 255, 78, 90, 123, 255]);
  const source = await sharp(sourcePixels, {
    raw: { width: 2, height: 1, channels: 4 },
  })
    .withMetadata({ orientation: 6 })
    .png()
    .toBuffer();
  expect((await sharp(source).metadata()).orientation).toBe(6);
  const candidate = await sharp(source).rotate().png().toBuffer();
  const actual = await sharp(candidate).ensureAlpha().raw().toBuffer();
  const inspection = await imageReviewPixelInspection(
    source,
    candidate,
    identity,
  );
  expect(inspection.rgbaExact).toBe(true);
  expect(inspection.source).toMatchObject({
    width: 1,
    height: 2,
    channels: 4,
    bytes: 8,
    sha256: sha256(actual),
  });
  expect(inspection.source).toEqual(inspection.candidate);
});
