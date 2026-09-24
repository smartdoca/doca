import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAIMemory, memoryOwner } from "../apps/server/src/services/ai/memory.js";
import { conversationHistory } from "../apps/server/src/services/ai/history.js";
import { createAIModel } from "../apps/server/src/services/ai/providers.js";
import { completionResponse } from "./ai-mock.js";

it("uses persistent Mastra block observations, keeps short conversations intact and isolates owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "doca-context-"));
  let memory = await createAIMemory({
    driver: "sqlite",
    url: join(root, "memory.db"),
  });
  let calls = 0,
    failure = false;
  const model = createAIModel(
    {
      id: "fixture",
      model: "fixture",
      alias: "fixture",
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture",
      levels: [],
      enabled: true,
      tools: true,
      inputRate: 1,
      outputRate: 1,
      cacheRate: 0.5,
      maxInput: 24000,
      maxOutput: 4000,
    },
    (async (_url, init) => {
      calls++;
      if (failure)
        return Response.json(
          { error: { message: "fixture failure" } },
          { status: 401 },
        );
      const body = JSON.parse(String(init?.body));
      return completionResponse(
        {
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content:
                  "<observations>\nDate: 2026-09-15\n- 🔴 用户交付要求：中文调研报告，保留来源链接；目标文档 doc-demo，尚未完成验收。\n</observations>",
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
          },
        },
        !!body.stream,
      );
    }) as typeof fetch,
  );
  const owner = memoryOwner("owner"),
    sid = "context-session";
  const opts = () => ({
    memory,
    model,
    maxInput: 24000,
    maxOutput: 4000,
    keepRecentRounds: 2,
    userId: "owner",
    sessionId: sid,
    excludeId: "current",
  });
  const add = async (start: number, count: number, long = false) => {
    const messages = Array.from({ length: count }, (_, i) => ({
      id: `message-${start + i}`,
      threadId: sid,
      resourceId: owner,
      role: (start + i) % 2 ? ("assistant" as const) : ("user" as const),
      createdAt: new Date(Date.UTC(2026, 8, 15, 0, 0, start + i)),
      content: {
        format: 2 as const,
        parts: [
          {
            type: "text" as const,
            text: `第${start + i}条。${long ? "调研报告的背景和详细要求，尚未完成验收。".repeat(400) : "请保留报告来源链接"}`,
          },
        ],
        metadata: { references: [{ resourceId: "doc-demo" }] },
      },
    }));
    await memory.memory.saveMessages({ messages });
  };
  try {
    await memory.memory.createThread({
      threadId: sid,
      resourceId: owner,
      title: "隔离上下文",
    });
    await add(0, 20);
    const short = await conversationHistory(opts());
    expect(short.messages).toHaveLength(20); // keepRecentRounds is NOT a last-N window.
    expect(short.summary).toBe("");
    expect(calls).toBe(0);
    await expect(
      conversationHistory({ ...opts(), userId: "other" }),
    ).rejects.toThrow();
    await add(20, 8, true);
    failure = true;
    await expect(conversationHistory(opts())).rejects.toThrow();
    expect(
      (
        await memory.memory.recall({
          threadId: sid,
          resourceId: owner,
          perPage: false,
        })
      ).messages,
    ).toHaveLength(28);
    failure = false;
    const compacted = await conversationHistory(opts());
    expect(compacted.summary).toContain("中文调研报告");
    expect(compacted.messages.length).toBeLessThan(28);
    expect(
      (
        await memory.memory.recall({
          threadId: sid,
          resourceId: owner,
          perPage: false,
        })
      ).messages,
    ).toHaveLength(28);
    const afterCompressionCalls = calls;
    await memory.close();
    memory = await createAIMemory({
      driver: "sqlite",
      url: join(root, "memory.db"),
    });
    const restored = await conversationHistory(opts());
    expect(restored.summary).toBe(compacted.summary);
    expect(restored.messages.map((m) => m.id)).toEqual(
      compacted.messages.map((m) => m.id),
    );
    expect(calls).toBe(afterCompressionCalls);
    await add(28, 2);
    const continued = await conversationHistory(opts());
    expect(continued.summary).toBe(compacted.summary);
    expect(continued.messages.slice(0, -2).map((m) => m.id)).toEqual(
      compacted.messages.map((m) => m.id),
    );
    expect(calls).toBe(afterCompressionCalls);
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
