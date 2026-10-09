import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { imageEditPreview } from "../apps/server/src/services/ai/image-edit-preview.js";
import { preserveOutsideRegions, type EditRegions } from "../apps/server/src/services/ai/image-edit-regions.js";

const region: EditRegions = [{ label: "body", points: [[.25, .25], [.75, .25], [.75, .75], [.25, .75]] }];
const source = (width = 200, height = 100) => sharp({ create: {
  width, height, channels: 3, background: "#fff",
} }).png().toBuffer();

it("shows exact editable and protected coverage on full and local views without changing source pixels", async () => {
  const original = await source(), copy = Buffer.from(original);
  const preview = await imageEditPreview(original, region);
  expect(preview.coverage).toEqual({
    editablePixels: 5000, protectedPixels: 15000, totalPixels: 20000, editableFraction: .25,
  });
  expect(preview.source).toEqual({
    width: 200, height: 100, digest: createHash("sha256").update(original).digest("hex"),
  });
  expect(preview.full.sourceRect).toEqual({ left: 0, top: 0, width: 200, height: 100 });
  expect(preview.local.sourceRect).toEqual({ left: 34, top: 9, width: 132, height: 82 });
  for (const view of [preview.full, preview.local]) {
    expect((await sharp(view.data).metadata()).format).toBe("png");
    const pixels = await sharp(view.data).removeAlpha().raw().toBuffer();
    const pixel = (sourceX: number, sourceY: number) => {
      const x = view.contentRect.left + Math.floor((sourceX - view.sourceRect.left) * view.contentRect.width / view.sourceRect.width),
        y = view.contentRect.top + Math.floor((sourceY - view.sourceRect.top) * view.contentRect.height / view.sourceRect.height),
        index = (y * view.width + x) * 3;
      return [...pixels.subarray(index, index + 3)];
    };
    const editable = pixel(100, 50), protectedPixel = pixel(40, 12);
    expect(editable[1]).toBeGreaterThan(editable[2]!);
    expect(protectedPixel[2]).toBeGreaterThan(protectedPixel[1]!);
    // Green boundary highlighting must remain inside coverage, never over a protected neighbour.
    expect(pixel(49, 50)[2]).toBeGreaterThan(pixel(49, 50)[1]!);
    expect(pixel(50, 50)[1]).toBeGreaterThan(pixel(50, 50)[2]!);
  }
  expect(original).toEqual(copy);
  expect(preview.instruction).toContain("不是生成结果或验收通过证明");
});

it("counts overlapping polygons as a union matching actual protected-pixel composition", async () => {
  const original = await source(100, 100);
  const regions: EditRegions = [
    { label: "head", points: [[.1, .1], [.6, .1], [.6, .6], [.1, .6]] },
    { label: "body", points: [[.4, .4], [.9, .4], [.9, .9], [.4, .9]] },
  ];
  const preview = await imageEditPreview(original, regions);
  expect(preview.coverage.editablePixels).toBe(2500 + 2500 - 400);
  const replacement = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#f00" } }).png().toBuffer();
  const actual = await preserveOutsideRegions(original, replacement, regions);
  expect(actual.preservation.editablePixels).toBe(preview.coverage.editablePixels);
  expect(actual.preservation.protectedPixels).toBe(preview.coverage.protectedPixels);
});

it("binds the digest to the source and exact validated outlines while exposing original-coordinate mapping", async () => {
  const original = await source(), first = await imageEditPreview(original, region),
    repeat = await imageEditPreview(original, region);
  expect(repeat.digest).toBe(first.digest);
  const changed: EditRegions = [{ label: "body", points: [[.2, .25], [.75, .25], [.75, .75], [.2, .75]] }];
  expect((await imageEditPreview(original, changed)).digest).not.toBe(first.digest);
  expect((await imageEditPreview(await source(201, 100), region)).digest).not.toBe(first.digest);
  const view = first.local, sourceX = 90, sourceY = 55;
  const pngX = view.contentRect.left + (sourceX - view.sourceRect.left) * view.contentRect.width / view.sourceRect.width,
    pngY = view.contentRect.top + (sourceY - view.sourceRect.top) * view.contentRect.height / view.sourceRect.height;
  expect(view.sourceRect.left + (pngX - view.contentRect.left) * view.sourceRect.width / view.contentRect.width).toBeCloseTo(sourceX);
  expect(view.sourceRect.top + (pngY - view.contentRect.top) * view.sourceRect.height / view.contentRect.height).toBeCloseTo(sourceY);
});

it.each([[4000, 2000], [2000, 4000]])("bounds both PNG views to 1600 without losing their source coordinates (%s×%s)", async (width, height) => {
  const preview = await imageEditPreview(await source(width, height), region);
  expect(preview.source).toMatchObject({ width, height });
  for (const view of [preview.full, preview.local]) {
    const size = await sharp(view.data).metadata();
    expect(Math.max(size.width!, size.height!)).toBeLessThanOrEqual(1600);
    expect(view.contentRect.top).toBe(48);
    expect(view.contentRect.width).toBeLessThanOrEqual(view.width);
    expect(view.contentRect.height).toBeLessThan(view.height);
  }
});

it("rejects invalid geometry and outlines too small to cover source pixels before any external work", async () => {
  const original = await source(20, 20), copy = Buffer.from(original);
  await expect(imageEditPreview(original, [{ label: "crossed", points: [[.1, .1], [.9, .8], [.1, .9], [.8, .1]] }])).rejects.toThrow("自交");
  await expect(imageEditPreview(original, [{ label: "too small", points: [[.5, .5], [.502, .5], [.501, .502]] }])).rejects.toThrow("没有覆盖任何原图像素");
  expect(original).toEqual(copy);
});
