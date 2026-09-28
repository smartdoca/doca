import { errorDetails, ProtocolInvariantError } from "./errors.js";
import type { ToolCall, ToolOutcome, ToolResult } from "./events.js";
import { stableId, toolResultId } from "./ids.js";
import {
  freezeJson,
  freezeJsonObject,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type { EffectRegistry, RegistryEntry } from "./registry.js";

export interface ToolExecutionContext<Context = unknown> {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId?: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly host: Context;
}

export interface ToolDefinition<Context = unknown> extends RegistryEntry {
  readonly inputSchema?: JsonObject;
  readonly description?: string;
  /** Adapter surfaces allowed to expose the tool. Defaults to both. */
  readonly exposure?: readonly ("chat" | "mcp")[];
  /** Host-owned policy identifiers; these are metadata, never implicit grants. */
  readonly requiredPermissions?: readonly string[];
  readonly approval?: "never" | "policy" | "always";
  readonly idempotency?: "none" | "call" | "explicit-key";
  readonly execute: (
    input: JsonObject,
    context: ToolExecutionContext<Context>,
  ) => JsonValue | Promise<JsonValue>;
}

export interface ToolExecutionRequest<Context = unknown> {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId?: string;
  readonly call: ToolCall;
  readonly signal: AbortSignal;
  readonly host: Context;
}

export interface PreparedToolExecution<Context = unknown>
  extends Omit<ToolExecutionRequest<Context>, "call"> {
  readonly call: ToolCall;
  readonly tool: ToolDefinition<Context>;
}

export type ToolGuardEffect = "allow" | "require-approval" | "deny";

export interface ToolGuardDecision {
  readonly effect: ToolGuardEffect;
  readonly reason?: string;
}

export interface ToolGuardState {
  readonly effect: ToolGuardEffect;
  readonly reasons: readonly string[];
}

export interface ToolApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

export type ToolPreExecuteHook<Context = unknown> = (
  execution: PreparedToolExecution<Context>,
) => void | JsonObject | Promise<void | JsonObject>;

export type ToolGuard<Context = unknown> = (
  execution: PreparedToolExecution<Context>,
  current: ToolGuardState,
) => ToolGuardDecision | Promise<ToolGuardDecision>;

export type ToolApprover<Context = unknown> = (
  execution: PreparedToolExecution<Context>,
  guard: ToolGuardState,
) => ToolApprovalDecision | Promise<ToolApprovalDecision>;

export type ToolExecuteWrapper<Context = unknown> = (
  execution: PreparedToolExecution<Context>,
  next: () => Promise<JsonValue>,
) => JsonValue | Promise<JsonValue>;

export type ToolPostExecuteHook<Context = unknown> = (
  execution: PreparedToolExecution<Context>,
  outcome: ToolOutcome,
) => void | ToolOutcome | Promise<void | ToolOutcome>;

export interface ToolPipelineOptions<Context = unknown> {
  readonly tools: EffectRegistry<ToolDefinition<Context>>;
  readonly preExecute?: readonly ToolPreExecuteHook<Context>[];
  readonly guards?: readonly ToolGuard<Context>[];
  readonly approve?: ToolApprover<Context>;
  readonly wrappers?: readonly ToolExecuteWrapper<Context>[];
  readonly postExecute?: readonly ToolPostExecuteHook<Context>[];
  readonly onResult?: (result: ToolResult) => void | Promise<void>;
}

const guardRank: Record<ToolGuardEffect, number> = {
  allow: 0,
  "require-approval": 1,
  deny: 2,
};

export function mergeGuardDecision(
  current: ToolGuardState,
  next: ToolGuardDecision,
): ToolGuardState {
  if (!Object.hasOwn(guardRank, next.effect)) {
    throw new ProtocolInvariantError(
      "invalid_guard_effect",
      `Unknown guard effect: ${String(next.effect)}`,
    );
  }
  const effect =
    guardRank[next.effect] > guardRank[current.effect]
      ? next.effect
      : current.effect;
  const reasons =
    next.reason === undefined
      ? current.reasons
      : Object.freeze([...current.reasons, next.reason]);
  return Object.freeze({ effect, reasons });
}

export function createToolCall(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId?: string;
  readonly toolId: string;
  readonly ordinal: number;
  readonly input: unknown;
}): ToolCall {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new TypeError("Tool call ordinal must be a non-negative safe integer");
  }
  const callInput = freezeJsonObject(input.input, "tool input");
  return Object.freeze({
    id: stableId(
      "tool-call",
      input.sessionId,
      input.turnId,
      input.stepId ?? null,
      input.toolId,
      input.ordinal,
    ),
    toolId: input.toolId,
    input: callInput,
  });
}

function cancellationReason(signal: AbortSignal): string {
  if (typeof signal.reason === "string" && signal.reason) return signal.reason;
  if (signal.reason instanceof Error && signal.reason.message) {
    return signal.reason.message;
  }
  return "Cancelled";
}

function outcomeFromError(error: unknown, signal: AbortSignal): ToolOutcome {
  if (
    signal.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return Object.freeze({
      status: "cancelled",
      reason: cancellationReason(signal),
    });
  }
  return Object.freeze({ status: "error", error: errorDetails(error) });
}

function freezeOutcome(outcome: ToolOutcome): ToolOutcome {
  switch (outcome.status) {
    case "success":
      return freezeJson(
        { status: "success", value: outcome.value },
        "tool outcome",
      ) as ToolOutcome;
    case "denied":
      return freezeJson(
        { status: "denied", reason: outcome.reason },
        "tool outcome",
      ) as ToolOutcome;
    case "cancelled":
      return freezeJson(
        { status: "cancelled", reason: outcome.reason },
        "tool outcome",
      ) as ToolOutcome;
    case "error":
      return freezeJson(
        { status: "error", error: outcome.error },
        "tool outcome",
      ) as ToolOutcome;
    default:
      throw new ProtocolInvariantError(
        "invalid_tool_outcome",
        "Post-execute returned an invalid tool outcome",
      );
  }
}

function executionWithInput<Context>(
  execution: PreparedToolExecution<Context>,
  input: JsonObject,
): PreparedToolExecution<Context> {
  return Object.freeze({
    ...execution,
    call: Object.freeze({ ...execution.call, input }),
  });
}

function composeExecution<Context>(
  execution: PreparedToolExecution<Context>,
  wrappers: readonly ToolExecuteWrapper<Context>[],
): () => Promise<JsonValue> {
  let next = async (): Promise<JsonValue> =>
    freezeJson(
      await execution.tool.execute(execution.call.input, {
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        ...(execution.stepId === undefined
          ? {}
          : { stepId: execution.stepId }),
        callId: execution.call.id,
        signal: execution.signal,
        host: execution.host,
      }),
      "tool output",
    );

  for (const wrapper of [...wrappers].reverse()) {
    const inner = next;
    next = async () => {
      let called = false;
      const callInner = async () => {
        if (called) {
          throw new ProtocolInvariantError(
            "wrapper_called_twice",
            "A tool execute wrapper called next() more than once",
          );
        }
        called = true;
        return inner();
      };
      return freezeJson(
        await wrapper(execution, callInner),
        "wrapped tool output",
      );
    };
  }
  return next;
}

export class ToolPipeline<Context = unknown> {
  readonly #options: ToolPipelineOptions<Context>;
  readonly #results = new Map<string, Promise<ToolResult>>();

  constructor(options: ToolPipelineOptions<Context>) {
    this.#options = options;
  }

  execute(request: ToolExecutionRequest<Context>): Promise<ToolResult> {
    const existing = this.#results.get(request.call.id);
    if (existing) return existing;
    const pending = this.#executeOnce(request);
    this.#results.set(request.call.id, pending);
    return pending;
  }

  async #executeOnce(
    request: ToolExecutionRequest<Context>,
  ): Promise<ToolResult> {
    let outcome: ToolOutcome;
    let execution: PreparedToolExecution<Context> | undefined;

    try {
      if (request.signal.aborted) {
        outcome = {
          status: "cancelled",
          reason: cancellationReason(request.signal),
        };
      } else {
        const tool = this.#options.tools.get(request.call.toolId);
        if (!tool) {
          throw new ProtocolInvariantError(
            "tool_not_found",
            `Tool "${request.call.toolId}" is not registered`,
          );
        }
        execution = Object.freeze({
          ...request,
          call: Object.freeze({
            ...request.call,
            input: freezeJsonObject(request.call.input, "tool input"),
          }),
          tool,
        });

        for (const hook of this.#options.preExecute ?? []) {
          const nextInput = await hook(execution);
          if (nextInput !== undefined) {
            execution = executionWithInput(
              execution,
              freezeJsonObject(nextInput, "pre-execute input"),
            );
          }
          if (request.signal.aborted) {
            throw Object.assign(new Error(cancellationReason(request.signal)), {
              name: "AbortError",
            });
          }
        }

        let guard: ToolGuardState = Object.freeze({
          effect: "allow",
          reasons: Object.freeze([]),
        });
        for (const evaluate of this.#options.guards ?? []) {
          guard = mergeGuardDecision(
            guard,
            await evaluate(execution, guard),
          );
        }
        if (request.signal.aborted) {
          throw Object.assign(new Error(cancellationReason(request.signal)), {
            name: "AbortError",
          });
        }

        if (guard.effect === "deny") {
          outcome = {
            status: "denied",
            reason: guard.reasons.join("; ") || "Denied by policy",
          };
        } else {
          if (guard.effect === "require-approval") {
            if (!this.#options.approve) {
              outcome = {
                status: "denied",
                reason:
                  guard.reasons.join("; ") ||
                  "Approval is required but no approver is configured",
              };
            } else {
              const approval = await this.#options.approve(execution, guard);
              if (request.signal.aborted) {
                throw Object.assign(
                  new Error(cancellationReason(request.signal)),
                  { name: "AbortError" },
                );
              }
              if (!approval.approved) {
                outcome = {
                  status: "denied",
                  reason: approval.reason ?? "Approval was denied",
                };
              } else {
                const value = await composeExecution(
                  execution,
                  this.#options.wrappers ?? [],
                )();
                outcome = { status: "success", value };
              }
            }
          } else {
            const value = await composeExecution(
              execution,
              this.#options.wrappers ?? [],
            )();
            outcome = { status: "success", value };
          }
        }
      }
    } catch (error) {
      outcome = outcomeFromError(error, request.signal);
    }

    if (execution) {
      try {
        for (const hook of this.#options.postExecute ?? []) {
          const transformed = await hook(execution, freezeOutcome(outcome));
          if (transformed !== undefined) outcome = freezeOutcome(transformed);
        }
      } catch (error) {
        outcome = outcomeFromError(error, request.signal);
      }
    }

    const result = freezeJson(
      {
        id: toolResultId(request.call.id),
        callId: request.call.id,
        toolId: request.call.toolId,
        outcome: freezeOutcome(outcome),
      },
      "tool result",
    ) as unknown as ToolResult;

    // This is deliberately the only result publication site.
    await this.#options.onResult?.(result);
    return result;
  }
}

export function createToolPipeline<Context = unknown>(
  options: ToolPipelineOptions<Context>,
): ToolPipeline<Context> {
  return new ToolPipeline(options);
}
