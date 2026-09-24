import { createHash } from "node:crypto";
import type { AIConfig, AIModel } from "./config.js";
import { embeddingSource, embeddingApi } from "./providers.js";
import { fail } from "../../shared/errors.js";

export function embeddingModelIssue(config: AIConfig, model: AIModel) {
  if (!model.embedding) return "请选择向量模型";
  if (!model.enabled) return "模型已停用";
  if (!config.vendors.some((v) => v.id === model.vendorId && v.enabled))
    return "模型厂商已停用或不存在";
  if (!embeddingSource(model.provider)) return "暂不支持该厂商的向量接口";
  if (!model.apiKey && model.provider !== "ollama")
    return "模型厂商尚未配置密钥";
  if (
    (embeddingSource(model.provider) === "rest" ||
      embeddingApi(model) === "doubao-multimodal") &&
    !model.embeddingDimensions
  )
    return "请在 AI 模型管理中填写向量维度";
  return "";
}

export function embeddingSettings(model: AIModel) {
  const source = embeddingSource(model.provider);
  if (!model.embedding || !source) fail(400, "请选择受支持的向量模型");
  return {
    source: embeddingApi(model) === "doubao-multimodal" ? "rest" : source,
    url:
      model.baseUrl.replace(/\/+$/, "") +
      (embeddingApi(model) === "doubao-multimodal"
        ? "/embeddings/multimodal"
        : "/embeddings"),
    // Always send the current vendor credential, including explicit removal.
    apiKey: model.apiKey || null,
    dimensions: model.embeddingDimensions ?? null,
    ...(embeddingApi(model) === "doubao-multimodal"
      ? {
          request: {
            model: model.model,
            input: [{ type: "text", text: "{{text}}" }],
          },
          response: { data: { embedding: "{{embedding}}" } },
        }
      : source === "openAi"
        ? { model: model.model }
        : {
            request: {
              model: model.model,
              input: ["{{text}}", "{{..}}"],
              encoding_format: "float",
            },
            response: { data: [{ embedding: "{{embedding}}" }, "{{..}}"] },
          }),
  };
}

export function embeddingFingerprint(model: AIModel) {
  return createHash("sha256")
    .update(JSON.stringify(embeddingSettings(model)))
    .digest("hex");
}
