import { knowledgeGenerate } from "../apps/server/src/services/ai/knowledge-model.js";
/** User-authorized network guide demo. Creates only its own new library; never resets existing data. */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { openDatabase } from "../packages/db/src/index.js";
import { config } from "../apps/server/src/bootstrap/config.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { aiConfig } from "../packages/core/src/modules/ai/config.js";
import { meteredModel } from "../apps/server/src/services/ai/model.js";
import {
  saveHumanKnowledge,
  reviewKnowledgeEntry,
  knowledgeInstructions,
  saveKnowledgeInstruction,
  saveKnowledgeSettings,
  saveKnowledgeAssistant,
} from "../packages/core/src/modules/knowledge/system.js";
import {
  subscribeKnowledgeSource,
  setLibraryCuration,
} from "../packages/core/src/modules/knowledge/subscriptions.js";
import {
  createKnowledgeConversation,
  appendKnowledgeMessage,
} from "../packages/core/src/modules/knowledge/conversations.js";
import { publishKnowledgeDocuments } from "../packages/core/src/modules/knowledge/publications.js";

const directory = "artifacts/network-guide";
await mkdir(directory, { recursive: true });
const statePath = `${directory}/state.json`;
const state: any = await readFile(statePath, "utf8")
  .then(JSON.parse)
  .catch(() => ({ chapters: {}, sources: {} }));
const db = await openDatabase(config().database);
const persist = () => writeFile(statePath, JSON.stringify(state, null, 2));
const log = (stage: string, data: unknown) =>
  console.log(JSON.stringify({ stage, data }));
try {
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("login", "=", "admin")
    .where("status", "=", "active")
    .executeTakeFirstOrThrow();
  const ai = await aiConfig(db);
  const modelId =
    process.env.DOCA_GUIDE_MODEL ||
    ai.models.find((x) => x.model === "kimi-k3" && x.enabled)?.id ||
    ai.defaultModel;
  const model = await meteredModel(db, actor.id, modelId, null);
  const generate = async (
    system: string,
    prompt: string,
    maxOutputTokens = 10000,
  ) => {
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        const result = await knowledgeGenerate(model, {
          prompt: [
            { role: "system", content: system },
            { role: "user", content: [{ type: "text", text: prompt }] },
          ],
          maxOutputTokens,
          abortSignal: AbortSignal.timeout(300000),
        });
        if (result.finishReason.unified === "length")
          throw Error("Output truncated");
        return result.content
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n");
      } catch (error) {
        log("retry", { attempt, error: (error as Error).message });
        if (attempt === 2) throw error;
      }
    throw Error("generation failed");
  };
  const rfc = [
    1122, 8200, 9293, 768, 1034, 1035, 6891, 8484, 7858, 9110, 9112, 9113, 9114,
    9000, 8446, 2131, 4861, 4271, 2328, 826, 3022, 4301, 7348, 792, 4443, 3376,
    7761, 4291, 8415, 7766, 5681, 9002, 2475, 4594, 4251, 5321, 9051, 5905,
    3411,
  ];
  const materials: Record<string, string> = {};
  await mkdir("/tmp/doca-network-guide-sources", { recursive: true });
  const pendingSources = [...rfc];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (pendingSources.length) {
        const number = pendingSources.shift()!;
        const key = `RFC${number}`,
          path = `/tmp/doca-network-guide-sources/${key}.txt`;
        let text = await readFile(path, "utf8").catch(() => "");
        if (!text) {
          const response = await fetch(
            `https://www.rfc-editor.org/rfc/rfc${number}.txt`,
            { signal: AbortSignal.timeout(90000) },
          );
          if (!response.ok) throw Error(`Cannot read ${key}`);
          text = await response.text();
          await writeFile(path, text);
        }
        materials[key] = text;
        log("source", key);
      }
    }),
  );

  log("sources_loaded", { count: rfc.length });
  if (!state.libraryId) {
    state.libraryId = (
      await createContent(db).create(actor, {
        kind: "library",
        format: "markdown",
        title: "计算机网络指南 · 从协议原理到工程排障",
      })
    ).id;
    await setLibraryCuration(db, actor, state.libraryId, true);
    const session = await createKnowledgeConversation(
      db,
      actor,
      state.libraryId,
      "curation",
      "建设完整计算机网络指南",
    );
    state.conversationId = session.id;
    await appendKnowledgeMessage(
      db,
      session.id,
      "user",
      "建设一套详细的计算机网络指南。第一层按知识种类，后续层级由 AI 按技术组织。覆盖 DNS、TCP/IP、分层模型、局域网、路由、传输、应用、安全、运维等，包含实例、排障、边界和参考依据。",
      actor.id,
      "manual",
    );
    await persist();
  }
  if (!state.configured) {
    let bundle = await knowledgeInstructions(db, actor, state.libraryId);
    await saveKnowledgeInstruction(db, actor, state.libraryId, {
      path: "KNOWLEDGE.md",
      expectedRevision:
        bundle.files.find((x) => x.path === "KNOWLEDGE.md")?.revision ?? 0,
      markdown:
        "# 计算机网络指南\n\n面向计算机专业学生、研发和运维。第一层按知识种类组织，之后按技术主题组织。每篇应是可以独立学习和用于排障的完整章节，而非短摘要。保留原理、报文/状态、具体例子、配置和观测方法、常见误区与安全边界。跨层建立关联。通用标准以 IETF RFC 为主要依据，历史 RFC 标注适用版本和后继标准；平台命令注明系统差异。合成实验使用保留示例域名和文档地址，不伪称实测。原始来源不足时明确缺口，不编造标准参数。人工改动优先保留，冲突生成建议。新增来源先核实再推荐，管理员忽略决定持续有效。每次更新检查来源质量和问答反馈。\n\n## 质量验收\n应能解释 DNS 变更传播、三次握手与拥塞控制、IPv6 邻居发现、HTTP/2 与 QUIC 差异、路由收敛、TLS 身份认证、MTU 黑洞及逐层排障。回答必须引用本库已生效的具体章节。",
    });
    bundle = await knowledgeInstructions(db, actor, state.libraryId);
    await saveKnowledgeSettings(
      db,
      actor,
      state.libraryId,
      bundle.settingsRevision,
      {
        ...bundle.settings,
        modelId,
        maxDocumentDepth: 5,
        publicationMode: "manual",
      },
    );
    state.configured = true;
    await persist();
  }
  for (const number of rfc) {
    const key = `RFC${number}`;
    if (state.sources[key]) continue;
    const url = `https://www.rfc-editor.org/rfc/rfc${number}.html`;
    const source = await subscribeKnowledgeSource(db, actor, state.libraryId, {
      sourceKind: "url",
      url,
    });
    state.sources[key] = source.id;
    await saveKnowledgeInstruction(db, actor, state.libraryId, {
      path: `sources/${source.id}/SOURCE.md`,
      expectedRevision: 0,
      markdown: `# ${key}\nIETF 原始规范。用于相关协议的机制、字段和条件核实；检查规范年代和后继 RFC，不把旧版本当成最新强制实现。提炼完整章节，不限制为短摘要，不复制原文。引用保留 ${key} 和章节号。`,
    });
    await persist();
  }
  const coverage = [
    "网络分层、封装、端到端与设备角色",
    "物理介质、以太网、MAC、VLAN与二层环路",
    "无线局域网机制、漫游与有线对比",
    "IPv4子网/CIDR/最长前缀匹配",
    "IPv6地址、扩展首部、邻居发现",
    "ARP与IPv6 NDP对照",
    "DHCPv4与DHCPv6/SLAAC",
    "ICMP、traceroute与路径MTU",
    "NAT/PAT与连接跟踪",
    "路由表、静态路由与收敛",
    "OSPF区域、邻接与链路状态",
    "BGP路径策略、自治系统与安全边界",
    "UDP语义、数据报与应用可靠性",
    "TCP连接建立、关闭与状态机",
    "TCP序号、确认、重传与流量控制",
    "TCP拥塞控制、RTT、带宽时延积与性能",
    "QUIC传输、迁移、可靠流与拥塞",
    "DNS命名、委派、递归与权威链路",
    "DNS记录、缓存、负缓存与变更排障",
    "DNS UDP/TCP、EDNS、DoT/DoH与安全",
    "HTTP语义、缓存、代理与条件请求",
    "HTTP/1.1连接复用与消息边界",
    "HTTP/2多路复用、流控与HTTP/3对比",
    "TLS1.3握手、证书、密钥与0-RTT",
    "IPsec、VPN与隧道安全",
    "VXLAN、Overlay与容器网络的分层解释",
    "组播、IGMP与PIM",
    "QoS、DSCP、队列与拥塞管理",
    "SSH远程管理与安全访问",
    "邮件SMTP/IMAP与端到端投递",
    "NTP时钟同步与SNMP监测",
    "从DNS到TLS到HTTP的全链路排障实验",
  ];
  if (!state.plan) {
    const raw = await generate(
      "你是计算机网络教材主编。输出严格 JSON，不含代码围栏。只能选择给出的RFC资料ID。目录由你设计，第一层必须是知识种类而不是技术/应用/未来这种泛分类。对缺少 IEEE 等一手材料的部分在 sourceGap 明确写出，不能假称有标准依据。",
      JSON.stringify({
        task: "规划覆盖全部主题的32篇详细章节，每个给出key、title、path(1到3层父目录，不含标题)、objectives(字符串)、sourceQueries(5到10个英文检索关键词)、sources(1到4个RFC ID)、sourceGap。返回{chapters:[...]}",
        coverage,
        availableSources: rfc.map((x) => `RFC${x}`),
      }),
      12000,
    );
    state.plan = JSON.parse(
      raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
    );
    if (state.plan.chapters.length < 30) throw Error("Plan lacks coverage");
    await writeFile(
      `${directory}/plan.json`,
      JSON.stringify(state.plan, null, 2),
    );
    await appendKnowledgeMessage(
      db,
      state.conversationId,
      "assistant",
      `已规划 ${state.plan.chapters.length} 个完整章节，第一层按知识种类组织。\n\n` +
        state.plan.chapters
          .map((x: any) => `- ${x.path.join(" / ")} / ${x.title}`)
          .join("\n"),
    );
    await persist();
  }
  // Independent chapter generations; database persistence is serialized below.
  const queue = [...state.plan.chapters].filter(
    (chapter) => !state.chapters[chapter.key],
  );
  let writing = Promise.resolve();
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const chapter = queue.shift();
        if (!chapter) break;
        log("chapter_started", { key: chapter.key, title: chapter.title });
        const keywords = (chapter.sourceQueries ?? [])
          .join(" ")
          .toLowerCase()
          .split(/\s+/)
          .filter((x: string) => x.length > 3);
        const sourceTexts = chapter.sources
          .filter((key: string) => materials[key])
          .map((key: string) => {
            const full = materials[key];
            const windows = [];
            for (let start = 0; start < full.length; start += 1800) {
              const text = full.slice(start, start + 2200);
              windows.push({
                start,
                text,
                score: keywords.reduce(
                  (n: number, k: string) =>
                    n + (text.toLowerCase().split(k).length - 1),
                  0,
                ),
              });
            }
            const chosen = windows
              .sort((a, b) => b.score - a.score)
              .slice(0, 7)
              .sort((a, b) => a.start - b.start);
            return {
              id: key,
              excerpts: true,
              text: chosen.map((x) => x.text).join("\n[下一摘录]\n"),
            };
          });
        const prompt = JSON.stringify({
          chapter,
          requirements:
            "中文撰写，至少2500个汉字（通常3500到5500字），章节按具体技术灵活组织，必须包含学习目标、核心机制和关键报文字段/状态、具体数值例子或逐步过程、可操作的观测/诊断方法、常见误区、边界与安全、至少3个带解释的自测题、参考RFC和具体节号。表格用于字段或对比，命令用代码块。例子明确为推演，不虚构实测结果。不要泛泛重复‘很重要’；不能以摘要冒充指南。不要复制资料原文。资料未覆盖的标准细节明确说明未核实，工程经验与规范要求分开。不以sourceGap阻止整个章节，但不能虚构IEEE标准条文或精确参数。",
          sources: sourceTexts,
        });
        let markdown = await generate(
          "你是严谨的计算机网络教材作者。根据提供的一手RFC材料写原创中文详细章节。先准确解释机制，再推演例子，再给诊断方法。阅读所有相关资料，区分RFC版本、可选行为和必需行为。仅输出完整Markdown正文。",
          prompt,
          8000,
        );
        if (markdown.length < 4500)
          markdown = await generate(
            "你是计算机网络教材作者，上一稿深度不足。根据材料重写完整章节，必须至少7000个字符，逐项解释报文、状态和实例，避免空泛。仅输出完整Markdown。",
            prompt + "\n上一稿：\n" + markdown,
            8000,
          );
        if (markdown.length < 4000)
          throw Error(`Shallow chapter: ${chapter.title}`);
        await writeFile(`${directory}/${chapter.key}.md`, markdown);
        writing = writing.then(async () => {
          const draft = await saveHumanKnowledge(db, actor, state.libraryId, {
            title: chapter.title,
            path: chapter.path,
            markdown,
            expectedRevision: 0,
          });
          await db
            .updateTable("knowledge_entries")
            .set({
              origin: "ai_synthesized",
              source_refs: JSON.stringify(
                chapter.sources
                  .filter((x: string) => state.sources[x])
                  .map((x: string) => ({
                    subscriptionId: state.sources[x],
                    version: "rfc",
                    title: x,
                  })),
              ),
            })
            .where("id", "=", draft.id)
            .execute();
          const result = await reviewKnowledgeEntry(
            db,
            actor,
            state.libraryId,
            draft.id,
            draft.revision,
            "publish",
          );
          state.chapters[chapter.key] = {
            id: draft.id,
            title: chapter.title,
            path: chapter.path,
            characters: markdown.length,
            nodeId: result.reviewState.nodeId,
          };
          await appendKnowledgeMessage(
            db,
            state.conversationId,
            "tool",
            "draft",
            null,
            "assistant",
            {
              name: "draft",
              status: "completed",
              result: {
                title: chapter.title,
                characters: markdown.length,
                nodeId: result.reviewState.nodeId,
                sources: chapter.sources,
              },
            },
          );
          await persist();
          log("chapter_saved", state.chapters[chapter.key]);
        });
        await writing;
      }
    }),
  );
  if (!state.botId) {
    const bot = await saveKnowledgeAssistant(db, actor, {
      title: "计算机网络问答",
      libraryIds: [state.libraryId],
      memberIds: [],
      visibility: "authenticated",
      enabled: true,
      expectedRevision: 0,
    });
    state.botId = bot.id;
    await persist();
  }
  // Index publication is performed through the running server so it uses the configured Meilisearch runtime.
  state.completedAt = new Date().toISOString();
  state.libraryUrl = `${config().origin}/#/r/${state.libraryId}`;
  state.studioUrl = `${state.libraryUrl}?view=system`;
  state.botUrl = `${config().origin}/#/knowledge-assistants?bot=${state.botId}`;
  await appendKnowledgeMessage(
    db,
    state.conversationId,
    "assistant",
    `已完成 ${Object.keys(state.chapters).length} 个详细章节，共 ${Object.values(state.chapters).reduce((sum: number, x: any) => sum + x.characters, 0)} 字符。文档可以直接编辑。问答生效方式暂设为手动，完成索引与质量验收后发布。`,
  );
  await persist();
  log("complete", {
    chapters: Object.keys(state.chapters).length,
    libraryUrl: state.libraryUrl,
    botUrl: state.botUrl,
  });
} finally {
  await db.destroy();
}
