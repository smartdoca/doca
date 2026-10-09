import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAIMemory,
  memoryOwner,
  messageText,
} from "../apps/server/src/services/ai/memory.js";
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
      enabled: true,
      tools: true,
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

it("keeps the just-observed cursor through a real SDK reflection and does not observe those turns again after reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "doca-reflection-cursor-"));
  let memory = await createAIMemory({
    driver: "sqlite",
    url: join(root, "memory.db"),
  });
  const sid = "reflection-session",
    owner = memoryOwner("reflection-owner");
  const critical =
    "原任务task-original；妈妈=ref-mom，爸爸=ref-dad，Kipper替换为Zeze；背景与非目标文字严格保留；完整12页验收。";
  let observerCalls = 0,
    reflectionCalls = 0;
  const model = createAIModel(
    {
      id: "reflection-fixture",
      model: "reflection-fixture",
      alias: "Fixture",
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture",
      enabled: true,
      tools: false,
      maxInput: 16000,
      maxOutput: 12000,
    },
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const reflector = body.messages.some(
        (message: any) =>
          message.role === "system" &&
          String(message.content).includes("observation reflector"),
      );
      if (reflector) reflectionCalls++;
      else observerCalls++;
      return completionResponse(
        {
          id: "cursor-fixture",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: `<observations>\nDate: 2026-09-15\n- 🔴 ${critical}\n${reflector ? "- 🟡 尚未完成，不得把计划当作验收通过。" : Array.from({ length: 90 }, (_, index) => `- 🟡 未完事实${index}：保留原任务的页面顺序、爸爸妈妈与孩子身份关系及姓名、附件准确标识和完整验收要求。`).join("\n")}\n</observations>`,
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
  const messages = Array.from({ length: 24 }, (_, index) => ({
    id: `cursor-${index}`,
    threadId: sid,
    resourceId: owner,
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    createdAt: new Date(Date.UTC(2026, 8, 15, 0, 0, index)),
    content: {
      format: 2 as const,
      parts: [
        {
          type: "text" as const,
          text:
            index % 2
              ? `已记录第${index}轮，尚未验收。`
              : `${critical}\n${"Historical task details preserve exact authorized references and all delivery requirements. ".repeat(140)}`,
        },
      ],
      metadata: {
        references: [{ resourceId: "task-original" }],
        attachments: [
          { id: "ref-mom", filename: "mom.png" },
          { id: "ref-dad", filename: "dad.png" },
        ],
      },
    },
  }));
  const opts = () => ({
    memory,
    model,
    maxInput: 16000,
    maxOutput: 12000,
    keepRecentRounds: 2,
    userId: "reflection-owner",
    sessionId: sid,
    excludeId: "current",
  });
  try {
    await memory.memory.createThread({
      threadId: sid,
      resourceId: owner,
      title: "Reflection fixture",
    });
    await memory.memory.saveMessages({ messages });
    const before = (
      await memory.memory.recall({
        threadId: sid,
        resourceId: owner,
        perPage: false,
      })
    ).messages;
    const compacted = await conversationHistory(opts());
    expect(observerCalls).toBeGreaterThan(0);
    expect(reflectionCalls).toBeGreaterThan(0);
    expect(compacted.messages.length).toBeLessThan(messages.length);
    expect(compacted.summary).toContain(critical);
    const stored = (
      await memory.memory.recall({
        threadId: sid,
        resourceId: owner,
        perPage: false,
      })
    ).messages;
    expect(stored.map((message) => message.id).sort()).toEqual(
      messages.map((message) => message.id).sort(),
    );
    for (const original of before) {
      expect(
        messageText(stored.find((message) => message.id === original.id)),
      ).toBe(messageText(original));
      expect(
        stored.find((message) => message.id === original.id)?.content.metadata,
      ).toEqual(original.content.metadata);
    }
    const store = await memory.storage.getStore("memory");
    const record = await store!.getObservationalMemory(sid, owner);
    expect(record!.generationCount).toBeGreaterThan(0);
    expect(+new Date(record!.lastObservedAt!)).toBeGreaterThanOrEqual(
      +messages[0]!.createdAt,
    );
    const observedThrough = +new Date(record!.lastObservedAt!);
    expect(compacted.summary).toBe(record!.activeObservations);
    expect(record!.totalTokensObserved).toBeGreaterThan(0);
    const generations = await store!.getObservationalMemoryHistory(sid, owner);
    expect(generations.length).toBeGreaterThan(1);
    // The storage engine retains observation IDs on their original generation;
    // reflection creates a separate summary row without rewriting those facts.
    expect(
      [
        ...new Set(
          generations.flatMap(
            (generation) => generation.observedMessageIds ?? [],
          ),
        ),
      ].sort(),
    ).toEqual(
      messages
        .filter((message) => +message.createdAt <= observedThrough)
        .map((message) => message.id)
        .sort(),
    );
    for (const generation of generations) {
      expect(+new Date(generation.lastObservedAt!)).toBeLessThanOrEqual(
        observedThrough,
      );
      expect(generation.totalTokensObserved).toBeLessThanOrEqual(
        record!.totalTokensObserved,
      );
    }
    expect(
      compacted.messages.every(
        (message) => +new Date(message.createdAt) > observedThrough,
      ),
    ).toBe(true);
    const calls = observerCalls + reflectionCalls;
    await memory.close();
    memory = await createAIMemory({
      driver: "sqlite",
      url: join(root, "memory.db"),
    });
    const reopened = await conversationHistory(opts());
    expect(reopened.summary).toBe(compacted.summary);
    expect(reopened.messages.map((message) => message.id)).toEqual(
      compacted.messages.map((message) => message.id),
    );
    expect(observerCalls + reflectionCalls).toBe(calls);
  } finally {
    await memory.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
