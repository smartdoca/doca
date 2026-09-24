import { checkQuickNoteIds } from "../services/ai/quick-notes.js";
import { defaultOfficialSkills } from "@core/modules/ai/skills.js";
import { checkAttachments } from "../services/ai/attachments.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  testAIModel,
  discoverAIModels,
  modelConnectionError,
  modelConnectionDetail,
} from "../services/ai/providers.js";
import { aiProviders } from "@core/modules/ai/providers.js";
import { usageOf } from "../services/ai/model.js";
import { testAIEmbeddingModel } from "../services/ai/embeddings.js";
import { testAIImageModel } from "../services/ai/images.js";
import { fetchWebPage } from "../services/ai/web-fetch.js";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import {
  tokenHash,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { authorize } from "@core/modules/access/queries.js";
import {
  entitlementConfig,
  requireCapability,
} from "@core/modules/entitlements/service.js";
import {
  aiConfig,
  aiConfigSchema,
  storedAIConfig,
  aiUser,
  availableModels,
  displayModel,
  lockAIUser,
  requireModel,
  saveAIConfig,
} from "@core/modules/ai/config.js";
import {
  aiPeriods,
  pointUnits,
  quotaSummary,
  settleCall,
} from "@core/modules/ai/quota.js";
import {
  digest,
  readAIDocument,
  previewAIDocument,
} from "@core/workflows/ai-documents.js";
import { createAIRunner, sessionSources } from "../services/ai/runner.js";
import { explorerTargets, memoryOwner, messageText, messageReasoning } from "../services/ai/memory.js";
import { noteLimit, readNote, writeNote } from "../services/ai/notes.js";
import {
  deleteSecret,
  listSecrets,
  writeSecret,
} from "../services/ai/secrets.js";
import { registerAIMcp } from "./ai-mcp.js";
import { searchWeb } from "../services/ai/web-search.js";
import {
  imageInsertSchema,
  insertGeneratedImage,
  generatedImageStatus,
} from "../services/ai/image-insert.js";
import {
  progressPatch,
  type AIProgress,
} from "@core/modules/ai/progress.js";

function stripMaskedAIConfig(value: any) {
  const strip = (item: any) => {
    if (!item || typeof item !== "object") return item;
    const { hasKey: _hasKey, ...rest } = item;
    return rest;
  };
  return {
    ...value,
    webSearch: strip(value.webSearch),
    webFetch: strip(value.webFetch),
    vendors: Array.isArray(value.vendors)
      ? value.vendors.map(strip)
      : value.vendors,
    models: Array.isArray(value.models)
      ? value.models.map(strip)
      : value.models,
  };
}

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") + "：" : "";
    fail(400, "参数无效：" + path + (issue?.message ?? "格式不正确"));
  }
  return r.data;
};
const id = z.string().uuid();
export async function registerAI(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  admin: (req: FastifyRequest) => Actor,
  options: Parameters<typeof createAIRunner>[1] = {},
) {
  const runner = createAIRunner(db, { ...options, logger: api.log });
  api.get<{ Params: { id: string } }>(
    "/api/v1/ai/images/:id/status",
    async (req) =>
      generatedImageStatus(db, { actor: auth(req) }, parse(id, req.params.id)),
  );
  api.post("/api/v1/ai/images/insert", async (req) => {
    const actor = auth(req);
    const { requestId, sessionId, ...input } = parse(
      imageInsertSchema.extend({ requestId: id, sessionId: id.optional() }),
      req.body,
    );
    if (sessionId) {
      const session = await db
        .selectFrom("ai_sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .where("user_id", "=", actor.id)
        .executeTakeFirst();
      if (!session) fail(404, "会话不存在");
      await sessionSources(db, actor.id, session);
    }
    const result = await insertGeneratedImage(
      db,
      { actor, notify: options.notify },
      input,
      requestId,
      options.storage,
    );
    if (sessionId)
      await transact(db, async (tx) => {
        await lockAIUser(tx, actor.id);
        const session = await tx
          .selectFrom("ai_sessions")
          .selectAll()
          .where("id", "=", sessionId)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        if (session)
          await tx
            .updateTable("ai_sessions")
            .set({
              resource_ids: JSON.stringify([
                ...new Set([
                  ...JSON.parse(session.resource_ids),
                  input.resourceId,
                ]),
              ]),
            })
            .where("id", "=", session.id)
            .execute();
      });
    return result;
  });
  api.addHook("preClose", async () => runner.close());
  const session = async (
    user: Actor,
    sessionId: string,
    checkSources = true,
  ) => {
    const row = await db
      .selectFrom("ai_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    if (!row) fail(404, "会话不存在");
    if (checkSources) await sessionSources(db, user.id, row);
    return row;
  };
  api.get("/api/v1/ai/options", async (req) => {
    const user = auth(req),
      { config, models, rights } = await availableModels(db, user.id),
      prefs = await aiUser(db, user.id);
    return {
      enabled: rights.can["ai.create"],
      memoryAvailable: config.memoryEnabled,
      webSearchAvailable:
        config.webSearch?.provider === "searxng"
          ? !!config.webSearch.baseUrl
          : !!config.webSearch?.apiKey,
      preferences: prefs,
      defaultModel: config.defaultModel,
      models: models.map((m) => ({
        id: m.id,
        name: displayModel(config, m),
        inputRate: m.inputRate,
        outputRate: m.outputRate,
        cacheRate: m.cacheRate,
        maxInput: m.maxInput,
        maxOutput: m.maxOutput,
        vision: !!m.vision,
        pdf: !!m.pdf,
      })),
    };
  });
  api.get("/api/v1/admin/ai", async (req) => {
    admin(req);
    const config = await aiConfig(db);
    return {
      providers: aiProviders,
      config: {
        ...storedAIConfig(config),
        webSearch: config.webSearch
          ? {
              ...config.webSearch,
              apiKey: null,
              hasKey: !!config.webSearch.apiKey,
            }
          : undefined,
        webFetch: config.webFetch
          ? {
              ...config.webFetch,
              apiKey: null,
              hasKey: !!config.webFetch.apiKey,
            }
          : undefined,
        vendors: config.vendors.map((v) => ({
          ...v,
          apiKey: null,
          hasKey: !!v.apiKey,
        })),
      },
      levels: (await entitlementConfig(db)).levels.map((l) => ({
        id: l.id,
        name: l.name,
      })),
    };
  });
  api.post("/api/v1/admin/ai/web-search/test", async (req) => {
    admin(req);
    const result = await searchWeb(
      (await aiConfig(db)).webSearch,
      "SearXNG documentation",
      undefined,
      options.webFetch,
    );
    return { count: result.sources.length, provider: result.provider };
  });
  api.post("/api/v1/admin/ai/web-fetch/test", async (req) => {
    admin(req);
    const config = await aiConfig(db);
    const page = await fetchWebPage(
      "https://example.com",
      undefined,
      { fetcher: options.webFetch },
      config.webFetch,
    );
    return {
      ok: true,
      provider: config.webFetch?.provider ?? "builtin",
      title: page.title,
      length: page.text.length,
    };
  });
  api.put(
    "/api/v1/admin/ai/management",
    { bodyLimit: 2 * 1024 * 1024 },
    async (req) => {
      admin(req);
      const { revision, config: rawConfig } = parse(
        z
          .object({
            revision: z.number().int().min(0),
            config: z.any(),
          })
          .strict(),
        req.body,
      );
      const config = parse(
        aiConfigSchema.omit({ limits: true, taskBudget: true }),
        stripMaskedAIConfig(rawConfig),
      );
      const old = await aiConfig(db);
      const models = config.models.map((m) => {
        const previous = old.models.find((x) => x.id === m.id);
        return {
          ...m,
          inputRate: previous?.inputRate ?? 1,
          outputRate: previous?.outputRate ?? 1,
          cacheRate: previous?.cacheRate ?? 1,
          imageRate: previous?.imageRate,
          imageSizeRates: previous?.imageSizeRates,
        };
      });
      const result = await saveAIConfig(
        db,
        { ...config, models, limits: old.limits, taskBudget: old.taskBudget },
        revision,
      );
      return { revision: result.revision };
    },
  );
  api.get("/api/v1/admin/ai/credits", async (req) => {
    admin(req);
    const c = await aiConfig(db);
    return {
      revision: c.revision,
      limits: c.limits,
      taskBudget: c.taskBudget,
      models: c.models.map((m) => ({
        id: m.id,
        name: m.alias || m.model,
        vendor: c.vendors.find((v) => v.id === m.vendorId)?.name,
        embedding: !!m.embedding,
        inputRate: m.inputRate,
        outputRate: m.outputRate,
        cacheRate: m.cacheRate,
        imageGeneration: !!m.imageGeneration,
        imageRate: m.imageRate,
        imageSizeRates: m.imageSizeRates,
      })),
      levels: (await entitlementConfig(db)).levels.map((l) => ({
        id: l.id,
        name: l.name,
      })),
    };
  });
  api.put("/api/v1/admin/ai/credits", async (req) => {
    admin(req);
    const { revision, limits, taskBudget, models } = parse(
      aiConfigSchema
        .pick({ limits: true, taskBudget: true })
        .extend({
          revision: z.number().int().min(0),
          models: z
            .array(
              z
                .object({
                  id: z.string(),
                  inputRate: z.number(),
                  outputRate: z.number(),
                  cacheRate: z.number(),
                  imageRate: z.number().optional(),
                  imageSizeRates: z.record(z.string(), z.number()).optional(),
                })
                .strict(),
            )
            .max(50),
        })
        .strict(),
      req.body,
    );
    const { revision: oldRevision, ...old } = await aiConfig(db);
    if (oldRevision !== revision) fail(409, "配置已变化，请刷新");
    if (
      new Set(models.map((m) => m.id)).size !== models.length ||
      models.some((m) => !old.models.some((x) => x.id === m.id))
    )
      fail(400, "模型不存在或重复");
    const result = await saveAIConfig(
      db,
      {
        ...old,
        limits,
        taskBudget,
        models: old.models.map((m) => ({
          ...m,
          ...models.find((x) => x.id === m.id),
        })),
      },
      revision,
    );
    return { revision: result.revision };
  });
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/ai/vendors/:id/catalog",
    async (req) => {
      admin(req);
      const vendor = (await aiConfig(db)).vendors.find(
        (v) => v.id === req.params.id,
      );
      if (!vendor || (!vendor.apiKey && vendor.provider !== "ollama"))
        fail(400, "请先保存厂商地址与密钥");
      return discoverAIModels(vendor, options.fetch);
    },
  );
  api.post("/api/v1/admin/ai/embeddings/detect", async (req) => {
    admin(req);
    const body = parse(
      z
        .object({
          vendorId: z.string().min(1).max(64),
          model: z.string().trim().min(1).max(160),
          embeddingApi: z.enum(["openai", "doubao-multimodal"]).optional(),
        })
        .strict(),
      req.body,
    );
    const vendor = (await aiConfig(db)).vendors.find(
      (v) => v.id === body.vendorId,
    );
    if (
      !vendor ||
      !vendor.enabled ||
      (!vendor.apiKey && vendor.provider !== "ollama")
    )
      fail(400, "请先保存并启用厂商地址与密钥");
    const result = await testAIEmbeddingModel(
      {
        ...vendor,
        id: "embedding-probe",
        vendorId: vendor.id,
        model: body.model,
        embeddingApi: body.embeddingApi,
        alias: "向量检测",
        embedding: true,
        tools: false,
        levels: [],
        inputRate: 1,
        outputRate: 1,
        cacheRate: 1,
        maxInput: 8000,
        maxOutput: 32,
      },
      options.fetch,
    );
    return { dimensions: result.dimensions };
  });
  api.put("/api/v1/admin/ai", { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    admin(req);
    const { revision, config: rawConfig } = parse(
      z.object({ revision: z.number().int().min(0), config: z.any() }),
      req.body,
    );
    const config = stripMaskedAIConfig(rawConfig);
    const result = await saveAIConfig(db, config, revision);
    return { revision: result.revision };
  });
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/ai/models/:id/catalog",
    async (req) => {
      admin(req);
      const config = await aiConfig(db),
        model = config.models.find((m) => m.id === req.params.id);
      if (!model || (!model.apiKey && model.provider !== "ollama"))
        fail(400, "请先保存供应商配置与凭据");
      return discoverAIModels(model, options.fetch);
    },
  );
  api.post<{ Params: { id: string } }>(
    "/api/v1/admin/ai/models/:id/test",
    async (req) => {
      const actor = admin(req),
        config = await aiConfig(db),
        model = config.models.find((m) => m.id === req.params.id);
      if (!model || (!model.apiKey && model.provider !== "ollama"))
        fail(400, "请先保存模型凭据");
      const stamp = new Date().toISOString(),
        callId = randomUUID();
      try {
        let detectedApiMode: "chat" | "responses" | undefined;
        let detectedRevision = config.revision;
        let imageTest = false;
        const result = model.embedding
          ? await testAIEmbeddingModel(model, options.fetch)
          : model.imageGeneration && !model.tools
            ? ((imageTest = true), await testAIImageModel(model, options.fetch))
          : await testAIModel(model, options.fetch, (mode) => {
              detectedApiMode = mode;
            });

        // Model list metadata is optional. Some providers expose context and
        // output limits there, while others only expose the inference API.
        // A missing /models endpoint must not make a successful connection test fail.
        let detectedLimits: { maxInput?: number; maxOutput?: number } = {};
        if (!model.embedding && !imageTest) {
          try {
            const catalog = await discoverAIModels(model, options.fetch);
            detectedLimits =
              catalog.models.find((item: any) => item.id === model.model) ?? {};
          } catch {
            // The connection test itself is authoritative; limits are best effort.
          }
        }
        let testedModel = model;
        if (
          detectedApiMode ||
          detectedLimits.maxInput ||
          detectedLimits.maxOutput
        ) {
          const latest = await aiConfig(db);
          const latestModel = latest.models.find((item) => item.id === model.id);
          if (latestModel) {
            const nextModel = {
              ...latestModel,
              ...(detectedApiMode && !latestModel.apiMode
                ? { apiMode: detectedApiMode }
                : {}),
              ...(detectedLimits.maxInput
                ? { maxInput: detectedLimits.maxInput }
                : {}),
              ...(detectedLimits.maxOutput
                ? { maxOutput: detectedLimits.maxOutput }
                : {}),
            };
            const changed =
              nextModel.apiMode !== latestModel.apiMode ||
              nextModel.maxInput !== latestModel.maxInput ||
              nextModel.maxOutput !== latestModel.maxOutput;
            if (changed) {
              const saved = await saveAIConfig(
                db,
                { ...latest, models: latest.models.map((item) =>
                  item.id === model.id ? nextModel : item,
                ) },
                latest.revision,
              );
              detectedRevision = saved.revision;
              testedModel = saved.models.find((item) => item.id === model.id) ?? model;
            }
          }
        }
        const u = (result.usage ?? {}) as any;
        const usage = usageOf(u);
        const { apiKey: _secret, baseUrl: _url, ...safe } = testedModel;
        await db
          .insertInto("ai_calls")
          .values({
            id: callId,
            user_id: actor.id,
            job_id: null,
            model_id: model.id,
            model_snapshot: JSON.stringify(safe),
            periods: JSON.stringify(
              aiPeriods((await entitlementConfig(db)).timezone),
            ),
            state: "site_test",
            input_tokens: u.inputTokens?.total ?? 0,
            output_tokens: u.outputTokens?.total ?? 0,
            cached_tokens: usage?.cached ?? 0,
            points: 0,
            base_points: 0,
            allocations: "[]",
            usage: JSON.stringify(u),
            created_at: stamp,
            updated_at: new Date().toISOString(),
          })
          .execute();
        return {
          ok: true,
          revision: detectedRevision,
          apiMode: detectedApiMode,
          maxInput: detectedLimits.maxInput,
          maxOutput: detectedLimits.maxOutput,
          message: imageTest
            ? "生图接口测试通过；已实际生成一张测试图片，测试用量已记录，不扣用户积分"
            : model.embedding
              ? "向量模型连接与维度校验通过；测试用量已记录，不扣用户积分"
            : `模型连接测试通过；${[
                  detectedApiMode
                    ? `接口协议已识别为${detectedApiMode === "chat" ? " Chat Completions" : " Responses API"}`
                    : "",
                  detectedLimits.maxInput
                    ? `输入上下文 ${detectedLimits.maxInput.toLocaleString()} Token`
                    : "",
                  detectedLimits.maxOutput
                    ? `单次输出 ${detectedLimits.maxOutput.toLocaleString()} Token`
                    : "",
                ]
                  .filter(Boolean)
                  .join("，") || "连接参数有效"}。测试用量已记录，不扣用户积分`,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        const generic = modelConnectionError(error);
        const detail = modelConnectionDetail(error, model);
        fail(502, detail && !generic.includes(detail) ? `${generic}：${detail}` : generic);
      }
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/ai/resources/:id/preview",
    async (req) => previewAIDocument(db, auth(req), req.params.id),
  );
  api.get("/api/v1/ai/usage", async (req) => quotaSummary(db, auth(req).id));
  api.get<{ Querystring: { userId?: string } }>(
    "/api/v1/admin/ai/usage",
    async (req) => {
      admin(req);
      if (req.query.userId) return quotaSummary(db, req.query.userId);
      const calls = await db
        .selectFrom("ai_calls")
        .leftJoin("users", "users.id", "ai_calls.user_id")
        .selectAll("ai_calls")
        .select("users.display_name as userName")
        .orderBy("ai_calls.created_at", "desc")
        .limit(200)
        .execute();
      return {
        calls: calls.map((c) => ({
          ...c,
          points: c.points / 1000,
          base_points: c.base_points / 1000,
          model_snapshot: JSON.parse(c.model_snapshot),
          callKind: JSON.parse(c.model_snapshot).callKind ?? "chat",
          images: c.usage ? (JSON.parse(c.usage).provider?.images ?? 0) : 0,
        })),
      };
    },
  );
  api.post("/api/v1/admin/ai/grants", async (req) => {
    const actor = admin(req),
      body = parse(
        z.object({
          id,
          userId: id,
          amount: z.number().positive().max(1000000000),
          reason: z.string().min(1).max(500),
          expiresAt: z.string().datetime().nullable(),
        }),
        req.body,
      );
    if (body.expiresAt && body.expiresAt <= new Date().toISOString())
      fail(400, "到期时间必须在未来");
    await transact(db, async (tx) => {
      await lockAIUser(tx, body.userId);
      const existing = await tx
        .selectFrom("ai_grants")
        .selectAll()
        .where("id", "=", body.id)
        .executeTakeFirst();
      if (existing) {
        if (
          existing.user_id !== body.userId ||
          existing.amount !== pointUnits(body.amount) ||
          existing.expires_at !== body.expiresAt ||
          existing.reason !== body.reason
        )
          fail(409, "相同发放ID的内容不同");
        return;
      }
      await tx
        .insertInto("ai_grants")
        .values({
          id: body.id,
          user_id: body.userId,
          amount: pointUnits(body.amount),
          remaining: pointUnits(body.amount),
          reason: body.reason,
          actor_id: actor.id,
          expires_at: body.expiresAt,
          created_at: new Date().toISOString(),
        })
        .execute();
    });
    return { ok: true };
  });
  api.post<{ Params: { id: string } }>(
    "/api/v1/admin/ai/calls/:id/reconcile",
    async (req) => {
      admin(req);
      const usage = parse(
        z
          .object({
            input: z.number().int().min(0).max(1000000000),
            output: z.number().int().min(0).max(1000000000),
            cached: z.number().int().min(0).max(1000000000).default(0),
            images: z.number().int().min(0).max(1).optional(),
          })
          .refine((v) => v.cached <= v.input, "缓存 Token 不能超过输入 Token"),
        req.body,
      );
      await transact(db, async (tx) => {
        const c = await tx
          .selectFrom("ai_calls")
          .selectAll()
          .where("id", "=", req.params.id)
          .executeTakeFirstOrThrow();
        await lockAIUser(tx, c.user_id);
        const current = await tx
          .selectFrom("ai_calls")
          .select("state")
          .where("id", "=", c.id)
          .executeTakeFirstOrThrow();
        if (current.state !== "pending") fail(409, "仅待对账用量可以结算");
        const isImage = JSON.parse(c.model_snapshot).callKind === "image";
        if (isImage !== (usage.images !== undefined))
          fail(
            400,
            isImage
              ? "请填写已核对的生成图片数量（0 或 1）"
              : "此记录是对话调用，不能按图片结算",
          );
        await tx
          .updateTable("ai_calls")
          .set({ state: "reserved" })
          .where("id", "=", c.id)
          .execute();
        await settleCall(
          tx,
          c.id,
          {
            ...usage,
            raw:
              usage.images === undefined ? undefined : { images: usage.images },
          },
          "reconciled",
        );
      });
      return { ok: true };
    },
  );
  api.put("/api/v1/ai/preferences", async (req) => {
    const actor = auth(req),
      p = parse(
        z.object({
          defaultModel: z.string().max(64).nullable(),
          memoryEnabled: z.boolean(),
        }),
        req.body,
      );
    if (p.defaultModel) await requireModel(db, actor.id, p.defaultModel);
    await aiUser(db, actor.id);
    await db
      .updateTable("ai_users")
      .set({
        default_model: p.defaultModel,
        memory_enabled: Number(p.memoryEnabled),
      })
      .where("user_id", "=", actor.id)
      .execute();
    return { ok: true };
  });
  api.get("/api/v1/ai/memory", async (req) => {
    const actor = auth(req),
      prefs = await aiUser(db, actor.id),
      m = await runner.memory();
    const threadId = "preferences-" + actor.id;
    return {
      text:
        (await m.memory.getWorkingMemory({
          threadId,
          resourceId: memoryOwner(actor.id),
          memoryConfig: { workingMemory: { enabled: true, scope: "resource" } },
        })) ?? "",
      revision: prefs.memory_revision,
    };
  });
  api.put("/api/v1/ai/memory", async (req) => {
    const actor = auth(req),
      body = parse(
        z.object({
          text: z.string().max(8000),
          revision: z.number().int().min(0),
        }),
        req.body,
      );
    const prefs = await aiUser(db, actor.id);
    if (prefs.memory_revision !== body.revision)
      fail(409, "偏好已变化，请刷新");
    if (body.text && !(await aiConfig(db)).memoryEnabled)
      fail(403, "管理员未启用长期记忆");
    const m = await runner.memory(),
      threadId = "preferences-" + actor.id;
    if (
      !(await m.memory.getThreadById({
        threadId,
        resourceId: memoryOwner(actor.id),
      }))
    )
      await m.memory.createThread({
        threadId,
        resourceId: memoryOwner(actor.id),
        title: "个人偏好",
      });
    // Serialize updates across requests with a database-owned revision/lock.
    await transact(db, async (tx) => {
      await lockAIUser(tx, actor.id);
      const current = await tx
        .selectFrom("ai_users")
        .selectAll()
        .where("user_id", "=", actor.id)
        .executeTakeFirstOrThrow();
      if (current.memory_revision !== body.revision)
        fail(409, "偏好已变化，请刷新");
      await m.memory.updateWorkingMemory({
        threadId,
        resourceId: memoryOwner(actor.id),
        workingMemory: body.text,
        memoryConfig: { workingMemory: { enabled: true, scope: "resource" } },
      });
      await tx
        .updateTable("ai_users")
        .set({ memory_revision: body.revision + 1 })
        .where("user_id", "=", actor.id)
        .execute();
    });
    return { revision: body.revision + 1 };
  });
  api.get("/api/v1/ai/note", async (req) => {
    const actor = auth(req);
    return readNote(db, actor.id);
  });
  api.put("/api/v1/ai/note", async (req) => {
    const actor = auth(req),
      body = parse(
        z.object({ content: z.string().max(noteLimit) }),
        req.body,
      );
    return writeNote(db, actor.id, body.content);
  });
  api.get("/api/v1/ai/secrets", async (req) => {
    const actor = auth(req);
    return { items: await listSecrets(db, actor.id) };
  });
  api.put("/api/v1/ai/secrets", async (req) => {
    const actor = auth(req),
      body = parse(
        z.object({
          key: z.string().min(1).max(64),
          value: z.string().min(1).max(4000),
        }),
        req.body,
      );
    return writeSecret(db, actor.id, body.key, body.value);
  });
  api.delete("/api/v1/ai/secrets/:key", async (req) => {
    const actor = auth(req);
    return deleteSecret(
      db,
      actor.id,
      decodeURIComponent((req.params as { key: string }).key),
    );
  });
  api.get<{ Querystring: { resourceId?: string; archived?: string } }>(
    "/api/v1/ai/sessions",
    async (req) => {
      const actor = auth(req);
      let query = db
        .selectFrom("ai_sessions")
        .selectAll()
        .where("user_id", "=", actor.id)
        .where("archived", "=", req.query.archived === "true" ? 1 : 0);
      if (req.query.resourceId)
        query = query.where(
          "resource_ids",
          "like",
          `%"${parse(id, req.query.resourceId)}"%`,
        );
      const rows = await query
        .orderBy("updated_at", "desc")
        .limit(200)
        .execute();
      const safe = [];
      const activeJobs = await db
        .selectFrom("ai_jobs")
        .select(["session_id", "status"])
        .where("user_id", "=", actor.id)
        .where("status", "in", ["queued", "running", "awaiting_approval"])
        .execute();
      const runningSessions = new Set(
        activeJobs
          .filter((job) => job.status !== "awaiting_approval")
          .map((job) => job.session_id),
      );
      const latestAt = rows.length
        ? await db
            .selectFrom("ai_jobs")
            .select(({ fn }) => [
              "session_id",
              fn.max("created_at").as("created_at"),
            ])
            .where("user_id", "=", actor.id)
            .where(
              "session_id",
              "in",
              rows.map((row) => row.id),
            )
            .groupBy("session_id")
            .execute()
        : [];
      const latestJobs = latestAt.length
        ? await db
            .selectFrom("ai_jobs")
            .select([
              "session_id",
              "status",
              "cancelled",
              "created_at",
              "updated_at",
            ])
            .where("user_id", "=", actor.id)
            .where((eb) =>
              eb.or(
                latestAt.map((row) =>
                  eb.and([
                    eb("session_id", "=", row.session_id),
                    eb("created_at", "=", row.created_at),
                  ]),
                ),
              ),
            )
            .execute()
        : [];
      const latestJobBySession = new Map<string, (typeof latestJobs)[number]>();
      for (const job of latestJobs)
        if (!latestJobBySession.has(job.session_id))
          latestJobBySession.set(job.session_id, job);
      for (const row of rows) {
        if (
          req.query.resourceId &&
          !JSON.parse(row.resource_ids).includes(req.query.resourceId)
        )
          continue;
        try {
          await sessionSources(db, actor.id, row);
          safe.push({
            ...row,
            running: runningSessions.has(row.id),
            awaitingApproval: activeJobs.some(
              (job) =>
                job.session_id === row.id && job.status === "awaiting_approval",
            ),
            executionFailed: (() => {
              const job = latestJobBySession.get(row.id);
              // A newer user message updates the session before its queued job
              // runs. That message supersedes any previous failure badge.
              return !!job &&
                job.updated_at >= row.updated_at &&
                (["failed", "interrupted"].includes(job.status) ||
                  (job.status === "cancelled" && job.cancelled === 0));
            })(),
          });
        } catch {
          safe.push({
            ...row,
            title: "来源已不可用的会话",
            resource_ids: "[]",
            mentioned_resource_ids: "[]",
            approved_resource_ids: "[]",
            restricted: true,
          });
        }
      }
      return safe;
    },
  );
  api.post("/api/v1/ai/sessions", async (req) => {
    const actor = auth(req),
      body = parse(
        z.object({
          title: z.string().max(100).default("新对话"),
          modelId: z.string().nullable().optional(),
          resourceIds: z.array(id).max(30).default([]),
        }),
        req.body,
      );
    for (const r of body.resourceIds) await authorize(db, actor, r, 1);
    if (body.modelId) await requireModel(db, actor.id, body.modelId);
    const now = new Date().toISOString(),
      row = {
        id: randomUUID(),
        user_id: actor.id,
        title: body.title,
        model_id: body.modelId ?? null,
        resource_ids: JSON.stringify(body.resourceIds),
        archived: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      };
    await db.insertInto("ai_sessions").values(row).execute();
    await runner.ensureThread(row);
    return row;
  });
  api.get<{ Params: { id: string }; Querystring: { page?: string } }>(
    "/api/v1/ai/sessions/:id",
    async (req) => {
      const actor = auth(req),
        s = await session(actor, req.params.id),
        m = await runner.ensureThread(s);
      const history = await m.memory.recall({
        threadId: s.id,
        resourceId: memoryOwner(actor.id),
        perPage: 24,
        page: parse(
          z.coerce.number().int().min(0).max(100000),
          req.query.page ?? 0,
        ),
        orderBy: { field: "createdAt", direction: "DESC" },
      });
      const jobs = await db
        .selectFrom("ai_jobs")
        .select([
          "id",
          "status",
          "error",
          "created_at",
          "updated_at",
          "model_id",
          "result",
        ])
        .where("session_id", "=", s.id)
        .where((eb) =>
          eb.or([
            ...(history.messages.length
              ? [
                  eb(
                    "id",
                    "in",
                    history.messages.map((message) =>
                      message.id.replace(/-answer$/, ""),
                    ),
                  ),
                ]
              : []),
            eb("status", "in", ["queued", "running", "awaiting_approval"]),
            eb(
              "id",
              "in",
              db
                .selectFrom("ai_jobs")
                .select("id")
                .where("session_id", "=", s.id)
                .orderBy("created_at", "desc")
                .limit(30),
            ),
          ]),
        )
        .orderBy("created_at", "desc")
        .execute();
      const userMessageIds = history.messages
        .filter((message) => message.role === "user")
        .map((message) => message.id);
      const jobInputs = userMessageIds.length
        ? await db
            .selectFrom("ai_jobs")
            .select(["id", "input"])
            .where("id", "in", userMessageIds)
            .execute()
        : [];
      const explorerByMessage = new Map(
        jobInputs.map((job) => {
          let files: unknown = [];
          try {
            files = JSON.parse(job.input).files;
          } catch {
            files = [];
          }
          return [job.id, explorerTargets(files)] as const;
        }),
      );
      const operations = jobs.length
        ? await db
            .selectFrom("ai_operations")
            .select(["id", "job_id", "result", "created_at"])
            .where(
              "job_id",
              "in",
              jobs.map((j) => j.id),
            )
            .execute()
        : [];
      const linkedIds: string[] = JSON.parse(s.resource_ids);
      const resources = linkedIds.length
        ? await db
            .selectFrom("resources")
            .select(["id", "title", "format", "kind"])
            .where("id", "in", linkedIds)
            .where("deleted_at", "is", null)
            .execute()
        : [];
      return {
        session: s,
        resources,
        messages: [...history.messages]
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
          .map((x) => ({
            id: x.id,
            role: x.role,
            text: messageText(x),
            reasoning: messageReasoning(x),
            references: x.content.metadata?.references ?? [],
            attachments: x.content.metadata?.attachments ?? [],
            explorer: (() => {
              const saved = explorerTargets(x.content.metadata?.explorer);
              return saved.length ? saved : explorerByMessage.get(x.id) ?? [];
            })(),
            quickNotes: x.content.metadata?.quickNotes ?? [],
            createdAt: x.createdAt,
          })),
        hasMore: history.hasMore,
        contextTokens: jobs.length
          ? (
              await db
                .selectFrom("ai_calls")
                .select("input_tokens")
                .where(
                  "job_id",
                  "in",
                  jobs.map((j) => j.id),
                )
                .where("input_tokens", ">", 0)
                .orderBy("created_at", "desc")
                .executeTakeFirst()
            )?.input_tokens ?? null
          : null,
        jobs: jobs.map(({ result, ...job }) => ({
          ...job,
          progress: result ? JSON.parse(result).progress : undefined,
        })),
        operations: operations.map((o) => ({
          ...o,
          result: JSON.parse(o.result),
        })),
      };
    },
  );
  // The job remains owned by the background runner. Disconnecting a viewer never cancels it.
  // Short-lived streams reauthenticate periodically, and each update rechecks resource permissions.
  const streams = new Set<() => void>();
  api.addHook("preClose", async () => {
    for (const close of streams) close();
  });
  api.get<{ Params: { id: string } }>(
    "/api/v1/ai/sessions/:id/stream",
    async (req, reply) => {
      const actor = auth(req);
      await session(actor, req.params.id);
      await requireCapability(db, actor.id, "ai.create");
      const { Readable } = await import("node:stream");
      let closed = false,
        busy = false;
      const previous = new Map<
        string,
        { status: string; result: string; progress?: AIProgress }
      >();
      const output = new Readable({ read() {} });
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearTimeout(timeout);
        streams.delete(close);
        output.push(null);
      };
      const send = (event: string, data: unknown) =>
        output.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const tick = async () => {
        if (closed || busy || output.readableLength > 256000) return;
        busy = true;
        try {
          await session(actor, req.params.id);
          await requireCapability(db, actor.id, "ai.create");
          const jobs = await db
            .selectFrom("ai_jobs")
            .select(["id", "status", "result", "error", "created_at"])
            .where("session_id", "=", req.params.id)
            .orderBy("created_at", "desc")
            .limit(30)
            .execute();
          for (const { result, ...job } of jobs) {
            const old = previous.get(job.id);
            if (old?.status === job.status && old?.result === result) continue;
            const progress: AIProgress | undefined = result
              ? JSON.parse(result).progress
              : undefined;
            if (!closed)
              send("job", {
                ...job,
                progress: progress
                  ? progressPatch(old?.progress, progress)
                  : undefined,
              });
            previous.set(job.id, { status: job.status, result, progress });
          }
        } catch {
          if (!closed) send("revoked", {});
          close();
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => void tick(), 250);
      const timeout = setTimeout(close, 60000);
      streams.add(close);
      output.on("close", close);
      req.raw.on("aborted", close);
      reply.raw.on("close", close);
      output.push(": connected\n\n");
      void tick();
      return reply
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache, no-transform")
        .header("X-Accel-Buffering", "no")
        .send(output);
    },
  );
  api.patch<{ Params: { id: string } }>(
    "/api/v1/ai/sessions/:id",
    async (req) => {
      const actor = auth(req),
        s = await session(actor, req.params.id, false),
        body = parse(
          z.object({
            title: z.string().min(1).max(100).optional(),
            archived: z.boolean().optional(),
            modelId: z.string().optional(),
          }),
          req.body,
        );
      if (body.modelId) await requireModel(db, actor.id, body.modelId);
      await db
        .updateTable("ai_sessions")
        .set({
          ...(body.title ? { title: body.title } : {}),
          ...(body.archived !== undefined
            ? { archived: Number(body.archived) }
            : {}),
          ...(body.modelId ? { model_id: body.modelId } : {}),
          revision: s.revision + 1,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", s.id)
        .execute();
      return { ok: true };
    },
  );
  api.post("/api/v1/ai/sessions/batch", async (req) => {
    const actor = auth(req),
      body = parse(
        z.object({
          ids: z.array(id).min(1).max(200),
          archived: z.boolean(),
        }),
        req.body,
      );
    const result = await db
      .updateTable("ai_sessions")
      .set((eb) => ({
        archived: Number(body.archived),
        revision: eb("revision", "+", 1),
        updated_at: new Date().toISOString(),
      }))
      .where("user_id", "=", actor.id)
      .where("id", "in", body.ids)
      .executeTakeFirst();
    return { updated: Number(result.numUpdatedRows ?? 0) };
  });
  api.delete<{ Params: { id: string } }>(
    "/api/v1/ai/sessions/:id",
    async (req) => {
      const actor = auth(req),
        s = await session(actor, req.params.id, false);
      const m = await runner.memory();
      await transact(db, async (tx) => {
        await lockAIUser(tx, actor.id);
        if (
          await tx
            .selectFrom("ai_jobs")
            .select("id")
            .where("session_id", "=", s.id)
            .where("status", "in", ["running", "queued", "awaiting_approval"])
            .executeTakeFirst()
        )
          fail(409, "请先停止该会话的运行任务");
        await m.memory.deleteThread(s.id);
        await tx.deleteFrom("ai_jobs").where("session_id", "=", s.id).execute();
        await tx.deleteFrom("ai_sessions").where("id", "=", s.id).execute();
      });
      return { ok: true };
    },
  );
  api.post<{ Params: { id: string } }>(
    "/api/v1/ai/sessions/:id/messages",
    async (req) => {
      const actor = auth(req),
        s = await session(actor, req.params.id),
        body = parse(
          z.object({
            id,
            text: z.string().trim().min(1).max(20000),
            modelId: z.string(),
            scope: z.enum(["document", "all"]),
            currentResourceId: id.optional(),
            currentMailboxId: id.optional(),
            currentMessageId: z.string().min(1).max(160).optional(),
            references: z
              .array(
                z.object({
                  resourceId: id,
                  anchor: z.any().optional(),
                  label: z.string().max(300).optional(),
                  format: z.string().max(30).optional(),
                  description: z.string().max(300).optional(),
                  epochId: z.string().optional(),
                  seq: z.number().int().optional(),
                }),
              )
              .max(20)
              .default([]),
            attachments: z.array(id).max(8).default([]),
            files: z
              .array(
                z.object({
                  kind: z.enum(["file", "folder"]),
                  id: z.string().min(1).max(80),
                  name: z.string().max(255).optional(),
                }),
              )
              .max(20)
              .default([]),
            quickNoteIds: z.array(id).max(20).default([]),
            skillIds: z.array(z.string().max(100)).max(20).default([]),
            webSearch: z.boolean().default(true),
            skipApprovals: z
              .object({
                create: z.boolean().optional(),
                delete: z.boolean().optional(),
                modify: z.boolean().optional(),
              })
              .optional(),
            retryOf: id.optional(),
          }),
          req.body,
        );
      if (s.archived) fail(409, "请先恢复归档会话");
      if (body.retryOf) {
        const previous = await db
          .selectFrom("ai_jobs")
          .selectAll()
          .where("id", "=", body.retryOf)
          .where("user_id", "=", actor.id)
          .where("session_id", "=", s.id)
          .executeTakeFirst();
        if (!previous) fail(404, "原任务不存在");
        if (!["failed", "interrupted", "cancelled"].includes(previous.status))
          fail(409, "只能重试失败、停止或中断的任务");
        const original = JSON.parse(previous.input);
        if (!original.text) fail(409, "原任务要求已不可用，请重新发送");
        Object.assign(body, {
          text: original.text,
          scope: original.scope,
          currentResourceId: original.currentResourceId,
          currentMailboxId: original.currentMailboxId,
          currentMessageId: original.currentMessageId,
          references: original.references ?? [],
          attachments: original.attachments ?? [],
          files: original.files ?? [],
          quickNoteIds: original.quickNoteIds ?? [],
          skillIds: original.skillIds ?? [],
          webSearch: original.webSearch ?? true,
          skipApprovals: original.skipApprovals,
        });
      }
      if (body.currentResourceId)
        await authorize(db, actor, body.currentResourceId, 1);
      const { model, config } = await requireModel(db, actor.id, body.modelId);
      const media = config.mediaModel
        ? config.models.find((item) => item.id === config.mediaModel)
        : undefined;
      await checkAttachments(db, actor.id, body.attachments, model, media);
      await checkQuickNoteIds(db, actor.id, body.quickNoteIds);
      for (const ref of body.references) {
        const r = await readAIDocument(
          db,
          { actor },
          ref.resourceId,
          ref.anchor,
        );
        if (ref.epochId && ref.epochId !== r.epochId)
          fail(409, "引用已失效，请重新选择");
      }
      // Older conversations predate the explicit mention registry. Recover only
      // user-supplied references, never documents the model discovered on its own.
      let historicalMentions: string[] = [];
      if (s.mentioned_resource_ids === "[]" || !s.mentioned_resource_ids) {
        const memory = await runner.memory();
        const history = await memory.memory.recall({
          threadId: s.id,
          resourceId: memoryOwner(actor.id),
          perPage: 24,
          page: 0,
          orderBy: { field: "createdAt", direction: "DESC" },
        });
        historicalMentions = history.messages
          .filter((m) => m.role === "user")
          .flatMap(
            (m) =>
              (m.content.metadata?.references ?? []) as {
                resourceId: string;
              }[],
          )
          .map((r) => r.resourceId)
          .filter((id) => typeof id === "string");
      }
      const { id: jobId, modelId, ...input } = body,
        hash = digest({ session: s.id, modelId, input });
      const job = await transact(db, async (tx) => {
        await lockAIUser(tx, actor.id);
        const currentSession = await tx
          .selectFrom("ai_sessions")
          .selectAll()
          .where("id", "=", s.id)
          .executeTakeFirst();
        if (!currentSession || currentSession.archived)
          fail(409, "会话已删除或归档");
        const old = await tx
          .selectFrom("ai_jobs")
          .selectAll()
          .where("id", "=", jobId)
          .executeTakeFirst();
        if (old) {
          if (old.user_id !== actor.id || old.digest !== hash)
            fail(409, "重复发送内容不同");
          return old;
        }
        if (body.retryOf) {
          const ongoing = await tx
            .selectFrom("ai_jobs")
            .selectAll()
            .where("user_id", "=", actor.id)
            .where("digest", "=", hash)
            .where("status", "in", [
              "queued",
              "running",
              "awaiting_approval",
              "completed",
            ])
            .executeTakeFirst();
          if (ongoing) return ongoing;
        }
        const pending = await tx
          .selectFrom("ai_jobs")
          .select("id")
          .where("user_id", "=", actor.id)
          .where("status", "in", ["running", "queued", "awaiting_approval"])
          .execute();
        if (pending.length >= 5) fail(429, "待处理任务过多，请等待或取消");
        const now = new Date().toISOString();
        const row = {
          id: jobId,
          session_id: s.id,
          user_id: actor.id,
          model_id: modelId,
          status: "queued",
          input: JSON.stringify(input),
          digest: hash,
          result: "",
          error: "",
          lease: null,
          lease_until: null,
          attempts: 0,
          cancelled: 0,
          created_at: now,
          updated_at: now,
        };
        await tx.insertInto("ai_jobs").values(row).execute();
        await tx
          .updateTable("ai_sessions")
          .set({
            model_id: modelId,
            mentioned_resource_ids: JSON.stringify([
              ...new Set([
                ...JSON.parse(currentSession.mentioned_resource_ids ?? "[]"),
                ...historicalMentions,
                ...body.references.map((r) => r.resourceId),
              ]),
            ]),
            resource_ids: JSON.stringify([
              ...new Set([
                ...JSON.parse(currentSession.resource_ids),
                ...(body.currentResourceId ? [body.currentResourceId] : []),
                ...body.references.map((r) => r.resourceId),
              ]),
            ]),
            title:
              currentSession.title === "新对话"
                ? body.text.slice(0, 40)
                : currentSession.title,
            updated_at: now,
          })
          .where("id", "=", s.id)
          .execute();
        return row;
      });
      void runner.pump().catch(() => {});
      return { id: job.id, status: job.status };
    },
  );
  api.post<{ Params: { id: string } }>(
    "/api/v1/ai/jobs/:id/approval",
    async (req) => {
      const actor = auth(req);
      const body = parse(
        z.object({ approvalId: id, approved: z.boolean() }).strict(),
        req.body,
      );
      const job = await transact(db, async (tx) => {
        await lockAIUser(tx, actor.id);
        const current = await tx
          .selectFrom("ai_jobs")
          .selectAll()
          .where("id", "=", req.params.id)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        if (!current) fail(404, "任务不存在");
        const result = JSON.parse(current.result || "{}");
        const approval = result.progress?.approvals?.find(
          (a: any) => a.id === body.approvalId,
        );
        if (!approval) fail(404, "审批项不存在");
        const decision = body.approved ? "approved" : "rejected";
        if (approval.state === decision) return current;
        if (
          current.status !== "awaiting_approval" ||
          current.cancelled ||
          approval.state !== "pending"
        )
          fail(409, "审批已处理或任务已停止");
        if (body.approved && approval.action === "access") {
          await authorize(tx, actor, approval.resourceId, 1);
          const session = await tx
            .selectFrom("ai_sessions")
            .selectAll()
            .where("id", "=", current.session_id)
            .where("user_id", "=", actor.id)
            .executeTakeFirstOrThrow();
          await tx
            .updateTable("ai_sessions")
            .set({
              approved_resource_ids: JSON.stringify([
                ...new Set([
                  ...JSON.parse(session.approved_resource_ids ?? "[]"),
                  approval.resourceId,
                ]),
              ]),
              resource_ids: JSON.stringify([
                ...new Set([
                  ...JSON.parse(session.resource_ids),
                  approval.resourceId,
                ]),
              ]),
            })
            .where("id", "=", session.id)
            .execute();
        }
        approval.state = decision;
        approval.resolvedAt = new Date().toISOString();
        const waiting = result.progress.approvals.some(
          (a: any) => a.state === "pending",
        );
        const status = !body.approved
          ? "cancelled"
          : waiting
            ? "awaiting_approval"
            : "queued";
        result.progress.phase = !body.approved
          ? "用户已拒绝操作"
          : waiting
            ? "等待其余操作审批"
            : "审批通过，继续执行";
        await tx
          .updateTable("ai_jobs")
          .set({
            status,
            cancelled: body.approved ? 0 : 1,
            result: JSON.stringify(result),
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", current.id)
          .execute();
        return { ...current, status };
      });
      if (job.status === "queued") void runner.pump().catch(() => {});
      return { id: job.id, status: job.status };
    },
  );
  api.post<{ Params: { id: string } }>(
    "/api/v1/ai/jobs/:id/cancel",
    async (req) => {
      const actor = auth(req),
        r = await transact(db, async (tx) => {
          await lockAIUser(tx, actor.id);
          return tx
            .updateTable("ai_jobs")
            .set({ cancelled: 1 })
            .where("id", "=", req.params.id)
            .where("user_id", "=", actor.id)
            .where("status", "in", ["queued", "running", "awaiting_approval"])
            .returningAll()
            .executeTakeFirst();
        });
      if (r) {
        runner.cancel(r.id);
        if (["queued", "awaiting_approval"].includes(r.status))
          await db
            .updateTable("ai_jobs")
            .set({ status: "cancelled" })
            .where("id", "=", r.id)
            .where("status", "in", ["queued", "awaiting_approval"])
            .execute();
      }
      return { ok: true };
    },
  );
  api.get("/api/v1/ai/skills", async (req) => {
    const actor = auth(req);
    return {
      official: (
        (await aiConfig(db)).officialSkills ?? defaultOfficialSkills
      ).filter((s) => s.enabled),
      personal: await db
        .selectFrom("ai_skills")
        .selectAll()
        .where("user_id", "=", actor.id)
        .orderBy("updated_at", "desc")
        .execute(),
    };
  });
  api.put<{ Params: { id: string } }>("/api/v1/ai/skills/:id", async (req) => {
    const actor = auth(req),
      skillId = parse(id, req.params.id),
      body = parse(
        z.object({
          name: z.string().min(1).max(80),
          description: z.string().min(1).max(300),
          content: z.string().min(1).max(12000),
          formats: z.array(z.string()).max(5),
          enabled: z.boolean(),
          revision: z.number().int().min(0),
        }),
        req.body,
      );
    await transact(db, async (tx) => {
      await lockAIUser(tx, actor.id);
      const old = await tx
        .selectFrom("ai_skills")
        .selectAll()
        .where("id", "=", skillId)
        .executeTakeFirst();
      if (old && (old.user_id !== actor.id || old.revision !== body.revision))
        fail(409, "Skill 已变化或无权修改");
      const row = {
        id: skillId,
        user_id: actor.id,
        name: body.name,
        description: body.description,
        content: body.content,
        formats: JSON.stringify(body.formats),
        enabled: Number(body.enabled),
        revision: body.revision + 1,
        updated_at: new Date().toISOString(),
      };
      if (old)
        await tx
          .updateTable("ai_skills")
          .set(row)
          .where("id", "=", skillId)
          .execute();
      else await tx.insertInto("ai_skills").values(row).execute();
    });
    return { ok: true };
  });
  api.delete<{ Params: { id: string } }>(
    "/api/v1/ai/skills/:id",
    async (req) => {
      await db
        .deleteFrom("ai_skills")
        .where("id", "=", req.params.id)
        .where("user_id", "=", auth(req).id)
        .execute();
      return { ok: true };
    },
  );
  api.get("/api/v1/ai/mcp-keys", async (req) =>
    db
      .selectFrom("ai_mcp_keys")
      .select([
        "id",
        "name",
        "resource_ids",
        "writable",
        "expires_at",
        "created_at",
      ])
      .where("user_id", "=", auth(req).id)
      .execute(),
  );
  api.post("/api/v1/ai/mcp-keys", async (req) => {
    const actor = auth(req),
      body = parse(
        z.object({
          name: z.string().min(1).max(80),
          resourceIds: z.array(id).min(1).max(50),
          writable: z.boolean(),
          days: z.number().int().min(1).max(365),
        }),
        req.body,
      );
    if (body.writable) await requireCapability(db, actor.id, "mcp.write");
    for (const r of body.resourceIds)
      await authorize(db, actor, r, body.writable ? 3 : 1);
    const token = "doca_mcp_" + randomBytes(32).toString("hex"),
      keyId = randomUUID();
    await db
      .insertInto("ai_mcp_keys")
      .values({
        id: keyId,
        user_id: actor.id,
        name: body.name,
        token_hash: tokenHash(token),
        resource_ids: JSON.stringify(body.resourceIds),
        writable: Number(body.writable),
        expires_at: new Date(Date.now() + body.days * 86400000).toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();
    return { id: keyId, token };
  });
  api.delete<{ Params: { id: string } }>(
    "/api/v1/ai/mcp-keys/:id",
    async (req) => {
      await db
        .deleteFrom("ai_mcp_keys")
        .where("id", "=", req.params.id)
        .where("user_id", "=", auth(req).id)
        .execute();
      return { ok: true };
    },
  );
  await registerAIMcp(api, db, options.notify, options.search);
  return runner;
}
