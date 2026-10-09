import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import {
  aiDefaults,
  saveAIConfig,
} from "@core/modules/ai/config.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { completionResponse } from "./ai-mock.js";
import { readAIDocument } from "@core/workflows/ai-documents.js";
import { defaultOfficialSkills } from "@core/modules/ai/skills.js";

let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      defaultModel: "test",
      vendors: [
        {
          id: "test-vendor",
          name: "测试厂商",
          provider: "compatible",
          baseUrl: "https://model.example.test/v1",
          apiKey: "private-key-test",
          enabled: true,
        },
      ],
      models: [
        {
          id: "test",
          vendorId: "test-vendor",
          model: "private-real-model",
          alias: "创作助手",
          enabled: true,
          maxInput: 64000,
          maxOutput: 4000,
          tools: true,
        },
      ],
    },
    0,
  );
});
afterEach(async () => {
  await db.destroy();
});

type Script = (ctx: {
  toolMessages: any[];
  prompt: string;
  body: any;
}) => { name: string; args: any } | { text: string };
function scriptedAI(script: Script, review: Script, seen: string[] = []) {
  return (async (_url: any, init: any) => {
    if (String(_url).endsWith("/models"))
      return Response.json({ data: [{ id: "isolated-mock" }] });
    const body = JSON.parse(String(init?.body));
    const messages: any[] = body.messages;
    const toolMessages = messages
      .filter((m) => m.role === "tool")
      .map((m) => m.content);
    seen.push(...toolMessages.map((c: any) => String(c).slice(0, 400)));
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const content = messages[lastUser]?.content;
    const prompt = Array.isArray(content)
      ? content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")
      : String(content ?? "");
    const isReview = body.tools?.some(
      (t: any) => t.function?.name === "submit_review",
    );
    const next = (isReview ? review : script)({ toolMessages, prompt, body });
    const message =
      "text" in next
        ? { role: "assistant", content: next.text }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `mock-${toolMessages.length}`,
                type: "function",
                function: {
                  name: next.name,
                  args: undefined,
                  arguments: JSON.stringify(next.args),
                },
              },
            ],
          };
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
            finish_reason: "text" in next ? "stop" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      },
      !!body.stream,
    );
  }) as typeof fetch;
}
// Reviewer that passes only when the saved artifact contains a real link element.
const linkReview: Script = ({ toolMessages, prompt }) => {
  const reads = toolMessages.map((m) => {
    try {
      return JSON.parse(m);
    } catch {
      return null;
    }
  });
  const current = reads.findLast((r) => r?.resource);
  if (!current) {
    const id = prompt.match(/[a-f0-9-]{36}/)?.[0];
    return { name: "document_read", args: { resourceId: id, offset: 0 } };
  }
  const hasRealLink =
    current.content.includes('"type":"link"') &&
    current.content.includes("doca.example.com");
  return {
    name: "submit_review",
    args: {
      verdict: hasRealLink ? "pass" : "revise",
      summary: hasRealLink ? "链接已真实写入" : "未检测到链接元素",
      checks: [
        {
          requirement: "文档包含可点击链接",
          passed: hasRealLink,
          evidence: hasRealLink ? "回读到 link 元素" : "回读只有纯文本",
        },
      ],
    },
  };
};
async function runJob(
  app: Awaited<ReturnType<typeof createApp>>,
  cookie: string,
  docId: string | null,
  text: string,
) {
  const request = (method: any, path: string, payload?: any) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { host: "localhost:39139", origin: "http://localhost:39139", cookie },
      payload,
    });
  const sid = (
    await request("POST", "/ai/sessions", {
      modelId: "test",
      resourceIds: docId ? [docId] : [],
    })
  ).json().id;
  const jobId = randomUUID();
  await request("POST", `/ai/sessions/${sid}/messages`, {
    id: jobId,
    text,
    modelId: "test",
    scope: docId ? "document" : "all",
    references: docId ? [{ resourceId: docId }] : [],
    ...(docId ? {} : { skipApprovals: { create: true } }),
  });
  for (let i = 0; i < 200; i++) {
    const result = (await request("GET", `/ai/sessions/${sid}`)).json();
    const job = result.jobs.find((j: any) => j.id === jobId);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("job timeout");
}
async function setup(fetcher: typeof fetch) {
  const doc = await createContent(db).create(owner, {
    title: "链接目标文档",
    kind: "document",
    format: "rich_text",
  });
  const origin = "http://localhost:39139";
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: fetcher },
  });
  const cookie = String(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { host: "localhost:39139", origin },
        payload: { login: "owner", password: "test-password-2026" },
      })
    ).headers["set-cookie"],
  ).split(";")[0]!;
  return { app, cookie, doc };
}

it("appended markdown link syntax is saved as a real link element and passes review", async () => {
  const script: Script = ({ toolMessages, prompt }) => {
    if (!toolMessages.length) {
      const id = prompt.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];
      return { name: "document_read", args: { resourceId: id, offset: 0 } };
    }
    const read = JSON.parse(toolMessages[0]);
    if (toolMessages.length === 1)
      return {
        name: "rich_text_edit",
        args: {
          resourceId: read.resource.id,
          seq: read.seq,
          epochId: read.epochId,
          operations: [
            {
              type: "append",
              text: "详见 [Doca 官网](https://doca.example.com) 获取更多信息",
            },
          ],
        },
      };
    return { text: "已在文档末尾插入链接。" };
  };
  const { app, cookie, doc } = await setup(scriptedAI(script, linkReview));
  try {
    const job = await runJob(
      app,
      cookie,
      doc.id,
      "在文档末尾添加 Doca 官网链接 https://doca.example.com",
    );
    expect(job.status, JSON.stringify(job.progress?.events)).toBe("completed");
    expect(job.progress?.review?.verdict).toBe("pass");
  } finally {
    await app.close();
  }
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const links = JSON.stringify(after.value).match(/"type":"link"/g) ?? [];
  expect(links.length).toBe(1);
  expect(JSON.stringify(after.value)).toContain("https://doca.example.com");
}, 60000);

it("unknown edit commands return a precise server error the model can fix", async () => {
  const seen: string[] = [];
  const script: Script = ({ toolMessages, prompt }) => {
    if (!toolMessages.length) {
      const id = prompt.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0];
      return { name: "document_read", args: { resourceId: id, offset: 0 } };
    }
    const read = JSON.parse(toolMessages[0]);
    if (toolMessages.length === 1)
      return {
        name: "rich_text_edit",
        args: {
          resourceId: read.resource.id,
          seq: read.seq,
          epochId: read.epochId,
          operations: [{ type: "node", id: "x" }],
        },
      };
    if (toolMessages.length === 2)
      return {
        name: "rich_text_edit",
        args: {
          resourceId: read.resource.id,
          seq: read.seq,
          epochId: read.epochId,
          operations: [{ type: "append", text: "修正后的内容" }],
        },
      };
    return { text: "已保存。" };
  };
  const review: Script = ({ toolMessages, prompt }) => {
    const reads = toolMessages
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!reads.some((r: any) => r.resource)) {
      const id = prompt.match(/[a-f0-9-]{36}/)?.[0];
      return { name: "document_read", args: { resourceId: id, offset: 0 } };
    }
    return {
      name: "submit_review",
      args: {
        verdict: "pass",
        summary: "隔离测试通过",
        checks: [
          { requirement: "内容已保存", passed: true, evidence: "已回读" },
        ],
      },
    };
  };
  const { app, cookie, doc } = await setup(scriptedAI(script, review, seen));
  try {
    const job = await runJob(app, cookie, doc.id, "修改这份文档");
    expect(job.status, JSON.stringify(job.progress?.events)).toBe("completed");
  } finally {
    await app.close();
  }
  expect(
    seen.some((m) => m.includes("不支持 rich_text 命令 node")),
    JSON.stringify(seen, null, 1),
  ).toBe(true);
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  expect(JSON.stringify(after.value)).toContain("修正后的内容");
}, 60000);

it.each([
  ["帮我生成一个年会报告的文档模板", true],
  ["新建采购清单", false],
])("creates and fills a native table with an automatically supplied manual: %s", async (text, preload) => {
  const writing = defaultOfficialSkills.find((skill) => skill.id === "writing")!;
  const calls: string[] = [];
  let createdId = "";
  const script: Script = ({ toolMessages, prompt, body }) => {
    const step = toolMessages.length;
    if (!step) {
      expect(prompt.includes(writing.content)).toBe(preload);
      if (preload) expect(prompt.indexOf(writing.content)).toBeLessThan(prompt.lastIndexOf("【用户要求】"));
      expect(JSON.stringify(body.messages.filter((message: any) => message.role === "system"))).not.toContain(writing.content);
      calls.push("document_create");
      return { name: "document_create", args: { title: "隔离文档模板" } };
    }
    const created = JSON.parse(toolMessages[0]);
    createdId = created.id;
    expect(createdId).toBeTruthy();
    expect(created.format).toBe("rich_text");
    if (!preload) expect(created.editingSkill).toEqual({ id: writing.id, name: writing.name, instructions: writing.content });
    if (step === 1 || step === 3) {
      calls.push("document_read");
      return { name: "document_read", args: { resourceId: createdId } };
    }
    if (step === 2) {
      const read = JSON.parse(toolMessages[1]);
      expect(read.editingSkill).toBeUndefined();
      calls.push("rich_text_edit");
      return { name: "rich_text_edit", args: {
        resourceId: createdId, seq: read.seq, epochId: read.epochId,
        operations: [{ type: "insertTable", rows: 2, columns: 2, afterId: read.outline.blocks.at(-1).id }],
      } };
    }
    if (step === 4) {
      const read = JSON.parse(toolMessages[3]);
      const table = read.outline.blocks.find((block: any) => block.type === "table");
      expect(table.rows).toHaveLength(2);
      calls.push("rich_text_edit");
      return { name: "rich_text_edit", args: {
        resourceId: createdId, seq: read.seq, epochId: read.epochId,
        operations: table.rows[0].cells.map((cell: any, index: number) => ({
          type: "setCellContent", tableId: table.id, cellId: cell.id,
          children: [{ id: randomUUID(), type: "paragraph", children: [{ text: ["指标", "目标值"][index] }] }],
        })),
      } };
    }
    return { text: "文档模板已保存。" };
  };
  const review: Script = ({ toolMessages }) => {
    if (!toolMessages.length) return { name: "document_read", args: { resourceId: createdId } };
    const read = JSON.parse(toolMessages.at(-1));
    if (read.accepted) return { text: "验收完成。" };
    const saved = String(read.content).includes("指标") && String(read.content).includes("目标值");
    return { name: "submit_review", args: {
      verdict: saved ? "pass" : "revise", summary: "核对隔离模板表格",
      checks: [{ requirement: "原生表格内容已保存", passed: saved, evidence: String(read.content).slice(0, 500) }],
    } };
  };
  const { app, cookie } = await setup(scriptedAI(script, review));
  try {
    const job = await runJob(app, cookie, null, text);
    expect(job.status, job.error ?? JSON.stringify(job.progress?.events)).toBe("completed");
    expect(job.progress.events.filter((event: any) => event.kind === "tool" && event.status === "error")).toEqual([]);
    expect(calls).toEqual(["document_create", "document_read", "rich_text_edit", "document_read", "rich_text_edit"]);
    const saved = await readAIDocument(db, { actor: owner }, createdId);
    const table = (saved.value as any[]).find((block) => block.type === "table");
    expect(table.children[0].children.map((cell: any) => cell.children[0].children[0].text)).toEqual(["指标", "目标值"]);
  } finally {
    await app.close();
  }
}, 60000);

it("supplies the actual document manual on a read when the request did not identify its format", async () => {
  const writing = defaultOfficialSkills.find((skill) => skill.id === "writing")!;
  let targetId = "";
  const script: Script = ({ toolMessages, prompt }) => {
    if (!toolMessages.length) {
      expect(prompt).not.toContain(writing.content);
      return { name: "document_read", args: { resourceId: targetId } };
    }
    const read = JSON.parse(toolMessages[0]);
    expect(read.editingSkill).toEqual({ id: writing.id, name: writing.name, instructions: writing.content });
    if (toolMessages.length === 1) return { name: "rich_text_edit", args: {
      resourceId: targetId, seq: read.seq, epochId: read.epochId,
      operations: [{ type: "append", text: "说明详见 [Doca 官网](https://doca.example.com)" }],
    } };
    return { text: "已补充说明。" };
  };
  const { app, cookie, doc } = await setup(scriptedAI(script, linkReview));
  targetId = doc.id;
  try {
    const job = await runJob(app, cookie, null, "补充一段说明");
    expect(job.status, job.error).toBe("completed");
    expect(job.progress.review.verdict).toBe("pass");
    const saved = await readAIDocument(db, { actor: owner }, doc.id);
    expect(JSON.stringify(saved.value)).toContain("https://doca.example.com");
  } finally {
    await app.close();
  }
}, 60000);
