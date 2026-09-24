// Isolated fixture for composer approval/choice cards; never pass a production origin.
if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Isolated AI QA only: set DOCA_QA_ISOLATED=1");
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { readAIDocument } from "../packages/core/src/workflows/ai-documents.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { createApp } from "../apps/server/src/bootstrap/app.js";
import { completionResponse, mockAI } from "../tests/ai-mock.js";
import { resolve } from "node:path";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const owner = {
  ...(await createUser(
    db,
    {
      login: "aiqa",
      displayName: "AI 验收员",
      password: "isolated-ai-qa-2026",
    },
    { bootstrap: true },
  )),
  admin: 1,
};
const content = createContent(db),
  docs = [];
for (const [format, title] of [
  ["rich_text", "项目说明"],
  ["markdown", "研发笔记"],
] as const) {
  const r = await content.create(owner, { kind: "document", format, title });
  await readAIDocument(db, { actor: owner }, r.id);
  docs.push({ id: r.id, title, format });
}
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    enabled: true,
    memoryEnabled: true,
    defaultModel: "mock",
    limits: { standard: { day: 1000000, week: 5000000, month: 20000000 } },
    models: [
      {
        id: "mock",
        model: "isolated-mock",
        alias: "创作助手（模拟）",
        baseUrl: "https://isolated.invalid/v1",
        apiKey: "not-a-real-key",
        enabled: true,
        levels: [],
        inputRate: 1,
        outputRate: 2,
        cacheRate: 0.5,
        maxInput: 64000,
        maxOutput: 2000,
        tools: true,
        vision: true,
      },
    ],
  },
  0,
);
const base = mockAI({ delay: Number(process.env.DOCA_QA_DELAY ?? 120) });
const fixture = (async (url: any, init: any) => {
  if (String(url).endsWith("/models")) return base(url, init);
  const body = JSON.parse(String(init?.body));
  const messages: any[] = body.messages ?? [];
  const lastUser = messages.findLastIndex((m: any) => m.role === "user");
  const answered = messages
    .slice(lastUser + 1)
    .some((m: any) => m.role === "tool");
  const lastText = JSON.stringify(messages[lastUser]?.content ?? "");
  const reply = (content: string | null, toolCalls?: any[]) =>
    completionResponse(
      {
        id: "mock-choice",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
        },
      },
      !!body.stream,
    );
  if (!answered && lastText.includes("请做选择"))
    return reply(null, [
      {
        id: "mock-ask-user",
        type: "function",
        function: {
          name: "ask_user",
          arguments: JSON.stringify({
            title: "报告面向谁？",
            options: ["管理层", "开发团队", "客户"],
          }),
        },
      },
    ]);
  if (!answered && lastText.includes("链接测试"))
    return reply(
      "外部链接 [Example 文档](https://example.com/docs) 与行内代码 `https://example.com/in-code`：\n\n```text\nhttps://example.com/in-block\n```\n\n结束。",
    );
  return base(url, init);
}) as typeof fetch;
const port = Number(process.env.DOCA_QA_PORT ?? 39257),
  origin = `http://${process.env.DOCA_QA_HOSTNAME ?? "127.0.0.1"}:${port}`;
const uploadRoot = await mkdtemp(resolve(tmpdir(), "doca-ai-qa-"));
const staticRoot = await mkdtemp(resolve(tmpdir(), "doca-ai-qa-web-"));
await cp(resolve("apps/web/dist"), staticRoot, { recursive: true });
const app = await createApp(db, {
  storage: { ...storageRuntime(), root: uploadRoot },
  origin,
  staticDirectory: staticRoot,
  ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: fixture },
});
await app.listen({ host: "127.0.0.1", port });
console.log(
  JSON.stringify({
    origin,
    model: "isolated-mock",
    login: "aiqa",
    password: "isolated-ai-qa-2026",
    documents: docs,
  }),
);
const close = async () => {
  await app.close();
  await db.destroy();
  await rm(uploadRoot, { recursive: true, force: true });
  await rm(staticRoot, { recursive: true, force: true });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
