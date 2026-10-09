import { z } from "zod";
import type { DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import {
  imageEditMaskReceiptSchema,
  previewImageEditMask,
  readImageEditMask,
  type ImageEditMaskReceipt,
} from "./image-edit-mask.js";
import { modelImage } from "./model-image.js";

export const imageMaskViewInputSchema = z
  .object({ maskReceiptId: z.string().uuid() })
  .strict();
export const imageMaskViewOutputSchema = imageEditMaskReceiptSchema
  .pick({
    kind: true,
    version: true,
    state: true,
    digest: true,
    generatedWindow: true,
    coverage: true,
    diagnostics: true,
    instruction: true,
  })
  .extend({
    readonly: z.literal(true),
    maskReceiptId: z.string().uuid(),
    referenceImageId: z.string().uuid(),
    generationOperationId: z.string().uuid(),
    source: imageEditMaskReceiptSchema.shape.source.omit({
      referenceImageId: true,
    }),
    binding: imageEditMaskReceiptSchema
      .pick({
        scope: true,
        raw: true,
        transform: true,
        proposalBindings: true,
        maskDigest: true,
        protectionDigest: true,
      })
      .strict(),
  })
  .strict();
export type ImageMaskViewInput = z.infer<typeof imageMaskViewInputSchema>;
export type ImageMaskViewOutput = z.infer<typeof imageMaskViewOutputSchema>;
type Options = {
  vision: boolean;
  storage?: StorageRuntime;
  signal?: AbortSignal;
};

function input(value: ImageMaskViewInput, options: Options) {
  const parsed = imageMaskViewInputSchema.parse(value);
  if (!options.vision) fail(409, "蒙版重看需要能实际读取图片的视觉模型");
  return parsed;
}
function facts(receipt: ImageEditMaskReceipt): ImageMaskViewOutput {
  return imageMaskViewOutputSchema.parse({
    kind: receipt.kind,
    version: receipt.version,
    state: receipt.state,
    readonly: true,
    maskReceiptId: receipt.receiptId,
    digest: receipt.digest,
    referenceImageId: receipt.input.referenceImageId,
    generationOperationId: receipt.input.generationOperationId,
    source: {
      width: receipt.source.width,
      height: receipt.source.height,
      sha256: receipt.source.sha256,
    },
    binding: {
      scope: receipt.scope,
      raw: receipt.raw,
      transform: receipt.transform,
      proposalBindings: receipt.proposalBindings,
      maskDigest: receipt.maskDigest,
      protectionDigest: receipt.protectionDigest,
    },
    generatedWindow: receipt.generatedWindow,
    coverage: receipt.coverage,
    diagnostics: receipt.diagnostics,
    instruction: receipt.instruction,
  });
}

/** Revalidate an existing v2 receipt. This does not prepare or save a new mask. */
export async function viewImageMask(
  db: DB,
  ctx: ToolContext,
  value: ImageMaskViewInput,
  options: Options,
): Promise<ImageMaskViewOutput> {
  const { maskReceiptId } = input(value, options);
  const result = await readImageEditMask(db, ctx, maskReceiptId, options);
  return facts(result.receipt);
}

/** Actual bounded media, reauthorized separately from the textual tool result.
 * The caller must observe both transmitted frames and enforce a later round;
 * returning this object alone never grants inspection or semantic approval.
 */
export async function imageMaskViewModelOutput(
  db: DB,
  ctx: ToolContext,
  value: ImageMaskViewInput,
  expectedFacts: ImageMaskViewOutput,
  options: Options,
) {
  const { maskReceiptId } = input(value, options);
  const expected = imageMaskViewOutputSchema.parse(expectedFacts);
  if (expected.maskReceiptId !== maskReceiptId)
    fail(409, "蒙版查看回执与本次输出不一致");
  const preview = await previewImageEditMask(db, ctx, maskReceiptId, options);
  const current = facts(preview.receipt);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    fail(409, "蒙版查看绑定或诊断事实已改变，请重新读取");
  const frames = await Promise.all(
    [preview.full, preview.local].map(async (frame) => ({
      ...frame,
      pixels: await modelImage(frame.data),
    })),
  );
  options.signal?.throwIfAborted();
  // Converting media can take time. Recheck permissions and all bound facts
  // before these private buffers can become model input.
  const final = await viewImageMask(db, ctx, value, options);
  if (JSON.stringify(final) !== JSON.stringify(current))
    fail(409, "蒙版查看绑定或诊断事实已改变，请重新读取");
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: JSON.stringify(current) },
      ...frames.flatMap((frame) => [
        {
          type: "text" as const,
          text: JSON.stringify({
            maskReceiptId: current.maskReceiptId,
            digest: current.digest,
            referenceImageId: current.referenceImageId,
            generationOperationId: current.generationOperationId,
            view: frame.view,
            sourceRect: frame.sourceRect,
            contentRect: frame.contentRect,
            width: frame.width,
            height: frame.height,
          }),
        },
        {
          type: "media" as const,
          mediaType: frame.pixels.mime,
          data: frame.pixels.data.toString("base64"),
        },
      ]),
    ],
  };
}
