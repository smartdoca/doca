import { describe, expect, it } from "vitest";
import {
  createLiveSessionEvent,
  createSessionEvent,
  eventId,
  projectSession,
  replaySession,
  SessionEventLog,
  stableId,
  type JsonObject,
  type SessionEvent,
  type SessionEventDataMap,
  type SessionEventInput,
  type SessionEventType,
} from "../packages/ai-host/src/index.js";

const error = {
  code: "failed",
  message: "failed",
  retryable: false,
} as const;

function scenario(): SessionEvent[] {
  let sequence = 0;
  const event = <T extends SessionEventType>(
    type: T,
    data: SessionEventDataMap[T],
  ) =>
    createSessionEvent({
      sessionId: "session-1",
      sequence,
      timestamp: `2026-09-25T00:00:${String(sequence++).padStart(2, "0")}Z`,
      type,
      data,
    } as SessionEventInput<T>);

  return [
    event("turn.started", { turnId: "turn-1" }),
    event("user.message", {
      turnId: "turn-1",
      message: { id: "message-u", role: "user", content: "Make a report" },
    }),
    event("intent.routed", {
      turnId: "turn-1",
      intentId: "report",
      confidence: 0.9,
      priority: 4,
    }),
    event("step.started", {
      turnId: "turn-1",
      stepId: "step-1",
      name: "draft",
    }),
    event("assistant.attempt.started", {
      turnId: "turn-1",
      stepId: "step-1",
      attemptId: "attempt-1",
    }),
    event("workflow.started", {
      turnId: "turn-1",
      workflowId: "report",
      runId: "run-1",
      input: { topic: "quarterly" },
    }),
    event("tool.call", {
      turnId: "turn-1",
      stepId: "step-1",
      call: {
        id: "call-1",
        toolId: "document.write",
        input: { title: "Q3" },
      },
    }),
    event("tool.result", {
      turnId: "turn-1",
      stepId: "step-1",
      result: {
        id: "result-1",
        callId: "call-1",
        toolId: "document.write",
        outcome: { status: "success", value: { documentId: "doc-1" } },
      },
    }),
    event("workflow.completed", {
      turnId: "turn-1",
      workflowId: "report",
      runId: "run-1",
      output: { documentId: "doc-1" },
    }),
    event("acceptance.requested", {
      turnId: "turn-1",
      acceptanceId: "acceptance-1",
      evaluatorId: "document-review",
      subject: { documentId: "doc-1" },
    }),
    event("acceptance.result", {
      turnId: "turn-1",
      acceptanceId: "acceptance-1",
      evaluatorId: "document-review",
      verdict: "accepted",
      evidence: ["saved", "read-back"],
    }),
    event("assistant.message", {
      turnId: "turn-1",
      attemptId: "attempt-1",
      message: {
        id: "message-a",
        role: "assistant",
        content: "Report created",
      },
    }),
    event("assistant.attempt.completed", {
      turnId: "turn-1",
      attemptId: "attempt-1",
    }),
    event("step.completed", { turnId: "turn-1", stepId: "step-1" }),
    event("turn.completed", { turnId: "turn-1" }),
  ];
}

describe("AI host session events", () => {
  it("uses stable IDs and an append-only event log", () => {
    const events = scenario();
    const log = new SessionEventLog("session-1");
    events.forEach((event) => log.append(event));

    expect(events[0]!.id).toBe(eventId("session-1", 0));
    expect(log.nextSequence).toBe(events.length);
    expect(Object.isFrozen(log.snapshot())).toBe(true);
    expect(() => log.append(events[1]!)).toThrow(/Expected sequence/);
    expect(
      stableId("turn", "session-1", 0),
    ).toBe(stableId("turn", "session-1", 0));
    expect(stableId("turn", "session-1", 0)).not.toBe(
      stableId("turn", "session-1", 1),
    );

    const mutable = {
      ...events[0]!,
      data: { turnId: "turn-1" },
    } as SessionEvent;
    const copied = new SessionEventLog("session-1");
    copied.append(mutable);
    (mutable.data as { turnId: string }).turnId = "changed-after-append";
    expect(copied.snapshot()[0]?.data).toEqual({ turnId: "turn-1" });
  });

  it("projects deterministically from storage order and freezes the result", () => {
    const events = scenario();
    const forward = projectSession(events);
    const reversed = projectSession([...events].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.status).toBe("completed");
    expect(forward.steps["step-1"]?.status).toBe("completed");
    expect(forward.attempts["attempt-1"]?.status).toBe("completed");
    expect(forward.workflows["run-1"]?.output).toEqual({
      documentId: "doc-1",
    });
    expect(forward.toolCalls["call-1"]?.result?.outcome.status).toBe(
      "success",
    );
    expect(forward.acceptances["acceptance-1"]?.verdict).toBe("accepted");
    expect(forward.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.toolCalls["call-1"]!)).toBe(true);

    const types = replaySession(events, [] as string[], (state, event) => [
      ...state,
      event.type,
    ]);
    expect(types.at(0)).toBe("turn.started");
    expect(types.at(-1)).toBe("turn.completed");
  });

  it("keeps live deltas outside the committed sequence", () => {
    const live = createLiveSessionEvent({
      sessionId: "session-1",
      turnId: "turn-1",
      emittedAt: "2026-09-25T00:00:00Z",
      type: "assistant.delta",
      data: { attemptId: "attempt-1", delta: "working" },
    });

    expect(live.delivery).toBe("live");
    expect("sequence" in live).toBe(false);
    expect("id" in live).toBe(false);
    expect(projectSession(scenario()).messages).toHaveLength(2);
  });

  it("rejects gaps, mixed sessions, unstable IDs, and mutable non-JSON data", () => {
    const events = scenario();
    expect(() => projectSession(events.slice(1))).toThrow(
      /Expected sequence 0/,
    );
    expect(() =>
      projectSession([
        events[0]!,
        { ...events[1]!, sessionId: "other-session" },
      ]),
    ).toThrow(/one session/);
    expect(() =>
      projectSession([{ ...events[0]!, id: "invented" }]),
    ).toThrow(/stable ID/);
    expect(() =>
      createSessionEvent({
        sessionId: "session-1",
        sequence: 0,
        timestamp: "now",
        type: "turn.failed",
        data: {
          turnId: "turn-1",
          error: {
            ...error,
            details: { invalid: undefined } as unknown as JsonObject,
          },
        },
      }),
    ).toThrow(/undefined/);
  });

  it("projects cancellation and failure terminal states", () => {
    const failed = [
      createSessionEvent({
        sessionId: "failed-session",
        sequence: 0,
        timestamp: "t0",
        type: "turn.started",
        data: { turnId: "turn-failed" },
      }),
      createSessionEvent({
        sessionId: "failed-session",
        sequence: 1,
        timestamp: "t1",
        type: "step.started",
        data: { turnId: "turn-failed", stepId: "step-failed" },
      }),
      createSessionEvent({
        sessionId: "failed-session",
        sequence: 2,
        timestamp: "t2",
        type: "step.failed",
        data: { turnId: "turn-failed", stepId: "step-failed", error },
      }),
      createSessionEvent({
        sessionId: "failed-session",
        sequence: 3,
        timestamp: "t3",
        type: "turn.cancelled",
        data: { turnId: "turn-failed", reason: "user stopped" },
      }),
    ];
    const projection = projectSession(failed);
    expect(projection.steps["step-failed"]?.status).toBe("failed");
    expect(projection.status).toBe("cancelled");
  });
});
