import { prepareRunReuse, retryBookRun } from "./retry.js";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { roleQuery } from "../access/queries.js";
import { bookFail as fail } from "./errors.js";
import { bookAccess, bookInputSnapshot, bookNow } from "./management.js";
import { type BookSourceRuntime, canReadBookEvidence } from "./sources.js";
import { bookConfigurationSchema, type Evidence } from "./protocol.js";

export async function listBookHumanTasks(
  db: DB,
  actor: Actor,
  input: {
    bookId?: string;
    nodeId?: string;
    runId?: string;
    query?: string;
    kind?: "review" | "publication" | "repair";
    status?: "pending" | "resolved" | "cancelled" | "superseded";
    offset?: number;
  },
) {
  let query = db
    .selectFrom("knowledge_book_human_tasks as task")
    .innerJoin("resources as r", "r.id", "task.book_id")
    .select([
      "task.id",
      "task.book_id",
      "task.run_id",
      "task.node_id",
      "task.kind",
      "task.title",
      "task.status",
      "task.revision",
      "task.resolution",
      "task.created_at",
      "task.updated_at",
      "r.title as book_title",
    ])
    .where("r.deleted_at", "is", null)
    .where(roleQuery(sql.ref("r.id"), actor), ">=", 3);
  if (input.bookId) query = query.where("task.book_id", "=", input.bookId);
  if (input.nodeId) query = query.where("task.node_id", "=", input.nodeId);
  if (input.runId) query = query.where("task.run_id", "=", input.runId);
  if (input.query)
    query = query.where((eb) =>
      eb.or([
        eb("task.title", "like", `%${input.query}%`),
        eb("r.title", "like", `%${input.query}%`),
        eb("task.node_id", "like", `%${input.query}%`),
      ]),
    );
  if (input.kind) query = query.where("task.kind", "=", input.kind);
  if (input.status) query = query.where("task.status", "=", input.status);
  const rows = await query
    .orderBy("task.created_at", "desc")
    .orderBy("task.id")
    .limit(50)
    .offset(input.offset ?? 0)
    .execute();
  const items = [];
  for (const row of rows) {
    const run = await db
      .selectFrom("knowledge_book_runs")
      .select([
        "configuration_revision",
        "configuration",
        "input_hash",
        "status",
        "error",
      ])
      .where("id", "=", row.run_id)
      .executeTakeFirstOrThrow();
    const { book } = await bookAccess(db, actor, row.book_id, 3);
    const inputSnapshot = await bookInputSnapshot(db, row.book_id);
    const node = await db
      .selectFrom("knowledge_book_node_runs")
      .select(["output", "error"])
      .where("run_id", "=", row.run_id)
      .where("node_id", "=", row.node_id)
      .executeTakeFirst();
    let readable = true;
    const output = node?.output ? JSON.parse(node.output) : null;
    for (const evidence of (output?.evidence ?? []) as Evidence[])
      if (!(await canReadBookEvidence(db, actor, evidence))) readable = false;
    const configuration = bookConfigurationSchema.parse(
        JSON.parse(run.configuration),
      ),
      definition = configuration.workflow.nodes.find(
        (node) => node.id === row.node_id,
      )!;
    items.push({
      ...row,
      nodeLabel: definition.label,
      nodeType: definition.type,
      criteria: configuration.criteria,
      instructions: definition.parameters.instructions,
      resolution: row.resolution ? JSON.parse(row.resolution) : null,
      stale:
        book.revision !== run.configuration_revision ||
        inputSnapshot.hash !== run.input_hash,
      readable,
      output: readable ? output : null,
      error: node?.error || run.error,
    });
  }
  return {
    items,
    nextOffset: rows.length === 50 ? (input.offset ?? 0) + 50 : null,
  };
}
export async function resolveBookHumanTask(
  db: DB,
  actor: Actor,
  id: string,
  input: {
    expectedRevision: number;
    decision: "approve" | "reject" | "retry";
    note: string;
  },
  runtime?: BookSourceRuntime,
) {
  const task = await db
    .selectFrom("knowledge_book_human_tasks")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!task) fail(404, "Human intervention task not found");
  await bookAccess(db, actor, task.book_id, 3);
  const node = await db
    .selectFrom("knowledge_book_node_runs")
    .select("output")
    .where("run_id", "=", task.run_id)
    .where("node_id", "=", task.node_id)
    .executeTakeFirst();
  for (const evidence of (input.decision === "approve" && node?.output
    ? (JSON.parse(node.output).evidence ?? [])
    : []) as Evidence[])
    if (!(await canReadBookEvidence(db, actor, evidence)))
      fail(403, "Original evidence access is required to resolve this task");
  const verified =
    input.decision === "retry"
      ? await prepareRunReuse(db, actor, task.book_id, task.run_id, runtime)
      : new Set<string>();
  return transact(db, async (tx) => {
    const { book } = await bookAccess(tx, actor, task.book_id, 3);
    const current = await tx
      .selectFrom("knowledge_book_human_tasks")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    if (
      current.revision !== input.expectedRevision ||
      current.status !== "pending"
    )
      fail(409, "Human intervention task changed");
    const run = await tx
      .selectFrom("knowledge_book_runs")
      .selectAll()
      .where("id", "=", task.run_id)
      .executeTakeFirstOrThrow();
    if (input.decision === "approve") {
      if (
        book.revision !== run.configuration_revision ||
        (await bookInputSnapshot(tx, task.book_id)).hash !== run.input_hash
      )
        fail(
          409,
          "Task inputs changed; update the workflow and start a new run",
        );
      if (task.kind === "review" && run.status === "awaiting_input") {
        await tx
          .updateTable("knowledge_book_node_runs")
          .set({ status: "completed", completed_at: bookNow() })
          .where("run_id", "=", task.run_id)
          .where("node_id", "=", task.node_id)
          .where("status", "=", "awaiting_input")
          .execute();
        await tx
          .updateTable("knowledge_book_runs")
          .set({
            status: "queued_resume",
            actor_id: actor.id,
            updated_at: bookNow(),
          })
          .where("id", "=", task.run_id)
          .where("status", "=", "awaiting_input")
          .execute();
      } else if (
        task.kind === "publication" &&
        run.status === "awaiting_publication"
      ) {
        await tx
          .updateTable("knowledge_book_runs")
          .set({
            status: "queued_publish",
            actor_id: actor.id,
            updated_at: bookNow(),
          })
          .where("id", "=", task.run_id)
          .where("status", "=", "awaiting_publication")
          .execute();
      } else fail(409, "This task cannot be approved in its current state");
    } else {
      await tx
        .updateTable("knowledge_book_runs")
        .set({ status: "cancelled", lease_id: null, updated_at: bookNow() })
        .where("id", "=", task.run_id)
        .where("status", "in", [
          "queued",
          "running",
          "awaiting_input",
          "queued_resume",
          "awaiting_publication",
          "queued_publish",
        ])
        .execute();
    }
    const resolution = JSON.stringify({
      decision: input.decision,
      note: input.note,
      actorId: actor.id,
      createdAt: bookNow(),
    });
    const changed = await tx
      .updateTable("knowledge_book_human_tasks")
      .set({
        status: "resolved",
        revision: current.revision + 1,
        resolution,
        updated_at: bookNow(),
      })
      .where("id", "=", id)
      .where("revision", "=", input.expectedRevision)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (!Number(changed.numUpdatedRows))
      fail(409, "Human intervention task changed");
    await tx
      .insertInto("audit_events")
      .values({
        id: randomUUID(),
        actor_id: actor.id,
        resource_id: task.book_id,
        action: "knowledge_book.human_task_resolved",
        created_at: bookNow(),
      })
      .execute();
    if (input.decision === "retry")
      return retryBookRun(tx, actor, task.book_id, task.run_id, verified);
    return { ok: true };
  });
}
