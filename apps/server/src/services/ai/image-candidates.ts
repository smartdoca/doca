import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import {
  checkJob,
  checkScope,
  type ToolContext,
} from "@core/workflows/ai-documents.js";
import {
  checkStorage,
  requireCapability,
} from "@core/modules/access/operation-policy.js";
import { objectKey } from "../storage-policy.js";
import { registerStoredObject } from "../stored-objects.js";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
  type StorageRuntime,
} from "../../adapters/storage.js";
import {
  imageRevisionBindingSchema,
  imageRevisionReceiptSchema,
  revisionRawPointerSchema,
  imageRevisionBindingV2Schema,
  imageRevisionV2ReceiptSchema,
  revisionRawPointerV2Schema,
  revisionProviderReferencesSchema,
  validRevisionV2References,
  type ImageRevisionBinding,
  type ImageRevisionBindingV2,
  type RevisionProviderReference,
} from "./image-revision-contract.js";
import { savedLocalBitmapFactsSchema } from "./image-saved-local-bitmap.js";
import { imageGenerationV1ReceiptSchema } from "./image-generation-contract.js";

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sizeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
  .refine((size) => size.width * size.height <= 25_000_000);
const rectSchema = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const workspaceSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    contentWidth: z.number().int().positive(),
    contentHeight: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) =>
      value.width * value.height <= 25_000_000 &&
      value.left + value.contentWidth <= value.width &&
      value.top + value.contentHeight <= value.height,
  );

export const rawImageTransformSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full") }).strict(),
  z
    .object({
      kind: z.literal("viewport"),
      rect: rectSchema,
      workspace: workspaceSchema.nullable(),
    })
    .strict()
    .refine(
      (value) =>
        value.workspace === null ||
        (value.workspace.contentWidth === value.rect.width &&
          value.workspace.contentHeight === value.rect.height),
    ),
]);
export type RawImageTransform = z.infer<typeof rawImageTransformSchema>;
export const rawImageReferenceSchema = z
  .object({
    referenceImageId: z.string().uuid(),
    sha256: hashSchema,
    size: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.width * value.height <= 25_000_000);
export type RawImageReference = z.infer<typeof rawImageReferenceSchema>;
const candidateFields = {
  origin: z.literal("provider"),
  generationOperationId: z.string().uuid(),
  providerCallId: z.string().uuid(),
  assetId: z.string().uuid(),
  profileId: z.string().min(1),
  objectKey: z.string().min(1),
  mime: z.enum(["image/png", "image/jpeg"]),
  size: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  sha256: hashSchema,
  dimensions: sizeSchema,
  references: z.array(rawImageReferenceSchema).max(8),
  scope: z
    .object({
      resourceId: z.string().uuid().nullable(),
      jobId: z.string().uuid().nullable(),
      sessionId: z.string().uuid().nullable(),
    })
    .strict()
    .refine((value) => (value.jobId === null) === (value.sessionId === null)),
  request: z
    .object({
      modelId: z.string().min(1),
      model: z.string().min(1),
      protocol: z.enum([
        "openai-generations",
        "openai-edits",
        "seedream-generations",
        "qwen-generations",
        "qwen-native",
        "wan-native",
        "mflux-native-v1",
      ]),
      prompt: z.string(),
      size: sizeSchema,
      transportDimensions: z.array(sizeSchema).max(8),
    })
    .strict(),
  transform: rawImageTransformSchema,
  nativeUsage: z.discriminatedUnion("state", [
    z.object({ state: z.literal("not-reported") }).strict(),
    z.object({ state: z.literal("reported"), value: z.json() }).strict(),
  ]),
};
function validCandidateReferences(value: {
  references: RawImageReference[];
  request: { transportDimensions: { width: number; height: number }[] };
  transform: RawImageTransform;
}) {
  if (
    new Set(value.references.map((reference) => reference.referenceImageId))
      .size !== value.references.length
  )
    return false;
  if (value.references.length !== value.request.transportDimensions.length)
    return false;
  if (value.transform.kind !== "viewport") return true;
  const source = value.references[0],
    rect = value.transform.rect;
  return (
    !!source &&
    rect.left + rect.width <= source.width &&
    rect.top + rect.height <= source.height
  );
}
const candidateBaseSchema = z
  .object({
    kind: z.literal("image_raw_candidate"),
    version: z.literal(1),
    ...candidateFields,
  })
  .strict()
  .refine(validCandidateReferences);
export const rawImageCandidateSchema = candidateBaseSchema.safeExtend({
  state: z.literal("saved"),
});
const candidatePendingSchema = candidateBaseSchema.safeExtend({
  state: z.literal("storing"),
});
const candidateFailedSchema = candidateBaseSchema.safeExtend({
  state: z.literal("save_failed"),
  failure: z
    .object({
      stage: z.enum(["write", "commit"]),
      cleanup: z.enum(["removed", "uncertain"]),
    })
    .strict(),
});
const candidateReceiptSchema = z.union([
  rawImageCandidateSchema,
  candidatePendingSchema,
  candidateFailedSchema,
]);
function sameReference(a: RawImageReference, b: RawImageReference) {
  return (
    a.referenceImageId === b.referenceImageId &&
    a.sha256 === b.sha256 &&
    a.size === b.size &&
    a.width === b.width &&
    a.height === b.height
  );
}
const revisionCandidateBaseSchema = z
  .object({
    kind: z.literal("image_revision_raw"),
    version: z.literal(1),
    ...candidateFields,
    references: z.array(rawImageReferenceSchema).min(1).max(8),
    transform: z.object({ kind: z.literal("full") }).strict(),
    binding: imageRevisionBindingSchema,
  })
  .strict()
  .refine(validCandidateReferences)
  .refine(
    (value) =>
      value.scope.sessionId === value.binding.sessionId &&
      value.scope.jobId !== null &&
      sameReference(value.references[0]!, value.binding.base) &&
      value.references.every(
        (reference) =>
          reference.referenceImageId !==
            value.binding.original.referenceImageId ||
          sameReference(reference, value.binding.original),
      ),
  );
export const revisionRawImageCandidateSchema =
  revisionCandidateBaseSchema.safeExtend({ state: z.literal("saved") });
const revisionCandidatePendingSchema = revisionCandidateBaseSchema.safeExtend({
  state: z.literal("storing"),
});
const revisionCandidateFailedSchema = revisionCandidateBaseSchema.safeExtend({
  state: z.literal("save_failed"),
  failure: z
    .object({
      stage: z.enum(["write", "commit"]),
      cleanup: z.enum(["removed", "uncertain"]),
    })
    .strict(),
});
const revisionCandidateReceiptSchema = z.union([
  revisionRawImageCandidateSchema,
  revisionCandidatePendingSchema,
  revisionCandidateFailedSchema,
]);
export {
  candidateReceiptSchema as rawImageCandidateReceiptSchema,
  revisionCandidateReceiptSchema as revisionRawImageCandidateReceiptSchema,
};
export const revisionRawTransformV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full") }).strict(),
  z
    .object({
      kind: z.literal("saved-local"),
      facts: savedLocalBitmapFactsSchema,
    })
    .strict(),
]);
export type RevisionRawImageTransformV2 = z.infer<
  typeof revisionRawTransformV2Schema
>;
const revisionCandidateV2BaseSchema = z
  .object({
    kind: z.literal("image_revision_raw"),
    version: z.literal(2),
    ...candidateFields,
    mode: z.enum(["whole", "local"]),
    binding: imageRevisionBindingV2Schema,
    references: z.array(rawImageReferenceSchema).min(1).max(8),
    providerReferences: revisionProviderReferencesSchema,
    transform: revisionRawTransformV2Schema,
  })
  .strict()
  .refine((value) => {
    if (
      value.mode !== value.binding.mode ||
      value.scope.sessionId !== value.binding.sessionId ||
      value.scope.jobId === null ||
      !sameReference(value.references[0]!, value.binding.base) ||
      !validRevisionV2References(value) ||
      new Set(value.references.map((ref) => ref.referenceImageId)).size !==
        value.references.length ||
      value.references.length !== value.providerReferences.length ||
      value.providerReferences.length !==
        value.request.transportDimensions.length ||
      value.references.some(
        (ref, index) =>
          ref.referenceImageId !==
            value.providerReferences[index]!.referenceImageId ||
          (ref.referenceImageId === value.binding.original.referenceImageId &&
            !sameReference(ref, value.binding.original)),
      ) ||
      value.providerReferences.some(
        (ref, index) =>
          ref.width !== value.request.transportDimensions[index]!.width ||
          ref.height !== value.request.transportDimensions[index]!.height,
      )
    )
      return false;
    if (value.mode === "whole") return value.transform.kind === "full";
    return (
      value.binding.mode === "local" &&
      value.transform.kind === "saved-local" &&
      JSON.stringify(value.transform.facts) ===
        JSON.stringify(value.binding.localFacts) &&
      value.request.size.width === value.binding.localFacts.provider.width &&
      value.request.size.height === value.binding.localFacts.provider.height
    );
  });
export const revisionRawImageCandidateV2Schema =
  revisionCandidateV2BaseSchema.safeExtend({ state: z.literal("saved") });
const revisionCandidateV2PendingSchema =
  revisionCandidateV2BaseSchema.safeExtend({ state: z.literal("storing") });
const revisionCandidateV2FailedSchema =
  revisionCandidateV2BaseSchema.safeExtend({
    state: z.literal("save_failed"),
    failure: z
      .object({
        stage: z.enum(["write", "commit"]),
        cleanup: z.enum(["removed", "uncertain"]),
      })
      .strict(),
  });
export const revisionRawImageCandidateV2ReceiptSchema = z.union([
  revisionRawImageCandidateV2Schema,
  revisionCandidateV2PendingSchema,
  revisionCandidateV2FailedSchema,
]);
export const revisionRawImageCandidateAnyReceiptSchema = z.union([
  revisionCandidateReceiptSchema,
  revisionRawImageCandidateV2ReceiptSchema,
]);
export type RevisionRawImageCandidateV2 = z.infer<
  typeof revisionRawImageCandidateV2Schema
>;
export type RevisionRawImageCandidatePointerV2 = z.infer<
  typeof revisionRawPointerV2Schema
>;
export type RevisionRawImageCandidateAny =
  RevisionRawImageCandidate | RevisionRawImageCandidateV2;
export type RevisionRawImageCandidate = z.infer<
  typeof revisionRawImageCandidateSchema
>;
export type RevisionRawImageCandidatePointer = z.infer<
  typeof revisionRawPointerSchema
>;
export type RawImageCandidate = z.infer<typeof rawImageCandidateSchema>;
export type RawImageCandidatePointer = {
  version: 1;
  receiptId: string;
  assetId: string;
  sha256: string;
};

function stableId(namespace: string, operationId: string) {
  const hex = sha256(`${namespace}\0${operationId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const rawImageCandidateReceiptId = (operationId: string) =>
  stableId("doca-image-raw-receipt-v1", operationId);
function pointer(
  receiptId: string,
  candidate: Pick<RawImageCandidate, "assetId" | "sha256">,
): RawImageCandidatePointer {
  return {
    version: 1,
    receiptId,
    assetId: candidate.assetId,
    sha256: candidate.sha256,
  };
}

export const revisionRawImageCandidateReceiptId = (operationId: string) =>
  stableId("doca-image-revision-raw-receipt-v1", operationId);
export const revisionRawImageCandidateV2ReceiptId = (operationId: string) =>
  stableId("doca-image-revision-raw-receipt-v2", operationId);
function revisionPointer(
  receiptId: string,
  candidate: Pick<RawImageCandidate, "assetId" | "sha256">,
): RevisionRawImageCandidatePointer {
  return revisionRawPointerSchema.parse({
    kind: "image_revision_raw",
    ...pointer(receiptId, candidate),
  });
}

type SavedCandidate =
  RawImageCandidate | RevisionRawImageCandidate | RevisionRawImageCandidateV2;
type PendingCandidate =
  | z.infer<typeof candidatePendingSchema>
  | z.infer<typeof revisionCandidatePendingSchema>
  | z.infer<typeof revisionCandidateV2PendingSchema>;
type FailedCandidate =
  | z.infer<typeof candidateFailedSchema>
  | z.infer<typeof revisionCandidateFailedSchema>
  | z.infer<typeof revisionCandidateV2FailedSchema>;
type CandidateReceipt = SavedCandidate | PendingCandidate | FailedCandidate;
type RawLifecycleContract<P> = {
  kind: "image_raw_candidate" | "image_revision_raw";
  version: 1 | 2;
  assetNamespace: string;
  retainAfterCancellation: boolean;
  receiptId(operationId: string): string;
  baseParse(value: unknown): unknown;
  pendingParse(value: unknown): PendingCandidate;
  savedParse(value: unknown): SavedCandidate;
  failedParse(value: unknown): FailedCandidate;
  receiptParse(value: unknown): CandidateReceipt;
  receiptSafeParse(
    value: unknown,
  ): { success: false } | { success: true; data: CandidateReceipt };
  pointer(
    receiptId: string,
    candidate: Pick<RawImageCandidate, "assetId" | "sha256">,
  ): P;
  validateParent(value: unknown, candidate: PendingCandidate): void;
};
const generationRawContract: RawLifecycleContract<RawImageCandidatePointer> = {
  kind: "image_raw_candidate",
  version: 1,
  assetNamespace: "doca-image-raw-asset-v1",
  retainAfterCancellation: false,
  receiptId: rawImageCandidateReceiptId,
  baseParse: (value) => candidateBaseSchema.parse(value),
  pendingParse: (value) => candidatePendingSchema.parse(value),
  savedParse: (value) => rawImageCandidateSchema.parse(value),
  failedParse: (value) => candidateFailedSchema.parse(value),
  receiptParse: (value) => candidateReceiptSchema.parse(value),
  receiptSafeParse: (value) => candidateReceiptSchema.safeParse(value),
  pointer,
  validateParent: (value, candidate) => {
    const parent = value as any;
    if (parent?.version === undefined) {
      if (parent?.kind !== "image_generation" || parent?.state !== "generating")
        fail(409, "图片生成操作状态已改变");
      return;
    }
    const parsed = imageGenerationV1ReceiptSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.state !== "generating" ||
      parsed.data.origin !== undefined ||
      parsed.data.generationOperationId !== candidate.generationOperationId ||
      parsed.data.generation.referenceImageIds[0] !==
        candidate.references[0]?.referenceImageId ||
      JSON.stringify(parsed.data.generation.referenceImageIds) !==
        JSON.stringify(candidate.references.map((ref) => ref.referenceImageId))
    )
      fail(409, "图片生成操作状态已改变");
  },
};
const revisionRawContract: RawLifecycleContract<RevisionRawImageCandidatePointer> =
  {
    kind: "image_revision_raw",
    version: 1,
    assetNamespace: "doca-image-revision-raw-asset-v1",
    retainAfterCancellation: true,
    receiptId: revisionRawImageCandidateReceiptId,
    baseParse: (value) => revisionCandidateBaseSchema.parse(value),
    pendingParse: (value) => revisionCandidatePendingSchema.parse(value),
    savedParse: (value) => revisionRawImageCandidateSchema.parse(value),
    failedParse: (value) => revisionCandidateFailedSchema.parse(value),
    receiptParse: (value) => revisionCandidateReceiptSchema.parse(value),
    receiptSafeParse: (value) =>
      revisionCandidateReceiptSchema.safeParse(value),
    pointer: revisionPointer,
    validateParent: (value, candidate) => {
      const parsed = imageRevisionReceiptSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.state !== "generating" ||
        candidate.kind !== "image_revision_raw" ||
        parsed.data.generationOperationId !== candidate.generationOperationId ||
        JSON.stringify(parsed.data.binding) !==
          JSON.stringify(candidate.binding) ||
        JSON.stringify(parsed.data.providerReferenceImageIds) !==
          JSON.stringify(
            candidate.references.map((reference) => reference.referenceImageId),
          )
      )
        fail(409, "已保存图片修订的原始候选与生成操作绑定不一致");
    },
  };
const revisionRawV2Contract: RawLifecycleContract<RevisionRawImageCandidatePointerV2> =
  {
    kind: "image_revision_raw",
    version: 2,
    assetNamespace: "doca-image-revision-raw-asset-v2",
    retainAfterCancellation: true,
    receiptId: revisionRawImageCandidateV2ReceiptId,
    baseParse: (value) => revisionCandidateV2BaseSchema.parse(value),
    pendingParse: (value) => revisionCandidateV2PendingSchema.parse(value),
    savedParse: (value) => revisionRawImageCandidateV2Schema.parse(value),
    failedParse: (value) => revisionCandidateV2FailedSchema.parse(value),
    receiptParse: (value) =>
      revisionRawImageCandidateV2ReceiptSchema.parse(value),
    receiptSafeParse: (value) =>
      revisionRawImageCandidateV2ReceiptSchema.safeParse(value),
    pointer: (receiptId, candidate) =>
      revisionRawPointerV2Schema.parse({
        kind: "image_revision_raw",
        version: 2,
        receiptId,
        assetId: candidate.assetId,
        sha256: candidate.sha256,
      }),
    validateParent: (value, candidate) => {
      const parsed = imageRevisionV2ReceiptSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.state !== "generating" ||
        candidate.kind !== "image_revision_raw" ||
        candidate.version !== 2 ||
        parsed.data.generationOperationId !== candidate.generationOperationId ||
        parsed.data.mode !== candidate.mode ||
        JSON.stringify(parsed.data.binding) !==
          JSON.stringify(candidate.binding) ||
        JSON.stringify(parsed.data.providerReferences) !==
          JSON.stringify(candidate.providerReferences)
      )
        fail(409, "已保存图片修订的原始候选与生成操作绑定不一致");
    },
  };

/** Record source bytes before preview/crop transformations; dimensions use oriented pixels. */
export async function rawImageReferences(
  ids: string[],
  references: { data: Buffer }[],
) {
  if (ids.length !== references.length)
    fail(400, "原始候选的参考图对应关系无效");
  const values: RawImageReference[] = [];
  for (const [index, reference] of references.entries()) {
    const meta = await sharp(reference.data, {
      limitInputPixels: 25_000_000,
    }).metadata();
    values.push(
      rawImageReferenceSchema.parse({
        referenceImageId: ids[index],
        sha256: sha256(reference.data),
        size: reference.data.length,
        width: meta.autoOrient.width,
        height: meta.autoOrient.height,
      }),
    );
  }
  return values;
}

/** PNG/JPEG bytes remain exact. Other supported raster pixels are decoded to lossless PNG. */
async function candidatePixels(bytes: Buffer) {
  try {
    const decoder = sharp(bytes, {
      limitInputPixels: 25_000_000,
      failOn: "warning",
    });
    const meta = await decoder.metadata();
    if (
      !["png", "jpeg", "webp", "gif"].includes(meta.format!) ||
      (meta.pages !== undefined && meta.pages !== 1)
    )
      fail(502, "原始候选必须是有效的单帧图像");
    await decoder.stats();
    const exact = meta.format === "png" || meta.format === "jpeg";
    const data = exact
      ? bytes
      : await sharp(bytes, { limitInputPixels: 25_000_000 })
          .rotate()
          .png()
          .toBuffer();
    if (data.length > 20 * 1024 * 1024) fail(413, "原始候选图片文件过大");
    return {
      data,
      mime: (meta.format === "jpeg" ? "image/jpeg" : "image/png") as
        "image/png" | "image/jpeg",
      dimensions: {
        width: meta.autoOrient.width,
        height: meta.autoOrient.height,
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(502, "原始候选无法完整解析或分辨率过大");
  }
}

/** Durable intermediate output; it is never a delivered file or an image-generation receipt. */
export type SaveRawImageCandidateInput = {
  generationOperationId: string;
  providerCallId: string;
  bytes: Buffer;
  references: RawImageReference[];
  resourceId: string | null;
  request: RawImageCandidate["request"];
  transform: RawImageTransform;
  nativeUsage: RawImageCandidate["nativeUsage"];
};
export type SaveRawImageCandidateOptions = {
  storage?: StorageRuntime;
  signal?: AbortSignal;
  authorize: (tx: DB) => Promise<void>;
};
export async function saveRawImageCandidate(
  db: DB,
  ctx: ToolContext,
  input: SaveRawImageCandidateInput,
  options: SaveRawImageCandidateOptions,
): Promise<RawImageCandidatePointer> {
  return saveCandidate(db, ctx, input, options, generationRawContract);
}
export function saveRevisionRawImageCandidate(
  db: DB,
  ctx: ToolContext,
  input: SaveRawImageCandidateInput & { binding: ImageRevisionBinding },
  options: SaveRawImageCandidateOptions,
): Promise<RevisionRawImageCandidatePointer>;
export function saveRevisionRawImageCandidate(
  db: DB,
  ctx: ToolContext,
  input: SaveRevisionRawImageCandidateInput,
  options: SaveRawImageCandidateOptions,
): Promise<
  RevisionRawImageCandidatePointer | RevisionRawImageCandidatePointerV2
>;
export async function saveRevisionRawImageCandidate(
  db: DB,
  ctx: ToolContext,
  input: SaveRevisionRawImageCandidateInput,
  options: SaveRawImageCandidateOptions,
): Promise<
  RevisionRawImageCandidatePointer | RevisionRawImageCandidatePointerV2
> {
  if (input.binding.version === 1) {
    imageRevisionBindingSchema.parse(input.binding);
    if ("providerReferences" in input || "mode" in input)
      fail(422, "原始候选记录格式无效，不能转换或补造缺失事实");
    return saveCandidate(db, ctx, input, options, revisionRawContract);
  }
  imageRevisionBindingV2Schema.parse(input.binding);
  return saveCandidate(db, ctx, input, options, revisionRawV2Contract);
}
export type SaveRevisionRawImageCandidateInput =
  | (SaveRawImageCandidateInput & { binding: ImageRevisionBinding })
  | (Omit<SaveRawImageCandidateInput, "transform"> & {
      mode: "whole" | "local";
      binding: ImageRevisionBindingV2;
      transform: RevisionRawImageTransformV2;
      providerReferences: RevisionProviderReference[];
    });
async function saveCandidate<P>(
  db: DB,
  ctx: ToolContext,
  input: Omit<SaveRawImageCandidateInput, "transform"> & {
    transform: RawImageTransform | RevisionRawImageTransformV2;
    binding?: ImageRevisionBinding | ImageRevisionBindingV2;
    providerReferences?: RevisionProviderReference[];
    mode?: "whole" | "local";
  },
  options: SaveRawImageCandidateOptions,
  contract: RawLifecycleContract<P>,
): Promise<P> {
  const raw = await candidatePixels(input.bytes);
  const runtime = options.storage ?? storageRuntime(),
    storage = createStorage(runtime);
  const receiptId = contract.receiptId(input.generationOperationId);
  const assetId = stableId(
    contract.assetNamespace,
    input.generationOperationId,
  );
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const config = storageConfigForProfile(runtime, profile),
    key = objectKey(assetId, raw.mime);
  const job = ctx.jobId
    ? await db
        .selectFrom("ai_jobs")
        .select("session_id")
        .where("id", "=", ctx.jobId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirst()
    : undefined;
  if (ctx.jobId && !job) fail(409, "原始候选的任务不存在或无权访问");
  const candidate = contract.pendingParse({
    kind: contract.kind,
    version: contract.version,
    origin: "provider",
    state: "storing",
    generationOperationId: input.generationOperationId,
    providerCallId: input.providerCallId,
    assetId,
    profileId: profile.id,
    objectKey: key,
    mime: raw.mime,
    size: raw.data.length,
    sha256: sha256(raw.data),
    dimensions: raw.dimensions,
    references: input.references,
    scope: {
      resourceId: input.resourceId,
      jobId: ctx.jobId ?? null,
      sessionId: job?.session_id ?? null,
    },
    request: input.request,
    transform: input.transform,
    nativeUsage: input.nativeUsage,
    ...(contract.kind === "image_revision_raw"
      ? { binding: input.binding }
      : {}),
    ...(contract.version === 2
      ? { mode: input.mode, providerReferences: input.providerReferences }
      : {}),
  });
  const fingerprint = sha256(
    JSON.stringify(contract.baseParse(candidateBase(candidate))),
  );
  const authorize = async (tx: DB) => {
    if (ctx.writable === false) fail(403, "本次授权仅允许读取");
    if (!contract.retainAfterCancellation) options.signal?.throwIfAborted();
    await lockAIUser(tx, ctx.actor.id);
    if (!contract.retainAfterCancellation) await checkJob(tx, ctx);
    if (contract.kind === "image_raw_candidate") {
      const parent = await tx
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", input.generationOperationId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirstOrThrow();
      const value = JSON.parse(parent.result);
      if (value.version !== undefined)
        contract.validateParent(value, candidate);
    }
    if (contract.retainAfterCancellation) {
      const actor = await tx
        .selectFrom("users")
        .select("status")
        .where("id", "=", ctx.actor.id)
        .executeTakeFirst();
      if (
        actor?.status !== "active" ||
        candidate.kind !== "image_revision_raw" ||
        candidate.binding.actorId !== ctx.actor.id ||
        candidate.binding.sessionId !== job?.session_id
      )
        fail(403, "修订原始候选的账号或会话绑定无效");
      const parent = await tx
        .selectFrom("ai_operations")
        .select(["result", "job_id"])
        .where("id", "=", input.generationOperationId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirstOrThrow();
      if (parent.job_id !== ctx.jobId)
        fail(403, "修订原始候选的生成任务绑定无效");
      contract.validateParent(JSON.parse(parent.result), candidate);
    }
    await requireCapability(tx, ctx.actor.id, "ai.create");
    await requireCapability(tx, ctx.actor.id, "assets.upload");
    await options.authorize(tx);
    const call = await tx
      .selectFrom("ai_calls")
      .selectAll()
      .where("id", "=", input.providerCallId)
      .where("user_id", "=", ctx.actor.id)
      .executeTakeFirst();
    const usage = call ? JSON.parse(call.usage) : null;
    const snapshot = call ? JSON.parse(call.model_snapshot) : null;
    if (
      !call ||
      call.state !== "confirmed" ||
      call.model_id !== input.request.modelId ||
      call.job_id !== (ctx.jobId ?? null) ||
      snapshot?.callKind !== "image" ||
      usage?.known !== true ||
      usage.providerMetrics?.images !== 1
    )
      fail(409, "原始候选没有对应的已确认图片调用事实");
    if (!contract.retainAfterCancellation) options.signal?.throwIfAborted();
  };
  const existing = await transact(db, async (tx) => {
    await authorize(tx);
    const old = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", receiptId)
      .executeTakeFirst();
    if (old) {
      if (old.user_id !== ctx.actor.id || old.digest !== fingerprint)
        fail(409, "原始候选操作标识冲突");
      const value = contract.receiptParse(JSON.parse(old.result));
      if (value.state !== "saved")
        fail(409, "原始候选的保存状态待核对，不能重复生成或覆盖");
      return value;
    }
    await checkStorage(tx, ctx.actor.id, candidate.size);
    await tx
      .insertInto("ai_operations")
      .values({
        id: receiptId,
        user_id: ctx.actor.id,
        job_id: ctx.jobId ?? null,
        digest: fingerprint,
        result: JSON.stringify(candidate),
        created_at: new Date().toISOString(),
      })
      .execute();
    return null;
  });
  if (existing) {
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", existing.assetId)
      .where("owner_id", "=", ctx.actor.id)
      .where("purpose", "=", "ai_image_candidate")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!asset) fail(404, "原始候选已删除，不能重新创建");
    const bytes = await storage.read(config, key, existing.size);
    if (bytes.length !== existing.size || sha256(bytes) !== existing.sha256)
      fail(409, "原始候选内容已改变，不能覆盖");
    return contract.pointer(receiptId, existing);
  }
  let stage: "write" | "commit" = "write";
  try {
    if (!contract.retainAfterCancellation) options.signal?.throwIfAborted();
    await storage.put(
      config,
      key,
      raw.data,
      raw.mime,
      `raw-${assetId}.${raw.mime === "image/jpeg" ? "jpg" : "png"}`,
    );
    stage = "commit";
    const saved = contract.savedParse({
      ...candidate,
      state: "saved",
    });
    await transact(db, async (tx) => {
      await authorize(tx);
      await checkStorage(tx, ctx.actor.id, candidate.size);
      const receipt = await tx
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", receiptId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirstOrThrow();
      if (
        receipt.digest !== fingerprint ||
        contract.pendingParse(JSON.parse(receipt.result)).state !== "storing"
      )
        fail(409, "原始候选保存状态已改变");
      const createdAt = new Date().toISOString();
      const asset: Schema["assets"] = {
        id: assetId,
        owner_id: ctx.actor.id,
        uploaded_by: ctx.actor.id,
        resource_id: null,
        purpose: "ai_image_candidate",
        profile_id: profile.id,
        object_key: key,
        filename: `raw-${assetId}.${raw.mime === "image/jpeg" ? "jpg" : "png"}`,
        mime: candidate.mime,
        size: candidate.size,
        created_at: createdAt,
        deleted_at: null,
      };
      await tx.insertInto("assets").values(asset).execute();
      await registerStoredObject(tx, {
        id: assetId,
        profile_id: profile.id,
        object_key: key,
        sha256: candidate.sha256,
        size: candidate.size,
        mime: candidate.mime,
        ai_description: "AI 原始候选（非交付结果）",
        ai_status: "skipped",
        ai_model: null,
        ai_generated_at: createdAt,
        created_at: createdAt,
      });
      await tx
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(saved) })
        .where("id", "=", receiptId)
        .execute();
      const operation = await tx
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", input.generationOperationId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirstOrThrow();
      const generation = JSON.parse(operation.result);
      contract.validateParent(generation, candidate);
      const update = tx
        .updateTable("ai_operations")
        .set({
          result: JSON.stringify({
            ...generation,
            rawCandidate: contract.pointer(receiptId, saved),
          }),
        })
        .where("id", "=", input.generationOperationId);
      if (contract.kind === "image_revision_raw") {
        const adopted = await update
          .where("result", "=", operation.result)
          .executeTakeFirst();
        if (adopted.numUpdatedRows !== 1n)
          fail(409, "修订操作在原始候选保存期间改变");
      } else await update.execute();
    });
    return contract.pointer(receiptId, saved);
  } catch (error) {
    // A lost commit response does not authorize deleting a possibly committed object.
    let row: { result: string; digest: string } | undefined;
    try {
      row = await db
        .selectFrom("ai_operations")
        .select(["result", "digest"])
        .where("id", "=", receiptId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirst();
    } catch {
      throw error;
    }
    const recorded =
      row?.digest === fingerprint
        ? contract.receiptParse(JSON.parse(row.result))
        : undefined;
    if (recorded?.state === "saved")
      return contract.pointer(receiptId, recorded);
    if (!row || recorded?.state !== "storing") throw error;
    const failed = contract.failedParse({
      ...recorded,
      state: "save_failed",
      failure: { stage, cleanup: "uncertain" },
    });
    // A SELECT can observe storing while an earlier COMMIT is still finishing.
    // Only a successful exact-state CAS establishes that this write did not commit.
    const claimed = await db
      .updateTable("ai_operations")
      .set({ result: JSON.stringify(failed) })
      .where("id", "=", receiptId)
      .where("user_id", "=", ctx.actor.id)
      .where("digest", "=", fingerprint)
      .where("result", "=", row.result)
      .executeTakeFirst()
      .catch(() => undefined);
    if (claimed?.numUpdatedRows !== 1n) {
      const current = await db
        .selectFrom("ai_operations")
        .select(["result", "digest"])
        .where("id", "=", receiptId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirst()
        .catch(() => undefined);
      const confirmed =
        current?.digest === fingerprint
          ? contract.receiptSafeParse(JSON.parse(current.result))
          : undefined;
      if (confirmed?.success && confirmed.data.state === "saved")
        return contract.pointer(receiptId, confirmed.data);
      // Unknown CAS acknowledgement or a changed state is not permission to delete.
      // Existing receipt facts retain a locator without storage credentials.
      throw error;
    }
    let cleanup: "removed" | "uncertain" = "removed";
    try {
      await storage.remove(config, key);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
        cleanup = "uncertain";
    }
    await db
      .updateTable("ai_operations")
      .set({
        result: JSON.stringify(
          contract.failedParse({
            ...failed,
            failure: { stage, cleanup },
          }),
        ),
      })
      .where("id", "=", receiptId)
      .where("user_id", "=", ctx.actor.id)
      .where("digest", "=", fingerprint)
      .where("result", "=", JSON.stringify(failed))
      .execute()
      .catch(() => undefined);
    throw error;
  }
}

function candidateBase(candidate: PendingCandidate | SavedCandidate) {
  const { state: _state, ...base } = candidate;
  return base;
}

/** Owner/session authorization is mandatory; callers additionally reauthorize source bytes. */
export type ReadRawImageCandidateOptions = {
  storage?: StorageRuntime;
  readReferences: (
    ids: string[],
  ) => Promise<{ data: Buffer; mime: string; filename: string }[]>;
};
export type ReadRevisionRawImageCandidateOptions =
  ReadRawImageCandidateOptions & {
    /** Reconstruct the exact transmitted pixels from authorized full sources; required for v2. */
    readProviderReferences?: (
      candidate: RevisionRawImageCandidateV2,
      sourceReferences: { data: Buffer; mime: string; filename: string }[],
    ) => Promise<{ data: Buffer; mime: string; filename: string }[]>;
  };
export async function readRawImageCandidateRecord(
  db: DB,
  ctx: ToolContext,
  generationOperationId: string,
  options: ReadRawImageCandidateOptions,
) {
  const result = await readCandidate(
    db,
    ctx,
    generationOperationId,
    options,
    generationRawContract,
  );
  return {
    ...result,
    candidate: rawImageCandidateSchema.parse(result.candidate),
  };
}
export async function readRevisionRawImageCandidateRecord(
  db: DB,
  ctx: ToolContext,
  operationId: string,
  options: ReadRawImageCandidateOptions,
) {
  const result = await readCandidate(
    db,
    ctx,
    operationId,
    options,
    revisionRawContract,
  );
  return {
    ...result,
    candidate: revisionRawImageCandidateSchema.parse(result.candidate),
  };
}
export async function readAnyRevisionRawImageCandidateRecord(
  db: DB,
  ctx: ToolContext,
  operationId: string,
  options: ReadRevisionRawImageCandidateOptions,
) {
  await checkJob(db, ctx);
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", operationId)
    .where("user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!row) fail(404, "修订操作与持久原始候选绑定不一致");
  let parent: unknown;
  try {
    parent = JSON.parse(row.result);
  } catch {
    fail(422, "原始候选记录 JSON 无效，不能修复或补造");
  }
  const v1 = imageRevisionReceiptSchema.safeParse(parent);
  if (v1.success)
    return readRevisionRawImageCandidateRecord(db, ctx, operationId, options);
  const v2 = imageRevisionV2ReceiptSchema.safeParse(parent);
  if (!v2.success) fail(422, "原始候选记录格式无效，不能转换或补造缺失事实");
  const result = await readCandidate(
    db,
    ctx,
    operationId,
    options,
    revisionRawV2Contract,
  );
  const candidate = revisionRawImageCandidateV2Schema.parse(result.candidate);
  return { ...result, candidate };
}
async function readCandidate<P>(
  db: DB,
  ctx: ToolContext,
  generationOperationId: string,
  options: ReadRevisionRawImageCandidateOptions,
  contract: RawLifecycleContract<P>,
) {
  const runtime = options.storage ?? storageRuntime();
  await checkJob(db, ctx);
  const user = await db
    .selectFrom("users")
    .select("status")
    .where("id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (user?.status !== "active") fail(401, "登录已失效");
  const id = contract.receiptId(generationOperationId);
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!row)
    fail(422, "此记录没有持久原始候选，不能将最终图片当作 raw 或重新计费生成", {
      code: "image_raw_unavailable",
    });
  let value: unknown;
  try {
    value = JSON.parse(row.result);
  } catch {
    fail(422, "原始候选记录 JSON 无效，不能修复或补造");
  }
  const parsed = contract.receiptSafeParse(value);
  if (!parsed.success)
    fail(422, "原始候选记录格式无效，不能转换或补造缺失事实");
  if (parsed.data.state !== "saved")
    fail(409, "原始候选没有确认保存，请核对存储状态，不能重复生成");
  const candidate = parsed.data;
  if (candidate.generationOperationId !== generationOperationId)
    fail(409, "原始候选来源操作不一致");
  if (candidate.scope.resourceId !== null)
    await checkScope(db, ctx, candidate.scope.resourceId);
  if (candidate.scope.sessionId !== null) {
    const job = ctx.jobId
      ? await db
          .selectFrom("ai_jobs")
          .select("session_id")
          .where("id", "=", ctx.jobId)
          .where("user_id", "=", ctx.actor.id)
          .executeTakeFirst()
      : undefined;
    if (job?.session_id !== candidate.scope.sessionId)
      fail(404, "原始候选不属于当前会话");
  }
  const verifyOriginal = async () => {
    if (candidate.kind !== "image_revision_raw") {
      const operation = await db
        .selectFrom("ai_operations")
        .select(["result", "job_id"])
        .where("id", "=", generationOperationId)
        .where("user_id", "=", ctx.actor.id)
        .executeTakeFirstOrThrow();
      const value = JSON.parse(operation.result);
      if (value.version === undefined) return;
      const parsed = imageGenerationV1ReceiptSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.origin !== undefined ||
        parsed.data.generationOperationId !== generationOperationId ||
        row.job_id !== candidate.scope.jobId ||
        operation.job_id !== candidate.scope.jobId ||
        row.digest !==
          sha256(
            JSON.stringify(contract.baseParse(candidateBase(candidate))),
          ) ||
        JSON.stringify(parsed.data.generation.referenceImageIds) !==
          JSON.stringify(
            candidate.references.map((ref) => ref.referenceImageId),
          ) ||
        parsed.data.rawCandidate?.receiptId !== id ||
        parsed.data.rawCandidate.assetId !== candidate.assetId ||
        parsed.data.rawCandidate.sha256 !== candidate.sha256 ||
        (parsed.data.providerCallId !== undefined &&
          parsed.data.providerCallId !== candidate.providerCallId)
      )
        fail(409, "图片生成操作状态已改变");
      return;
    }
    if (
      candidate.binding.actorId !== ctx.actor.id ||
      candidate.binding.sessionId !== candidate.scope.sessionId
    )
      fail(403, "修订原始候选的账号或会话绑定无效");
    if (
      row.digest !==
      sha256(JSON.stringify(contract.baseParse(candidateBase(candidate))))
    )
      fail(409, "修订原始候选回执摘要不一致");
    const operation = await db
      .selectFrom("ai_operations")
      .select(["result", "job_id"])
      .where("id", "=", generationOperationId)
      .where("user_id", "=", ctx.actor.id)
      .executeTakeFirstOrThrow();
    const parent =
      candidate.version === 1
        ? imageRevisionReceiptSchema.safeParse(JSON.parse(operation.result))
        : imageRevisionV2ReceiptSchema.safeParse(JSON.parse(operation.result));
    if (
      !parent.success ||
      row.job_id !== candidate.scope.jobId ||
      operation.job_id !== candidate.scope.jobId ||
      parent.data.generationOperationId !== generationOperationId ||
      parent.data.version !== candidate.version ||
      JSON.stringify(parent.data.binding) !==
        JSON.stringify(candidate.binding) ||
      JSON.stringify(parent.data.providerReferenceImageIds) !==
        JSON.stringify(
          candidate.references.map((reference) => reference.referenceImageId),
        ) ||
      parent.data.rawCandidate?.receiptId !== id ||
      parent.data.rawCandidate.assetId !== candidate.assetId ||
      parent.data.rawCandidate.sha256 !== candidate.sha256 ||
      (parent.data.providerCallId !== undefined &&
        parent.data.providerCallId !== candidate.providerCallId)
    )
      fail(409, "修订操作与持久原始候选绑定不一致");
    if (
      candidate.version === 2 &&
      (parent.data.version !== 2 ||
        parent.data.mode !== candidate.mode ||
        JSON.stringify(parent.data.providerReferences) !==
          JSON.stringify(candidate.providerReferences))
    )
      fail(409, "修订操作与持久原始候选绑定不一致");
    const original = await options.readReferences([
      candidate.binding.original.referenceImageId,
    ]);
    const references = await rawImageReferences(
      [candidate.binding.original.referenceImageId],
      original,
    );
    if (
      references.length !== 1 ||
      !sameReference(references[0]!, candidate.binding.original)
    )
      fail(409, "修订冻结原页的字节或尺寸已改变");
  };
  await verifyOriginal();
  let sources = await options.readReferences(
    candidate.references.map((reference) => reference.referenceImageId),
  );
  checkRawImageSources(candidate, sources);
  if (candidate.kind === "image_revision_raw") {
    const references = await rawImageReferences(
      candidate.references.map((reference) => reference.referenceImageId),
      sources,
    );
    if (
      references.some(
        (reference, index) =>
          !sameReference(reference, candidate.references[index]!),
      )
    )
      fail(409, "修订实际参考图尺寸或字节已改变");
  }
  const actualSources = async (fullSources: typeof sources) => {
    if (candidate.kind !== "image_revision_raw" || candidate.version !== 2)
      return fullSources;
    if (!options.readProviderReferences)
      fail(422, "原始候选记录格式无效，不能转换或补造缺失事实");
    const actual = await options.readProviderReferences(
      structuredClone(candidate),
      fullSources.map((source) => ({
        ...source,
        data: Buffer.from(source.data),
      })),
    );
    const facts = await rawImageReferences(
      candidate.providerReferences.map(
        (reference) => reference.referenceImageId,
      ),
      actual,
    );
    if (
      facts.length !== candidate.providerReferences.length ||
      facts.some(
        (reference, index) =>
          !sameReference(reference, candidate.providerReferences[index]!) ||
          actual[index]!.mime !== candidate.providerReferences[index]!.mime,
      )
    )
      fail(409, "修订实际参考图尺寸或字节已改变");
    for (const [index, source] of actual.entries()) {
      const decoder = sharp(source.data, {
          limitInputPixels: 25_000_000,
          failOn: "warning",
        }),
        meta = await decoder.metadata();
      if (
        (meta.pages !== undefined && meta.pages !== 1) ||
        `image/${meta.format}` !== candidate.providerReferences[index]!.mime
      )
        fail(409, "修订实际参考图尺寸或字节已改变");
      await decoder.stats();
    }
    return actual;
  };
  await actualSources(sources);
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", candidate.assetId)
    .where("owner_id", "=", ctx.actor.id)
    .where("purpose", "=", "ai_image_candidate")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (
    !asset ||
    asset.profile_id !== candidate.profileId ||
    asset.object_key !== candidate.objectKey ||
    asset.size !== candidate.size ||
    asset.mime !== candidate.mime
  )
    fail(404, "原始候选不存在、已删除或记录不一致");
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", asset.profile_id)
    .executeTakeFirstOrThrow();
  const data = await createStorage(runtime).read(
    storageConfigForProfile(runtime, profile),
    asset.object_key,
    candidate.size,
  );
  if (data.length !== candidate.size || sha256(data) !== candidate.sha256)
    fail(409, "原始候选内容已改变，不能继续合成");
  const pixels = await candidatePixels(data);
  if (
    pixels.mime !== candidate.mime ||
    !pixels.data.equals(data) ||
    pixels.dimensions.width !== candidate.dimensions.width ||
    pixels.dimensions.height !== candidate.dimensions.height
  )
    fail(409, "原始候选格式或尺寸与记录不一致");
  await checkJob(db, ctx);
  sources = await options.readReferences(
    candidate.references.map((reference) => reference.referenceImageId),
  );
  checkRawImageSources(candidate, sources);
  if (candidate.kind === "image_revision_raw") {
    const references = await rawImageReferences(
      candidate.references.map((reference) => reference.referenceImageId),
      sources,
    );
    if (
      references.some(
        (reference, index) =>
          !sameReference(reference, candidate.references[index]!),
      )
    )
      fail(409, "修订实际参考图尺寸或字节已改变");
  }
  await verifyOriginal();
  const sourceReferences = sources;
  sources = await actualSources(sourceReferences);
  const currentUser = await db
    .selectFrom("users")
    .select("status")
    .where("id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (currentUser?.status !== "active") fail(401, "登录已失效");
  return { receiptId: id, candidate, data, sources, sourceReferences };
}

export function checkRawImageSources(
  candidate: SavedCandidate,
  sources: { data: Buffer }[],
) {
  if (
    sources.length !== candidate.references.length ||
    sources.some(
      (source, index) =>
        sha256(source.data) !== candidate.references[index]!.sha256 ||
        source.data.length !== candidate.references[index]!.size,
    )
  )
    fail(409, "原始候选的来源字节已改变，不能重新合成");
}

/** Recreate the original affine placement from recorded facts, never current model heuristics. */
export async function rawImageCandidateCanvas(
  candidate: RawImageCandidate,
  raw: Buffer,
  source: Buffer,
) {
  rawImageCandidateSchema.parse(candidate);
  if (
    !candidate.references[0] ||
    sha256(source) !== candidate.references[0].sha256 ||
    sha256(raw) !== candidate.sha256
  )
    fail(409, "原始候选与来源字节不一致");
  const original = await sharp(source, { limitInputPixels: 25_000_000 })
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true });
  if (
    original.info.width !== candidate.references[0].width ||
    original.info.height !== candidate.references[0].height
  )
    fail(409, "原始候选的来源尺寸不一致");
  if (candidate.transform.kind === "full")
    return sharp(raw, { limitInputPixels: 25_000_000 })
      .rotate()
      .resize(original.info.width, original.info.height, { fit: "fill" })
      .png()
      .toBuffer();
  const { rect, workspace } = candidate.transform;
  const data = workspace
    ? await sharp(raw, { limitInputPixels: 25_000_000 })
        .rotate()
        .resize(workspace.width, workspace.height, { fit: "fill" })
        .extract({
          left: workspace.left,
          top: workspace.top,
          width: workspace.contentWidth,
          height: workspace.contentHeight,
        })
        .png()
        .toBuffer()
    : await sharp(raw, { limitInputPixels: 25_000_000 })
        .rotate()
        .resize(rect.width, rect.height, { fit: "fill" })
        .png()
        .toBuffer();
  const canvas = await sharp(original.data)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
  const patch = await sharp(data)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
  for (let row = 0; row < rect.height; row++) {
    const start = row * rect.width * 4;
    patch.copy(
      canvas,
      ((rect.top + row) * original.info.width + rect.left) * 4,
      start,
      start + rect.width * 4,
    );
  }
  return sharp(canvas, {
    raw: {
      width: original.info.width,
      height: original.info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}
