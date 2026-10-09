import sharp from "sharp";
import { fail } from "@core/shared/errors.js";

export const IMAGE_REVIEW_DETAIL_EDGE = 1536;
export const IMAGE_REVIEW_DETAIL_OVERLAP = 64;
export const IMAGE_REVIEW_MAX_DETAIL_TILES = 16;
export const IMAGE_REVIEW_TILES_PER_CALL = 1;
export type ImageReviewSize = { width: number; height: number };
export type ImageReviewRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type ImageReviewDetailTile = {
  id: string;
  normalizedRect: { left: number; top: number; right: number; bottom: number };
  sourceRect: ImageReviewRect;
  candidateRect: ImageReviewRect;
};

/** A complete, host-selected grid. Native crops are never resized or sampled. */
export function imageReviewDetailPlan(
  source: ImageReviewSize,
  candidate: ImageReviewSize,
) {
  for (const size of [source, candidate]) {
    if (
      ![size.width, size.height].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      size.width * size.height > 25_000_000
    )
      fail(422, "图片验收原生尺寸无效或超过2500万像素");
  }
  const width = Math.max(source.width, candidate.width),
    height = Math.max(source.height, candidate.height);
  const divisions = (length: number) =>
    length <= IMAGE_REVIEW_DETAIL_EDGE
      ? 1
      : Math.ceil(
          length / (IMAGE_REVIEW_DETAIL_EDGE - IMAGE_REVIEW_DETAIL_OVERLAP * 2),
        );
  const columns = divisions(width),
    rows = divisions(height);
  if (columns * rows > IMAGE_REVIEW_MAX_DETAIL_TILES)
    fail(
      422,
      `图片验收完整原生细节需要${columns * rows}块，超过${IMAGE_REVIEW_MAX_DETAIL_TILES}块/${IMAGE_REVIEW_MAX_DETAIL_TILES / IMAGE_REVIEW_TILES_PER_CALL}次细节调用预算；不能抽样或降低分辨率宣称通过`,
    );
  const rect = (
    size: ImageReviewSize,
    bounds: ImageReviewDetailTile["normalizedRect"],
  ): ImageReviewRect => {
    const left = Math.floor(bounds.left * size.width),
      top = Math.floor(bounds.top * size.height);
    const right = Math.min(size.width, Math.ceil(bounds.right * size.width));
    const bottom = Math.min(
      size.height,
      Math.ceil(bounds.bottom * size.height),
    );
    return { left, top, width: right - left, height: bottom - top };
  };
  const tiles: ImageReviewDetailTile[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const normalizedRect = {
        left: Math.max(
          0,
          column / columns -
            (column > 0 ? IMAGE_REVIEW_DETAIL_OVERLAP / width : 0),
        ),
        top: Math.max(
          0,
          row / rows - (row > 0 ? IMAGE_REVIEW_DETAIL_OVERLAP / height : 0),
        ),
        right: Math.min(
          1,
          (column + 1) / columns +
            (column + 1 < columns ? IMAGE_REVIEW_DETAIL_OVERLAP / width : 0),
        ),
        bottom: Math.min(
          1,
          (row + 1) / rows +
            (row + 1 < rows ? IMAGE_REVIEW_DETAIL_OVERLAP / height : 0),
        ),
      };
      const tile = {
        id: `detail-${row + 1}-${column + 1}`,
        normalizedRect,
        sourceRect: rect(source, normalizedRect),
        candidateRect: rect(candidate, normalizedRect),
      };
      if (
        [tile.sourceRect, tile.candidateRect].some(
          (area) =>
            Math.max(area.width, area.height) > IMAGE_REVIEW_DETAIL_EDGE,
        )
      )
        fail(422, "图片验收完整细节无法在原生分辨率预算内表达");
      tiles.push(tile);
    }
  return {
    source,
    candidate,
    rows,
    columns,
    tiles,
    detailCalls: Math.ceil(tiles.length / IMAGE_REVIEW_TILES_PER_CALL),
  };
}

/** One orientation-normalized canvas supplies every native crop and all size facts. */
export async function imageReviewCanvas(data: Buffer) {
  const rendered = await sharp(data, { limitInputPixels: 25_000_000 })
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    data: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
  };
}

export async function imageReviewNativeCrop(
  data: Buffer,
  rect: ImageReviewRect,
) {
  const rendered = await sharp(data, { limitInputPixels: 25_000_000 })
    .extract(rect)
    .png()
    .toBuffer({ resolveWithObject: true });
  if (
    rendered.info.width !== rect.width ||
    rendered.info.height !== rect.height ||
    Math.max(rect.width, rect.height) > IMAGE_REVIEW_DETAIL_EDGE
  )
    fail(422, "图片验收细节必须保持原生尺寸，不得缩小");
  return rendered.data;
}

export async function imageReviewPng(data: Buffer, longest: number) {
  return sharp(data, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize(longest, longest, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

/** Review-only transport: verify actual PNGs, leaving normal metering and context checks intact. */
export async function nativeImageReviewPrompt(prompt: any[]) {
  for (const message of prompt)
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type !== "file" || !part.mediaType?.startsWith("image/"))
        continue;
      if (part.mediaType !== "image/png" || part.data?.type !== "data")
        fail(422, "独立图片验收必须发送完整PNG像素");
      const data =
        typeof part.data.data === "string"
          ? Buffer.from(part.data.data, "base64")
          : Buffer.from(part.data.data);
      const metadata = await sharp(data, {
        limitInputPixels: 25_000_000,
      }).metadata();
      if (
        metadata.format !== "png" ||
        !metadata.width ||
        !metadata.height ||
        Math.max(metadata.width, metadata.height) > 1600 ||
        (metadata.pages ?? 1) !== 1
      )
        fail(422, "独立图片验收实际PNG帧尺寸或内容不完整");
    }
  return prompt;
}
