import { z } from "zod";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { AppError, fail } from "@core/shared/errors.js";
import {
  createKnowledgeBook,
  listKnowledgeBooks,
  bookNow,
  queueBookRun,
} from "@core/modules/knowledge-books/management.js";
import { executeBookCommand } from "@core/modules/knowledge-books/commands.js";
import {
  readPublishedKnowledgeBook,
  readKnowledgeBook,
  readBookRelease,
  readBookRun,
  readBookPipeline,
} from "@core/modules/knowledge-books/reads.js";
import { recoverBookRuns } from "@core/modules/knowledge-books/recovery.js";
import { executeBookRun } from "@core/modules/knowledge-books/engine.js";
import { bookConfigurationSchema } from "@core/modules/knowledge-books/protocol.js";
import { knowledgeBookRuntime } from "../services/ai/knowledge-book-runtime.js";
import {
  bookWebSearchSchema,
  bookWebCheckSchema,
  searchBookWebSources,
  checkBookWebSources,
} from "../services/ai/knowledge-book-web-sources.js";
import {
  listBookHumanTasks,
  resolveBookHumanTask,
} from "@core/modules/knowledge-books/human-tasks.js";
import type { StorageRuntime } from "../adapters/storage.js";

export function registerKnowledgeBooks(
  api: FastifyInstance,
  db: DB,
  auth: (request: FastifyRequest) => Actor,
  storage?: StorageRuntime,
) {
  const viewer = (request: FastifyRequest) => {
    try {
      return auth(request);
    } catch (error) {
      if (error instanceof AppError && error.status === 401) return null;
      throw error;
    }
  };
  const params = Type.Object(
    { id: Type.String({ format: "uuid" }) },
    { additionalProperties: false },
  );
  function webInput<S extends z.ZodType>(
    schema: S,
    body: unknown,
  ): z.output<S> {
    const result = schema.safeParse(body);
    if (!result.success) fail(400, "Invalid knowledge book web source input");
    return result.data;
  }
  api.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/knowledge-books/:id/source-search",
    {
      schema: {
        params,
        body: Type.Object(
          {
            query: Type.String({ minLength: 1, maxLength: 200 }),
            sites: Type.String({ maxLength: 300 }),
            language: Type.Union([Type.Literal("zh"), Type.Literal("en")]),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) =>
      searchBookWebSources(
        db,
        auth(request),
        request.params.id,
        webInput(bookWebSearchSchema, request.body),
      ),
  );
  api.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/knowledge-books/:id/source-web-check",
    {
      schema: {
        params,
        body: Type.Object(
          {
            urls: Type.Array(Type.String({ format: "uri", maxLength: 4000 }), {
              minItems: 1,
              maxItems: 50,
            }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) =>
      checkBookWebSources(
        db,
        auth(request),
        request.params.id,
        webInput(bookWebCheckSchema, request.body),
        knowledgeBookRuntime(
          db,
          auth(request).id,
          "source-validation",
          "",
          storage,
        ),
      ),
  );
  api.get<{
    Querystring: {
      bookId?: string;
      nodeId?: string;
      runId?: string;
      query?: string;
      kind?: "review" | "publication" | "repair";
      status?: "pending" | "resolved" | "cancelled" | "superseded";
      offset?: number;
    };
  }>(
    "/api/v1/knowledge-books/human-tasks",
    {
      schema: {
        querystring: Type.Object(
          {
            bookId: Type.Optional(Type.String({ format: "uuid" })),
            nodeId: Type.Optional(Type.String({ maxLength: 100 })),
            runId: Type.Optional(Type.String({ format: "uuid" })),
            query: Type.Optional(Type.String({ maxLength: 200 })),
            kind: Type.Optional(
              Type.Union([
                Type.Literal("review"),
                Type.Literal("publication"),
                Type.Literal("repair"),
              ]),
            ),
            status: Type.Optional(
              Type.Union([
                Type.Literal("pending"),
                Type.Literal("resolved"),
                Type.Literal("cancelled"),
                Type.Literal("superseded"),
              ]),
            ),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request) => listBookHumanTasks(db, auth(request), request.query),
  );
  api.post<{
    Params: { id: string };
    Body: {
      expectedRevision: number;
      decision: "approve" | "reject" | "retry" | "resume";
      note: string;
    };
  }>(
    "/api/v1/knowledge-books/human-tasks/:id/resolve",
    {
      schema: {
        params,
        body: Type.Object(
          {
            expectedRevision: Type.Integer({ minimum: 1 }),
            decision: Type.Union([
              Type.Literal("approve"),
              Type.Literal("reject"),
              Type.Literal("retry"),
              Type.Literal("resume"),
            ]),
            note: Type.String({ maxLength: 20000 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request) =>
      resolveBookHumanTask(
        db,
        auth(request),
        request.params.id,
        request.body,
        knowledgeBookRuntime(
          db,
          auth(request).id,
          "source-validation",
          "",
          storage,
        ),
      ),
  );
  api.get<{ Querystring: { offset?: number } }>(
    "/api/v1/knowledge-books",
    {
      schema: {
        querystring: Type.Object(
          { offset: Type.Optional(Type.Integer({ minimum: 0 })) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => ({
      items: await listKnowledgeBooks(
        db,
        auth(request),
        request.query.offset ?? 0,
      ),
    }),
  );
  api.post<{ Body: { title: string } }>(
    "/api/v1/knowledge-books",
    {
      schema: {
        body: Type.Object(
          { title: Type.String({ minLength: 1, maxLength: 160 }) },
          { additionalProperties: false },
        ),
      },
    },
    (request) => createKnowledgeBook(db, auth(request), request.body.title),
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/knowledge-books/:id",
    { schema: { params } },
    (request) => {
      const actor = viewer(request);
      return actor
        ? readKnowledgeBook(db, actor, request.params.id)
        : readPublishedKnowledgeBook(db, request.params.id);
    },
  );
  api.post<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/knowledge-books/:id/commands",
    {
      schema: {
        params,
        body: Type.Object(
          { operation: Type.String() },
          { additionalProperties: true },
        ),
      },
    },
    async (request) => {
      try {
        return await executeBookCommand(
          db,
          auth(request),
          request.params.id,
          request.body,
          "manual",
          knowledgeBookRuntime(
            db,
            auth(request).id,
            "source-validation",
            "",
            storage,
          ),
        );
      } catch (error) {
        if (error instanceof z.ZodError)
          fail(
            400,
            "Invalid knowledge book command: " +
              error.issues.map((issue) => issue.message).join("; "),
          );
        throw error;
      }
    },
  );
  const scoped = Type.Object(
    {
      id: Type.String({ format: "uuid" }),
      targetId: Type.String({ format: "uuid" }),
    },
    { additionalProperties: false },
  );
  api.get<{ Params: { id: string; targetId: string } }>(
    "/api/v1/knowledge-books/:id/releases/:targetId",
    { schema: { params: scoped } },
    (request) =>
      readBookRelease(
        db,
        viewer(request),
        request.params.id,
        request.params.targetId,
      ),
  );
  api.get<{ Params: { id: string; targetId: string } }>(
    "/api/v1/knowledge-books/:id/runs/:targetId",
    { schema: { params: scoped } },
    (request) =>
      readBookRun(
        db,
        auth(request),
        request.params.id,
        request.params.targetId,
      ),
  );
  api.get<{ Params: { id: string; targetId: string } }>(
    "/api/v1/knowledge-books/:id/runs/:targetId/pipeline",
    { schema: { params: scoped } },
    (request) => readBookPipeline(db, auth(request), request.params.id, request.params.targetId),
  );
  let stopped = false,
    processing: Promise<void> | null = null,
    lastSchedule = 0;
  async function drain() {
    if (stopped || processing) return;
    processing = (async () => {
      const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
      await recoverBookRuns(db, cutoff);
      const next = await db
        .selectFrom("knowledge_book_runs")
        .select(["id", "actor_id", "configuration"])
        .where("status", "in", ["queued", "queued_publish", "queued_resume"])
        .orderBy("created_at")
        .executeTakeFirst();
      if (next) {
        const configuration = bookConfigurationSchema.parse(
          JSON.parse(next.configuration),
        );
        await executeBookRun(
          db,
          next.id,
          knowledgeBookRuntime(
            db,
            next.actor_id,
            next.id,
            configuration.modelId,
            storage,
          ),
        );
      }
      if (Date.now() - lastSchedule < 60000) return;
      lastSchedule = Date.now();
      const books = await db
        .selectFrom("knowledge_books as b")
        .innerJoin("resources as r", "r.id", "b.id")
        .select(["b.id", "b.configuration", "r.owner_id"])
        .where("r.deleted_at", "is", null)
        .execute();
      for (const book of books) {
        const config = bookConfigurationSchema.parse(
          JSON.parse(book.configuration),
        );
        if (config.schedule === "off") continue;
        const now = new Date(),
          period =
            config.schedule === "daily"
              ? now.toISOString().slice(0, 10)
              : String(
                  Math.floor(
                    (now.getTime() - Date.UTC(1970, 0, 5)) / (7 * 86400000),
                  ),
                );
        const actor = await db
          .selectFrom("users")
          .select(["id", "display_name", "admin"])
          .where("id", "=", book.owner_id)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (actor)
          try {
            await queueBookRun(
              db,
              actor,
              book.id,
              `${config.schedule}:${period}`,
            );
          } catch (error) {
            api.log.warn(
              {
                bookId: book.id,
                error:
                  error instanceof Error ? error.message : "Schedule failed",
              },
              "Knowledge book schedule did not queue",
            );
          }
      }
    })()
      .catch((error) =>
        api.log.error(
          { error: error instanceof Error ? error.message : "Worker failed" },
          "Knowledge book worker failed",
        ),
      )
      .finally(() => {
        processing = null;
      });
  }
  const timer = setInterval(() => void drain(), 1000);
  timer.unref();
  api.addHook("preClose", async () => {
    stopped = true;
    clearInterval(timer);
    if (processing) await processing;
  });
}
