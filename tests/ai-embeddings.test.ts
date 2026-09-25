import { expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import {
  aiConfig,
  aiDefaults,
  availableModels,
  requireModel,
  saveAIConfig,
  type AIModel,
} from "@core/modules/ai/config.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { testAIEmbeddingModel } from "../apps/server/src/services/ai/embeddings.js";
import { createAIModel } from "../apps/server/src/services/ai/providers.js";
import { embeddingSettings } from "@core/modules/ai/embeddings.js";
import { embeddingApi } from "@core/modules/ai/providers.js";

const model: AIModel = {
  id: "embedding",
  vendorId: "compatible-vendor",
  provider: "compatible",
  baseUrl: "https://model.test/v1/",
  apiKey: "secret-key",
  model: "embedding-model",
  alias: "向量模型",
  enabled: true,
  embedding: true,
  embeddingDimensions: 3,
  tools: false,
  maxInput: 8000,
  maxOutput: 32,
};

it("uses Doubao REST embedders even when the vendor protocol is OpenAI", () => {
  expect(
    embeddingApi({ provider: "openai", model: "doubao-embedding-vision" }),
  ).toBe("doubao-multimodal");
  expect(
    embeddingSettings({
      ...model,
      provider: "openai",
      model: "doubao-embedding-vision",
      embeddingDimensions: 2048,
    }),
  ).toMatchObject({
    source: "rest",
    url: "https://model.test/v1/embeddings/multimodal",
    request: {
      model: "doubao-embedding-vision",
      input: [{ type: "text", text: "{{text}}" }],
    },
  });
});

it("persists vector capability and dimensions but never exposes vector models as chat choices", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const user = await createUser(
      db,
      {
        login: "admin",
        displayName: "Admin",
        password: "embedding-test-password",
      },
      { bootstrap: true },
    );
    const chat = {
      ...model,
      id: "chat",
      alias: "聊天模型",
      embedding: false,
      tools: true,
    };
    await saveAIConfig(
      db,
      {
        ...aiDefaults,
        vendors: [
          {
            id: "compatible-vendor",
            name: "兼容厂商",
            provider: "compatible",
            baseUrl: "https://model.test/v1/",
            apiKey: "secret-key",
            enabled: true,
          },
        ],
        models: [model, chat],
      },
      0,
    );
    const { revision, ...current } = await aiConfig(db);
    expect(current.models[0]).toMatchObject({
      embedding: true,
      embeddingDimensions: 3,
      apiKey: "secret-key",
    });
    expect(
      (await availableModels(db, user.id)).models.map((m) => m.id),
    ).not.toContain("embedding");
    expect(
      (await availableModels(db, user.id)).models.map((m) => m.id),
    ).toContain("chat");
    await expect(requireModel(db, user.id, "embedding")).rejects.toThrow();
    await expect(
      saveAIConfig(db, { ...current, defaultModel: "embedding" }, 1),
    ).rejects.toThrow("非向量模型");
    await expect(
      saveAIConfig(db, { ...current, imageModel: "embedding" }, 1),
    ).rejects.toThrow("不能使用向量模型");
    for (const patch of [
      { embeddingDimensions: undefined },
      { embeddingDimensions: 0 },
      { embeddingDimensions: 1.5 },
      { tools: true },
      { imageGeneration: true },
    ])
      await expect(
        saveAIConfig(
          db,
          {
            ...aiDefaults,
            vendors: [
              {
                id: "compatible-vendor",
                name: "兼容厂商",
                provider: "compatible",
                baseUrl: "https://model.test/v1/",
                apiKey: "secret-key",
                enabled: true,
              },
            ],
            models: [{ ...model, ...patch }],
          },
          1,
        ),
      ).rejects.toThrow();
    expect(() => createAIModel(model)).toThrow("不能用于聊天");
  } finally {
    await db.destroy();
  }
});

it("tests embeddings through the embedding endpoint and validates the returned dimensions", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    expect(url).toBe("https://model.test/v1/embeddings");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as any).Authorization).toBe("Bearer secret-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "embedding-model",
      input: ["Doca 向量连接测试"],
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("dimensions");
    return Response.json({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 8 },
    });
  };
  expect(
    (await testAIEmbeddingModel(model, fetcher)).usage.inputTokens.total,
  ).toBe(8);
  expect(calls).toBe(1);
  await expect(
    testAIEmbeddingModel(model, async () =>
      Response.json({ data: [{ embedding: [1] }] }),
    ),
  ).rejects.toThrow("维度");
  await expect(
    testAIEmbeddingModel(
      model,
      async () => new Response("secret-key", { status: 401 }),
    ),
  ).rejects.toThrow("向量连接测试失败");
  await testAIEmbeddingModel(
    { ...model, provider: "openai" },
    async (_url, init) => {
      expect(JSON.parse(String(init?.body)).dimensions).toBe(3);
      return Response.json({ data: [{ embedding: [1, 2, 3] }] });
    },
  );
});

it("detects actual dimensions without a stored model and handles Doubao multimodal responses", async () => {
  const detected = await testAIEmbeddingModel(
    { ...model, embeddingDimensions: undefined },
    async () => Response.json({ data: [{ embedding: [1, 2, 3, 4] }] }),
  );
  expect(detected.dimensions).toBe(4);
  const vision = {
    ...model,
    provider: "doubao" as const,
    model: "doubao-embedding-vision",
    embeddingDimensions: undefined,
  };
  const result = await testAIEmbeddingModel(vision, async (url, init) => {
    expect(String(url).endsWith("/embeddings/multimodal")).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: vision.model,
      input: [{ type: "text", text: "Doca 向量连接测试" }],
    });
    return Response.json({
      data: { embedding: [1, 2, 3] },
      usage: { prompt_tokens: 3 },
    });
  });
  expect(result.dimensions).toBe(3);
});
