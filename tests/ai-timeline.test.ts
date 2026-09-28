import { expect, it } from "vitest";
import {
  aiTimeline,
  completionPresentation,
  taskDuration,
} from "../apps/web/src/features/ai/ai-timeline.js";
const keys = (items: ReturnType<typeof aiTimeline>) =>
  items.map((i) => (i.kind === "message" ? i.message.id : `task:${i.job.id}`));
it("places each failed task immediately after its own question, including repeated prompts", () => {
  const messages = [1, 2, 3].map((n) => ({
    id: `q${n}`,
    role: "user",
    text: "你是谁",
    createdAt: `2026-09-15T01:00:0${n}Z`,
  }));
  expect(
    keys(
      aiTimeline(
        messages,
        [3, 2, 1].map((n) => ({ id: `q${n}`, status: "failed" })),
      ),
    ),
  ).toEqual(["q1", "task:q1", "q2", "task:q2", "q3", "task:q3"]);
});
it("pairs answers with their request even when concurrent jobs finish out of order", () => {
  expect(
    keys(
      aiTimeline(
        [
          { id: "q1", role: "user" },
          { id: "q2", role: "user" },
          { id: "q2-answer", role: "assistant" },
          { id: "q1-answer", role: "assistant" },
        ],
        [
          { id: "q2", status: "completed" },
          { id: "q1", status: "completed" },
        ],
      ),
    ),
  ).toEqual(["q1", "task:q1", "q1-answer", "q2", "task:q2", "q2-answer"]);
});
it("deduplicates overlapping history pages and hides unrelated old failures", () => {
  const m = { id: "q1", role: "user" };
  expect(
    keys(
      aiTimeline(
        [m, m],
        [
          { id: "old", status: "failed" },
          { id: "q1", status: "failed" },
        ],
      ),
    ),
  ).toEqual(["q1", "task:q1"]);
});
it("retains partial history answers and active jobs before their message arrives", () => {
  expect(
    keys(
      aiTimeline(
        [{ id: "older-answer", role: "assistant" }],
        [{ id: "pending", status: "queued" }],
      ),
    ),
  ).toEqual(["older-answer", "task:pending"]);
});

it("formats completed duration and tolerates missing historical timestamps", () => {
  expect(taskDuration("2026-09-16T00:00:00Z", "2026-09-16T01:02:03Z")).toEqual({
    hours: 1,
    minutes: 2,
    seconds: 3,
  });
  expect(taskDuration()).toBeNull();
});

it("derives completed presentation without comparing localized phase text", () => {
  expect(completionPresentation({})).toBe("done");
  expect(completionPresentation({ questions: [{}] })).toBe("waiting-choice");
  expect(completionPresentation({ pendingAccess: {} })).toBe("waiting-access");
  expect(completionPresentation({ plan: { mode: "clarify" } })).toBe(
    "waiting-input",
  );
  expect(completionPresentation({ review: { verdict: "needs_user" } })).toBe(
    "waiting-input",
  );
  expect(completionPresentation({ plan: { mode: "deliver" } })).toBe("done");
});
