import sharp from "sharp";
import {
  editViewport,
  editMask,
  markEditRegions,
  type EditRegions,
} from "./image-edit-regions.js";
import { modelImage } from "./model-image.js";
import { z } from "zod";
import type { ImageEditMechanism } from "@core/modules/ai/image-model-catalog.js";

export const referenceCropsSchema = z
  .array(
    z
      .object({
        referenceImageId: z.string().uuid(),
        box: z
          .tuple([
            z.number().min(0).max(1),
            z.number().min(0).max(1),
            z.number().min(0).max(1),
            z.number().min(0).max(1),
          ])
          .refine(([left, top, right, bottom]) => left < right && top < bottom),
      })
      .strict(),
  )
  .min(1)
  .max(7)
  .refine(
    (crops) =>
      new Set(crops.map((crop) => crop.referenceImageId)).size === crops.length,
  );
export type ReferenceCrops = z.infer<typeof referenceCropsSchema>;

type Reference = { data: Buffer; mime: string; filename: string };

/** Select the relevant view in a contact sheet; the source ID and full original stay durable. */
export async function cropImageReferences(
  references: Reference[],
  ids: string[],
  crops?: ReferenceCrops,
) {
  if (!crops) return references;
  referenceCropsSchema.parse(crops);
  if (crops.some((crop) => ids.indexOf(crop.referenceImageId) < 1))
    throw Error(
      "只允许裁切图2及之后的身份/风格参考，且ID必须在referenceImageIds中",
    );
  return Promise.all(
    references.map(async (reference, index) => {
      const crop = crops.find((crop) => crop.referenceImageId === ids[index]);
      if (!crop) return reference;
      const source = await sharp(reference.data)
        .rotate()
        .png()
        .toBuffer({ resolveWithObject: true });
      const [left, top, right, bottom] = crop.box;
      const x = Math.floor(left * source.info.width),
        y = Math.floor(top * source.info.height);
      const width = Math.ceil(right * source.info.width) - x,
        height = Math.ceil(bottom * source.info.height) - y;
      return {
        ...reference,
        data: await sharp(source.data)
          .extract({ left: x, top: y, width, height })
          .png()
          .toBuffer(),
        mime: "image/png",
      };
    }),
  );
}

/** Transport previews retain alpha where it affects an edit, and never crop composition. */
async function referencePreview(
  image: Reference,
  png = false,
): Promise<Reference> {
  const metadata = await sharp(image.data).metadata();
  const transparent =
    metadata.hasAlpha && !(await sharp(image.data).stats()).isOpaque;
  const preview =
    png || transparent
      ? {
          data: await sharp(image.data)
            .rotate()
            .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer(),
          mime: "image/png",
        }
      : await modelImage(image.data);
  return {
    ...image,
    ...preview,
    filename: image.filename.replace(
      /\.[^.]+$/,
      preview.mime === "image/png" ? ".png" : ".jpg",
    ),
  };
}

/** Native coordinate syntax belongs in the adapter, never in the task's source coordinates.
 * https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro-editing-guide
 */
export function seedreamRegionPrompt(prompt: string, regions: EditRegions) {
  const coordinate = (value: number) =>
    Math.max(0, Math.min(999, Math.round(value * 1000)));
  const targets = regions
    .map(({ label, points }) => {
      const x = points.map(([x]) => x),
        y = points.map(([, y]) => y);
      return `${label}：Image 1 <bbox>${[Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)].map(coordinate).join(" ")}</bbox>`;
    })
    .join("；");
  return `图1是原图的局部窗口，只返回这个窗口的编辑结果。构图、人物位置、大小、动作、姿势和朝向按用户明确的修改目标执行；未要求改变的部分保留图1原意，不自行放大、居中或重构。目标：${targets}。框用于定位目标，框内其他物体与背景仍须保留。\n${prompt}`;
}

/** Common workspace, preview and restoration; only the model's input mechanism differs. */
export async function prepareImageEdit(
  mechanism: ImageEditMechanism,
  prompt: string,
  references: Reference[],
  regions?: EditRegions,
  outputSize?: { width: number; height: number },
) {
  const viewport = regions
    ? await editViewport(references[0]!.data, regions)
    : undefined;
  const nativeMask = !!viewport && mechanism === "mask";
  const nativeCoordinates = !!viewport && mechanism === "coordinates";
  let workingPixels = viewport?.data;
  let workingRegions = viewport?.regions;
  let workspace:
    | { width: number; height: number; left: number; top: number; contentWidth: number; contentHeight: number }
    | undefined;
  if (viewport && outputSize) {
    const { width: contentWidth, height: contentHeight } = viewport.rect;
    const ratio = outputSize.width / outputSize.height;
    const width = Math.max(contentWidth, Math.ceil(contentHeight * ratio));
    const height = Math.max(contentHeight, Math.ceil(contentWidth / ratio));
    const left = Math.floor((width - contentWidth) / 2);
    const top = Math.floor((height - contentHeight) / 2);
    workspace = { width, height, left, top, contentWidth, contentHeight };
    workingPixels = await sharp(viewport.data).extend({
      left, right: width - contentWidth - left,
      top, bottom: height - contentHeight - top,
      extendWith: "copy",
    }).png().toBuffer();
    workingRegions = viewport.regions.map(region => ({
      ...region,
      points: region.points.map(([x, y]) => [
        (x * contentWidth + left) / width,
        (y * contentHeight + top) / height,
      ] as [number, number]),
    }));
  }
  const images = await Promise.all(
    references.map((reference, index) =>
      referencePreview(
        index === 0 && viewport
          ? { ...reference, data: workingPixels!, mime: "image/png" }
          : reference,
        index === 0 && nativeMask,
      ),
    ),
  );
  let mask: Buffer | undefined;
  if (viewport) {
    if (nativeMask) mask = await editMask(images[0]!.data, workingRegions!);
    else if (!nativeCoordinates) {
      const marked = await markEditRegions(images[0]!.data, workingRegions!);
      // SVG compositing adds an alpha channel even to an opaque input. Only
      // strip that redundant channel from the host's local-edit transport;
      // genuinely transparent pixels keep their original alpha values.
      const transport = (await sharp(marked).stats()).isOpaque
        ? await sharp(marked).removeAlpha().png().toBuffer()
        : marked;
      images[0] = await referencePreview(
        {
          ...images[0]!,
          data: transport,
        },
        true,
      );
    }
    prompt = nativeCoordinates
      ? seedreamRegionPrompt(prompt, workingRegions!)
      : `图1是原图的局部编辑窗口，只返回这个窗口。构图、主体位置、比例、动作、姿势与朝向按用户明确的修改目标执行；未要求改变的部分保留原意。仅修改${nativeMask ? "蒙版透明区内" : "紫红色轮廓标记的"}目标：${viewport.regions.map((r) => r.label).join("；")}；其他物体与背景保持不变。${nativeMask ? "" : "标记仅用于定位，输出必须去除标记，不能画色块或描边。"}\n${prompt}`;
  }
  return { viewport, workspace, images, mask, prompt };
}

/** Remove aspect-ratio padding before composing the patch at its original coordinates. */
export async function imageEditPatch(
  edit: Awaited<ReturnType<typeof prepareImageEdit>>,
  generated: Buffer,
) {
  if (!edit.workspace) return generated;
  const { width, height, left, top, contentWidth, contentHeight } = edit.workspace;
  const canvas = await sharp(generated).rotate().resize(width, height, { fit: "fill" }).png().toBuffer();
  return sharp(canvas).extract({ left, top, width: contentWidth, height: contentHeight }).png().toBuffer();
}
