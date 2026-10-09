import { expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AIModel } from "@core/modules/ai/config.js";
import { createAIModel } from "../apps/server/src/services/ai/providers.js";

const model: AIModel = {
  id: "kimi-wire-test",
  provider: "doubao",
  model: "kimi-k3",
  alias: "Mock Kimi Plan",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  apiKey: "mock-only",
  enabled: true,
  tools: true,
  vision: true,
  maxInput: 1048576,
  maxOutput: 32768,
};
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Read the source before editing." }] }];
const usage = {
  prompt_tokens: 91,
  completion_tokens: 18,
  completion_tokens_details: { reasoning_tokens: 12 },
};
const answer = {
  id: "kimi-mock",
  object: "chat.completion",
  created: 1,
  model: "kimi-k3",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", reasoning_content: "Source checked.", content: "Done." } }],
  usage,
};

async function request(patch: Partial<AIModel> = {}, options: any = {}) {
  const bodies: any[] = [];
  const sdk = createAIModel({ ...model, ...patch }, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(answer);
  });
  const result = await sdk.doGenerate({ prompt, maxOutputTokens: 32768, ...options });
  expect(bodies).toHaveLength(1);
  return { body: bodies[0], result };
}

it("uses native low effort and the full configured output budget on the explicit Kimi Plan model", async () => {
  const providerOptions = { doca: { user: "isolated-user" } };
  const { body, result } = await request({ baseUrl: `${model.baseUrl}/` }, { providerOptions });
  expect(body).toMatchObject({ model: "kimi-k3", reasoning_effort: "low", max_tokens: 32768, user: "isolated-user" });
  expect(body.thinking).toBeUndefined();
  expect(body.max_completion_tokens).toBeUndefined();
  expect(providerOptions).toEqual({ doca: { user: "isolated-user" } });
  expect(result.content).toContainEqual(expect.objectContaining({ type: "reasoning", text: "Source checked." }));
  expect(result.usage.raw).toEqual(usage);
  expect(result.usage.outputTokens).toMatchObject({ total: 18, reasoning: 12 });
});

it.each([
  { providerOptions: { doca: { reasoningEffort: "high" } } },
  { providerOptions: { openaiCompatible: { reasoningEffort: "max" } } },
  { reasoning: "high" },
])("preserves an explicit Kimi reasoning effort", async (options) => {
  const { body } = await request({}, options);
  expect(body.reasoning_effort).toBe("reasoning" in options ? "high" : Object.values(options.providerOptions!)[0].reasoningEffort);
  expect(body.thinking).toBeUndefined();
});

it.each([
  { provider: "moonshot" as const },
  { provider: "compatible" as const },
  { model: "kimi-k2.5" },
  { model: "kimi-k3-unknown" },
  { model: "ep-private-kimi-deployment" },
  { baseUrl: "https://gateway.example.invalid/api/plan/v3" },
  { baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3" },
  { baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3?version=old" },
])("does not infer Kimi deployment identity or expand the approved endpoint", async (patch) => {
  const { body } = await request(patch);
  expect(body.reasoning_effort).toBeUndefined();
  expect(body.thinking).toBeUndefined();
});

it.each([400, 422, 429])("does not retry Kimi parameter or quota rejection %s", async (status) => {
  let requests = 0;
  const sdk = createAIModel(model, async (_url, init) => {
    requests++;
    expect(JSON.parse(String(init?.body)).reasoning_effort).toBe("low");
    return Response.json({ error: { message: "Explicit test rejection", type: "invalid_request_error" } }, { status });
  });
  await expect(sdk.doGenerate({ prompt, maxOutputTokens: 32768 })).rejects.toMatchObject({ statusCode: status });
  expect(requests).toBe(1);
});

it("preserves returned reasoning, tool arguments and call IDs through the next real SDK request", async () => {
  const bodies: any[] = [];
  const sdk = createAIModel(model, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1) return Response.json({
      ...answer,
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: "I will inspect the original.",
        reasoning_content: "A source character may be a bystander. Read the original before deciding.",
        tool_calls: [{ id: "source-call-1", type: "function", function: { name: "read_source", arguments: '{"page":10}' } }],
      } }],
    });
    return Response.json(answer);
  });
  const tools = [{ type: "function" as const, name: "read_source", description: "Read a real source page", inputSchema: { type: "object", properties: { page: { type: "integer" } }, required: ["page"], additionalProperties: false } }];
  const first = await sdk.doGenerate({ prompt, tools, toolChoice: { type: "auto" }, maxOutputTokens: 32768 });
  const call = first.content.find((part) => part.type === "tool-call");
  expect(call).toMatchObject({ toolCallId: "source-call-1", toolName: "read_source", input: '{"page":10}' });
  if (!call || call.type !== "tool-call") throw Error("Missing tool call");
  await sdk.doGenerate({ prompt: [
    ...prompt,
    { role: "assistant", content: first.content.map((part) => part.type === "tool-call" ? { ...part, input: JSON.parse(part.input) } : part) },
    { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "json", value: { page: 10, checked: true } } }] },
  ], tools, maxOutputTokens: 32768 } as any);
  expect(bodies).toHaveLength(2);
  expect(bodies.every((body) => body.reasoning_effort === "low")).toBe(true);
  expect(bodies[1].messages[1]).toEqual({
    role: "assistant", content: "I will inspect the original.",
    reasoning_content: "A source character may be a bystander. Read the original before deciding.",
    tool_calls: [{ id: "source-call-1", type: "function", function: { name: "read_source", arguments: '{"page":10}' } }],
  });
  expect(bodies[1].messages[2]).toMatchObject({ role: "tool", tool_call_id: "source-call-1" });
});

it("retains streaming reasoning and actual token usage while sending the same Kimi effort", async () => {
  let body: any;
  const chunks = [
    { id: "kimi-stream", created: 1, model: "kimi-k3", choices: [{ index: 0, delta: { reasoning_content: "Source checked." }, finish_reason: null }] },
    { id: "kimi-stream", created: 1, model: "kimi-k3", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] },
    { id: "kimi-stream", created: 1, model: "kimi-k3", choices: [], usage },
  ];
  const sdk = createAIModel(model, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const { stream } = await sdk.doStream({ prompt, maxOutputTokens: 32768 });
  const events: any[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    events.push(next.value);
  }
  expect(body).toMatchObject({ reasoning_effort: "low", max_tokens: 32768, stream: true, stream_options: { include_usage: true } });
  expect(body.thinking).toBeUndefined();
  expect(events).toContainEqual(expect.objectContaining({ type: "reasoning-delta", delta: "Source checked." }));
  expect(events.find((event) => event.type === "finish").usage.raw).toEqual(usage);
});

it("keeps complete thinking and a parsed tool exchange in the current agent loop", async () => {
  const bodies: any[] = [];
  const sourceReads: number[] = [];
  const sdk = createAIModel(model, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return Response.json({
      ...answer,
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: "Read page 10 first.", reasoning_content: "Do not decide family membership without inspecting the actual source.",
        tool_calls: [{ id: "agent-source-1", type: "function", function: { name: "read_source", arguments: '{"page":10}' } }],
      } }],
    });
    return Response.json(answer);
  });
  const readSource = createTool({
    id: "read_source",
    description: "Inspect a source page",
    inputSchema: z.object({ page: z.number().int() }),
    outputSchema: z.object({ inspectedPage: z.number().int() }),
    execute: async ({ page }) => { sourceReads.push(page); return { inspectedPage: page }; },
  });
  const agent = new Agent({ id: "kimi-agent-wire-test", name: "Kimi agent wire test", instructions: "Use read_source before deciding.", model: sdk, tools: { read_source: readSource } });
  const result = await agent.generate("Inspect the original page 10.", { maxSteps: 3, modelSettings: { maxOutputTokens: 32768 } });
  expect(result.text).toBe("Read page 10 first.Done.");
  expect(sourceReads).toEqual([10]);
  expect(bodies).toHaveLength(2);
  expect(bodies.every((body) => body.reasoning_effort === "low")).toBe(true);
  const assistant = bodies[1].messages.find((message: any) => message.role === "assistant");
  expect(assistant).toMatchObject({
    reasoning_content: "Do not decide family membership without inspecting the actual source.",
    tool_calls: [{ id: "agent-source-1", type: "function", function: { name: "read_source", arguments: '{"page":10}' } }],
  });
  const toolResult = bodies[1].messages.find((message: any) => message.role === "tool");
  expect(toolResult).toMatchObject({ tool_call_id: "agent-source-1" });
  expect(JSON.parse(toolResult.content)).toEqual({ inspectedPage: 10 });
});
