/** Real-model acceptance, isolated DB only. Never edits the original tutorial documents. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "@db/index.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { createContent } from "@core/workflows/resources.js";
import { defaultBookConfiguration } from "@core/modules/knowledge-books/protocol.js";
import { executeBookCommand } from "@core/modules/knowledge-books/commands.js";
import { readKnowledgeBook } from "@core/modules/knowledge-books/reads.js";
import { createApp } from "../apps/server/src/app/create-app.js";

const root = resolve(
  process.env.DOCA_BOOK_DEMO_DIR || "/tmp/doca-knowledge-books/network-demo",
);
await mkdir(root, { recursive: true, mode: 0o700 });
process.env.DOCA_FILE_STORE_ID ||= "local";
process.env.DOCA_FILE_STORES_JSON ||= JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: resolve(root, "storage") } },
});
const credential = JSON.parse(
  await readFile(
    resolve(
      process.env.DOCA_BOOK_MODEL_CONFIG ||
        "/tmp/doca-knowledge-books/omlx-test-private.json",
    ),
    "utf8",
  ),
);
if (credential.baseUrl !== "http://127.0.0.1:8000/v1")
  throw new Error("Use the authorized local oMLX service for this acceptance");
const model = {
  id: "omlx_qwen36_4bit",
  vendorId: "omlx_local",
  model: "Qwen3.6-35B-A3B-4bit",
  alias: "Local Qwen3.6",
  apiMode: "chat" as const,
  baseUrl: credential.baseUrl,
  apiKey: credential.apiKey,
  enabled: true,
  tools: true,
  maxInput: 65000,
  maxOutput: 16000,
  inputRate: 0,
  outputRate: 0,
};
const saved = {
  ...aiDefaults,
  vendors: [
    {
      id: "omlx_local",
      name: "Local oMLX",
      provider: "compatible" as const,
      baseUrl: credential.baseUrl,
      apiKey: credential.apiKey,
      enabled: true,
    },
  ],
  models: [model],
  webSearch: {
    provider: "searxng" as const,
    baseUrl: "http://127.0.0.1:8080",
    apiKey: null,
  },
};
const db = await openDatabase({
  driver: "sqlite",
  path: resolve(root, "demo.db"),
});
await chmod(resolve(root, "demo.db"), 0o600);
const password = randomUUID();
const actor = {
  ...(await createUser(
    db,
    { login: "network-demo", displayName: "网络协议验收", password },
    { bootstrap: true },
  )),
  admin: 1,
};
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    ...saved,
    officialSkills: aiDefaults.officialSkills,
    defaultModel: model.id,
    models: saved.models.filter((m: any) => !m.imageGeneration),
    imageModel: "",
    imageToolModels: {},
    maxSteps: 60,
    memoryEnabled: false,
  },
  0,
);
const origin = "http://127.0.0.1:39281";
const app = await createApp(db, {
  origin,
  staticDirectory: resolve("apps/web/dist"),
  ai: { memory: { driver: "sqlite", url: resolve(root, "memory.db") } },
  webhookDispatch: false,
});
await app.listen({ host: "127.0.0.1", port: 39281 });
const login = await app.inject({
  method: "POST",
  url: "/api/v1/auth/login",
  headers: { host: "127.0.0.1:39281", origin },
  payload: { login: "network-demo", password },
});
const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
await writeFile(resolve(root, "browser-cookie.txt"), cookie, { mode: 0o600 });
const request = async (method: any, path: string, payload?: unknown) => {
  const response = await app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host: "127.0.0.1:39281", origin, cookie },
    payload,
  });
  if (response.statusCode >= 400)
    throw new Error(`${path}: ${response.statusCode}: ${response.body}`);
  return response.json();
};
const sid = (
  await request("POST", "/ai/sessions", { modelId: model.id, resourceIds: [] })
).id;
async function assistant(text: string) {
  const sent = await request("POST", `/ai/sessions/${sid}/messages`, {
    id: randomUUID(),
    text,
    modelId: model.id,
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
    const state = await request("GET", `/ai/sessions/${sid}`);
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
      return job;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Assistant did not finish before deadline");
}
await assistant(
  "请创建一个知识册，名称为「网络协议完整教程」。用 knowledge_book 创建。先只创建，然后告诉我 ID。目标：知识足够详细，涵盖主要知识点，第一层按知识类型分类，后续目录自己决定。将结合已有文档与网上搜索补充资料。不要创建普通文档或第二个助手，不要编造已经完成整理。",
);
const books = await db.selectFrom("knowledge_books").select("id").execute();
if (books.length !== 1)
  throw new Error("The assistant did not create exactly one knowledge book");
const bookId = books[0]!.id,
  sourceIds: Record<string, string> = {};
const docs = resolve("artifacts/network-guide");
for (const file of (await readdir(docs))
  .filter((file) => /^(link|net|trans|app|sec|exp)-\d.*\.md$/.test(file))
  .sort()) {
  const markdown = await readFile(resolve(docs, file), "utf8");
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? file;
  const document = await createContent(db).create(actor, {
    kind: "document",
    format: "markdown",
    title,
    markdown,
    private: true,
  });
  const source = (await executeBookCommand(db, actor, bookId, {
    operation: "source.save",
    expectedRevision: 0,
    title: `已有文档快照：${title}`,
    configuration: {
      version: 1,
      items: [{ id: "binding", kind: "document", resourceId: document.id }],
    },
    status: "active",
  })) as { id: string };
  sourceIds[file] = source.id;
}
console.log(
  JSON.stringify({
    event: "source_copies_registered",
    count: Object.keys(sourceIds).length,
    bookId,
  }),
);
const config = defaultBookConfiguration();
config.goal =
  "中文网络协议完整教程，面向工程师，从原理到排障。第一层必须按知识类型：基础概念、协议机制、工程实践、排障与验证；后续层级自行决定。每个领域均保留主要知识点、字段含义、交互过程、适用条件、易错点、可执行示例和检查方法。结合已有文档与权威 RFC。人工反馈是候选输入，按证据决定采用或拒绝，说明依据。";
config.modelId = model.id;
config.maxDocumentDepth = 4;
config.autoPublish = false;
config.criteria = [
  {
    id: "shared-quality",
    description:
      "覆盖当前验收节点所选来源的主要知识，说明机制、条件、实例和可执行实践；事实段落引用有效证据，来源冲突和反馈的采用或拒绝说明依据，旧引用不能替代事实核实。目录第一层使用基础概念、协议机制、工程实践、排障与验证中的适用类型；四类齐备是整册要求，单个领域无需四类俱全。页名包含领域与主题，不能只有通用分类名。",
    required: true,
  },
];
config.workflow.nodes = [];
config.workflow.edges = [];
const domains = [
  ["link", "链路与分层", /^(link|net-01)/],
  ["address", "地址与邻居发现", /^net-0[234567]/],
  ["route", "路由与网络工程", /^net-(0[89]|1)/],
  ["transport", "传输协议", /^trans/],
  ["dns", "DNS", /^app-0[123]/],
  ["application", "应用协议", /^app-0[4-9]/],
  ["security", "安全与排障", /^(sec|exp)/],
] as const;
const parameters = {
  instructions: "",
  sourceIds: [] as string[],
  criterionIds: [] as string[],
  sourceWeight: 1,
  feedbackWeight: 1,
};
config.workflow.nodes.push({
  id: "feedback",
  type: "feedback",
  label: "汇入人工反馈",
  position: { x: 0, y: 0 },
  parameters: { ...parameters },
});
for (let i = 0; i < domains.length; i++) {
  const [name, label, pattern] = domains[i]!;
  const ids = Object.entries(sourceIds)
    .filter(([file]) => pattern.test(file))
    .map(([, id]) => id);
  const types = [
    "sources",
    "extract",
    "synthesize",
    "organize",
    "acceptance",
  ] as const;
  types.forEach((type, j) => {
    const id = `${name}-${type}`;
    config.workflow.nodes.push({
      id,
      type,
      label: `${label} · ${type}`,
      position: { x: 220 * j, y: 120 * i },
      parameters: {
        ...parameters,
        instructions: `只整理${label}领域。保留足够细节，输出 3 至 8 篇有实质内容的教程页面，每页 5 至 12 个段落。第一层是知识类型，不是领域或来源名。事实提取覆盖所有所选来源主要知识点，避免只摘一两个段落。人工反馈只处理与本领域相关的部分。`,
        sourceIds: type === "sources" ? ids : [],
        criterionIds: type === "acceptance" ? ["shared-quality"] : [],
      },
    });
    if (j)
      config.workflow.edges.push({
        source: `${name}-${types[j - 1]}`,
        target: id,
      });
    if (type === "extract")
      config.workflow.edges.push({ source: "feedback", target: id });
  });
}
config.workflow.nodes.push(
  {
    id: "review",
    type: "human_review",
    label: "人工验收完整教程",
    position: { x: 1200, y: 200 },
    parameters: {
      ...parameters,
      instructions: "检查领域覆盖、段落依据和第一层知识类型。",
    },
  },
  {
    id: "publish",
    type: "publish",
    label: "发布教程",
    position: { x: 1400, y: 200 },
    parameters: { ...parameters },
  },
);
for (const [name] of domains)
  config.workflow.edges.push({
    source: `${name}-acceptance`,
    target: "review",
  });
config.workflow.edges.push({ source: "review", target: "publish" });
await writeFile(
  resolve(root, "candidate-configuration.json"),
  JSON.stringify(config, null, 2),
);
await assistant(
  `知识册 ID 是 ${bookId}。已有32篇文档快照来源已登记。请网上搜索 RFC9293、RFC9000、RFC2308 的权威资料，再登记三条 URL 来源：https://www.rfc-editor.org/rfc/rfc9293.html#section-2.2、https://www.rfc-editor.org/rfc/rfc9000.html#section-2、https://www.rfc-editor.org/rfc/rfc2308.html。source.save 的 expectedRevision:0、status:active。先只登记来源，不保存整张流程图、不开始运行。人工会调整流程后再请你完善。`,
);
await writeFile(
  resolve(root, "state.json"),
  JSON.stringify(
    {
      bookId,
      sid,
      origin,
      sourceCopies: Object.keys(sourceIds),
      modelId: model.id,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    event: "demo_running",
    bookId,
    sid,
    url: `${origin}/#/knowledge-books/${bookId}`,
  }),
);
let prior = "";
for (;;) {
  const book = await readKnowledgeBook(db, actor, bookId);
  const latest = book.runs[0];
  if (latest && latest.status !== prior) {
    prior = latest.status;
    console.log(
      JSON.stringify({
        event: "run_status",
        status: prior,
        error: latest.error,
      }),
    );
    await writeFile(
      resolve(root, "run-status.json"),
      JSON.stringify(latest, null, 2),
    );
  }
  await new Promise((r) => setTimeout(r, 3000));
}
