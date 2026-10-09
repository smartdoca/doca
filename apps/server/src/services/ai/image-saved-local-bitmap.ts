import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import {
  imageModelProfiles,
  imageSizeForRatio,
  validImageSize,
  type ImageModelProfile,
} from "@core/modules/ai/image-model-catalog.js";

const MAX_PIXELS = 25_000_000;
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const positiveInt = z.number().int().positive().max(MAX_PIXELS);
const nonnegativeInt = z.number().int().nonnegative().max(MAX_PIXELS);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const sizeSchema = z
  .object({ width: positiveInt, height: positiveInt })
  .strict();
const rectSchema = sizeSchema
  .extend({ left: nonnegativeInt, top: nonnegativeInt })
  .strict();

/** This selection belongs to the CURRENT saved base, never the original page. */
export const savedLocalBitmapRegionSchema = z
  .object({
    left: z.number().finite().min(0).lt(1),
    top: z.number().finite().min(0).lt(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .refine((r) => r.left + r.width <= 1 && r.top + r.height <= 1, {
    message: "The entire region must be inside the current base",
  });
export type SavedLocalBitmapRegion = z.infer<
  typeof savedLocalBitmapRegionSchema
>;

export const savedLocalBitmapFactsSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("saved-local-viewport-v1"),
    coordinateSpace: z.literal("current-base"),
    base: sizeSchema.extend({ sha256: sha, rgbaSHA256: sha }).strict(),
    region: savedLocalBitmapRegionSchema,
    contextPaddingPixels: nonnegativeInt,
    nativeRect: rectSchema,
    contextCrop: rectSchema,
    crop: sizeSchema.extend({ sha256: sha }).strict(),
    workspace: sizeSchema
      .extend({
        contentRect: rectSchema,
        padding: z
          .object({
            left: nonnegativeInt,
            top: nonnegativeInt,
            right: nonnegativeInt,
            bottom: nonnegativeInt,
          })
          .strict(),
        scale: z
          .object({
            requested: z.number().finite().min(1),
            x: z.number().finite().min(1),
            y: z.number().finite().min(1),
          })
          .strict(),
        inverseScale: z
          .object({
            x: z.number().finite().positive().max(1),
            y: z.number().finite().positive().max(1),
          })
          .strict(),
      })
      .strict(),
    provider: sizeSchema
      .extend({
        profileId: z.string().min(1),
        requestedSize: z.string().regex(/^\d{2,4}x\d{2,4}$/),
        sha256: sha,
      })
      .strict(),
    digest: sha,
  })
  .strict();
export type SavedLocalBitmapFacts = z.infer<typeof savedLocalBitmapFactsSchema>;
type Size = z.infer<typeof sizeSchema>;
type Rect = z.infer<typeof rectSchema>;
type Pixels = Size & { pixels: Buffer };

export class SavedLocalBitmapError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SavedLocalBitmapError";
  }
}

function reject(code: string, message: string): never {
  throw new SavedLocalBitmapError(code, message);
}

async function decode(input: Buffer, label: string): Promise<Pixels> {
  if (!Buffer.isBuffer(input) || !input.length)
    reject("invalid_image", `${label} is empty`);
  try {
    const meta = await sharp(input, { limitInputPixels: false }).metadata();
    const width = meta.autoOrient.width,
      height = meta.autoOrient.height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > MAX_PIXELS
    )
      reject("image_dimensions", `${label} exceeds the supported pixel bounds`);
    if (meta.pages !== undefined && meta.pages !== 1)
      reject("image_animation", `${label} must be a single-frame image`);
    const result = await sharp(input, {
      limitInputPixels: MAX_PIXELS,
      failOn: "warning",
    })
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      result.info.width !== width ||
      result.info.height !== height ||
      result.info.channels !== 4 ||
      result.data.length !== width * height * 4
    )
      reject("invalid_image", `${label} has incomplete RGBA pixels`);
    return { width, height, pixels: result.data };
  } catch (error) {
    if (error instanceof SavedLocalBitmapError) throw error;
    reject("invalid_image", `${label} cannot be decoded`);
  }
}

function png(pixels: Pixels) {
  return sharp(pixels.pixels, {
    raw: { width: pixels.width, height: pixels.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

function cropPixels(image: Pixels, rect: Rect): Pixels {
  const pixels = Buffer.alloc(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const offset = ((rect.top + y) * image.width + rect.left) * 4;
    image.pixels.copy(
      pixels,
      y * rect.width * 4,
      offset,
      offset + rect.width * 4,
    );
  }
  return { width: rect.width, height: rect.height, pixels };
}

function implementedProfile(profile: ImageModelProfile) {
  const current = imageModelProfiles.find((item) => item.id === profile.id);
  if (
    !current ||
    !current.operations.includes("edit") ||
    current.adapter !== profile.adapter ||
    JSON.stringify(current.limits) !== JSON.stringify(profile.limits)
  )
    reject(
      "provider_profile",
      "An explicit implemented editing profile is required",
    );
  return current;
}

function nativeRegion(size: Size, region: SavedLocalBitmapRegion): Rect {
  const left = Math.floor(region.left * size.width),
    top = Math.floor(region.top * size.height),
    right = Math.ceil((region.left + region.width) * size.width),
    bottom = Math.ceil((region.top + region.height) * size.height);
  return { left, top, width: right - left, height: bottom - top };
}

function workspaceSize(profile: ImageModelProfile, crop: Size) {
  const ratio = Math.max(
    1 / profile.limits.maxRatio,
    Math.min(profile.limits.maxRatio, crop.width / crop.height),
  );
  // Padding changes transport aspect only; a native crop is never shrunk.
  const required = {
    width: Math.max(crop.width, Math.ceil(crop.height * ratio)),
    height: Math.max(crop.height, Math.ceil(crop.width / ratio)),
  };
  let size = imageSizeForRatio(profile, ratio, required);
  if (!size && profile.limits.sizes) {
    size = [...profile.limits.sizes]
      .filter((s) => {
        const [w, h] = s.split("x").map(Number) as [number, number];
        return (
          w >= crop.width && h >= crop.height && validImageSize(profile, s)
        );
      })
      .sort((a, b) => {
        const [aw, ah] = a.split("x").map(Number) as [number, number];
        const [bw, bh] = b.split("x").map(Number) as [number, number];
        return (
          Math.abs(Math.log(aw / ah / ratio)) -
            Math.abs(Math.log(bw / bh / ratio)) || aw * ah - bw * bh
        );
      })[0];
  }
  if (!size || !validImageSize(profile, size))
    reject(
      "provider_size",
      "The native context crop has no legal provider workspace",
    );
  const [width, height] = size.split("x").map(Number) as [number, number];
  if (width < crop.width || height < crop.height || width * height > MAX_PIXELS)
    reject(
      "provider_size",
      "A provider workspace cannot shrink the native context crop",
    );
  return { width, height, size };
}

/** Pure preparation: no receipt, asset, usage or permission state is written. */
export async function prepareSavedLocalBitmap(
  base: Buffer,
  regionInput: SavedLocalBitmapRegion,
  profileInput: ImageModelProfile,
  contextPaddingPixels: number,
): Promise<{
  facts: SavedLocalBitmapFacts;
  cropPNG: Buffer;
  providerPNG: Buffer;
}> {
  const region = savedLocalBitmapRegionSchema.parse(regionInput);
  nonnegativeInt.parse(contextPaddingPixels);
  const profile = implementedProfile(profileInput),
    image = await decode(base, "Current base"),
    nativeRect = nativeRegion(image, region);
  const left = Math.max(0, nativeRect.left - contextPaddingPixels),
    top = Math.max(0, nativeRect.top - contextPaddingPixels),
    right = Math.min(
      image.width,
      nativeRect.left + nativeRect.width + contextPaddingPixels,
    ),
    bottom = Math.min(
      image.height,
      nativeRect.top + nativeRect.height + contextPaddingPixels,
    );
  const contextCrop = { left, top, width: right - left, height: bottom - top },
    crop = cropPixels(image, contextCrop),
    cropPNG = await png(crop),
    output = workspaceSize(profile, crop),
    requestedScale = Math.min(
      output.width / crop.width,
      output.height / crop.height,
    );
  const resized = await sharp(cropPNG)
    .resize(output.width, output.height, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (resized.info.width < crop.width || resized.info.height < crop.height)
    reject(
      "provider_size",
      "The rendered workspace would lose native crop resolution",
    );
  const padding = {
    left: Math.floor((output.width - resized.info.width) / 2),
    top: Math.floor((output.height - resized.info.height) / 2),
    right: Math.ceil((output.width - resized.info.width) / 2),
    bottom: Math.ceil((output.height - resized.info.height) / 2),
  };
  const providerPNG = await sharp(resized.data, {
    raw: {
      width: resized.info.width,
      height: resized.info.height,
      channels: 4,
    },
  })
    .extend({ ...padding, extendWith: "copy" })
    .png()
    .toBuffer();
  const contentRect = {
      left: padding.left,
      top: padding.top,
      width: resized.info.width,
      height: resized.info.height,
    },
    body = {
      version: 1 as const,
      algorithm: "saved-local-viewport-v1" as const,
      coordinateSpace: "current-base" as const,
      base: {
        width: image.width,
        height: image.height,
        sha256: hash(base),
        rgbaSHA256: hash(image.pixels),
      },
      region,
      contextPaddingPixels,
      nativeRect,
      contextCrop,
      crop: { width: crop.width, height: crop.height, sha256: hash(cropPNG) },
      workspace: {
        width: output.width,
        height: output.height,
        contentRect,
        padding,
        scale: {
          requested: requestedScale,
          x: contentRect.width / crop.width,
          y: contentRect.height / crop.height,
        },
        inverseScale: {
          x: crop.width / contentRect.width,
          y: crop.height / contentRect.height,
        },
      },
      provider: {
        profileId: profile.id,
        requestedSize: output.size,
        width: output.width,
        height: output.height,
        sha256: hash(providerPNG),
      },
    };
  const canonicalBody = savedLocalBitmapFactsSchema
    .omit({ digest: true })
    .parse(body);
  const facts = savedLocalBitmapFactsSchema.parse({
    ...canonicalBody,
    digest: hash(JSON.stringify(canonicalBody)),
  });
  return { facts, cropPNG, providerPNG };
}

async function verifyFacts(base: Buffer, input: SavedLocalBitmapFacts) {
  const facts = savedLocalBitmapFactsSchema.parse(input),
    profile = imageModelProfiles.find(
      (item) => item.id === facts.provider.profileId,
    );
  if (!profile)
    reject("provider_profile", "The bound provider profile is unavailable");
  const current = await prepareSavedLocalBitmap(
    base,
    facts.region,
    profile,
    facts.contextPaddingPixels,
  );
  if (
    current.facts.digest !== facts.digest ||
    JSON.stringify(current.facts) !== JSON.stringify(facts)
  )
    reject("binding_changed", "The current base or viewport facts changed");
  return { facts, profile };
}

/** Actual raw stays immutable; this returns a separate current-base composition. */
export async function composeSavedLocalBitmap(
  base: Buffer,
  providerActual: Buffer,
  factsInput: SavedLocalBitmapFacts,
) {
  const { facts, profile } = await verifyFacts(base, factsInput),
    actual = await decode(providerActual, "Actual provider image");
  if (!validImageSize(profile, `${actual.width}x${actual.height}`))
    reject(
      "provider_dimensions",
      "Actual provider dimensions violate the bound profile",
    );
  // One rounded return pixel on each axis is the complete tolerance. Unlike a
  // percentage bound, this does not permit a visibly different native aspect.
  if (
    Math.abs(
      actual.width * facts.workspace.height -
        actual.height * facts.workspace.width,
    ) >
    facts.workspace.width + facts.workspace.height
  )
    reject(
      "provider_aspect",
      "Actual provider aspect does not match the viewport workspace",
    );
  const workspacePNG = await sharp(providerActual, {
    limitInputPixels: MAX_PIXELS,
    failOn: "warning",
  })
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .resize(facts.workspace.width, facts.workspace.height, { fit: "fill" })
    .png()
    .toBuffer();
  const mapped = await sharp(workspacePNG)
    .extract(facts.workspace.contentRect)
    .resize(facts.contextCrop.width, facts.contextCrop.height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    mapped.info.width !== facts.contextCrop.width ||
    mapped.info.height !== facts.contextCrop.height ||
    mapped.info.channels !== 4
  )
    reject("invalid_image", "The mapped provider crop is incomplete");
  const original = await decode(base, "Current base"),
    result = Buffer.from(original.pixels),
    r = facts.nativeRect,
    cropX = r.left - facts.contextCrop.left,
    cropY = r.top - facts.contextCrop.top;
  for (let y = 0; y < r.height; y++) {
    const from = ((cropY + y) * facts.contextCrop.width + cropX) * 4,
      to = ((r.top + y) * original.width + r.left) * 4;
    mapped.data.copy(result, to, from, from + r.width * 4);
  }
  const data = await png({ ...original, pixels: result });
  return {
    data,
    actual: {
      width: actual.width,
      height: actual.height,
      sha256: hash(providerActual),
      rgbaSHA256: hash(actual.pixels),
    },
    result: {
      width: original.width,
      height: original.height,
      sha256: hash(data),
      rgbaSHA256: hash(result),
      editedPixels: r.width * r.height,
      preservedPixels: original.width * original.height - r.width * r.height,
    },
    geometryDigest: facts.digest,
  };
}

export type SavedLocalBitmapPreviewFrame = {
  role:
    | "original-context"
    | "current-base-coverage"
    | "current-base-local-coverage";
  data: Buffer;
  sha256: string;
  sourceSize: Size;
  sourceRect: Rect;
  displaySize: Size;
  contentRect: Rect;
  selectionCoordinateSpace: "current-base" | null;
};

function outlined(image: Pixels, rect: Rect): Pixels {
  const pixels = Buffer.from(image.pixels);
  for (let y = rect.top; y < rect.top + rect.height; y++)
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      if (
        x > rect.left + 1 &&
        x < rect.left + rect.width - 2 &&
        y > rect.top + 1 &&
        y < rect.top + rect.height - 2
      )
        continue;
      const i = (y * image.width + x) * 4;
      pixels[i] = 255;
      pixels[i + 1] = 48;
      pixels[i + 2] = 48;
      pixels[i + 3] = 255;
    }
  return { ...image, pixels };
}

async function previewFrame(
  role: SavedLocalBitmapPreviewFrame["role"],
  image: Pixels,
  sourceSize: Size,
  sourceRect: Rect,
  selectionCoordinateSpace: SavedLocalBitmapPreviewFrame["selectionCoordinateSpace"],
): Promise<SavedLocalBitmapPreviewFrame> {
  const rendered = await sharp(await png(image))
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  const displaySize = {
    width: rendered.info.width,
    height: rendered.info.height,
  };
  return {
    role,
    data: rendered.data,
    sha256: hash(rendered.data),
    sourceSize,
    sourceRect,
    displaySize,
    contentRect: { left: 0, top: 0, ...displaySize },
    selectionCoordinateSpace,
  };
}

/** Three views only. They are not raw candidates or an authorization proof. */
export async function savedLocalBitmapPreview(
  original: Buffer,
  base: Buffer,
  factsInput: SavedLocalBitmapFacts,
): Promise<{
  facts: SavedLocalBitmapFacts;
  frames: [
    SavedLocalBitmapPreviewFrame,
    SavedLocalBitmapPreviewFrame,
    SavedLocalBitmapPreviewFrame,
  ];
}> {
  const { facts } = await verifyFacts(base, factsInput),
    originalImage = await decode(original, "Frozen original"),
    baseImage = await decode(base, "Current base"),
    local = cropPixels(baseImage, facts.contextCrop),
    localRect = {
      ...facts.nativeRect,
      left: facts.nativeRect.left - facts.contextCrop.left,
      top: facts.nativeRect.top - facts.contextCrop.top,
    };
  const frames = await Promise.all([
    previewFrame(
      "original-context",
      originalImage,
      { width: originalImage.width, height: originalImage.height },
      {
        left: 0,
        top: 0,
        width: originalImage.width,
        height: originalImage.height,
      },
      null,
    ),
    previewFrame(
      "current-base-coverage",
      outlined(baseImage, facts.nativeRect),
      { width: baseImage.width, height: baseImage.height },
      { left: 0, top: 0, width: baseImage.width, height: baseImage.height },
      "current-base",
    ),
    previewFrame(
      "current-base-local-coverage",
      outlined(local, localRect),
      { width: baseImage.width, height: baseImage.height },
      facts.contextCrop,
      "current-base",
    ),
  ]);
  return { facts, frames: [frames[0]!, frames[1]!, frames[2]!] };
}
