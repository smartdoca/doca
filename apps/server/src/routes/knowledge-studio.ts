import {registerCurationWorkspace} from "./knowledge-curation-workspace.js";
import {messageFeedback,recordQuestionFeedback} from "@core/modules/knowledge/question-feedback.js";
import { registerKnowledgeBotAccess } from "./knowledge-bot-access.js";
import {
  checkAttachments,
  attachmentInfo,
} from "../services/ai/attachments.js";
import { retryKnowledgeTask } from "@core/modules/knowledge/recovery.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { tokenHash } from "@core/modules/identity/passwords.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import {
  conversationAccess,
  createKnowledgeConversation,
  listKnowledgeConversations,
  sendKnowledgeMessage,
  knowledgeBot,
  visibleKnowledgeAnswers,
} from "@core/modules/knowledge/conversations.js";
import {
  publicationStatus,
  publishKnowledgeDocuments,
  type AnswerIndex,
} from "@core/modules/knowledge/publications.js";
import {
  maintainKnowledge,
  knowledgeBotConfig,
  knowledgeSettingsSchema,
  saveKnowledgeSettings,
  knowledgeInstructions,
} from "@core/modules/knowledge/system.js";
import {
  createKnowledgeStudio,
  libraryCases,
  runSourceAction,
} from "../services/ai/knowledge-studio.js";

export function registerKnowledgeStudio(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  index?: AnswerIndex,
  notify?: (id: string) => Promise<void>,
  consumeRateLimit?: (key: string, max: number, windowMs: number) => Promise<boolean>,
) {
  const studio = createKnowledgeStudio(db, index, notify);
  registerKnowledgeBotAccess(api, db, auth, studio, consumeRateLimit);
  registerCurationWorkspace(api, db, auth);
  const root = "/api/v1/knowledge";
  api.get<{ Querystring: { scopeId: string; kind: "curation" | "answer"; archived?: string } }>(
    `${root}/conversations`,
    async (req) => {
      const query = z
        .object({
          scopeId: z.string().uuid(),
          kind: z.enum(["curation", "answer"]),
          archived: z.enum(["true", "false"]).optional(),
        })
        .parse(req.query);
      return {
        items: await listKnowledgeConversations(
          db,
          auth(req),
          query.scopeId,
          query.kind,
          query.archived === "true",
        ),
      };
    },
  );
  api.post(`${root}/conversations`, async (req) => {
    const body = z
      .object({
        scopeId: z.string().uuid(),
        kind: z.enum(["curation", "answer"]),
        title: z.string().max(160),
      })
      .parse(req.body);
    return createKnowledgeConversation(
      db,
      auth(req),
      body.scopeId,
      body.kind,
      body.title,
    );
  });
  async function visibleMessages(actor: Actor, id: string) {
    const conversation = await conversationAccess(db, actor, id);
    let messages = await db
      .selectFrom("knowledge_messages as m")
      .leftJoin("users as u", "u.id", "m.author_id")
      .select([
        "m.id",
        "m.role",
        "m.content",
        "m.detail",
        "m.trigger",
        "m.author_id",
        "m.created_at",
        "u.display_name as authorName",
      ])
      .where("m.conversation_id", "=", id)
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
    if (conversation.kind === "answer")
      messages = await visibleKnowledgeAnswers(
        db,
        actor,
        conversation.scope_id,
        messages,
      );
    const feedback=await messageFeedback(db,actor.id,messages.map(x=>x.id));
    return {
      conversation,
      messages: messages.map((x) => ({ ...x, feedback:feedback[x.id]??null, detail: JSON.parse(x.detail) })),
    };
  }
  api.get<{ Params: { id: string } }>(`${root}/conversations/:id`, (req) =>
    visibleMessages(auth(req), req.params.id),
  );
  async function manageConversations(
    actor: Actor,
    ids: string[],
    action: "archive" | "restore" | "delete",
  ) {
    const unique = [...new Set(ids)];
    return db.transaction().execute(async (tx) => {
      const conversations = [];
      for (const id of unique)
        conversations.push(await conversationAccess(tx, actor, id));
      const active = conversations.find((conversation) =>
        ["queued", "running"].includes(conversation.state),
      );
      if (active) fail(409, "请先等待或暂停正在运行的会话");
      if (action !== "delete") {
        const result = await tx
          .updateTable("knowledge_conversations")
          .set({
            archived: action === "archive" ? 1 : 0,
            updated_at: new Date().toISOString(),
          })
          .where("id", "in", unique)
          .executeTakeFirst();
        return { updated: Number(result.numUpdatedRows ?? 0) };
      }
      const tasks = await tx
          .selectFrom("knowledge_tasks")
          .select("id")
          .where("conversation_id", "in", unique)
          .execute(),
        messages = await tx
          .selectFrom("knowledge_messages")
          .select("id")
          .where("conversation_id", "in", unique)
          .execute();
      if (tasks.length)
        await tx
          .deleteFrom("knowledge_checkpoints")
          .where("task_id", "in", tasks.map((task) => task.id))
          .execute();
      if (messages.length)
        await tx
          .deleteFrom("knowledge_cases")
          .where("message_id", "in", messages.map((message) => message.id))
          .execute();
      const result = await tx
        .deleteFrom("knowledge_conversations")
        .where("id", "in", unique)
        .executeTakeFirst();
      return { deleted: Number(result.numDeletedRows ?? 0) };
    });
  }
  api.post(`${root}/conversations/batch`, async (req) => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(200),
        action: z.enum(["archive", "restore", "delete"]),
      })
      .parse(req.body);
    return manageConversations(auth(req), body.ids, body.action);
  });
  api.patch<{ Params: { id: string } }>(
    `${root}/conversations/:id`,
    async (req) => {
      const body = z.object({ archived: z.boolean() }).parse(req.body);
      return manageConversations(
        auth(req),
        [req.params.id],
        body.archived ? "archive" : "restore",
      );
    },
  );
  api.delete<{ Params: { id: string } }>(
    `${root}/conversations/:id`,
    (req) => manageConversations(auth(req), [req.params.id], "delete"),
  );
  api.post<{ Params: { id: string } }>(
    `${root}/conversations/:id/messages`,
    async (req) => {
      const body = z
        .object({
          content: z.string().min(1).max(20000),
          requestId: z.string().uuid(),
          attachments: z.array(z.string().uuid()).max(8).default([]),
          channel: z.enum(["web", "embed"]).default("web"),
        })
        .parse(req.body);
      const actor = auth(req),
        conversation = await conversationAccess(db, actor, req.params.id);
      if (conversation.archived) fail(409, "请先恢复归档会话");
      if (conversation.kind === "answer") {
        const bot = await knowledgeBot(db, actor, conversation.scope_id);
        if (!knowledgeBotConfig(bot).channels.includes(body.channel))
          fail(403, "网页问答已关闭");
        if (!JSON.parse(bot.library_ids).length)
          fail(409, "尚未绑定可用知识库");
        if (
          body.attachments.length &&
          !knowledgeBotConfig(bot).attachmentsEnabled
        )
          fail(403, "此机器人未开启附件");
      } else if (body.attachments.length) fail(400, "此入口不支持整理附件");
      const attachments = (
        await checkAttachments(db, actor.id, body.attachments)
      ).map(attachmentInfo);
      return sendKnowledgeMessage(
        db,
        actor,
        req.params.id,
        body.content,
        body.requestId,
        "manual",
        attachments,
      );
    },
  );
  api.post<{ Params: { id: string } }>(
    `${root}/conversations/:id/pause`,
    async (req) => {
      await conversationAccess(db, auth(req), req.params.id);
      await db
        .updateTable("knowledge_conversations")
        .set({ state: "paused" })
        .where("id", "=", req.params.id)
        .execute();
      await db
        .updateTable("knowledge_tasks")
        .set({ status: "canceled" })
        .where("conversation_id", "=", req.params.id)
        .where("status", "=", "queued")
        .execute();
      return { ok: true };
    },
  );
  api.get<{ Params: { id: string } }>(
    `${root}/conversations/:id/stream`,
    async (req, reply) => {
      const actor = auth(req);
      await conversationAccess(db, actor, req.params.id);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      reply.raw.on("close", () => {
        closed = true;
      });
      let last = "";
      try {
        while (!closed) {
          const value = await visibleMessages(actor, req.params.id);
          const json = JSON.stringify(value);
          if (json !== last) {
            reply.raw.write(`event: update\ndata: ${json}\n\n`);
            last = json;
          }
          if (!["running", "queued"].includes(value.conversation.state)) {
            reply.raw.write("event: done\ndata: {}\n\n");
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      } catch {
        if (!closed)
          reply.raw.write(
            'event: error\ndata: {"code":"access_or_stream_failed"}\n\n',
          );
      } finally {
        reply.raw.end();
      }
    },
  );
  api.get<{ Params: { id: string } }>(
    `${root}/libraries/:id/publication`,
    async (req) => {
      await maintainKnowledge(db, auth(req), req.params.id);
      return publicationStatus(db, req.params.id);
    },
  );
  api.post<{ Params: { id: string } }>(
    `${root}/libraries/:id/publication`,
    async (req) => {
      await publishKnowledgeDocuments(db, auth(req), req.params.id, index);
      return publicationStatus(db, req.params.id);
    },
  );
  api.put<{ Params: { id: string } }>(
    `${root}/libraries/:id/publication-mode`,
    async (req) => {
      const body = z
        .object({ mode: z.enum(["automatic", "manual"]) })
        .parse(req.body);
      const actor = auth(req),
        bundle = await knowledgeInstructions(db, actor, req.params.id);
      return saveKnowledgeSettings(
        db,
        actor,
        req.params.id,
        bundle.settingsRevision,
        { ...bundle.settings, publicationMode: body.mode },
      );
    },
  );
  api.get<{ Params: { id: string } }>(
    `${root}/libraries/:id/source-actions`,
    async (req) => {
      await maintainKnowledge(db, auth(req), req.params.id);
      return {
        items: await db
          .selectFrom("knowledge_source_actions")
          .selectAll()
          .where("library_id", "=", req.params.id)
          .orderBy("created_at", "desc")
          .limit(200)
          .execute(),
      };
    },
  );
  api.post<{ Params: { id: string } }>(
    `${root}/libraries/:id/source-actions`,
    async (req) => {
      const body = z
        .object({
          sourceKey: z.string().max(2000),
          action: z.enum([
            "ignore",
            "restore",
            "pause",
            "resume",
            "priority",
            "detach",
          ]),
          reason: z.string().max(2000),
          weight: z.number().min(0).max(100).optional(),
          scope: z.string().max(300).optional(),
        })
        .parse(req.body);
      return runSourceAction(db, auth(req), req.params.id, body);
    },
  );
  api.get<{ Params: { id: string } }>(
    `${root}/libraries/:id/cases`,
    async (req) => ({
      items: await libraryCases(db, auth(req), req.params.id),
    }),
  );
  api.post<{ Params: { id: string } }>(
    `${root}/messages/:id/feedback`,
    async (req) => {
      const body=z.object({judgment:z.enum(["useful","unhelpful"]).nullable(),reason:z.string().max(2000).default("")}).parse(req.body);
      return recordQuestionFeedback(db,auth(req),req.params.id,body.judgment,body.reason);
    },
  );
  api.post<{ Params: { id: string } }>(
    `${root}/assistants/:id/search`,
    async (req) => {
      const body = z
        .object({ query: z.string().min(1).max(4000) })
        .parse(req.body);
      const actor = auth(req),
        bot = await knowledgeBot(db, actor, req.params.id);
      if (!knowledgeBotConfig(bot).channels.includes("api"))
        fail(403, "API 调用已关闭");
      return studio.searchAnswer(actor, req.params.id, body.query);
    },
  );
  api.post<{ Params: { id: string } }>(
    `${root}/assistants/:id/retrieve`,
    async (req) => {
      const body = z
        .object({ query: z.string().min(1).max(4000) })
        .parse(req.body);
      const actor = auth(req),
        bot = await knowledgeBot(db, actor, req.params.id);
      if (!knowledgeBotConfig(bot).channels.includes("api"))
        fail(403, "API 调用已关闭");
      return studio.searchAnswer(actor, req.params.id, body.query);
    },
  );
  async function ask(
    actor: Actor,
    botId: string,
    query: string,
    conversationId?: string,
  ) {
    const conversation = conversationId
      ? await conversationAccess(db, actor, conversationId)
      : await createKnowledgeConversation(
          db,
          actor,
          botId,
          "answer",
          query.slice(0, 80),
        );
    if (conversation.kind !== "answer" || conversation.scope_id !== botId)
      fail(400, "会话与机器人不匹配");
    await sendKnowledgeMessage(db, actor, conversation.id, query, randomUUID());
    return {
      conversationId: conversation.id,
      status: "queued",
      streamUrl: `/api/v1/knowledge/conversations/${conversation.id}/stream`,
    };
  }
  api.post<{ Params: { id: string } }>(
    `${root}/assistants/:id/ask`,
    async (req) => {
      const body = z
        .object({
          query: z.string().min(1).max(20000),
          conversationId: z.string().uuid().optional(),
        })
        .parse(req.body);
      const actor = auth(req),
        bot = await knowledgeBot(db, actor, req.params.id);
      if (!knowledgeBotConfig(bot).channels.includes("api"))
        fail(403, "API 调用已关闭");
      if (!JSON.parse(bot.library_ids).length) fail(409, "尚未绑定可用知识库");
      return ask(actor, req.params.id, body.query, body.conversationId);
    },
  );
  api.post(`${root}/mcp`, { bodyLimit: 100000 }, async (req, reply) => {
    const token = /^Bearer (doca_mcp_[a-f0-9]{64})$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    if (!token) fail(401, "需要 MCP 访问凭据");
    const key = await db
      .selectFrom("ai_mcp_keys")
      .selectAll()
      .where("token_hash", "=", tokenHash(token))
      .where("expires_at", ">", new Date().toISOString())
      .executeTakeFirst();
    if (!key) fail(401, "凭据已失效");
    const actor = await db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", key.user_id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!actor) fail(401, "账号不可用");
    const scope = JSON.parse(key.resource_ids) as string[];
    const check = async (botId: string) => {
      const bot = await knowledgeBot(db, actor, botId);
      if (!knowledgeBotConfig(bot).channels.includes("mcp"))
        fail(403, "MCP 调用已关闭");
      if (
        !(JSON.parse(bot.library_ids) as string[]).every((id) =>
          scope.includes(id),
        )
      )
        fail(403, "凭据未授权此机器人所用知识库");
    };
    const server = new McpServer({ name: "doca-knowledge", version: "1.0.0" });
    const wrap =
      (fn: (input: any) => Promise<unknown>) => async (input: any) => {
        try {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(await fn(input)) },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: (error as Error).message },
            ],
          };
        }
      };
    server.registerTool(
      "knowledge_search",
      {
        description: "检索当前生效知识版本的证据，只读，不访问来源或个人记忆。",
        inputSchema: {
          botId: z.string().uuid(),
          query: z.string().min(1).max(4000),
        },
      },
      wrap(async ({ botId, query }) => {
        await check(botId);
        return studio.searchAnswer(actor, botId, query);
      }),
    );
    server.registerTool(
      "knowledge_ask",
      {
        description:
          "启动或继续独立多轮知识问答，返回会话ID，通过knowledge_answer读取进度与答案。",
        inputSchema: {
          botId: z.string().uuid(),
          query: z.string().min(1).max(20000),
          conversationId: z.string().uuid().optional(),
        },
      },
      wrap(async ({ botId, query, conversationId }) => {
        await check(botId);
        return ask(actor, botId, query, conversationId);
      }),
    );
    server.registerTool(
      "knowledge_answer",
      {
        description: "读取知识问答的流式进度或完成答案和引用。",
        inputSchema: { conversationId: z.string().uuid() },
      },
      wrap(async ({ conversationId }) => {
        const conversation = await conversationAccess(
          db,
          actor,
          conversationId,
        );
        if (conversation.kind !== "answer") fail(403, "只允许问答会话");
        await check(conversation.scope_id);
        return visibleMessages(actor, conversationId);
      }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  let stopped = false,
    busy = false,
    lastSync = 0;
  const running = new Map<string, Promise<void>>();
  let synchronization: Promise<void> | undefined;
  const publicationRetries = new Map<string, { failures: number; nextAt: number }>();
  const synchronizePublications = async () => {
    const libraries = await db
      .selectFrom("resources")
      .select(["id", "owner_id"])
      .where("kind", "=", "library")
      .where("ai_curated", "=", 1)
      .where("deleted_at", "is", null)
      .execute();
    for (const library of libraries) {
      if ((publicationRetries.get(library.id)?.nextAt ?? 0) > Date.now()) continue;
      const row = await db
        .selectFrom("knowledge_settings")
        .select("config")
        .where("library_id", "=", library.id)
        .executeTakeFirst();
      if (
        knowledgeSettingsSchema.parse(row ? JSON.parse(row.config) : {})
          .publicationMode !== "automatic"
      )
        continue;
      const actor = await db
        .selectFrom("users")
        .select(["id", "display_name", "admin"])
        .where("id", "=", library.owner_id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (actor)
        try {
          await publishKnowledgeDocuments(db, actor, library.id, index);
          publicationRetries.delete(library.id);
        } catch (error) {
          const failures = (publicationRetries.get(library.id)?.failures ?? 0) + 1;
          publicationRetries.set(library.id, { failures, nextAt: Date.now() + Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)) });
          api.log.warn(
            { libraryId: library.id, error: String(error) },
            "Knowledge publication pending",
          );
        }
    }
  };
  const drain = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const stale = await db
        .selectFrom("knowledge_tasks")
        .selectAll()
        .where("status", "=", "running")
        .where("updated_at", "<", new Date(Date.now() - 180000).toISOString())
        .execute();
      for (const task of stale) {
        if (
          await retryKnowledgeTask(
            db,
            task.id,
            new Error("任务进程中断，自动续跑"),
            true,
          )
        ) {
          await db
            .updateTable("knowledge_conversations")
            .set({ state: "queued" })
            .where("id", "=", task.conversation_id)
            .where("state", "!=", "paused")
            .execute();
          continue;
        }
        await db
          .updateTable("knowledge_tasks")
          .set({ status: "failed", error: "interrupted" })
          .where("id", "=", task.id)
          .execute();
        await db
          .updateTable("knowledge_conversations")
          .set({ state: "failed" })
          .where("id", "=", task.conversation_id)
          .execute();
      }
      const candidates = await db
        .selectFrom("knowledge_tasks as t")
        .leftJoin("knowledge_checkpoints as p", "p.task_id", "t.id")
        .innerJoin("knowledge_conversations as c", "c.id", "t.conversation_id")
        .select(["t.id", "t.conversation_id", "c.kind"])
        .where("t.status", "=", "queued")
        .where("c.state", "!=", "paused")
        .where((eb) =>
          eb.or([
            eb("p.available_at", "is", null),
            eb("p.available_at", "<=", new Date().toISOString()),
          ]),
        )
        .orderBy("c.kind")
        .orderBy("t.created_at")
        .limit(30)
        .execute();
      for (const task of candidates) {
        if (running.size >= 3) break;
        if (running.has(task.conversation_id)) continue;
        const processing = await db
          .selectFrom("knowledge_tasks")
          .select("id")
          .where("conversation_id", "=", task.conversation_id)
          .where("status", "=", "running")
          .executeTakeFirst();
        if (processing) continue;
        const promise = studio
          .process(task.id)
          .finally(() => running.delete(task.conversation_id));
        running.set(task.conversation_id, promise);
      }
      // Index preparation can take minutes; it must never hold the chat queue lock.
      if (!synchronization && Date.now() - lastSync > 5000) {
        lastSync = Date.now();
        synchronization = synchronizePublications()
          .catch((error) =>
            api.log.error(error, "Knowledge publication worker failed"),
          )
          .finally(() => {
            synchronization = undefined;
          });
      }
    } catch (error) {
      api.log.error(error, "Knowledge studio worker failed");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void drain(), 700);
  timer.unref();
  api.addHook("preClose", async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.allSettled([
      ...running.values(),
      ...(synchronization ? [synchronization] : []),
    ]);
  });
  return studio;
}
