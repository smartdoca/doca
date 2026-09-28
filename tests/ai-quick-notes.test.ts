import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import {
  aiDefaults,
  saveAIConfig,
} from "@core/modules/ai/config.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { completionResponse, mockAI } from "./ai-mock.js";
import type { QuickNote } from "@core/shared/quick-notes.js";
let db: DB, owner: Actor;
const password = "quick-note-ai-isolated-2026";
const origin = "http://localhost:39135";
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const c = {
    ...aiDefaults,
    defaultModel: "test",
    memoryEnabled: true,
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
        maxInput: 32000,
        maxOutput: 1000,
        tools: true,
      },
    ],
  };
  await saveAIConfig(db, c, 0);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
});
function scripted(replies: string[], counter?: { calls: number }) {
  let call = 0;
  return (async (url: any, init: any) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "isolated-mock" }] });
    const body = JSON.parse(String(init?.body));
    if (body?.messages) {
      if (counter) counter.calls++;
      call++;
    }
    const content = replies[Math.min(call - 1, replies.length - 1)];
    return completionResponse(
      {
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      !!body?.stream,
    );
  }) as typeof fetch;
}
async function harness(modelFetch: typeof fetch) {
  const app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: modelFetch },
  });
  const headers: any = { host: "localhost:39135", origin };
  const req = (method: any, path: string, payload?: any) =>
    app.inject({ method, url: "/api/v1" + path, headers, payload });
  headers.cookie = String(
    (await req("POST", "/auth/login", { login: "owner", password })).headers[
      "set-cookie"
    ],
  ).split(";")[0];
  const note = (
    await req("PUT", "/quick-notes/" + randomUUID(), {
      content: [
        {
          id: randomUUID(),
          type: "paragraph",
          children: [{ text: "明天上午十点产品评审，记得准备数据。" }],
        },
      ],
      assetIds: [],
    })
  ).json() as QuickNote;
  const sid = (await req("POST", "/ai/sessions", { modelId: "test" })).json()
    .id;
  const send = async (text: string) => {
    const sent = await req("POST", `/ai/sessions/${sid}/messages`, {
      id: randomUUID(),
      modelId: "test",
      scope: "all",
      text,
      quickNoteIds: [note.id],
    });
    expect(sent.statusCode, sent.body).toBe(200);
  };
  const session = async () => (await req("GET", `/ai/sessions/${sid}`)).json();
  return { app, req, note, sid, send, session };
}
function expectTextOnly(job: any, operations: any[]) {
  expect(job?.status, job?.error).toBe("completed");
  expect(job.progress.phase).toBe("completed");
  expect(job.progress.review).toBeUndefined();
  expect(job.progress.approvals).toBeUndefined();
  expect(
    (job.progress.events ?? []).some(
      (e: any) =>
        String(e.text).includes("未发现文档保存记录") ||
        String(e.text).includes("独立验收"),
    ),
  ).toBe(false);
  expect(operations).toHaveLength(0);
}
it("answers quick-note text requests without document checks or creation", async () => {
  const counter = { calls: 0 };
  const { app, send, session } = await harness(
    scripted(
      [
        "已按你的要求改成纯文字，内容如下：\n\n明天上午十点产品评审，记得准备数据。\n\n需要存档的话我可以帮你保存成文档。",
      ],
      counter,
    ),
  );
  try {
    await send("把这条随手记转成文字发我");
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs).toHaveLength(1);
        expectTextOnly(result.jobs[0], result.operations);
      },
      { timeout: 10000 },
    );
    expect(counter.calls).toBe(1);
    expect(
      (await session()).messages.some((m: any) =>
        m.text.includes("已按你的要求改成纯文字"),
      ),
    ).toBe(true);
    expect(
      await db
        .selectFrom("resources")
        .select("id")
        .where("deleted_at", "is", null)
        .execute(),
    ).toHaveLength(0);
  } finally {
    await app.close();
  }
}, 20000);

it("stops document validation in later turns after the user declines documents", async () => {
  const counter = { calls: 0 };
  const { app, send, session } = await harness(
    scripted(
      [
        "好的，本次不再创建文档，已将内容转为文字如下：\n\n明天上午十点产品评审，记得准备数据。",
        "已帮你改成纯文字，文档就不用创建了。",
      ],
      counter,
    ),
  );
  try {
    await send("把这条随手记的内容发我，不需要文档");
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs).toHaveLength(1);
        expectTextOnly(result.jobs[0], result.operations);
      },
      { timeout: 10000 },
    );
    await send("不需要文档，保持现状就好");
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs).toHaveLength(2);
        expect(result.jobs[0]?.status, result.jobs[0]?.error).toBe("completed");
      },
      { timeout: 10000 },
    );
    const result = await session();
    for (const job of result.jobs) expectTextOnly(job, result.operations);
    expect(counter.calls).toBe(2);
    expect(
      await db
        .selectFrom("resources")
        .select("id")
        .where("deleted_at", "is", null)
        .execute(),
    ).toHaveLength(0);
  } finally {
    await app.close();
  }
}, 20000);

it("still creates and reviews a document when the user explicitly asks to save one", async () => {
  const { app, req, send, session } = await harness(mockAI());
  try {
    await send("把这条随手记创建成文档保存下来");
    let approval: any, jobId = "";
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "awaiting_approval",
        );
        jobId = result.jobs[0].id;
        approval = result.jobs[0].progress.approvals[0];
        expect(result.operations).toHaveLength(0);
      },
      { timeout: 10000 },
    );
    expect(
      (
        await req("POST", `/ai/jobs/${jobId}/approval`, {
          approvalId: approval.id,
          approved: true,
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "completed",
        );
        expect(result.jobs[0].progress.review?.verdict).toBe("pass");
        expect(result.operations).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    const docs = await db
      .selectFrom("resources")
      .select(["id", "title", "format"])
      .where("deleted_at", "is", null)
      .execute();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toContain("项目计划");
    expect(docs[0]?.format).toBe("rich_text");
  } finally {
    await app.close();
  }
}, 30000);

it("creates markdown only when the user explicitly asks for it", async () => {
  const { app, req, send, session } = await harness(mockAI());
  try {
    await send("把这条随手记创建成 Markdown 文档保存下来");
    let approval: any, jobId = "";
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "awaiting_approval",
        );
        jobId = result.jobs[0].id;
        approval = result.jobs[0].progress.approvals[0];
      },
      { timeout: 10000 },
    );
    expect(approval.code).toBe("create_documents");
    expect(approval.data?.formats).toBe("markdown");
    expect(approval).not.toHaveProperty("title");
    expect(approval).not.toHaveProperty("detail");
    expect(
      (
        await req("POST", `/ai/jobs/${jobId}/approval`, {
          approvalId: approval.id,
          approved: true,
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "completed",
        );
        expect(result.jobs[0].progress.review?.verdict).toBe("pass");
      },
      { timeout: 10000 },
    );
    const docs = await db
      .selectFrom("resources")
      .select(["id", "format"])
      .where("deleted_at", "is", null)
      .execute();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.format).toBe("markdown");
  } finally {
    await app.close();
  }
}, 30000);

it("asks which document format to create when the type is unclear", async () => {
  const { app, req, send, session } = await harness(mockAI());
  try {
    await send("帮我把这条随手记整理成资料");
    await vi.waitFor(
      async () => {
        const result = await session();
        const job = result.jobs[0];
        expect(job?.status, job?.error).toBe("completed");
        expect(job.progress.phase).toBe("waiting_choice");
        expect(job.progress.questions[0].options).toEqual([
          "富文本文档",
          "Markdown 文档",
          "表格",
          "演示文稿",
        ]);
        expect(result.operations).toHaveLength(0);
      },
      { timeout: 10000 },
    );
    expect(
      await db
        .selectFrom("resources")
        .select("id")
        .where("deleted_at", "is", null)
        .execute(),
    ).toHaveLength(0);
    await send("要创建哪种类型的文档？\n我的选择：表格");
    let approval: any, jobId = "";
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "awaiting_approval",
        );
        jobId = result.jobs[0].id;
        approval = result.jobs[0].progress.approvals[0];
      },
      { timeout: 10000 },
    );
    expect(approval.code).toBe("create_documents");
    expect(approval.data?.formats).toBe("spreadsheet");
    expect(
      (
        await req("POST", `/ai/jobs/${jobId}/approval`, {
          approvalId: approval.id,
          approved: true,
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs[0]?.status, JSON.stringify(result.jobs)).toBe(
          "completed",
        );
        expect(result.jobs[0].progress.review?.verdict).toBe("pass");
        expect(result.operations).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    const docs = await db
      .selectFrom("resources")
      .select(["id", "format"])
      .where("deleted_at", "is", null)
      .execute();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.format).toBe("spreadsheet");
  } finally {
    await app.close();
  }
}, 30000);

it("asks with a choice card instead of assuming document creation when unsure", async () => {
  const counter = { calls: 0 };
  let call = 0;
  const modelFetch = (async (url: any, init: any) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "isolated-mock" }] });
    const body = JSON.parse(String(init?.body));
    counter.calls++;
    const message =
      ++call === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "choose-delivery",
                type: "function",
                function: {
                  name: "ask_user",
                  arguments: JSON.stringify({
                    title: "整理结果要保存为文档吗？",
                    options: ["直接在对话输出文字", "保存为文档"],
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content:
              "已将随手记整理成文字：\n\n明天上午十点产品评审，记得准备数据。",
          };
    return completionResponse(
      {
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [
          {
            index: 0,
            message,
            finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      !!body?.stream,
    );
  }) as typeof fetch;
  const { app, send, session } = await harness(modelFetch);
  try {
    await send("帮我整理一下这条随手记");
    await vi.waitFor(
      async () => {
        const result = await session();
        const job = result.jobs[0];
        expect(job?.status, job?.error).toBe("completed");
        expect(job.progress.phase).toBe("waiting_choice");
        expect(job.progress.questions[0].options).toEqual([
          "直接在对话输出文字",
          "保存为文档",
        ]);
        expect(result.operations).toHaveLength(0);
      },
      { timeout: 10000 },
    );
    expect(counter.calls).toBe(1);
    await send("整理结果要保存为文档吗？\n我的选择：直接在对话输出文字");
    await vi.waitFor(
      async () => {
        const result = await session();
        expect(result.jobs).toHaveLength(2);
        expectTextOnly(result.jobs[0], result.operations);
      },
      { timeout: 10000 },
    );
    expect(counter.calls).toBe(2);
    expect(
      await db
        .selectFrom("resources")
        .select("id")
        .where("deleted_at", "is", null)
        .execute(),
    ).toHaveLength(0);
  } finally {
    await app.close();
  }
}, 20000);
