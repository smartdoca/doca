/** Isolated local-model demo. Does not read, migrate or reset a user database. */
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { createContent } from "@core/workflows/resources.js";
import { authorize } from "@core/modules/access/queries.js";
import { createContentService } from "@core/modules/content/service.js";
import {
  bookHash,
  createKnowledgeBook,
  saveBookConfiguration,
} from "@core/modules/knowledge-books/management.js";
import {
  defaultBookConfiguration,
  type BookSourceBinding,
} from "@core/modules/knowledge-books/protocol.js";
import { executeBookCommand } from "@core/modules/knowledge-books/commands.js";
import { fail } from "@core/shared/errors.js";
import { knowledgeBookRuntime } from "../apps/server/src/services/ai/knowledge-book-runtime.js";
import { createApp } from "../apps/server/src/app/create-app.js";

const root = resolve(
    process.env.DOCA_BOOK_DEMO_DIR || ".cache/knowledge-book-bindings-demo",
  ),
  origin = "http://127.0.0.1:39282",
  modelId = "omlx_qwen36_4bit";
await mkdir(root, { recursive: true, mode: 0o700 });
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: resolve(root, "storage") } },
});
const db = await openDatabase({
  driver: "sqlite",
  path: resolve(root, "demo.db"),
});
await chmod(resolve(root, "demo.db"), 0o600);
let admin = await db
  .selectFrom("users")
  .select(["id", "display_name", "admin"])
  .where("login", "=", "network-demo")
  .executeTakeFirst();
const initialized = !!admin;
let reviewer = await db
  .selectFrom("users")
  .select(["id", "display_name", "admin"])
  .where("login", "=", "network-review")
  .executeTakeFirst();
if (!admin) {
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
    throw new Error("This demo requires the authorized local oMLX endpoint");
  admin = {
    ...(await createUser(
      db,
      {
        login: "network-demo",
        displayName: "验收管理",
        password: randomUUID(),
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const password = randomUUID();
  reviewer = {
    ...(await createUser(
      db,
      { login: "network-review", displayName: "知识册试用", password },
      { actor: admin },
    )),
    admin: 0,
  };
  await writeFile(
    resolve(root, "review-login.json"),
    JSON.stringify({ login: "network-review", password }),
    { mode: 0o600 },
  );
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      defaultModel: modelId,
      memoryEnabled: false,
      webSearch: {
        provider: "searxng",
        baseUrl: "http://127.0.0.1:8080",
        apiKey: null,
      },
      maxSteps: 30,
      vendors: [
        {
          id: "omlx_local",
          name: "Local oMLX",
          provider: "compatible",
          baseUrl: credential.baseUrl,
          apiKey: credential.apiKey,
          enabled: true,
        },
      ],
      models: [
        {
          id: modelId,
          vendorId: "omlx_local",
          model: "Qwen3.6-35B-A3B-4bit",
          alias: "本地 Qwen3.6",
          apiMode: "chat",
          apiKey: null,
          baseUrl: credential.baseUrl,
          enabled: true,
          maxInput: 65000,
          maxOutput: 16000,
          tools: true,
          inputRate: 0,
          outputRate: 0,
        },
      ],
    },
    0,
  );
}
if (!reviewer) throw new Error("Missing isolated reviewer account");
const actor: Actor = reviewer;
const docs = new Map<string, { id: string; title: string }>();
const savedState = initialized
  ? (JSON.parse(await readFile(resolve(root, "state.json"), "utf8")) as {
      bookId: string;
    })
  : null;
let book = savedState
  ? await db
      .selectFrom("knowledge_books")
      .select("id")
      .where("id", "=", savedState.bookId)
      .executeTakeFirstOrThrow()
  : undefined;
if (!book) {
  for (const file of (await readdir(resolve("artifacts/network-guide")))
    .filter((file) => /^(link|net|trans|app|sec|exp)-\d.*\.md$/.test(file))
    .sort()) {
    const markdown = await readFile(
        resolve("artifacts/network-guide", file),
        "utf8",
      ),
      title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? file;
    const document = await createContent(db).create(actor, {
      kind: "document",
      format: "markdown",
      title,
      markdown,
      private: true,
    });
    docs.set(file, { id: document.id, title });
  }
  await writeFile(
    resolve(root, "source-documents.json"),
    JSON.stringify([...docs]),
    { mode: 0o600 },
  );
} else
  for (const [file, document] of JSON.parse(
    await readFile(resolve(root, "source-documents.json"), "utf8"),
  ))
    docs.set(file, document);

// Test provider registered through the shipped content service, with native ACL checks on every call.
async function pluginRecord(principalId: string, topic: string) {
  const principal = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", principalId)
    .where("status", "=", "active")
    .executeTakeFirstOrThrow();
  const document = docs.get(topic === "tcp" ? "trans-01.md" : "app-02.md");
  if (!document) fail(404, "Missing isolated source document");
  await authorize(db, principal, document.id, 1);
  const state = await db
    .selectFrom("document_states")
    .select("text")
    .where("resource_id", "=", document.id)
    .executeTakeFirstOrThrow();
  const text = state.text.slice(0, 3000);
  return {
    ref: {
      sourceId: "acceptance.protocol-notes",
      resourceId: document.id,
      blockId: "summary",
    },
    title: `插件验收材料：${document.title}`,
    fingerprint: bookHash(text),
    text,
  };
}
createContentService(db).register({
  id: "acceptance.protocol-notes",
  pluginId: "acceptance",
  version: 1,
  title: { zh: "协议材料（验收提供方）", en: "Protocol notes (test provider)" },
  contentTypes: ["text"],
  purposes: ["knowledge"],
  capabilities: { search: false },
  configSchema: {
    type: "object",
    properties: {
      topic: { type: "string", title: "主题", enum: ["tcp", "dns"] },
    },
    required: ["topic"],
    additionalProperties: false,
  },
  async list(ctx, input) {
    const { text: _body, ...item } = await pluginRecord(
      ctx.principalId,
      String(input.config.topic),
    );
    return { items: [item], snapshot: item.fingerprint, nextCursor: null };
  },
  async read(ctx, input) {
    const record = await pluginRecord(
      ctx.principalId,
      String(input.config.topic),
    );
    if (record.fingerprint !== input.fingerprint) fail(409, "Source changed");
    return record;
  },
  async resolve(ctx, ref) {
    const topic =
      ref.resourceId === docs.get("trans-01.md")?.id ? "tcp" : "dns";
    const record = await pluginRecord(ctx.principalId, topic);
    if (record.ref.resourceId !== ref.resourceId) return null;
    return { path: `/r/${ref.resourceId}`, fingerprint: record.fingerprint };
  },
});
if (!book) {
  book = await createKnowledgeBook(db, admin, "网络协议完整教程");
  const resource = await db
    .selectFrom("resources")
    .select("authz_revision")
    .where("id", "=", book.id)
    .executeTakeFirstOrThrow();
  await createContent(db).member(admin, book.id, actor.id, {
    revision: resource.authz_revision!,
    role: "manager",
    includeDescendants: true,
  });
  const domains = [
    [
      "link",
      "链路与分层",
      /^(link|net-01)/,
      [
        "https://www.rfc-editor.org/rfc/rfc9542.html#section-2.1",
        "https://www.rfc-editor.org/rfc/rfc9542.html#section-3",
      ],
    ],
    [
      "address",
      "地址与邻居发现",
      /^net-0[234567]/,
      ["https://www.rfc-editor.org/rfc/rfc4291.html#section-2.7.1"],
    ],
    ["route", "路由与网络工程", /^net-(0[89]|1)/, []],
    [
      "transport",
      "传输协议",
      /^trans/,
      [
        "https://www.rfc-editor.org/rfc/rfc9293.html#section-2.2",
        "https://www.rfc-editor.org/rfc/rfc9000.html#section-2",
      ],
    ],
    [
      "dns",
      "DNS",
      /^app-0[123]/,
      ["https://www.rfc-editor.org/rfc/rfc2308.html"],
    ],
    ["application", "应用协议", /^app-0[4-9]/, []],
    [
      "security",
      "安全与排障",
      /^(sec|exp)/,
      [
        "https://www.rfc-editor.org/rfc/rfc8470.html#section-3",
        "https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2",
      ],
    ],
  ] as const;
  const config = defaultBookConfiguration();
  config.goal =
    "详细的中文网络协议教程，涵盖全部来源的主要知识点、机制、条件、实例与排障方法。文档树第一层只用基础概念、协议机制、工程实践、排障与验证，之后层级按主题决定。每篇文章使用有意义的 Markdown 二、三级标题，保留支持事实的证据，区分不确定和冲突。";
  config.modelId = modelId;
  config.maxDocumentDepth = 4;
  config.autoPublish = false;
  config.criteria = [
    {
      id: "shared-quality",
      description:
        "覆盖所选来源主要知识点，说明机制、条件与实例；事实引用有效证据，纠错依据可查；文档第一层按知识类型，页内有合理小标题。只评审本分支，整册类别齐备由合并结果查看。",
      required: true,
    },
  ];
  config.workflow.nodes = [];
  config.workflow.edges = [];
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
    label: "人工反馈",
    position: { x: 0, y: -150 },
    parameters: { ...parameters },
  });
  for (let index = 0; index < domains.length; index++) {
    const [id, label, pattern, urls] = domains[index]!;
    const items: BookSourceBinding[] = [...docs]
      .filter(([file]) => pattern.test(file))
      .map(([file, document]) => ({
        id: `doc-${file.replace(/\.md$/, " ").trim()}`,
        kind: "document",
        resourceId: document.id,
      }));
    urls.forEach((url, index) =>
      items.push({ id: `web-${index + 1}`, kind: "url", url }),
    );
    if (id === "transport" || id === "dns")
      items.push({
        id: "plugin-notes",
        kind: "content",
        sourceId: "acceptance.protocol-notes",
        config: { topic: id === "transport" ? "tcp" : "dns" },
      });
    const source = (await executeBookCommand(
      db,
      actor,
      book.id,
      {
        operation: "source.save",
        expectedRevision: 0,
        title: `${label} · 原文与权威资料`,
        configuration: { version: 1, items },
        status: "active",
      },
      "manual",
      knowledgeBookRuntime(db, actor.id, "source-validation", ""),
    )) as { id: string };
    const types = ["sources", "extract", "synthesize", "acceptance"] as const;
    types.forEach((type, column) =>
      config.workflow.nodes.push({
        id: `${id}-${type}`,
        type,
        label: `${label} · ${type}`,
        position: { x: column * 220, y: index * 150 },
        parameters: {
          ...parameters,
          sourceIds: type === "sources" ? [source.id] : [],
          criterionIds: type === "acceptance" ? ["shared-quality"] : [],
          instructions:
            type === "extract"
              ? `完整提取${label}主要知识点，保留条件，合并相关事实，每批次控制4至8个实质判断。`
              : type === "synthesize"
                ? `为${label}生成3至6篇详细教程，各篇4至8个实质段落，按知识类型组织目录。段落内合理使用##和###标题，禁止只有术语列表。`
                : "",
        },
      }),
    );
    for (let column = 1; column < types.length; column++)
      config.workflow.edges.push({
        source: `${id}-${types[column - 1]}`,
        target: `${id}-${types[column]}`,
      });
    config.workflow.edges.push(
      { source: "feedback", target: `${id}-extract` },
      { source: `${id}-acceptance`, target: "review" },
    );
  }
  config.workflow.nodes.push(
    {
      id: "review",
      type: "human_review",
      label: "共同审阅",
      position: { x: 900, y: 300 },
      parameters: {
        ...parameters,
        instructions: "核对教程覆盖、证据与反馈，必要时退回。",
      },
    },
    {
      id: "publish",
      type: "publish",
      label: "发布成果",
      position: { x: 1120, y: 300 },
      parameters: { ...parameters },
    },
  );
  config.workflow.edges.push({ source: "review", target: "publish" });
  await saveBookConfiguration(db, actor, book.id, 1, config);
}
await writeFile(
  resolve(root, "state.json"),
  JSON.stringify({
    origin,
    bookId: book.id,
    modelId,
    actorId: actor.id,
    adminId: admin.id,
  }),
  { mode: 0o600 },
);
const app = await createApp(db, {
  origin,
  staticDirectory: resolve("apps/web/dist"),
  ai: { memory: { driver: "sqlite", url: resolve(root, "memory.db") } },
  webhookDispatch: false,
});
await app.listen({ host: "127.0.0.1", port: 39282 });
console.log(
  JSON.stringify({
    event: "ready",
    url: `${origin}/#/knowledge-books/${book.id}`,
    model: "Qwen3.6-35B-A3B-4bit",
    login: "network-review",
    credentialsFile: resolve(root, "review-login.json"),
  }),
);
for (;;) await new Promise((resolve) => setTimeout(resolve, 30000));
