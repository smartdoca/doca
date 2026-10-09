import { z } from "zod";
import { imageInputSchema, type ImageInput } from "./images.js";
import type { ImageOperation } from "@core/modules/ai/image-model-catalog.js";
import { savedLocalBitmapRegionSchema } from "./image-saved-local-bitmap.js";

export const imageToolNames = {
  generate: "image_generate",
  reference: "image_reference_generate",
  edit: "image_edit",
} as const satisfies Record<ImageOperation, string>;

const common = imageInputSchema.extend({
  prompt: imageInputSchema.shape.prompt.describe(
    "清楚、简洁地说明生成或修改目标，以及图1、图2等参考图的用途。局部编辑只描述目标变化，系统转换工作窗口和坐标。",
  ),
  size: imageInputSchema.shape.size.describe(
    "通常省略；系统按所选模型的能力和默认尺寸选择。仅在用户明确指定且模型支持时传入，与 aspectRatio 二选一。",
  ),
});

/** Tool intent is explicit, even when several tools share one provider endpoint. */
export const imageGenerateInputSchema = common
  .omit({
    referenceImageIds: true,
    referenceCrops: true,
    editRegions: true,
  })
  .strict();
export const imageReferenceInputSchema = common
  .omit({ editRegions: true, referenceCrops: true })
  .extend({
    referenceImageIds: z
      .array(z.string().uuid())
      .min(1)
      .max(8)
      .describe(
        "生成新图所用的实际参考图片 ID，按提示词图1、图2排序。修改已有底图时改用 image_edit。",
      ),
  })
  .strict();
export const imageEditInputSchema = common
  .extend({
    sourceImageId: z
      .string()
      .uuid()
      .describe(
        "需要修改的底图 ID，与附加身份、风格参考明确区分；系统将底图作为图1。",
      ),
    referenceImageIds: z
      .array(z.string().uuid())
      .max(7)
      .optional()
      .describe(
        "可选的附加身份、风格参考 ID，依次作为图2及之后的图片；不要重复填写底图 ID。",
      ),
  })
  .strict()
  .refine(
    (input) => !(input.referenceImageIds ?? []).includes(input.sourceImageId),
    {
      message: "底图不能重复作为附加参考图片",
      path: ["referenceImageIds"],
    },
  );

export function normalizeImageEditInput(
  input: z.infer<typeof imageEditInputSchema>,
): ImageInput {
  const { sourceImageId, referenceImageIds, ...rest } = input;
  return {
    ...rest,
    referenceImageIds: [sourceImageId, ...(referenceImageIds ?? [])],
  };
}

export const imageEditSavedInputSchema = common.omit({editRegions:true}).extend({
  originalReferenceImageId:z.string().uuid().describe("冻结的原书页 ID；验收始终对照此页"),
  baseAssetId:z.string().uuid().describe("本页当前 delivered 的成品 assetId；作为实际图1保留已有修改"),
  referenceImageIds:z.array(z.string().uuid()).max(7).optional().describe("图2起的身份、风格或场景参考；不要重复原页或成品底图"),
}).strict().refine(v=>!(v.referenceImageIds??[]).some(id=>id===v.baseAssetId||id===v.originalReferenceImageId));

export const imageEditSavedLocalInputSchema = common.omit({editRegions:true,size:true,aspectRatio:true}).extend({
  originalReferenceImageId:z.string().uuid().describe("冻结原书页；只作上下文和完整验收，不作成品底图"),
  baseAssetId:z.string().uuid().describe("当前本页最新成品；选区坐标属于这张图"),
  region:savedLocalBitmapRegionSchema.describe("当前成品上的完整返修选区，left/top/width/height为0到1；覆盖自然轮廓及必要邻近接触范围，其他区域逐像素保留。先用本工具的preview实际查看覆盖范围"),
  contextPaddingPixels:z.number().int().min(0).max(512).optional().describe("选区周围只供模型理解的上下文像素；省略时为64，这些上下文不会自动采用"),
  referenceImageIds:z.array(z.string().uuid()).max(6).optional().describe("身份等附加参考，不重复当前成品或原页；原页由宿主放在最后作为上下文"),
}).strict().refine(v=>!(v.referenceImageIds??[]).some(id=>id===v.baseAssetId||id===v.originalReferenceImageId));
