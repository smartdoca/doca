import { createHash } from "node:crypto";
import { z } from "zod";
import {
  imageBatchAttemptScopeV2Schema,
  imageBatchAttemptScopeV3Schema,
} from "./image-batch.js";
import { referenceCropsSchema } from "./image-edit-adapter.js";
import {
  savedLocalBitmapFactsSchema,
  type SavedLocalBitmapFacts,
} from "./image-saved-local-bitmap.js";
import {
  isSavedGenerationReceipt,
  imageGenerationV1ReceiptSchema,
} from "./image-generation-contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const revisionReferenceSchema = z
  .object({
    referenceImageId: z.string().uuid(),
    sha256: hash,
    size: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.width * v.height <= 25_000_000);

/** Host facts, never model input. The original page and the actual provider base are distinct. */
export const imageRevisionBindingSchema = z
  .object({
    version: z.literal(1),
    actorId: z.string().uuid(),
    sessionId: z.string().uuid(),
    attemptScope: imageBatchAttemptScopeV2Schema,
    requirementsDigest: hash,
    original: revisionReferenceSchema,
    base: revisionReferenceSchema
      .safeExtend({ operationId: z.string().uuid(), receiptDigest: hash })
      .strict(),
  })
  .strict()
  .refine((v) => v.original.referenceImageId !== v.base.referenceImageId);
export type ImageRevisionBinding = z.infer<typeof imageRevisionBindingSchema>;

const paidAttempt = z
  .object({
    version: z.literal(2),
    scope: imageBatchAttemptScopeV2Schema,
    referenceImageId: z.string().uuid(),
    ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const revisionRawPointerSchema = z
  .object({
    kind: z.literal("image_revision_raw"),
    version: z.literal(1),
    receiptId: z.string().uuid(),
    assetId: z.string().uuid(),
    sha256: hash,
  })
  .strict();
const request = z
  .object({
    prompt: z.string().min(2).max(8000),
    referenceImageIds: z.array(z.string().uuid()).min(1).max(8),
    referenceCrops: referenceCropsSchema.optional(),
  })
  .strict();
const common = z
  .object({
    kind: z.literal("image_revision"),
    version: z.literal(1),
    generationOperationId: z.string().uuid(),
    resourceId: z.string().uuid().optional(),
    originalReferenceImageId: z.string().uuid(),
    binding: imageRevisionBindingSchema,
    providerReferenceImageIds: z.array(z.string().uuid()).min(1).max(8),
    reviewGeneration: request,
    paidAttempt,
    rawCandidate: revisionRawPointerSchema.optional(),
    providerCallId: z.string().uuid().optional(),
  })
  .strict();
export const imageRevisionSavedSchema = common
  .extend({
    state: z.literal("saved"),
    assetId: z.string().uuid(),
    filename: z.string().min(1),
    rawCandidate: revisionRawPointerSchema,
    providerCallId: z.string().uuid(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mime: z.literal("image/png"),
    size: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    ready: z.literal(true),
    url: z.string(),
    instruction: z.string(),
    providerImageUsage: z
      .object({ inputImages: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export const imageRevisionReceiptSchema = z
  .union([
    imageRevisionSavedSchema,
    common
      .extend({ state: z.enum(["generating", "failed", "save_failed"]) })
      .strict(),
  ])
  .refine(
    (v) =>
      v.originalReferenceImageId === v.binding.original.referenceImageId &&
      v.paidAttempt.referenceImageId === v.originalReferenceImageId &&
      JSON.stringify(v.paidAttempt.scope) ===
        JSON.stringify(v.binding.attemptScope) &&
      v.providerReferenceImageIds[0] === v.binding.base.referenceImageId &&
      v.reviewGeneration.referenceImageIds[0] === v.originalReferenceImageId &&
      JSON.stringify(v.providerReferenceImageIds.slice(1)) ===
        JSON.stringify(v.reviewGeneration.referenceImageIds.slice(1)) &&
      new Set(v.providerReferenceImageIds).size ===
        v.providerReferenceImageIds.length &&
      !v.providerReferenceImageIds.includes(v.originalReferenceImageId) &&
      (v.reviewGeneration.referenceCrops ?? []).every(
        (crop) =>
          v.providerReferenceImageIds.indexOf(crop.referenceImageId) > 0,
      ) &&
      (v.state !== "saved" || v.width * v.height <= 25_000_000),
  );

/** Explicit dispatch. Unknown revision formats never acquire a saved-image permission. */
export function savedRevision(value: unknown) {
  const parsed = imageRevisionReceiptSchema.safeParse(value);
  return parsed.success && parsed.data.state === "saved"
    ? parsed.data
    : undefined;
}
export function isSavedImageReceipt(value: any): boolean {
  return value?.kind === "image_generation"
    ? isSavedGenerationReceipt(value)
    : !!anySavedRevision(value);
}
export function savedImageReviewGeneration(value: any): unknown {
  if (value?.kind !== "image_generation")
    return anySavedRevision(value)?.reviewGeneration;
  if (value.version === undefined) return value.generation;
  const parsed = imageGenerationV1ReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data.generation : undefined;
}

export const imageRevisionViewOutputSchema = z
  .object({
    kind: z.literal("image_revision_view"),
    version: z.literal(1),
    generationOperationId: z.string().uuid(),
    receiptId: z.string().uuid(),
    sha256: hash,
    originalReferenceImageId: z.string().uuid(),
    baseAssetId: z.string().uuid(),
    rawAssetId: z.string().uuid(),
    bindingDigest: hash,
    instruction: z.string(),
  })
  .strict();

const bindingV2Fields = {
  version: z.literal(2),
  actorId: z.string().uuid(),
  sessionId: z.string().uuid(),
  attemptScope: imageBatchAttemptScopeV3Schema,
  requirementsDigest: hash,
  original: revisionReferenceSchema,
  base: revisionReferenceSchema
    .safeExtend({ operationId: z.string().uuid(), receiptDigest: hash })
    .strict(),
};
export const imageRevisionWholeBindingV2Schema = z
  .object({ ...bindingV2Fields, mode: z.literal("whole") })
  .strict();
function validLocalFacts(facts: SavedLocalBitmapFacts) {
  const { digest, ...body } = facts,
    r = facts.nativeRect,
    c = facts.contextCrop,
    w = facts.workspace,
    p = w.padding,
    content = w.contentRect,
    base = facts.base;
  const expectedRect = {
    left: Math.floor(facts.region.left * base.width),
    top: Math.floor(facts.region.top * base.height),
    width:
      Math.ceil((facts.region.left + facts.region.width) * base.width) -
      Math.floor(facts.region.left * base.width),
    height:
      Math.ceil((facts.region.top + facts.region.height) * base.height) -
      Math.floor(facts.region.top * base.height),
  };
  return (
    digest ===
      createHash("sha256").update(JSON.stringify(body)).digest("hex") &&
    r.left === expectedRect.left &&
    r.top === expectedRect.top &&
    r.width === expectedRect.width &&
    r.height === expectedRect.height &&
    c.left === Math.max(0, r.left - facts.contextPaddingPixels) &&
    c.top === Math.max(0, r.top - facts.contextPaddingPixels) &&
    c.left + c.width ===
      Math.min(base.width, r.left + r.width + facts.contextPaddingPixels) &&
    c.top + c.height ===
      Math.min(base.height, r.top + r.height + facts.contextPaddingPixels) &&
    facts.crop.width === c.width &&
    facts.crop.height === c.height &&
    w.width * w.height <= 25_000_000 &&
    c.width * c.height <= 25_000_000 &&
    content.left === p.left &&
    content.top === p.top &&
    content.width + p.left + p.right === w.width &&
    content.height + p.top + p.bottom === w.height &&
    w.scale.requested === Math.min(w.width / c.width, w.height / c.height) &&
    w.scale.x === content.width / c.width &&
    w.scale.y === content.height / c.height &&
    w.inverseScale.x === c.width / content.width &&
    w.inverseScale.y === c.height / content.height &&
    facts.provider.width === w.width &&
    facts.provider.height === w.height &&
    facts.provider.requestedSize === `${w.width}x${w.height}`
  );
}
export const imageRevisionLocalBindingV2Schema = z
  .object({
    ...bindingV2Fields,
    mode: z.literal("local"),
    localFacts: savedLocalBitmapFactsSchema,
  })
  .strict()
  .refine((value) => validLocalFacts(value.localFacts));
export const imageRevisionBindingV2Schema = z
  .discriminatedUnion("mode", [
    imageRevisionWholeBindingV2Schema,
    imageRevisionLocalBindingV2Schema,
  ])
  .refine(
    (value) =>
      value.original.referenceImageId !== value.base.referenceImageId &&
      (value.mode === "whole" ||
        (value.localFacts.base.sha256 === value.base.sha256 &&
          value.localFacts.base.width === value.base.width &&
          value.localFacts.base.height === value.base.height)),
  );
export type ImageRevisionBindingV2 = z.infer<
  typeof imageRevisionBindingV2Schema
>;
export const imageRevisionAnyBindingSchema = z.union([
  imageRevisionBindingSchema,
  imageRevisionBindingV2Schema,
]);
export type ImageRevisionAnyBinding = z.infer<
  typeof imageRevisionAnyBindingSchema
>;
export const imageRevisionBindingDigest = (binding: ImageRevisionAnyBinding) =>
  createHash("sha256").update(JSON.stringify(binding)).digest("hex");

/** Actual provider bytes, in their submitted order. A viewport is never a full base. */
export const revisionProviderReferenceSchema = revisionReferenceSchema
  .safeExtend({
    order: z.number().int().nonnegative().max(7),
    role: z.enum(["base", "base-viewport", "identity", "original-context"]),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict();
export type RevisionProviderReference = z.infer<
  typeof revisionProviderReferenceSchema
>;
export const revisionProviderReferencesSchema = z
  .array(revisionProviderReferenceSchema)
  .min(1)
  .max(8)
  .refine(
    (values) =>
      values.every((value, index) => value.order === index) &&
      new Set(values.map((value) => value.referenceImageId)).size ===
        values.length,
  );
export const revisionRawPointerV2Schema = revisionRawPointerSchema
  .extend({ version: z.literal(2) })
  .strict();
export const revisionAnyRawPointerSchema = z.union([
  revisionRawPointerSchema,
  revisionRawPointerV2Schema,
]);
export const revisionPaidAttemptV3Schema = paidAttempt
  .extend({ version: z.literal(3), scope: imageBatchAttemptScopeV3Schema })
  .strict();

export const imageRevisionLocalPreviewSchema = z
  .object({
    kind: z.literal("image_revision_local_preview"),
    version: z.literal(1),
    binding: imageRevisionLocalBindingV2Schema,
    bindingDigest: hash,
    geometryDigest: hash,
    instruction: z.string(),
  })
  .strict()
  .refine(
    (value) =>
      value.geometryDigest === value.binding.localFacts.digest &&
      value.bindingDigest === imageRevisionBindingDigest(value.binding) &&
      value.binding.original.referenceImageId !==
        value.binding.base.referenceImageId &&
      value.binding.localFacts.base.sha256 === value.binding.base.sha256 &&
      value.binding.localFacts.base.width === value.binding.base.width &&
      value.binding.localFacts.base.height === value.binding.base.height,
  );
export type ImageRevisionLocalPreview = z.infer<
  typeof imageRevisionLocalPreviewSchema
>;

const pixelFacts = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: hash,
    rgbaSHA256: hash,
  })
  .strict()
  .refine((value) => value.width * value.height <= 25_000_000);
export const revisionLocalCompositionSchema = z
  .object({
    geometryDigest: hash,
    actual: pixelFacts,
    result: pixelFacts
      .safeExtend({
        editedPixels: z.number().int().positive(),
        preservedPixels: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.result.editedPixels + value.result.preservedPixels ===
      value.result.width * value.result.height,
  );
const commonV2Fields = {
  kind: z.literal("image_revision"),
  version: z.literal(2),
  generationOperationId: z.string().uuid(),
  resourceId: z.string().uuid().optional(),
  originalReferenceImageId: z.string().uuid(),
  providerReferenceImageIds: z.array(z.string().uuid()).min(1).max(8),
  providerReferences: revisionProviderReferencesSchema,
  reviewGeneration: request,
  paidAttempt: revisionPaidAttemptV3Schema,
  rawCandidate: revisionRawPointerV2Schema.optional(),
  providerCallId: z.string().uuid().optional(),
};
const wholeV2Common = z
  .object({
    ...commonV2Fields,
    mode: z.literal("whole"),
    binding: imageRevisionWholeBindingV2Schema,
  })
  .strict();
const localV2Common = z
  .object({
    ...commonV2Fields,
    mode: z.literal("local"),
    binding: imageRevisionLocalBindingV2Schema,
    previewBinding: imageRevisionLocalPreviewSchema,
  })
  .strict();
const savedV2Fields = {
  state: z.literal("saved"),
  assetId: z.string().uuid(),
  filename: z.string().min(1),
  rawCandidate: revisionRawPointerV2Schema,
  providerCallId: z.string().uuid(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.literal("image/png"),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  ready: z.literal(true),
  url: z.string(),
  instruction: z.string(),
  providerImageUsage: z
    .object({ inputImages: z.number().int().nonnegative() })
    .strict()
    .optional(),
};
export function validRevisionV2References(value: {
  mode: "whole" | "local";
  binding: ImageRevisionBindingV2;
  providerReferences: RevisionProviderReference[];
}) {
  const refs = value.providerReferences,
    first = refs[0],
    originalIndex = refs.findIndex((ref) => ref.role === "original-context");
  if (
    !first ||
    first.referenceImageId !== value.binding.base.referenceImageId ||
    first.role !== (value.mode === "whole" ? "base" : "base-viewport")
  )
    return false;
  if (
    originalIndex !== -1 &&
    (originalIndex !== refs.length - 1 ||
      refs[originalIndex]!.referenceImageId !==
        value.binding.original.referenceImageId)
  )
    return false;
  if (
    refs
      .slice(1, originalIndex === -1 ? undefined : originalIndex)
      .some(
        (ref) =>
          ref.role !== "identity" ||
          [
            value.binding.base.referenceImageId,
            value.binding.original.referenceImageId,
          ].includes(ref.referenceImageId),
      )
  )
    return false;
  if (value.mode === "local") {
    if (value.binding.mode !== "local" || originalIndex === -1) return false;
    const provider = value.binding.localFacts.provider;
    if (
      first.sha256 !== provider.sha256 ||
      first.width !== provider.width ||
      first.height !== provider.height ||
      first.mime !== "image/png"
    )
      return false;
  }
  return true;
}
function validRevisionV2(value: any) {
  if (
    value.mode !== value.binding.mode ||
    !imageRevisionBindingV2Schema.safeParse(value.binding).success ||
    value.originalReferenceImageId !==
      value.binding.original.referenceImageId ||
    value.paidAttempt.referenceImageId !== value.originalReferenceImageId ||
    JSON.stringify(value.paidAttempt.scope) !==
      JSON.stringify(value.binding.attemptScope) ||
    JSON.stringify(value.providerReferenceImageIds) !==
      JSON.stringify(
        value.providerReferences.map(
          (ref: RevisionProviderReference) => ref.referenceImageId,
        ),
      ) ||
    !validRevisionV2References(value)
  )
    return false;
  const identities = value.providerReferences
    .filter((ref: RevisionProviderReference) => ref.role === "identity")
    .map((ref: RevisionProviderReference) => ref.referenceImageId);
  if (
    JSON.stringify(value.reviewGeneration.referenceImageIds) !==
      JSON.stringify([value.originalReferenceImageId, ...identities]) ||
    (value.reviewGeneration.referenceCrops ?? []).some(
      (crop: { referenceImageId: string }) =>
        !identities.includes(crop.referenceImageId),
    )
  )
    return false;
  if (
    value.mode === "local" &&
    (JSON.stringify(value.previewBinding.binding) !==
      JSON.stringify(value.binding) ||
      value.previewBinding.geometryDigest !== value.binding.localFacts.digest)
  )
    return false;
  if (value.state !== "saved") return true;
  if (value.width * value.height > 25_000_000) return false;
  return (
    value.mode === "whole" ||
    (value.width === value.binding.base.width &&
      value.height === value.binding.base.height &&
      value.composition.geometryDigest === value.binding.localFacts.digest &&
      value.composition.actual.sha256 === value.rawCandidate.sha256 &&
      value.composition.result.width === value.width &&
      value.composition.result.height === value.height &&
      value.composition.result.editedPixels ===
        value.binding.localFacts.nativeRect.width *
          value.binding.localFacts.nativeRect.height)
  );
}
export const imageRevisionV2SavedSchema = z
  .union([
    wholeV2Common.extend(savedV2Fields).strict(),
    localV2Common
      .extend({ ...savedV2Fields, composition: revisionLocalCompositionSchema })
      .strict(),
  ])
  .refine(validRevisionV2);
export const imageRevisionV2ReceiptSchema = z
  .union([
    imageRevisionV2SavedSchema,
    wholeV2Common
      .extend({ state: z.enum(["generating", "failed", "save_failed"]) })
      .strict(),
    localV2Common
      .extend({ state: z.enum(["generating", "failed", "save_failed"]) })
      .strict(),
  ])
  .refine(validRevisionV2);
export const imageRevisionAnyReceiptSchema = z.union([
  imageRevisionReceiptSchema,
  imageRevisionV2ReceiptSchema,
]);
export type ImageRevisionV2Receipt = z.infer<
  typeof imageRevisionV2ReceiptSchema
>;
export function anySavedRevision(value: unknown) {
  const parsed = imageRevisionAnyReceiptSchema.safeParse(value);
  return parsed.success && parsed.data.state === "saved"
    ? parsed.data
    : undefined;
}
