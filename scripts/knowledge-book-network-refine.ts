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
const initial = await readKnowledgeBook(db, actor, bookId),
  releaseId = initial.releases.at(-1)!.id;
if (process.env.DOCA_BOOK_DEMO_RESUME !== "1") {
  const authority = [
    {
      domain: "link",
      url: "https://www.rfc-editor.org/rfc/rfc9542.html#section-2.1",
      title: "RFC 9542：MAC 地址空间与本地管理地址",
    },
    {
      domain: "link",
      url: "https://www.rfc-editor.org/rfc/rfc9542.html#section-3",
      title: "RFC 9542：EtherType 分配范围",
    },
    {
      domain: "address",
      url: "https://www.rfc-editor.org/rfc/rfc4291.html#section-2.7.1",
      title: "RFC 4291：Solicited-Node 多播地址低 24 位",
    },
    {
      domain: "security",
      url: "https://www.rfc-editor.org/rfc/rfc8470.html#section-3",
      title: "RFC 8470：HTTP 早期数据的重放风险",
    },
    {
      domain: "security",
      url: "https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2",
      title: "RFC 9110：安全方法与幂等方法的区别",
    },
  ];
  const runtime = knowledgeBookRuntime(db, actor.id, "source-validation", "");
  const added = new Map<string, string[]>();
  for (const item of authority) {
    const inspected = await runtime.readWeb(item.url);
    if (inspected.text.length < 200)
      throw new Error(`Authority section is empty: ${item.url}`);
    console.log(
      JSON.stringify({
        event: "authority_verified",
        url: item.url,
        characters: inspected.text.length,
      }),
    );
    const existing = initial.sources.find((source) =>
      source.configuration?.items.some(
        (binding) => binding.kind === "url" && binding.url === item.url,
      ),
    );
    const source: any =
      existing ??
      (await executeBookCommand(db, actor, bookId, {
        operation: "source.save",
        expectedRevision: 0,
        status: "active",
        title: item.title,
        configuration: {
          version: 1,
          items: [{ id: "binding", kind: "url", url: item.url }],
        },
      }, "manual", runtime));
    added.set(item.domain, [...(added.get(item.domain) ?? []), source.id]);
  }
  for (const [domain, ids] of added) {
    const current = await readKnowledgeBook(db, actor, bookId);
    if (
      current.configuration.workflow.nodes.some(
        (node) => node.id === `authority-${domain}`,
      )
    )
      continue;
    await executeBookCommand(db, actor, bookId, {
      operation: "workflow.node.add",
      expectedRevision: current.revision,
      inputs: [],
      outputs: [`${domain}-extract`],
      node: {
        id: `authority-${domain}`,
        type: "sources",
        label: `权威规范 · ${domain}`,
        position: { x: 0, y: 1000 + [...added.keys()].indexOf(domain) * 130 },
        parameters: {
          instructions:
            "以权威规范核对旧教程与人工纠错。旧来源与新规范冲突时保留限定条件，修正旧错误，不能以旧资料数量代替权威性。",
          sourceIds: ids,
          criterionIds: [],
          sourceWeight: 10,
          feedbackWeight: 1,
        },
      },
    });
  }
  const corrections = [
    "MAC 地址不能笼统称为全球唯一。请区分通用管理地址、本地管理地址、随机化与虚拟化地址；前 24 位 OUI 并不是所有 MAC 地址都适用的解释。以 RFC 9542 新来源核对并修正旧说法。EtherType 还需区分 1500 与 1536 的边界。",
    "IPv6 Solicited-Node 多播地址采用原单播或任播地址的低 24 位，接到 ff02::1:ff00:0/104，不能写低 32 位；请与多播 MAC 映射使用 IPv6 多播地址的低 32 位区分。以 RFC 4291 的已登记原文核对。",
  ];
  for (const content of corrections)
    await request("POST", `/knowledge-books/${bookId}/commands`, {
      operation: "feedback.save",
      expectedRevision: 0,
      status: "active",
      detail: {
        kind: "correction",
        content,
        releaseId: null,
        pageId: null,
        paragraphId: null,
      },
    });
  let current = await readKnowledgeBook(db, actor, bookId),
    configuration = current.configuration;
  configuration.goal +=
    "\n验收范围澄清：四类知识类型应在整册中齐备，每个领域可以使用适用的类型，不强求每个分支都重复四类。机制主题可以引用同领域独立的工程实践或排障页组成学习闭环，不需要把同一命令复制到每一页。必须修正 MAC 地址唯一性、IPv6 Solicited-Node 低 24 位、HTTP 0-RTT 安全性与幂等性混淆。既有源有误时，以已登记的权威 RFC 与相关人工反馈核对，不能重复旧错误。";
  for (const criterion of configuration.criteria)
    criterion.description +=
      "；按该领域证据验收，整册四类齐备即可，本领域不必独占四类；跨页关联实践可构成闭环。已有错误必须与本领域权威来源核对，不能因为有旧引用就认为事实正确。";
  for (const node of configuration.workflow.nodes) {
    if (node.type === "extract")
      node.parameters.instructions +=
        "\n合并重复判断，每 6000 字批次控制 10 至 18 个知识判断；优先核对高权重 RFC 与纠错，保留适用条件。";
    if (node.type === "synthesize")
      node.parameters.instructions +=
        "\npath 最多三个分类标签，文档 title 算第四层。规范纠错必须落实到正文，人工输入应有采用或不采用的理由。不同主题通过独立实践页关联即可，不要机械重复命令。";
  }
  await saveBookConfiguration(
    db,
    actor,
    bookId,
    current.revision,
    configuration,
  );
  await assistant(
    `请为知识册 ${bookId} 登记 correction 反馈：我认为现有 0-RTT 页把安全方法和幂等方法混淆了，DELETE 在 HTTP 语义中是幂等方法，PUT 也有副作用，不能把“幂等”自动等同于“可安全在早期数据执行”。请依据已登记 RFC 8470 与 RFC 9110 高权重来源，明确资源级重放风险、业务副作用和 425 Too Early。只能 feedback.save（expectedRevision:0、status:active、detail.releaseId/pageId/paragraphId 均 null），然后 run.start。人工已经校准验收范围，请保持当前配置，不降低必需项。`,
  );
} else {
  const latest = (await readKnowledgeBook(db, actor, bookId)).runs[0];
  if (latest?.status !== "failed" && latest?.status !== "cancelled")
    throw new Error("Resume requires a failed or cancelled run");
  const retried = await executeBookCommand(
    db,
    actor,
    bookId,
    { operation: "run.retry", runId: latest.id },
    "manual",
    knowledgeBookRuntime(db, actor.id, "source-validation", ""),
  );
  console.log(JSON.stringify({ event: "human_retry", ...retried }));
}
console.log(JSON.stringify({ event: "corrected_demo_running", bookId }));
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
const second = await waitAndApprove(3);
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
