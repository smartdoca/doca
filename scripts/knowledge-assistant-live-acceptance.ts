/** Opt-in live acceptance. Credentials are read from a private file, never printed or saved in the report. */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { openTestDatabase } from "../tests/database.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { createAIRunner } from "../apps/server/src/services/ai/runner.js";
import { meteredModel } from "../apps/server/src/services/ai/model.js";
import {
  knowledgeGenerator,
  answerKnowledge,
} from "../apps/server/src/services/ai/knowledge-curation.js";
import { fetchWebPage } from "../apps/server/src/services/ai/web-fetch.js";
import {
  subscribeKnowledgeSource,
  setLibraryCuration,
} from "../packages/core/src/modules/knowledge/subscriptions.js";
import {
  knowledgeInstructions,
  knowledgeEntries,
  knowledgeHumanChanges,
  saveKnowledgeInstruction,
  saveKnowledgeSettings,
  saveHumanKnowledge,
  reviewKnowledgeEntry,
  queueKnowledgeCuration,
  executeKnowledgeCuration,
  saveKnowledgeAssistant,
  searchKnowledgeAssistant,
  detachKnowledgeSource,
} from "../packages/core/src/modules/knowledge/system.js";

const keyPath = process.env.DOCA_KNOWLEDGE_TEST_KEY_FILE;
const baseUrl = process.env.DOCA_KNOWLEDGE_TEST_BASE_URL;
if (!keyPath || !baseUrl)
  throw new Error(
    "Set DOCA_KNOWLEDGE_TEST_KEY_FILE and DOCA_KNOWLEDGE_TEST_BASE_URL explicitly.",
  );
const key = (await readFile(keyPath, "utf8")).trim();
const modelName = process.env.DOCA_KNOWLEDGE_TEST_MODEL || "deepseek-v4-flash";
const output =
  process.env.DOCA_KNOWLEDGE_TEST_REPORT ||
  join(tmpdir(), "doca-knowledge-assistant-live-report.json");
const directory = await mkdtemp(join(tmpdir(), "doca-knowledge-live-"));
process.env.DOCA_PLUGINS_DIR = join(directory, "plugins");
const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
const report: any = {
  model: modelName,
  startedAt: new Date().toISOString(),
  scenarios: [],
};
const log = (value: unknown) =>
  console.log(JSON.stringify(value).split(key).join("[REDACTED]"));
const transientRetry = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt >= 2 || !/504|503|超时|timeout|暂时异常|网页读取失败/i.test(String((error as Error).message))) throw error;
      log({stage: label, retry: attempt + 1});
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
};
const pageCache = new Map<string, Awaited<ReturnType<typeof fetchWebPage>>>();
try {
  const actor = {
    ...(await createUser(
      db,
      {
        login: "live-acceptance",
        displayName: "隔离验收",
        password: randomUUID(),
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const reader = await createUser(
    db,
    { login: "qa-only", displayName: "仅问答用户", password: randomUUID() },
    { actor },
  );
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      defaultModel: "live",
      vendors: [
        {
          id: "live",
          name: "Acceptance gateway",
          provider: "compatible",
          baseUrl,
          apiKey: key,
          enabled: true,
        },
      ],
      models: [
        {
          id: "live",
          vendorId: "live",
          model: modelName,
          alias: "Live acceptance",
          enabled: true,
          maxInput: 64000,
          maxOutput: 8000,
          tools: true,
        },
      ],
    },
    0,
  );

  const content = createContent(db);
  const internal = await content.create(actor, { kind: "document", format: "markdown", title: "验收 DNS 部署规范", markdown: "# 验收 DNS 部署规范\n\n测试域 demo.example 的 TTL 为300秒，递归查询通过测试解析器完成。" });
  assert((await content.list(actor, {q: "DNS", kind: "document"})).items.some(item => item.id === internal.id), "Internal fixture must be discoverable before starting the assistant");
  const sessionId = randomUUID(), jobId = randomUUID(), now = new Date().toISOString();
  await db.insertInto("ai_sessions").values({ id: sessionId, user_id: actor.id, title: "知识库建设验收", model_id: "live", resource_ids: "[]", archived: 0, revision: 1, created_at: now, updated_at: now }).execute();
  await db.insertInto("ai_jobs").values({ id: jobId, session_id: sessionId, user_id: actor.id, model_id: "live", status: "queued", input: JSON.stringify({
    text: "请实际执行并建立一个叫 DNS 助手验收的知识库。查找内部‘验收 DNS 部署规范’并订阅它。编写整库整理指引：技术、应用场景、未来发展为第一层，总共三层；只保存独立总结，来源和人工权重相同，冲突待人工裁决。给订阅单独写来源指引，禁止提取联系方式。配置三层目录、联系方式过滤并启用整理，发起一次整理任务，回报真实排队状态即可，不需要等整理完成。已授权以上创建和修改操作。不要创建多余的知识正文或问答机器人。",
    references: [], scope: "all", skillIds: [], skipApprovals: { create: true, modify: true },
  }), digest: "knowledge-live-acceptance", result: "", error: "", lease: null, lease_until: null, attempts: 0, cancelled: 0, created_at: now, updated_at: now }).execute();
  const runner = createAIRunner(db, { search: async (searchActor, query) => { const result = await content.list(searchActor, query); log({stage: "search", query, hits: result.items.map(item => ({id: item.id, title: item.title}))}); return result; }, memory: { driver: "sqlite", url: join(directory, "memory.db") }, logger: { error: () => {} } });
  try {
    await runner.pump();
    const deadline = Date.now() + 300000;
    let job;
    do {
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await db.selectFrom("ai_jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
    } while (["queued", "running"].includes(job.status) && Date.now() < deadline);
    report.jobStatus = job.status;
    report.result = JSON.parse(job.result || "{}");
    report.jobError = job.error;
    const library = await db.selectFrom("resources").selectAll().where("kind", "=", "library").where("deleted_at", "is", null).executeTakeFirst();
    assert(library, "Assistant must actually create a library");
    report.library = library.title;
    const bundle = await knowledgeInstructions(db, actor, library.id);
    report.instructionPaths = bundle.files.map(file => file.path);
    report.settings = bundle.settings;
    const subscriptions = await db.selectFrom("knowledge_subscriptions").selectAll().where("library_id", "=", library.id).execute();
    report.sources = subscriptions.map(source => ({ kind: source.source_kind, id: source.source_id }));
    assert(subscriptions.some(source => source.source_id === internal.id), "Assistant must discover and subscribe the internal source");
    assert(bundle.files.some(file => file.path === "KNOWLEDGE.md" && file.revision > 0), "Assistant must save the library definition");
    assert(bundle.files.some(file => file.path.startsWith("sources/") && file.revision > 0), "Assistant must save source instructions");
    assert.equal(bundle.settings.maxDocumentDepth, 3);
    assert.equal(bundle.settings.redactContacts, true);
    const runs = await db.selectFrom("knowledge_runs").selectAll().where("library_id", "=", library.id).execute();
    assert(runs.some(run => run.status === "queued"), "Assistant must enqueue real curation");
    assert.equal(job.status, "completed", job.error);
    report.passed = true;
  } finally { await runner.close(); }
} catch (error) {
  report.passed = false;
  report.error = String((error as Error).message).split(key).join("[REDACTED]");
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2).split(key).join("[REDACTED]"));
  await db.destroy();
  await rm(directory, { recursive: true, force: true });
  log({ report: output, passed: report.passed, error: report.error });
}
