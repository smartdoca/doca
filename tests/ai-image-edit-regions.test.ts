import { it, expect } from "vitest";
import sharp from "sharp";
import {
  preserveOutsideRegions,
  editRegionsSchema,
  editViewport,
  restoreViewport,
} from "../apps/server/src/services/ai/image-edit-regions.js";
import { seedreamRegionPrompt } from "../apps/server/src/services/ai/image-edit-adapter.js";
it("locates native Seedream edits in the remapped window without sending polygon arrays or leaking original page coordinates", async () => {
  const base = await sharp({
    create: { width: 400, height: 600, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const regions = [
    {
      label: "妈妈脸部",
      points: [
        [0.4, 0.3],
        [0.6, 0.3],
        [0.6, 0.5],
        [0.4, 0.5],
      ] as [number, number][],
    },
  ];
  const window = await editViewport(base, regions);
  const prompt = seedreamRegionPrompt(
    "用图2的妈妈替换脸部，保留原姿态。",
    window.regions,
  );
  const coords = prompt
    .match(/<bbox>(\d+) (\d+) (\d+) (\d+)<\/bbox>/)!
    .slice(1)
    .map(Number);
  const [left, top] = window.regions[0]!.points[0]!;
  expect(coords.slice(0, 2)).toEqual([
    Math.round(left * 1000),
    Math.round(top * 1000),
  ]);
  expect(prompt).toContain("局部窗口");
  expect(prompt).toContain("用图2的妈妈替换脸部");
  expect(prompt).toContain("框内其他物体与背景仍须保留");
  expect(prompt).not.toContain("points");
  expect(
    seedreamRegionPrompt("替换", [
      {
        label: "边缘",
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    ]),
  ).toContain("<bbox>0 0 999 999</bbox>");
});
it("preserves every protected pixel exactly while replacing only the polygon interior", async () => {
  const width = 33,
    height = 21;
  const source = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    source[i * 4] = i % 255;
    source[i * 4 + 1] = (i * 13) % 255;
    source[i * 4 + 2] = (i * 19) % 255;
    source[i * 4 + 3] = 255;
  }
  const base = await sharp(source, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  const generated = await sharp({
    create: {
      width: 66,
      height: 42,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const out = await preserveOutsideRegions(base, generated, [
    {
      label: "head",
      points: [
        [0.2, 0.2],
        [0.8, 0.2],
        [0.5, 0.8],
      ],
    },
  ]);
  const pixels = await sharp(out.data).ensureAlpha().raw().toBuffer();
  let changed = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (x < 5 || x > 27 || y < 3 || y > 18)
        expect(pixels.subarray(i, i + 4)).toEqual(source.subarray(i, i + 4));
      if (!pixels.subarray(i, i + 4).equals(source.subarray(i, i + 4)))
        changed++;
    }
  expect(changed).toBeGreaterThan(0);
  expect(out.preservation.changedPixels).toBe(changed);
  expect(out.preservation.protectedPixelsChanged).toBe(0);
  expect(out.info).toMatchObject({ format: "png", width, height });
});
it("maps a local edit window back to the original page without scaling the scene or changing protected pixels", async () => {
  const base = await sharp({
    create: { width: 400, height: 600, channels: 4, background: "#183c59" },
  })
    .png()
    .toBuffer();
  const regions = [
    {
      label: "face",
      points: [
        [0.4, 0.3],
        [0.6, 0.3],
        [0.6, 0.5],
        [0.4, 0.5],
      ] as [number, number][],
    },
  ];
  const viewport = await editViewport(base, regions);
  expect(viewport.rect.width).toBeLessThan(200);
  expect(viewport.rect.height).toBeLessThan(200);
  const [point] = viewport.regions[0]!.points;
  expect(point![0] * viewport.rect.width + viewport.rect.left).toBeCloseTo(160);
  expect(point![1] * viewport.rect.height + viewport.rect.top).toBeCloseTo(180);
  const generated = await sharp({
    create: { width: 500, height: 500, channels: 4, background: "#f8a722" },
  })
    .png()
    .toBuffer();
  const out = await preserveOutsideRegions(
    base,
    await restoreViewport(base, generated, viewport.rect),
    regions,
  );
  const image = await sharp(out.data).ensureAlpha().raw().toBuffer();
  const pixel = (x: number, y: number) =>
    Array.from(image.subarray((y * 400 + x) * 4, (y * 400 + x) * 4 + 4));
  expect(pixel(200, 240)).toEqual([248, 167, 34, 255]);
  expect(pixel(150, 240)).toEqual([24, 60, 89, 255]);
  expect(out.info).toMatchObject({ width: 400, height: 600 });
  expect(out.preservation.protectedPixelsChanged).toBe(0);
});
it("rejects empty, degenerate and out of bounds outlines before a paid request", () => {
  for (const points of [
    [],
    [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ],
    [
      [0, 0],
      [1.1, 0],
      [1, 1],
    ],
  ])
    expect(
      editRegionsSchema.safeParse([{ label: "head", points }]).success,
    ).toBe(false);
  expect(editRegionsSchema.safeParse([]).success).toBe(false);
  expect(editRegionsSchema.safeParse([{ label: "too many", points: Array.from({ length: 201 }, (_, i) => [i / 202, .5]) }]).success).toBe(false);
});

it.each([
  ["bow tie", [[.1, .1], [.9, .9], [.1, .9], [.9, .1]]],
  ["nonzero-area crossing", [[.1, .1], [.9, .8], [.1, .9], [.8, .1]]],
  ["zero-length edge", [[.1, .1], [.9, .1], [.9, .1], [.9, .9], [.1, .9]]],
  ["adjacent backtrack", [[.1, .1], [.9, .1], [.5, .1], [.5, .9], [.1, .9]]],
  ["nonadjacent touch", [[.1, .1], [.9, .1], [.9, .9], [.5, .5], [.1, .9], [.5, .5]]],
  ["nonadjacent overlap", [[.1, .1], [.9, .1], [.9, .9], [.1, .9], [.1, .5], [.8, .5], [.8, .1], [.3, .1], [.3, .4], [.1, .4]]],
])("rejects %s without repairing or changing supplied vertices", (_name, points) => {
  const input = [{ label: "target", points }];
  const before = JSON.stringify(input);
  expect(editRegionsSchema.safeParse(input).success).toBe(false);
  expect(JSON.stringify(input)).toBe(before);
});

it("explicitly rejects a repeated closing vertex rather than converting it", () => {
  const points = [[.1, .1], [.9, .1], [.9, .9], [.1, .9], [.1, .1]];
  const result = editRegionsSchema.safeParse([{ label: "head", points }]);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]!.message).toContain("不应重复首点闭合");
  expect(points).toHaveLength(5);
});

it("accepts simple concave polygons in either direction and straight consecutive edges", () => {
  const concave = [[.1, .1], [.8, .1], [.8, .4], [.4, .4], [.4, .8], [.1, .8]];
  for (const points of [concave, [...concave].reverse(), [[.1, .1], [.5, .1], [.9, .1], [.9, .9], [.1, .9]]])
    expect(editRegionsSchema.safeParse([{ label: "body", points }]).success).toBe(true);
});
