import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  bindImageEditBitmap,
  imageEditBitmapViewport,
  ImageEditBitmapError,
  preserveOutsideBitmap,
  unionImageEditBitmaps,
} from "../apps/server/src/services/ai/image-edit-bitmap.js";

async function binaryPNG(rows: string[], compressionLevel = 6) {
  const width = rows[0]!.length,
    height = rows.length;
  const pixels = Buffer.from(
    Array.from(rows.join(""), (value) => (value === "1" ? 255 : 0)),
  );
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .toColourspace("b-w")
    .png({ compressionLevel })
    .toBuffer();
}

async function imagePNG(width: number, height: number, seed = 0) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = (index * 17 + seed) % 256;
    pixels[index * 4 + 1] = (index * 23 + seed) % 256;
    pixels[index * 4 + 2] = (index * 43 + seed) % 256;
    pixels[index * 4 + 3] = [0, 83, 170, 255][index % 4]!;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

async function rgba(input: Buffer) {
  return sharp(input).rotate().ensureAlpha().raw().toBuffer();
}

async function maskPixels(input: Buffer) {
  return sharp(input).toColourspace("b-w").raw().toBuffer();
}

function headerPNG(input: Buffer, width: number, height: number, depth = 8) {
  // A tiny valid PNG header avoids allocating an oversized fixture pixel buffer.
  const png = Buffer.from(input);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = depth;
  let crc = 0xffffffff;
  for (const byte of png.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  png.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return png;
}

const sourceRows = [
  "00000000",
  "01111000",
  "01001000",
  "01111000",
  "00000010",
  "00000000",
];
const generatedRows = [
  "00000000",
  "01111000",
  "01001000",
  "01111100",
  "00000010",
  "00000010",
];

describe("binary image-edit masks", () => {
  it("retains shared holes and disconnected targets and reports exact protection conflicts without clipping the union", async () => {
    const source = await imagePNG(8, 6);
    const sourceMask = await binaryPNG(sourceRows);
    const generatedMask = await binaryPNG(generatedRows);
    const protection = await binaryPNG([
      "10000000",
      "01000000",
      "00000000",
      "00000100",
      "00000000",
      "00000000",
    ]);
    const inputs = [source, sourceMask, generatedMask, protection];
    const originals = inputs.map((input) => Buffer.from(input));
    const union = await unionImageEditBitmaps(
      source,
      sourceMask,
      generatedMask,
      protection,
    );
    expect(union).toMatchObject({
      hasProtectionConflict: true,
      expandedPixels: 2,
      sourceTargetPixels: 11,
      generatedTargetPixels: 13,
      coverage: { editablePixels: 13, protectedPixels: 35, totalPixels: 48 },
      conflicts: {
        pixels: 2,
        sourcePixels: 1,
        generatedPixels: 2,
        bounds: { left: 1, top: 1, width: 5, height: 3 },
      },
    });
    expect(await maskPixels(union.data)).toEqual(
      await maskPixels(generatedMask),
    );
    expect(await sharp(union.data).metadata()).toMatchObject({
      format: "png",
      width: 8,
      height: 6,
      channels: 1,
      hasAlpha: false,
    });
    const pixels = await maskPixels(union.data);
    expect(pixels[2 * 8 + 2]).toBe(0); // Background inside the arm/body gap.
    expect(pixels[2 * 8 + 3]).toBe(0);
    expect(pixels[4 * 8 + 6]).toBe(255); // Separate target component retained.
    expect(pixels[5 * 8 + 6]).toBe(255); // Generated component is not cut off.
    expect(pixels[3 * 8 + 5]).toBe(255); // Conflict is not silently subtracted.
    await expect(
      preserveOutsideBitmap(
        source,
        await imagePNG(8, 6, 59),
        union.data,
        protection,
      ),
    ).rejects.toMatchObject({
      name: "ImageEditBitmapError",
      code: "protection_conflict",
      facts: { pixels: 2, bounds: { left: 1, top: 1, width: 5, height: 3 } },
    });
    inputs.forEach((input, index) => expect(input).toEqual(originals[index]));

    const noProtection = await unionImageEditBitmaps(
      source,
      sourceMask,
      generatedMask,
    );
    expect(noProtection.hasProtectionConflict).toBe(false);
    expect(noProtection.conflicts).toEqual({
      pixels: 0,
      sourcePixels: 0,
      generatedPixels: 0,
      bounds: null,
    });
    expect(noProtection.data).toEqual(union.data);
  });

  it("composes complete generated targets while every pixel outside the union, including holes and alpha, remains identical", async () => {
    const source = await imagePNG(8, 6);
    const generated = await imagePNG(8, 6, 59);
    const union = await unionImageEditBitmaps(
      source,
      await binaryPNG(sourceRows),
      await binaryPNG(generatedRows),
    );
    const sourceBefore = Buffer.from(source),
      generatedBefore = Buffer.from(generated),
      maskBefore = Buffer.from(union.data);
    const result = await preserveOutsideBitmap(
      source,
      generated,
      union.data,
      await binaryPNG([
        "10000000",
        "00000000",
        "00000000",
        "00000000",
        "00000000",
        "00000000",
      ]),
    );
    const original = await rgba(source),
      replacement = await rgba(generated),
      actual = await rgba(result.data),
      mask = await maskPixels(union.data);
    let changedPixels = 0,
      protectedPixelsChanged = 0;
    for (let index = 0; index < mask.length; index++) {
      const offset = index * 4;
      const before = original.subarray(offset, offset + 4);
      const after = actual.subarray(offset, offset + 4);
      const editable = mask[index] === 255;
      expect(after).toEqual(
        editable ? replacement.subarray(offset, offset + 4) : before,
      );
      if (!after.equals(before)) {
        changedPixels++;
        if (!editable) protectedPixelsChanged++;
      }
    }
    expect(result).toMatchObject({
      info: { format: "png", width: 8, height: 6, channels: 4 },
      maskDigest: union.digest,
      coverage: { editablePixels: 13, protectedPixels: 35 },
      preservation: {
        baseWidth: 8,
        baseHeight: 6,
        editablePixels: 13,
        changedPixels,
        protectedPixels: 35,
        protectedPixelsChanged,
      },
    });
    expect(changedPixels).toBe(13);
    expect(protectedPixelsChanged).toBe(0);
    expect(result.digest).toBe(
      createHash("sha256").update(result.data).digest("hex"),
    );
    expect(source).toEqual(sourceBefore);
    expect(generated).toEqual(generatedBefore);
    expect(union.data).toEqual(maskBefore);
    const identical = await preserveOutsideBitmap(source, source, union.data);
    expect(identical.preservation.changedPixels).toBe(0);
    expect(await rgba(identical.data)).toEqual(original);
  });

  it("binds digest to exact source content and mask pixels, independently of mask PNG compression", async () => {
    const source = await imagePNG(8, 6);
    const first = await bindImageEditBitmap(
      source,
      await binaryPNG(sourceRows, 0),
    );
    const reencoded = await bindImageEditBitmap(
      source,
      await binaryPNG(sourceRows, 9),
    );
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(reencoded.digest);
    expect(first.data).toEqual(reencoded.data);
    expect(first.source.digest).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    expect(
      (await bindImageEditBitmap(await imagePNG(8, 6, 1), first.data)).digest,
    ).not.toBe(first.digest);
    expect(
      (await bindImageEditBitmap(source, await binaryPNG(generatedRows)))
        .digest,
    ).not.toBe(first.digest);
  });

  it("crops image and single-channel mask together in original coordinates without filling holes or authorizing padding", async () => {
    const source = await imagePNG(10, 8);
    const mask = await binaryPNG([
      "0000000000",
      "0000000000",
      "0001111000",
      "0001001000",
      "0001111000",
      "0000000100",
      "0000000000",
      "0000000000",
    ]);
    const bound = await bindImageEditBitmap(source, mask);
    const viewport = await imageEditBitmapViewport(source, mask, 1);
    expect(viewport).toMatchObject({
      digest: bound.digest,
      source: bound.source,
      bounds: { left: 3, top: 2, width: 5, height: 4 },
      rect: { left: 2, top: 1, width: 7, height: 6 },
      coverage: bound.coverage,
    });
    expect(await sharp(viewport.mask).metadata()).toMatchObject({
      width: 7,
      height: 6,
      channels: 1,
      hasAlpha: false,
    });
    const original = await rgba(source),
      crop = await rgba(viewport.data),
      originalMask = await maskPixels(mask),
      cropMask = await maskPixels(viewport.mask);
    for (let y = 0; y < viewport.rect.height; y++)
      for (let x = 0; x < viewport.rect.width; x++) {
        const local = y * viewport.rect.width + x;
        const originalIndex =
          (y + viewport.rect.top) * 10 + x + viewport.rect.left;
        expect(crop.subarray(local * 4, local * 4 + 4)).toEqual(
          original.subarray(originalIndex * 4, originalIndex * 4 + 4),
        );
        expect(cropMask[local]).toBe(originalMask[originalIndex]);
      }
    expect(cropMask[0]).toBe(0); // Context padding remains protected.
    expect(cropMask[2 * 7 + 2]).toBe(0); // Inner hole is still protected.
    expect((await imageEditBitmapViewport(source, mask)).rect).toEqual(
      bound.bounds,
    );
    expect((await imageEditBitmapViewport(source, mask, 100)).rect).toEqual({
      left: 0,
      top: 0,
      width: 10,
      height: 8,
    });
    for (const padding of [-1, 0.5, NaN, Infinity])
      await expect(
        imageEditBitmapViewport(source, mask, padding),
      ).rejects.toMatchObject({
        code: "invalid_viewport_padding",
      });
  });

  it("uses the source's oriented coordinates while rejecting mask orientation and any size mismatch instead of resizing", async () => {
    const source = await sharp(await imagePNG(3, 2))
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const mask = await binaryPNG(["01", "00", "00"]);
    const bound = await bindImageEditBitmap(source, mask);
    expect(bound.source).toMatchObject({ width: 2, height: 3 });
    const viewport = await imageEditBitmapViewport(source, mask);
    expect(viewport.rect).toEqual({ left: 1, top: 0, width: 1, height: 1 });
    expect(await rgba(viewport.data)).toEqual(
      (await rgba(source)).subarray(4, 8),
    );
    await expect(
      bindImageEditBitmap(source, await binaryPNG(["010", "000"])),
    ).rejects.toMatchObject({ code: "mask_dimensions" });
    await expect(
      preserveOutsideBitmap(source, await imagePNG(3, 2), mask),
    ).rejects.toMatchObject({ code: "generated_dimensions" });
    const rotatedMask = await sharp(mask)
      .withMetadata({ orientation: 3 })
      .toColourspace("b-w")
      .png()
      .toBuffer();
    await expect(
      bindImageEditBitmap(source, rotatedMask),
    ).rejects.toMatchObject({
      code: "mask_orientation",
    });
  });

  it("rejects invalid, multichannel, grey, empty and oversized masks without repairing the input or allocating oversized pixels", async () => {
    const source = await imagePNG(2, 2);
    const binary = await binaryPNG(["01", "00"]);
    const grey = await sharp(Buffer.from([0, 127, 255, 0]), {
      raw: { width: 2, height: 2, channels: 1 },
    })
      .toColourspace("b-w")
      .png()
      .toBuffer();
    const rgb = await sharp(Buffer.from([0, 255, 0, 0]), {
      raw: { width: 2, height: 2, channels: 1 },
    })
      .png()
      .toBuffer();
    const jpeg = await sharp(binary).jpeg().toBuffer();
    const invalidMasks = [
      [Buffer.from("invalid"), "invalid_mask"],
      [binary.subarray(0, 30), "invalid_mask"],
      [Buffer.alloc(0), "invalid_mask"],
      [jpeg, "mask_format"],
      [rgb, "mask_channels"],
      [source, "mask_channels"],
      [grey, "mask_nonbinary"],
      [await binaryPNG(["00", "00"]), "empty_mask"],
      [await binaryPNG(["010", "000"]), "mask_dimensions"],
      [headerPNG(binary, 2, 2, 16), "mask_depth"],
      [headerPNG(binary, 5000, 5001), "pixel_limit"],
    ] as const;
    for (const [input, code] of invalidMasks) {
      const before = Buffer.from(input);
      await expect(bindImageEditBitmap(source, input)).rejects.toMatchObject({
        name: "ImageEditBitmapError",
        code,
      });
      expect(input).toEqual(before);
    }
    await expect(bindImageEditBitmap(source, grey)).rejects.toMatchObject({
      facts: { x: 1, y: 0, value: 127 },
    });
    await expect(
      bindImageEditBitmap(headerPNG(binary, 5000, 5001), binary),
    ).rejects.toMatchObject({ code: "pixel_limit" });
    await expect(
      bindImageEditBitmap(Buffer.from("invalid"), binary),
    ).rejects.toBeInstanceOf(ImageEditBitmapError);
    await expect(
      unionImageEditBitmaps(source, binary, await binaryPNG(["00", "00"])),
    ).rejects.toMatchObject({ code: "empty_mask" });
    await expect(
      preserveOutsideBitmap(
        source,
        source,
        binary,
        await binaryPNG(["00", "00"]),
      ),
    ).rejects.toMatchObject({ code: "empty_mask" });
  });
});
