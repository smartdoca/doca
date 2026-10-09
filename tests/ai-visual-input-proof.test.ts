import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { DB } from "@db/index.js";
import { meteredModel } from "../apps/server/src/services/ai/model.js";
import { modelPromptImages } from "../apps/server/src/services/ai/model-image.js";
import { fitPromptToModelInput } from "../apps/server/src/services/ai/context-budget.js";
import {
  bindToolImageFrames,
  hoistToolImages,
  inspectionFrameDigests,
  transmittedToolImageFrames,
  type ToolImageSelection,
} from "../apps/server/src/services/ai/tool-media.js";

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
  base: { doStream: vi.fn(), doGenerate: vi.fn() },
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
  fixture.model.maxInput = 64000;
  fixture.begin.mockResolvedValue({ id: "call" });
  fixture.settle.mockResolvedValue(undefined);
});
const frame = (name: string, value = "pixels") => ({
  type: "file",
  mediaType: "image/jpeg",
  data: { type: "data", data: Buffer.from(value) },
  filename: name,
});
const currentCandidateGroup = () => ({
  type: "text",
  text: JSON.stringify({
    kind: "image_candidate_view_runtime",
    frameCount: 3,
    sceneReferenceImageId: null,
    sceneStatus: "not-merged",
    reason: "no-bound-adjacent-scene",
  }),
});
const tool = (id: string) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolName: "image_candidate_view",
      toolCallId: id,
      output: {
        type: "content",
        value: [
          { type: "text", text: JSON.stringify({ generationOperationId: id }) },
          currentCandidateGroup(),
          frame(`${id}-source`),
          frame(`${id}-raw`),
          frame(`${id}-projection`),
        ],
      },
    },
  ],
});

const diagnosticTool = (
  name:
    | "image_candidate_view"
    | "image_edit_preview"
    | "image_mask_prepare"
    | "image_mask_segment",
  id: string,
  padding = "",
) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolName: name,
      toolCallId: id,
      output: {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              generationOperationId: id,
              referenceImageId: `${id}-source`,
              details: padding,
            }),
          },
          ...(name === "image_candidate_view" ? [currentCandidateGroup()] : []),
          ...Array.from(
            { length: name === "image_candidate_view" ? 3 : 2 },
            (_, index) => [
              {
                type: "text",
                text: JSON.stringify({
                  label: `${id}-frame-${index}`,
                  sourceRect: { x: index, y: 2, width: 10, height: 20 },
                  contentRect: { x: 0, y: 0, width: 10, height: 20 },
                }),
              },
              frame(`${id}-${index}`),
            ],
          ).flat(),
        ],
      },
    },
  ],
});

it("presents only complete candidate groups and binds identical pixels to their own tool identity and frame multiplicity", () => {
  const selected: ToolImageSelection[] = [];
  const prompt = hoistToolImages([tool("A"), tool("B")], 4, (part) =>
    selected.push(part),
  );
  const frames = transmittedToolImageFrames(
    prompt,
    bindToolImageFrames(selected, prompt),
  );
  expect(
    frames.map((frame) => [
      frame.facts.generationOperationId,
      frame.frameIndex,
    ]),
  ).toEqual([
    ["A", 0],
    ["A", 1],
    ["A", 2],
  ]);
  expect(inspectionFrameDigests(tool("A").content[0]!.output)).toHaveLength(3);
});

it("does not confirm diagnostic frames removed by actual context fitting", () => {
  const selected: ToolImageSelection[] = [];
  const prompt = hoistToolImages([tool("A")], 4, (part) => selected.push(part));
  const bound = bindToolImageFrames(selected, prompt);
  prompt.at(-1)!.content.unshift({
    type: "text",
    text: "visual exchange context ".repeat(1000),
  });
  prompt.unshift({
    role: "user",
    content: [{ type: "text", text: "older material ".repeat(4000) }],
  });
  prompt.push({
    role: "user",
    content: [{ type: "text", text: "current question" }],
  });
  const fitted = fitPromptToModelInput(prompt, 1000);
  expect(transmittedToolImageFrames(fitted, bound)).toEqual([]);
});

it.each([
  "image_candidate_view",
  "image_edit_preview",
  "image_mask_prepare",
  "image_mask_segment",
] as const)(
  "does not confirm %s when actual fitting truncates its metadata but retains every image",
  (name) => {
    const selected: ToolImageSelection[] = [];
    const second = diagnosticTool(name, "B");
    if (name === "image_candidate_view") {
      second.content[0]!.toolName = "image_view" as typeof name;
      const values = second.content[0]!.output.value;
      // A regular single-image view has no candidate group declaration.
      second.content[0]!.output.value = [values[0]!, values[2]!, values[3]!];
    }
    const prompt = hoistToolImages(
      [diagnosticTool(name, "A", "x".repeat(7000)), second],
      4,
      (part) => selected.push(part),
    );
    const bound = bindToolImageFrames(selected, prompt);
    const fitted = fitPromptToModelInput(prompt, 1000);
    expect(fitted[0].content[0].output.value).toEqual([
      { type: "text", text: expect.stringContaining("[truncated]") },
    ]);
    expect(
      fitted.at(-1).content.filter((part: any) => part.type === "file"),
    ).toHaveLength(4);
    const transmitted = transmittedToolImageFrames(fitted, bound);
    expect(
      transmitted.some((part) => part.facts.generationOperationId === "A"),
    ).toBe(false);
    expect(transmitted.map((part) => part.facts.generationOperationId)).toEqual(
      name === "image_candidate_view" ? ["B"] : ["B", "B"],
    );
  },
);

it.each([
  "image_candidate_view",
  "image_edit_preview",
  "image_mask_prepare",
  "image_mask_segment",
] as const)(
  "does not confirm %s if only the frame label or window coordinates change",
  (name) => {
    const selected: ToolImageSelection[] = [];
    const prompt = hoistToolImages([diagnosticTool(name, "A")], 4, (part) =>
      selected.push(part),
    );
    const bound = bindToolImageFrames(selected, prompt);
    expect(transmittedToolImageFrames(prompt, bound)).toHaveLength(
      name === "image_candidate_view" ? 3 : 2,
    );
    prompt[0].content[0].output.value[1].text = JSON.stringify({
      label: "different frame",
      sourceRect: { x: 100, y: 2, width: 10, height: 20 },
      contentRect: { x: 0, y: 0, width: 10, height: 20 },
    });
    expect(transmittedToolImageFrames(prompt, bound)).toEqual([]);
  },
);

it.each([
  "image_candidate_view",
  "image_edit_preview",
  "image_mask_prepare",
  "image_mask_segment",
] as const)(
  "does not let another tool identity supply the same %s metadata and pixels",
  (name) => {
    const selected: ToolImageSelection[] = [];
    const prompt = hoistToolImages([diagnosticTool(name, "A")], 4, (part) =>
      selected.push(part),
    );
    const bound = bindToolImageFrames(selected, prompt);
    prompt[0].content[0].toolCallId = "replacement";
    expect(transmittedToolImageFrames(prompt, bound)).toEqual([]);
  },
);

it("does not confirm surviving pixels after actual context fitting removes their tool receipt", () => {
  const selected: ToolImageSelection[] = [];
  const prompt = hoistToolImages(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "older original context ".repeat(1000) },
        ],
      },
      diagnosticTool("image_candidate_view", "A"),
    ],
    4,
    (part) => selected.push(part),
  );
  const bound = bindToolImageFrames(selected, prompt);
  const fitted = fitPromptToModelInput(prompt, 1000);
  expect(fitted.some((message: any) => message.role === "tool")).toBe(false);
  expect(
    fitted.at(-1).content.filter((part: any) => part.type === "file"),
  ).toHaveLength(3);
  expect(transmittedToolImageFrames(fitted, bound)).toEqual([]);
});

it("refuses replaced or mutated frames even when text claims the original candidate", () => {
  const selected: ToolImageSelection[] = [];
  const prompt = hoistToolImages([tool("A")], 4, (part) => selected.push(part));
  const bound = bindToolImageFrames(selected, prompt);
  const images = prompt
    .at(-1)!
    .content.filter((part: any) => part.type === "file");
  images[1].data = { type: "data", data: Buffer.from("replacement") };
  images[2].data.data[0] = 0;
  expect(
    transmittedToolImageFrames(prompt, bound).map((frame) => frame.frameIndex),
  ).toEqual([0]);
});

it("tracks the normalized JPEG as a transformation of the correct original diagnostic frame", async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const input = tool("A");
  for (const part of input.content[0]!.output.value)
    if (part.type === "file") {
      (part as any).mediaType = "image/png";
      (part as any).data.data = png;
    }
  const selected: ToolImageSelection[] = [];
  const prompt = hoistToolImages([input], 4, (part) => selected.push(part));
  const normalized = await modelPromptImages(prompt);
  const frames = transmittedToolImageFrames(
    normalized,
    bindToolImageFrames(selected, normalized),
  );
  expect(frames).toHaveLength(3);
  expect(
    frames.every((frame) => frame.facts.generationOperationId === "A"),
  ).toBe(true);
  expect(
    normalized
      .at(-1)!
      .content.filter((part: any) => part.type === "file")
      .every((part: any) => part.mediaType === "image/jpeg"),
  ).toBe(true);
});

async function observedModel() {
  const state = { shown: 0, aborted: 0, frames: 0 };
  const model = await meteredModel(
    {} as DB,
    "user",
    "chat",
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (_prompt, frames) => {
      state.frames = frames.length;
      return {
        complete: () => {
          state.shown++;
        },
        abort: () => {
          state.aborted++;
          state.shown = 0;
        },
      };
    },
  );
  return { model, state };
}
const finish = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage: { inputTokens: 10, outputTokens: 5 },
};
const call = {
  type: "tool-call",
  toolCallId: "edit",
  toolName: "image_generate",
  input: "{}",
};
function providerStream() {
  let controller!: ReadableStreamDefaultController<any>;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  fixture.base.doStream.mockResolvedValue({ stream });
  return () => controller;
}
const waitTick = () => new Promise((resolve) => setTimeout(resolve, 10));

it.each(["error-event", "error-finish"])(
  "drops complete paid calls and clears proof for %s before stream completion",
  async (kind) => {
    const producer = providerStream(),
      { model, state } = await observedModel();
    const output = await model.doStream({ prompt: [tool("A")] } as any),
      reader = output.stream.getReader();
    producer().enqueue(call);
    const chunks: any[] = [];
    const drain = (async () => {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
      }
    })();
    await waitTick();
    if (kind === "error-event")
      producer().enqueue({ type: "error", error: new Error("fixture") });
    producer().enqueue(
      kind === "error-finish"
        ? { ...finish, finishReason: { unified: "error", raw: "error" } }
        : finish,
    );
    producer().close();
    await drain;
    expect(chunks.some((chunk) => chunk.type === "tool-call")).toBe(false);
    expect(state.shown).toBe(0);
    expect(state.aborted).toBeGreaterThan(0);
  },
);

it("discards a pending executable call and visual proof when the consumer cancels the provider stream", async () => {
  const producer = providerStream(),
    { model, state } = await observedModel();
  const output = await model.doStream({ prompt: [tool("A")] } as any),
    reader = output.stream.getReader();
  producer().enqueue(call);
  const next = reader.read();
  await waitTick();
  await reader.cancel("cancelled fixture");
  expect((await next).done).toBe(true);
  expect(state.shown).toBe(0);
  expect(state.aborted).toBeGreaterThan(0);
});

it("does not release a complete paid call after request abort even if the provider still sends finish", async () => {
  const producer = providerStream(),
    { model, state } = await observedModel(),
    abort = new AbortController();
  const output = await model.doStream({
      prompt: [tool("A")],
      abortSignal: abort.signal,
    } as any),
    reader = output.stream.getReader();
  producer().enqueue(call);
  const next = reader.read();
  await waitTick();
  abort.abort();
  producer().enqueue(finish);
  producer().close();
  expect((await next).value?.type).toBe("finish");
  expect(state.shown).toBe(0);
  expect(state.aborted).toBeGreaterThan(0);
});

it("does not commit visual proof or release paid calls when the provider stream fails after its finish chunk", async () => {
  const producer = providerStream(),
    { model, state } = await observedModel();
  const output = await model.doStream({ prompt: [tool("A")] } as any),
    reader = output.stream.getReader();
  producer().enqueue(call);
  producer().enqueue(finish);
  const next = reader.read();
  await waitTick();
  expect(state.shown).toBe(0);
  producer().error(new Error("truncated provider stream"));
  await expect(next).rejects.toThrow("truncated provider stream");
  expect(state.shown).toBe(0);
  expect(state.aborted).toBeGreaterThan(0);
});

it("rejects an oversized final prompt before the provider or visual confirmation is invoked", async () => {
  fixture.model.maxInput = 1000;
  const { model, state } = await observedModel();
  await expect(
    model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "x".repeat(10000) }] },
      ],
    } as any),
  ).rejects.toThrow("当前上下文过长");
  expect(fixture.base.doStream).not.toHaveBeenCalled();
  expect(state.shown).toBe(0);
});
