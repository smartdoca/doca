import { defaultOfficialSkills } from "./skills.js";
import { z } from "zod";
import { sql } from "kysely";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { requireCapability } from "../access/operation-policy.js";
import { aiProviders, embeddingSource } from "./providers.js";
import { defaultImageProfile, imageProfileForModel, imageOperations, validImageSize, type ImageOperation } from "./image-model-catalog.js";

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && !value.trim() ? undefined : value;
}
function isServiceUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
const optionalServiceUrl = z.preprocess(
  emptyToUndefined,
  z.string().max(2000).refine(isServiceUrl, "服务地址无效").optional(),
);
const requiredServiceUrl = z
  .string()
  .max(2000)
  .refine(isServiceUrl, "服务地址无效");
const usageRate = z
  .number()
  .min(0)
  .max(1000)
  .refine(
    (value) =>
      Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 0.000001,
    "Token 速率最多六位小数",
  );
const webFetchSchema = z
  .object({
    provider: z.enum(["builtin", "firecrawl", "jina", "tavily"]),
    baseUrl: optionalServiceUrl,
    apiKey: z.string().max(8000).nullable().optional(),
  })
  .strict();
export const modelSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    vendorId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    provider: z.enum(aiProviders.map((p) => p.id)).optional(),
    apiMode: z.enum(["chat", "responses"]).optional(),
    apiVersion: z.string().max(60).optional(),
    vision: z.boolean().optional(),
    pdf: z.boolean().optional(),
    imageGeneration: z.boolean().optional(),
    imageProfile: z.string().max(160).optional(),
    embedding: z.boolean().optional(),
    embeddingApi: z.enum(["openai", "doubao-multimodal"]).optional(),
    embeddingDimensions: z.number().int().min(1).max(65536).optional(),
    imageSize: z
      .string()
      .regex(/^\d{2,4}x\d{2,4}$/)
      .optional(),
    model: z.string().trim().min(1).max(160),
    alias: z.string().trim().max(80),
    baseUrl: requiredServiceUrl,
    apiKey: z.string().max(8000).nullable(),
    enabled: z.boolean(),
    inputRate: usageRate.optional(),
    outputRate: usageRate.optional(),
    imageRate: z.number().int().min(0).max(1000000000).optional(),
    maxInput: z.number().int().min(1000).max(10000000),
    maxOutput: z.number().int().min(32).max(1000000),
    tools: z.boolean(),
  })
  .strict();
export const vendorSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().trim().min(1).max(80),
    provider: z.enum(aiProviders.map((p) => p.id)),
    baseUrl: requiredServiceUrl,
    apiKey: z.string().max(8000).nullable(),
    apiVersion: z.string().max(60).optional(),
    enabled: z.boolean(),
  })
  .strict();
const linkedModelSchema = modelSchema
  .omit({ provider: true, baseUrl: true, apiKey: true, apiVersion: true })
  .extend({
    vendorId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    inputRate: usageRate.default(1),
    outputRate: usageRate.default(1),
    imageRate: z.number().int().min(0).max(1000000000).default(1),
  });
export const aiConfigSchema = z
  .object({
    display: z.enum(["real", "alias"]),
    defaultModel: z.string().max(64),
    imageModel: z.string().max(64).optional(),
    imageToolModels: z.object({
      generate: z.string().max(64).optional(),
      reference: z.string().max(64).optional(),
      edit: z.string().max(64).optional(),
    }).strict().optional(),
    mediaModel: z.string().max(64).optional(),
    memoryEnabled: z.boolean(),
    historyRounds: z.number().int().min(1).max(50),
    maxSteps: z.number().int().min(1).max(100),
    webSearch: z
      .object({
        provider: z.enum(["tavily", "brave", "searxng"]),
        apiKey: z.string().max(8000).nullable(),
        baseUrl: optionalServiceUrl,
      })
      .strict()
      .optional(),
    webFetch: webFetchSchema.optional(),
    vendors: z.array(vendorSchema).max(50).optional(),
    models: z.array(linkedModelSchema).max(50),
    officialSkills: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            name: z.string().trim().min(1).max(80),
            description: z.string().trim().min(1).max(500),
            content: z.string().trim().min(1).max(12000),
            formats: z
              .array(
                z.enum([
                  "rich_text",
                  "markdown",
                  "spreadsheet",
                  "canvas",
                  "presentation",
                ]),
              )
              .max(5),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict();
export type AIVendor = z.infer<typeof vendorSchema>;
export type AIConfig = Omit<
  z.infer<typeof aiConfigSchema>,
  "models" | "vendors"
> & { models: AIModel[]; vendors: AIVendor[] };
export type AIModel = z.infer<typeof modelSchema>;
export function modelUsageRates(
  model: Pick<AIModel, "inputRate" | "outputRate" | "imageRate">,
) {
  return {
    input: model.inputRate ?? 1,
    output: model.outputRate ?? 1,
    image: model.imageRate ?? 1,
  };
}
export const aiDefaults: AIConfig = {
  display: "alias",
  defaultModel: "",
  memoryEnabled: true,
  historyRounds: 6,
  maxSteps: 12,
  models: [],
  vendors: [],
  officialSkills: defaultOfficialSkills,
  webFetch: { provider: "builtin", apiKey: null },
};
export async function aiConfig(db: DB) {
  const row = await db
    .selectFrom("account_settings")
    .selectAll()
    .where("id", "=", "ai")
    .executeTakeFirst();
  return {
    ...resolveConfig(
      aiConfigSchema.parse({
        ...aiDefaults,
        ...existingImageDefaults(row ? JSON.parse(row.config) : {}),
      }),
    ),
    revision: row?.revision ?? 0,
  };
}
// Old image settings receive one explicit profile/default size. No legacy
// protocol remains in execution, and the actual deployment ID stays intact.
function existingImageDefaults(input: Record<string, any>) {
  if (!Array.isArray(input.models)) return input;
  return { ...input, models: input.models.map((value: Record<string, any>) => {
    const { imageEditApi: _discarded, ...model } = value;
    if (!model.imageGeneration || model.imageProfile) return model;
    const vendor = input.vendors?.find((item: Record<string, any>) => item.id === model.vendorId);
    const profile = defaultImageProfile(vendor?.provider, model.model);
    return profile ? { ...model, imageProfile: profile.id, imageSize: profile.defaultSize } : model;
  }) };
}
// Stored models reference vendors; resolved credentials exist only on the server.
function resolveConfig(input: z.infer<typeof aiConfigSchema>): AIConfig {
  const vendors = (input.vendors ?? []).map((v) => ({ ...v }));
  const models = input.models.map((m) => {
    const vendor = vendors.find((v) => v.id === m.vendorId);
    if (!vendor) fail(400, "模型所属厂商不存在，请先移除或转移旗下模型");
    return {
      ...m,
      vendorId: vendor.id,
      provider: vendor.provider,
      baseUrl: vendor.baseUrl,
      apiKey: vendor.apiKey,
      apiVersion: vendor.apiVersion,
    } as AIModel;
  });
  return {
    ...input,
    // Personal memory is a platform capability. Users may opt out in their
    // own AI preferences, but administrators cannot disable it globally.
    memoryEnabled: true,
    vendors,
    models,
    officialSkills: refreshOfficialSkills(input.officialSkills),
  };
}
function refreshOfficialSkills(stored: AIConfig["officialSkills"] | undefined) {
  if (!stored?.length) return defaultOfficialSkills;
  const defaults = new Map(
    defaultOfficialSkills.map((skill) => [skill.id, skill]),
  );
  return stored.map((skill) => {
    const next = defaults.get(skill.id);
    return next ? { ...next, enabled: skill.enabled } : skill;
  });
}
export function storedAIConfig(config: AIConfig) {
  return {
    ...config,
    models: config.models.map(
      ({ provider, baseUrl, apiKey, apiVersion, ...m }) => ({
        ...m,
        vendorId: m.vendorId!,
      }),
    ),
  };
}
export function displayModel(
  config: Pick<AIConfig, "display">,
  model: Pick<AIModel, "model" | "alias">,
) {
  return config.display === "alias" ? model.alias : model.model;
}
function normalizeConfigInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.models)) return input;
  return {
    ...value,
    models: value.models.map((model) => {
      if (!model || typeof model !== "object" || Array.isArray(model))
        return model;
      const { provider, baseUrl, apiKey, apiVersion, ...linked } =
        model as Record<string, unknown>;
      return "vendorId" in linked ? linked : model;
    }),
  };
}
export async function saveAIConfig(db: DB, input: unknown, revision: number) {
  const parsed = aiConfigSchema.safeParse(normalizeConfigInput(input));
  if (!parsed.success)
    fail(400, "AI 配置无效：" + parsed.error.issues[0]?.message);
  const config = resolveConfig(parsed.data);
  if (config.webSearch?.provider === "searxng") {
    const url = config.webSearch.baseUrl
      ? new URL(config.webSearch.baseUrl)
      : null;
    if (
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(400, "自建搜索需要有效的 HTTP(S) 服务地址，不能包含凭据或查询参数");
  }
  if (config.webFetch?.provider !== "builtin" && config.webFetch?.baseUrl) {
    const url = new URL(config.webFetch.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(400, "网页读取服务地址必须使用 HTTP(S)，不含凭据、参数或片段");
  }
  if (new Set(config.vendors.map((v) => v.id)).size !== config.vendors.length)
    fail(400, "厂商 ID 不得重复");
  for (const vendor of config.vendors) {
    const url = new URL(vendor.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      fail(400, "厂商地址必须使用 HTTP(S)，不含凭据、参数或片段");
  }
  if (
    new Set(config.officialSkills?.map((s) => s.id)).size !==
    (config.officialSkills?.length ?? 0)
  )
    fail(400, "官方 Skill ID 不得重复");
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const model of config.models) {
    if (!model.embedding && model.imageGeneration) {
      const profile = imageProfileForModel(model);
      if (!profile) fail(400, "请从适配器支持清单选择图片模型", { code: model.imageProfile ? "image_profile_invalid" : "image_profile_required" });
      if (model.imageSize && !validImageSize(profile, model.imageSize)) fail(400, "图片默认尺寸超出所选模型支持范围", { code: "image_size_invalid" });
    }
    if (model.embedding) {
      const source = embeddingSource(model.provider);
      if (!source)
        fail(400, "向量模型目前支持 OpenAI 和 OpenAI 兼容接口，请选择对应厂商");
      if (source === "rest" && !model.embeddingDimensions)
        fail(400, "兼容接口的向量模型需要填写实际输出维度");
      if (model.tools || model.vision || model.pdf || model.imageGeneration)
        fail(400, "向量模型不能同时启用聊天、工具调用或图片生成能力");
    }
    if (ids.has(model.id)) fail(400, "模型 ID 不得重复");
    ids.add(model.id);
    const url = new URL(model.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      fail(400, "模型地址必须使用 HTTP(S)，不含凭据、参数或片段");
    if (config.display === "alias" && model.enabled) {
      if (!model.alias || aliases.has(model.alias))
        fail(400, "别名模式下每个启用模型需要不同的别名");
      aliases.add(model.alias);
    }
  }
  if (
    config.defaultModel &&
    !config.models.some(
      (m) => m.id === config.defaultModel && m.enabled && !m.embedding,
    )
  )
    fail(400, "默认模型必须是已启用的非向量模型");
  if (
    config.imageModel &&
    !config.models.some((m) => m.id === config.imageModel && m.enabled && imageProfileForModel(m))
  )
    fail(400, "图片工具默认模型必须是已启用且有适配器的图片模型", { code: "image_model_not_enabled" });
  for (const operation of imageOperations) {
    const id = config.imageToolModels?.[operation];
    if (id && !config.models.some(model => model.id === id && model.enabled && imageProfileForModel(model)?.operations.includes(operation)))
      fail(400, "工具覆盖模型必须已启用并支持对应图片操作", { code: "image_operation_unsupported" });
  }
  if (config.mediaModel) {
    const media = config.models.find((m) => m.id === config.mediaModel);
    if (!media || media.embedding)
      fail(400, "附件识别模型必须是已配置的非向量模型");
    if (!media.vision) fail(400, "附件识别模型需要启用图片理解");
  }
  return transact(db, async (tx) => {
    const old = await aiConfig(tx);
    if (old.revision !== revision) fail(409, "配置已变化，请刷新");
    if (config.webSearch?.apiKey === null)
      config.webSearch.apiKey =
        old.webSearch?.provider === config.webSearch.provider
          ? (old.webSearch.apiKey ?? "")
          : "";
    if (config.webFetch && config.webFetch.apiKey == null)
      config.webFetch.apiKey =
        old.webFetch?.provider === config.webFetch.provider &&
        old.webFetch?.baseUrl === config.webFetch.baseUrl
          ? (old.webFetch.apiKey ?? "")
          : "";
    for (const v of config.vendors)
      if (v.apiKey === null)
        v.apiKey =
          old.vendors.find((x) => x.id === v.id && x.provider === v.provider)
            ?.apiKey ?? "";
    const stored = storedAIConfig(config);
    if (!revision)
      await tx
        .insertInto("account_settings")
        .values({ id: "ai", config: JSON.stringify(stored), revision: 1 })
        .execute();
    else {
      const r = await tx
        .updateTable("account_settings")
        .set({ config: JSON.stringify(stored), revision: revision + 1 })
        .where("id", "=", "ai")
        .where("revision", "=", revision)
        .executeTakeFirst();
      if (!r.numUpdatedRows) fail(409, "配置已变化，请刷新");
    }
    return {
      ...resolveConfig(aiConfigSchema.parse(stored)),
      revision: revision + 1,
    };
  });
}
export async function aiUser(db: DB, userId: string) {
  await db
    .insertInto("ai_users")
    .values({
      user_id: userId,
      default_model: null,
      memory_enabled: 1,
      memory_revision: 0,
      lock_version: 0,
    })
    .onConflict((oc) => oc.column("user_id").doNothing())
    .execute();
  return db
    .selectFrom("ai_users")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
}
export async function lockAIUser(db: DB, userId: string) {
  await aiUser(db, userId);
  await db
    .updateTable("ai_users")
    .set({ lock_version: sql`lock_version + 1` })
    .where("user_id", "=", userId)
    .execute();
}
export async function availableModels(db: DB, userId: string) {
  await requireCapability(db, userId, "ai.create");
  const config = await aiConfig(db);
  const models = config.models.filter(
    (m) =>
      m.enabled &&
      !m.embedding &&
      m.tools &&
      config.vendors.some((v) => v.id === m.vendorId && v.enabled) &&
      (!!m.apiKey || m.provider === "ollama"),
  );
  return { config, models };
}
export async function requireModel(db: DB, userId: string, id: string) {
  const { config, models } = await availableModels(db, userId);
  const model = models.find((m) => m.id === id);
  if (!model) fail(403, "所选模型未启用或尚未配置", { code: "model_not_enabled" });
  return { config, model };
}
/** Reading and verification do not need tool calling; agent selection still does. */
export async function requireInferenceModel(db: DB, userId: string, id: string) {
  await requireCapability(db, userId, "ai.create");
  const config = await aiConfig(db);
  const model = config.models.find(m => m.id === id && m.enabled && !m.embedding && !m.imageGeneration && config.vendors.some(v => v.id === m.vendorId && v.enabled) && (!!m.apiKey || m.provider === "ollama"));
  if (!model) fail(403, "所选推理模型未启用或尚未配置", { code: "model_inference_not_enabled" });
  return {config,model};
}
export async function requireImageModel(db: DB, userId: string, id: string, operation?: ImageOperation) {
  await requireCapability(db, userId, "ai.create");
  const config = await aiConfig(db);
  const model = config.models.find((m) => m.id === id);
  if (
    !model?.enabled ||
    model.embedding ||
    !model.imageGeneration ||
    !model.apiKey ||
    !config.vendors.some((v) => v.id === model.vendorId && v.enabled)
  )
    fail(403, "图片生成模型未配置或未启用", { code: "image_model_not_enabled" });
  const profile = imageProfileForModel(model);
  if (!profile) fail(400, "所选图片模型没有已实现的适配器", { code: "image_profile_invalid" });
  if (operation && !profile.operations.includes(operation)) fail(400, "所选模型不支持这项图片操作", { code: "image_operation_unsupported" });
  return { config, model, profile };
}
