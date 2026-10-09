import { prepareRunReuse, retryBookRun } from "./retry.js";
import { transact } from "@db/transactions.js";
import type { BookSourceRuntime } from "./sources.js";
import type { BookFeedbackMethod } from "./feedback-origin.js";
import { z } from "zod";
import { bookFail as fail } from "./errors.js";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import {
  bookNodeSchema,
  bookConfigurationSchema,
  bookSourceInputSchema,
  bookFeedbackInputSchema,
} from "./protocol.js";
import {
  bookAccess,
  saveBookConfiguration,
  saveBookSource,
  saveBookFeedback,
  queueBookRun,
  changeBookRun,
} from "./management.js";
import { validateBookSource, validateBookSourceForSave } from "./sources.js";

const revision = z.number().int().min(0);
export const bookCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("workflow.node.add"),
      expectedRevision: revision,
      node: bookNodeSchema,
      inputs: z.array(bookNodeSchema.shape.id).max(40),
      outputs: z.array(bookNodeSchema.shape.id).max(40),
    })
    .strict(),
  z
    .object({ operation: z.literal("run.retry"), runId: z.string().uuid() })
    .strict(),
  z
    .object({
      operation: z.literal("feedback.withdraw"),
      id: z.string().uuid(),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      operation: z.literal("source.remove"),
      id: z.string().uuid(),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      operation: z.literal("configuration.patch"),
      expectedRevision: revision,
      changes: z
        .object({
          goal: bookConfigurationSchema.shape.goal.optional(),
          modelId: bookConfigurationSchema.shape.modelId.optional(),
          criteria: bookConfigurationSchema.shape.criteria.optional(),
          maxDocumentDepth:
            bookConfigurationSchema.shape.maxDocumentDepth.optional(),
          schedule: bookConfigurationSchema.shape.schedule.optional(),
          autoPublish: bookConfigurationSchema.shape.autoPublish.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("workflow.node.patch"),
      expectedRevision: revision,
      nodeId: bookNodeSchema.shape.id,
      changes: z
        .object({
          label: bookNodeSchema.shape.label.optional(),
          position: bookNodeSchema.shape.position.optional(),
          parameters: bookNodeSchema.shape.parameters.partial().optional(),
          inputs: z.array(bookNodeSchema.shape.id).max(40).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("configuration.save"),
      expectedRevision: revision,
      configuration: bookConfigurationSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("source.save"),
      id: z.string().uuid().optional(),
      expectedRevision: revision,
      title: z.string().trim().min(1).max(200),
      configuration: bookSourceInputSchema,
      status: z.enum(["active", "paused", "removed"]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("feedback.save"),
      id: z.string().uuid().optional(),
      expectedRevision: revision,
      detail: bookFeedbackInputSchema,
      status: z.enum(["active", "withdrawn"]),
    })
    .strict(),
  z.object({ operation: z.literal("run.start") }).strict(),
  z
    .object({ operation: z.literal("run.cancel"), runId: z.string().uuid() })
    .strict(),
  z
    .object({ operation: z.literal("run.publish"), runId: z.string().uuid() })
    .strict(),
]);
/** UI and personal AI use these exact commands, authorization and revision checks. */
export async function executeBookCommand(
  db: DB,
  actor: Actor,
  id: string,
  raw: unknown,
  method: BookFeedbackMethod = "manual",
  runtime?: BookSourceRuntime,
) {
  const command = bookCommandSchema.parse(raw);
  switch (command.operation) {
    case "run.retry": {
      await bookAccess(db, actor, id, 3);
      const prior = await db
        .selectFrom("knowledge_book_runs")
        .select("status")
        .where("id", "=", command.runId)
        .where("book_id", "=", id)
        .executeTakeFirst();
      if (!prior || !["failed", "cancelled"].includes(prior.status))
        fail(409, "Only a failed or cancelled run can be retried");
      const verified = await prepareRunReuse(
        db,
        actor,
        id,
        command.runId,
        runtime,
      );
      return transact(db, (tx) =>
        retryBookRun(tx, actor, id, command.runId, verified),
      );
    }
    case "feedback.withdraw": {
      await bookAccess(db, actor, id, 2);
      const row = await db
        .selectFrom("knowledge_book_feedback")
        .selectAll()
        .where("id", "=", command.id)
        .where("book_id", "=", id)
        .executeTakeFirst();
      if (!row) fail(404, "Knowledge book feedback not found");
      return saveBookFeedback(
        db,
        actor,
        id,
        {
          id: row.id,
          expectedRevision: command.expectedRevision,
          detail: JSON.parse(row.detail),
          status: "withdrawn",
        },
        method,
      );
    }
    case "source.remove": {
      await bookAccess(db, actor, id, 3);
      const row = await db
        .selectFrom("knowledge_book_sources")
        .selectAll()
        .where("id", "=", command.id)
        .where("book_id", "=", id)
        .executeTakeFirst();
      if (!row) fail(404, "Knowledge book source not found");
      return saveBookSource(
        db,
        actor,
        id,
        {
          id: row.id,
          expectedRevision: command.expectedRevision,
          title: row.title,
          configuration: JSON.parse(row.configuration),
          status: "removed",
        },
        validateBookSource,
      );
    }
    case "workflow.node.add": {
      const { book } = await bookAccess(db, actor, id, 3),
        current = bookConfigurationSchema.parse(JSON.parse(book.configuration));
      if (current.workflow.nodes.some((node) => node.id === command.node.id))
        fail(409, "Workflow node already exists");
      current.workflow.nodes.push(command.node);
      current.workflow.edges.push(
        ...command.inputs.map((source) => ({
          source,
          target: command.node.id,
        })),
        ...command.outputs.map((target) => ({
          source: command.node.id,
          target,
        })),
      );
      return saveBookConfiguration(
        db,
        actor,
        id,
        command.expectedRevision,
        current,
      );
    }
    case "configuration.patch": {
      const { book } = await bookAccess(db, actor, id, 3);
      const current = bookConfigurationSchema.parse(
        JSON.parse(book.configuration),
      );
      return saveBookConfiguration(db, actor, id, command.expectedRevision, {
        ...current,
        ...command.changes,
      });
    }
    case "workflow.node.patch": {
      const { book } = await bookAccess(db, actor, id, 3);
      const current = bookConfigurationSchema.parse(
        JSON.parse(book.configuration),
      );
      if (!current.workflow.nodes.some((node) => node.id === command.nodeId))
        fail(404, "Workflow node not found");
      const { parameters, inputs, ...changes } = command.changes;
      current.workflow.nodes = current.workflow.nodes.map((node) =>
        node.id === command.nodeId
          ? {
              ...node,
              ...changes,
              parameters: { ...node.parameters, ...parameters },
            }
          : node,
      );
      if (inputs)
        current.workflow.edges = [
          ...current.workflow.edges.filter(
            (edge) => edge.target !== command.nodeId,
          ),
          ...inputs.map((source) => ({ source, target: command.nodeId })),
        ];
      return saveBookConfiguration(
        db,
        actor,
        id,
        command.expectedRevision,
        current,
      );
    }
    case "configuration.save":
      return saveBookConfiguration(
        db,
        actor,
        id,
        command.expectedRevision,
        command.configuration,
      );
    case "source.save":
      return saveBookSource(
        db,
        actor,
        id,
        command,
        (db, actor, configuration) =>
          command.status === "paused"
            ? validateBookSource(db, actor, configuration)
            : validateBookSourceForSave(db, actor, configuration, runtime),
      );
    case "feedback.save":
      return saveBookFeedback(db, actor, id, command, method);
    case "run.start":
      return queueBookRun(db, actor, id);
    case "run.cancel":
      return changeBookRun(db, actor, id, command.runId, "cancel");
    case "run.publish":
      return changeBookRun(db, actor, id, command.runId, "publish");
  }
}
