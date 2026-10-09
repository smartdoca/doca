import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import type { DB } from "@db/index.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import {
  editMask,
  editRegionsSchema,
} from "../apps/server/src/services/ai/image-edit-regions.js";
import * as masks from "../apps/server/src/services/ai/image-edit-mask.js";
import {
  imageMaskGeometryInputSchema,
  imageMaskGeometryOutputSchema,
  imageMaskPixelGeometry,
  readImageMaskGeometry,
} from "../apps/server/src/services/ai/image-mask-geometry.js";

afterEach(() => vi.restoreAllMocks());
const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  width: number,
  height: number,
) => ({
  label: "fixture",
  points: [
    [x / width, y / height],
    [(x + w) / width, y / height],
    [(x + w) / width, (y + h) / height],
    [x / width, (y + h) / height],
  ] as [number, number][],
});
function set(
  pixels: Buffer,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value = 255,
) {
  for (let row = y; row < y + h; row++)
    pixels.fill(value, row * width + x, row * width + x + w);
}
async function actualRaster(
  geometry: NonNullable<
    Awaited<ReturnType<typeof imageMaskPixelGeometry>>["geometry"]
  >,
  width: number,
  height: number,
) {
  const original = await sharp({
    create: { width, height, channels: 4, background: "white" },
  })
    .png()
    .toBuffer();
  const selected = Buffer.alloc(width * height);
  for (const [key, value] of [
    ["include", 255],
    ["exclude", 0],
  ] as const) {
    if (!geometry[key].length) continue;
    const mask = await editMask(original, geometry[key]);
    const alpha = await sharp(mask)
      .ensureAlpha()
      .extractChannel(3)
      .raw()
      .toBuffer();
    for (let i = 0; i < selected.length; i++)
      if (alpha[i] === 0) selected[i] = value;
  }
  return selected;
}
async function exact(pixels: Buffer, width: number, height: number) {
  const result = await imageMaskPixelGeometry(pixels, width, height);
  expect(result.state).toBe("ready");
  expect(result.geometry).not.toBeNull();
  expect(result.diagnostics.roundTripExact).toBe(true);
  expect(
    (await actualRaster(result.geometry!, width, height)).equals(pixels),
  ).toBe(true);
  if (result.geometry!.include.length)
    expect(editRegionsSchema.safeParse(result.geometry!.include).success).toBe(
      true,
    );
  if (result.geometry!.exclude.length)
    expect(editRegionsSchema.safeParse(result.geometry!.exclude).success).toBe(
      true,
    );
  return result;
}
it("merges integer pixel runs vertically and returns existing exact selection without closing duplicate points", async () => {
  const width = 31,
    height = 23,
    pixels = Buffer.alloc(width * height);
  set(pixels, width, 0, 0, 2, 7);
  set(pixels, width, 5, 4, 10, 12);
  set(pixels, width, 30, 22, 1, 1);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.rectangleCount).toBe(3);
  expect(result.geometry!.include).toHaveLength(3);
  expect(result.geometry!.proposalIds).toEqual([]);
  expect(result.diagnostics.selectedPixels).toBe(135);
  expect(result.diagnostics.bounds).toEqual({ left: 0, top: 0, width, height });
});
it("preserves holes, disconnected islands and page edges in the actual existing sharp SVG raster", async () => {
  const width = 83,
    height = 61,
    pixels = Buffer.alloc(width * height);
  set(pixels, width, 0, 0, 37, 39);
  set(pixels, width, 4, 5, 13, 21, 0);
  set(pixels, width, 8, 9, 3, 3);
  set(pixels, width, 72, 53, 11, 8);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.selectedPixels).toBe(1267);
  expect(result.diagnostics.algorithm).toBe("rectangles");
});
it("uses exact orthogonal contours when tiny run rectangles violate the unchanged normalized minimum area", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  for (let i = 0; i < 30; i++) set(pixels, width, 20 + i, 20 + i, 2, 1);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.rectangleCount).toBe(30);
  expect(result.diagnostics.algorithm).toBe("contours");
  expect(result.geometry!.include).toHaveLength(1);
  expect(result.diagnostics.selectedPixels).toBe(60);
});
it("contour fallback keeps a hole and disconnected external parts rather than filling or bridging them", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  // A thin staircase forces contour fallback. The large ring has a true hole.
  for (let i = 0; i < 25; i++) set(pixels, width, 20 + i, 20 + i, 2, 1);
  set(pixels, width, 80, 80, 30, 30);
  set(pixels, width, 85, 85, 20, 20, 0);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.algorithm).toBe("contours");
  expect(result.geometry!.include).toHaveLength(2);
  expect(result.geometry!.exclude).toHaveLength(1);
  expect(result.diagnostics.selectedPixels).toBe(550);
});
it("uses fractional rectangle bounds for an isolated one-pixel region without adding selected pixels", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  set(pixels, width, 300, 301, 1, 1);
  set(pixels, width, 400, 401, 10, 10);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.algorithm).toBe("rectangles");
  expect(result.diagnostics.selectedPixels).toBe(101);
  expect(result.geometry!.include).toHaveLength(2);
  expect(result.geometry!.include[0]!.points[0]![0] * width).toBeLessThan(300);
  expect(result.geometry!.include[1]!.points).toEqual(
    rect(400, 401, 10, 10, width, height).points,
  );
  expect(pixels[301 * width + 300]).toBe(255);
});
it.each([
  [1, 1],
  [2, 1],
  [1, 2],
])(
  "represents an isolated %ix%i tiny rectangle under the unchanged area and SVG rules",
  async (w, h) => {
    const width = 1500,
      height = 2000,
      pixels = Buffer.alloc(width * height);
    set(pixels, width, 300, 301, w, h);
    const result = await exact(pixels, width, height);
    expect(result.diagnostics.selectedPixels).toBe(w * h);
    expect(result.geometry!.include).toHaveLength(1);
    expect(result.geometry!.exclude).toEqual([]);
  },
);
function minimumContourFixture(
  width = 1500,
  height = 2000,
  x = 1051,
  y = 1400,
) {
  const pixels = Buffer.alloc(width * height);
  // More than 100 run rectangles force contours without exceeding 200
  // vertices per polygon. Nearby one-pixel islands still require tab encoding.
  for (let i = 0; i < 20; i++) set(pixels, width, 50 + i, 50 + i, 2, 1);
  for (let i = 0; i < 84; i++)
    set(
      pixels,
      width,
      40 + (i % 42) * 30,
      900 + Math.floor(i / 42) * 100,
      1,
      1,
    );
  set(pixels, width, 500, 950, 1, 1);
  set(pixels, width, 502, 950, 1, 1);
  set(pixels, width, x, y, 2, 1);
  set(pixels, width, x, y + 1, 1, 1);
  return { pixels, width, height };
}
it("keeps a three-pixel nonrectangular island when normalized area cancellation blocks the entire contour fallback", async () => {
  const { pixels, width, height } = minimumContourFixture();
  const x = 1051,
    y = 1400;
  const integerContour = {
    label: "three-pixel L",
    points: [
      [x, y],
      [x + 2, y],
      [x + 2, y + 1],
      [x + 1, y + 1],
      [x + 1, y + 2],
      [x, y + 2],
    ].map(([px, py]) => [px! / width, py! / height]),
  };
  // The existing validator remains strict: the unadjusted normalized
  // shoelace area is 9.999999999732445e-7, even though native area is 3.
  expect(editRegionsSchema.safeParse([integerContour]).success).toBe(false);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.rectangleCount).toBeGreaterThan(100);
  expect(result.diagnostics.algorithm).toBe("contours");
  expect(result.diagnostics.selectedPixels).toBe(129);
  expect(result.geometry!.exclude).toEqual([]);
  expect(result.geometry!.include.length).toBeLessThanOrEqual(100);
  expect(result.geometry!.include.every((r) => r.points.length <= 200)).toBe(
    true,
  );
});
it("keeps the integer minimum-area contour at the existing 25-million-pixel canvas limit", async () => {
  const width = 5000,
    height = 5000,
    pixels = Buffer.alloc(width * height),
    x = 3503,
    y = 3500;
  // This orthogonal contour has exactly 25 native pixels and normalized
  // floating area just below 1e-6. Its chosen binary support cannot grow.
  set(pixels, width, x, y, 1, 1);
  set(pixels, width, x, y + 1, 6, 4);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.selectedPixels).toBe(25);
  expect(result.geometry!.exclude).toEqual([]);
});
it("does not enlarge a genuinely undersized nonrectangle merely to satisfy the area validator", async () => {
  const { pixels, width, height } = minimumContourFixture(2000, 2000);
  // The three-pixel L is genuinely below this canvas's four-pixel minimum.
  const result = await imageMaskPixelGeometry(pixels, width, height);
  expect(result.state).toBe("unrepresentable");
  expect(result.geometry).toBeNull();
  expect(result.diagnostics.roundTripExact).toBe(false);
  expect(result.diagnostics.selectedPixels).toBe(129);
});
it("rejects the whole contour group when a minimum-area numerical margin would leave the canvas", async () => {
  const { pixels, width, height } = minimumContourFixture(
    1500,
    2000,
    1498,
    1400,
  );
  const result = await imageMaskPixelGeometry(pixels, width, height);
  expect(result.state).toBe("unrepresentable");
  expect(result.geometry).toBeNull();
  expect(result.diagnostics.roundTripExact).toBe(false);
  expect(result.diagnostics.selectedPixels).toBe(129);
});

function contourHoleFixture(holes: [number, number, number, number][]) {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  // Over 100 run rectangles force the existing contour path, while keeping
  // its components and every contour within their unchanged limits.
  for (let i = 0; i < 90; i++)
    set(
      pixels,
      width,
      700 + (i % 10) * 15,
      100 + Math.floor(i / 10) * 15,
      5,
      5,
    );
  for (let i = 0; i < 20; i++) set(pixels, width, 20 + i, 20 + i, 2, 1);
  set(pixels, width, 290, 291, 30, 30);
  for (const [x, y, w, h] of holes) set(pixels, width, x, y, w, h, 0);
  return { width, height, pixels };
}
it.each([
  [1, 1],
  [2, 1],
  [1, 2],
])(
  "preserves an isolated %ix%i hole through the complete include/exclude raster",
  async (w, h) => {
    const { pixels, width, height } = contourHoleFixture([[300, 301, w, h]]);
    const result = await exact(pixels, width, height);
    expect(result.diagnostics.algorithm).toBe("contours");
    expect(result.geometry!.exclude).toHaveLength(1);
    expect(result.diagnostics.selectedPixels).toBe(3190 - w * h);
  },
);
it.each([
  [0, 301, 1, 1],
  [1499, 301, 1, 1],
  [300, 0, 2, 1],
  [300, 1999, 2, 1],
  [0, 0, 1, 1],
])(
  "keeps a tiny rectangle at %i,%i (%ix%i) with a complete on-canvas tab encoding",
  async (x, y, w, h) => {
    const width = 1500,
      height = 2000,
      pixels = Buffer.alloc(width * height);
    set(pixels, width, x, y, w, h);
    const result = await exact(pixels, width, height);
    expect(result.diagnostics.selectedPixels).toBe(w * h);
    expect(result.geometry!.include[0]!.points).toHaveLength(8);
    for (const [px, py] of result.geometry!.include[0]!.points) {
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(1);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(1);
    }
  },
);
it("rejects the whole selection when no fixed tab schedule keeps every corner on canvas", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  for (const [x, y] of [
    [0, 0],
    [1499, 0],
    [0, 1999],
    [1499, 1999],
  ])
    set(pixels, width, x!, y!, 1, 1);
  const result = await imageMaskPixelGeometry(pixels, width, height);
  expect(result.state).toBe("unrepresentable");
  expect(result.geometry).toBeNull();
  expect(result.diagnostics.selectedPixels).toBe(4);
  expect(result.diagnostics.roundTripExact).toBe(false);
});
it.each([
  [302, 301],
  [301, 302],
])(
  "preserves nearby one-pixel islands at 300,301 and %i,%i after rejecting unsafe centered bounds",
  async (x, y) => {
    const width = 1500,
      height = 2000,
      pixels = Buffer.alloc(width * height);
    set(pixels, width, 300, 301, 1, 1);
    set(pixels, width, x, y, 1, 1);
    const result = await exact(pixels, width, height);
    expect(result.diagnostics.selectedPixels).toBe(2);
    expect(
      result.geometry!.include.map((region) => region.points.length),
    ).toEqual([8, 8]);
  },
);
it("preserves nearby one-pixel holes after rejecting unsafe combined centered exclusion alpha", async () => {
  const { pixels, width, height } = contourHoleFixture([
    [300, 301, 1, 1],
    [302, 301, 1, 1],
  ]);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.algorithm).toBe("contours");
  expect(result.diagnostics.selectedPixels).toBe(3188);
  expect(
    result.geometry!.exclude.map((region) => region.points.length),
  ).toEqual([8, 8]);
});
it("does not accept seven overlapping sub-threshold tabs that accumulate alpha above the selection threshold", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  const east = [...Array(7)].map((_, i) => {
    const x = 300 + i * 2,
      y = 301;
    set(pixels, width, x, y, 1, 1);
    return {
      label: "unsafe overlapping tab",
      points: [
        [x, y],
        [x + 1, y],
        [x + 1, y + 0.45],
        [x + 21.001, y + 0.45],
        [x + 21.001, y + 0.55],
        [x + 1, y + 0.55],
        [x + 1, y + 1],
        [x, y + 1],
      ].map(([px, py]) => [px! / width, py! / height] as [number, number]),
    };
  });
  expect(editRegionsSchema.safeParse(east).success).toBe(true);
  const unsafe = await actualRaster(
    { proposalIds: [], include: east, exclude: [] },
    width,
    height,
  );
  expect(
    unsafe.reduce(
      (sum, value, i) => sum + (value === 255 && pixels[i] === 0 ? 1 : 0),
      0,
    ),
  ).toBe(8);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.selectedPixels).toBe(7);
  // East and west both overlap; the bounded schedule must test another whole candidate.
  expect(
    result.geometry!.include.every(
      (region) => Math.max(...region.points.map(([, y]) => y * height)) > 321,
    ),
  ).toBe(true);
});
it("preserves all four cross neighbors without selecting the center background pixel", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  for (const [x, y] of [
    [300, 301],
    [302, 301],
    [301, 300],
    [301, 302],
  ])
    set(pixels, width, x!, y!, 1, 1);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.selectedPixels).toBe(4);
  expect(
    result.geometry!.include.every((region) => region.points.length === 8),
  ).toBe(true);
  expect(pixels[301 * width + 301]).toBe(0);
});
it("roundtrips the isolated 89-pixel contact pattern with its complete selection digest", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  // Synthetic binary geometry only; no user image or runtime receipt fixture.
  const rectangles = [
    [1292, 1259, 1, 1],
    [1285, 1260, 6, 1],
    [1283, 1261, 5, 1],
    [1281, 1262, 3, 1],
    [1278, 1263, 2, 1],
    [1274, 1264, 4, 1],
    [1272, 1265, 4, 1],
    [1270, 1266, 4, 1],
    [1268, 1267, 4, 1],
    [1267, 1268, 2, 1],
    [1249, 1360, 2, 1],
    [1246, 1361, 6, 1],
    [1245, 1362, 8, 2],
    [1244, 1364, 9, 1],
    [1244, 1365, 10, 1],
    [1247, 1366, 7, 1],
    [1250, 1367, 4, 1],
  ];
  for (const [x, y, w, h] of rectangles) set(pixels, width, x!, y!, w!, h!);
  const digest =
    "7f16f61bf41672db6c65cffd504ea9135e7b23ac443e06a05caa5086a59521eb";
  expect(createHash("sha256").update(pixels).digest("hex")).toBe(digest);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.selectedPixels).toBe(89);
  expect(result.diagnostics.selectionSha256).toBe(digest);
});
it("roundtrips the entire 1514-pixel contact pattern without truncating parts outside the two contact clips", async () => {
  const width = 1500,
    height = 2000,
    pixels = Buffer.alloc(width * height);
  // Binary geometry only, reconstructed from run lengths. No source image,
  // proposal asset or formal receipt is included in this fixture.
  const rectangles = [
    [1292, 1259, 1, 1],
    [1285, 1260, 6, 1],
    [1283, 1261, 5, 1],
    [1281, 1262, 3, 1],
    [1278, 1263, 2, 1],
    [1274, 1264, 4, 1],
    [1272, 1265, 4, 1],
    [1270, 1266, 4, 1],
    [1268, 1267, 4, 1],
    [1267, 1268, 2, 1],
    [1249, 1360, 2, 1],
    [1246, 1361, 6, 1],
    [1245, 1362, 8, 2],
    [1244, 1364, 9, 1],
    [1244, 1365, 10, 1],
    [1247, 1366, 7, 1],
    [1250, 1367, 4, 1],
    [746, 1432, 2, 1],
    [744, 1433, 5, 1],
    [745, 1434, 4, 1],
    [745, 1435, 3, 1],
    [746, 1436, 2, 1],
    [712, 1444, 2, 1],
    [711, 1445, 8, 1],
    [710, 1446, 10, 1],
    [709, 1447, 12, 1],
    [708, 1448, 15, 1],
    [707, 1449, 17, 2],
    [706, 1451, 19, 1],
    [705, 1452, 20, 2],
    [704, 1454, 21, 1],
    [703, 1455, 22, 1],
    [702, 1456, 23, 2],
    [701, 1458, 24, 4],
    [758, 1459, 1, 1],
    [757, 1460, 3, 2],
    [700, 1462, 25, 1],
    [756, 1462, 5, 1],
    [700, 1463, 24, 3],
    [755, 1463, 6, 1],
    [754, 1464, 8, 1],
    [753, 1465, 10, 1],
    [700, 1466, 25, 5],
    [749, 1466, 14, 1],
    [751, 1467, 12, 1],
    [752, 1468, 10, 1],
    [756, 1469, 4, 1],
    [701, 1471, 24, 4],
    [702, 1475, 23, 2],
    [703, 1477, 22, 3],
    [704, 1480, 21, 1],
    [705, 1481, 20, 2],
    [708, 1483, 17, 1],
    [712, 1484, 14, 1],
    [714, 1485, 12, 1],
    [716, 1486, 10, 1],
    [719, 1487, 7, 1],
    [720, 1488, 7, 1],
    [720, 1489, 6, 1],
    [721, 1490, 4, 1],
    [722, 1491, 2, 1],
    [729, 1491, 3, 1],
    [722, 1492, 1, 1],
    [728, 1492, 9, 1],
    [726, 1493, 13, 1],
    [724, 1494, 16, 1],
    [727, 1495, 14, 1],
    [731, 1496, 12, 1],
    [733, 1497, 13, 1],
    [735, 1498, 13, 1],
    [738, 1499, 12, 1],
    [740, 1500, 11, 1],
    [742, 1501, 10, 1],
    [743, 1502, 9, 1],
    [744, 1503, 9, 1],
    [746, 1504, 9, 1],
    [747, 1505, 10, 1],
    [749, 1506, 10, 1],
    [750, 1507, 11, 1],
    [751, 1508, 11, 1],
    [753, 1509, 10, 1],
    [755, 1510, 9, 1],
    [757, 1511, 7, 1],
    [759, 1512, 8, 1],
    [761, 1513, 10, 1],
    [762, 1514, 10, 1],
    [764, 1515, 9, 1],
    [766, 1516, 9, 1],
    [768, 1517, 8, 1],
    [771, 1518, 6, 1],
    [773, 1519, 5, 1],
    [774, 1520, 5, 1],
    [775, 1521, 5, 1],
    [776, 1522, 6, 1],
    [778, 1523, 6, 1],
    [780, 1524, 5, 1],
    [783, 1525, 3, 1],
    [784, 1526, 3, 1],
    [786, 1527, 2, 1],
    [787, 1528, 4, 1],
    [788, 1529, 8, 1],
    [789, 1530, 13, 1],
    [791, 1531, 15, 1],
    [792, 1532, 15, 1],
    [801, 1533, 7, 1],
    [802, 1534, 6, 1],
    [804, 1535, 5, 1],
    [805, 1536, 1, 1],
    [843, 1553, 2, 1],
    [844, 1554, 3, 1],
    [845, 1555, 3, 1],
    [846, 1556, 4, 1],
    [847, 1557, 5, 1],
    [848, 1558, 5, 1],
    [851, 1559, 3, 1],
    [854, 1560, 2, 1],
    [856, 1561, 3, 1],
    [859, 1562, 3, 1],
    [861, 1563, 4, 1],
    [864, 1564, 2, 1],
    [866, 1565, 1, 1],
    [867, 1566, 1, 1],
    [868, 1567, 1, 1],
  ];
  for (const [x, y, w, h] of rectangles) set(pixels, width, x!, y!, w!, h!);
  const digest =
    "db72e392b020014e75babdcb2801bb4d5ccc7554e5252f2bb32361b8196a3955";
  expect(createHash("sha256").update(pixels).digest("hex")).toBe(digest);
  let outsideContactClips = 0;
  for (let i = 0; i < pixels.length; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    if (
      pixels[i] === 255 &&
      !(x >= 1200 && x < 1320 && y >= 1220 && y < 1455) &&
      !(x >= 660 && x < 790 && y >= 1360 && y < 1570)
    )
      outsideContactClips++;
  }
  expect(outsideContactClips).toBe(110);
  const result = await exact(pixels, width, height);
  expect(result.diagnostics.selectedPixels).toBe(1514);
  expect(result.diagnostics.rectangleCount).toBe(123);
  expect(result.diagnostics.selectionSha256).toBe(digest);
  expect(result.diagnostics.algorithm).toBe("contours");
  expect(result.geometry!.include).toHaveLength(16);
  expect(
    result.geometry!.include.some((region) => region.points.length === 8),
  ).toBe(true);
});
it("fails the entire geometry when there are more than 100 disconnected components", async () => {
  const width = 100,
    height = 100,
    pixels = Buffer.alloc(width * height);
  for (let i = 0; i < 101; i++)
    set(pixels, width, (i % 10) * 10, Math.floor(i / 10) * 5, 2, 2);
  const result = await imageMaskPixelGeometry(pixels, width, height);
  expect(result.state).toBe("unrepresentable");
  expect(result.geometry).toBeNull();
  expect(result.diagnostics.selectedPixels).toBe(404);
  expect(result.diagnostics.rectangleCount).toBe(101);
  expect(result.diagnostics.failure).toContain("100-region");
});
it("fails exact contours beyond 200 vertices without simplification or truncated output", async () => {
  const width = 1000,
    height = 1000,
    pixels = Buffer.alloc(width * height);
  for (let i = 0; i < 110; i++) set(pixels, width, 10 + i, 10 + i, 2, 1);
  const result = await imageMaskPixelGeometry(pixels, width, height);
  expect(result.state).toBe("unrepresentable");
  expect(result.geometry).toBeNull();
  expect(result.diagnostics.failure).toContain("200");
  expect(result.diagnostics.selectedPixels).toBe(220);
});
it("empty selections are exact and no editable authority is invented", async () => {
  const result = await exact(Buffer.alloc(35), 7, 5);
  expect(result.geometry).toEqual({
    proposalIds: [],
    include: [],
    exclude: [],
  });
  expect(result.diagnostics.bounds).toBeNull();
  expect(result.diagnostics.selectedPixels).toBe(0);
});
it("rejects invalid binary values, dimensions, oversized images and model-controlled paths", async () => {
  await expect(
    imageMaskPixelGeometry(Buffer.from([128]), 1, 1),
  ).rejects.toThrow();
  await expect(
    imageMaskPixelGeometry(Buffer.alloc(1), NaN, 1),
  ).rejects.toThrow();
  await expect(
    imageMaskPixelGeometry(Buffer.alloc(1), 1.5, 1),
  ).rejects.toThrow();
  await expect(
    imageMaskPixelGeometry(Buffer.alloc(1), 25_000_001, 1),
  ).rejects.toThrow();
  expect(
    imageMaskGeometryInputSchema.safeParse({
      maskReceiptId: randomUUID(),
      selection: "conflicts",
      sourcePath: "/tmp/file",
    }).success,
  ).toBe(false);
});
function fixture() {
  const width = 31,
    height = 23,
    length = width * height;
  const s = Buffer.alloc(length),
    g = Buffer.alloc(length),
    p = Buffer.alloc(length),
    t = Buffer.alloc(length),
    conflicts = Buffer.alloc(length);
  set(s, width, 3, 2, 10, 12);
  set(g, width, 7, 4, 12, 10);
  set(p, width, 9, 1, 8, 17);
  set(t, width, 10, 8, 2, 2);
  for (let i = 0; i < length; i++)
    if (p[i] === 255 && (s[i] === 255 || g[i] === 255 || t[i] === 255))
      conflicts[i] = 255;
  const receipt = {
    receiptId: randomUUID(),
    digest: "a".repeat(64),
    maskDigest: "b".repeat(64),
    source: { width, height, referenceImageId: randomUUID() },
    raw: { generationOperationId: randomUUID() },
  };
  const value = {
    receipt,
    computed: {
      s: { pixels: s },
      g: { pixels: g },
      p: { pixels: p },
      t: { pixels: t },
      conflicts,
    },
  } as unknown as Awaited<ReturnType<typeof masks.readImageEditMask>>;
  const reader = vi.spyOn(masks, "readImageEditMask").mockResolvedValue(value);
  return { width, height, s, g, p, t, conflicts, receipt, reader };
}
const db = {} as DB,
  ctx = {} as ToolContext;
it("reads strict authorized receipts and computes G∩P∩clip minus text, while source/conflicts remain separate diagnostics", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const input = {
    maskReceiptId: f.receipt.receiptId,
    selection: "generated-protected" as const,
    clipRegions: [rect(11, 5, 5, 8, f.width, f.height)],
  };
  const result = await readImageMaskGeometry(db, ctx, input, { signal });
  expect(f.reader).toHaveBeenCalledWith(db, ctx, input.maskReceiptId, {
    signal,
  });
  expect(imageMaskGeometryOutputSchema.safeParse(result).success).toBe(true);
  expect(result.diagnostics.semanticCoverage).toBe("unverified");
  expect(result.instruction).toContain("不是真实轮廓、遮挡授权或语义验收");
  expect(result.instruction).toContain("仅用于当前version:2蒙版selection");
  expect(result.instruction).toContain(
    "不能复用为生成editRegions、编辑窗口或描边",
  );
  const expected = Buffer.alloc(f.width * f.height);
  set(expected, f.width, 11, 5, 5, 8);
  set(expected, f.width, 11, 8, 1, 2, 0);
  expect(await actualRaster(result.geometry!, f.width, f.height)).toEqual(
    expected,
  );
  const source = await readImageMaskGeometry(db, ctx, {
    maskReceiptId: input.maskReceiptId,
    selection: "source-protected",
  });
  const sourcePixels = Buffer.alloc(expected.length);
  for (let i = 0; i < expected.length; i++)
    if (f.s[i] === 255 && f.p[i] === 255) sourcePixels[i] = 255;
  expect(await actualRaster(source.geometry!, f.width, f.height)).toEqual(
    sourcePixels,
  );
  const conflict = await readImageMaskGeometry(db, ctx, {
    maskReceiptId: input.maskReceiptId,
    selection: "conflicts",
  });
  expect(await actualRaster(conflict.geometry!, f.width, f.height)).toEqual(
    f.conflicts,
  );
});
it("does not manufacture output after authorization/binding failure or cancellation", async () => {
  const f = fixture();
  const error = new Error("authorization or binding changed");
  f.reader.mockRejectedValueOnce(error);
  await expect(
    readImageMaskGeometry(db, ctx, {
      maskReceiptId: f.receipt.receiptId,
      selection: "conflicts",
    }),
  ).rejects.toBe(error);
  const controller = new AbortController();
  controller.abort();
  await expect(
    readImageMaskGeometry(
      db,
      ctx,
      { maskReceiptId: f.receipt.receiptId, selection: "conflicts" },
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
});
