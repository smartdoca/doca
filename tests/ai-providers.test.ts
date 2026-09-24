import { expect, it } from "vitest";
import {
  createAIModel,
  discoverAIModels,
} from "../apps/server/src/services/ai/providers.js";
import { usageOf } from "../apps/server/src/services/ai/model.js";
import type { AIModel } from "@core/modules/ai/config.js";
const model: AIModel = {
  id: "test",
  model: "test-model",
  alias: "Test",
  baseUrl: "https://api.example.test/v1",
  apiKey: "secret-test-key",
  enabled: true,
  levels: [],
  inputRate: 1,
  outputRate: 2,
  cacheRate: 0.5,
  maxInput: 32000,
  maxOutput: 1000,
  tools: true,
};
const responses = {
  id: "resp_test",
  object: "response",
  created_at: 1,
  model: "test-model",
  status: "completed",
  output: [
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};
const chat = {
  id: "chat_test",
  object: "chat.completion",
  created: 1,
  model: "test-model",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "ok" },
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 40,
    total_tokens: 140,
    prompt_tokens_details: { cached_tokens: 20 },
  },
};
it.each([
  {
    provider: "openai",
    suffix: "/responses",
    body: responses,
    header: "authorization",
    key: "Bearer secret-test-key",
  },
  {
    provider: "openai",
    apiMode: "chat",
    suffix: "/chat/completions",
    body: chat,
    header: "authorization",
    key: "Bearer secret-test-key",
  },
  {
    provider: "anthropic",
    suffix: "/messages",
    body: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 80,
        output_tokens: 40,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
      },
    },
    header: "x-api-key",
    key: "secret-test-key",
  },
  {
    provider: "google",
    suffix: "/models/test-model:generateContent",
    body: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 40,
        totalTokenCount: 140,
        cachedContentTokenCount: 20,
      },
    },
    header: "x-goog-api-key",
    key: "secret-test-key",
  },
  {
    provider: "azure",
    suffix: "/responses",
    body: responses,
    header: "api-key",
    key: "secret-test-key",
  },
  {
    provider: "deepseek",
    suffix: "/chat/completions",
    body: chat,
    header: "authorization",
    key: "Bearer secret-test-key",
  },
] as const)(
  "normalizes $provider $apiMode requests and billing",
  async (item) => {
    let request: any;
    const fetcher = (async (url, init) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify(item.body), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const m = createAIModel(
      {
        ...model,
        provider: item.provider,
        apiMode: "apiMode" in item ? item.apiMode : undefined,
      },
      fetcher,
    );
    const output = await m.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      maxOutputTokens: 40,
    });
    expect(request.url).toContain(item.suffix);
    expect(request.headers.get(item.header)).toBe(item.key);
    expect(output.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "ok" }),
    );
    expect(usageOf(output.usage)).toMatchObject({
      input: 100,
      output: 40,
      cached: 20,
    });
  },
);
it("uses Azure deployment URLs when a versioned chat API is configured", async () => {
  let url = "";
  await createAIModel(
    {
      ...model,
      provider: "azure",
      apiMode: "chat",
      apiVersion: "2024-10-21",
      baseUrl: "https://example.openai.azure.com/openai",
    },
    (async (input) => {
      url = String(input);
      return Response.json(chat);
    }) as typeof fetch,
  ).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  expect(url).toContain(
    "/deployments/test-model/chat/completions?api-version=2024-10-21",
  );
});
it("normalizes catalog IDs and does not forward redirects", async () => {
  const catalog = await discoverAIModels(
    { ...model, provider: "google" },
    (async (url, init) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(
        model.apiKey,
      );
      return Response.json({
        models: [{ name: "models/gemini-test", displayName: "Gemini test" }],
      });
    }) as typeof fetch,
  );
  expect(catalog.models).toEqual([{ id: "gemini-test", name: "Gemini test" }]);
});

it("uses a minimal plain-text connection probe regardless of model capabilities", async () => {
  const { testAIModel } = await import("../apps/server/src/services/ai/providers.js");
  const requests: any[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (
      body.tool_choice?.type === "function" &&
      body.thinking?.type !== "disabled"
    )
      return Response.json(
        {
          error: { message: "Thinking mode does not support this tool_choice" },
        },
        { status: 400 },
      );
    return Response.json(chat);
  }) as typeof fetch;
  const deepseek = { ...model, provider: "deepseek" as const };
  await testAIModel(deepseek, fetcher);
  expect(requests[0].tools).toBeUndefined();
  expect(requests[0].tool_choice).toBeUndefined();
  expect(requests[0].thinking).toBeUndefined();
  await createAIModel(deepseek, fetcher).doGenerate({
    prompt: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "previous provider reasoning" },
          { type: "text", text: "ok" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ],
  });
  expect(requests[1].thinking).toBeUndefined();
  expect(requests[1].messages[0].reasoning_content).toBe(
    "previous provider reasoning",
  );
  await testAIModel({ ...deepseek, tools: false }, fetcher);
  expect(requests[2].tools).toBeUndefined();
});

it("degrades the connection probe when a vendor rejects optional parameters", async () => {
  const { testAIModel } = await import("../apps/server/src/services/ai/providers.js");
  const requests: any[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (body.max_tokens != null)
      return Response.json(
        {
          error: {
            message:
              "The parameter `max_tokens` specified in the request is not supported for kimi-k3",
          },
        },
        { status: 400 },
      );
    return Response.json(chat);
  }) as typeof fetch;
  const result = await testAIModel(
    { ...model, provider: "doubao", model: "kimi-k3" },
    fetcher,
  );
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "ok" }),
  );
  expect(requests).toHaveLength(2);
  expect(requests[0].max_tokens).toBe(128);
  expect(requests[1].max_tokens).toBeUndefined();
  expect(requests[1].tools).toBeUndefined();
});

it("surfaces the vendor error without leaking the configured key", async () => {
  const { modelConnectionDetail } =
    await import("../apps/server/src/services/ai/providers.js");
  const error = {
    statusCode: 400,
    message:
      "The parameter `tool_choice` is invalid for kimi-k3. Authorization: Bearer secret-test-key",
  };
  const detail = modelConnectionDetail(error, { apiKey: "secret-test-key" });
  expect(detail).toContain("tool_choice");
  expect(detail).toContain("kimi-k3");
  expect(detail).not.toContain("secret-test-key");
  expect(modelConnectionDetail(new Error(), { apiKey: "k" })).toBe("");
});

it("reports connection categories without leaking provider request details", async () => {
  const { modelConnectionError } =
    await import("../apps/server/src/services/ai/providers.js");
  for (const statusCode of [400, 401, 402, 403, 404, 422, 429, 500, 503]) {
    const message = modelConnectionError({
      statusCode,
      message: "Authorization: Bearer secret-test-key",
    });
    expect(message).not.toContain("secret-test-key");
    expect(message).toContain(String(statusCode));
  }
  expect(modelConnectionError({ name: "TimeoutError" })).toContain("超时");
  expect(modelConnectionError({ message: "Invalid JSON response" })).toContain(
    "非 JSON",
  );
  const budgetError = modelConnectionError({
    statusCode: 400,
    message:
      "max_tokens: expected a value <= 131072, but got 640000. secret-test-key",
  });
  expect(budgetError).toContain("131,072");
  expect(budgetError).not.toContain("secret-test-key");
});

it("enables Claude automatic caching without adding flags to compatible vendors", async () => {
  const { promptCacheOptions } =
    await import("../apps/server/src/services/ai/providers.js");
  const options = {
    prompt: [
      { role: "system" as const, content: "Stable rules" },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Hello" }],
      },
    ],
  };
  const claude = { ...model, provider: "anthropic" as const };
  let request: any;
  await createAIModel(claude, (async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return Response.json({
      id: "msg_cache",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      },
    });
  }) as typeof fetch)
    .doGenerate(promptCacheOptions(claude, options))
    .then((result) => {
      expect(usageOf(result.usage)).toMatchObject({
        input: 100,
        output: 2,
        cached: 80,
      });
    });
  expect(request.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(request.system[0].text).toBe("Stable rules");
  for (const provider of [
    "deepseek",
    "openai",
    "compatible",
    "google",
  ] as const)
    expect(promptCacheOptions({ ...model, provider }, options)).toBe(options);
  expect(
    promptCacheOptions(
      { ...model, provider: "openai" },
      options,
      "session-1",
    ).providerOptions.openai.promptCacheKey,
  ).toBe("session-1");
});

it.each([
  { prompt_cache_hit_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } },
  { prompt_tokens_details: { cached_tokens: 30 } },
  { input_tokens_details: { cached_tokens: 30 } },
  { cache_read_input_tokens: 30 },
])(
  "uses raw vendor cache counts when normalized SDK data omits them: %j",
  (raw) => {
    expect(
      usageOf({
        inputTokens: { total: 100, cacheRead: 0 },
        outputTokens: { total: 10 },
        raw,
      }),
    ).toMatchObject({ input: 100, output: 10, cached: 30 });
  },
);
it("does not treat cache writes as hits or charge malformed cached usage", () => {
  expect(
    usageOf({
      inputTokens: { total: 100, cacheWrite: 60 },
      outputTokens: { total: 10 },
    })?.cached,
  ).toBe(0);
  expect(
    usageOf({
      inputTokens: 100,
      outputTokens: 10,
      raw: { prompt_cache_hit_tokens: -1 },
    }),
  ).toBeNull();
});

it("requests usage for compatible tool streams and reads the final usage-only chunk", async () => {
  let sent: any;
  const m = createAIModel({ ...model, provider: "moonshot" }, (async (
    _url,
    init,
  ) => {
    sent = JSON.parse(String(init?.body));
    const common = {
      id: "tool-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
    };
    const chunks = [
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "document_read",
                    arguments: '{"resourceId":"test"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      { ...common, choices: [], usage: chat.usage },
    ];
    return new Response(
      chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch);
  const result = await m.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Read" }] }],
  });
  const events = [];
  const reader = result.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    events.push(next.value);
  }
  expect(sent.stream_options).toEqual({ include_usage: true });
  const finished = events.find((e) => e.type === "finish");
  expect(usageOf((finished as any)?.usage)).toMatchObject({
    input: 100,
    output: 40,
    cached: 20,
  });
});

it("requests reasoning summaries on the Responses API only for reasoning models", async () => {
  const bodies: any[] = [];
  const fetcher = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(responses);
  }) as typeof fetch;
  const prompt = [
    { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] },
  ];
  await createAIModel(
    { ...model, provider: "openai", model: "gpt-5-mini-reasoning-qa" },
    fetcher,
  ).doGenerate({ prompt });
  expect(bodies[0].reasoning).toEqual({ summary: "auto" });
  await createAIModel(
    { ...model, provider: "openai", model: "gpt-4o-plain-qa" },
    fetcher,
  ).doGenerate({ prompt });
  expect(bodies[1].reasoning).toBeUndefined();
});

it("streams Responses API reasoning summaries as reasoning deltas", async () => {
  const reasoningItem = {
    id: "rs_stream",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "先分析再回答" }],
  };
  const messageItem = {
    id: "msg_stream",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "答案", annotations: [] }],
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_stream", created_at: 1, model: "gpt-5-stream-qa" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_stream", type: "reasoning" },
    },
    {
      type: "response.reasoning_summary_part.added",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
      delta: "先分析",
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
      delta: "再回答",
    },
    {
      type: "response.reasoning_summary_part.done",
      item_id: "rs_stream",
      output_index: 0,
      summary_index: 0,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...reasoningItem, encrypted_content: null },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_stream",
      output_index: 1,
      content_index: 0,
      delta: "答案",
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: messageItem,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_stream",
        created_at: 1,
        model: "gpt-5-stream-qa",
        status: "completed",
        output: [reasoningItem, messageItem],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
          input_tokens_details: { cached_tokens: 20 },
        },
      },
    },
  ];
  let request: any;
  const m = createAIModel(
    { ...model, provider: "openai", model: "gpt-5-stream-qa" },
    (async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  );
  const result = await m.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  const parts = [];
  const reader = result.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  expect(request.reasoning).toEqual({ summary: "auto" });
  const reasoning = parts
    .filter((p) => p.type === "reasoning-delta")
    .map((p: any) => p.delta)
    .join("");
  expect(reasoning).toBe("先分析再回答");
  expect(
    parts
      .filter((p) => p.type === "text-delta")
      .map((p: any) => p.delta)
      .join(""),
  ).toBe("答案");
  const finished = parts.find((p) => p.type === "finish");
  expect(usageOf((finished as any)?.usage)).toMatchObject({
    input: 100,
    output: 40,
    cached: 20,
  });
});

it("falls back to Chat Completions once when an endpoint has no Responses API", async () => {
  const urls: string[] = [];
  const fetcher = (async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith("/responses"))
      return Response.json(
        { error: { message: "Unknown request URL" } },
        { status: 404 },
      );
    return Response.json(chat);
  }) as typeof fetch;
  const prompt = [
    { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] },
  ];
  const fallbackModel = {
    ...model,
    provider: "openai" as const,
    model: "endpoint-fallback-qa",
  };
  const output = await createAIModel(fallbackModel, fetcher).doGenerate({
    prompt,
  });
  expect(output.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "ok" }),
  );
  expect(urls[0]).toContain("/responses");
  expect(urls[1]).toContain("/chat/completions");
  // The adaptation is remembered: later calls go straight to Chat Completions.
  await createAIModel(fallbackModel, fetcher).doGenerate({ prompt });
  expect(urls).toHaveLength(3);
  expect(urls[2]).toContain("/chat/completions");
  // An explicit apiMode stays authoritative and never silently degrades.
  await expect(
    createAIModel(
      { ...fallbackModel, model: "endpoint-explicit-qa", apiMode: "responses" },
      fetcher,
    ).doGenerate({ prompt }),
  ).rejects.toMatchObject({ statusCode: 404 });
});

it("falls back when an OpenAI-compatible endpoint returns an invalid Responses body", async () => {
  const urls: string[] = [];
  const fetcher = (async (url) => {
    urls.push(String(url));
    if (String(url).endsWith("/responses"))
      throw Object.assign(new Error("Invalid JSON response"), {
        statusCode: undefined,
      });
    return Response.json(chat);
  }) as typeof fetch;
  const output = await createAIModel(
    { ...model, provider: "openai", model: "agent-plan-qa" },
    fetcher,
  ).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  expect(output.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "ok" }),
  );
  expect(urls).toEqual([
    "https://api.example.test/v1/responses",
    "https://api.example.test/v1/chat/completions",
  ]);
});

it("enables thinking for Claude and Gemini and retries without it when rejected", async () => {
  const anthropicRequests: any[] = [];
  const claude = {
    ...model,
    provider: "anthropic" as const,
    model: "claude-thinking-qa",
  };
  await createAIModel(claude, (async (_url, init) => {
    anthropicRequests.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      model: "claude-thinking-qa",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  }) as typeof fetch).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    maxOutputTokens: 40,
  });
  expect(anthropicRequests[0].thinking).toEqual({
    type: "enabled",
    budget_tokens: 1024,
  });
  expect(anthropicRequests[0].max_tokens).toBe(1064);

  const googleRequests: any[] = [];
  await createAIModel(
    { ...model, provider: "google", model: "gemini-thinking-qa" },
    (async (_url, init) => {
      googleRequests.push(JSON.parse(String(init?.body)));
      return Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
        },
      });
    }) as typeof fetch,
  ).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  expect(googleRequests[0].generationConfig.thinkingConfig).toEqual({
    includeThoughts: true,
  });

  const rejected: any[] = [];
  const legacy = { ...model, provider: "anthropic" as const, model: "claude-legacy-qa" };
  const legacyFetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    rejected.push(body);
    if (body.thinking)
      return Response.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "thinking: Extra inputs are not permitted" },
        },
        { status: 400 },
      );
    return Response.json({
      id: "msg_legacy",
      type: "message",
      role: "assistant",
      model: "claude-legacy-qa",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  }) as typeof fetch;
  const output = await createAIModel(legacy, legacyFetcher).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  expect(output.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "ok" }),
  );
  expect(rejected[0].thinking).toBeDefined();
  expect(rejected[1].thinking).toBeUndefined();
  // The rejection is remembered: the next call omits thinking immediately.
  await createAIModel(legacy, legacyFetcher).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  expect(rejected).toHaveLength(3);
  expect(rejected[2].thinking).toBeUndefined();
});

it("leaves forced tool-choice probes free of reasoning switches", async () => {
  const requests: any[] = [];
  await createAIModel(
    { ...model, provider: "anthropic", model: "claude-probe-qa" },
    (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: "claude-probe-qa",
        content: [
          {
            type: "tool_use",
            id: "toolu_probe",
            name: "doca_connection_check",
            input: { ok: true },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    }) as typeof fetch,
  ).doGenerate({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Call doca_connection_check." }],
      },
    ],
    tools: [
      {
        type: "function" as const,
        name: "doca_connection_check",
        description: "Non-mutating connection check",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    toolChoice: { type: "tool" as const, toolName: "doca_connection_check" },
  });
  expect(requests[0].tool_choice).toEqual({
    type: "tool",
    name: "doca_connection_check",
  });
  expect(requests[0].thinking).toBeUndefined();
});
