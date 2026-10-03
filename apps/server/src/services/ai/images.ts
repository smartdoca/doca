import { objectKey } from "../storage-policy.js";
import { registerStoredObject } from "../stored-objects.js";
import { createHash, randomUUID } from "node:crypto";
import sharp, { type OutputInfo } from "sharp";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import {
  aiConfig,
  requireImageModel,
  lockAIUser,
  type AIModel,
} from "@core/modules/ai/config.js";
import { providerPreset } from "@core/modules/ai/providers.js";
import { beginCall, settleCall } from "@core/modules/ai/usage.js";
import {
  checkScope,
  checkJob,
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
  type StorageConfig,
} from "../../adapters/storage.js";

export const imageInputSchema = z.object({
  resourceId: z.string().uuid().optional(),
  prompt: z.string().trim().min(2).max(8000),
  aspectRatio: z
    .enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
    .optional()
    .describe("支持的图片长宽比；与 size 二选一"),
  size: z
    .string()
    .regex(/^\d{2,4}x\d{2,4}$/)
    .optional()
    .describe(
      "通常省略，使用管理员配置的默认尺寸；仅在用户明确指定且模型支持时传入",
    ),
});
export type ImageInput = z.infer<typeof imageInputSchema>;

export async function testAIImageModel(
  model: AIModel,
  fetcher: typeof fetch = fetch,
) {
  if (
    !["openai", "compatible"].includes(providerPreset(model.provider).protocol)
  )
    fail(400, "当前生图适配支持 OpenAI Images API 及其兼容服务");
  const size =
    model.imageSize ??
    (/seedream/i.test(model.model) ? "2048x2048" : "1024x1024");
  const dimensions = size.split("x").map(Number);
  if (
    !/^\d{2,4}x\d{2,4}$/.test(size) ||
    dimensions[0]! * dimensions[1]! > 25000000
  )
    fail(400, "图片尺寸无效或过大");
  if (
    /seedream/i.test(model.model) &&
    dimensions[0]! * dimensions[1]! < 3686400
  )
    fail(400, "该 Seedream 模型不支持此小尺寸，请将默认尺寸改为 2048x2048");
  try {
    const response = await fetcher(
      model.baseUrl.replace(/\/$/, "") + "/images/generations",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(180000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${model.apiKey || "ollama"}`,
        },
        body: JSON.stringify({
          model: model.model,
          prompt: "Doca 图片生成连接测试，请生成一张简单的彩色几何图形。",
          n: 1,
          size,
          ...(!model.model.startsWith("gpt-image")
            ? { response_format: "b64_json" }
            : {}),
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        502,
        [401, 403].includes(response.status)
          ? "图片模型认证失败，请检查厂商密钥"
          : `图片模型调用失败（HTTP ${response.status}），请检查模型标识、接口及尺寸支持`,
      );
    }
    if (!response.body) fail(502, "图片服务返回空响应");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body as any) {
      bytes += chunk.byteLength;
      if (bytes > 28 * 1024 * 1024) {
        await response.body.cancel();
        fail(502, "图片响应超过大小限制");
      }
      chunks.push(chunk);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail(502, "图片服务响应无效");
    }
    const encoded = body.data?.[0]?.b64_json;
    if (
      typeof encoded !== "string" ||
      !encoded.length ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      fail(
        502,
        "图片服务没有返回 base64 图片；请使用支持 b64_json 的 Images API",
      );
    return {
      usage: {
        inputTokens: {
          total:
            Number.isSafeInteger(body.usage?.input_tokens) &&
            body.usage.input_tokens >= 0
              ? body.usage.input_tokens
              : 0,
        },
        outputTokens: {
          total:
            Number.isSafeInteger(body.usage?.output_tokens) &&
            body.usage.output_tokens >= 0
              ? body.usage.output_tokens
              : 0,
        },
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(502, "图片模型连接失败，请检查模型标识、接口和密钥");
  }
}

export async function generateImageAsset(
  db: DB,
  ctx: ToolContext,
  input: ImageInput,
  operationId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    storage?: StorageRuntime;
    relatedJobIds?: string[];
  } = {},
) {
  if (input.aspectRatio && input.size)
    fail(400, "图片长宽比和尺寸只能选择一个");
  const config = await aiConfig(db);
  if (!config.imageModel)
    fail(400, "未配置图片生成模型，请管理员在 AI 模型管理的工具配置中选择");
  const { model } = await requireImageModel(
    db,
    ctx.actor.id,
    config.imageModel,
  );
  if (
    !["openai", "compatible"].includes(providerPreset(model.provider).protocol)
  )
    fail(400, "当前生图适配支持 OpenAI Images API 及其兼容服务");
  await requireCapability(db, ctx.actor.id, "assets.upload");
  if (ctx.writable === false) fail(403, "本次授权仅允许读取");
  const seedream = /seedream/i.test(model.model);
  const ratioSize: Record<
    NonNullable<ImageInput["aspectRatio"]>,
    string
  > = seedream
    ? {
        "1:1": "2048x2048",
        "16:9": "2560x1440",
        "9:16": "1440x2560",
        "4:3": "2304x1728",
        "3:4": "1728x2304",
        "3:2": "2496x1664",
        "2:3": "1664x2496",
      }
    : {
        "1:1": "1024x1024",
        "16:9": "1536x864",
        "9:16": "864x1536",
        "4:3": "1152x864",
        "3:4": "864x1152",
        "3:2": "1152x768",
        "2:3": "768x1152",
      };
  const size =
    input.size ??
    (input.aspectRatio ? ratioSize[input.aspectRatio] : undefined) ??
    model.imageSize ??
    (/seedream/i.test(model.model) ? "2048x2048" : "1024x1024");
  const dimensions = size.split("x").map(Number);
  if (
    !/^\d{2,4}x\d{2,4}$/.test(size) ||
    dimensions[0]! * dimensions[1]! > 25000000
  )
    fail(400, "图片尺寸无效或过大");
  if (
    /seedream/i.test(model.model) &&
    dimensions[0]! * dimensions[1]! < 3686400
  )
    fail(
      400,
      "该 Seedream 模型不支持此小尺寸，请省略 size 使用默认尺寸或改用 2048x2048",
    );
  const identity = digest({ ...input, modelId: model.id });
  const existing = await transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    await checkJob(tx, ctx);
    const resource = input.resourceId
      ? (await checkScope(tx, ctx, input.resourceId, true)).resource
      : undefined;
    if (resource && resource.kind !== "document")
      fail(400, "请先创建用于放置图片的文档或画板");
    const old = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", operationId)
      .executeTakeFirst();
    if (old) {
      if (old.user_id !== ctx.actor.id || old.digest !== identity)
        fail(409, "图片操作标识冲突");
      const value = JSON.parse(old.result);
      if (value.state === "failed" && ctx.jobId && old.job_id !== ctx.jobId) {
        await tx
          .updateTable("ai_operations")
          .set({
            job_id: ctx.jobId,
            result: JSON.stringify({
              kind: "image_generation",
              state: "generating",
              resourceId: input.resourceId,
            }),
          })
          .where("id", "=", operationId)
          .execute();
        return null;
      }
      return value;
    }
    // A document (or a chat with no resourceId) can receive several different
    // images. Guard the request identity, not the shared destination.
    const pending = ctx.jobId
      ? await tx
          .selectFrom("ai_operations")
          .select("result")
          .where("user_id", "=", ctx.actor.id)
          .where("digest", "=", identity)
          .where(
            "job_id",
            "in",
            options.relatedJobIds?.length ? options.relatedJobIds : [ctx.jobId],
          )
          .execute()
      : [];
    const blocked = pending
      .map((r) => JSON.parse(r.result))
      .find(
        (value) =>
          value.kind === "image_generation" &&
          ["generating", "save_failed"].includes(value.state),
      );
    if (blocked)
      fail(
        409,
        blocked.state === "save_failed"
          ? "相同的图片请求已生成但保存失败，不能重复提交；请联系管理员检查存储"
          : "相同的图片请求正在生成或结果待核对，不能重复提交；请先核对已有结果",
      );
    await tx
      .insertInto("ai_operations")
      .values({
        id: operationId,
        user_id: ctx.actor.id,
        job_id: ctx.jobId ?? null,
        digest: identity,
        result: JSON.stringify({
          kind: "image_generation",
          state: "generating",
          resourceId: input.resourceId,
        }),
        created_at: new Date().toISOString(),
      })
      .execute();
    return null;
  });
  if (existing) {
    if (existing.state === "save_failed")
      fail(
        409,
        "这次图片已生成但保存失败，请先联系管理员检查存储；请勿重复生成",
      );
    if (!existing.assetId)
      fail(
        409,
        "这次图片请求已执行或结果待核对，请勿重复生成。可查看任务记录后重新提出生成要求。",
      );
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", existing.assetId)
      .where("owner_id", "=", ctx.actor.id)
      .where("resource_id", "is", null)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!asset) fail(404, "生成的图片已不可用");
    return {
      ...existing,
      ready: true,
    };
  }
  let call: Awaited<ReturnType<typeof beginCall>>;
  try {
    call = await beginCall(
      db,
      ctx.actor.id,
      model.id,
      ctx.jobId ?? null,
      0,
      0,
      1,
      size,
    );
  } catch (error) {
    await db
      .deleteFrom("ai_operations")
      .where("id", "=", operationId)
      .execute();
    throw error;
  }
  const runtime = options.storage ?? storageRuntime();
  const storage = createStorage(runtime);
  let stored: { config: StorageConfig; key: string } | undefined;
  let committed = false,
    settled = false,
    definitiveRejection = false;
  try {
    options.signal?.throwIfAborted();
    const response = await (options.fetch ?? fetch)(
      model.baseUrl.replace(/\/$/, "") + "/images/generations",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(180000),
          ...(options.signal ? [options.signal] : []),
        ]),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify({
          model: model.model,
          prompt: input.prompt,
          n: 1,
          size,
          ...(!model.model.startsWith("gpt-image")
            ? { response_format: "b64_json" }
            : {}),
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
        await settleCall(
          db,
          call.id,
          { input: 0, output: 0, images: 0, raw: { images: 0 } },
          "failed",
        );
        settled = true;
        definitiveRejection = true;
      }
      fail(
        502,
        [401, 403].includes(response.status)
          ? "图片模型认证失败，请检查厂商密钥"
          : "图片模型调用失败，请检查模型标识、接口及尺寸支持",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) fail(502, "生图服务返回空响应");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 28 * 1024 * 1024) {
        await reader.cancel();
        fail(502, "图片响应超过大小限制");
      }
      chunks.push(chunk.value);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail(502, "图片服务响应无效");
    }
    const encoded = body.data?.[0]?.b64_json;
    if (
      typeof encoded !== "string" ||
      !encoded.length ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      fail(
        502,
        "图片服务没有返回 base64 图片；请使用支持 b64_json 的 Images API",
      );
    const actual = (key: string) =>
      Number.isSafeInteger(body.usage?.[key]) && body.usage[key] >= 0
        ? body.usage[key]
        : 0;
    await settleCall(db, call.id, {
      input: actual("input_tokens"),
      output: actual("output_tokens"),
      images: 1,
      raw: {
        images: 1,
        unit: "image",
        inputTokens: actual("input_tokens"),
        outputTokens: actual("output_tokens"),
      },
    });
    settled = true;
    let rendered: { data: Buffer; info: OutputInfo };
    try {
      const decoder = sharp(Buffer.from(encoded, "base64"), {
        limitInputPixels: 25000000,
        animated: false,
      });
      const meta = await decoder.metadata();
      if (!["png", "jpeg", "webp", "gif"].includes(meta.format ?? ""))
        fail(502, "图片格式不支持");
      rendered = await decoder
        .rotate()
        .webp({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      fail(502, "生成图片无法解析或分辨率过大");
    }
    if (rendered.data.length > 20 * 1024 * 1024) fail(413, "生成图片文件过大");
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow();
    const storageConfig = storageConfigForProfile(runtime, profile);
    const assetId = randomUUID(),
      key = objectKey(assetId, "image/webp"),
      filename = `AI-${assetId.slice(0, 8)}.webp`;
    options.signal?.throwIfAborted();
    await storage.put(
      storageConfig,
      key,
      rendered.data,
      "image/webp",
      filename,
    );
    stored = { config: storageConfig, key };
    const result = await transact(db, async (tx) => {
      await lockAIUser(tx, ctx.actor.id);
      await checkJob(tx, ctx);
      await requireCapability(tx, ctx.actor.id, "ai.create");
      if (input.resourceId) await checkScope(tx, ctx, input.resourceId, true);
      await requireCapability(tx, ctx.actor.id, "assets.upload");
      await checkStorage(tx, ctx.actor.id, rendered.data.length);
      const asset: Schema["assets"] = {
        id: assetId,
        owner_id: ctx.actor.id,
        uploaded_by: ctx.actor.id,
        resource_id: null,
        purpose: "ai_attachment",
        profile_id: profile.id,
        object_key: key,
        filename,
        mime: "image/webp",
        size: rendered.data.length,
        created_at: new Date().toISOString(),
        deleted_at: null,
      };
      await tx.insertInto("assets").values(asset).execute();
      const recognitionSetting = await tx
        .selectFrom("file_recognition_settings")
        .select("config")
        .where("id", "=", "default")
        .executeTakeFirst();
      const recognitionConfig = recognitionSetting
        ? (JSON.parse(recognitionSetting.config) as {
            enabled?: boolean;
            modelId?: string | null;
          })
        : {};
      const recognitionEnabled =
        !!recognitionConfig.enabled && !!recognitionConfig.modelId;
      const fileObject: Schema["file_storage_objects"] = {
        id: asset.id,
        profile_id: asset.profile_id,
        object_key: asset.object_key,
        sha256: createHash("sha256").update(rendered.data).digest("hex"),
        size: asset.size,
        mime: asset.mime,
        ai_description: recognitionEnabled ? null : "AI 生成图片",
        ai_status: recognitionEnabled ? "pending" : "skipped",
        ai_model: recognitionEnabled ? recognitionConfig.modelId! : null,
        ai_generated_at: asset.created_at,
        created_at: asset.created_at,
      };
      await registerStoredObject(tx, fileObject);
      await tx
        .insertInto("file_items")
        .values({
          id: randomUUID(),
          owner_id: asset.owner_id,
          parent_type: "system",
          parent_id: "ai",
          storage_object_id: fileObject.id,
          name: asset.filename,
          mime: asset.mime,
          size: asset.size,
          metadata: JSON.stringify({ assetId: asset.id }),
          ai_description_override: null,
          locked: 0,
          version: 1,
          created_at: asset.created_at,
          updated_at: asset.created_at,
          deleted_at: null,
          delete_batch: null,
        })
        .execute();
      const sourceItem = await tx
        .selectFrom("file_items")
        .select("id")
        .where("storage_object_id", "=", fileObject.id)
        .where("parent_type", "=", "system")
        .where("parent_id", "=", "ai")
        .executeTakeFirstOrThrow();
      await enqueueProjection(tx, "search-file", sourceItem.id, {
        fileId: sourceItem.id,
      });
      const result = {
        kind: "image_generation",
        state: "saved",
        resourceId: input.resourceId,
        assetId,
        filename,
        width: rendered.info.width,
        height: rendered.info.height,
        mime: "image/webp",
        size: rendered.data.length,
        ready: true,
        url: `/api/v1/assets/${assetId}/content`,
        instruction: input.resourceId
          ? "图片已存入 AI 助手文件夹并展示在对话中。仅在用户要求插入时调用 image_insert；加入文档只会创建位置引用，不会复制图片内容。"
          : "图片已存入 AI 助手文件夹并展示在对话中。用户可预览、下载或点击加入文档；加入文档只会创建位置引用。",
      };
      await tx
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(result) })
        .where("id", "=", operationId)
        .execute();
      await tx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          actor_id: ctx.actor.id,
          resource_id: input.resourceId ?? null,
          action: "ai.image.generated",
          created_at: asset.created_at,
        })
        .execute();
      return result;
    });
    committed = true;
    return result;
  } catch (error) {
    if (definitiveRejection || settled)
      await db
        .updateTable("ai_operations")
        .set({
          result: JSON.stringify({
            kind: "image_generation",
            state: definitiveRejection ? "failed" : "save_failed",
            resourceId: input.resourceId,
          }),
        })
        .where("id", "=", operationId)
        .execute();
    if (!settled) await settleCall(db, call.id, null);
    if (stored && !committed)
      await storage.remove(stored.config, stored.key).catch(() => {});
    options.signal?.throwIfAborted();
    if (error instanceof AppError) throw error;
    if (settled)
      fail(
        500,
        "图片模型已返回结果，但图片保存失败；本次用量已记录，请联系管理员检查存储和数据库",
      );
    fail(502, "图片生成未完成，结果和费用待核对，请稍后查看任务记录");
  }
}
