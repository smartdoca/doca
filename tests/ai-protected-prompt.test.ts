import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { DB } from "@db/index.js";
import { meteredModel } from "../apps/server/src/services/ai/model.js";
import {
  exceedsModelInput,
  fitPromptToModelInput,
} from "../apps/server/src/services/ai/context-budget.js";
import { hoistToolImages } from "../apps/server/src/services/ai/tool-media.js";

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
    maxInput: 1000,
    maxOutput: 100,
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
  fixture.model.maxInput = 1000;
  fixture.begin.mockResolvedValue({ id: "call" });
  fixture.settle.mockResolvedValue(undefined);
  fixture.base.doGenerate.mockResolvedValue({
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
});

const textMessage = (role: string, text: string) => ({
  role,
  content: [{ type: "text", text }],
});
const taskPrefix = () => [
  textMessage(
    "system",
    "Host instructions: use the formal user task and fixed criteria.",
  ),
  textMessage(
    "user",
    "Original formal request: replace Kipper with Zeze. Preserve every other person.",
  ),
  textMessage(
    "user",
    'Frozen criteria: {"identity":"Zeze","allPages":95,"text":"complete"}',
  ),
  textMessage(
    "user",
    "Current formal feedback: book two page three must wave and say Yes, it is Zeze.",
  ),
];
const candidateResult = (data = Buffer.from("pixels")) => ({
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
            text: JSON.stringify({ generationOperationId: "operation" }),
          },
          {
            type: "text",
            text: JSON.stringify({
              kind: "image_candidate_view_runtime",
              frameCount: 3,
              sceneReferenceImageId: null,
              sceneStatus: "not-merged",
              reason: "no-bound-adjacent-scene",
            }),
          },
          ...Array.from({ length: 3 }, () => ({
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data },
          })),
        ],
      },
    },
  ],
});
const exchange = (id: string, padding = "") => [
  {
    role: "assistant",
    content: [
      { type: "text", text: padding },
      {
        type: "tool-call",
        toolName: "file_read",
        toolCallId: id,
        input: { fileId: id },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "file_read",
        toolCallId: id,
        output: { type: "json", value: { fileId: id, complete: true } },
      },
    ],
  },
];
const assertCompleteToolPairs = (prompt: any[]) => {
  const parts = prompt.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const calls = parts
    .filter((part) => part.type === "tool-call")
    .map((part) => part.toolCallId)
    .sort();
  const results = parts
    .filter((part) => part.type === "tool-result")
    .map((part) => part.toolCallId)
    .sort();
  expect(calls).toEqual(results);
};

it("preserves the formal request, frozen criteria and current feedback when media hoisting creates a newer user turn", () => {
  const prefix = taskPrefix();
  const before = JSON.stringify(prefix);
  const prompt = hoistToolImages([
    ...prefix,
    ...exchange("old", "old reasoning ".repeat(1000)),
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolName: "image_candidate_view",
          toolCallId: "view",
          input: {},
        },
      ],
    },
    candidateResult(),
  ]);
  const fitted = fitPromptToModelInput(prompt, 1000, undefined, prefix.length);
  expect(exceedsModelInput(fitted, 1000)).toBe(false);
  expect(fitted.slice(0, prefix.length)).toEqual(prefix);
  expect(fitted.at(-1)?.role).toBe("user");
  expect(
    fitted.at(-1)?.content.filter((part: any) => part.type === "file"),
  ).toHaveLength(3);
  expect(JSON.stringify(prefix)).toBe(before);
  assertCompleteToolPairs(fitted);
});

it("compresses only execution history while retaining a surviving complete tool exchange", () => {
  const prefix = taskPrefix();
  const body = [
    textMessage("user", "Older execution material"),
    ...exchange("old", "old reasoning ".repeat(1000)),
    textMessage("user", "Latest diagnostic frame and next action"),
    ...exchange("current"),
  ];
  const fitted = fitPromptToModelInput(
    [...prefix, ...body],
    1000,
    undefined,
    prefix.length,
  );
  expect(fitted.slice(0, prefix.length)).toEqual(prefix);
  expect(JSON.stringify(fitted)).not.toContain("old reasoning");
  expect(JSON.stringify(fitted)).toContain('"toolCallId":"current"');
  assertCompleteToolPairs(fitted);
});

it("includes the immutable prefix and tool definitions in every compression budget decision", () => {
  const prefix = [textMessage("user", "formal requirement ".repeat(100))];
  const prompt = [
    ...prefix,
    textMessage("assistant", "old execution ".repeat(1000)),
    textMessage("user", "current visual input"),
  ];
  const tools = [
    { type: "function", name: "edit", description: "tool guide ".repeat(300) },
  ];
  const fitted = fitPromptToModelInput(prompt, 1000, tools, prefix.length);
  expect(fitted.slice(0, prefix.length)).toEqual(prefix);
  expect(exceedsModelInput(fitted, 1000, tools)).toBe(true);
});

it("does not trim a protected structured receipt even when the complete minimum request remains too large", () => {
  const prefix = [
    ...taskPrefix(),
    ...exchange("host-receipt", "formal source evidence ".repeat(1000)),
  ];
  const fitted = fitPromptToModelInput(
    [...prefix, textMessage("user", "current visual input")],
    1000,
    undefined,
    prefix.length,
  );
  expect(fitted.slice(0, prefix.length)).toEqual(prefix);
  expect(exceedsModelInput(fitted, 1000)).toBe(true);
  assertCompleteToolPairs(fitted);
});

it.each([-1, 0.5, 2])(
  "rejects invalid runtime prefix boundary %s rather than choosing a silent default",
  (protectedPrefix) => {
    expect(() =>
      fitPromptToModelInput(
        [textMessage("user", "formal requirement")],
        1000,
        undefined,
        protectedPrefix,
      ),
    ).toThrow(RangeError);
  },
);

it("passes a complete protected prefix through the real model pipeline after image hoisting and input fitting", async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const prefix = taskPrefix();
  const model = await meteredModel(
    {} as DB,
    "user",
    "chat",
    null,
    undefined,
    undefined,
    undefined,
    (prompt) => ({
      prompt: [...prefix, ...prompt],
      protectedPrefix: prefix.length,
    }),
  );
  await model.doGenerate({
    prompt: [
      ...exchange("old", "old reasoning ".repeat(1000)),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "image_candidate_view",
            toolCallId: "view",
            input: {},
          },
        ],
      },
      candidateResult(png),
    ],
  } as any);
  const request = fixture.base.doGenerate.mock.calls[0]![0];
  expect(request.prompt.slice(0, prefix.length)).toEqual(prefix);
  expect(
    request.prompt.at(-1).content.filter((part: any) => part.type === "file"),
  ).toHaveLength(3);
  expect(JSON.stringify(request)).not.toContain("protectedPrefix");
  expect(fixture.begin).toHaveBeenCalledOnce();
  assertCompleteToolPairs(request.prompt);
});

it.each(["prefix", "prefix-and-tools"])(
  "rejects an over-budget %s before usage reservation or provider execution",
  async (kind) => {
    const prefix = [
      textMessage(
        "user",
        "formal user requirement ".repeat(kind === "prefix" ? 300 : 100),
      ),
    ];
    const tools =
      kind === "prefix-and-tools"
        ? [
            {
              type: "function",
              name: "edit",
              description: "tool guidance ".repeat(200),
            },
          ]
        : undefined;
    const model = await meteredModel(
      {} as DB,
      "user",
      "chat",
      null,
      undefined,
      undefined,
      undefined,
      (prompt) => ({
        prompt: [...prefix, ...prompt],
        protectedPrefix: prefix.length,
      }),
    );
    await expect(
      model.doGenerate({
        prompt: [
          textMessage("assistant", "old execution ".repeat(1000)),
          textMessage("user", "current diagnostic"),
        ],
        tools,
      } as any),
    ).rejects.toMatchObject({ status: 413 });
    expect(fixture.begin).not.toHaveBeenCalled();
    expect(fixture.base.doGenerate).not.toHaveBeenCalled();
  },
);
