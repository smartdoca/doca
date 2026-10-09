import sharp from "sharp";
import { z } from "zod";

type Point = [number, number];
const GEOMETRY_EPSILON = 1e-10;
const samePoint = (a: Point, b: Point) =>
  Math.abs(a[0] - b[0]) <= GEOMETRY_EPSILON &&
  Math.abs(a[1] - b[1]) <= GEOMETRY_EPSILON;
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) -
  (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a: Point, b: Point, point: Point) {
  return Math.abs(cross(a, b, point)) <= GEOMETRY_EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - GEOMETRY_EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + GEOMETRY_EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - GEOMETRY_EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + GEOMETRY_EPSILON;
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const abC = cross(a, b, c), abD = cross(a, b, d),
    cdA = cross(c, d, a), cdB = cross(c, d, b);
  const sign = (value: number) =>
    Math.abs(value) <= GEOMETRY_EPSILON ? 0 : Math.sign(value);
  return sign(abC) * sign(abD) < 0 && sign(cdA) * sign(cdB) < 0 ||
    onSegment(a, b, c) || onSegment(a, b, d) ||
    onSegment(c, d, a) || onSegment(c, d, b);
}

export const editRegionsSchema = z
  .array(
    z
      .object({
        label: z.string().trim().min(1).max(100),
        points: z
          .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
          .min(3)
          .max(200),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .superRefine((regions, ctx) => {
    if (regions.length > 100) return;
    for (const [index, region] of regions.entries()) {
      const points = region.points;
      // Zod still runs refinements after array-size errors; geometry requires valid bounds.
      if (points.length < 3 || points.length > 200) continue;
      const invalid = (message: string) => ctx.addIssue({
        code: "custom", path: [index, "points"], message,
      });
      // Closing is implicit. Reject rather than silently removing persisted vertices.
      if (samePoint(points[0]!, points.at(-1)!)) {
        invalid("编辑轮廓不应重复首点闭合；系统会连接最后一个点和首点");
        continue;
      }
      const zeroEdge = points.findIndex((point, i) => samePoint(point, points[(i + 1) % points.length]!));
      if (zeroEdge >= 0) {
        invalid(`编辑轮廓第 ${zeroEdge + 1} 条边为零长度或退化边`);
        continue;
      }
      let geometryError: string | undefined;
      for (let i = 0; i < points.length && !geometryError; i++) {
        const a = points[i]!, b = points[(i + 1) % points.length]!,
          c = points[(i + 2) % points.length]!;
        // Straight continuation is valid; reversing over the previous edge is not.
        if (Math.abs(cross(a, b, c)) <= GEOMETRY_EPSILON &&
          (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > GEOMETRY_EPSILON ** 2) {
          geometryError = `编辑轮廓第 ${i + 1} 条边与相邻边回折重叠`;
          break;
        }
        for (let j = i + 2; j < points.length; j++) {
          if (i === 0 && j === points.length - 1) continue;
          if (segmentsIntersect(a, b, points[j]!, points[(j + 1) % points.length]!)) {
            geometryError = `编辑轮廓第 ${i + 1} 条边与第 ${j + 1} 条边自交或非相邻边接触，必须提供简单多边形`;
            break;
          }
        }
      }
      if (geometryError) {
        invalid(geometryError);
        continue;
      }
      const area =
        Math.abs(
          region.points.reduce((sum, [x, y], i) => {
            const [nx, ny] = region.points[(i + 1) % region.points.length]!;
            return sum + x * ny - nx * y;
          }, 0),
        ) / 2;
      if (area < 0.000001)
        ctx.addIssue({
          code: "custom",
          path: [index, "points"],
          message: "编辑轮廓面积过小或退化",
        });
    }
  });
export type EditRegions = z.infer<typeof editRegionsSchema>;

/** A shared local workspace for every editing model; originals remain untouched. */
export async function editViewport(base: Buffer, regions: EditRegions) {
  editRegionsSchema.parse(regions);
  const original = await sharp(base)
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = original.info;
  const points = regions.flatMap((region) => region.points);
  const x = points.map((point) => point[0] * width),
    y = points.map((point) => point[1] * height);
  const padding = Math.max(
    16,
    Math.max(Math.max(...x) - Math.min(...x), Math.max(...y) - Math.min(...y)) *
      0.15,
  );
  const left = Math.max(0, Math.floor(Math.min(...x) - padding)),
    top = Math.max(0, Math.floor(Math.min(...y) - padding));
  const right = Math.min(width, Math.ceil(Math.max(...x) + padding)),
    bottom = Math.min(height, Math.ceil(Math.max(...y) + padding));
  const rect = { left, top, width: right - left, height: bottom - top };
  const data = await sharp(original.data).extract(rect).png().toBuffer();
  return {
    rect,
    data,
    regions: regions.map((region) => ({
      ...region,
      points: region.points.map(
        ([x, y]) =>
          [
            (x * width - left) / rect.width,
            (y * height - top) / rect.height,
          ] as [number, number],
      ),
    })),
  };
}

export async function editMask(base: Buffer, regions: EditRegions) {
  editRegionsSchema.parse(regions);
  const { width, height } = await sharp(base).metadata();
  if (!width || !height) throw Error("无法读取蒙版尺寸");
  const polygons = regions
    .map(
      (region) =>
        `<polygon fill="white" points="${region.points.map(([x, y]) => `${x * width},${y * height}`).join(" ")}"/>`,
    )
    .join("");
  const coverage = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${polygons}</svg>`,
    ),
  )
    .ensureAlpha()
    .raw()
    .toBuffer();
  // OpenAI mask semantics: transparent = editable, opaque = protected.
  for (let i = 0; i < width * height; i++)
    coverage[i * 4 + 3] = coverage[i * 4 + 3]! >= 128 ? 0 : 255;
  return sharp(coverage, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Visible outlines guide reference-only models without changing durable source pixels. */
export async function markEditRegions(base: Buffer, regions: EditRegions) {
  editRegionsSchema.parse(regions);
  const { width, height } = await sharp(base).metadata();
  if (!width || !height) throw Error("无法读取编辑窗口尺寸");
  const stroke = Math.max(1.5, Math.max(width, height) / 600);
  const polygons = regions
    .map(
      (region) =>
        `<polygon fill="none" stroke="#ff00ff" stroke-width="${stroke}" points="${region.points.map(([x, y]) => `${x * width},${y * height}`).join(" ")}"/>`,
    )
    .join("");
  return sharp(base)
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${polygons}</svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
}

export async function restoreViewport(
  base: Buffer,
  generated: Buffer,
  rect: { left: number; top: number; width: number; height: number },
) {
  const patch = await sharp(generated)
    .rotate()
    .resize(rect.width, rect.height, { fit: "fill" })
    .png()
    .toBuffer();
  return sharp(base)
    .rotate()
    .composite([{ input: patch, left: rect.left, top: rect.top }])
    .png()
    .toBuffer();
}

/** Binary masks + PNG ensure every pixel outside the declared outlines is unchanged. */
export async function preserveOutsideRegions(
  base: Buffer,
  generated: Buffer,
  regions: EditRegions,
) {
  editRegionsSchema.parse(regions);
  const original = await sharp(base, { limitInputPixels: 25000000 })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = original.info;
  const replacement = await sharp(generated, { limitInputPixels: 25000000 })
    .rotate()
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${regions.map((region) => `<polygon fill="white" points="${region.points.map(([x, y]) => `${x * width},${y * height}`).join(" ")}"/>`).join("")}</svg>`,
  );
  const mask = await sharp(svg).ensureAlpha().raw().toBuffer();
  const result = Buffer.from(original.data);
  let changedPixels = 0,
    editablePixels = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i * 4 + 3]! < 128) continue;
    editablePixels++;
    let changed = false;
    for (let c = 0; c < channels; c++) {
      if (result[i * channels + c] !== replacement[i * channels + c])
        changed = true;
      result[i * channels + c] = replacement[i * channels + c]!;
    }
    if (changed) changedPixels++;
  }
  if (!editablePixels) throw Error("编辑轮廓没有覆盖任何像素");
  const data = await sharp(result, { raw: { width, height, channels } })
    .png()
    .toBuffer();
  return {
    data,
    info: { ...original.info, format: "png" as const, size: data.length },
    preservation: {
      baseWidth: width,
      baseHeight: height,
      editablePixels,
      changedPixels,
      protectedPixels: width * height - editablePixels,
      protectedPixelsChanged: 0,
      regions,
    },
  };
}
