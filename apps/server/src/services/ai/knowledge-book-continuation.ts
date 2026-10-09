import type { DB } from "@db/index.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import { bookAccess } from "@core/modules/knowledge-books/management.js";
import { readRunForAssistant } from "@core/modules/knowledge-books/assistant-reads.js";
import type { AIContinuationSource } from "@smartdoca/plugin-sdk/ai";
import type { Actor } from "@core/modules/identity/passwords.js";
import { transact } from "@db/transactions.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { fail } from "@core/shared/errors.js";
import { z } from "zod";
export const BOOK_CONTINUATION_SOURCE = "doca.ai.knowledge-book";
export const bookContinuationInput = (bookId: string, runId: string) => ({
  sourceId: BOOK_CONTINUATION_SOURCE,
  operationId: `${bookId}/${runId}`,
});

const runReceiptSchema = z
  .object({
    kind: z.literal("knowledge_book_run"),
    version: z.literal(1),
    bookId: z.string(),
    result: z.json(),
  })
  .strict();
/** Commit a new run action and its receipt together, so a checkpoint replay cannot create a second run. */
export async function persistBookRunAction<T>(
  db: DB,
  actor: Actor,
  bookId: string,
  input: { id: string; jobId: string; digest: string },
  execute: (tx: DB, current: Actor) => Promise<T>,
): Promise<T> {
  return transact(db, async (tx) => {
    await lockAIUser(tx, actor.id);
    const current = await tx
      .selectFrom("users")
      .selectAll()
      .where("id", "=", actor.id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!current) fail(403, "Continuation owner is unavailable");
    await bookAccess(tx, current, bookId, 3);
    const previous = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (previous) {
      if (previous.user_id !== current.id || previous.digest !== input.digest)
        fail(409, "Book run operation receipt changed");
      const receipt = runReceiptSchema.parse(JSON.parse(previous.result));
      if (receipt.bookId !== bookId)
        fail(409, "Book run receipt belongs to another book");
      return receipt.result as T;
    }
    const result = await execute(tx, current);
    const receipt = runReceiptSchema.parse({
      kind: "knowledge_book_run",
      version: 1,
      bookId,
      result,
    });
    await tx
      .insertInto("ai_operations")
      .values({
        id: input.id,
        user_id: current.id,
        job_id: input.jobId,
        digest: input.digest,
        result: JSON.stringify(receipt),
        created_at: new Date().toISOString(),
      })
      .execute();
    return result;
  });
}
export function registerKnowledgeBookContinuation(db: DB) {
  const registry = pluginServices(db).continuations;
  const source: AIContinuationSource = {
    id: BOOK_CONTINUATION_SOURCE,
    pluginId: "doca.ai",
    async read(context, { operationId }) {
      const ids = operationId.split("/");
      if (ids.length !== 2 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))
        return null;
      const [bookId, runId] = ids as [string, string];
      const actor = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", context.principal.id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!actor) return null;
      await bookAccess(db, actor, bookId, 3);
      const run = await readRunForAssistant(db, actor, bookId, runId);
      if (run.restricted) return null;
      const state = [
        "queued",
        "queued_resume",
        "queued_publish",
        "running",
      ].includes(run.status)
        ? "running"
        : ["awaiting_input", "awaiting_publication"].includes(run.status)
          ? "waiting_input"
          : run.status === "published"
            ? "completed"
            : run.status === "cancelled"
              ? "cancelled"
              : "failed";
      return {
        version: 1,
        state,
        revision: `${run.status}:${run.updatedAt}`,
        summary: run.status,
        result: {
          bookId,
          runId,
          status: run.status,
          error: run.error,
          nodes: run.nodes.map((node) => ({
            nodeId: node.nodeId,
            type: node.type,
            status: node.status,
            error: node.error,
          })),
        },
      };
    },
  };
  if (registry.has(source.id))
    throw new Error("Duplicate knowledge-book continuation source");
  registry.set(source.id, source);
  return () => {
    if (registry.get(source.id) === source) registry.delete(source.id);
  };
}
