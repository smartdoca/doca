/** Creates only explicitly requested demo assets in the configured local Doca database. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { openDatabase } from "../packages/db/src/index.js";
import { config } from "../apps/server/src/bootstrap/config.js";
import { aiDefaults, aiConfig, saveAIConfig } from "../packages/core/src/modules/ai/config.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { subscribeKnowledgeSource, setLibraryCuration } from "../packages/core/src/modules/knowledge/subscriptions.js";
import { knowledgeInstructions, saveKnowledgeInstruction, saveKnowledgeSettings, queueKnowledgeCuration, executeKnowledgeCuration, knowledgeEntries, saveHumanKnowledge, reviewKnowledgeEntry, saveKnowledgeAssistant, searchKnowledgeAssistant, knowledgeHumanChanges } from "../packages/core/src/modules/knowledge/system.js";
import { knowledgeGenerator, answerKnowledge } from "../apps/server/src/services/ai/knowledge-curation.js";
import { fetchWebPage } from "../apps/server/src/services/ai/web-fetch.js";

assert.equal(process.env.DOCA_KNOWLEDGE_LOCAL_DEMO, "1", "Explicit local demo opt-in required");
for (const filename of ["doca-knowledge-live-report.json", "doca-knowledge-assistant-live-report.json"])
  assert.equal(JSON.parse(await readFile(join(tmpdir(), filename), "utf8")).passed, true, `${filename} must pass before local creation`);
const key = (await readFile(process.env.DOCA_KNOWLEDGE_TEST_KEY_FILE!, "utf8")).trim();
const cfg = config(), db = await openDatabase(cfg.database);
const statePath = join(tmpdir(), "doca-local-dns-demo.json");
const state: Record<string, any> = await readFile(statePath, "utf8").then(JSON.parse).catch(() => ({}));
const persist = () => writeFile(statePath, JSON.stringify(state, null, 2));
const log = (stage: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ stage, ...data }));
try {
  const actor = await db.selectFrom("users").select(["id", "display_name", "admin"]).where("login", "=", "admin").where("status", "=", "active").executeTakeFirstOrThrow();
  const content = createContent(db);
  const ai = await aiConfig(db);
  const vendorId = "knowledge-demo-gateway", modelId = "knowledge-demo-mini";
  if (!ai.models.some(model => model.id === modelId)) {
    const stored = await db.selectFrom("account_settings").select("config").where("id", "=", "ai").executeTakeFirst();
    const raw = { ...aiDefaults, ...(stored ? JSON.parse(stored.config) : {}) };
    await saveAIConfig(db, { ...raw, defaultModel: raw.defaultModel || modelId,
      vendors: [...raw.vendors, { id: vendorId, name: "知识库验收接口", provider: "compatible", baseUrl: process.env.DOCA_KNOWLEDGE_TEST_BASE_URL, apiKey: key, enabled: true }],
      models: [...raw.models, { id: modelId, vendorId, model: "doubao-seed-2.0-mini", alias: "知识库验收 · Doubao Mini", enabled: true, tools: true, maxInput: 64000, maxOutput: 8000 }],
    }, ai.revision);
  }
  if (!state.libraryId) {
    state.libraryId = (await content.create(actor, { kind: "library", format: "markdown", title: "DNS 数据全链路详解 · 验收知识库" })).id;
    await persist();
  }
  const library = await db.selectFrom("resources").selectAll().where("id", "=", state.libraryId).executeTakeFirstOrThrow();
  assert.equal(library.owner_id, actor.id);
  const libraryId: string = library.id;
  const instruction = `# DNS 数据全链路详解

## 目标与读者
面向研发和运维，解释从终端请求、递归解析、权威应答到缓存与业务排障的完整链路。只保存可独立回答问题的提炼成果，不复制原文，不把指引中的示例当成事实。

## 三层组织
总共三层，标题本身为第三层。第一层为“技术”“应用场景”“未来发展”；第二层按真实内容拆分（例如解析链路、缓存与记录、测试环境、加密解析）；第三层为具体知识文档。path 只含前两层。未知方向写待补充，不编造时间表。每个来源最多3个主题条目，每条正文100至300字，保留条件、单位与限制。

## 提炼与来源隔离
通用网页只提炼通用机制；内部测试材料只提炼测试环境，不把测试参数说成互联网默认值。一个已存在主题只维护一份当前发布知识，更新用 replacesId，不新增相互矛盾的条目。

## 权重与冲突
官方公开来源在通用标准方面权重100，内部来源在本测试环境方面权重100，人工修订权重100。同主题同条件事实相反且权重相等或不明时，必须生成待裁决修订，绝不能自动覆盖当前发布版本。待裁决候选写拟采用的新值，旧值与理由放在冲突说明中。人工改动是独立来源，不可忽略。

## 隐私边界
各来源 SOURCE.md 的限制优先。不得提取或发布姓名、邮箱、电话、凭据；结构化联系方式过滤已启用。公开链接允许查看，私有链接由来源创建者单独控制。权重不能扩大权限。

## 来源缺失
取消订阅或撤权不撤回已发布知识。下次整理列出缺源项，人工确认保留后无新证据不重复提醒。

## 验收问题
DNS查询经过哪些角色？缓存如何影响查询？内部测试域 demo.example 的缓存秒数是多少？DoH解决什么问题、哪些问题不能仅靠它解决？只回答已发布知识，没有依据时说明缺口。`;
  const saveGuide = async (path: string, markdown: string) => {
    const bundle = await knowledgeInstructions(db, actor, libraryId);
    const current = bundle.files.find(file => file.path === path);
    if (!current?.revision) await saveKnowledgeInstruction(db, actor, libraryId, { path, markdown, expectedRevision: 0 });
  };
  await saveGuide("KNOWLEDGE.md", instruction);
  if (!state.internalId) {
    state.internalId = (await content.create(actor, { kind: "document", format: "markdown", title: "DNS 验收专用测试资料", private: true,
      markdown: "# DNS 验收专用测试资料\n\n本页是合成测试资料，不描述真实公司网络。\n\n测试域 demo.example 的缓存配置为600秒；仅适用于这个测试环境，不能作为互联网通用默认值。终端向测试递归解析器发起请求，解析器使用缓存或继续查询权威服务器。发生解析异常时，先区分缓存未过期、解析器配置不一致与权威记录变更。\n\n用于验证过滤的虚构邮箱：dns-private@example.test。不要把联系方式写入知识成果。" })).id;
    await persist();
  }
  const targets = [
    { key: "generalSource", sourceKind: "url" as const, url: "https://developers.cloudflare.com/learning-paths/cybersafe/concepts/what-is-dns/", guide: "仅提炼通用DNS定义、查询链路与缓存机制，可分技术和应用场景。不得推测 demo.example 或内部部署数值，不提取联系方式和页面导航，不复制原文或网址。最多3条独立总结。" },
    { key: "privacySource", sourceKind: "url" as const, url: "https://www.rfc-editor.org/rfc/rfc8484.html", guide: "仅提炼RFC8484中的DNS over HTTPS目标、消息传输及隐私限制，最多2条独立总结，按未来发展/加密解析组织。写明这是已存在标准，不能把2018年标准说成尚未落地。忽略作者联系方式、代码字节示例与参考文献列表，不复制原文或网址。不得推测内部部署参数。" },
    { key: "internalSource", sourceKind: "document" as const, sourceId: state.internalId as string, guide: "仅用于demo.example测试环境。必须生成独立的测试域缓存配置知识，明确秒数和适用范围。禁止输出任何邮箱、电话和姓名，不将测试值作为通用DNS默认值。人工修订与本来源同权，冲突必须提出replacesId修订候选等待裁决。" },
  ];
  for (const target of targets) {
    if (!state[target.key]) {
      state[target.key] = (await subscribeKnowledgeSource(db, actor, libraryId, target)).id;
      await persist();
    }
    await saveGuide(`sources/${state[target.key]}/SOURCE.md`, `# 来源整理与边界\n\n${target.guide}`);
  }
  if (!state.configured) {
    const bundle = await knowledgeInstructions(db, actor, libraryId);
    await saveKnowledgeSettings(db, actor, libraryId, bundle.settingsRevision, { ...bundle.settings, modelId, maxDocumentDepth: 3, redactContacts: true });
    await setLibraryCuration(db, actor, libraryId, true);
    state.configured = true;
    await persist();
  }
  const scan = async (stage: string) => {
    log(stage);
    const run = await queueKnowledgeCuration(db, actor, libraryId);
    await executeKnowledgeCuration(db, run.id, knowledgeGenerator(db, actor.id, run.id), async url => {
      const page = await fetchWebPage(url, AbortSignal.timeout(45000));
      assert(!page.truncated, "Source is too long; choose a smaller source");
      return page;
    });
    const deadline = Date.now() + 300000;
    let result;
    do {
      result = await db.selectFrom("knowledge_runs").selectAll().where("id", "=", run.id).executeTakeFirstOrThrow();
      if (!["queued", "running"].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    assert(!["failed", "queued", "running"].includes(result.status), JSON.parse(result.detail).error || "Curation did not complete");
    return knowledgeEntries(db, actor, libraryId);
  };
  if (!state.initialPublished) {
    let entries = await knowledgeEntries(db, actor, libraryId);
    if (!entries.length) entries = await scan("initial_curation");
    assert(entries.some(entry => entry.sourceRefs.some(ref => ref.subscriptionId === state.internalSource) && entry.markdown.includes("600")));
    assert(entries.every(entry => !entry.markdown.includes("dns-private@example.test") && entry.path.length <= 2));
    state.initialEntries = entries.map(entry => ({ title: entry.title, path: entry.path, markdown: entry.markdown }));
    await persist();
    for (const entry of entries.filter(entry => entry.status === "draft")) await reviewKnowledgeEntry(db, actor, libraryId, entry.id, entry.revision, "publish");
    state.initialPublished = true;
    await persist();
  }
  if (!state.humanEntryId) {
    const entry = (await knowledgeEntries(db, actor, libraryId)).find(entry => entry.status === "published" && entry.sourceRefs.some(ref => ref.subscriptionId === state.internalSource) && entry.markdown.includes("600"))!;
    const amended = await saveHumanKnowledge(db, actor, libraryId, { id: entry.id, expectedRevision: entry.revision, title: entry.title, path: entry.path, markdown: entry.markdown.replaceAll("600", "180") });
    await reviewKnowledgeEntry(db, actor, libraryId, amended.id, amended.revision, "publish");
    state.humanEntryId = amended.id;
    await persist();
  }
  if (!state.pendingConflictId) {
    let entries = await knowledgeEntries(db, actor, libraryId);
    if (!entries.some(entry => entry.status === "draft" && entry.reviewState.replaces === state.humanEntryId)) entries = await scan("human_conflict_curation");
    const conflict = entries.find(entry => entry.status === "draft" && entry.reviewState.replaces === state.humanEntryId);
    assert(conflict, "Expected a pending conflict for manual inspection");
    state.pendingConflictId = conflict.id;
    await persist();
  }
  if (!state.botId) {
    state.botId = (await saveKnowledgeAssistant(db, actor, { title: "DNS 知识问答 · 验收", expectedRevision: 0, libraryIds: [libraryId], memberIds: [], enabled: true, visibility: "invited" })).id;
    await persist();
  }
  const question = "demo.example 测试域的缓存配置是多少秒？";
  const answer = await answerKnowledge(db, actor, state.botId, question);
  assert(answer.answer.includes("180"), "Pending 600-second candidate must not change the published 180-second answer");
  state.question = question;
  state.answer = answer.answer;
  state.humanChanges = await knowledgeHumanChanges(db, actor, libraryId);
  state.url = `${cfg.origin}/#/r/${libraryId}?view=system&section=entries`;
  state.botUrl = `${cfg.origin}/#/knowledge-assistants?bot=${state.botId}`;
  state.completedAt = new Date().toISOString();
  await persist();
  log("ready", { libraryId, url: state.url, botUrl: state.botUrl, pendingConflictId: state.pendingConflictId });
} finally { await db.destroy(); }
