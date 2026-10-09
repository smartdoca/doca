/** The image allowlist is owned by implemented adapters, never by name inference. */
export const imageOperations = ["generate", "reference", "edit"] as const;
export type ImageOperation = (typeof imageOperations)[number];
export type ImageAdapterId =
  "seedream" | "qwen-images" | "qwen-native" | "wan-native" | "openai-images" | "mflux-native-v1";
export type ImageEditMechanism = "mask" | "coordinates" | "prompt";
export type ImageSizeLimits = {
  minPixels: number;
  maxPixels: number;
  maxRatio: number;
  step?: number;
  minEdge?: number;
  maxEdge?: number;
  sizes?: readonly string[];
};
export type ImageModelProfile = {
  id: string;
  providers: readonly string[];
  adapter: ImageAdapterId;
  operations: readonly ImageOperation[];
  maxReferences: number;
  editMechanism: ImageEditMechanism;
  defaultSize: string;
  limits: ImageSizeLimits;
};

const allOperations = imageOperations;
const seedream = (
  id: string,
  minPixels: number,
  maxPixels: number,
  coordinates = false,
): ImageModelProfile => ({
  id,
  providers: ["doubao"],
  adapter: "seedream",
  operations: allOperations,
  maxReferences: 8,
  editMechanism: coordinates ? "coordinates" : "prompt",
  defaultSize: "2048x2048",
  limits: { minPixels, maxPixels, maxRatio: 16 },
});
const qwen = (
  id: string,
  options: Partial<ImageModelProfile> = {},
): ImageModelProfile => ({
  id,
  providers: ["qwen"],
  adapter: "qwen-native",
  operations: allOperations,
  maxReferences: 3,
  editMechanism: "prompt",
  defaultSize: "2048x2048",
  limits: {
    minPixels: 512 * 512,
    maxPixels: 2048 * 2048,
    maxRatio: 4,
    step: 16,
  },
  ...options,
});
const openai = (id: string, flexible = false): ImageModelProfile => ({
  id,
  providers: ["openai", "compatible"],
  adapter: "openai-images",
  operations: allOperations,
  maxReferences: 8,
  editMechanism: "mask",
  defaultSize: "1024x1024",
  limits: flexible
    ? {
        minPixels: 655360,
        maxPixels: 3840 * 2160,
        maxRatio: 3,
        step: 16,
        maxEdge: 3840,
      }
    : {
        minPixels: 1024 * 1024,
        maxPixels: 1536 * 1024,
        maxRatio: 1.5,
        sizes: ["1024x1024", "1536x1024", "1024x1536"],
      },
});

/** Source links and verified request contracts live in docs/ai-image-models.md. */
export const imageModelProfiles: readonly ImageModelProfile[] = [
  ...["mflux-flux2-klein-9b-q8-v1", "mflux-qwen-image-edit-2511-q8-v1"].map((id): ImageModelProfile => ({
    id, providers: ["compatible"], adapter: "mflux-native-v1",
    operations: id === "mflux-flux2-klein-9b-q8-v1" ? allOperations : ["reference", "edit"],
    maxReferences: 8, editMechanism: "prompt", defaultSize: "1024x1024",
    limits: { minPixels: 256 * 256, maxPixels: 2048 * 2048, maxRatio: 4, minEdge: 128, maxEdge: 2048, step: 16 },
  })),
  {
    id: "wan2.7-image-pro",
    providers: ["qwen"],
    adapter: "wan-native",
    operations: allOperations,
    maxReferences: 8,
    editMechanism: "prompt",
    defaultSize: "2048x2048",
    // This implementation deliberately supports one image and at most 2K total
    // pixels for every operation; it does not expose Wan's 4K text-only mode.
    limits: { minPixels: 768 * 768, maxPixels: 2048 * 2048, maxRatio: 8 },
  },
  seedream("doubao-seedream-4-0-250828", 921600, 16777216),
  seedream("doubao-seedream-4-5-251128", 3686400, 16777216),
  seedream("doubao-seedream-5-0-lite-260128", 3686400, 16777216),
  seedream("doubao-seedream-5-0-pro-260628", 921600, 4624220, true),
  seedream("doubao-seedream-5-0-flash-260915", 921600, 4624220, true),
  ...["qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.1-pro"].map((id) =>
    qwen(id, {
      adapter: "qwen-images",
      maxReferences: id === "qwen-image-2.1-pro" ? 8 : 3,
      limits: {
        minPixels: 512 * 512,
        maxPixels: 2048 * 2048,
        maxRatio: 8,
        step: 16,
      },
    }),
  ),
  ...[
    "qwen-image-2.0-pro",
    "qwen-image-2.0-pro-2026-06-22",
    "qwen-image-2.0-pro-2026-04-22",
    "qwen-image-2.0-pro-2026-03-03",
    "qwen-image-2.0",
    "qwen-image-2.0-2026-03-03",
  ].map((id) => qwen(id)),
  ...[
    "qwen-image-max",
    "qwen-image-max-2025-12-30",
    "qwen-image-plus",
    "qwen-image-plus-2026-01-09",
    "qwen-image",
  ].map((id) =>
    qwen(id, {
      operations: ["generate"],
      maxReferences: 0,
      defaultSize: "1328x1328",
      limits: {
        minPixels: 928 * 1664,
        maxPixels: 1328 * 1328,
        maxRatio: 2,
        sizes: ["1664x928", "1472x1104", "1328x1328", "1104x1472", "928x1664"],
      },
    }),
  ),
  ...[
    "qwen-image-edit-max",
    "qwen-image-edit-max-2026-01-16",
    "qwen-image-edit-plus",
    "qwen-image-edit-plus-2025-12-15",
    "qwen-image-edit-plus-2025-10-30",
  ].map((id) =>
    qwen(id, {
      operations: ["reference", "edit"],
      defaultSize: "1024x1024",
      limits: {
        minPixels: 512 * 512,
        maxPixels: 2048 * 2048,
        maxRatio: 4,
        step: 16,
        minEdge: 512,
        maxEdge: 2048,
      },
    }),
  ),
  ...["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5"].map((id) =>
    openai(id),
  ),
  ...[
    "gpt-image-2",
    "gpt-image-2-2026-04-21",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst-2026-09-08",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-flare-2026-09-08",
  ].map((id) => openai(id, true)),
];

export function imageProfilesForProvider(provider: string | undefined) {
  return imageModelProfiles.filter(
    (profile) => !!provider && profile.providers.includes(provider),
  );
}

export function imageProfileForModel(model: {
  provider?: string;
  imageProfile?: string;
  imageGeneration?: boolean;
}) {
  if (!model.imageGeneration || !model.imageProfile || !model.provider)
    return undefined;
  return imageProfilesForProvider(model.provider).find(
    (profile) => profile.id === model.imageProfile,
  );
}

export function supportsImageOperation(
  model: Parameters<typeof imageProfileForModel>[0],
  operation: ImageOperation,
) {
  return imageProfileForModel(model)?.operations.includes(operation) === true;
}

/** Defaults for existing configurations, explicitly approved by the user. */
export function defaultImageProfile(
  provider: string | undefined,
  model?: string,
) {
  // New Wan inputs require an explicit profile; the approved old-default reader
  // must not infer this newly implemented protocol from a model name.
  if (["wan2.7-image-pro", "flux2-klein-9b-8bit", "qwen-image-edit-2511-8bit", "mflux-flux2-klein-9b-q8-v1", "mflux-qwen-image-edit-2511-q8-v1"].includes(model ?? "")) return undefined;
  const profiles = imageProfilesForProvider(provider);
  const exact = profiles.find((profile) => profile.id === model);
  if (exact) return exact;
  const id =
    provider === "doubao"
      ? "doubao-seedream-5-0-pro-260628"
      : provider === "qwen"
        ? "qwen-image-3.0-pro"
        : "gpt-image-2";
  return profiles.find((profile) => profile.id === id);
}

export function imageModelIdForOperation(
  config: {
    imageModel?: string;
    imageToolModels?: Partial<Record<ImageOperation, string>>;
  },
  operation: ImageOperation,
) {
  return config.imageToolModels?.[operation] || config.imageModel || "";
}

export function validImageSize(profile: ImageModelProfile, size: string) {
  if (!/^\d{2,4}x\d{2,4}$/.test(size)) return false;
  const [width, height] = size.split("x").map(Number) as [number, number];
  const { limits } = profile;
  if (limits.sizes) return limits.sizes.includes(size);
  return (
    width * height >= limits.minPixels &&
    width * height <= limits.maxPixels &&
    Math.max(width / height, height / width) <= limits.maxRatio &&
    (!limits.step ||
      (width % limits.step === 0 && height % limits.step === 0)) &&
    (!limits.minEdge || Math.min(width, height) >= limits.minEdge) &&
    (!limits.maxEdge || Math.max(width, height) <= limits.maxEdge)
  );
}

/** Select a legal size near the source aspect ratio; never shrink a source silently. */
export function imageSizeForRatio(
  profile: ImageModelProfile,
  ratio: number,
  source?: { width: number; height: number },
) {
  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    Math.max(ratio, 1 / ratio) > profile.limits.maxRatio
  )
    return undefined;
  const sizes = profile.limits.sizes;
  if (sizes)
    return sizes.find((size) => {
      const [width, height] = size.split("x").map(Number) as [number, number];
      return (
        Math.abs(width / height - ratio) < 0.015 &&
        (!source || (width >= source.width && height >= source.height))
      );
    });
  const [defaultWidth, defaultHeight] = profile.defaultSize
    .split("x")
    .map(Number) as [number, number];
  const pixels = Math.max(
    profile.limits.minPixels,
    source ? source.width * source.height : defaultWidth * defaultHeight,
  );
  const step = profile.limits.step ?? 1;
  const edge = profile.limits.minEdge ?? 1;
  const height =
    Math.ceil(
      Math.max(
        Math.sqrt(pixels / ratio),
        edge,
        edge / ratio,
        source?.height ?? 0,
        (source?.width ?? 0) / ratio,
      ) / step,
    ) * step;
  const width = Math.ceil((height * ratio) / step) * step;
  const size = `${width}x${height}`;
  if (validImageSize(profile, size)) return size;
  // At the upper pixel boundary, rounding up can exceed the limit. Explicit ratios
  // without source pixels can use the largest legal multiple below that boundary.
  if (source) return undefined;
  const boundedHeight =
    Math.floor(Math.sqrt(profile.limits.maxPixels / ratio) / step) * step;
  const boundedWidth = Math.floor((boundedHeight * ratio) / step) * step;
  const bounded = `${boundedWidth}x${boundedHeight}`;
  return validImageSize(profile, bounded) ? bounded : undefined;
}
