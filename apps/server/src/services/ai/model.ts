import {
  createAIModel,
  modelConnectionError,
  modelConnectionReason,
  promptCacheOptions,
} from "./providers.js";
import type { DB } from "@db/index.js";
import { AppError, fail } from "@core/shared/errors.js";
import { requireInferenceModel } from "@core/modules/ai/config.js";
import {
  hoistToolImages,
  bindToolImageFrames,
  transmittedToolImageFrames,
  type ToolImageSelection,
  type TransmittedToolImage,
} from "./tool-media.js";
import { modelPromptImages } from "./model-image.js";
import { beginCall, settleCall } from "@core/modules/ai/usage.js";
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
export type ScopedModelPrompt = {
  prompt: any[];
  protectedPrefix: number;
};
export async function meteredModel(
  db: DB,
  userId: string,
  modelId: string,
  jobId: string | null,
  fetcher?: typeof fetch,
  beforeCall?: () => Promise<void>,
  cacheKey?: string,
  scopePrompt?: (prompt: any[]) => ScopedModelPrompt,
  scopeTools?: (tools: any) => any,
  preparedPrompt?: (
    prompt: any[],
    frames: TransmittedToolImage[],
  ) => { complete(): void; abort(): void },
  normalizePromptImages: (prompt: any[]) => Promise<any[]> = modelPromptImages,
) {
  const { model } = await requireInferenceModel(db, userId, modelId);
  const base = createAIModel(model, fetcher);
  return new Proxy(base, {
    get(target, key) {
      if (key !== "doGenerate" && key !== "doStream") {
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (options: any) => {
        options = promptCacheOptions(model, options, cacheKey);
        if (scopeTools)
          options = { ...options, tools: scopeTools(options.tools) };
        await beforeCall?.();
        const current = await requireInferenceModel(db, userId, modelId);
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
          fail(409, "模型配置已变化，请重新发起任务", {
            code: "model_config_changed",
          });
        let transmittedFrames: TransmittedToolImage[] = [];
        if (Array.isArray(options.prompt)) {
          const selected: ToolImageSelection[] = [];
          const scoped = scopePrompt
            ? scopePrompt(options.prompt)
            : { prompt: options.prompt, protectedPrefix: 0 };
          const hoisted = hoistToolImages(scoped.prompt, 4, (frame) =>
            selected.push(frame),
          );
          const normalized = normalizePromptImages === modelPromptImages
            ? await modelPromptImages(hoisted, new Set(selected
                .filter(frame => frame.toolName === "image_mask_region_view" || frame.toolName === "image_candidate_region_view")
                .map(frame => frame.part.data)))
            : await normalizePromptImages(hoisted);
          const bound = bindToolImageFrames(selected, normalized);
          options = {
            ...options,
            prompt: fitPromptToModelInput(
              normalized,
              model.maxInput,
              options.tools,
              scoped.protectedPrefix,
            ),
          };
          transmittedFrames = transmittedToolImageFrames(options.prompt, bound);
        }
        const bytes = promptPayloadBytes(options.prompt, options.tools);
        if (bytes > model.maxInput * MODEL_INPUT_BYTE_FACTOR)
          fail(413, "当前上下文过长，请减少引用或新建会话", {
            code: "model_context_large",
          });
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
        let observation:
          ReturnType<NonNullable<typeof preparedPrompt>> | undefined;
        let failed = false;
        const abortObservation = () => {
          failed = true;
          observation?.abort();
        };
        const confirm = (finishReason: any) => {
          const reason =
            typeof finishReason === "string"
              ? finishReason
              : finishReason?.unified;
          if (
            failed ||
            options.abortSignal?.aborted ||
            !["stop", "tool-calls", "length"].includes(reason)
          )
            abortObservation();
          else observation?.complete();
        };
        try {
          // No private frame identifiers are added to options or provider JSON.
          // Confirmation is committed only after a successful response finishes.
          observation = preparedPrompt?.(options.prompt, transmittedFrames);
          if (key === "doGenerate") {
            const result = await target.doGenerate({
              ...options,
              maxOutputTokens: maxOutput,
            });
            await settleCall(db, call.id, usageOf(result.usage));
            confirm(result.finishReason);
            return result;
          }
          const result = await target.doStream({
            ...options,
            maxOutputTokens: maxOutput,
          });
          let ended = false;
          let finishReason: any;
          const held: any[] = [];
          const reader = result.stream.getReader();
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                // Mastra synthesizes a complete tool-call at tool-input-end.
                // Retain either executable boundary and its tail until success.
                while (true) {
                  const next = await reader.read();
                  if (next.done) {
                    if (!ended) {
                      abortObservation();
                      await settleCall(db, call.id, null);
                    }
                    if (observation && ended) {
                      confirm(finishReason);
                      for (const value of held)
                        if (!failed || value.type === "finish")
                          controller.enqueue(value);
                    }
                    controller.close();
                    return;
                  }
                  if (next.value.type === "error") {
                    abortObservation();
                    held.length = 0;
                  }
                  if (next.value.type === "finish") {
                    await settleCall(db, call.id, usageOf(next.value.usage));
                    ended = true;
                    finishReason = next.value.finishReason;
                    if (observation) {
                      held.push(next.value);
                      continue;
                    }
                    controller.enqueue(next.value);
                    return;
                  }
                  if (
                    observation &&
                    (held.length ||
                      next.value.type === "tool-input-end" ||
                      next.value.type === "tool-call")
                  ) {
                    if (!failed) held.push(next.value);
                    continue;
                  }
                  controller.enqueue(next.value);
                  return;
                }
              } catch (e) {
                abortObservation();
                await settleCall(db, call.id, null);
                controller.error(e);
              }
            },
            async cancel(reason) {
              abortObservation();
              await reader.cancel(reason);
              if (!ended) await settleCall(db, call.id, null);
            },
          });
          return { ...result, stream };
        } catch (e) {
          abortObservation();
          const status = (e as any)?.statusCode;
          await settleCall(
            db,
            call.id,
            [400, 401, 403, 404, 413, 422, 429].includes(status)
              ? { input: 0, output: 0 }
              : null,
            "failed",
          );
          // Our own guarded errors carry a safe message already; only
          // provider/network failures need translation. Never forward provider
          // bodies, request headers or real model IDs to a user.
          if (e instanceof AppError) throw e;
          fail(
            [413, 429].includes(status) ? status : 502,
            modelConnectionError(e),
            modelConnectionReason(e),
          );
        }
      };
    },
  });
}
