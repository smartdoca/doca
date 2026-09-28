import { describe, expect, it } from "vitest";
import {
  createToolCall,
  createToolPipeline,
  createToolRegistry,
  mergeGuardDecision,
  stableId,
  type JsonObject,
  type ToolResult,
} from "../packages/ai-host/src/index.js";

function request<Context>(
  call: ReturnType<typeof createToolCall>,
  host: Context,
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    stepId: "step-1",
    call,
    signal,
    host,
  };
}

describe("AI host tool pipeline", () => {
  it("runs pre, guards, approval, wrappers, execute, post, and one result", async () => {
    const trace: string[] = [];
    const published: ToolResult[] = [];
    const tools = createToolRegistry<{ trace: string[] }>();
    let executions = 0;
    tools.register({
      id: "math.increment",
      execute: (input, context) => {
        executions++;
        context.host.trace.push("execute");
        return { value: Number(input.value) + 1 };
      },
    });
    const source = { value: 1 };
    const call = createToolCall({
      sessionId: "session-1",
      turnId: "turn-1",
      stepId: "step-1",
      toolId: "math.increment",
      ordinal: 0,
      input: source,
    });
    source.value = 100;

    const pipeline = createToolPipeline({
      tools,
      preExecute: [
        (execution) => {
          trace.push("pre");
          return { value: Number(execution.call.input.value) + 1 };
        },
      ],
      guards: [
        () => {
          trace.push("guard-approval");
          return { effect: "require-approval", reason: "writes data" };
        },
        (_execution, current) => {
          trace.push(`guard-cannot-relax-${current.effect}`);
          return { effect: "allow", reason: "later allow" };
        },
      ],
      approve: (_execution, guard) => {
        trace.push(`approve-${guard.effect}`);
        return { approved: true };
      },
      wrappers: [
        async (_execution, next) => {
          trace.push("wrapper-before");
          const output = await next();
          trace.push("wrapper-after");
          return output;
        },
      ],
      postExecute: [
        (_execution, outcome) => {
          trace.push("post");
          return outcome.status === "success"
            ? {
                status: "success",
                value: { output: outcome.value, checked: true },
              }
            : outcome;
        },
      ],
      onResult: (result) => {
        trace.push("result");
        published.push(result);
      },
    });

    const first = await pipeline.execute(request(call, { trace }));
    const duplicate = await pipeline.execute(request(call, { trace }));

    expect(first).toBe(duplicate);
    expect(first.outcome).toEqual({
      status: "success",
      value: { checked: true, output: { value: 3 } },
    });
    expect(first.id).toBe(stableId("result", call.id));
    expect(executions).toBe(1);
    expect(published).toEqual([first]);
    expect(trace).toEqual([
      "pre",
      "guard-approval",
      "guard-cannot-relax-require-approval",
      "approve-require-approval",
      "wrapper-before",
      "execute",
      "wrapper-after",
      "post",
      "result",
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.outcome)).toBe(true);
    expect(
      first.outcome.status === "success" &&
        Object.isFrozen(first.outcome.value),
    ).toBe(true);
  });

  it("keeps guard policy monotonic and denies before execution", async () => {
    const state = mergeGuardDecision(
      { effect: "deny", reasons: ["first"] },
      { effect: "allow", reason: "cannot relax" },
    );
    expect(state).toEqual({
      effect: "deny",
      reasons: ["first", "cannot relax"],
    });

    let executions = 0;
    let approvals = 0;
    const tools = createToolRegistry();
    tools.register({
      id: "dangerous",
      execute: () => {
        executions++;
        return true;
      },
    });
    const pipeline = createToolPipeline({
      tools,
      guards: [
        () => ({ effect: "deny", reason: "tenant policy" }),
        () => ({ effect: "allow", reason: "plugin attempted relaxation" }),
      ],
      approve: () => {
        approvals++;
        return { approved: true };
      },
    });
    const result = await pipeline.execute(
      request(
        createToolCall({
          sessionId: "session-1",
          turnId: "turn-1",
          toolId: "dangerous",
          ordinal: 0,
          input: {},
        }),
        undefined,
      ),
    );
    expect(result.outcome).toEqual({
      status: "denied",
      reason: "tenant policy; plugin attempted relaxation",
    });
    expect(executions).toBe(0);
    expect(approvals).toBe(0);
  });

  it("does not execute when approval is unavailable or rejected", async () => {
    let executions = 0;
    const tools = createToolRegistry();
    tools.register({
      id: "write",
      execute: () => {
        executions++;
        return { written: true };
      },
    });
    const call = (ordinal: number) =>
      createToolCall({
        sessionId: "session-1",
        turnId: "turn-1",
        toolId: "write",
        ordinal,
        input: {},
      });
    const withoutApprover = createToolPipeline({
      tools,
      guards: [() => ({ effect: "require-approval" })],
    });
    const rejected = createToolPipeline({
      tools,
      guards: [() => ({ effect: "require-approval" })],
      approve: () => ({ approved: false, reason: "user declined" }),
    });

    expect((await withoutApprover.execute(request(call(0), undefined))).outcome)
      .toMatchObject({ status: "denied" });
    expect((await rejected.execute(request(call(1), undefined))).outcome).toEqual(
      { status: "denied", reason: "user declined" },
    );
    expect(executions).toBe(0);
  });

  it("turns cancellation, unknown tools, and thrown errors into results", async () => {
    const published: ToolResult[] = [];
    const tools = createToolRegistry();
    tools.register({
      id: "throws",
      execute: () => {
        throw new Error("boom");
      },
    });
    const pipeline = createToolPipeline({
      tools,
      onResult: (result) => {
        published.push(result);
      },
    });
    const controller = new AbortController();
    controller.abort("stopped by user");

    const cancelled = await pipeline.execute(
      request(
        createToolCall({
          sessionId: "session-1",
          turnId: "turn-1",
          toolId: "throws",
          ordinal: 0,
          input: {},
        }),
        undefined,
        controller.signal,
      ),
    );
    const failed = await pipeline.execute(
      request(
        createToolCall({
          sessionId: "session-1",
          turnId: "turn-1",
          toolId: "throws",
          ordinal: 1,
          input: {},
        }),
        undefined,
      ),
    );
    const missing = await pipeline.execute(
      request(
        createToolCall({
          sessionId: "session-1",
          turnId: "turn-1",
          toolId: "missing",
          ordinal: 2,
          input: {},
        }),
        undefined,
      ),
    );

    expect(cancelled.outcome).toEqual({
      status: "cancelled",
      reason: "stopped by user",
    });
    expect(failed.outcome).toMatchObject({
      status: "error",
      error: { code: "execution_error", message: "boom" },
    });
    expect(missing.outcome).toMatchObject({
      status: "error",
      error: { code: "tool_not_found" },
    });
    expect(published).toHaveLength(3);
  });

  it("publishes one error result when middleware or JSON validation fails", async () => {
    const tools = createToolRegistry();
    let executions = 0;
    tools.register({
      id: "once",
      execute: () => {
        executions++;
        return { ok: true };
      },
    });
    const published: ToolResult[] = [];
    const twice = createToolPipeline({
      tools,
      wrappers: [
        async (_execution, next) => {
          await next();
          return next();
        },
      ],
      onResult: (result) => {
        published.push(result);
      },
    });
    const result = await twice.execute(
      request(
        createToolCall({
          sessionId: "session-1",
          turnId: "turn-1",
          toolId: "once",
          ordinal: 0,
          input: {},
        }),
        undefined,
      ),
    );

    expect(result.outcome).toMatchObject({
      status: "error",
      error: { code: "wrapper_called_twice" },
    });
    expect(executions).toBe(1);
    expect(published).toEqual([result]);

    const invalidTools = createToolRegistry();
    invalidTools.register({
      id: "invalid-json",
      execute: () => undefined as never,
    });
    const invalid = await createToolPipeline({ tools: invalidTools }).execute(
      request(
        createToolCall({
          sessionId: "session-1",
          turnId: "turn-1",
          toolId: "invalid-json",
          ordinal: 1,
          input: {},
        }),
        undefined,
      ),
    );
    expect(invalid.outcome).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("JSON-compatible") },
    });
  });

  it("freezes copied input and rejects non-JSON input", () => {
    const input: JsonObject = { nested: { value: 1 } };
    const call = createToolCall({
      sessionId: "session-1",
      turnId: "turn-1",
      toolId: "read",
      ordinal: 0,
      input,
    });
    expect(Object.isFrozen(call.input)).toBe(true);
    expect(Object.isFrozen(call.input.nested)).toBe(true);
    expect(() =>
      createToolCall({
        sessionId: "session-1",
        turnId: "turn-1",
        toolId: "read",
        ordinal: 1,
        input: { bad: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/finite/);
  });
});
