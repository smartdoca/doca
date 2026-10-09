import { beforeEach, expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { meteredModel } from "../apps/server/src/services/ai/model.js";

const fixture = vi.hoisted(() => ({
  model: {
    id: "chat",
    model: "fixture",
    baseUrl: "https://fixture.invalid",
    provider: "openai",
    apiMode: "chat",
    apiKey: "fixture-key",
    vision: true,
    pdf: false,
    maxInput: 64000,
    maxOutput: 1000,
  },
  base: {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    doStream: vi.fn(),
    doGenerate: vi.fn(),
  },
  begin: vi.fn(),
  settle: vi.fn(),
}));
vi.mock("@core/modules/ai/config.js", () => ({
  requireInferenceModel: async () => ({ model: fixture.model }),
}));
vi.mock("@core/modules/ai/usage.js", () => ({
  beginCall: (...args: any[]) => fixture.begin(...args),
  settleCall: (...args: any[]) => fixture.settle(...args),
}));
vi.mock("../apps/server/src/services/ai/providers.js", () => ({
  createAIModel: () => fixture.base,
  promptCacheOptions: (_model: unknown, options: unknown) => options,
  modelConnectionError: () => "Fixture connection failed",
  modelConnectionReason: () => ({ code: "fixture_failure" }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.begin.mockResolvedValue({ id: "call" });
  fixture.settle.mockResolvedValue(undefined);
});

const names = [
  "image_generate",
  "image_recompose",
  "image_edit_preview",
  "image_mask_prepare",
  "image_mask_segment",
  "image_mask_compose",
] as const;
const finish = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
};
const diagnostic = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "view",
      toolName: "image_candidate_view",
      output: {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({ generationOperationId: "raw-operation" }),
          },
          { type: "text", text: JSON.stringify({ kind: "image_candidate_view_runtime", frameCount: 3, sceneReferenceImageId: null, sceneStatus: "not-merged", reason: "no-bound-adjacent-scene" }) },
          ...[0, 1, 2].map(() => ({
            type: "file",
            mediaType: "image/jpeg",
            data: { type: "data", data: Buffer.from("fixture-pixels") },
          })),
        ],
      },
    },
  ],
};
const rawCall = (name: string) => ({
  type: "tool-call",
  toolCallId: name,
  toolName: name,
  input: JSON.stringify({ value: name }),
});
const inputStart = (name: string) => ({
  type: "tool-input-start",
  id: name,
  toolName: name,
});
const inputDelta = (name: string) => ({
  type: "tool-input-delta",
  id: name,
  delta: JSON.stringify({ value: name }),
});
const inputEnd = (name: string) => ({ type: "tool-input-end", id: name });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function setup(withObserver = true, scene = false) {
  let controller!: ReadableStreamDefaultController<any>;
  fixture.base.doStream.mockResolvedValue({
    stream: new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
  });
  const state = { shown: 0, aborted: 0, frames: 0 };
  const model = await meteredModel(
    {} as DB,
    "user",
    "chat",
    null,
    undefined,
    undefined,
    undefined,
    (prompt) => {
      const current = structuredClone(diagnostic);
      if (scene) {
        current.content[0]!.output.value[1] = { type: "text", text: JSON.stringify({ kind: "image_candidate_view_runtime", frameCount: 4,
          sceneReferenceImageId: "11111111-1111-4111-8111-111111111111", sceneStatus: "included", reason: null }) };
        current.content[0]!.output.value.push({ type: "file", mediaType: "image/jpeg", data: { type: "data", data: Buffer.from("scene-pixels") } });
      }
      return { prompt: [...prompt, current], protectedPrefix: 0 };
    },
    undefined,
    withObserver
      ? (_prompt, frames) => {
          state.frames = frames.length;
          return {
            complete() {
              state.shown++;
            },
            abort() {
              state.shown = 0;
              state.aborted++;
            },
          };
        }
      : undefined,
  );
  return { model, state, controller };
}

async function actualAgent(abortSignal?: AbortSignal, scene = false) {
  const setupResult = await setup(true, scene);
  const executions: { name: string; value: string; shown: number }[] = [];
  const agent = new Agent({
    id: "visual-proof-stream-test",
    name: "Visual proof stream test",
    instructions: "Execute the requested test tools.",
    model: setupResult.model as any,
    tools: Object.fromEntries(
      names.map((name) => [
        name,
        createTool({
          id: name,
          description:
            "Local fixture; never invokes a provider or writes data.",
          inputSchema: z.object({ value: z.string() }).strict(),
          execute: async ({ value }) => {
            executions.push({ name, value, shown: setupResult.state.shown });
            return { completed: true };
          },
        }),
      ]),
    ),
  });
  const output = await agent.stream("Verify the fixture tools", {
    maxSteps: 1,
    abortSignal,
    modelSettings: { maxRetries: 0 },
  });
  const chunks: any[] = [],
    errors: unknown[] = [];
  const drain = (async () => {
    try {
      for await (const chunk of output.fullStream) chunks.push(chunk);
    } catch (error) {
      errors.push(error);
    }
  })();
  await vi.waitFor(() => expect(fixture.base.doStream).toHaveBeenCalledOnce());
  setupResult.controller.enqueue({ type: "stream-start", warnings: [] });
  return { ...setupResult, executions, chunks, errors, drain };
}

it.each([false, true])("withholds synthetic and formal calls through actual Mastra until successful finish and EOF, then executes every tool exactly once with scene=%s", async scene => {
  const run = await actualAgent(undefined, scene);
  for (const name of names) {
    run.controller.enqueue(inputStart(name));
    run.controller.enqueue(inputDelta(name));
    run.controller.enqueue(inputEnd(name));
    run.controller.enqueue(rawCall(name));
  }
  await tick();
  expect(run.state.frames).toBe(scene ? 4 : 3);
  const providerRequest = JSON.stringify(
    fixture.base.doStream.mock.calls[0]![0],
  );
  expect(providerRequest).not.toContain("sourceDigest");
  expect(providerRequest).not.toContain("frameIndex");
  expect(run.chunks.some((chunk) => chunk.type === "tool-call-delta")).toBe(
    true,
  );
  expect(run.chunks.some((chunk) => chunk.type === "tool-call")).toBe(false);
  expect(run.executions).toEqual([]);
  expect(run.state.shown).toBe(0);
  run.controller.enqueue(finish);
  await tick();
  expect(run.executions).toEqual([]);
  expect(run.state.shown).toBe(0);
  run.controller.close();
  await run.drain;
  expect(run.errors).toEqual([]);
  expect(run.state.shown).toBe(1);
  expect(run.executions).toEqual(
    names.map((name) => ({ name, value: name, shown: 1 })),
  );
  expect(run.chunks.filter((chunk) => chunk.type === "tool-call")).toHaveLength(
    names.length,
  );
});

it.each(["soft-error", "abort", "missing-finish", "after-finish-truncation"])(
  "does not run paid generation, local recomposition or preview through Mastra after %s",
  async (kind) => {
    const abort = new AbortController();
    const run = await actualAgent(abort.signal, true);
    for (const name of names) {
      run.controller.enqueue(inputStart(name));
      run.controller.enqueue(inputDelta(name));
      run.controller.enqueue(inputEnd(name));
      run.controller.enqueue(rawCall(name));
    }
    await tick();
    expect(run.executions).toEqual([]);
    expect(run.chunks.some((chunk) => chunk.type === "tool-call")).toBe(false);
    if (kind === "soft-error")
      run.controller.enqueue({
        type: "error",
        error: new Error("fixture provider error"),
      });
    if (kind === "abort") abort.abort();
    if (kind !== "missing-finish") run.controller.enqueue(finish);
    if (kind === "after-finish-truncation") {
      await tick();
      run.controller.error(new Error("fixture truncated transport"));
    } else run.controller.close();
    await run.drain;
    expect(run.state.shown).toBe(0);
    expect(run.state.aborted).toBeGreaterThan(0);
    expect(run.executions).toEqual([]);
    expect(
      run.chunks.some(
        (chunk) =>
          chunk.type === "tool-call-input-streaming-end" ||
          chunk.type === "tool-call",
      ),
    ).toBe(false);
  },
);

it("preserves the original executable-tail ordering at the raw wrapper boundary", async () => {
  const { model, controller, state } = await setup();
  const result = await model.doStream({ prompt: [] } as any);
  const reader = result.stream.getReader();
  controller.enqueue(inputStart("image_generate"));
  controller.enqueue(inputDelta("image_generate"));
  expect((await reader.read()).value?.type).toBe("tool-input-start");
  expect((await reader.read()).value?.type).toBe("tool-input-delta");
  const tail = [
    inputEnd("image_generate"),
    { type: "text-delta", id: "text", delta: "tail" },
    rawCall("image_generate"),
    finish,
  ];
  for (const chunk of tail) controller.enqueue(chunk);
  const received: any[] = [];
  const drain = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received.push(chunk.value);
    }
  })();
  await tick();
  expect(received).toEqual([]);
  expect(state.shown).toBe(0);
  controller.close();
  await drain;
  expect(received).toEqual(tail);
  expect(state.shown).toBe(1);
});

it("keeps ordinary no-observer tool-input-end streaming behavior unchanged", async () => {
  const { model, controller } = await setup(false);
  const result = await model.doStream({ prompt: [] } as any);
  const reader = result.stream.getReader();
  controller.enqueue(inputEnd("image_generate"));
  expect((await reader.read()).value?.type).toBe("tool-input-end");
  controller.enqueue(finish);
  controller.close();
  expect((await reader.read()).value?.type).toBe("finish");
  expect((await reader.read()).done).toBe(true);
});
