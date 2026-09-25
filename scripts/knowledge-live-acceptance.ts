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
  join(tmpdir(), "doca-knowledge-live-report.json");
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
  for (const scenario of ["DNS", "采购订单"]) {
    const dns = scenario === "DNS";
    log({ scenario, stage: "create_library" });
    const library = await content.create(actor, {
      kind: "library",
      format: "markdown",
      title: `${scenario}真实验收`,
    });
    const definitionModel = await meteredModel(db, actor.id, "live", null);
    const definition = await definitionModel.doGenerate({
      prompt: [
        {
          role: "system",
          content:
            "为知识库编写简洁的 KNOWLEDGE.md 专用整理 skill，只输出 Markdown。包括目标、三层目录、提炼、来源/人工权重、冲突和验收问题。业务规则由本文声明。只声明整理规则，不生成知识正文，不填写任何假设的参数、金额或示例事实。具体事实只能由后续读取来源后提炼。来源局部隐私限制优先。",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: dns
                ? "DNS 数据全链路详解。第一层技术、应用场景、未来发展；第二层按内容，第三层是知识文档。实际可用的内容才建文档，未知发展方向列待补充。网页负责通用链路，内部文档仅负责自家部署参数。针对内部 demo.example 测试域的缓存配置生成一个独立条目，正文必须包含 demo.example 和明确秒数；后续同主题变化必须提出 replacesId 修订，不得另建矛盾条目。内部来源和人工修订权重都为100，冲突必须人工裁决。每条独立总结150字以内，每个来源最多3条。"
                : "采购订单知识库，订阅采购单文件夹。按供应商/年度/订单三层组织；订单号是去重键，相同版本的重复材料只保留一份，新版本替代旧版本，金额必须包含币种，绝不叠加同一订单的不同版本。每个订单一条知识，标题必须含订单号，后续金额变化必须用 replacesId 提候选而非新增矛盾条目。来源与人工权重都100，有冲突必须人工裁决。过滤联系方式，只保留订单、供应商、版本、金额与币种。每条150字以内。",
            },
          ],
        },
      ],
      maxOutputTokens: 8000,
      abortSignal: AbortSignal.timeout(90000),
    });
    const markdown = definition.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    assert(markdown.length > 100);
    report.definitions ??= {};
    report.definitions[scenario] = markdown;
    await saveKnowledgeInstruction(db, actor, library.id, {
      path: "KNOWLEDGE.md",
      markdown,
      expectedRevision: 0,
    });
    await setLibraryCuration(db, actor, library.id, true);
    const settings = (await knowledgeInstructions(db, actor, library.id))
      .settings;
    await saveKnowledgeSettings(db, actor, library.id, 0, {
      ...settings,
      modelId: "live",
      maxDocumentDepth: 3,
      redactContacts: true,
    });
    let updateSource: () => Promise<void>;
    let primaryId: string;
    if (dns) {
      const web = await subscribeKnowledgeSource(db, actor, library.id, {
        sourceKind: "url",
        url: "https://developers.cloudflare.com/learning-paths/cybersafe/concepts/what-is-dns/",
      });
      await saveKnowledgeInstruction(db, actor, library.id, {
        path: `sources/${web.id}/SOURCE.md`,
        expectedRevision: 0,
        markdown:
          "本来源仅形成通用 DNS 查询链路说明，不推断本公司部署、内部域名或配置，不提取联系方式，不复制链接或原文。",
      });
      const internal = await content.create(actor, {
        kind: "document",
        format: "markdown",
        title: "内部 DNS 部署（隔离测试）",
        markdown:
          "# 内部 DNS 部署\n测试域 demo.example 的缓存配置为 300 秒。工作站经公司递归解析器查询。此数据只适用于本测试环境，与互联网通用默认值无关。",
      });
      primaryId = (
        await subscribeKnowledgeSource(db, actor, library.id, {
          sourceKind: "document",
          sourceId: internal.id,
        })
      ).id;
      updateSource = async () => {
        await db
          .updateTable("document_states")
          .set({
            text: "# 内部 DNS 部署更新\n最新运维确认：测试域 demo.example 缓存配置已调整为600秒，替代旧的300秒配置。只适用于测试环境。",
            seq: 2,
          })
          .where("resource_id", "=", internal.id)
          .execute();
      };
    } else {
      const folderId = randomUUID(),
        fileId = randomUUID(),
        objectId = randomUUID(),
        profileId = randomUUID();
      await db
        .insertInto("storage_profiles")
        .values({
          id: profileId,
          provider: "local",
          config: "{}",
          active: 0,
          created_at: new Date().toISOString(),
        })
        .execute();
      await db
        .insertInto("file_storage_objects")
        .values({
          id: objectId,
          profile_id: profileId,
          object_key: "synthetic-order",
          sha256: "synthetic-order",
          size: 120,
          mime: "text/plain",
          created_at: new Date().toISOString(),
        })
        .execute();
      await db
        .insertInto("file_folders")
        .values({
          id: folderId,
          owner_id: actor.id,
          parent_id: null,
          name: "隔离采购单",
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          delete_batch: null,
        })
        .execute();
      await db
        .insertInto("file_items")
        .values({
          id: fileId,
          owner_id: actor.id,
          parent_type: "folder",
          parent_id: folderId,
          storage_object_id: objectId,
          name: "PO-2026-001.txt",
          mime: "text/plain",
          size: 120,
          metadata: "{}",
          ai_description_override: null,
          locked: 0,
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          delete_batch: null,
        })
        .execute();
      await db
        .insertInto("knowledge_chunks")
        .values({
          id: randomUUID(),
          source_kind: "file",
          source_id: fileId,
          ordinal: 0,
          title: "采购单",
          text: "订单 PO-2026-001；供应商甲；2026年；版本1；金额100 CNY。\n重复副本：订单 PO-2026-001；供应商甲；2026年；版本1；金额100 CNY。\n联系人：private@example.test。",
          anchor: "",
          content_hash: "v1",
          reader_ids: JSON.stringify([actor.id]),
          updated_at: new Date().toISOString(),
        })
        .execute();
      primaryId = (
        await subscribeKnowledgeSource(db, actor, library.id, {
          sourceKind: "folder",
          sourceId: folderId,
        })
      ).id;
      updateSource = async () => {
        await db
          .updateTable("knowledge_chunks")
          .set({
            text: "订单 PO-2026-001；供应商甲；2026年；最新版本2；金额200 CNY，替代版本1金额100 CNY。\n重复副本：订单 PO-2026-001；版本2；金额200 CNY。",
            content_hash: "v2",
            updated_at: new Date().toISOString(),
          })
          .where("source_id", "=", fileId)
          .execute();
      };
    }
    await saveKnowledgeInstruction(db, actor, library.id, {
      path: `sources/${primaryId}/SOURCE.md`,
      expectedRevision: 0,
      markdown: dns
        ? "仅提炼内部测试域 demo.example 配置，必须标注测试环境。禁止提炼任何联系方式。不把内部值描述为通用 DNS 默认值。"
        : "仅提炼订单事实和币种，禁止输出联系人姓名、电话、邮箱。不得从共同指引扩大范围。",
    });
    const scan = async (stage: string) => {
      log({ scenario, stage });
      const run = await queueKnowledgeCuration(db, actor, library.id);
      await executeKnowledgeCuration(
        db,
        run.id,
        async (input) => {
          const output = await transientRetry("model", () => knowledgeGenerator(db, actor.id, run.id)(input));
          log({
            scenario,
            generated: output.entries.map((e) => ({
              title: e.title,
              path: e.path,
              replacesId: e.replacesId,
            })),
            notes: output.notes,
          });
          return output;
        },
        async (url) => {
          const page = pageCache.get(url) ?? await transientRetry("web_fetch", () => fetchWebPage(url, AbortSignal.timeout(45000)));
          pageCache.set(url, page);
          assert(!page.truncated, "Web source must not be silently truncated");
          return page;
        },
      );
      const result = await db
        .selectFrom("knowledge_runs")
        .selectAll()
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      assert.notEqual(result.status, "failed", JSON.parse(result.detail).error);
      const entries = await knowledgeEntries(db, actor, library.id);
      log({
        scenario,
        stage,
        status: result.status,
        entries: entries.map((e) => ({
          title: e.title,
          path: e.path,
          status: e.status,
          conflict: e.reviewState.conflict,
        })),
      });
      return entries;
    };
    let entries = await scan("initial_curation");
    assert(entries.length > 0);
    assert(entries.every((e) => e.path.length <= 2));
    assert(
      entries.some((e) => e.path.length === 2),
      "Expected three-level knowledge structure",
    );
    if (dns)
      assert(
        entries.every((e) =>
          ["技术", "应用场景", "未来发展"].includes(e.path[0]),
        ),
      );
    assert(!JSON.stringify(entries).includes("private@example.test"));
    for (const entry of entries)
      await reviewKnowledgeEntry(
        db,
        actor,
        library.id,
        entry.id,
        entry.revision,
        "publish",
      );
    entries = await knowledgeEntries(db, actor, library.id);
    const original = entries.find((e) =>
      dns
        ? e.markdown.includes("demo.example")
        : e.title.includes("PO-2026-001"),
    );
    assert(original, "Required independent fact was not extracted");
    assert(original.markdown.includes(dns ? "300" : "100"), "Initial fact does not match the actual source");
    if (dns) assert(entries.filter(e => !e.sourceRefs.some(ref => ref.subscriptionId === primaryId)).every(e => !e.markdown.includes("demo.example")), "Web source crossed its scope into internal deployment facts");
    if (!dns)
      assert.equal(
        entries.filter((e) => e.title.includes("PO-2026-001")).length,
        1,
        "Duplicate purchase order",
      );
    const amended = await saveHumanKnowledge(db, actor, library.id, {
      id: original.id,
      expectedRevision: original.revision,
      title: original.title,
      path: original.path,
      markdown: dns
        ? "测试环境 demo.example 的缓存配置经人工核对为180秒。该值不是互联网通用默认。"
        : "采购订单 PO-2026-001，供应商甲，2026年，版本1，金额经人工核对为120 CNY。",
    });
    await reviewKnowledgeEntry(
      db,
      actor,
      library.id,
      amended.id,
      amended.revision,
      "publish",
    );
    assert.equal(
      (await knowledgeHumanChanges(db, actor, library.id)).length,
      1,
    );
    const bot = await saveKnowledgeAssistant(db, actor, {
      expectedRevision: 0,
      title: `${scenario}问答`,
      libraryIds: [library.id],
      memberIds: [reader.id],
      enabled: true,
    });
    const question = dns
      ? "demo.example 的缓存配置是多少秒？"
      : "PO-2026-001 的订单金额和币种是多少？";
    const before = await searchKnowledgeAssistant(db, reader, bot.id, question);
    assert(before.items.every((item) => !item.documentUrl));
    await updateSource();
    entries = await scan("conflict_curation");
    const conflict = entries.find(
      (e) => e.status === "draft" && e.reviewState.replaces === amended.id,
    );
    assert(
      conflict,
      "Expected an adjudicable conflict against the human amendment",
    );
    assert.deepEqual(
      await searchKnowledgeAssistant(db, reader, bot.id, question),
      before,
      "Pending conflict changed answers",
    );
    await reviewKnowledgeEntry(
      db,
      actor,
      library.id,
      conflict.id,
      conflict.revision,
      "publish",
    );
    const answer = await answerKnowledge(db, reader, bot.id, question);
    assert(
      answer.answer.includes(dns ? "600" : "200"),
      "Answer did not use adjudicated content",
    );
    const beforeDetach = await searchKnowledgeAssistant(
      db,
      reader,
      bot.id,
      question,
    );
    const subscriptions = await db
      .selectFrom("knowledge_subscriptions")
      .select("id")
      .where("library_id", "=", library.id)
      .execute();
    for (const source of subscriptions)
      await detachKnowledgeSource(db, actor, library.id, source.id);
    const afterDetach = await searchKnowledgeAssistant(
      db,
      reader,
      bot.id,
      question,
    );
    const contentOnly = (result: typeof beforeDetach) =>
      result.items.map(({ sources, ...item }) => item);
    assert.deepEqual(contentOnly(beforeDetach), contentOnly(afterDetach));
    report.scenarios.push({
      scenario,
      passed: true,
      definition: markdown,
      tree: entries.map((e) => ({
        title: e.title,
        path: e.path,
        status: e.status,
      })),
      question,
      answer: answer.answer,
      humanChanges: await knowledgeHumanChanges(db, actor, library.id),
      checks: [
        "real_model_definition",
        "real_model_curation",
        dns ? "real_web_and_internal_sources" : "folder_subscription_and_dedup",
        "three_level_tree",
        "human_amendment_source",
        "conflict_pending_preserves_answer",
        "human_adjudication",
        "search_without_document_access",
        "answer_survives_all_sources_detached",
      ],
    });
    log({ scenario, passed: true, answer: answer.answer });
  }
  report.calls = await db
    .selectFrom("ai_calls")
    .select(["model_id", "state", "input_tokens", "output_tokens"])
    .execute();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String((error as Error).message)
    .split(key)
    .join("[REDACTED]");
  log({ passed: false, error: report.error });
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2));
  await db.destroy();
  await rm(directory, { recursive: true, force: true });
  log({ report: output, passed: report.passed });
}
