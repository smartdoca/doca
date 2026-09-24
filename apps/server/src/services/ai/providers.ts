import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAzure } from "@ai-sdk/azure";
import type { AIModel } from "@core/modules/ai/config.js";
import { providerPreset } from "@core/modules/ai/providers.js";
import { fail } from "@core/shared/errors.js";

const hourCache = { type: "ephemeral" as const, ttl: "1h" as const };

export function promptCacheOptions(
  model: AIModel,
  options: any,
  cacheKey?: string,
) {
  const protocol = providerPreset(model.provider).protocol;
  // Compatible vendors cache a stable prefix on their own. Do not send
  // vendor-specific flags there. Claude keeps a one-hour breakpoint so a pause
  // for approval does not drop the prefix. OpenAI routes a session to one cache.
  if (protocol === "anthropic")
    return {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        anthropic: {
          cacheControl: hourCache,
          ...options.providerOptions?.anthropic,
        },
      },
    };
  if (cacheKey && (protocol === "openai" || protocol === "azure"))
    return {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        openai: {
          promptCacheKey: cacheKey,
          ...options.providerOptions?.openai,
        },
      },
    };
  return options;
}

/** Mark the last stable history block. Later tool results stay outside this prefix. */
export function markPromptCacheBoundary<T extends { providerOptions?: any }>(
  message: T,
): T {
  message.providerOptions = {
    ...message.providerOptions,
    anthropic: {
      ...message.providerOptions?.anthropic,
      cacheControl: hourCache,
    },
  };
  return message;
}

// Hosted protocols hide reasoning unless asked: OpenAI returns reasoning
// summaries only when the Responses request opts in, Claude and Gemini keep
// thinking hidden without an explicit switch. Ask by default; endpoints that
// reject the switch are remembered and retried once without it.
const adaptation = new Map<string, { chatOnly?: boolean; noReasoning?: boolean }>();
function rememberAdaptation(
  key: string,
  patch: { chatOnly?: boolean; noReasoning?: boolean },
) {
  if (adaptation.size > 256) adaptation.clear();
  adaptation.set(key, { ...adaptation.get(key), ...patch });
}
function reasoningRequest(protocol: string, apiMode?: "chat" | "responses") {
  switch (protocol) {
    case "openai":
    case "azure":
      return apiMode === "chat"
        ? null
        : { openai: { reasoningSummary: "auto" } };
    case "anthropic":
      return {
        anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      };
    case "google":
      return { google: { thinkingConfig: { includeThoughts: true } } };
    default:
      return null;
  }
}
function withReasoning(options: any, request: Record<string, any>) {
  const merged: Record<string, any> = { ...options.providerOptions };
  for (const [provider, value] of Object.entries(request))
    merged[provider] = { ...value, ...options.providerOptions?.[provider] };
  return { ...options, providerOptions: merged };
}
function responseProtocolUnsupported(error: unknown) {
  const e = error as { statusCode?: number; message?: string };
  return (
    e.statusCode === 404 ||
    e.statusCode === 405 ||
    (!e.statusCode &&
      /invalid\s+json|unexpected\s+token|unexpected\s+character|json\s+response/i.test(
        e.message ?? "",
      ))
  );
}
export type DetectedAIModelMode = "chat" | "responses";
export type DetectedAIModelLimits = {
  maxInput?: number;
  maxOutput?: number;
};

export function createAIModel(
  model: AIModel,
  fetcher: typeof fetch = fetch,
  onApiMode?: (mode: DetectedAIModelMode) => void,
) {
  if (model.embedding) fail(400, "向量模型不能用于聊天或 Agent 调用");
  const settings = {
    baseURL: model.baseUrl.replace(/\/$/, ""),
    apiKey: model.apiKey || (model.provider === "ollama" ? "ollama" : ""),
    fetch: ((input, init) =>
      fetcher(input, { ...init, redirect: "error" })) as typeof fetch,
  };
  const protocol = providerPreset(model.provider).protocol;
  const build = (apiMode?: "chat" | "responses") => {
    switch (protocol) {
      case "openai": {
        const p = createOpenAI(settings);
        return apiMode === "chat"
          ? p.chat(model.model)
          : p.responses(model.model);
      }
      case "anthropic":
        return createAnthropic(settings)(model.model);
      case "google":
        return createGoogleGenerativeAI(settings)(model.model);
      case "azure": {
        const p = createAzure({
          ...settings,
          useDeploymentBasedUrls: apiMode === "chat" && !!model.apiVersion,
          ...(model.apiVersion ? { apiVersion: model.apiVersion } : {}),
        });
        return apiMode === "chat"
          ? p.chat(model.model)
          : p.responses(model.model);
      }
      default:
        return createOpenAICompatible({
          ...settings,
          name: "doca",
          includeUsage: true,
        }).chatModel(model.model);
    }
  };
  // Administrators only configure address, key and model. The Responses API is
  // preferred where it exists (the only OpenAI interface returning reasoning);
  // endpoints without it fall back to Chat Completions once and are remembered.
  const adaptable =
    !model.apiMode && (protocol === "openai" || protocol === "azure");
  const key = [model.provider, model.baseUrl, model.apiVersion ?? "", model.model].join("|");
  const invoke = async (
    method: "doGenerate" | "doStream",
    options: any,
  ): Promise<any> => {
    const state = adaptation.get(key);
    const apiMode =
      protocol === "openai" || protocol === "azure"
        ? (model.apiMode ?? (state?.chatOnly ? "chat" : "responses"))
        : undefined;
    // Several vendors reject thinking combined with a forced tool choice,
    // so leave such calls untouched.
    const forced = options.toolChoice && options.toolChoice.type !== "auto";
    const request =
      state?.noReasoning ||
      forced ||
      options.providerOptions?.doca?.reasoning === false
        ? null
        : reasoningRequest(protocol, apiMode);
    try {
      const result = await (build(apiMode) as any)[method](
        request ? withReasoning(options, request) : options,
      );
      if (apiMode) onApiMode?.(apiMode);
      return result;
    } catch (e) {
      const status = (e as any)?.statusCode;
      if (
        adaptable &&
        apiMode === "responses" &&
        responseProtocolUnsupported(e)
      )
        rememberAdaptation(key, { chatOnly: true });
      else if (request && (status === 400 || status === 422))
        rememberAdaptation(key, { noReasoning: true });
      else throw e;
      return invoke(method, options);
    }
  };
  return new Proxy(build(model.apiMode), {
    get(target, property) {
      if (property === "doGenerate" || property === "doStream")
        return (options: any) => invoke(property, options);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function positiveLimit(value: unknown, minimum: number, maximum: number) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= minimum && n <= maximum ? n : undefined;
}

function modelLimits(model: any): DetectedAIModelLimits {
  const limits = model?.limits ?? model?.capabilities ?? {};
  return {
    maxInput:
      positiveLimit(
        model?.context_length ??
          model?.contextLength ??
          model?.max_context_length ??
          model?.maxContextLength ??
          model?.input_token_limit ??
          model?.max_input_tokens ??
          limits?.context_length ??
          limits?.contextLength ??
          limits?.max_input_tokens,
        1000,
        10000000,
      ) ??
      positiveLimit(
        model?.token_limits?.input ?? limits?.input_tokens,
        1000,
        10000000,
      ),
    maxOutput:
      positiveLimit(
        model?.max_output_tokens ??
          model?.maxOutputTokens ??
          model?.max_completion_tokens ??
          model?.maxCompletionTokens ??
          model?.output_token_limit ??
          limits?.max_output_tokens ??
          limits?.max_completion_tokens,
        32,
        1000000,
      ) ??
      positiveLimit(
        model?.token_limits?.output ?? limits?.output_tokens,
        32,
        1000000,
      ),
  };
}

export async function discoverAIModels(
  model: Pick<AIModel, "provider" | "baseUrl" | "apiKey">,
  fetcher: typeof fetch = fetch,
) {
  const protocol = providerPreset(model.provider).protocol;
  if (protocol === "azure") fail(400, "Azure 请填写控制台中的部署名称");
  const headers: Record<string, string> =
    protocol === "anthropic"
      ? { "x-api-key": model.apiKey!, "anthropic-version": "2023-06-01" }
      : protocol === "google"
        ? { "x-goog-api-key": model.apiKey! }
        : { Authorization: `Bearer ${model.apiKey || "ollama"}` };
  try {
    const r = await fetcher(model.baseUrl.replace(/\/$/, "") + "/models", {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) fail(502, "供应商未提供可用模型列表，请手动填写模型 ID");
    const body = (await r.json()) as any;
    return {
      models: (body.data ?? body.models ?? [])
        .slice(0, 500)
        .map((m: any) => {
          const item: {
            id: string;
            name: string;
            maxInput?: number;
            maxOutput?: number;
          } = {
            id: String(m.id ?? m.name ?? "").replace(/^models\//, ""),
            name: String(
              m.displayName ?? m.display_name ?? m.id ?? m.name ?? "",
            ).slice(0, 160),
          };
          const limits = modelLimits(m);
          if (limits.maxInput) item.maxInput = limits.maxInput;
          if (limits.maxOutput) item.maxOutput = limits.maxOutput;
          return item;
        })
        .filter((m: any) => m.id && m.id.length <= 160),
    };
  } catch (e) {
    if ((e as any)?.status) throw e;
    fail(502, "模型列表读取失败，请检查配置或手动填写模型 ID");
  }
}

export async function testAIModel(
  model: AIModel,
  fetcher?: typeof fetch,
  onApiMode?: (mode: DetectedAIModelMode) => void,
) {
  const target = createAIModel(model, fetcher, onApiMode);
  const prompt = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: 'Reply with "OK".' }],
    },
  ];
  let lastError: unknown;
  for (const extra of [{ maxOutputTokens: 128 }, {}]) {
    try {
      return await target.doGenerate({
        prompt,
        ...extra,
        abortSignal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      if (![400, 422].includes((e as any)?.statusCode)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

// The admin probe surfaces the vendor's own message; keys are always stripped.
export function modelConnectionDetail(
  error: unknown,
  model: Pick<AIModel, "apiKey">,
) {
  let detail = String((error as { message?: string })?.message ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) return "";
  if (model.apiKey) detail = detail.split(model.apiKey).join("***");
  return detail.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 300);
}

// Never return provider request bodies, headers or secrets in an error response.
export function modelConnectionError(error: unknown): string {
  const e = error as {
    statusCode?: number;
    name?: string;
    message?: string;
    cause?: { code?: string };
  };
  const status = e?.statusCode;
  if (status === 401)
    return "模型认证失败（401），请检查厂商密钥是否正确或已失效";
  if (status === 402) return "模型厂商账户余额不足（402），请在厂商平台充值";
  if (status === 403)
    return "厂商拒绝访问（403），请检查密钥权限与模型开通状态";
  if (status === 404)
    return "模型或接口不存在（404），请核对厂商地址和模型标识";
  if (status === 429)
    return "模型厂商限流或额度不足（429），请稍后重试或检查厂商额度";
  if (status === 400 || status === 422) {
    if (/max_(?:completion_|output_)?tokens/i.test(e.message ?? "")) {
      const maximum =
        /(?:<=|at most|maximum(?: value)?(?: of)?[: =]*)\s*(\d{2,9})/i.exec(
          e.message ?? "",
        )?.[1];
      return maximum
        ? `单次输出上限超过厂商限制，当前接口最多允许 ${Number(maximum).toLocaleString("en-US")} Token，请在模型管理中调整`
        : "单次输出上限不符合厂商要求，请在模型管理中检查输出参数";
    }
    if (/tool_choice/i.test(e.message ?? ""))
      return "模型不支持本次工具调用参数，请检查工具调用能力和思考模式配置";
    return `厂商拒绝请求（${status}），请核对模型标识及其支持的参数`;
  }
  if (status && status >= 500)
    return `模型厂商服务暂时异常（${status}），请稍后重试`;
  if (e?.name === "TimeoutError" || e?.name === "AbortError")
    return "模型连接超时，请检查网络或稍后重试";
  if (/invalid\s+json|unexpected\s+token|unexpected\s+character|json\s+response/i.test(e?.message ?? ""))
    return "厂商返回了非 JSON 响应，请检查 API 地址和协议类型";
  return "无法完成模型连接，请检查网络、厂商地址及服务状态";
}
