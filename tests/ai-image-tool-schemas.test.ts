import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  imageGenerateInputSchema,
  imageReferenceInputSchema,
  imageEditInputSchema,
  normalizeImageEditInput,
} from "../apps/server/src/services/ai/image-tool-schemas.js";

it("text generation refuses image inputs and reference generation requires references", () => {
  const input = { prompt: "生成一个新场景" };
  expect(imageGenerateInputSchema.safeParse(input).success).toBe(true);
  expect(
    imageGenerateInputSchema.safeParse({
      ...input,
      referenceImageIds: [randomUUID()],
    }).success,
  ).toBe(false);
  expect(imageReferenceInputSchema.safeParse(input).success).toBe(false);
  expect(
    imageReferenceInputSchema.safeParse({
      ...input,
      referenceImageIds: [randomUUID()],
    }).success,
  ).toBe(true);
});

it("editing requires a distinct source and keeps reference ordering", () => {
  const sourceImageId = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  expect(
    imageEditInputSchema.safeParse({
      prompt: "替换人物",
      referenceImageIds: [first],
    }).success,
  ).toBe(false);
  expect(
    imageEditInputSchema.safeParse({
      prompt: "替换人物",
      sourceImageId,
      referenceImageIds: [sourceImageId],
    }).success,
  ).toBe(false);
  const parsed = imageEditInputSchema.parse({
    prompt: "替换人物",
    sourceImageId,
    referenceImageIds: [first, second],
  });
  expect(normalizeImageEditInput(parsed)).toEqual({
    prompt: "替换人物",
    referenceImageIds: [sourceImageId, first, second],
  });
  expect(
    normalizeImageEditInput(
      imageEditInputSchema.parse({ prompt: "修改背景", sourceImageId }),
    ).referenceImageIds,
  ).toEqual([sourceImageId]);
});
