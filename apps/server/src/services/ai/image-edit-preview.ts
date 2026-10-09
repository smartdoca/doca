import { createHash } from "node:crypto";
import sharp from "sharp";
import { editRegionsSchema, editViewport, type EditRegions } from "./image-edit-regions.js";

type Rect = { left: number; top: number; width: number; height: number };
const MAX_EDGE = 1600, LEGEND_HEIGHT = 48;
const EDITABLE = [0, 185, 100, 82] as const;
const PROTECTED = [25, 87, 180, 60] as const;

/** Local visual preflight only: no database, storage writes, paid model, or approval claim. */
export async function imageEditPreview(base: Buffer, input: EditRegions) {
  const regions = editRegionsSchema.parse(input);
  const source = await sharp(base, { limitInputPixels: 25000000 })
    .rotate().png().toBuffer({ resolveWithObject: true });
  const { width, height } = source.info;
  const viewport = await editViewport(source.data, regions);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${regions.map(region =>
      `<polygon fill="white" points="${region.points.map(([x, y]) => `${x * width},${y * height}`).join(" ")}"/>`,
    ).join("")}</svg>`,
  );
  // The same >=128 alpha threshold is used by lossless protected-pixel composition.
  const coverage = await sharp(svg).ensureAlpha().extractChannel(3).raw().toBuffer();
  let editablePixels = 0;
  for (let index = 0; index < coverage.length; index++) {
    const editable = coverage[index]! >= 128;
    coverage[index] = editable ? 255 : 0;
    if (editable) editablePixels++;
  }
  if (!editablePixels) throw Error("编辑轮廓没有覆盖任何原图像素");

  async function render(rect: Rect) {
    const scale = Math.min(1, MAX_EDGE / rect.width, (MAX_EDGE - LEGEND_HEIGHT) / rect.height);
    const contentWidth = Math.max(1, Math.round(rect.width * scale)),
      contentHeight = Math.max(1, Math.round(rect.height * scale));
    const canvasWidth = Math.max(320, contentWidth),
      canvasHeight = contentHeight + LEGEND_HEIGHT,
      left = Math.floor((canvasWidth - contentWidth) / 2);
    const mask = await sharp(coverage, { raw: { width, height, channels: 1 } })
      .extract(rect).resize(contentWidth, contentHeight, { fit: "fill", kernel: "nearest" })
      .extractChannel(0).raw().toBuffer();
    const overlay = Buffer.alloc(contentWidth * contentHeight * 4);
    for (let index = 0; index < mask.length; index++) {
      const editable = mask[index]! >= 128, x = index % contentWidth,
        boundary = editable && (
          x > 0 && mask[index - 1]! < 128 ||
          x < contentWidth - 1 && mask[index + 1]! < 128 ||
          index >= contentWidth && mask[index - contentWidth]! < 128 ||
          index < mask.length - contentWidth && mask[index + contentWidth]! < 128
        );
      // Highlight only inside the binary editable coverage; never draw green over protection.
      overlay.set(boundary ? [0, 185, 100, 210] : editable ? EDITABLE : PROTECTED, index * 4);
    }
    const scene = await sharp(source.data).extract(rect)
      .resize(contentWidth, contentHeight, { fit: "fill" }).flatten({ background: "#fff" })
      .composite([
        { input: overlay, raw: { width: contentWidth, height: contentHeight, channels: 4 } },
      ]).png().toBuffer();
    const legend = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${LEGEND_HEIGHT}">` +
      `<rect width="100%" height="100%" fill="white"/>` +
      `<rect x="10" y="8" width="14" height="14" fill="#00b96d"/>` +
      `<text x="30" y="20" font-family="sans-serif" font-size="13" fill="#111">EDITABLE (green)</text>` +
      `<rect x="164" y="8" width="14" height="14" fill="#1957b4"/>` +
      `<text x="184" y="20" font-family="sans-serif" font-size="13" fill="#111">PROTECTED (blue)</text>` +
      `<text x="10" y="40" font-family="sans-serif" font-size="11" fill="#333">Source x:${rect.left} y:${rect.top} w:${rect.width} h:${rect.height}</text></svg>`,
    );
    const data = await sharp({ create: {
      width: canvasWidth, height: canvasHeight, channels: 3, background: "#fff",
    } }).composite([
      { input: legend, left: 0, top: 0 },
      { input: scene, left, top: LEGEND_HEIGHT },
    ]).png().toBuffer();
    return {
      data, mime: "image/png" as const, width: canvasWidth, height: canvasHeight,
      sourceRect: rect,
      contentRect: { left, top: LEGEND_HEIGHT, width: contentWidth, height: contentHeight },
    };
  }

  const sourceDigest = createHash("sha256").update(base).digest("hex");
  const digest = createHash("sha256").update("doca-image-edit-preview-v1\0")
    .update(sourceDigest).update(JSON.stringify(regions)).digest("hex");
  return {
    source: { width, height, digest: sourceDigest },
    digest,
    editRegions: regions,
    coverage: {
      editablePixels, protectedPixels: width * height - editablePixels,
      totalPixels: width * height, editableFraction: editablePixels / (width * height),
    },
    full: await render({ left: 0, top: 0, width, height }),
    local: await render(viewport.rect),
    legend: { editable: "green", protected: "blue" },
    instruction: "这是覆盖范围预览，不是生成结果或验收通过证明。绿色仅表示可编辑像素，蓝色表示保护像素。应检查目标全身/头部是否完整覆盖，背景、道具和非目标人物是否排除。所有editRegions坐标仍属于原图，不属于带图例的预览PNG。预览坐标到原图：x=sourceRect.left+(x-contentRect.left)*sourceRect.width/contentRect.width；y同理，再除以source.width或source.height得到归一化坐标。",
  };
}
