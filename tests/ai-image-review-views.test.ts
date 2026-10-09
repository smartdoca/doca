import { expect, it } from "vitest";
import sharp from "sharp";
import {
  imageReviewDetailPlan,
  imageReviewNativeCrop,
  nativeImageReviewPrompt,
} from "../apps/server/src/services/ai/image-review-views.js";

it.each([
  [1500, 2000, 1, 2, 2],
  [1780, 2357, 2, 2, 4],
  [5000, 5000, 4, 4, 16],
] as const)(
  "fully covers %s×%s within the declared native tile and request budget",
  (width, height, columns, rows, calls) => {
    const plan = imageReviewDetailPlan({ width, height }, { width, height });
    expect([plan.columns, plan.rows, plan.detailCalls]).toEqual([
      columns,
      rows,
      calls,
    ]);
    expect(plan.tiles).toHaveLength(columns * rows);
    expect(plan.detailCalls).toBe(plan.tiles.length);
    const xs = new Set([0, width - 1]),
      ys = new Set([0, height - 1]);
    for (const tile of plan.tiles) {
      expect(
        Math.max(tile.sourceRect.width, tile.sourceRect.height),
      ).toBeLessThanOrEqual(1536);
      expect(tile.sourceRect).toEqual(tile.candidateRect);
      for (const x of [
        tile.sourceRect.left - 1,
        tile.sourceRect.left,
        tile.sourceRect.left + tile.sourceRect.width - 1,
        tile.sourceRect.left + tile.sourceRect.width,
      ])
        if (x >= 0 && x < width) xs.add(x);
      for (const y of [
        tile.sourceRect.top - 1,
        tile.sourceRect.top,
        tile.sourceRect.top + tile.sourceRect.height - 1,
        tile.sourceRect.top + tile.sourceRect.height,
      ])
        if (y >= 0 && y < height) ys.add(y);
    }
    // Every partition/seam/edge cell is covered, including the final row and column.
    for (const x of xs)
      for (const y of ys)
        expect(
          plan.tiles.some(
            ({ sourceRect: r }) =>
              x >= r.left &&
              x < r.left + r.width &&
              y >= r.top &&
              y < r.top + r.height,
          ),
        ).toBe(true);
    if (rows > 1) {
      const first = plan.tiles[0]!.sourceRect,
        next = plan.tiles[columns]!.sourceRect;
      expect(first.top + first.height - next.top).toBeGreaterThanOrEqual(128);
    }
    if (columns > 1) {
      const first = plan.tiles[0]!.sourceRect,
        next = plan.tiles[1]!.sourceRect;
      expect(first.left + first.width - next.left).toBeGreaterThanOrEqual(128);
    }
  },
);

it("maps differing native canvases by normalized location without resizing either crop", async () => {
  const source = { width: 1200, height: 1800 },
    candidate = { width: 1640, height: 2460 };
  const plan = imageReviewDetailPlan(source, candidate);
  expect(plan.detailCalls).toBe(plan.tiles.length);
  const data = await sharp({
    create: {
      ...candidate,
      channels: 4,
      background: { r: 32, g: 178, b: 91, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  for (const tile of plan.tiles) {
    expect(tile.sourceRect.width).not.toEqual(tile.candidateRect.width);
    const crop = await imageReviewNativeCrop(data, tile.candidateRect);
    const meta = await sharp(crop).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([
      tile.candidateRect.width,
      tile.candidateRect.height,
      "png",
    ]);
    expect(
      (await sharp(crop).ensureAlpha().raw().toBuffer()).equals(
        await sharp(data)
          .extract(tile.candidateRect)
          .ensureAlpha()
          .raw()
          .toBuffer(),
      ),
    ).toBe(true);
  }
});

it.each([
  [{ width: 25000, height: 100 }, "超过16块/16次"],
  [{ width: 5001, height: 5001 }, "超过2500万"],
  [{ width: 0, height: 100 }, "无效"],
  [{ width: Infinity, height: 100 }, "无效"],
  [{ width: NaN, height: 100 }, "无效"],
  [{ width: 1.5, height: 100 }, "无效"],
] as const)(
  "refuses an unrepresentable complete coverage plan without partial sampling: %j",
  (size, message) => {
    expect(() =>
      imageReviewDetailPlan(size, { width: 1500, height: 2000 }),
    ).toThrow(message);
  },
);

it("strict review transport keeps PNG bytes and rejects JPEG or oversized native frames instead of converting them", async () => {
  const png = await sharp({
    create: { width: 33, height: 29, channels: 4, background: "#1749a3" },
  })
    .png()
    .toBuffer();
  const prompt = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: png },
        },
      ],
    },
  ];
  expect(await nativeImageReviewPrompt(prompt)).toBe(prompt);
  expect(prompt[0]!.content[0]!.data.data).toEqual(png);
  await expect(
    nativeImageReviewPrompt([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/jpeg",
            data: { type: "data", data: png },
          },
        ],
      },
    ]),
  ).rejects.toThrow("完整PNG");
  const oversized = await sharp({
    create: { width: 1601, height: 20, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await expect(
    nativeImageReviewPrompt([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: oversized },
          },
        ],
      },
    ]),
  ).rejects.toThrow("尺寸或内容不完整");
});
