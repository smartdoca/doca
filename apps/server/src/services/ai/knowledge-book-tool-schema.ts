import { z } from "zod";
import { bookCommandSchema } from "@core/modules/knowledge-books/commands.js";
import {
  bookNodeSchema,
  bookConfigurationSchema,
  bookSourceInputSchema,
  bookFeedbackInputSchema,
} from "@core/modules/knowledge-books/protocol.js";
import {
  bookWebSearchSchema,
  bookWebCheckSchema,
} from "./knowledge-book-web-sources.js";

/** Exact execution contract; every action and command is validated before dispatch. */
export const bookAssistantActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      title: z.string().trim().min(1).max(160),
    })
    .strict(),
  z.object({ action: z.literal("read"), bookId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("command"),
      bookId: z.string().uuid(),
      command: bookCommandSchema,
    })
    .strict(),
  bookWebSearchSchema
    .extend({ action: z.literal("search_sources"), bookId: z.string().uuid() })
    .strict(),
  bookWebCheckSchema
    .extend({
      action: z.literal("check_web_sources"),
      bookId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("run"),
      bookId: z.string().uuid(),
      runId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("release"),
      bookId: z.string().uuid(),
      releaseId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("source"),
      bookId: z.string().uuid(),
      sourceId: z.string().uuid(),
      bindingId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,100}$/)
        .optional(),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("candidate_page"),
      bookId: z.string().uuid(),
      runId: z.string().uuid(),
      nodeId: z.string(),
      pageId: z.string(),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("page"),
      bookId: z.string().uuid(),
      releaseId: z.string().uuid(),
      pageId: z.string(),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("find"),
      bookId: z.string().uuid(),
      releaseId: z.string().uuid(),
      query: z.string().trim().min(1).max(200),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("human_tasks"),
      bookId: z.string().uuid().optional(),
      nodeId: z.string().max(100).optional(),
      runId: z.string().uuid().optional(),
      query: z.string().max(200).optional(),
      kind: z.enum(["review", "publication", "repair"]).optional(),
      status: z
        .enum(["pending", "resolved", "cancelled", "superseded"])
        .optional(),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve_task"),
      bookId: z.string().uuid(),
      taskId: z.string().uuid(),
      expectedRevision: z.number().int().min(1),
      decision: z.enum(["approve", "reject", "retry"]),
      note: z.string().max(20000),
    })
    .strict(),
]);

/** A declared root object exposes parameter types to tool servers; no string decoding or adapter. */
export const bookAssistantInputSchema = z
  .object({
    action: z.enum([
      "list",
      "create",
      "read",
      "command",
      "search_sources",
      "check_web_sources",
      "run",
      "release",
      "source",
      "candidate_page",
      "page",
      "find",
      "human_tasks",
      "resolve_task",
    ]),
    bookId: z.string().uuid().optional(),
    title: z.string().max(160).optional(),
    command: z
      .object({
        operation: z.enum([
          "workflow.node.add",
          "run.retry",
          "feedback.withdraw",
          "source.remove",
          "configuration.patch",
          "workflow.node.patch",
          "configuration.save",
          "source.save",
          "feedback.save",
          "run.start",
          "run.cancel",
          "run.publish",
        ]),
        id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Existing source or feedback ID, only for editing. Omit this field when creating a source or feedback. Never use bookId as command.id.",
          ),
        expectedRevision: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Use 0 when creating a source or feedback; for editing use that entity's current revision.",
          ),
        title: z.string().max(200).optional(),
        status: z
          .enum(["active", "paused", "removed", "withdrawn"])
          .optional()
          .describe(
            "Required for source.save (active/paused/removed) and feedback.save (active/withdrawn).",
          ),
        configuration: z
          .union([bookSourceInputSchema, bookConfigurationSchema])
          .optional(),
        detail: bookFeedbackInputSchema.optional(),
        changes: z
          .object({
            goal: z.string().optional(),
            modelId: z.string().optional(),
            criteria: bookConfigurationSchema.shape.criteria.optional(),
            maxDocumentDepth: z.number().optional(),
            schedule: z.enum(["off", "daily", "weekly"]).optional(),
            autoPublish: z.boolean().optional(),
            label: z.string().optional(),
            position: bookNodeSchema.shape.position.optional(),
            parameters: bookNodeSchema.shape.parameters.partial().optional(),
            inputs: z.array(bookNodeSchema.shape.id).optional(),
          })
          .strict()
          .optional(),
        node: bookNodeSchema.optional(),
        nodeId: bookNodeSchema.shape.id.optional(),
        inputs: z.array(bookNodeSchema.shape.id).optional(),
        outputs: z.array(bookNodeSchema.shape.id).optional(),
        runId: z.string().uuid().optional(),
      })
      .strict()
      .optional()
      .describe(
        "The actual command JSON object, never an encoded JSON string. For a new feedback use operation=feedback.save, expectedRevision=0, status=active, detail={kind,content,releaseId,pageId,paragraphId}, and omit id.",
      ),
    query: z.string().max(200).optional(),
    sites: z.string().max(300).optional(),
    language: z.enum(["zh", "en"]).optional(),
    urls: bookWebCheckSchema.shape.urls.optional(),
    runId: z.string().uuid().optional(),
    releaseId: z.string().uuid().optional(),
    sourceId: z.string().uuid().optional(),
    bindingId: z.string().max(100).optional(),
    nodeId: z.string().max(100).optional(),
    pageId: z.string().optional(),
    offset: z.number().int().min(0).optional(),
    kind: z.enum(["review", "publication", "repair"]).optional(),
    status: z
      .enum(["pending", "resolved", "cancelled", "superseded"])
      .optional(),
    taskId: z.string().uuid().optional(),
    expectedRevision: z.number().int().min(1).optional(),
    decision: z.enum(["approve", "reject", "retry"]).optional(),
    note: z.string().max(20000).optional(),
  })
  .strict();
