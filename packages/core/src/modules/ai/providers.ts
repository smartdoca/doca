// Provider presets describe protocols/endpoints, not a frozen list of model versions.
export const aiProviders = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    name: "Anthropic · Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "google",
    name: "Google · Gemini",
    protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  { id: "azure", name: "Azure OpenAI", protocol: "azure", baseUrl: "" },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "compatible",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    id: "qwen",
    name: "阿里云 · 通义千问",
    protocol: "compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "doubao",
    name: "火山方舟 · 豆包",
    protocol: "compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    id: "moonshot",
    name: "Moonshot · Kimi",
    protocol: "compatible",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    id: "zhipu",
    name: "智谱 · GLM",
    protocol: "compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
  },
  {
    id: "mistral",
    name: "Mistral",
    protocol: "compatible",
    baseUrl: "https://api.mistral.ai/v1",
  },
  {
    id: "groq",
    name: "Groq",
    protocol: "compatible",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "compatible",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    protocol: "compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  {
    id: "ollama",
    name: "Ollama · 本地模型",
    protocol: "compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  {
    id: "compatible",
    name: "自定义 OpenAI 兼容服务",
    protocol: "compatible",
    baseUrl: "",
  },
] as const;
export type AIProviderId = (typeof aiProviders)[number]["id"];
export const providerPreset = (id?: string) =>
  aiProviders.find((p) => p.id === (id ?? "compatible"))!;

export function embeddingSource(provider?: string) {
  const protocol = providerPreset(provider)?.protocol;
  return protocol === "openai"
    ? "openAi"
    : protocol === "compatible"
      ? "rest"
      : null;
}

export function embeddingApi(model: {
  embeddingApi?: string;
  provider?: string;
  model: string;
}) {
  if (model.embeddingApi) return model.embeddingApi;
  return /doubao-embedding-vision/i.test(model.model)
    ? "doubao-multimodal"
    : "openai";
}
