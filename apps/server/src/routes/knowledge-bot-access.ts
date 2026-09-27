import {messageFeedback,recordQuestionFeedback} from "@core/modules/knowledge/question-feedback.js";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyContextConfig,
} from "fastify";
import type { DB } from "@db/index.js";
import { tokenHash, type Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import {
  canManageKnowledgeBot,
  knowledgeBotConfig,
  listKnowledgeAssistants,
  effectiveKnowledgeBotLibraries,
} from "@core/modules/knowledge/system.js";
import {
  conversationAccess,
  createKnowledgeConversation,
  sendKnowledgeMessage,
  visibleKnowledgeAnswers,
} from "@core/modules/knowledge/conversations.js";
import type { createKnowledgeStudio } from "../services/ai/knowledge-studio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export function registerKnowledgeBotAccess(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  studio: ReturnType<typeof createKnowledgeStudio>,
  consumeRateLimit?: (key: string, max: number, windowMs: number) => Promise<boolean>,
) {
  const root = "/api/v1/knowledge/assistants";
  async function manage(actor: Actor, id: string) {
    const bot = await db
      .selectFrom("knowledge_assistants")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!bot || !canManageKnowledgeBot(bot, actor.id))
      fail(403, "无权管理此机器人");
    return bot;
  }
  api.get<{ Params: { id: string } }>(`${root}/:id`, async (req) => {
    const actor = auth(req),
      item = (
        await listKnowledgeAssistants(db, actor, undefined, req.params.id)
      ).find((x) => x.id === req.params.id);
    if (!item) fail(404, "机器人不可用");
    const bot = await db
        .selectFrom("knowledge_assistants")
        .selectAll()
        .where("id", "=", item.id)
        .executeTakeFirstOrThrow(),
      active = await effectiveKnowledgeBotLibraries(db, bot);
    return {
      ...item,
      activeLibraryCount: active.length,
      ...(item.canManage ? { activeLibraryIds: active } : {}),
    };
  });
  api.get<{ Params: { id: string } }>(`${root}/:id/keys`, async (req) => {
    await manage(auth(req), req.params.id);
    return {
      items: await db
        .selectFrom("knowledge_bot_keys")
        .select(["id", "name", "channel", "expires_at", "created_at"])
        .where("bot_id", "=", req.params.id)
        .where("channel", "not like", "public:%")
        .execute(),
    };
  });
  api.post<{ Params: { id: string } }>(`${root}/:id/keys`, async (req) => {
    const actor = auth(req),
      bot = await manage(actor, req.params.id),
      body = z
        .object({
          name: z.string().trim().min(1).max(100),
          channel: z.enum(["api", "mcp"]),
          days: z.number().int().min(1).max(365).default(90),
        })
        .parse(req.body);
    if (!knowledgeBotConfig(bot).channels.includes(body.channel))
      fail(400, "请先开启对应调用方式");
    const token = "doca_kb_" + randomBytes(32).toString("hex"),
      row = {
        id: randomUUID(),
        bot_id: bot.id,
        creator_id: actor.id,
        name: body.name,
        channel: body.channel,
        token_hash: tokenHash(token),
        expires_at: new Date(Date.now() + body.days * 86400000).toISOString(),
        created_at: new Date().toISOString(),
      };
    await db.insertInto("knowledge_bot_keys").values(row).execute();
    return { id: row.id, token, expiresAt: row.expires_at };
  });
  api.delete<{ Params: { id: string; key: string } }>(
    `${root}/:id/keys/:key`,
    async (req) => {
      await manage(auth(req), req.params.id);
      await db
        .deleteFrom("knowledge_bot_keys")
        .where("id", "=", req.params.key)
        .where("bot_id", "=", req.params.id)
        .execute();
      return { ok: true };
    },
  );
  async function credential(
    req: FastifyRequest,
    botId: string,
    channel: string,
  ) {
    const token = /^Bearer (doca_kb_[a-f0-9]{64})$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    if (!token) fail(401, "需要机器人调用密钥");
    const key = await db
      .selectFrom("knowledge_bot_keys")
      .selectAll()
      .where("token_hash", "=", tokenHash(token))
      .where("bot_id", "=", botId)
      .where("expires_at", ">", new Date().toISOString())
      .executeTakeFirst();
    const bot = await db
      .selectFrom("knowledge_assistants")
      .selectAll()
      .where("id", "=", botId)
      .executeTakeFirst();
    const publicChannel = key?.channel.startsWith("public:")
      ? key.channel.slice(7)
      : null;
    if (
      !key ||
      !bot ||
      !bot.enabled ||
      !canManageKnowledgeBot(bot, key.creator_id) ||
      (publicChannel
        ? channel !== "api" ||
          bot.visibility !== "public" ||
          !knowledgeBotConfig(bot).channels.includes(publicChannel)
        : key.channel !== channel ||
          !knowledgeBotConfig(bot).channels.includes(channel))
    )
      fail(403, "密钥无效或调用方式已关闭");
    const actor = await db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", key.creator_id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!actor) fail(403, "密钥创建者不可用");
    return { key, actor, bot };
  }
  async function answer(
    ctx: Awaited<ReturnType<typeof credential>>,
    conversationId: string,
  ) {
    const conversation = await conversationAccess(
      db,
      ctx.actor,
      conversationId,
    );
    if (
      conversation.scope_id !== ctx.bot.id ||
      conversation.access_key_id !== ctx.key.id
    )
      fail(403, "会话不属于此密钥");
    const messages = await visibleKnowledgeAnswers(
      db,
      ctx.actor,
      ctx.bot.id,
      await db
        .selectFrom("knowledge_messages")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .orderBy("created_at")
        .execute(),
    );
    const feedback=await messageFeedback(db,ctx.actor.id,messages.map(x=>x.id));
    return {
      conversation,
      messages: messages.map((x) => ({ ...x, feedback:feedback[x.id]??null, detail: JSON.parse(x.detail) })),
    };
  }
  async function ask(
    ctx: Awaited<ReturnType<typeof credential>>,
    query: string,
    conversationId?: string,
  ) {
    if (!(await effectiveKnowledgeBotLibraries(db, ctx.bot)).length)
      fail(409, "尚未绑定可用知识库");
    if (conversationId) await answer(ctx, conversationId);
    return db.transaction().execute(async (tx) => {
      const conversation = conversationId
        ? await conversationAccess(tx, ctx.actor, conversationId)
        : await createKnowledgeConversation(
            tx,
            ctx.actor,
            ctx.bot.id,
            "answer",
            query.slice(0, 80),
          );
      if (!conversationId)
        await tx
          .updateTable("knowledge_conversations")
          .set({ access_key_id: ctx.key.id })
          .where("id", "=", conversation.id)
          .execute();
      await sendKnowledgeMessage(
        tx,
        ctx.actor,
        conversation.id,
        query,
        randomUUID(),
        ctx.key.channel.startsWith("public:") ? "public" : "api",
      );
      return {
        conversationId: conversation.id,
        status: "queued",
        ...(ctx.key.channel === "mcp"
          ? { answerTool: "knowledge_answer" }
          : {
              streamUrl: `${root}/${ctx.bot.id}/api/conversations/${conversation.id}/stream`,
            }),
      };
    });
  }
  const external = {
    config: { docaPluginExternal: true } as FastifyContextConfig,
  };
  const localRate = new Map<string, { count: number; until: number }>();
  async function limit(req: FastifyRequest, kind: string, max: number) {
    const key = `knowledge:${kind}:${req.ip}`;
    if (consumeRateLimit) {
      if (!(await consumeRateLimit(key, max, 60_000)))
        fail(429, "请求过于频繁，请稍后再试");
      return;
    }
    const now = Date.now();
    for (const [id, value] of localRate)
      if (value.until < now) localRate.delete(id);
    const value = localRate.get(key) ?? { count: 0, until: now + 60_000 };
    if (++value.count > max) fail(429, "请求过于频繁，请稍后再试");
    localRate.set(key, value);
  }
  api.post<{ Params: { id: string } }>(
    `${root}/:id/public-session`,
    external,
    async (req) => {
      await limit(req, "public-session", 20);
      const { channel } = z
        .object({ channel: z.enum(["web", "embed"]).default("web") })
        .parse(req.body ?? {});
      const bot = await db
        .selectFrom("knowledge_assistants")
        .selectAll()
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (
        !bot ||
        !bot.enabled ||
        bot.visibility !== "public" ||
        !knowledgeBotConfig(bot).channels.includes(channel)
      )
        fail(403, "此机器人尚未公开或调用方式已关闭，请登录后访问");
      const owner = await db
        .selectFrom("users")
        .select("id")
        .where("id", "=", bot.owner_id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!owner) fail(403, "机器人不可用");
      const token = "doca_kb_" + randomBytes(32).toString("hex");
      await db
        .deleteFrom("knowledge_bot_keys")
        .where("bot_id", "=", bot.id)
        .where("channel", "like", "public:%")
        .where("expires_at", "<", new Date().toISOString())
        .execute();
      await db
        .insertInto("knowledge_bot_keys")
        .values({
          id: randomUUID(),
          bot_id: bot.id,
          creator_id: bot.owner_id,
          name: "Public session",
          channel: "public:" + channel,
          token_hash: tokenHash(token),
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          created_at: new Date().toISOString(),
        })
        .execute();
      return {
        token,
        title: bot.title,
        activeLibraryCount: (await effectiveKnowledgeBotLibraries(db, bot))
          .length,
        attachmentsEnabled: knowledgeBotConfig(bot).attachmentsEnabled,
      };
    },
  );
  api.get<{ Params: { id: string } }>(
    `${root}/:id/api/conversations`,
    external,
    async (req) => {
      const ctx = await credential(req, req.params.id, "api");
      return {
        items: await db
          .selectFrom("knowledge_conversations")
          .selectAll()
          .where("scope_id", "=", ctx.bot.id)
          .where("access_key_id", "=", ctx.key.id)
          .orderBy("updated_at", "desc")
          .limit(100)
          .execute(),
      };
    },
  );
  api.post<{ Params: { id: string; conversation: string; message: string } }>(
    `${root}/:id/api/conversations/:conversation/messages/:message/feedback`,
    external,
    async (req) => {
      const ctx=await credential(req,req.params.id,"api"),view=await answer(ctx,req.params.conversation);
      if(!view.messages.some(message=>message.id===req.params.message&&message.role==="assistant"))fail(404,"回答不存在");
      const body=z.object({judgment:z.enum(["useful","unhelpful"]).nullable()}).parse(req.body);
      return recordQuestionFeedback(db,ctx.actor,req.params.message,body.judgment);
    },
  );

  api.post<{ Params: { id: string } }>(
    `${root}/:id/api/ask`,
    external,
    async (req) => {
      await limit(req, "ask", 30);
      const ctx = await credential(req, req.params.id, "api"),
        body = z
          .object({
            query: z.string().min(1).max(20000),
            conversationId: z.string().uuid().optional(),
          })
          .parse(req.body);
      return ask(ctx, body.query, body.conversationId);
    },
  );
  api.get<{ Params: { id: string; conversation: string } }>(
    `${root}/:id/api/conversations/:conversation`,
    external,
    async (req) =>
      answer(
        await credential(req, req.params.id, "api"),
        req.params.conversation,
      ),
  );
  api.get<{ Params: { id: string; conversation: string } }>(
    `${root}/:id/api/conversations/:conversation/stream`,
    external,
    async (req, reply) => {
      await answer(
        await credential(req, req.params.id, "api"),
        req.params.conversation,
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      let closed = false,
        last = "";
      reply.raw.on("close", () => {
        closed = true;
      });
      try {
        while (!closed) {
          const value = await answer(
              await credential(req, req.params.id, "api"),
              req.params.conversation,
            ),
            json = JSON.stringify(value);
          if (last !== json) {
            reply.raw.write(`event: update\ndata: ${json}\n\n`);
            last = json;
          }
          if (!["queued", "running"].includes(value.conversation.state)) {
            reply.raw.write("event: done\ndata: {}\n\n");
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch {
        reply.raw.write('event: error\ndata: {"code":"access_revoked"}\n\n');
      } finally {
        reply.raw.end();
      }
    },
  );
  api.post<{ Params: { id: string } }>(
    `${root}/:id/mcp`,
    { ...external, bodyLimit: 100000 },
    async (req, reply) => {
      const ctx = await credential(req, req.params.id, "mcp"),
        server = new McpServer({ name: "doca-knowledge", version: "1.0.0" });
      const wrap =
        (fn: (input: any) => Promise<unknown>) => async (input: any) => {
          try {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(await fn(input)),
                },
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
        { inputSchema: { query: z.string().min(1).max(4000) } },
        wrap(async ({ query }) =>
          studio.searchAnswer(
            (await credential(req, req.params.id, "mcp")).actor,
            ctx.bot.id,
            query,
          ),
        ),
      );
      server.registerTool(
        "knowledge_ask",
        {
          inputSchema: {
            query: z.string().min(1).max(20000),
            conversationId: z.string().uuid().optional(),
          },
        },
        wrap(async ({ query, conversationId }) =>
          ask(
            await credential(req, req.params.id, "mcp"),
            query,
            conversationId,
          ),
        ),
      );
      server.registerTool(
        "knowledge_answer",
        { inputSchema: { conversationId: z.string().uuid() } },
        wrap(async ({ conversationId }) =>
          answer(await credential(req, req.params.id, "mcp"), conversationId),
        ),
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
    },
  );
}
