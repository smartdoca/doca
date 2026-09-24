import { expect, it } from "vitest";
import {
  DRAFT_QUEUE_KEY,
  adoptDraftQueue,
  activeQuestionFromPositions,
  formatContextTokens,
  loadPendingQueue,
  pendingSessionIds,
  previewQuestion,
  promotePendingItem,
  questionsToReveal,
  savePendingQueue,
  sessionHasActiveJob,
  userQuestions,
  windowedMessages,
  type PendingSendItem,
} from "../apps/web/src/features/ai/ai-session-ux.js";

const messages = [1, 2, 3, 4, 5].flatMap((n) => [
  { id: `q${n}`, role: "user", text: `问题 ${n} ${"很长的内容".repeat(20)}` },
  { id: `q${n}-answer`, role: "assistant", text: `回答 ${n}` },
]);

it("truncates hover previews and strips serialized mentions", () => {
  expect(previewQuestion("短问题")).toBe("短问题");
  expect(previewQuestion("@【项目计划】 请继续", 8)).toBe("请继续");
  expect(previewQuestion("一二三四五六七八九十", 6)).toBe("一二三四五六...");
  expect(previewQuestion("   @【a】   ")).toBe("（无文字）");
});

it("indexes user questions for navigation", () => {
  expect(userQuestions(messages).map((q) => q.id)).toEqual([
    "q1",
    "q2",
    "q3",
    "q4",
    "q5",
  ]);
});

it("windows history to the latest questions and can reveal an older one", () => {
  expect(windowedMessages(messages, 2).messages.map((m) => m.id)).toEqual([
    "q4",
    "q4-answer",
    "q5",
    "q5-answer",
  ]);
  expect(
    windowedMessages(messages, 2, "q2").messages.map((m) => m.id)[0],
  ).toBe("q2");
  expect(windowedMessages(messages, 20).startIndex).toBe(0);
  expect(questionsToReveal(userQuestions(messages), "q2", 2)).toBe(4);
});

it("marks the in-view question from bubble tops, not the previous round", () => {
  const items = [
    { id: "q1", top: -400 },
    { id: "q2", top: 40 },
    { id: "q3", top: 520 },
  ];
  expect(activeQuestionFromPositions(items, 120, false)).toBe("q2");
  expect(activeQuestionFromPositions(items, 120, true)).toBe("q3");
  expect(
    activeQuestionFromPositions(
      [
        { id: "q1", top: 180 },
        { id: "q2", top: 360 },
      ],
      120,
      false,
    ),
  ).toBe("q1");
});

it("formats recorded input tokens and hides missing usage", () => {
  expect(formatContextTokens(32000)).toBe("上下文 32,000 Token");
  expect(formatContextTokens(0)).toBeNull();
  expect(formatContextTokens(null)).toBeNull();
});

it("persists pending messages per session and adopts the draft queue", () => {
  const user = "user-pending";
  const item = (id: string): PendingSendItem => ({
    id,
    text: `草稿 ${id}`,
    attachments: [],
    references: [{ resourceId: "doc-1", label: "文档" }],
    notes: [],
    createdAt: "2026-09-21T00:00:00Z",
    modelId: "model-1",
    scope: "document",
    skillIds: ["skill-a"],
    webSearch: true,
  });
  savePendingQueue(user, DRAFT_QUEUE_KEY, [item("a")]);
  expect(loadPendingQueue(user, DRAFT_QUEUE_KEY)).toEqual([item("a")]);
  expect(adoptDraftQueue(user, "session-1")).toEqual([item("a")]);
  expect(loadPendingQueue(user, DRAFT_QUEUE_KEY)).toEqual([]);
  expect(loadPendingQueue(user, "session-1")).toEqual([item("a")]);
  savePendingQueue(user, "session-1", []);
});

it("promotes a queued item and ignores draft keys when listing sessions", () => {
  const first = {
    id: "a",
    text: "先发",
    attachments: [],
    references: [],
    notes: [],
    createdAt: "2026-09-21T00:00:00Z",
  };
  const second = { ...first, id: "b", text: "插队" };
  expect(promotePendingItem([first, second], "b").map((item) => item.id)).toEqual(
    ["b", "a"],
  );
  expect(
    pendingSessionIds({
      [DRAFT_QUEUE_KEY]: [first],
      "session-1": [second],
      "session-2": [],
    }),
  ).toEqual(["session-1"]);
  expect(
    sessionHasActiveJob([{ status: "completed" }, { status: "running" }]),
  ).toBe(true);
  expect(sessionHasActiveJob([{ status: "cancelled" }])).toBe(false);
});
