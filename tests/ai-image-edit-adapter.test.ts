import { afterEach, it, expect, vi } from "vitest";
import sharp from "sharp";
import {
  prepareImageEdit,
  imageEditPatch,
} from "../apps/server/src/services/ai/image-edit-adapter.js";
import {
  editViewport,
  markEditRegions,
  restoreViewport,
  preserveOutsideRegions,
} from "../apps/server/src/services/ai/image-edit-regions.js";
import { modelImage } from "../apps/server/src/services/ai/model-image.js";
import { imageModelProfiles } from "@core/modules/ai/image-model-catalog.js";
import { systemErrorReason } from "@core/shared/errors.js";
import {
  invokeImageProvider,
  validateImageProviderInput,
  type ImageProviderInput,
} from "../apps/server/src/services/ai/image-provider-adapters.js";

afterEach(() => vi.restoreAllMocks());

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
it.each(["mask", "coordinates", "prompt"] as const)(
  "uses one bounded workspace and identical protected-pixel restoration for %s",
  async (model) => {
    const original = await sharp({
      create: { width: 800, height: 1200, channels: 3, background: "#174263" },
    })
      .png()
      .toBuffer();
    const edit = await prepareImageEdit(
      model,
      "Replace face using Image 2",
      [{ data: original, mime: "image/png", filename: "page.png" }],
      regions,
    );
    expect(edit.viewport!.rect.width).toBeLessThan(400);
    expect(edit.viewport!.rect.height).toBeLessThan(400);
    expect(edit.prompt).toContain("Replace face using Image 2");
    expect(edit.prompt).not.toContain("points");
    const source = await sharp(edit.images[0]!.data).metadata();
    if (model === "mask") {
      const mask = await sharp(edit.mask!)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(mask.info.width).toBe(source.width);
      expect(mask.info.height).toBe(source.height);
      const at = (x: number, y: number) =>
        mask.data[(y * mask.info.width + x) * 4 + 3];
      expect(at(0, 0)).toBe(255);
      expect(
        at(Math.floor(mask.info.width / 2), Math.floor(mask.info.height / 2)),
      ).toBe(0);
    } else {
      expect(edit.mask).toBeUndefined();
      if (model === "coordinates") expect(edit.prompt).toContain("<bbox>");
      else {
        expect(edit.prompt).toContain("紫红色");
        const stats = await sharp(edit.images[0]!.data).stats();
        expect(stats.channels[0]!.max).toBeGreaterThan(200);
        expect(stats.channels[2]!.max).toBeGreaterThan(200);
      }
    }
    const generated = await sharp({
      create: { width: 200, height: 300, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const out = await preserveOutsideRegions(
      original,
      await restoreViewport(original, generated, edit.viewport!.rect),
      regions,
    );
    expect(out.preservation.protectedPixelsChanged).toBe(0);
    expect(out.info).toMatchObject({ width: 800, height: 1200 });
    expect((await sharp(original).raw().toBuffer())[0]).toBe(23);
  },
);
it("bounds all reference previews and preserves real transparency rather than flattening an editable input", async () => {
  const data = await sharp({
    create: {
      width: 2200,
      height: 1100,
      channels: 4,
      background: { r: 10, g: 40, b: 90, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const edit = await prepareImageEdit("prompt", "Edit", [
    { data, mime: "image/png", filename: "transparent.png" },
  ]);
  const preview = await sharp(edit.images[0]!.data)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(preview.info).toMatchObject({ width: 1600, height: 800, channels: 4 });
  expect(preview.data[3]).toBe(0);
  expect(edit.images[0]!.mime).toBe("image/png");
  expect(edit.mask).toBeUndefined();
});

it("pads a portrait workspace to the model output ratio without stretching the subject and removes the padding on restoration", async () => {
  const original = await sharp({
    create: { width: 800, height: 1200, channels: 3, background: "#174263" },
  })
    .png()
    .toBuffer();
  const portrait = [
    {
      label: "face",
      points: [
        [0.45, 0.3],
        [0.55, 0.3],
        [0.55, 0.6],
        [0.45, 0.6],
      ] as [number, number][],
    },
  ];
  const edit = await prepareImageEdit(
    "mask",
    "Edit",
    [{ data: original, mime: "image/png", filename: "page.png" }],
    portrait,
    { width: 1024, height: 1024 },
  );
  const image = await sharp(edit.images[0]!.data).metadata();
  expect(image.width).toBe(image.height);
  expect(edit.workspace!.left).toBeGreaterThan(0);
  const patch = await imageEditPatch(edit, edit.images[0]!.data);
  expect(await sharp(patch).metadata()).toMatchObject({
    width: edit.viewport!.rect.width,
    height: edit.viewport!.rect.height,
  });
  const restored = await preserveOutsideRegions(
    original,
    await restoreViewport(original, patch, edit.viewport!.rect),
    portrait,
  );
  expect(restored.preservation.changedPixels).toBe(0);
});

const wanRegions = [
  {
    label: "complete local target",
    points: [
      [0.3, 0.25],
      [0.7, 0.25],
      [0.7, 0.65],
      [0.3, 0.65],
    ] as [number, number][],
  },
];
const wanInput = (
  edit: Awaited<ReturnType<typeof prepareImageEdit>>,
): ImageProviderInput => ({
  profile: imageModelProfiles.find(
    (profile) => profile.id === "wan2.7-image-pro",
  )!,
  model: "wan2.7-image-pro",
  baseUrl:
    "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
  apiKey: "isolated-validation-no-api",
  operation: "edit",
  prompt: edit.prompt,
  size: "2048x2048",
  images: edit.images,
});

it("removes only the opaque marker Alpha channel, preserves every public markEditRegions RGB pixel, and passes actual Wan edit validation without an API call", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("This fixture must never request an image API"),
    );
  const original = await sharp({
    create: { width: 800, height: 1200, channels: 3, background: "#174263" },
  })
    .png()
    .toBuffer();
  expect(await sharp(original).metadata()).toMatchObject({
    hasAlpha: false,
    channels: 3,
  });
  const viewport = await editViewport(original, wanRegions);
  expect(viewport.rect).toMatchObject({ width: 464, height: 624 });
  const beforeMark = await modelImage(viewport.data);
  const marked = await markEditRegions(beforeMark.data, viewport.regions);
  expect(await sharp(marked).metadata()).toMatchObject({
    format: "png",
    hasAlpha: true,
    channels: 4,
  });
  const markedPixels = await sharp(marked)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(markedPixels.info.channels).toBe(4);
  expect(
    markedPixels.data.every((value, index) => index % 4 !== 3 || value === 255),
  ).toBe(true);
  const expectedRGB = await sharp(marked).removeAlpha().raw().toBuffer();
  expect(
    expectedRGB.equals(await sharp(beforeMark.data).raw().toBuffer()),
  ).toBe(false);
  const edit = await prepareImageEdit(
    "prompt",
    "Replace the visible target using Image 2",
    [{ data: original, mime: "image/png", filename: "original-page.png" }],
    wanRegions,
  );
  const transported = edit.images[0]!;
  expect(transported.mime).toBe("image/png");
  expect(await sharp(transported.data).metadata()).toMatchObject({
    format: "png",
    width: 464,
    height: 624,
    hasAlpha: false,
    channels: 3,
  });
  expect(await sharp(transported.data).raw().toBuffer()).toEqual(expectedRGB);
  const validated = await validateImageProviderInput(wanInput(edit));
  expect(validated.protocol).toBe("wan-native");
  const content = JSON.parse(String(validated.init.body)).input.messages[0]
    .content;
  expect(content[0].image).toBe(
    `data:image/png;base64,${transported.data.toString("base64")}`,
  );
  expect(content[1]).toEqual({ text: edit.prompt });
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves genuinely transparent marked pixels instead of flattening them and lets strict Wan validation reject the local edit before POST", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("Transparent input must be rejected before any API call"),
    );
  const original = await sharp({
    create: {
      width: 800,
      height: 1200,
      channels: 4,
      background: { r: 23, g: 66, b: 99, alpha: 0.4 },
    },
  })
    .png()
    .toBuffer();
  const viewport = await editViewport(original, wanRegions);
  const expected = await markEditRegions(viewport.data, viewport.regions);
  const edit = await prepareImageEdit(
    "prompt",
    "Replace the local target",
    [{ data: original, mime: "image/png", filename: "transparent-page.png" }],
    wanRegions,
  );
  const transported = edit.images[0]!;
  expect(transported.mime).toBe("image/png");
  expect(await sharp(transported.data).metadata()).toMatchObject({
    format: "png",
    width: 464,
    height: 624,
    hasAlpha: true,
    channels: 4,
  });
  const pixels = await sharp(transported.data)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(pixels.info.channels).toBe(4);
  expect(pixels.data[3]).toBe(102);
  expect(pixels.data).toEqual(await sharp(expected).raw().toBuffer());
  expect((await sharp(transported.data).stats()).isOpaque).toBe(false);
  const error = await validateImageProviderInput(wanInput(edit)).catch(
    (caught) => caught,
  );
  expect(systemErrorReason(error)).toEqual({
    code: "image_reference_size_unsupported",
  });
  await expect(invokeImageProvider(wanInput(edit))).rejects.toThrow("透明通道");
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps the ordinary whole-image RGB JPEG preview free of local marks and accepted by current Wan validation without an API call", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("Whole-image validation must not request an API"),
    );
  const original = await sharp({
    create: { width: 800, height: 1200, channels: 3, background: "#174263" },
  })
    .png()
    .toBuffer();
  const expected = await modelImage(original);
  const originalPrompt = "Change the complete image as requested";
  const edit = await prepareImageEdit("prompt", originalPrompt, [
    { data: original, mime: "image/png", filename: "whole-page.png" },
  ]);
  expect(edit.viewport).toBeUndefined();
  expect(edit.workspace).toBeUndefined();
  expect(edit.mask).toBeUndefined();
  expect(edit.prompt).toBe(originalPrompt);
  expect(edit.images).toHaveLength(1);
  expect(edit.images[0]).toMatchObject({
    mime: "image/jpeg",
    filename: "whole-page.jpg",
  });
  expect(edit.images[0]!.data.equals(expected.data)).toBe(true);
  expect(await sharp(edit.images[0]!.data).metadata()).toMatchObject({
    format: "jpeg",
    width: 800,
    height: 1200,
    hasAlpha: false,
    channels: 3,
  });
  const stats = await sharp(edit.images[0]!.data).stats();
  expect(stats.channels[0]!.max).toBeLessThan(150);
  expect(stats.channels[2]!.max).toBeLessThan(150);
  const validated = await validateImageProviderInput(wanInput(edit));
  expect(validated.protocol).toBe("wan-native");
  expect(
    JSON.parse(String(validated.init.body)).input.messages[0].content,
  ).toEqual([
    {
      image: `data:image/jpeg;base64,${edit.images[0]!.data.toString("base64")}`,
    },
    { text: originalPrompt },
  ]);
  expect(fetcher).not.toHaveBeenCalled();
});
