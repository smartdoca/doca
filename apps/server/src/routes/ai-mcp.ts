import { searchKnowledge } from "../services/ai/knowledge-search.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
import { tokenHash } from "@core/modules/identity/passwords.js";
import { requireCapability } from "@core/modules/access/operation-policy.js";
import {
  createToolCall,
  type AIContributionHost,
  type ToolOutcome,
} from "@doca/ai-host";
import type { AIContributionExecutionContext } from "../services/ai/runner.js";
import {
  checkScope,
  createAIDocument,
  digest,
  editAIDocument,
  readAIDocument,
  type ToolContext,
} from "@core/workflows/ai-documents.js";
export async function registerAIMcp(
  api: FastifyInstance,
  db: DB,
  notify?: (id: string) => Promise<void>,
  search?: (actor: any, query: any) => Promise<any>,
  contributions?: AIContributionHost<AIContributionExecutionContext>,
) {
  api.post("/api/v1/mcp", { bodyLimit: 300000 }, async (req, reply) => {
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
      .selectAll()
      .where("id", "=", key.user_id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!actor) fail(401, "账号不可用");
    const ctx: ToolContext = {
      actor,
      allowedResources: JSON.parse(key.resource_ids),
      writable: !!key.writable,
      notify,
    };
    const server = new McpServer({ name: "doca", version: "1.0.0" });
    const wrap =
      (fn: (input: any) => Promise<unknown>) => async (input: any) => {
        try {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(await fn(input)) },
            ],
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: (e as any)?.status ? (e as Error).message : "操作未完成",
              },
            ],
          };
        }
      };
    const contributedSessionId = `mcp:${key.id}`;
    const contributedTurnId = randomUUID();
    const contributedController = new AbortController();
    const contributedContext: AIContributionExecutionContext = {
      db,
      actor,
      jobId: contributedTurnId,
      sessionId: contributedSessionId,
    };
    const contributedPipeline =
      contributions?.createToolPipeline(contributedContext);
    let contributedOrdinal = 0;
    const unwrapOutcome = (outcome: ToolOutcome) => {
      if (outcome.status === "success") return outcome.value;
      if (outcome.status === "denied") throw new Error(outcome.reason);
      if (outcome.status === "cancelled")
        throw new DOMException(outcome.reason, "AbortError");
      throw new Error(outcome.error.message);
    };
    for (const tool of contributions?.snapshot().tools ?? []) {
      if (tool.exposure && !tool.exposure.includes("mcp")) continue;
      server.registerTool(
        tool.id,
        {
          description: tool.description ?? tool.id,
          inputSchema: {
            input: z.record(z.string(), z.unknown()).default({}),
          },
        },
        wrap(async ({ input }) => {
          const call = createToolCall({
            sessionId: contributedSessionId,
            turnId: contributedTurnId,
            toolId: tool.id,
            ordinal: contributedOrdinal++,
            input,
          });
          const result = await contributedPipeline!.execute({
            sessionId: contributedSessionId,
            turnId: contributedTurnId,
            call,
            signal: contributedController.signal,
          });
          return unwrapOutcome(result.outcome);
        }),
      );
    }
    server.registerTool(
      "knowledge_search",
      {
        description:
          "检索授权文档，默认 auto 优先语义搜索；keyword 按关键词，ai 按文档描述。返回正文片段、来源与分页，完整内容请调用 document_get。",
        inputSchema: {
          query: z.string().min(1).max(500),
          mode: z.enum(["auto", "keyword", "ai"]).default("auto"),
          libraryId: z.string().uuid().optional(),
          offset: z.number().int().min(0).max(100000).default(0),
        },
      },
      wrap((input) => searchKnowledge(db, ctx, input, search)),
    );
    server.registerTool(
      "document_get",
      {
        description: "分页读取原生文档JSON及版本，offset是字符偏移。",
        inputSchema: {
          resourceId: z.string().uuid(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(100).max(30000).default(16000),
        },
      },
      wrap(async ({ resourceId, offset, limit }) => {
        const r = await readAIDocument(db, ctx, resourceId);
        const text = JSON.stringify(r.value);
        const { value: _native, ...metadata } = r;
        return {
          ...metadata,
          content: text.slice(offset, offset + limit),
          nextOffset: offset + limit < text.length ? offset + limit : null,
        };
      }),
    );
    if (key.writable) {
      server.registerTool(
        "document_create",
        {
          description:
            "在授权知识库创建一篇Markdown文档。同一requestId重试不会重复创建。",
          inputSchema: {
            requestId: z.string().uuid(),
            libraryId: z.string().uuid(),
            parentId: z.string().uuid().optional(),
            title: z.string().min(1).max(160),
            body: z.string().max(200000),
          },
        },
        wrap(async ({ requestId, libraryId, parentId, title, body }) => {
          await requireCapability(db, actor.id, "mcp.write");
          return createAIDocument(
            db,
            ctx,
            {
              kind: "document",
              format: "markdown",
              title,
              libraryId,
              parentId,
              markdown: body,
            },
            digest({ key: key.id, requestId }).slice(0, 36),
          );
        }),
      );
      server.registerTool(
        "document_append",
        {
          description:
            "向已有Markdown或富文本文档追加正文。提供读取时的seq和epochId。",
          inputSchema: {
            requestId: z.string().uuid(),
            resourceId: z.string().uuid(),
            seq: z.number().int().min(0),
            epochId: z.string(),
            text: z.string().max(100000),
          },
        },
        wrap(async ({ requestId, resourceId, seq, epochId, text }) => {
          await requireCapability(db, actor.id, "mcp.write");
          const { resource } = await checkScope(db, ctx, resourceId, true);
          if (!["markdown", "rich_text"].includes(resource.format))
            fail(400, "仅支持富文本和Markdown追加");
          return editAIDocument(
            db,
            ctx,
            resourceId,
            { seq, epochId },
            [{ type: "append", text }],
            digest({ key: key.id, requestId, tool: "append" }).slice(0, 36),
          );
        }),
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    try {
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } finally {
      await transport.close();
      await server.close();
    }
  });
}
