import { expect, it, vi } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { AppError } from "@core/shared/errors.js";
import { imageEditMaskInputSchema } from "../apps/server/src/services/ai/image-edit-mask.js";
import { workflowFailureDiagnostic } from "../apps/server/src/services/ai/workflow-failure-diagnostic.js";
import { currentToolModelOutputError } from "../apps/server/src/services/ai/current-tool-model-output.js";

async function truncatedMask(withErrorChannel: boolean) {
  const execute = vi.fn(async () => ({ maskReceiptId: "fixture-mask" }));
  const mapped: unknown[] = [];
  const preview = vi.fn();
  const model = {
    specificationVersion: "v3" as const,
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    async doStream() {
      const input =
        '{"generationOperationId":"00000000-0000-4000-8000-000000000001","sourceTarget":{"include":[{"kind":"polygon","points":[{"x":0.1,"y":';
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-input-start",
                id: "mask",
                toolName: "image_mask_prepare",
              },
              { type: "tool-input-delta", id: "mask", delta: input },
              { type: "tool-input-end", id: "mask" },
              {
                type: "tool-call",
                toolCallId: "mask",
                toolName: "image_mask_prepare",
                input,
              },
              {
                type: "finish",
                finishReason: { unified: "length", raw: "length" },
                usage: {
                  inputTokens: { total: 100 },
                  outputTokens: { total: 12000 },
                },
              },
            ])
              controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
    async doGenerate() {
      throw new Error("Unused fixture method");
    },
  };
  const agent = new Agent({
    id: "mask-input-boundary",
    name: "Mask input boundary",
    instructions: "Local regression only.",
    model: model as any,
    tools: {
      image_mask_prepare: createTool({
        id: "image_mask_prepare",
        description:
          "Fixture of the current strict mask input and media mapping.",
        inputSchema: imageEditMaskInputSchema,
        outputSchema: z.object({ maskReceiptId: z.string() }),
        execute,
        toModelOutput: async (output) => {
          mapped.push(output);
          if (withErrorChannel) {
            const error = currentToolModelOutputError(output);
            if (error) return error;
          }
          preview(output.maskReceiptId);
          if (!output.maskReceiptId)
            throw new AppError(409, "Fixture mask receipt missing");
          return { type: "text", value: "fixture" };
        },
      }),
    },
  });
  const output = await agent.stream("Prepare the local fixture mask", {
    maxSteps: 1,
    modelSettings: { maxRetries: 0 },
  });
  const chunks: any[] = [];
  let thrown: unknown;
  try {
    for await (const chunk of output.fullStream) chunks.push(chunk);
  } catch (error) {
    thrown = error;
  }
  expect(execute).not.toHaveBeenCalled();
  expect(mapped).toHaveLength(1);
  expect(mapped[0]).toMatchObject({ error: true });
  expect((mapped[0] as any).maskReceiptId).toBeUndefined();
  const failure =
    thrown ?? chunks.find((chunk) => chunk.type === "error")?.payload.error;
  return { output, preview, failure, mapped, chunks };
}

it("reproduces the installed SDK's secondary media-mapping failure after truncated strict mask JSON without provider access", async () => {
  const { failure, preview } = await truncatedMask(false);
  expect(preview).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(failure).toBeDefined();
  expect(workflowFailureDiagnostic("fixture-job", "failed", failure)).toEqual({
    jobId: "fixture-job",
    status: "failed",
    errorType: "Error",
    stackFrames: [],
    errorStatus: 409,
  });
});

it("keeps the current SDK validation result in its error channel without preview, tool execution or a fabricated receipt", async () => {
  const { failure, preview, output, mapped, chunks } =
    await truncatedMask(true);
  expect(failure).toBeUndefined();
  expect(preview).not.toHaveBeenCalled();
  expect(
    chunks.find((chunk) => chunk.type === "tool-result")?.payload.result,
  ).toEqual(mapped[0]);
  const complete = await output.getFullOutput();
  expect(complete.error).toBeUndefined();
  expect(complete.finishReason).toBe("length");
  const modelOutput = currentToolModelOutputError(mapped[0]);
  expect(JSON.parse(modelOutput!.value)).toMatchObject({
    error: true,
    message: expect.stringContaining("Tool input validation failed"),
    instruction: expect.stringContaining("不是成功回执"),
  });
});

it("bounds validation error text and leaves successful, missing-field or other error shapes on their own strict path", () => {
  const validation = {
    error: true,
    message: "x".repeat(9000),
    validationErrors: { errors: [], fields: {} },
  };
  const result = currentToolModelOutputError(validation);
  expect(result?.value.length).toBeLessThan(4500);
  expect(JSON.parse(result!.value)).toMatchObject({
    error: true,
    message: `${"x".repeat(4000)}\n[truncated]`,
  });
  for (const output of [
    { maskReceiptId: "fixture-mask" },
    {},
    { error: true, message: "failure" },
    {
      error: false,
      message: "failure",
      validationErrors: validation.validationErrors,
    },
    { ...validation, maskReceiptId: "fixture-mask" },
    { ...validation, validationErrors: { errors: [], fields: [] } },
  ])
    expect(currentToolModelOutputError(output)).toBeUndefined();
});

it("does not invoke accessors or stringify validation trees when recognizing the current SDK channel", () => {
  const accessed = vi.fn(() => {
    throw new Error("private getter body");
  });
  for (const key of ["error", "message", "validationErrors"]) {
    const output = {
      error: true,
      message: "Fixture validation failed",
      validationErrors: { errors: [], fields: {} },
    };
    Object.defineProperty(output, key, { get: accessed });
    expect(currentToolModelOutputError(output)).toBeUndefined();
  }
  const nested = { errors: [], fields: {} };
  Object.defineProperty(nested.fields, "private", {
    get: accessed,
    enumerable: true,
  });
  const result = currentToolModelOutputError({
    error: true,
    message: "Fixture validation failed",
    validationErrors: nested,
  });
  expect(result).toBeDefined();
  expect(result!.value).not.toContain("private");
  expect(accessed).not.toHaveBeenCalled();
});
