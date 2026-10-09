import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "@db/index.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import { fail } from "@core/shared/errors.js";
import { editRegionsSchema, type EditRegions } from "./image-edit-regions.js";
import { readImageEditMask } from "./image-edit-mask.js";

const regions = z.union([z.tuple([]), editRegionsSchema]);
const rectangleSchema = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const imageMaskGeometryInputSchema = z
  .object({
    maskReceiptId: z.string().uuid(),
    selection: z.enum(["generated-protected", "source-protected", "conflicts"]),
    clipRegions: editRegionsSchema.optional(),
  })
  .strict();
export type ImageMaskGeometryInput = z.infer<
  typeof imageMaskGeometryInputSchema
>;
const instruction =
  "这是已绑定原尺寸二值蒙版的精确数学编码，不是真实轮廓、遮挡授权或语义验收。编码可能含亚像素边界或细tab，仅用于当前version:2蒙版selection的proposalIds/include/exclude；不能复用为生成editRegions、编辑窗口或描边。ready必须通过既有简单多边形校验及整组include/exclude原尺寸SVG alpha>=128逐像素回验，不能新增或遗漏任何选中像素。generated-protected仅是新人∩保护物∩可选窗口且扣除改字；只有用户已允许的真实新人遮挡才可用于allowedOcclusion，仍须实际对照人物与道具边缘。source-protected及conflicts仅用于诊断，不能自动转为允许遮挡或删除保护区。ready的selection可完整复制到既有proposalIds/include/exclude字段；unrepresentable不返回部分编码，不可扩大、填洞或截断以消除冲突。";
const geometrySchema = z
  .object({
    proposalIds: z.tuple([]),
    include: regions,
    exclude: regions,
  })
  .strict();
const diagnosticsSchema = z
  .object({
    semanticCoverage: z.literal("unverified"),
    selectedPixels: z.number().int().nonnegative(),
    bounds: rectangleSchema.nullable(),
    selectionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rectangleCount: z.number().int().nonnegative().nullable(),
    algorithm: z.enum(["rectangles", "contours"]).nullable(),
    roundTripExact: z.boolean(),
    failure: z.string().nullable(),
  })
  .strict();
export const imageMaskGeometryOutputSchema = z
  .object({
    kind: z.literal("image_mask_geometry"),
    state: z.enum(["ready", "unrepresentable"]),
    maskReceiptId: z.string().uuid(),
    maskReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    maskDigest: z.string().regex(/^[a-f0-9]{64}$/),
    referenceImageId: z.string().uuid(),
    generationOperationId: z.string().uuid(),
    selection: imageMaskGeometryInputSchema.shape.selection,
    clipRegions: regions,
    source: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    geometry: geometrySchema.nullable(),
    diagnostics: diagnosticsSchema,
    instruction: z.literal(instruction),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (
      output.state === "ready"
        ? output.geometry === null ||
          !output.diagnostics.roundTripExact ||
          output.diagnostics.failure !== null ||
          output.diagnostics.algorithm === null
        : output.geometry !== null ||
          output.diagnostics.roundTripExact ||
          output.diagnostics.failure === null ||
          output.diagnostics.algorithm !== null
    )
      ctx.addIssue({
        code: "custom",
        message: "精确几何状态与完整回验事实不一致",
      });
  });
export type ImageMaskGeometryOutput = z.infer<
  typeof imageMaskGeometryOutputSchema
>;
type Rect = z.infer<typeof rectangleSchema>;
type Point = [number, number];
type Edge = { from: Point; to: Point; direction: number; used: boolean };
const MAX_PIXELS = 25_000_000,
  MAX_WORK_ITEMS = 200_000,
  MIN_REGION_AREA = 0.000001,
  AREA_MARGIN_PIXELS = 0.0001,
  TAB_WIDTH_PIXELS = 0.1;
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

// This deliberately matches image-edit-mask's SVG alpha >=128 rule, without
// modifying that persisted v2 recipe or adding a different raster convention.
async function raster(input: EditRegions | [], width: number, height: number) {
  if (!input.length) return Buffer.alloc(width * height);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${input.map((region) => `<polygon fill="white" points="${region.points.map(([x, y]) => `${x * width},${y * height}`).join(" ")}"/>`).join("")}</svg>`,
  );
  const pixels = await sharp(svg, { limitInputPixels: MAX_PIXELS })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  for (let i = 0; i < pixels.length; i++)
    pixels[i] = pixels[i]! >= 128 ? 255 : 0;
  return pixels;
}
function pixelFacts(pixels: Buffer, width: number, height: number) {
  let count = 0,
    left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let i = 0; i < pixels.length; i++)
    if (pixels[i] === 255) {
      count++;
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  return {
    selectedPixels: count,
    bounds: count
      ? { left, top, width: right - left + 1, height: bottom - top + 1 }
      : null,
    selectionSha256: sha(pixels),
  };
}
function rowRuns(
  pixels: Buffer,
  width: number,
  y: number,
): [number, number][] | null {
  const runs: [number, number][] = [];
  for (let x = 0; x < width;) {
    if (pixels[y * width + x] !== 255) {
      x++;
      continue;
    }
    const left = x++;
    while (x < width && pixels[y * width + x] === 255) x++;
    runs.push([left, x]);
    if (runs.length > MAX_WORK_ITEMS) return null;
  }
  return runs;
}
function rectangles(
  pixels: Buffer,
  width: number,
  height: number,
): Rect[] | null {
  const complete: Rect[] = [];
  let active = new Map<string, Rect>();
  for (let y = 0; y < height; y++) {
    const runs = rowRuns(pixels, width, y);
    if (!runs) return null;
    const next = new Map<string, Rect>();
    for (const [left, right] of runs) {
      const key = `${left}:${right}`,
        previous = active.get(key);
      next.set(
        key,
        previous
          ? { ...previous, height: previous.height + 1 }
          : { left, top: y, width: right - left, height: 1 },
      );
      active.delete(key);
    }
    for (const rectangle of active.values()) complete.push(rectangle);
    active = next;
    if (complete.length + active.size > MAX_WORK_ITEMS) return null;
  }
  return [...complete, ...active.values()].sort(
    (a, b) =>
      a.top - b.top ||
      a.left - b.left ||
      a.height - b.height ||
      a.width - b.width,
  );
}
const rectangleRegion = (
  r: Rect,
  width: number,
  height: number,
  index: number,
) => ({
  label: `pixel rectangle ${index + 1}`,
  points: [
    [r.left / width, r.top / height],
    [(r.left + r.width) / width, r.top / height],
    [(r.left + r.width) / width, (r.top + r.height) / height],
    [r.left / width, (r.top + r.height) / height],
  ] as Point[],
});
function difference(a: [number, number][], b: [number, number][]) {
  const result: [number, number][] = [];
  let j = 0;
  for (const [left, right] of a) {
    let cursor = left;
    while (j < b.length && b[j]![1] <= cursor) j++;
    let k = j;
    while (k < b.length && b[k]![0] < right) {
      const [bl, br] = b[k++]!;
      if (bl > cursor) result.push([cursor, Math.min(bl, right)]);
      cursor = Math.max(cursor, br);
      if (cursor >= right) break;
    }
    if (cursor < right) result.push([cursor, right]);
  }
  return result;
}
function contours(
  pixels: Buffer,
  width: number,
  height: number,
): { include: EditRegions | []; exclude: EditRegions | [] } | string {
  const edges: Edge[] = [];
  const add = (from: Point, to: Point, direction: number) =>
    edges.push({ from, to, direction, used: false });
  let previous: [number, number][] = [];
  for (let y = 0; y <= height; y++) {
    const current = y === height ? [] : rowRuns(pixels, width, y);
    if (!current)
      return "Exact pixel boundary exceeds the bounded geometry work limit; narrow clipRegions.";
    for (const [left, right] of difference(current, previous))
      add([left, y], [right, y], 0);
    for (const [left, right] of difference(previous, current))
      add([right, y], [left, y], 2);
    for (const [left, right] of current) {
      add([left, y + 1], [left, y], 3);
      add([right, y], [right, y + 1], 1);
    }
    if (edges.length > MAX_WORK_ITEMS)
      return "Exact pixel boundary exceeds the bounded geometry work limit; narrow clipRegions.";
    previous = current;
  }
  const key = ([x, y]: Point) => `${x}:${y}`;
  const outgoing = new Map<string, number[]>();
  for (const [i, e] of edges.entries()) {
    const k = key(e.from);
    const list = outgoing.get(k) ?? [];
    list.push(i);
    outgoing.set(k, list);
  }
  const include: EditRegions = [],
    exclude: EditRegions = [];
  for (const edge of edges) {
    if (edge.used) continue;
    const points: Point[] = [];
    let current = edge,
      steps = 0;
    const start = key(edge.from);
    for (;;) {
      if (current.used || ++steps > edges.length)
        return "Exact pixel boundary cannot be represented as simple closed contours.";
      current.used = true;
      points.push(current.from);
      if (key(current.to) === start) break;
      const candidates = (outgoing.get(key(current.to)) ?? [])
        .map((i) => edges[i]!)
        .filter((e) => !e.used);
      // Filled cells stay on the right. At diagonal contacts turn right to
      // preserve separate components instead of bridging their corner.
      const turnRank = (next: Edge) =>
        [1, 0, 3, 2].indexOf((next.direction - current.direction + 4) % 4);
      candidates.sort((a, b) => turnRank(a) - turnRank(b));
      if (!candidates[0]) return "Exact pixel boundary is not closed.";
      current = candidates[0];
    }
    const simplified = points.filter((p, i) => {
      const a = points[(i + points.length - 1) % points.length]!,
        b = points[(i + 1) % points.length]!;
      return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
    });
    if (simplified.length > 200)
      return `Exact contour requires ${simplified.length} vertices; existing schema permits 200. Narrow clipRegions.`;
    const area = simplified.reduce((sum, [x, y], i) => {
      const [nx, ny] = simplified[(i + 1) % simplified.length]!;
      return sum + x * ny - nx * y;
    }, 0);
    const list = area > 0 ? include : exclude;
    list.push({
      label: `pixel ${area > 0 ? "outer" : "hole"} ${list.length + 1}`,
      points: simplified.map(([x, y]) => [x / width, y / height] as Point),
    });
    if (list.length > 100)
      return "Exact contours exceed the existing 100-region limit; narrow clipRegions.";
  }
  return { include, exclude };
}
async function verifyGeometry(
  pixels: Buffer,
  width: number,
  height: number,
  geometry: { include: EditRegions | []; exclude: EditRegions | [] },
) {
  const valid = geometrySchema.safeParse({ proposalIds: [], ...geometry });
  if (!valid.success)
    return {
      failure: `Existing regions schema rejects exact geometry: ${valid.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .slice(0, 3)
        .join("; ")}`,
    };
  const [include, exclude] = await Promise.all([
    raster(geometry.include, width, height),
    raster(geometry.exclude, width, height),
  ]);
  for (let i = 0; i < include.length; i++)
    if (exclude[i] === 255) include[i] = 0;
  if (!include.equals(pixels))
    return {
      failure:
        "Existing SVG alpha>=128 roundtrip differs from the selected pixels; exact geometry is unavailable.",
    };
  return { geometry: valid.data };
}

const regionArea = (region: EditRegions[number]) =>
  Math.abs(
    region.points.reduce((sum, [x, y], i) => {
      const [nx, ny] = region.points[(i + 1) % region.points.length]!;
      return sum + x * ny - nx * y;
    }, 0),
  ) / 2;
function rectanglePixelBounds(
  region: EditRegions[number],
  width: number,
  height: number,
) {
  const xs = [...new Set(region.points.map(([x]) => x))],
    ys = [...new Set(region.points.map(([, y]) => y))];
  if (
    region.points.length !== 4 ||
    xs.length !== 2 ||
    ys.length !== 2 ||
    !region.points.every(([x, y], i) => {
      const [nx, ny] = region.points[(i + 1) % 4]!;
      return (x === nx) !== (y === ny);
    })
  )
    return null;
  return {
    left: Math.min(...xs) * width,
    right: Math.max(...xs) * width,
    top: Math.min(...ys) * height,
    bottom: Math.max(...ys) * height,
  };
}
const onCanvas = (points: Point[]) =>
  points.every(
    ([x, y]) =>
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      x <= 1 &&
      y >= 0 &&
      y <= 1,
  );

function minimumAreaIntegerContour(
  region: EditRegions[number],
  width: number,
  height: number,
) {
  const native = region.points.map(
    ([x, y]) => [Math.round(x * width), Math.round(y * height)] as Point,
  );
  if (
    !native.every(
      ([x, y], i) =>
        Math.abs(x - region.points[i]![0] * width) <= 1e-7 &&
        Math.abs(y - region.points[i]![1] * height) <= 1e-7 &&
        (x === native[(i + 1) % native.length]![0]) !==
          (y === native[(i + 1) % native.length]![1]),
    )
  )
    return null;
  const area =
      Math.abs(
        native.reduce((sum, [x, y], i) => {
          const [nx, ny] = native[(i + 1) % native.length]!;
          return sum + x * ny - nx * y;
        }, 0),
      ) / 2,
    minimum = width * height * MIN_REGION_AREA;
  // Normalized shoelace cancellation can put an integer contour exactly at
  // the minimum just below it. Truly undersized non-rectangles stay rejected.
  if (area < minimum || area >= minimum + AREA_MARGIN_PIXELS) return null;
  const cx =
      (Math.min(...native.map(([x]) => x)) +
        Math.max(...native.map(([x]) => x))) /
      2,
    cy =
      (Math.min(...native.map(([, y]) => y)) +
        Math.max(...native.map(([, y]) => y))) /
      2,
    scale = Math.sqrt((minimum + AREA_MARGIN_PIXELS) / area),
    points = native.map(
      ([x, y]) =>
        [
          (cx + (x - cx) * scale) / width,
          (cy + (y - cy) * scale) / height,
        ] as Point,
    );
  // This is only a candidate encoding. The unchanged schema and complete SVG
  // roundtrip below still decide whether it represents every original pixel.
  return onCanvas(points) ? { ...region, points } : null;
}

function subpixelRectangles(
  geometry: { include: EditRegions | []; exclude: EditRegions | [] },
  width: number,
  height: number,
) {
  let changed = false;
  const lists: { include: EditRegions; exclude: EditRegions } = {
    include: [],
    exclude: [],
  };
  for (const key of ["include", "exclude"] as const)
    for (const region of geometry[key]) {
      if (regionArea(region) >= MIN_REGION_AREA) {
        lists[key].push(region);
        continue;
      }
      // Only undersized orthogonal rectangles are scaled. An integer contour
      // already at the minimum may instead need a numerical area margin.
      const bounds = rectanglePixelBounds(region, width, height);
      if (!bounds) {
        const repaired = minimumAreaIntegerContour(region, width, height);
        if (!repaired) return null;
        lists[key].push(repaired);
        changed = true;
        continue;
      }
      const { left, right, top, bottom } = bounds,
        cx = (left + right) / 2,
        cy = (top + bottom) / 2,
        scale = Math.sqrt(
          (width * height * MIN_REGION_AREA + AREA_MARGIN_PIXELS) /
            ((right - left) * (bottom - top)),
        );
      const points = region.points.map(
        ([x, y]) =>
          [
            (cx + (x * width - cx) * scale) / width,
            (cy + (y * height - cy) * scale) / height,
          ] as Point,
      );
      // Clamping would change the candidate's area and raster; reject edges.
      if (!onCanvas(points)) return null;
      lists[key].push({ ...region, points });
      changed = true;
    }
  return changed ? lists : null;
}

type TabDirection = "east" | "west" | "south" | "north";
const TAB_DIRECTION_CANDIDATES: readonly (readonly TabDirection[])[] = [
  ["east"],
  ["west"],
  ["south"],
  ["north"],
  ["east", "north", "west", "south"],
];
function rectangleTabEncoding(
  geometry: { include: EditRegions | []; exclude: EditRegions | [] },
  width: number,
  height: number,
  directions: readonly TabDirection[],
) {
  const lists: { include: EditRegions; exclude: EditRegions } = {
    include: [],
    exclude: [],
  };
  let changed = false,
    index = 0;
  for (const key of ["include", "exclude"] as const)
    for (const region of geometry[key]) {
      const direction = directions[index++ % directions.length]!;
      if (regionArea(region) >= MIN_REGION_AREA) {
        lists[key].push(region);
        continue;
      }
      const bounds = rectanglePixelBounds(region, width, height);
      if (!bounds) {
        const repaired = minimumAreaIntegerContour(region, width, height);
        if (!repaired) return null;
        lists[key].push(repaired);
        changed = true;
        continue;
      }
      const { left, right, top, bottom } = bounds,
        w = right - left,
        h = bottom - top,
        length =
          (width * height * MIN_REGION_AREA + AREA_MARGIN_PIXELS - w * h) /
          TAB_WIDTH_PIXELS;
      if (!Number.isFinite(length) || length <= 0) return null;
      // Retain the entire integer rectangle, with one narrow tab attached to
      // the middle of an edge. This is a binary-mask encoding, not its outline.
      const east = (x: number, y: number, rw: number, rh: number): Point[] => {
        const cy = y + rh / 2,
          half = TAB_WIDTH_PIXELS / 2;
        return [
          [x, y],
          [x + rw, y],
          [x + rw, cy - half],
          [x + rw + length, cy - half],
          [x + rw + length, cy + half],
          [x + rw, cy + half],
          [x + rw, y + rh],
          [x, y + rh],
        ];
      };
      let pixels = east(left, top, w, h);
      if (direction === "west")
        pixels = pixels.map(([x, y]) => [left + right - x, y]);
      if (direction === "south" || direction === "north") {
        pixels = east(top, left, h, w).map(([y, x]) => [x, y]);
        if (direction === "north")
          pixels = pixels.map(([x, y]) => [x, top + bottom - y]);
      }
      const points = pixels.map(([x, y]) => [x / width, y / height] as Point);
      if (!onCanvas(points)) return null;
      lists[key].push({ ...region, points });
      changed = true;
    }
  return changed ? lists : null;
}

/** Exact, bounded geometry only; no provider, database mutation, or mask authority. */
export async function imageMaskPixelGeometry(
  pixels: Buffer,
  width: number,
  height: number,
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width * height) ||
    width * height > MAX_PIXELS ||
    pixels.length !== width * height ||
    pixels.some((v) => v !== 0 && v !== 255)
  )
    fail(422, "精确几何只接受 2500 万像素内、原尺寸完整二值蒙版");
  const facts = pixelFacts(pixels, width, height),
    rects = rectangles(pixels, width, height);
  const candidates: {
    geometry: { include: EditRegions | []; exclude: EditRegions | [] };
    algorithm: "rectangles" | "contours";
  }[] = [];
  let failure: string;
  if (rects && rects.length <= 100) {
    const geometry = {
      include: rects.map((r, i) => rectangleRegion(r, width, height, i)),
      exclude: [],
    };
    candidates.push({ geometry, algorithm: "rectangles" });
    const first = await verifyGeometry(pixels, width, height, geometry);
    if (first.geometry)
      return {
        state: "ready" as const,
        geometry: first.geometry,
        diagnostics: {
          semanticCoverage: "unverified" as const,
          ...facts,
          rectangleCount: rects.length,
          algorithm: "rectangles" as const,
          roundTripExact: true,
          failure: null,
        },
      };
    failure = first.failure!;
  } else
    failure =
      "Exact run rectangles exceed the existing region or bounded work limit.";
  const traced = contours(pixels, width, height);
  if (typeof traced !== "string") {
    candidates.push({ geometry: traced, algorithm: "contours" });
    const second = await verifyGeometry(pixels, width, height, traced);
    if (second.geometry)
      return {
        state: "ready" as const,
        geometry: second.geometry,
        diagnostics: {
          semanticCoverage: "unverified" as const,
          ...facts,
          rectangleCount: rects?.length ?? null,
          algorithm: "contours" as const,
          roundTripExact: true,
          failure: null,
        },
      };
    failure = second.failure!;
  } else failure = traced;
  // Preserve every successful integer result before trying fractional bounds.
  // SVG source-over can add alpha where tiny rectangles are close, so only
  // the complete unchanged-schema include/exclude roundtrip can accept one.
  for (const candidate of candidates) {
    const geometry = subpixelRectangles(candidate.geometry, width, height);
    if (!geometry) continue;
    const verified = await verifyGeometry(pixels, width, height, geometry);
    if (verified.geometry)
      return {
        state: "ready" as const,
        geometry: verified.geometry,
        diagnostics: {
          semanticCoverage: "unverified" as const,
          ...facts,
          rectangleCount: rects?.length ?? null,
          algorithm: candidate.algorithm,
          roundTripExact: true,
          failure: null,
        },
      };
    failure = verified.failure!;
  }
  // A fixed five-direction schedule is the final bounded attempt. Even a
  // sub-threshold tab can accumulate alpha with other regions, so accept
  // nothing until the whole existing-schema selection roundtrips exactly.
  for (const directions of TAB_DIRECTION_CANDIDATES)
    for (const candidate of candidates) {
      const geometry = rectangleTabEncoding(
        candidate.geometry,
        width,
        height,
        directions,
      );
      if (!geometry) continue;
      const verified = await verifyGeometry(pixels, width, height, geometry);
      if (verified.geometry)
        return {
          state: "ready" as const,
          geometry: verified.geometry,
          diagnostics: {
            semanticCoverage: "unverified" as const,
            ...facts,
            rectangleCount: rects?.length ?? null,
            algorithm: candidate.algorithm,
            roundTripExact: true,
            failure: null,
          },
        };
      failure = verified.failure!;
    }
  return {
    state: "unrepresentable" as const,
    geometry: null,
    diagnostics: {
      semanticCoverage: "unverified" as const,
      ...facts,
      rectangleCount: rects?.length ?? null,
      algorithm: null,
      roundTripExact: false,
      failure,
    },
  };
}

export async function readImageMaskGeometry(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskGeometryInput,
  options: { storage?: StorageRuntime; signal?: AbortSignal } = {},
): Promise<ImageMaskGeometryOutput> {
  input = imageMaskGeometryInputSchema.parse(input);
  const current = await readImageEditMask(
    db,
    ctx,
    input.maskReceiptId,
    options,
  );
  options.signal?.throwIfAborted();
  const { width, height } = current.receipt.source,
    { s, g, p, t, conflicts } = current.computed;
  const clip = input.clipRegions
    ? await raster(input.clipRegions, width, height)
    : undefined;
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const selected =
      input.selection === "conflicts"
        ? conflicts[i] === 255
        : input.selection === "source-protected"
          ? s.pixels[i] === 255 && p.pixels[i] === 255
          : g.pixels[i] === 255 && p.pixels[i] === 255 && t.pixels[i] !== 255;
    if (selected && (!clip || clip[i] === 255)) pixels[i] = 255;
  }
  const result = await imageMaskPixelGeometry(pixels, width, height);
  options.signal?.throwIfAborted();
  return imageMaskGeometryOutputSchema.parse({
    kind: "image_mask_geometry",
    ...result,
    maskReceiptId: current.receipt.receiptId,
    maskReceiptDigest: current.receipt.digest,
    maskDigest: current.receipt.maskDigest,
    referenceImageId: current.receipt.source.referenceImageId,
    generationOperationId: current.receipt.raw.generationOperationId,
    selection: input.selection,
    clipRegions: input.clipRegions ?? [],
    source: { width, height },
    instruction,
  });
}
