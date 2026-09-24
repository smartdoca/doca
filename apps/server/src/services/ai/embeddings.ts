import type { AIModel } from "@core/modules/ai/config.js";
import { embeddingSettings } from "@core/modules/ai/embeddings.js";
import { embeddingApi } from "@core/modules/ai/providers.js";
import { fail } from "@core/shared/errors.js";

export async function testAIEmbeddingModel(
  model: AIModel,
  fetcher: typeof fetch = fetch,
) {
  const settings = embeddingSettings(model);
  try {
    const res = await fetcher(settings.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.model,
        ...(embeddingApi(model) === "doubao-multimodal"
          ? { input: [{ type: "text", text: "Doca 向量连接测试" }] }
          : { input: ["Doca 向量连接测试"], encoding_format: "float" }),
        ...(settings.source === "openAi" && model.embeddingDimensions
          ? { dimensions: model.embeddingDimensions }
          : {}),
      }),
    });
    if (!res.ok) throw new Error();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (!res.body) throw new Error();
    for await (const part of res.body as any) {
      size += part.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error();
      parts.push(part);
    }
    const data = JSON.parse(Buffer.concat(parts).toString()),
      vector =
        embeddingApi(model) === "doubao-multimodal"
          ? data.data?.embedding
          : data.data?.[0]?.embedding;
    if (
      !Array.isArray(vector) ||
      !vector.length ||
      vector.length > 65536 ||
      vector.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
      (model.embeddingDimensions && vector.length !== model.embeddingDimensions)
    )
      throw new Error();
    const tokens = data.usage?.prompt_tokens;
    return {
      dimensions: vector.length as number,
      content: [],
      usage: {
        inputTokens: {
          total: Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : 0,
        },
        outputTokens: { total: 0 },
      },
    };
  } catch {
    fail(502, "向量连接测试失败，请检查模型名称、接口、密钥和输出维度");
  }
}
