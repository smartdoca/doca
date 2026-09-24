// Isolated AI link-insertion QA server; never point a production client at it.
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
import { completionResponse } from "../tests/ai-mock.js";
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
const content = createContent(db);
const richDoc = await content.create(owner, {
  kind: "document",
  format: "rich_text",
  title: "链接验收文档",
});
await readAIDocument(db, { actor: owner }, richDoc.id);
const markdownDoc = await content.create(owner, {
  kind: "document",
  format: "markdown",
  title: "Markdown 链接验收",
  markdown: "# 笔记\n\n待补充链接。\n",
});
await readAIDocument(db, { actor: owner }, markdownDoc.id);
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
// Scripted model: read the target, then append a markdown-syntax link.
// The server must persist a native link element, and the reviewer passes only
// when the saved document actually contains one.
const reply = (body: any) => {
  const messages: any[] = body.messages;
  const toolMessages = messages.filter((m) => m.role === "tool");
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const content = messages[lastUser]?.content;
  const prompt = Array.isArray(content)
    ? content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")
    : String(content ?? "");
  const call = (name: string, args: any) => ({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `link-${toolMessages.length}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  let message: any;
  if (body.tools?.some((t: any) => t.function?.name === "submit_review")) {
    const reads = toolMessages.map((m) => {
      try {
        return JSON.parse(m.content);
      } catch {
        return null;
      }
    });
    const current = reads.findLast((r) => r?.resource);
    if (!current) {
      const id = prompt.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];
      message = call("document_read", { resourceId: id, offset: 0 });
    } else {
      const saved =
        current.content.includes('"type":"link"') ||
        current.content.includes("](https://doca.example.com)");
      message = call("submit_review", {
        verdict: saved ? "pass" : "revise",
        summary: saved ? "链接已真实写入文档" : "回读未检测到链接，继续修复",
        checks: [
          {
            requirement: "文档包含真实链接",
            passed: saved,
            evidence: saved ? "回读快照含链接" : "回读只有纯文本",
          },
        ],
      });
    }
  } else if (!toolMessages.length) {
    const id = prompt.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];
    message = call("document_read", { resourceId: id, offset: 0 });
  } else if (toolMessages.length === 1) {
    const read = JSON.parse(toolMessages[0].content);
    message = call(`${read.resource.format}_edit`, {
      resourceId: read.resource.id,
      seq: read.seq,
      epochId: read.epochId,
      operations: [
        {
          type: "append",
          text: "\n详见 [Doca 官网](https://doca.example.com) 获取更多信息",
        },
      ],
    });
  } else {
    message = { role: "assistant", content: "已在文档末尾插入官网链接。" };
  }
  return completionResponse(
    {
      id: "mock-response",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    },
    !!body.stream,
  );
};
const port = Number(process.env.DOCA_QA_PORT ?? 39261),
  origin = `http://127.0.0.1:${port}`;
const uploadRoot = await mkdtemp(resolve(tmpdir(), "doca-ai-link-qa-"));
const staticRoot = await mkdtemp(resolve(tmpdir(), "doca-ai-link-web-"));
await cp(resolve("apps/web/dist"), staticRoot, { recursive: true });
const app = await createApp(db, {
  storage: { ...storageRuntime(), root: uploadRoot },
  origin,
  staticDirectory: staticRoot,
  ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    fetch: (async (_url: any, init: any) => {
      if (String(_url).endsWith("/models"))
        return Response.json({ data: [{ id: "isolated-mock" }] });
      return reply(JSON.parse(String(init?.body)));
    }) as typeof fetch,
  },
});
await app.listen({ host: "127.0.0.1", port });
console.log(
  JSON.stringify({
    origin,
    login: "aiqa",
    password: "isolated-ai-qa-2026",
    documents: [
      { id: richDoc.id, title: "链接验收文档", format: "rich_text" },
      { id: markdownDoc.id, title: "Markdown 链接验收", format: "markdown" },
    ],
  }),
);
const close = async () => {
  await app.close();
  await db.destroy();
  await rm(uploadRoot, { recursive: true, force: true });
  await rm(staticRoot, { recursive: true, force: true });
};
process.on("SIGINT", () => void close().then(() => process.exit(0)));
process.on("SIGTERM", () => void close().then(() => process.exit(0)));
