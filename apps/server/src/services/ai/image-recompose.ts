import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import {
  checkJob,
  checkScope,
  digest,
  type ToolContext,
} from "@core/workflows/ai-documents.js";
import {
  checkStorage,
  requireCapability,
} from "@core/modules/access/operation-policy.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
  type StorageRuntime,
} from "../../adapters/storage.js";
import { registerStoredObject } from "../stored-objects.js";
import { objectKey } from "../storage-policy.js";
import { readRawImageCandidate } from "./images.js";
import { rawImageCandidateCanvas } from "./image-candidates.js";
import {
  editRegionsSchema,
  preserveOutsideRegions,
} from "./image-edit-regions.js";
import { referenceCropsSchema } from "./image-edit-adapter.js";
import { aiJobSessionFolder } from "./session-file-folders.js";
import { readImageEditMask } from "./image-edit-mask.js";
import { preserveOutsideBitmap } from "./image-edit-bitmap.js";

export const imageRecomposeSchema = z
  .object({
    generationOperationId: z.string().uuid(),
    referenceImageId: z.string().uuid(),
    editRegions: editRegionsSchema,
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^/\\]+$/),
  })
  .strict();
export type ImageRecomposeInput = z.infer<typeof imageRecomposeSchema>;
export const imageMaskComposeSchema = z.object({
  maskReceiptId: z.string().uuid(),
  generationOperationId: z.string().uuid(),
  referenceImageId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255).regex(/^[^/\\]+$/),
}).strict();
export type ImageMaskComposeInput = z.infer<typeof imageMaskComposeSchema>;
async function publicBoundary<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw new DOMException("图片合成已取消或任务授权已撤回", "AbortError");
    if (error instanceof AppError) throw error;
    fail(503, "图片合成资料或保存暂时不可用，原记录保留；本次没有调用图片服务", {
      code: "image_recompose_io_failed",
    });
  }
}
const generationSchema = z
  .object({
    prompt: z.string(),
    referenceImageIds: z.array(z.string().uuid()),
    editRegions: editRegionsSchema.optional(),
    referenceCrops: referenceCropsSchema.optional(),
  })
  .strict();

/** Reuse a retained provider candidate. This path has no provider call or image usage settlement. */
export async function recomposeImageAsset(
  db: DB,
  ctx: ToolContext,
  input: ImageRecomposeInput,
  operationId: string,
  options: { storage?: StorageRuntime; signal?: AbortSignal } = {},
) {
  imageRecomposeSchema.parse(input);
  return publicBoundary(options.signal, () =>
    saveRecomposition(db, ctx, input, operationId, options),
  );
}

/** Exact binary mask composition is a distinct strict tool, never a polygon fallback. */
export async function recomposeImageMaskAsset(
  db: DB,
  ctx: ToolContext,
  input: ImageMaskComposeInput,
  operationId: string,
  options: { storage?: StorageRuntime; signal?: AbortSignal } = {},
) {
  imageMaskComposeSchema.parse(input);
  return publicBoundary(options.signal, () =>
    saveRecomposition(db, ctx, input, operationId, options),
  );
}

async function saveRecomposition(
  db: DB,
  ctx: ToolContext,
  input: ImageRecomposeInput | ImageMaskComposeInput,
  operationId: string,
  options: { storage?: StorageRuntime; signal?: AbortSignal },
) {
  if (ctx.writable === false)
    fail(403, "当前上下文只允许读取，不能保存重合成图片");
  options.signal?.throwIfAborted();
  const runtime = options.storage ?? storageRuntime();
  const raw = await readRawImageCandidate(
    db,
    ctx,
    input.generationOperationId,
    runtime,
  );
  const mask = "maskReceiptId" in input
    ? await readImageEditMask(db, ctx, input.maskReceiptId, options)
    : undefined;
  if (mask && (
    mask.receipt.input.referenceImageId !== input.referenceImageId ||
    mask.receipt.input.generationOperationId !== input.generationOperationId ||
    mask.receipt.raw.sha256 !== raw.candidate.sha256
  )) fail(409, "蒙版回执与本次原页或原始候选不一致");
  if (mask && !mask.receipt.diagnostics.safeToCompose)
    fail(409, "蒙版仍覆盖不允许修改的保护区域，先修正并重新预览，不能裁断新人物或覆盖原道具");
  if (raw.candidate.references[0]?.referenceImageId !== input.referenceImageId)
    fail(409, "重合成来源必须为原始候选绑定的第一张原页");
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", input.generationOperationId)
    .where("user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  const parsed = generationSchema.safeParse(
    row ? JSON.parse(row.result).generation : undefined,
  );
  if (
    !parsed.success ||
    parsed.data.referenceImageIds.join() !==
      raw.candidate.references.map((ref) => ref.referenceImageId).join()
  )
    fail(422, "原生成输入事实缺失或与原始候选不一致，不能补造重合成记录");
  if (raw.candidate.transform.kind === "full") {
    const [source, candidate] = await Promise.all([
      sharp(raw.sources[0]!.data, { limitInputPixels: 25_000_000 }).metadata(),
      sharp(raw.data, { limitInputPixels: 25_000_000 }).metadata(),
    ]);
    const denominator = source.autoOrient.width * candidate.autoOrient.height,
      difference = Math.abs(
        candidate.autoOrient.width * source.autoOrient.height - denominator,
      );
    if (difference * 100 > denominator)
      fail(
        409,
        "整页原始候选与原页的实际比例偏差超过 1%，不能通过拉伸重合成修复；原始候选保留供诊断，本次未保存新图片或调用图片模型",
        { code: "image_recompose_aspect_mismatch" },
      );
  }
  // A window generation has no new pixels beyond that window. Do not silently use the
  // unchanged source outside it and claim the expanded target was regenerated.
  if (raw.candidate.transform.kind === "viewport" && "editRegions" in input) {
    const rect = raw.candidate.transform.rect,
      source = raw.candidate.references[0]!;
    if (
      input.editRegions.some((region) =>
        region.points.some(
          ([x, y]) =>
            x * source.width < rect.left ||
            x * source.width > rect.left + rect.width ||
            y * source.height < rect.top ||
            y * source.height > rect.top + rect.height,
        ),
      )
    )
      fail(
        409,
        "新轮廓超出原始候选的实际生成窗口，不能在没有生成像素的区域重合成",
      );
  }
  // A new mask replaces the old declared polygon for this new result only. The
  // retained raw and previous result stay intact; the verifier sees the full page.
  const { editRegions: ignoredRegions, ...rawGeneration } = parsed.data;
  const generation = "editRegions" in input
    ? { ...parsed.data, editRegions: input.editRegions }
    : rawGeneration;
  const editMask = mask ? {
    version: mask.receipt.version,
    receiptId: mask.receipt.receiptId,
    digest: mask.receipt.digest,
    maskDigest: mask.receipt.maskDigest,
  } : undefined;
  const resourceId = raw.candidate.scope.resourceId;
  const identity = digest({ ...input, rawSha256: raw.candidate.sha256 });
  const authorize = async (tx: DB, bytes: number) => {
    await checkJob(tx, ctx);
    await requireCapability(tx, ctx.actor.id, "ai.create");
    await requireCapability(tx, ctx.actor.id, "assets.upload");
    if (resourceId) await checkScope(tx, ctx, resourceId, true);
    // Recheck source membership, source digests, raw object and the current session
    // at each mutation boundary, rather than trusting pre-compute authorization.
    await readRawImageCandidate(tx, ctx, input.generationOperationId, runtime);
    if (mask && "maskReceiptId" in input) {
      const current = await readImageEditMask(tx, ctx, input.maskReceiptId, options);
      if (current.receipt.digest !== mask.receipt.digest || !current.receipt.diagnostics.safeToCompose)
        fail(409, "蒙版绑定或保护状态已改变，不能保存");
    }
    if (bytes) await checkStorage(tx, ctx.actor.id, bytes);
  };
  const existing = await transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    await authorize(tx, 0);
    const previous = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", operationId)
      .executeTakeFirst();
    if (previous) {
      if (previous.user_id !== ctx.actor.id || previous.digest !== identity)
        fail(409, "重合成操作标识冲突");
      const receipt = JSON.parse(previous.result);
      if (
        receipt.kind !== "image_generation" ||
        receipt.origin !== "local-recomposition" ||
        receipt.state !== "saved"
      )
        fail(
          409,
          "该本地重合成结果尚未确认，请先核对；原始候选仍保留，不会重新调用图片模型",
        );
      const asset = await tx
        .selectFrom("assets")
        .select("id")
        .where("id", "=", receipt.assetId)
        .where("owner_id", "=", ctx.actor.id)
        .where("purpose", "=", "ai_attachment")
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!asset) fail(404, "此前重合成图片已不可用");
      return receipt;
    }
    await tx
      .insertInto("ai_operations")
      .values({
        id: operationId,
        user_id: ctx.actor.id,
        job_id: ctx.jobId ?? null,
        digest: identity,
        created_at: new Date().toISOString(),
        result: JSON.stringify({
          kind: "image_generation",
          ...(JSON.parse(row!.result).version===1?{version:1}:{}),
          state: "composing",
          origin: "local-recomposition",
          generationOperationId: input.generationOperationId,
          generation,
          ...(editMask ? { editMask } : {}),
          rawCandidate: {
            version: 1,
            receiptId: raw.receiptId,
            assetId: raw.candidate.assetId,
            sha256: raw.candidate.sha256,
          },
        }),
      })
      .execute();
    return null;
  });
  if (existing) return { ...existing, ready: true };
  const storage = createStorage(runtime);
  let stored:
    | {
        config: ReturnType<typeof storageConfigForProfile>;
        key: string;
        profileId: string;
      }
    | undefined;
  let committed = false;
  try {
    const canvas = await rawImageCandidateCanvas(
      raw.candidate,
      raw.data,
      raw.sources[0]!.data,
    );
    const rendered = mask
      ? await preserveOutsideBitmap(raw.sources[0]!.data, canvas, mask.maskPNG, mask.protectionPNG)
      : await preserveOutsideRegions(raw.sources[0]!.data, canvas, (input as ImageRecomposeInput).editRegions);
    if (rendered.data.length > 20 * 1024 * 1024)
      fail(413, "重合成图片文件过大");
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow();
    const config = storageConfigForProfile(runtime, profile),
      assetId = randomUUID(),
      mime = "image/png";
    const key = objectKey(assetId, mime),
      filename = input.filename.replace(/\.[^.]+$/, "") + ".png";
    // Check quota before writing, and again under the mutation lock when committing.
    await transact(db, async (tx) => {
      await lockAIUser(tx, ctx.actor.id);
      await authorize(tx, rendered.data.length);
      const pending = await tx
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", operationId)
        .where("user_id", "=", ctx.actor.id)
        .where("digest", "=", identity)
        .executeTakeFirst();
      if (!pending || JSON.parse(pending.result).state !== "composing")
        fail(409, "本地重合成操作状态已改变，不能写入既有结果");
      // Keep a credential-free locator before the external write. If the final
      // commit cannot be confirmed, the retained object is still discoverable.
      const updated = await tx
        .updateTable("ai_operations")
        .set({
          result: JSON.stringify({
            ...JSON.parse(pending.result),
            localStorage: {
              state: "planned",
              assetId,
              objectKey: key,
              profileId: profile.id,
            },
          }),
        })
        .where("id", "=", operationId)
        .where("result", "=", pending.result)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n)
        fail(409, "本地重合成操作状态已改变，不能覆盖既有结果");
      options.signal?.throwIfAborted();
    });
    options.signal?.throwIfAborted();
    stored = { config, key, profileId: profile.id };
    await storage.put(config, key, rendered.data, mime, filename);
    const result = await transact(db, async (tx) => {
      await lockAIUser(tx, ctx.actor.id);
      await authorize(tx, rendered.data.length);
      options.signal?.throwIfAborted();
      const pending = await tx
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", operationId)
        .where("user_id", "=", ctx.actor.id)
        .where("digest", "=", identity)
        .executeTakeFirst();
      if (!pending || JSON.parse(pending.result).state !== "composing")
        fail(409, "本地重合成操作状态已改变，不能覆盖既有结果");
      const now = new Date().toISOString();
      const asset: Schema["assets"] = {
        id: assetId,
        owner_id: ctx.actor.id,
        uploaded_by: ctx.actor.id,
        resource_id: null,
        purpose: "ai_attachment",
        profile_id: profile.id,
        object_key: key,
        filename,
        mime,
        size: rendered.data.length,
        created_at: now,
        deleted_at: null,
      };
      await tx.insertInto("assets").values(asset).execute();
      await registerStoredObject(tx, {
        id: assetId,
        profile_id: profile.id,
        object_key: key,
        sha256: createHash("sha256").update(rendered.data).digest("hex"),
        size: asset.size,
        mime,
        ai_description: "AI 图片本地重合成候选",
        ai_status: "skipped",
        ai_model: null,
        ai_generated_at: now,
        created_at: now,
      });
      const fileId = randomUUID();
      await tx
        .insertInto("file_items")
        .values({
          id: fileId,
          owner_id: ctx.actor.id,
          parent_type: "system",
          parent_id: "ai",
          storage_object_id: assetId,
          name: filename,
          mime,
          size: asset.size,
          metadata: JSON.stringify({
            assetId,
            aiSessionFolder: await aiJobSessionFolder(
              tx,
              ctx.actor.id,
              ctx.jobId,
            ),
          }),
          ai_description_override: null,
          locked: 0,
          version: 1,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          delete_batch: null,
        })
        .execute();
      await enqueueProjection(tx, "search-file", fileId, { fileId });
      const native = raw.candidate.nativeUsage;
      const inputImages =
        native.state === "reported" &&
        native.value !== null &&
        typeof native.value === "object" &&
        !Array.isArray(native.value)
          ? native.value.input_images
          : undefined;
      const result = {
        kind: "image_generation",
          ...(JSON.parse(row!.result).version===1?{version:1}:{}),
        state: "saved",
        origin: "local-recomposition",
        generationOperationId: input.generationOperationId,
        ...(resourceId ? { resourceId } : {}),
        assetId,
        filename,
        width: rendered.info.width,
        height: rendered.info.height,
        mime,
        generation,
        ...(editMask ? { editMask } : {}),
        rawCandidate: {
          version: 1,
          receiptId: raw.receiptId,
          assetId: raw.candidate.assetId,
          sha256: raw.candidate.sha256,
        },
        providerCallId: raw.candidate.providerCallId,
        ...(typeof inputImages === "number" &&
        Number.isSafeInteger(inputImages) &&
        inputImages >= 0
          ? { providerImageUsage: { inputImages } }
          : {}),
        preservation: rendered.preservation,
        size: asset.size,
        ready: true,
        url: `/api/v1/assets/${assetId}/content`,
        instruction:
          "已用持久原始候选完成本地重合成，没有新增图片模型调用；仍需实际看图并按用户原始标准独立验收，不能只凭保护像素为零宣称通过。",
      };
      const updated = await tx
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(result) })
        .where("id", "=", operationId)
        .where("result", "=", pending.result)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n)
        fail(409, "本地重合成回执状态已改变，不能覆盖既有结果");
      await tx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          actor_id: ctx.actor.id,
          resource_id: resourceId,
          action: "ai.image.recomposed",
          created_at: now,
        })
        .execute();
      await checkJob(tx, ctx);
      options.signal?.throwIfAborted();
      return result;
    });
    committed = true;
    return result;
  } catch (error) {
    // A lost commit acknowledgement must not lead to deletion of a committed image.
    const saved = await db
      .selectFrom("ai_operations")
      .select("result")
      .where("id", "=", operationId)
      .where("user_id", "=", ctx.actor.id)
      .executeTakeFirst()
      .catch(() => undefined);
    if (saved) {
      const receipt = JSON.parse(saved.result);
      if (receipt.state === "saved" && receipt.origin === "local-recomposition")
        return receipt;
    }
    // If the database cannot establish commit state, leave the receipt/object intact.
    // An unavailable acknowledgement is not proof that a write was rolled back.
    if (saved && JSON.parse(saved.result).state === "composing") {
      const failure = {
        kind: "image_generation",
          ...(JSON.parse(row!.result).version===1?{version:1}:{}),
        state: "save_failed",
        origin: "local-recomposition",
        generationOperationId: input.generationOperationId,
        generation,
        ...(editMask ? { editMask } : {}),
        rawCandidate: {
          version: 1,
          receiptId: raw.receiptId,
          assetId: raw.candidate.assetId,
          sha256: raw.candidate.sha256,
        },
        localStorage: {
          cleanup: stored ? "uncertain" : "not-written",
          ...(stored
            ? { objectKey: stored.key, profileId: stored.profileId }
            : {}),
        },
      };
      const failed = await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(failure) })
        .where("id", "=", operationId)
        .where("user_id", "=", ctx.actor.id)
        .where("result", "=", saved.result)
        .executeTakeFirst()
        .catch(() => undefined);
      // Only a successful CAS of the known uncommitted state permits cleanup.
      if (stored && !committed && failed?.numUpdatedRows === 1n) {
        try {
          await storage.remove(stored.config, stored.key);
          await db
            .updateTable("ai_operations")
            .set({
              result: JSON.stringify({
                ...failure,
                localStorage: { cleanup: "removed" },
              }),
            })
            .where("id", "=", operationId)
            .where("result", "=", JSON.stringify(failure))
            .execute();
        } catch {
          /* Failure facts retain the object locator without storage credentials. */
        }
      }
    }
    throw error;
  }
}
