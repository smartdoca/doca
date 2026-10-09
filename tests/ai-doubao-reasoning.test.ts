import { expect, it } from "vitest";
import type { AIModel } from "@core/modules/ai/config.js";
import { createAIModel } from "../apps/server/src/services/ai/providers.js";

const model: AIModel = {
  id: "reasoning-probe",
  provider: "doubao",
  model: "doubao-seed-2.1-pro",
  alias: "Isolated wire probe",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  apiKey: "mock-only",
  enabled: true,
  maxInput: 128000,
  maxOutput: 12000,
  tools: true,
  vision: true,
};
const prompt = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Probe" }],
  },
];
const answer = {
  id: "chat_mock",
  object: "chat.completion",
  created: 1,
  model: "mock",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "ok" },
    },
  ],
  usage: {
    prompt_tokens: 9,
    completion_tokens: 5,
    completion_tokens_details: { reasoning_tokens: 4 },
  },
};
async function capture(
  patch: Partial<AIModel> = {},
  options: Record<string, any> = {},
) {
  const bodies: Record<string, any>[] = [];
  const sdk = createAIModel({ ...model, ...patch }, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(answer), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const result = await sdk.doGenerate({
    prompt,
    maxOutputTokens: 12000,
    ...options,
  });
  expect(bodies).toHaveLength(1);
  const body = bodies[0];
  if (!body) throw Error("SDK request was not captured");
  return { body, result };
}

it.each([
  { model: "doubao-seed-2.1-pro" },
  {
    model: "doubao-seed-2.1-pro",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/",
  },
  { model: "doubao-seed-2-1-pro-260628" },
  { model: "doubao-seed-2-1-pro-260915" },
])(
  "sends native low effort for the verified Seed pro model $model",
  async (patch) => {
    const providerOptions = { doca: { user: "isolated-user" } };
    const { body, result } = await capture(patch, { providerOptions });
    expect(body.reasoning_effort).toBe("low");
    expect(body.reasoningEffort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(12000);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.user).toBe("isolated-user");
    expect(providerOptions).toEqual({ doca: { user: "isolated-user" } });
    expect(result.usage.raw).toEqual(answer.usage);
    expect(result.usage.outputTokens).toMatchObject({ total: 5, reasoning: 4 });
  },
);

it.each(["low", "medium", "high", "minimal"])(
  "preserves the explicit doca effort %s",
  async (reasoningEffort) => {
    const { body } = await capture(
      {},
      { providerOptions: { doca: { reasoningEffort } } },
    );
    expect(body.reasoning_effort).toBe(reasoningEffort);
  },
);

it("preserves explicit generic SDK and top-level reasoning choices", async () => {
  const generic = await capture(
    {},
    { providerOptions: { openaiCompatible: { reasoningEffort: "high" } } },
  );
  expect(generic.body.reasoning_effort).toBe("high");
  const topLevel = await capture({}, { reasoning: "high" });
  expect(topLevel.body.reasoning_effort).toBe("high");
});

it.each(["enabled", "disabled"])(
  "does not add an effort to explicit thinking type %s",
  async (type) => {
    const { body } = await capture(
      {},
      { providerOptions: { doca: { thinking: { type } } } },
    );
    expect(body.thinking).toEqual({ type });
    expect(body.reasoning_effort).toBeUndefined();
  },
);

it.each([
  { provider: "compatible" as const },
  { provider: "qwen" as const },
  { provider: "deepseek" as const },
  { provider: "openai" as const, apiMode: "chat" as const },
  { model: "doubao-seed-2.1-pro-unknown" },
  { model: "doubao-seed-2.1-pro-260628" },
  { model: "doubao-seed-2.1-pro-260915" },
  { model: "doubao-seed-2.1-lite-260915" },
  { model: "ep-isolated-deployment" },
  { baseUrl: "https://compatible.example.invalid/v1" },
  { baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
])(
  "leaves other vendors, unknown models and unverified aliases unchanged",
  async (patch) => {
    const { body } = await capture(patch);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  },
);

it("does not treat the old internal reasoning flag as disabling Ark thinking", async () => {
  const { body } = await capture(
    {},
    { providerOptions: { doca: { reasoning: false } } },
  );
  expect(body.reasoning_effort).toBe("low");
  expect(body.thinking).toBeUndefined();
  expect(body.reasoning).toBe(false);
});

it.each([400, 422])(
  "reports effort rejection %s without a parameter-free retry",
  async (status) => {
    const bodies: Record<string, any>[] = [];
    const sdk = createAIModel(model, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          error: {
            message: "mock effort rejection",
            type: "invalid_request_error",
          },
        }),
        {
          status,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    await expect(
      sdk.doGenerate({ prompt, maxOutputTokens: 12000 }),
    ).rejects.toMatchObject({ statusCode: status });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning_effort).toBe("low");
  },
);

it("sends the same native effort in streaming SDK requests and retains raw usage", async () => {
  const bodies: Record<string, any>[] = [];
  const chunks = [
    {
      id: "mock",
      created: 1,
      model: "mock",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    },
    { id: "mock", created: 1, model: "mock", choices: [], usage: answer.usage },
  ];
  const sdk = createAIModel(model, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n",
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  });
  const { stream } = await sdk.doStream({ prompt, maxOutputTokens: 12000 });
  const reader = stream.getReader();
  const events: any[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    events.push(next.value);
  }
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    reasoning_effort: "low",
    stream: true,
    stream_options: { include_usage: true },
  });
  const finish = events.find((event) => event.type === "finish");
  expect(finish.usage.raw).toEqual(answer.usage);
  expect(finish.usage.outputTokens.reasoning).toBe(4);
});
