import { request } from "node:http";
/** Live acceptance: uses the configured model/index and keeps inspectable demo conversations. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { openDatabase } from "../packages/db/src/index.js";
import { config } from "../apps/server/src/bootstrap/config.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import {
  setLibraryCuration,
  subscribeKnowledgeSource,
} from "../packages/core/src/modules/knowledge/subscriptions.js";
import {
  knowledgeInstructions,
  saveKnowledgeSettings,
} from "../packages/core/src/modules/knowledge/system.js";
import {
  createKnowledgeConversation,
  sendKnowledgeMessage,
} from "../packages/core/src/modules/knowledge/conversations.js";
const db = await openDatabase(config().database),
  file = "artifacts/network-guide/live-acceptance.json",
  state = JSON.parse(
    await readFile("artifacts/network-guide/state.json", "utf8"),
  );
const report: any = await readFile(file, "utf8")
  .then(JSON.parse)
  .catch(() => ({ checks: [] }));
const actor = await db
  .selectFrom("users")
  .select(["id", "display_name", "admin"])
  .where("login", "=", "admin")
  .executeTakeFirstOrThrow();
const token = randomBytes(32).toString("hex"),
  hash = createHash("sha256").update(token).digest("hex");
await db
  .insertInto("sessions")
  .values({
    id: hash,
    user_id: actor.id,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })
  .execute();
const api = (
  path: string,
  body?: unknown,
  raw = false,
  extraHeaders: Record<string, string> = {},
): Promise<any> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 39120,
        path: `/api/v1/knowledge${path}`,
        method: body ? "POST" : "GET",
        headers: {
          Host: "127.0.0.1:39130",
          Cookie: `doca_session=${token}`,
          Origin: "http://127.0.0.1:39130",
          "Content-Type": "application/json",
          ...extraHeaders,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (part) => (data += part));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400)
            reject(Error(`${res.statusCode}: ${data}`));
          else
            try {
              resolve(raw ? data : JSON.parse(data));
            } catch (error) {
              reject(error);
            }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(600000, () => req.destroy(Error("HTTP timeout")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
const save = () => writeFile(file, JSON.stringify(report, null, 2));
async function waitTask(id: string) {
  let last = "";
  for (let i = 0; i < 450; i++) {
    const task = await db
      .selectFrom("knowledge_tasks")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    if (last !== task.status) {
      last = task.status;
      console.log(JSON.stringify({ task: id, status: last }));
    }
    if (task.status === "completed") return;
    if (["failed", "canceled"].includes(task.status))
      throw Error(task.error || task.status);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw Error("Task did not finish within 15 minutes");
}
async function curation(label: string, content: string, trigger = "manual") {
  const old = report.checks.find((x: any) => x.label === label && x.passed);
  if (old) return old;
  const conversation = await createKnowledgeConversation(
      db,
      actor,
      report.internalLibraryId,
      "curation",
      label,
    ),
    id = randomUUID();
  await sendKnowledgeMessage(db, actor, conversation.id, content, id, trigger);
  await waitTask(id);
  const events = await db
    .selectFrom("knowledge_messages")
    .selectAll()
    .where("conversation_id", "=", conversation.id)
    .execute();
  const scope = (
    await knowledgeInstructions(db, actor, report.internalLibraryId)
  ).settings.sourceScope;
  const calls = events
    .filter((x) => x.role === "tool")
    .map((x) => JSON.parse(x.detail));
  const check = {
    label,
    conversationId: conversation.id,
    taskId: id,
    scope,
    calls: calls.map((x) => ({ name: x.name, error: x.result?.error })),
    passed:
      scope === (label === "explicit-web-opt-in" ? "web" : "internal") &&
      !calls.some((x) => ["read_web", "search_sources"].includes(x.name)),
  };
  report.checks.push(check);
  await save();
  console.log(JSON.stringify(check));
  if (!check.passed) throw Error(label + " failed");
  return check;
}
try {
  if (!report.internalLibraryId) {
    const content = createContent(db),
      library = await content.create(actor, {
        kind: "library",
        format: "markdown",
        title: "验收 · 内部项目知识（来源边界）",
      });
    report.internalLibraryId = library.id;
    await setLibraryCuration(db, actor, library.id, true);
    const doc = await content.create(actor, {
      kind: "document",
      format: "markdown",
      title: "内部验收资料：海鸥项目",
      markdown:
        "# 海鸥项目内部发布规则\n\n仅用于验收的虚构项目。发布窗口为每周三14:30至15:00（亚洲/上海时区）。发布负责人为角色‘值班发布管理员’。发布前执行回滚演练，回滚门槛为连续五分钟错误率高于2%。客户数据保留期限未定义，需要内部负责人补充，禁止自行推断。",
    });
    report.internalSourceId = doc.id;
    await subscribeKnowledgeSource(db, actor, library.id, {
      sourceKind: "document",
      title: "海鸥项目内部文档",
      sourceIds: [doc.id],
    });
    await save();
  }
  await curation(
    "internal-only",
    "只从已经注册的内部项目文档获取，不要读取、推荐或注册网络来源。请读取内部资料，整理一篇完整的海鸥项目发布指南并采用，明确指出内部尚未定义的数据保留期限，不要补造数字。只需完成这一个主题，无须扩展。",
  );
  await curation(
    "scheduled-internal-scope",
    "检查已注册内部资料是否变化，并检查资料缺口。未变化则保留成果；不需要请求人工批准。",
    "schedule",
  );
  await curation(
    "explicit-web-opt-in",
    "现在明确允许新增网络来源。请只更新来源范围并确认，不要立即搜索、推荐或订阅任何链接。",
  );
  if (!report.publication) {
    report.publication = await api(
      `/libraries/${state.libraryId}/publication`,
      {},
    );
    await save();
    console.log(JSON.stringify({ publication: report.publication }));
  }
  if ((report.answers?.length ?? 0) < 3) {
    report.answers ??= [];
    let conversationId: string | undefined =
      report.answers.at(-1)?.conversationId;
    for (const query of [
      "DNS负缓存的TTL如何计算？如果SOA记录TTL是600秒、MINIMUM是3600秒，结果是多少？",
      "那五分钟后还剩多久？我刚创建了这个域名，缓存会立即失效吗？",
      "dig +norecurse 能保证绕过递归解析器的缓存吗？",
    ].slice(report.answers.length)) {
      const answer = await api(`/assistants/${state.botId}/ask`, {
        query,
        conversationId,
      });
      conversationId = answer.conversationId;
      const task = await db
        .selectFrom("knowledge_tasks")
        .select("id")
        .where("conversation_id", "=", conversationId!)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      await waitTask(task.id);
      const history = await api(`/conversations/${conversationId}`);
      const message = history.messages
        .filter((x: any) => x.role === "assistant")
        .at(-1);
      report.answers.push({
        query,
        conversationId,
        messageId: message.id,
        answer: message.content,
        citations: message.detail.citations,
      });
      await save();
      console.log(JSON.stringify({ answer: message.content }));
    }
  }

  const retrieved = await api(`/assistants/${state.botId}/retrieve`, {
    query: "DNS负缓存TTL SOA MINIMUM",
  });
  report.retrieval = {
    engine: retrieved.engine,
    evidenceCount: retrieved.items.length,
  };
  if (!retrieved.items.length) throw Error("No retrieval evidence");
  const last = report.answers.at(-1),
    stream = await api(
      `/conversations/${last.conversationId}/stream`,
      undefined,
      true,
    );
  report.stream = {
    update: stream.includes("event: update"),
    done: stream.includes("event: done"),
    containsAnswer: stream.includes(last.messageId),
  };
  if (!Object.values(report.stream).every(Boolean))
    throw Error("SSE did not deliver answer");
  await api(`/messages/${last.messageId}/feedback`, {
    judgment: "useful",
    reason: "验收：正确说明 RD=0 不保证绕过缓存",
  });
  const cases = await api(`/libraries/${state.libraryId}/cases`);
  report.feedback = {
    saved: cases.items.some(
      (x: any) => x.message_id === last.messageId && x.judgment === "useful",
    ),
    count: cases.items.length,
  };
  if (!report.feedback.saved) throw Error("Feedback not persisted");
  const mcpToken = "doca_mcp_" + randomBytes(32).toString("hex"),
    mcpId = randomUUID();
  await db
    .insertInto("ai_mcp_keys")
    .values({
      id: mcpId,
      user_id: actor.id,
      name: "Temporary knowledge acceptance",
      token_hash: createHash("sha256").update(mcpToken).digest("hex"),
      resource_ids: JSON.stringify([state.libraryId]),
      writable: 0,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();
  try {
    const headers = {
      Authorization: `Bearer ${mcpToken}`,
      Accept: "application/json, text/event-stream",
      Cookie: "",
    };
    const parse = (raw: string) =>
      JSON.parse(
        raw
          .split("\n")
          .find((x) => x.startsWith("data: "))
          ?.slice(6) ?? raw,
      );
    const listed = parse(
      await api(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        true,
        headers,
      ),
    );
    const answer = parse(
      await api(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "knowledge_answer",
            arguments: { conversationId: last.conversationId },
          },
        },
        true,
        headers,
      ),
    );
    report.mcp = {
      tools: listed.result?.tools?.map((x: any) => x.name),
      answerReadable:
        !answer.result?.isError &&
        JSON.stringify(answer).includes(last.messageId),
    };
    if (report.mcp.tools?.length !== 3 || !report.mcp.answerReadable)
      throw Error("MCP acceptance failed");
  } finally {
    await db.deleteFrom("ai_mcp_keys").where("id", "=", mcpId).execute();
  }
  await save();
  console.log(
    JSON.stringify({
      completed: true,
      report: file,
      retrieval: report.retrieval,
      stream: report.stream,
      feedback: report.feedback,
    }),
  );
} finally {
  await db.deleteFrom("sessions").where("id", "=", hash).execute();
  await db.destroy();
}
