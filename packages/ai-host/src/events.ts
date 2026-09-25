import type { ProtocolError } from "./errors.js";
import { ProtocolInvariantError } from "./errors.js";
import { eventId } from "./ids.js";
import {
  freezeJson,
  type JsonObject,
  type JsonValue,
} from "./json.js";

export interface Message {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly content: JsonValue;
}

export interface ToolCall {
  readonly id: string;
  readonly toolId: string;
  readonly input: JsonObject;
}

export type ToolOutcome =
  | {
      readonly status: "success";
      readonly value: JsonValue;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    }
  | {
      readonly status: "cancelled";
      readonly reason: string;
    }
  | {
      readonly status: "error";
      readonly error: ProtocolError;
    };

export interface ToolResult {
  readonly id: string;
  readonly callId: string;
  readonly toolId: string;
  readonly outcome: ToolOutcome;
}

export interface SessionEventDataMap {
  readonly "turn.started": {
    readonly turnId: string;
  };
  readonly "turn.completed": {
    readonly turnId: string;
  };
  readonly "turn.failed": {
    readonly turnId: string;
    readonly error: ProtocolError;
  };
  readonly "turn.cancelled": {
    readonly turnId: string;
    readonly reason: string;
  };
  readonly "step.started": {
    readonly turnId: string;
    readonly stepId: string;
    readonly name?: string;
  };
  readonly "step.completed": {
    readonly turnId: string;
    readonly stepId: string;
  };
  readonly "step.failed": {
    readonly turnId: string;
    readonly stepId: string;
    readonly error: ProtocolError;
  };
  readonly "step.cancelled": {
    readonly turnId: string;
    readonly stepId: string;
    readonly reason: string;
  };
  readonly "user.message": {
    readonly turnId: string;
    readonly message: Message & { readonly role: "user" };
  };
  readonly "assistant.attempt.started": {
    readonly turnId: string;
    readonly attemptId: string;
    readonly stepId?: string;
  };
  readonly "assistant.attempt.completed": {
    readonly turnId: string;
    readonly attemptId: string;
  };
  readonly "assistant.attempt.failed": {
    readonly turnId: string;
    readonly attemptId: string;
    readonly error: ProtocolError;
  };
  readonly "assistant.attempt.cancelled": {
    readonly turnId: string;
    readonly attemptId: string;
    readonly reason: string;
  };
  readonly "assistant.message": {
    readonly turnId: string;
    readonly attemptId: string;
    readonly message: Message & { readonly role: "assistant" };
  };
  readonly "intent.routed": {
    readonly turnId: string;
    readonly intentId: string;
    readonly confidence: number;
    readonly priority: number;
  };
  readonly "workflow.started": {
    readonly turnId: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly input: JsonValue;
  };
  readonly "workflow.completed": {
    readonly turnId: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly output: JsonValue;
  };
  readonly "workflow.failed": {
    readonly turnId: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly error: ProtocolError;
  };
  readonly "workflow.cancelled": {
    readonly turnId: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly reason: string;
  };
  readonly "tool.call": {
    readonly turnId: string;
    readonly stepId?: string;
    readonly call: ToolCall;
  };
  readonly "tool.result": {
    readonly turnId: string;
    readonly stepId?: string;
    readonly result: ToolResult;
  };
  readonly "acceptance.requested": {
    readonly turnId: string;
    readonly acceptanceId: string;
    readonly evaluatorId: string;
    readonly subject: JsonValue;
  };
  readonly "acceptance.result": {
    readonly turnId: string;
    readonly acceptanceId: string;
    readonly evaluatorId: string;
    readonly verdict: "accepted" | "rejected" | "needs-user";
    readonly evidence?: JsonValue;
  };
}

export type SessionEventType = keyof SessionEventDataMap;

export interface SessionEventBase<T extends SessionEventType> {
  readonly delivery: "committed";
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: T;
}

export type SessionEvent = {
  [T in SessionEventType]: SessionEventBase<T> & {
    readonly data: SessionEventDataMap[T];
  };
}[SessionEventType];

export type SessionEventOf<T extends SessionEventType> = Extract<
  SessionEvent,
  { readonly type: T }
>;

export type SessionEventInput<T extends SessionEventType> = Omit<
  SessionEventOf<T>,
  "data" | "delivery" | "id"
> & {
  readonly data: SessionEventDataMap[T];
};

export function createSessionEvent<T extends SessionEventType>(
  input: SessionEventInput<T>,
): SessionEventOf<T> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new ProtocolInvariantError(
      "invalid_sequence",
      "Event sequence must be a non-negative safe integer",
    );
  }
  if (!input.sessionId) {
    throw new ProtocolInvariantError(
      "invalid_session",
      "Event sessionId must not be empty",
    );
  }
  if (!input.timestamp) {
    throw new ProtocolInvariantError(
      "invalid_timestamp",
      "Event timestamp must not be empty",
    );
  }
  return Object.freeze({
    delivery: "committed",
    id: eventId(input.sessionId, input.sequence),
    sessionId: input.sessionId,
    sequence: input.sequence,
    timestamp: input.timestamp,
    type: input.type,
    data: freezeJson(input.data, "event.data"),
  }) as SessionEventOf<T>;
}

export interface LiveSessionEventDataMap {
  readonly "assistant.delta": {
    readonly attemptId: string;
    readonly delta: string;
  };
  readonly "tool.progress": {
    readonly callId: string;
    readonly progress: JsonValue;
  };
  readonly "workflow.progress": {
    readonly runId: string;
    readonly progress: JsonValue;
  };
}

export type LiveSessionEventType = keyof LiveSessionEventDataMap;
export type LiveSessionEvent = {
  [T in LiveSessionEventType]: {
    readonly delivery: "live";
    readonly sessionId: string;
    readonly turnId: string;
    readonly emittedAt: string;
    readonly type: T;
    readonly data: LiveSessionEventDataMap[T];
  };
}[LiveSessionEventType];

export function createLiveSessionEvent<T extends LiveSessionEventType>(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly emittedAt: string;
  readonly type: T;
  readonly data: LiveSessionEventDataMap[T];
}): Extract<LiveSessionEvent, { readonly type: T }> {
  return Object.freeze({
    delivery: "live",
    sessionId: input.sessionId,
    turnId: input.turnId,
    emittedAt: input.emittedAt,
    type: input.type,
    data: freezeJson(input.data, "liveEvent.data"),
  }) as Extract<LiveSessionEvent, { readonly type: T }>;
}

export function orderSessionEvents(
  events: readonly SessionEvent[],
): readonly SessionEvent[] {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  if (ordered.length === 0) return Object.freeze(ordered);

  const sessionId = ordered[0]!.sessionId;
  for (let index = 0; index < ordered.length; index++) {
    const event = ordered[index]!;
    if (event.sessionId !== sessionId) {
      throw new ProtocolInvariantError(
        "mixed_sessions",
        "A replay stream may contain only one session",
      );
    }
    if (event.sequence !== index) {
      throw new ProtocolInvariantError(
        "non_contiguous_sequence",
        `Expected sequence ${index}, received ${event.sequence}`,
      );
    }
    if (event.id !== eventId(event.sessionId, event.sequence)) {
      throw new ProtocolInvariantError(
        "unstable_event_id",
        `Event ${event.sequence} does not have its stable ID`,
      );
    }
  }
  return Object.freeze(ordered);
}

export class SessionEventLog {
  readonly sessionId: string;
  #events: SessionEvent[] = [];

  constructor(sessionId: string, events: readonly SessionEvent[] = []) {
    if (!sessionId) throw new TypeError("sessionId must not be empty");
    this.sessionId = sessionId;
    for (const event of orderSessionEvents(events)) this.append(event);
  }

  get nextSequence(): number {
    return this.#events.length;
  }

  append(event: SessionEvent): void {
    if (event.sessionId !== this.sessionId) {
      throw new ProtocolInvariantError(
        "wrong_session",
        `Cannot append event for session ${event.sessionId}`,
      );
    }
    if (event.sequence !== this.nextSequence) {
      throw new ProtocolInvariantError(
        "non_append_only",
        `Expected sequence ${this.nextSequence}, received ${event.sequence}`,
      );
    }
    if (event.id !== eventId(event.sessionId, event.sequence)) {
      throw new ProtocolInvariantError(
        "unstable_event_id",
        "Event ID does not match its session and sequence",
      );
    }
    if (this.#events.some((item) => item.id === event.id)) {
      throw new ProtocolInvariantError(
        "duplicate_event",
        `Event ${event.id} has already been appended`,
      );
    }
    this.#events.push(
      freezeJson(event, "event") as unknown as SessionEvent,
    );
  }

  snapshot(): readonly SessionEvent[] {
    return Object.freeze([...this.#events]);
  }
}

export type ProjectionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionProjection {
  readonly sessionId: string | null;
  readonly lastSequence: number;
  readonly status: "idle" | ProjectionStatus;
  readonly turns: Readonly<
    Record<string, { readonly status: ProjectionStatus; readonly error?: ProtocolError }>
  >;
  readonly steps: Readonly<
    Record<
      string,
      {
        readonly turnId: string;
        readonly name?: string;
        readonly status: ProjectionStatus;
        readonly error?: ProtocolError;
      }
    >
  >;
  readonly messages: readonly (Message & { readonly turnId: string })[];
  readonly attempts: Readonly<
    Record<
      string,
      {
        readonly turnId: string;
        readonly stepId?: string;
        readonly status: ProjectionStatus;
        readonly error?: ProtocolError;
      }
    >
  >;
  readonly intents: readonly SessionEventDataMap["intent.routed"][];
  readonly workflows: Readonly<
    Record<
      string,
      {
        readonly turnId: string;
        readonly workflowId: string;
        readonly status: ProjectionStatus;
        readonly output?: JsonValue;
        readonly error?: ProtocolError;
      }
    >
  >;
  readonly toolCalls: Readonly<
    Record<
      string,
      {
        readonly turnId: string;
        readonly stepId?: string;
        readonly call: ToolCall;
        readonly result?: ToolResult;
      }
    >
  >;
  readonly acceptances: Readonly<
    Record<
      string,
      {
        readonly turnId: string;
        readonly evaluatorId: string;
        readonly subject: JsonValue;
        readonly verdict?: "accepted" | "rejected" | "needs-user";
        readonly evidence?: JsonValue;
      }
    >
  >;
}

type MutableProjection = {
  sessionId: string | null;
  lastSequence: number;
  status: SessionProjection["status"];
  turns: Record<string, Record<string, unknown>>;
  steps: Record<string, Record<string, unknown>>;
  messages: Record<string, unknown>[];
  attempts: Record<string, Record<string, unknown>>;
  intents: SessionEventDataMap["intent.routed"][];
  workflows: Record<string, Record<string, unknown>>;
  toolCalls: Record<string, Record<string, unknown>>;
  acceptances: Record<string, Record<string, unknown>>;
};

function initialProjection(): MutableProjection {
  return {
    sessionId: null,
    lastSequence: -1,
    status: "idle",
    turns: {},
    steps: {},
    messages: [],
    attempts: {},
    intents: [],
    workflows: {},
    toolCalls: {},
    acceptances: {},
  };
}

function terminalStatus(type: string): ProjectionStatus | undefined {
  if (type.endsWith(".completed")) return "completed";
  if (type.endsWith(".failed")) return "failed";
  if (type.endsWith(".cancelled")) return "cancelled";
  return undefined;
}

export function projectSession(
  events: readonly SessionEvent[],
): SessionProjection {
  const projection = initialProjection();
  for (const event of orderSessionEvents(events)) {
    projection.sessionId = event.sessionId;
    projection.lastSequence = event.sequence;

    switch (event.type) {
      case "turn.started":
        projection.status = "running";
        projection.turns[event.data.turnId] = { status: "running" };
        break;
      case "turn.completed":
      case "turn.cancelled":
      case "turn.failed": {
        const status = terminalStatus(event.type)!;
        projection.status = status;
        projection.turns[event.data.turnId] = {
          ...projection.turns[event.data.turnId],
          status,
          ...("error" in event.data ? { error: event.data.error } : {}),
        };
        break;
      }
      case "step.started":
        projection.steps[event.data.stepId] = {
          turnId: event.data.turnId,
          ...(event.data.name === undefined ? {} : { name: event.data.name }),
          status: "running",
        };
        break;
      case "step.completed":
      case "step.cancelled":
      case "step.failed":
        projection.steps[event.data.stepId] = {
          ...projection.steps[event.data.stepId],
          turnId: event.data.turnId,
          status: terminalStatus(event.type)!,
          ...("error" in event.data ? { error: event.data.error } : {}),
        };
        break;
      case "user.message":
      case "assistant.message":
        projection.messages.push({
          ...event.data.message,
          turnId: event.data.turnId,
        });
        break;
      case "assistant.attempt.started":
        projection.attempts[event.data.attemptId] = {
          turnId: event.data.turnId,
          ...(event.data.stepId === undefined
            ? {}
            : { stepId: event.data.stepId }),
          status: "running",
        };
        break;
      case "assistant.attempt.completed":
      case "assistant.attempt.cancelled":
      case "assistant.attempt.failed":
        projection.attempts[event.data.attemptId] = {
          ...projection.attempts[event.data.attemptId],
          turnId: event.data.turnId,
          status: terminalStatus(event.type)!,
          ...("error" in event.data ? { error: event.data.error } : {}),
        };
        break;
      case "intent.routed":
        projection.intents.push(event.data);
        break;
      case "workflow.started":
        projection.workflows[event.data.runId] = {
          turnId: event.data.turnId,
          workflowId: event.data.workflowId,
          status: "running",
        };
        break;
      case "workflow.completed":
      case "workflow.cancelled":
      case "workflow.failed":
        projection.workflows[event.data.runId] = {
          ...projection.workflows[event.data.runId],
          turnId: event.data.turnId,
          workflowId: event.data.workflowId,
          status: terminalStatus(event.type)!,
          ...("output" in event.data ? { output: event.data.output } : {}),
          ...("error" in event.data ? { error: event.data.error } : {}),
        };
        break;
      case "tool.call":
        projection.toolCalls[event.data.call.id] = {
          turnId: event.data.turnId,
          ...(event.data.stepId === undefined
            ? {}
            : { stepId: event.data.stepId }),
          call: event.data.call,
        };
        break;
      case "tool.result": {
        const current = projection.toolCalls[event.data.result.callId];
        projection.toolCalls[event.data.result.callId] = {
          ...current,
          turnId: event.data.turnId,
          ...(event.data.stepId === undefined
            ? {}
            : { stepId: event.data.stepId }),
          result: event.data.result,
        };
        break;
      }
      case "acceptance.requested":
        projection.acceptances[event.data.acceptanceId] = {
          turnId: event.data.turnId,
          evaluatorId: event.data.evaluatorId,
          subject: event.data.subject,
        };
        break;
      case "acceptance.result":
        projection.acceptances[event.data.acceptanceId] = {
          ...projection.acceptances[event.data.acceptanceId],
          turnId: event.data.turnId,
          evaluatorId: event.data.evaluatorId,
          verdict: event.data.verdict,
          ...(event.data.evidence === undefined
            ? {}
            : { evidence: event.data.evidence }),
        };
        break;
    }
  }
  return freezeJson(projection, "projection") as unknown as SessionProjection;
}

export function replaySession<T>(
  events: readonly SessionEvent[],
  initial: T,
  reducer: (state: T, event: SessionEvent) => T,
): T {
  return orderSessionEvents(events).reduce(reducer, initial);
}
