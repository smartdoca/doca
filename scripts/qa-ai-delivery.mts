// Real-model acceptance against qa-ai-server.mts only; never point at user data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { readDocument } from "@eppt/editor/core";
if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated QA only");
const port = process.env.DOCA_QA_PORT ?? "39254";
if (!["39251", "39254"].includes(port)) throw Error("Unknown QA port");
const origin = `http://127.0.0.1:${port}`;
let cookie = "";
async function request(path: string, data?: unknown) {
  const res = await fetch(origin + "/api/v1" + path, {
    method: data ? "POST" : "GET",
    headers: { origin, cookie, "content-type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (path === "/auth/login")
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const result = await res.json();
  assert(res.ok, JSON.stringify(result));
  return result;
}
function presentation(preview: any) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(preview.surface.update, "base64"));
    return readDocument(doc);
  } finally {
    doc.destroy();
  }
}
await request("/auth/login", {
  login: "aiqa",
  password: "isolated-ai-qa-2026",
});
const modelId = "real-qa";
const code = 'package main\n\nfunc main() { println("交付验收") }';
const cases = [
  {
    format: "rich_text",
    title: "隔离代码修复",
    initialContent: {
      schemaVersion: 2,
      children: [
        {
          id: "title",
          type: "paragraph",
          title: "h1",
          children: [{ text: "隔离代码修复" }],
        },
        { id: "bad-code", type: "codeBlock", children: [{ text: code }] },
        {
          id: "keep",
          type: "paragraph",
          children: [{ text: "不应修改的原文" }],
        },
      ],
    },
    prompt:
      "修复文档中错误的代码块，转成真正的原生 Go 代码块，完整保留源码和其他段落。不要新建文档，保存后回读核对。",
    verify(before: any, after: any) {
      assert(
        after.value.some(
          (b: any) =>
            b.type === "code-block" && b.code === code && b.language === "go",
        ),
      );
      assert(!after.value.some((b: any) => b.type === "codeBlock"));
      assert.deepEqual(
        after.value.find((b: any) => b.id === "keep"),
        before.value.find((b: any) => b.id === "keep"),
      );
    },
  },
  {
    format: "markdown",
    title: "隔离调研报告",
    markdown: "# 已有内容\n\n保留这段原文。",
    prompt:
      "在当前文档末尾编写约500字的团队异步协作评估报告。先定计划，包含背景、评估方法、方案对比表、风险、结论，比较同步会议和共享文档。只分析一般原理，不编造数据或外部引用，保留已有内容，不新建文档。",
    verify(before: any, after: any) {
      assert(after.markdown.startsWith(before.markdown));
      const added = after.markdown.slice(before.markdown.length);
      for (const word of [
        "背景",
        "评估方法",
        "方案对比",
        "风险",
        "结论",
        "同步会议",
        "共享文档",
      ])
        assert(added.includes(word), word);
      assert(/^\|.+同步会议.+共享文档.+\|$/m.test(added));
      const count = added.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
      assert(
        count >= 400 && count <= 650,
        `Unexpected report length: ${count}`,
      );
    },
  },
  {
    format: "presentation",
    title: "隔离三页演示",
    prompt:
      "在当前演示文稿末尾新增3页异步协作介绍：第1页标题及目标；第2页同步会议和共享文档的方案对比；第3页风险与试点安排。使用原生可编辑文字，不用图片替代。先读取结构并定计划，保留已有页面，不新建文档。",
    verify(before: any, after: any) {
      const a = presentation(before),
        b = presentation(after);
      assert.equal(b.slideOrder.length, a.slideOrder.length + 3);
      for (const id of a.slideOrder)
        assert.deepEqual(b.slides[id], a.slides[id]);
      const added = b.slideOrder
        .filter((id) => !a.slideOrder.includes(id))
        .map((id) => b.slides[id]!);
      for (const [index, terms] of [
        [0, ["目标"]],
        [1, ["同步会议", "共享文档"]],
        [2, ["风险", "试点"]],
      ] as const) {
        for (const term of terms)
          assert(JSON.stringify(added[index]).includes(term), term);
      }
      for (const slide of added) {
        const elements = Object.values(slide.elements);
        assert(elements.some((e) => e.type === "text"));
        assert(!elements.some((e) => e.type === "image"));
        for (const e of elements) {
          const t = e.transform;
          assert(
            t.x >= 0 &&
              t.y >= 0 &&
              t.x + t.width <= b.size.width &&
              t.y + t.height <= b.size.height,
            "Element exceeds page",
          );
        }
      }
    },
  },
];
for (const test of cases) {
  const { prompt, verify, ...resource } = test;
  const doc = await request("/resources", { ...resource, kind: "document" });
  const before = await request(`/ai/resources/${doc.id}/preview`);
  const session = await request("/ai/sessions", {
    modelId,
    resourceIds: [doc.id],
  });
  await request(`/ai/sessions/${session.id}/messages`, {
    id: randomUUID(),
    text: prompt,
    modelId,
    scope: "document",
    currentResourceId: doc.id,
    references: [{ resourceId: doc.id }],
    skillIds: [],
  });
  console.log(`START ${test.format} ${session.id}`);
  let done = false;
  for (let poll = 0; poll < 900; poll++) {
    const state = await request(`/ai/sessions/${session.id}`);
    const job = state.jobs.at(-1);
    if (job && !["queued", "running"].includes(job.status)) {
      assert.equal(job.status, "completed", job.error);
      assert(
        state.operations.some((o: any) => o.result.saved),
        "No saved operation",
      );
      assert.equal(job.progress.review?.verdict, "pass");
      verify(before, await request(`/ai/resources/${doc.id}/preview`));
      console.log(
        `PASS ${test.format}: saved, reviewed and independently checked`,
      );
      done = true;
      break;
    }
    if (poll % 30 === 0)
      console.log(`${test.format}: ${job?.progress?.phase ?? "queued"}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(done, `Timed out: ${test.format}`);
}
