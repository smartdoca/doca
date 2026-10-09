import { createHash } from "node:crypto";
import sharp from "sharp";

export const IMAGE_EDIT_BITMAP_MAX_PIXELS = 25_000_000;

export type ImageEditBitmapRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type Size = { width: number; height: number };
type Pixels = Size & { pixels: Buffer };
type Mask = Pixels & {
  editablePixels: number;
  bounds: ImageEditBitmapRect;
};

export type ImageEditBitmapConflict = {
  pixels: number;
  sourcePixels: number;
  generatedPixels: number;
  bounds: ImageEditBitmapRect | null;
};

export class ImageEditBitmapError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly facts?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ImageEditBitmapError";
  }
}

export type ImageEditBitmap = {
  /** Lossless, single-channel binary PNG in the source's oriented coordinates. */
  data: Buffer;
  source: Size & { digest: string };
  /** Bound to the exact source bytes, dimensions and binary mask pixels. */
  digest: string;
  bounds: ImageEditBitmapRect;
  coverage: {
    editablePixels: number;
    protectedPixels: number;
    totalPixels: number;
    editableFraction: number;
  };
};

function sizeAllowed(size: Size, label: string) {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  )
    throw new ImageEditBitmapError("invalid_dimensions", `${label}尺寸无效`);
  if (size.width * size.height > IMAGE_EDIT_BITMAP_MAX_PIXELS)
    throw new ImageEditBitmapError(
      "pixel_limit",
      `${label}超过 2500 万像素限制`,
      { width: size.width, height: size.height },
    );
}

async function imagePixels(input: Buffer, label: string): Promise<Pixels> {
  if (!Buffer.isBuffer(input) || !input.length)
    throw new ImageEditBitmapError("invalid_image", `${label}内容为空或无效`);
  try {
    // Inspect dimensions before decoding; no oversized pixel buffer is allocated.
    const meta = await sharp(input, { limitInputPixels: false }).metadata();
    const size = {
      width: meta.autoOrient.width,
      height: meta.autoOrient.height,
    };
    sizeAllowed(size, label);
    if (meta.pages !== undefined && meta.pages !== 1)
      throw new ImageEditBitmapError(
        "image_animation",
        `${label}必须是单帧图像`,
      );
    const decoded = await sharp(input, {
      limitInputPixels: IMAGE_EDIT_BITMAP_MAX_PIXELS,
      failOn: "warning",
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.channels !== 4 ||
      decoded.info.width !== size.width ||
      decoded.info.height !== size.height ||
      decoded.data.length !== size.width * size.height * 4
    )
      throw new ImageEditBitmapError(
        "invalid_image",
        `${label}无法读取完整 RGBA 像素`,
      );
    return { ...size, pixels: decoded.data };
  } catch (error) {
    if (error instanceof ImageEditBitmapError) throw error;
    throw new ImageEditBitmapError("invalid_image", `${label}无法解析`);
  }
}

function boundsOf(pixels: Buffer, size: Size) {
  let left = size.width,
    top = size.height,
    right = -1,
    bottom = -1,
    count = 0;
  for (let index = 0; index < pixels.length; index++) {
    if (pixels[index] !== 255) continue;
    count++;
    const x = index % size.width,
      y = Math.floor(index / size.width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return {
    count,
    bounds: count
      ? { left, top, width: right - left + 1, height: bottom - top + 1 }
      : null,
  };
}

async function maskPixels(input: Buffer, expected: Size): Promise<Mask> {
  if (!Buffer.isBuffer(input) || !input.length)
    throw new ImageEditBitmapError("invalid_mask", "蒙版内容为空或无效");
  try {
    const meta = await sharp(input, { limitInputPixels: false }).metadata();
    if (meta.format !== "png")
      throw new ImageEditBitmapError("mask_format", "蒙版必须是 PNG");
    const size = { width: meta.width, height: meta.height };
    sizeAllowed(size, "蒙版");
    if (size.width !== expected.width || size.height !== expected.height)
      throw new ImageEditBitmapError(
        "mask_dimensions",
        "蒙版尺寸必须与原图完整尺寸一致，不能自动缩放",
        { expected, actual: size },
      );
    if (meta.pages !== undefined && meta.pages !== 1)
      throw new ImageEditBitmapError("mask_animation", "蒙版必须是单帧 PNG");
    if (meta.orientation !== undefined && meta.orientation !== 1)
      throw new ImageEditBitmapError(
        "mask_orientation",
        "蒙版必须已使用原图坐标，不能带旋转方向",
      );
    if (meta.channels !== 1 || meta.hasAlpha || meta.isPalette)
      throw new ImageEditBitmapError(
        "mask_channels",
        "蒙版必须是无 alpha、无调色板的单通道 PNG",
      );
    if (meta.depth !== "uchar" || ![1, 2, 4, 8].includes(meta.bitsPerSample!))
      throw new ImageEditBitmapError(
        "mask_depth",
        "蒙版必须使用不超过 8 位的二值像素",
      );
    const decoded = await sharp(input, {
      limitInputPixels: IMAGE_EDIT_BITMAP_MAX_PIXELS,
      failOn: "warning",
    })
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.channels !== 1 ||
      decoded.data.length !== size.width * size.height
    )
      throw new ImageEditBitmapError("invalid_mask", "蒙版像素内容不完整");
    for (let index = 0; index < decoded.data.length; index++) {
      const value = decoded.data[index];
      if (value !== 0 && value !== 255)
        throw new ImageEditBitmapError(
          "mask_nonbinary",
          "蒙版像素只能是 0 或 255，不能自动阈值化灰度",
          {
            x: index % size.width,
            y: Math.floor(index / size.width),
            value,
          },
        );
    }
    const { count, bounds } = boundsOf(decoded.data, size);
    if (!bounds)
      throw new ImageEditBitmapError("empty_mask", "蒙版没有任何有效像素");
    return {
      ...size,
      pixels: decoded.data,
      editablePixels: count,
      bounds,
    };
  } catch (error) {
    if (error instanceof ImageEditBitmapError) throw error;
    throw new ImageEditBitmapError("invalid_mask", "蒙版 PNG 无法完整解析");
  }
}

async function maskPNG(mask: Pixels) {
  return sharp(mask.pixels, {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .toColourspace("b-w")
    .png()
    .toBuffer();
}

async function boundBitmap(
  source: Buffer,
  mask: Mask,
): Promise<ImageEditBitmap> {
  const sourceDigest = createHash("sha256").update(source).digest("hex");
  const digest = createHash("sha256")
    .update("doca-image-edit-bitmap-v1\0")
    .update(sourceDigest)
    .update(`\0${mask.width}x${mask.height}\0`)
    .update(mask.pixels)
    .digest("hex");
  const totalPixels = mask.width * mask.height;
  return {
    data: await maskPNG(mask),
    source: { width: mask.width, height: mask.height, digest: sourceDigest },
    digest,
    bounds: mask.bounds,
    coverage: {
      editablePixels: mask.editablePixels,
      protectedPixels: totalPixels - mask.editablePixels,
      totalPixels,
      editableFraction: mask.editablePixels / totalPixels,
    },
  };
}

/** Validate without repairing, resizing, thresholding or mutating the supplied mask. */
export async function bindImageEditBitmap(source: Buffer, maskPNG: Buffer) {
  const original = await imagePixels(source, "原图");
  return boundBitmap(source, await maskPixels(maskPNG, original));
}

/**
 * Exact set union only. Holes and disconnected components are not filled or joined.
 * A conflicting union remains visible for correction, and is explicitly unsafe.
 * The caller must also establish semantic permission for generated-only pixels.
 */
export async function unionImageEditBitmaps(
  source: Buffer,
  sourceMaskPNG: Buffer,
  generatedMaskPNG: Buffer,
  protectionMaskPNG?: Buffer,
) {
  const original = await imagePixels(source, "原图");
  const sourceMask = await maskPixels(sourceMaskPNG, original);
  const generatedMask = await maskPixels(generatedMaskPNG, original);
  const protection = protectionMaskPNG
    ? await maskPixels(protectionMaskPNG, original)
    : undefined;
  const pixels = Buffer.alloc(original.width * original.height);
  const conflictPixels = Buffer.alloc(pixels.length);
  let expandedPixels = 0,
    sourceConflicts = 0,
    generatedConflicts = 0;
  for (let index = 0; index < pixels.length; index++) {
    const inSource = sourceMask.pixels[index] === 255,
      inGenerated = generatedMask.pixels[index] === 255;
    if (inSource || inGenerated) pixels[index] = 255;
    if (inGenerated && !inSource) expandedPixels++;
    if (protection?.pixels[index] !== 255) continue;
    if (inSource) sourceConflicts++;
    if (inGenerated) generatedConflicts++;
    if (inSource || inGenerated) conflictPixels[index] = 255;
  }
  const union = boundsOf(pixels, original);
  const conflict = boundsOf(conflictPixels, original);
  const conflicts: ImageEditBitmapConflict = {
    pixels: conflict.count,
    sourcePixels: sourceConflicts,
    generatedPixels: generatedConflicts,
    bounds: conflict.bounds,
  };
  return {
    ...(await boundBitmap(source, {
      width: original.width,
      height: original.height,
      pixels,
      editablePixels: union.count,
      bounds: union.bounds!,
    })),
    hasProtectionConflict: conflicts.pixels > 0,
    expandedPixels,
    sourceTargetPixels: sourceMask.editablePixels,
    generatedTargetPixels: generatedMask.editablePixels,
    conflicts,
  };
}

/** Crop both images in original pixel coordinates; padding supplies context, not edit permission. */
export async function imageEditBitmapViewport(
  source: Buffer,
  maskInput: Buffer,
  paddingPixels = 0,
) {
  if (!Number.isSafeInteger(paddingPixels) || paddingPixels < 0)
    throw new ImageEditBitmapError(
      "invalid_viewport_padding",
      "编辑视窗边距必须是非负整数像素",
    );
  const original = await imagePixels(source, "原图");
  const mask = await maskPixels(maskInput, original);
  const left = Math.max(0, mask.bounds.left - paddingPixels),
    top = Math.max(0, mask.bounds.top - paddingPixels),
    right = Math.min(
      original.width,
      mask.bounds.left + mask.bounds.width + paddingPixels,
    ),
    bottom = Math.min(
      original.height,
      mask.bounds.top + mask.bounds.height + paddingPixels,
    );
  const rect = { left, top, width: right - left, height: bottom - top };
  const bitmap = await boundBitmap(source, mask);
  return {
    source: bitmap.source,
    digest: bitmap.digest,
    coverage: bitmap.coverage,
    bounds: bitmap.bounds,
    rect,
    data: await sharp(original.pixels, {
      raw: { width: original.width, height: original.height, channels: 4 },
    })
      .extract(rect)
      .png()
      .toBuffer(),
    mask: await sharp(mask.pixels, {
      raw: { width: mask.width, height: mask.height, channels: 1 },
    })
      .extract(rect)
      .toColourspace("b-w")
      .png()
      .toBuffer(),
  };
}

/**
 * Copy generated RGBA only inside the exact binary mask. No resize, feathering,
 * protection subtraction or image-provider calls are performed.
 */
export async function preserveOutsideBitmap(
  source: Buffer,
  generated: Buffer,
  maskInput: Buffer,
  protectionMaskPNG?: Buffer,
) {
  const original = await imagePixels(source, "原图");
  const mask = await maskPixels(maskInput, original);
  if (protectionMaskPNG) {
    const protection = await maskPixels(protectionMaskPNG, original);
    const overlap = Buffer.alloc(mask.pixels.length);
    for (let index = 0; index < overlap.length; index++)
      if (mask.pixels[index] === 255 && protection.pixels[index] === 255)
        overlap[index] = 255;
    const conflicts = boundsOf(overlap, original);
    if (conflicts.count)
      throw new ImageEditBitmapError(
        "protection_conflict",
        "编辑蒙版覆盖了保护对象，必须修正；不能裁断目标或吞掉保护对象",
        { pixels: conflicts.count, bounds: conflicts.bounds },
      );
  }
  const replacement = await imagePixels(generated, "生成图");
  if (
    replacement.width !== original.width ||
    replacement.height !== original.height
  )
    throw new ImageEditBitmapError(
      "generated_dimensions",
      "生成图必须先精确映射到原图尺寸，不能在合成时自动缩放",
      {
        expected: { width: original.width, height: original.height },
        actual: { width: replacement.width, height: replacement.height },
      },
    );
  const result = Buffer.from(original.pixels);
  let changedPixels = 0;
  for (let index = 0; index < mask.pixels.length; index++) {
    if (mask.pixels[index] !== 255) continue;
    const offset = index * 4;
    if (
      original.pixels[offset] !== replacement.pixels[offset] ||
      original.pixels[offset + 1] !== replacement.pixels[offset + 1] ||
      original.pixels[offset + 2] !== replacement.pixels[offset + 2] ||
      original.pixels[offset + 3] !== replacement.pixels[offset + 3]
    )
      changedPixels++;
    result[offset] = replacement.pixels[offset]!;
    result[offset + 1] = replacement.pixels[offset + 1]!;
    result[offset + 2] = replacement.pixels[offset + 2]!;
    result[offset + 3] = replacement.pixels[offset + 3]!;
  }
  const rendered = await sharp(result, {
    raw: { width: original.width, height: original.height, channels: 4 },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  const bitmap = await boundBitmap(source, mask);
  return {
    data: rendered.data,
    info: rendered.info,
    source: bitmap.source,
    maskDigest: bitmap.digest,
    digest: createHash("sha256").update(rendered.data).digest("hex"),
    coverage: bitmap.coverage,
    preservation: {
      baseWidth: original.width,
      baseHeight: original.height,
      editablePixels: mask.editablePixels,
      changedPixels,
      protectedPixels: mask.pixels.length - mask.editablePixels,
      protectedPixelsChanged: 0,
    },
  };
}
