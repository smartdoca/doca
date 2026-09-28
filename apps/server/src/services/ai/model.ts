import {
  createAIModel,
  modelConnectionError,
  promptCacheOptions,
} from "./providers.js";
import type { DB } from "@db/index.js";
import { AppError, fail } from "@core/shared/errors.js";
import { requireModel } from "@core/modules/ai/config.js";
import {
  beginCall,
  settleCall,
} from "@core/modules/ai/usage.js";
import {
  MODEL_INPUT_BYTE_FACTOR,
  fitPromptToModelInput,
  promptPayloadBytes,
} from "./context-budget.js";

export function usageOf(usage: any) {
  const raw = usage?.raw;
  if (
    raw?.prompt_tokens !== undefined &&
    (!Number.isSafeInteger(raw.prompt_tokens) ||
      !Number.isSafeInteger(raw.completion_tokens))
  )
    return null;
  const input =
    typeof usage?.inputTokens === "number"
      ? usage.inputTokens
      : usage?.inputTokens?.total;
  const output =
    typeof usage?.outputTokens === "number"
      ? usage.outputTokens
      : usage?.outputTokens?.total;
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    return null;
  const cached =
    raw?.prompt_cache_hit_tokens ??
    raw?.prompt_tokens_details?.cached_tokens ??
    raw?.input_tokens_details?.cached_tokens ??
    raw?.cache_read_input_tokens ??
    usage.inputTokens?.cacheRead ??
    usage.cachedInputTokens ??
    0;
  if (!Number.isSafeInteger(cached) || cached < 0) return null;
  return {
    input,
    output,
    cached: Math.min(input, cached),
    raw: usage,
  };
}
export async function meteredModel(
  db: DB,
  userId: string,
  modelId: string,
  jobId: string | null,
  fetcher?: typeof fetch,
  beforeCall?: () => Promise<void>,
  cacheKey?: string,
) {
  const { model } = await requireModel(db, userId, modelId);
  const base = createAIModel(model, fetcher);
  return new Proxy(base, {
    get(target, key) {
      if (key !== "doGenerate" && key !== "doStream") {
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (options: any) => {
        options = promptCacheOptions(model, options, cacheKey);
        await beforeCall?.();
        const current = await requireModel(db, userId, modelId);
        if (
          current.model.model !== model.model ||
          current.model.baseUrl !== model.baseUrl ||
          current.model.provider !== model.provider ||
          current.model.apiMode !== model.apiMode ||
          current.model.apiVersion !== model.apiVersion ||
          current.model.apiKey !== model.apiKey ||
          current.model.vision !== model.vision ||
          current.model.pdf !== model.pdf ||
          current.model.maxInput !== model.maxInput ||
          current.model.maxOutput !== model.maxOutput
        )
          fail(409, "模型配置已变化，请重新发起任务");
        if (Array.isArray(options.prompt))
          options = {
            ...options,
            prompt: fitPromptToModelInput(
              options.prompt,
              model.maxInput,
              options.tools,
            ),
          };
        const bytes = promptPayloadBytes(options.prompt, options.tools);
        if (bytes > model.maxInput * MODEL_INPUT_BYTE_FACTOR)
          fail(413, "当前上下文过长，请减少引用或新建会话");
        // UTF-8 bytes bound common byte-tokenizers conservatively; reserve against enforced output limit.
        const media = (Array.isArray(options.prompt) ? options.prompt : [])
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .filter((p: any) => p.type === "file" || p.type === "image");
        const mediaBudget = media.reduce(
          (sum: number, p: any) =>
            sum + (p.mediaType === "application/pdf" ? model.maxInput : 8192),
          0,
        );
        const inputUpper = bytes + 512 + mediaBudget;
        const maxOutput = Math.min(
          options.maxOutputTokens ?? model.maxOutput,
          model.maxOutput,
        );
        const call = await beginCall(
          db,
          userId,
          modelId,
          jobId,
          inputUpper,
          maxOutput,
        );
        try {
          if (key === "doGenerate") {
            const result = await target.doGenerate({
              ...options,
              maxOutputTokens: maxOutput,
            });
            await settleCall(db, call.id, usageOf(result.usage));
            return result;
          }
          const result = await target.doStream({
            ...options,
            maxOutputTokens: maxOutput,
          });
          let ended = false;
          const reader = result.stream.getReader();
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  if (!ended) await settleCall(db, call.id, null);
                  controller.close();
                  return;
                }
                if (next.value.type === "finish") {
                  await settleCall(db, call.id, usageOf(next.value.usage));
                  ended = true;
                }
                controller.enqueue(next.value);
              } catch (e) {
                await settleCall(db, call.id, null);
                controller.error(e);
              }
            },
            async cancel(reason) {
              await reader.cancel(reason);
              if (!ended) await settleCall(db, call.id, null);
            },
          });
          return { ...result, stream };
        } catch (e) {
          const status = (e as any)?.statusCode;
          await settleCall(
            db,
            call.id,
            [400, 401, 403, 404, 422, 429].includes(status)
              ? { input: 0, output: 0 }
              : null,
            "failed",
          );
          // Our own guarded errors carry a safe message already; only
          // provider/network failures need translation. Never forward provider
          // bodies, request headers or real model IDs to a user.
          if (e instanceof AppError) throw e;
          fail(status === 429 ? 429 : 502, modelConnectionError(e));
        }
      };
    },
  });
}
