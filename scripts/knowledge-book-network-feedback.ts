import { knowledgeBookRuntime } from "../apps/server/src/services/ai/knowledge-book-runtime.js";
/** Continue the isolated real-model acceptance and retain every prior run/release. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "@db/index.js";
import { saveBookConfiguration } from "@core/modules/knowledge-books/management.js";
import { executeBookCommand } from "@core/modules/knowledge-books/commands.js";
import { readKnowledgeBook } from "@core/modules/knowledge-books/reads.js";
import {
  listBookHumanTasks,
  resolveBookHumanTask,
} from "@core/modules/knowledge-books/human-tasks.js";
import { createApp } from "../apps/server/src/app/create-app.js";
const root = resolve(
    process.env.DOCA_BOOK_DEMO_DIR ||
      "/tmp/doca-knowledge-books/network-demo-v8",
  ),
  origin = "http://127.0.0.1:39282";
process.env.DOCA_FILE_STORE_ID ||= "local";
process.env.DOCA_FILE_STORES_JSON ||= JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: resolve(root, "storage") } },
});
const db = await openDatabase({
  driver: "sqlite",
  path: resolve(root, "demo.db"),
});
const actor = await db
  .selectFrom("users")
  .select(["id", "display_name", "admin"])
  .where("login", "=", "network-demo")
  .executeTakeFirstOrThrow();
const bookId = (
  await db.selectFrom("knowledge_books").select("id").executeTakeFirstOrThrow()
).id;
const sid = await db
  .selectFrom("ai_sessions")
  .select(["id", "model_id"])
  .orderBy("created_at", "desc")
  .executeTakeFirstOrThrow();
const cookie = (
  await readFile(resolve(root, "browser-cookie.txt"), "utf8")
).trim();
const app = await createApp(db, {
  origin,
  staticDirectory: resolve("apps/web/dist"),
  ai: { memory: { driver: "sqlite", url: resolve(root, "memory.db") } },
  webhookDispatch: false,
});
await app.listen({ host: "127.0.0.1", port: 39282 });
const request = async (method: any, path: string, payload?: unknown) => {
  const response = await app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host: "127.0.0.1:39282", origin, cookie },
    payload,
  });
  if (response.statusCode >= 400)
    throw new Error(`${path}: ${response.statusCode}: ${response.body}`);
  return response.json();
};
if (process.env.DOCA_BOOK_DEMO_VIEW_ONLY === "1") {
  console.log(
    JSON.stringify({
      event: "demo_view",
      bookId,
      url: `${origin}/#/knowledge-books/${bookId}`,
    }),
  );
  for (;;) await new Promise((resolve) => setTimeout(resolve, 30000));
}
for (const job of await db
  .selectFrom("ai_jobs")
  .select("id")
  .where("status", "in", ["queued", "running"])
  .execute())
  await request("POST", `/ai/jobs/${job.id}/cancel`);
async function assistant(text: string) {
  const sent = await request("POST", `/ai/sessions/${sid.id}/messages`, {
    id: randomUUID(),
    text,
    modelId: sid.model_id,
    scope: "all",
    references: [],
    skillIds: ["knowledge"],
    webSearch: true,
  });
  console.log(
    JSON.stringify({ event: "assistant_queued", jobId: sent.id ?? sent.jobId }),
  );
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    const state = await request("GET", `/ai/sessions/${sid.id}`);
    const job = state.jobs[0];
    if (job && !["queued", "running"].includes(job.status)) {
      await writeFile(
        resolve(root, `assistant-${job.id}.json`),
        JSON.stringify(
          { job, messages: state.messages, operations: state.operations },
          null,
          2,
        ),
      );
      if (job.status !== "completed")
        throw new Error(`Assistant ${job.status}: ${job.error}`);
      console.log(
        JSON.stringify({ event: "assistant_completed", jobId: job.id }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Assistant timeout");
}
const reportDir = resolve("artifacts/knowledge-book-network-demo");
await mkdir(reportDir, { recursive: true });
if (process.env.DOCA_BOOK_DEMO_CONTINUE !== "1") {
  const config = JSON.parse(
    await readFile(resolve(root, "candidate-configuration.json"), "utf8"),
  );
  const settings = JSON.parse(
    (
      await db
        .selectFrom("account_settings")
        .select("config")
        .where("id", "=", "ai")
        .executeTakeFirstOrThrow()
    ).config,
  );
  const selected = settings.models.find(
    (model: any) => model.enabled && model.id === settings.defaultModel,
  );
  if (selected) config.modelId = selected.id;
  config.workflow.nodes = config.workflow.nodes.filter(
    (node: any) => node.type !== "organize",
  );
  config.workflow.edges = config.workflow.edges.filter(
    (edge: any) =>
      !edge.source.endsWith("-organize") && !edge.target.endsWith("-organize"),
  );
  for (const node of config.workflow.nodes.filter(
    (node: any) => node.type === "synthesize",
  ))
    config.workflow.edges.push({
      source: node.id,
      target: node.id.replace(/-synthesize$/, "-acceptance"),
    });
  for (const criterion of config.criteria)
    criterion.description +=
      "；文档 path 第一项必须原样使用中文基础概念、协议机制、工程实践、排障与验证之一；页名包含本领域和主题，不能用通用分类名当页名。";
  for (const node of config.workflow.nodes) {
    if (node.type === "extract")
      node.parameters.instructions =
        "完整覆盖本批次主要知识点、过程和条件，合并重复知识判断，控制每批次 10 至 18 个有实质内容的 claims；一个判断可覆盖紧密相关机制但须有准确证据。引用使用不超过 80 字符的短片段；理由一句话。不要输出文档，下一节点负责构建文档树。";
    if (node.type === "synthesize") {
      const domain = node.label.split(" · ")[0].split("：")[0];
      node.parameters.instructions = `构建中文完整教程的文档树。领域为${domain}，输出 3 至 8 篇，每篇 5 至 12 个有实质内容的段落，覆盖机制、条件、例子和可执行实践。path 第一项必须原样使用「基础概念」「协议机制」「工程实践」「排障与验证」之一，禁止英文分类。第二项用领域名称「${domain}」，后续自己组织。title 必须包含本领域和具体主题，例如「${domain}：关键机制与条件」，不能只有「基础概念」等通用分类名。段落包含正文而不只是术语，具体命令必须有来源证据。`;
    }
  }
  const initial = await readKnowledgeBook(db, actor, bookId);
  for (const source of initial.sources)
    for (const binding of source.configuration?.items ?? [])
      if (binding.kind === "url") {
        const domain = /rfc(?:9293|9000)/.test(binding.url)
          ? "transport"
          : /rfc2308/.test(binding.url)
            ? "dns"
            : null;
        const node = config.workflow.nodes.find(
          (node: any) => node.id === `${domain}-sources`,
        );
        if (node && !node.parameters.sourceIds.includes(source.id))
          node.parameters.sourceIds.push(source.id);
      }
  await saveBookConfiguration(db, actor, bookId, initial.revision, config);
  await assistant(
    `人工已经在知识册 ${bookId} 保存完整的 31 节点流程和 32 篇已有文档、3 个 RFC 来源。请用 knowledge_book read 检查，然后只用 configuration.patch（expectedRevision 用实际最新版本，changes:{goal:...}）优化目标为足够详细的中文网络协议教程，第一层「基础概念、协议机制、工程实践、排障与验证」，后续自行组织。再用 workflow.node.patch 调整 transport-extract 的 changes.parameters.instructions，要求精确区分 TCP 字节流和 QUIC 的流内有序与流间关系。不使用 configuration.save，不重传整张图。最后 run.start 排队，等待人工验收，不能说已经发布。`,
  );
} else {
  const latest = (await readKnowledgeBook(db, actor, bookId)).runs[0];
  if (latest?.status === "failed") {
    const task = (
      await listBookHumanTasks(db, actor, {
        bookId,
        runId: latest.id,
        kind: "repair",
        status: "pending",
      })
    ).items[0];
    if (!task) throw new Error("Failed run has no repair task");
    const retried = await resolveBookHumanTask(db, actor, task.id, {
      expectedRevision: task.revision,
      decision: "retry",
      note: "验收 demo 人工重试：已完成节点保留，复验来源后继续处理失败节点。",
    });
    console.log(JSON.stringify({ event: "human_retry", ...retried }));
  }
}
await writeFile(
  resolve(root, "state.json"),
  JSON.stringify(
    { bookId, sid: sid.id, origin, modelId: sid.model_id },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    event: "demo_running",
    bookId,
    url: `${origin}/#/knowledge-books/${bookId}`,
  }),
);
async function waitAndApprove(round: number) {
  let prior = "",
    repairAttempts = 0;
  const repaired = new Set<string>();
  const until = Date.now() + 130 * 60_000;
  while (Date.now() < until) {
    const book = await readKnowledgeBook(db, actor, bookId),
      run = book.runs[0];
    if (run?.status !== prior) {
      prior = run?.status ?? "";
      console.log(
        JSON.stringify({
          event: "run_status",
          round,
          status: prior,
          error: run?.error,
        }),
      );
    }
    if (run?.status === "failed") {
      if (
        repairAttempts < 3 &&
        !repaired.has(run.id) &&
        /文件下载|download|book_model_output/.test(run.error)
      ) {
        const task = (
          await listBookHumanTasks(db, actor, {
            bookId,
            runId: run.id,
            kind: "repair",
            status: "pending",
          })
        ).items[0];
        if (!task) throw new Error(`No repair task: ${run.error}`);
        const retried = await resolveBookHumanTask(
          db,
          actor,
          task.id,
          {
            expectedRevision: task.revision,
            decision: "retry",
            note: "验收 demo 人工修复路径：重试暂时下载或输出错误，成功节点复验后复用。",
          },
          knowledgeBookRuntime(db, actor.id, "source-validation", ""),
        );
        repairAttempts++;
        repaired.add(run.id);
        console.log(
          JSON.stringify({ event: "human_retry", round, ...retried }),
        );
        continue;
      }
      throw new Error(`Run failed: ${run.error}`);
    }
    if (run?.status === "published") return book;
    const tasks = await listBookHumanTasks(db, actor, {
      bookId,
      status: "pending",
    });
    for (const task of tasks.items)
      if (task.kind !== "repair") {
        if (task.stale || !task.readable)
          throw new Error("Human review is stale or inaccessible");
        const pages = task.output?.pages ?? [];
        if (!pages.length)
          throw new Error("Review has no inspectable generated pages");
        await writeFile(
          resolve(reportDir, `review-${round}-${task.kind}.json`),
          JSON.stringify(
            {
              taskId: task.id,
              kind: task.kind,
              pages: pages.length,
              checks: task.output?.checks,
              inspectedPaths: pages.map((page: any) => [
                ...page.path,
                page.title,
              ]),
            },
            null,
            2,
          ),
        );
        await resolveBookHumanTask(db, actor, task.id, {
          expectedRevision: task.revision,
          decision: "approve",
          note: "验收 demo 的人工处理路径：确认候选页面与验收项存在，通过并继续。技术内容仍需逐页复核。",
        });
        console.log(
          JSON.stringify({ event: "human_approved", round, kind: task.kind }),
        );
      }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Knowledge run timeout");
}
const first = await waitAndApprove(1),
  releaseId = first.publishedRelease!.id;
const page =
  first.publishedRelease!.artifact!.pages.find((p) =>
    p.title.includes("DNS"),
  ) ?? first.publishedRelease!.artifact!.pages[0]!;
await executeBookCommand(db, actor, bookId, {
  operation: "feedback.save",
  expectedRevision: 0,
  status: "active",
  detail: {
    kind: "correction",
    content:
      "请核对 DNS 负缓存：NXDOMAIN 和 NODATA 的负缓存 TTL 应使用 SOA 记录 TTL 与 SOA.MINIMUM 的较小值，不应笼统写成所有 DNS 错误都按这条规则缓存。SERVFAIL 等解析失败请结合 RFC 9520 区分。",
    releaseId,
    pageId: page.id,
    paragraphId: page.paragraphs[0]!.id,
  },
});
await executeBookCommand(db, actor, bookId, {
  operation: "feedback.save",
  expectedRevision: 0,
  status: "active",
  detail: {
    kind: "question",
    content:
      "QUIC 是否保证不同流之间有序？丢包是否完全不影响其他流？请明确流内排序与共享拥塞控制的区别。",
    releaseId: null,
    pageId: null,
    paragraphId: null,
  },
});
await executeBookCommand(db, actor, bookId, {
  operation: "feedback.save",
  expectedRevision: 0,
  status: "active",
  detail: {
    kind: "comment",
    content:
      "实践部分需要能按命令、预期观察、异常原因阅读，减少只列术语的段落。",
    releaseId: null,
    pageId: null,
    paragraphId: null,
  },
});
await assistant(
  `请给知识册 ${bookId} 登记两个人工反馈：1. correction：「我认为 TCP 是可靠消息协议的说法不对，应该明确 TCP 提供可靠有序字节流，应用自己处理消息边界。」2. supplement：「补充一个 DNS→TCP 或 QUIC→TLS→HTTP 的完整排障顺序，用 dig、curl 和抓包说明预期观察；已有证据不足时标为待补来源，不编造具体包内容。」必须用 feedback.save，expectedRevision:0、status:active，detail 中 releaseId/pageId/paragraphId 都 null；不能直接编辑成果。登记完成后 run.start，不要重传整张流程图。`,
);
const second = await waitAndApprove(2);
for (const release of second.releases) {
  const row = await db
    .selectFrom("knowledge_book_releases")
    .select("artifact")
    .where("id", "=", release.id)
    .executeTakeFirstOrThrow();
  const artifact = JSON.parse(row.artifact);
  await writeFile(
    resolve(reportDir, `release-${release.revision}.json`),
    JSON.stringify(artifact, null, 2),
  );
  for (const page of artifact.pages) {
    const dir = resolve(
      reportDir,
      `release-${release.revision}`,
      ...page.path.map((label: string) => label.replace(/[\\/:*?"<>|]/g, "_")),
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, page.title.replace(/[\\/:*?"<>|]/g, "_") + ".md"),
      page.paragraphs.map((p: any) => p.markdown).join("\n\n"),
    );
  }
}
await writeFile(
  resolve(reportDir, "acceptance.json"),
  JSON.stringify(
    {
      bookId,
      firstReleaseId: releaseId,
      secondReleaseId: second.publishedRelease!.id,
      sourceCount: second.sources.length,
      feedback: second.feedback.map((f) => ({
        id: f.id,
        kind: f.detail.kind,
        content: f.detail.content,
        origin: f.origin,
      })),
      runs: second.runs,
      releases: second.releases,
      pageCount: second.publishedRelease!.artifact!.pages.length,
      provenanceNodes:
        second.publishedRelease!.artifact!.provenance.nodes.length,
      checks: second.publishedRelease!.artifact!.checks,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    event: "acceptance_completed",
    bookId,
    artifactDirectory: reportDir,
  }),
);
for (;;) await new Promise((r) => setTimeout(r, 30000));
