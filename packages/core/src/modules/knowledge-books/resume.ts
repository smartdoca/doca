import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { securityAudit } from "../identity/accounts.js";
import {
  bookAccess,
  bookInputSnapshot,
  bookNow,
  bookHash,
} from "./management.js";
import { bookConfigurationSchema, type Evidence } from "./protocol.js";
import { bookFail as fail } from "./errors.js";
import {
  canReadBookEvidence,
  readBookSource,
  type BookSourceRuntime,
} from "./sources.js";

function frozenResumeAuditId(id: string) {
  const hash = bookHash(["knowledge-book-frozen-resume", id]).slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

export async function isFrozenBookResume(db: DB, id: string) {
  const row = await db
    .selectFrom("audit_events")
    .select("action")
    .where("id", "=", frozenResumeAuditId(id))
    .executeTakeFirst();
  if (!row) return false;
  if (row.action !== "knowledge_book.resumed")
    fail(409, "Invalid frozen-run resume audit");
  return true;
}

/** Resume this run's frozen graph. Nothing is copied to another pipeline. */
export async function resumeBookRun(
  db: DB,
  actor: Actor,
  bookId: string,
  id: string,
  runtime?: BookSourceRuntime,
  taskInput?: { id: string; expectedRevision: number; note: string },
) {
  await bookAccess(db, actor, bookId, 3);
  const run = await db
    .selectFrom("knowledge_book_runs")
    .selectAll()
    .where("id", "=", id)
    .where("book_id", "=", bookId)
    .executeTakeFirst();
  if (!run || !["failed", "cancelled"].includes(run.status))
    fail(409, "Only a failed or cancelled pipeline can continue");
  const configuration = bookConfigurationSchema.parse(
    JSON.parse(run.configuration),
  );
  const snapshot = await bookInputSnapshot(db, bookId);
  if (snapshot.hash !== run.input_hash)
    fail(409, "Sources or feedback changed; start a new pipeline");
  const nodes = await db
    .selectFrom("knowledge_book_node_runs")
    .selectAll()
    .where("run_id", "=", id)
    .execute();
  if (nodes.some((node) => node.status.startsWith("awaiting")))
    fail(
      409,
      "Resolve the existing review or publication task before continuing",
    );
  const evidence = new Map<string, Evidence>();
  for (const node of nodes.filter((node) => node.status === "completed")) {
    if (
      !configuration.workflow.nodes.some(
        (definition) =>
          definition.id === node.node_id && definition.type === node.type,
      )
    )
      fail(409, "Completed node does not match the frozen workflow");
    const output = JSON.parse(node.output);
    if (
      !Array.isArray(output.evidence) ||
      !Array.isArray(output.claims) ||
      !Array.isArray(output.pages) ||
      !Array.isArray(output.checks)
    )
      fail(409, "Completed node output is invalid");
    for (const item of output.evidence as Evidence[])
      evidence.set(
        JSON.stringify([item.id, item.contentHash, item.sourceVersion]),
        item,
      );
  }
  for (const item of evidence.values())
    if (!(await canReadBookEvidence(db, actor, item)))
      fail(403, "Original evidence access is required to continue");
  const reader = runtime ?? {
    async readFile() {
      fail(409, "A source reader is required to continue");
    },
    async readWeb() {
      fail(409, "A source reader is required to continue");
    },
  };
  for (const sourceId of new Set(
    [...evidence.values()]
      .filter((item) => item.reference.kind !== "feedback")
      .map((item) => item.sourceId),
  )) {
    const source = snapshot.sources.find((source) => source.id === sourceId);
    if (!source) fail(409, "Checkpoint source is unavailable");
    const expected = [...evidence.values()].filter(
      (item) => item.sourceId === sourceId,
    );
    const known = new Map(expected.map((item) => [item.id, item]));
    const current = await readBookSource(db, source, reader);
    if (
      known.size !== expected.length ||
      current.length !== known.size ||
      current.some((item) => {
        const previous = known.get(item.id);
        return (
          !previous ||
          previous.sourceRevision !== source.revision ||
          previous.sourceVersion !== item.sourceVersion ||
          previous.contentHash !== item.contentHash
        );
      })
    )
      fail(409, "Source inventory or content changed; start a new pipeline");
  }
  // A negative quality check needs corrected content. Rebuild the closest
  // content stage, keeping extraction and unrelated branches completed.
  const restart = new Set<string>();
  const definitions = new Map(
    configuration.workflow.nodes.map((node) => [node.id, node]),
  );
  for (const node of nodes.filter(
    (node) =>
      node.status === "failed" && node.type === "acceptance" && node.output,
  )) {
    const output = JSON.parse(node.output);
    if (
      !Array.isArray(output.checks) ||
      !output.checks.some((check: { passed: boolean }) => !check.passed)
    )
      continue;
    const queue = [node.node_id],
      visited = new Set(queue);
    for (let index = 0; index < queue.length; index++) {
      for (const edge of configuration.workflow.edges.filter(
        (edge) => edge.target === queue[index],
      )) {
        if (visited.has(edge.source)) continue;
        visited.add(edge.source);
        if (
          ["synthesize", "organize"].includes(
            definitions.get(edge.source)!.type,
          )
        )
          restart.add(edge.source);
        else queue.push(edge.source);
      }
    }
  }
  for (let pass = 0; pass < configuration.workflow.nodes.length; pass++)
    for (const edge of configuration.workflow.edges)
      if (restart.has(edge.source)) restart.add(edge.target);
  return transact(db, async (tx) => {
    await bookAccess(tx, actor, bookId, 3);
    if ((await bookInputSnapshot(tx, bookId)).hash !== run.input_hash)
      fail(409, "Sources or feedback changed; start a new pipeline");
    const now = bookNow();
    const tasks = await tx
      .selectFrom("knowledge_book_human_tasks")
      .selectAll()
      .where("run_id", "=", id)
      .where("kind", "=", "repair")
      .where("status", "=", "pending")
      .execute();
    if (
      taskInput &&
      !tasks.some(
        (task) =>
          task.id === taskInput.id &&
          task.revision === taskInput.expectedRevision,
      )
    )
      fail(409, "Human intervention task changed");
    const result = await tx
      .updateTable("knowledge_book_runs")
      .set({
        status: "queued_resume",
        actor_id: actor.id,
        error: "",
        lease_id: null,
        updated_at: now,
      })
      .where("id", "=", id)
      .where("status", "=", run.status)
      .where("updated_at", "=", run.updated_at)
      .executeTakeFirst();
    if (!Number(result.numUpdatedRows))
      fail(409, "Pipeline changed before it could continue");
    if (restart.size)
      await tx
        .updateTable("knowledge_book_node_runs")
        .set({ status: "cancelled" })
        .where("run_id", "=", id)
        .where("node_id", "in", [...restart])
        .where("status", "=", "completed")
        .execute();
    for (const task of tasks) {
      if (task.resolution)
        await securityAudit(
          tx,
          actor.id,
          actor.id,
          "knowledge_book.task_resolution_retained",
          {
            bookId,
            runId: id,
            taskId: task.id,
            resolution: task.resolution,
          },
        );
      const previous = task.resolution ? JSON.parse(task.resolution).note : "";
      const note =
        taskInput?.id === task.id
          ? [previous, taskInput.note].filter(Boolean).join("\n")
          : previous;
      await tx
        .updateTable("knowledge_book_human_tasks")
        .set({
          status: "resolved",
          revision: task.revision + 1,
          resolution: JSON.stringify({
            decision: "resume",
            note,
            actorId: actor.id,
            createdAt: now,
          }),
          updated_at: now,
        })
        .where("id", "=", task.id)
        .where("revision", "=", task.revision)
        .execute();
    }
    await tx
      .insertInto("audit_events")
      .values({
        id: frozenResumeAuditId(id),
        actor_id: actor.id,
        resource_id: bookId,
        action: "knowledge_book.resumed",
        created_at: now,
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    await tx
      .insertInto("audit_events")
      .values({
        id: randomUUID(),
        actor_id: actor.id,
        resource_id: bookId,
        action: "knowledge_book.resumed",
        created_at: now,
      })
      .execute();
    return { id, status: "queued_resume" as const };
  });
}
