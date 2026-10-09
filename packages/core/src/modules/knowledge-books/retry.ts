import { readBookSource, type BookSourceRuntime } from "./sources.js";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import {
  bookAccess,
  bookInputSnapshot,
  queueBookRun,
  bookHash,
  bookNow,
} from "./management.js";
import { bookConfigurationSchema, bookSourceInputSchema } from "./protocol.js";
import { bookFail as fail } from "./errors.js";

export function nodeReuseAuditId(runId: string, nodeId: string) {
  const h = bookHash(["book-node-reuse", runId, nodeId]).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
}
export async function readNodeReuse(db: DB, runId: string, nodeIds: string[]) {
  const reuse = new Map<string, string>();
  for (const nodeId of nodeIds) {
    const record = await db
      .selectFrom("audit_events")
      .select("action")
      .where("id", "=", nodeReuseAuditId(runId, nodeId))
      .executeTakeFirst();
    if (record) {
      if (!record.action.startsWith("knowledge_book.reuse:"))
        fail(409, "Node reuse audit record is invalid");
      reuse.set(nodeId, record.action.slice("knowledge_book.reuse:".length));
    }
  }
  return reuse;
}
function retryAuditId(runId: string) {
  return nodeReuseAuditId(runId, "run-retry-origin");
}
export async function readRetryOrigin(db: DB, runId: string) {
  const row = await db
    .selectFrom("audit_events")
    .select("action")
    .where("id", "=", retryAuditId(runId))
    .executeTakeFirst();
  if (!row) return null;
  if (!row.action.startsWith("knowledge_book.retry:"))
    fail(409, "Retry origin audit record is invalid");
  return row.action.slice("knowledge_book.retry:".length);
}
/** External inventories are read before opening the write transaction. Proofs never contain primary bodies. */
export async function prepareRunReuse(
  db: DB,
  actor: Actor,
  bookId: string,
  runId: string,
  runtime?: BookSourceRuntime,
) {
  const verified = new Set<string>();
  const localOnly: BookSourceRuntime = {
    async readFile() {
      throw new Error("A file reader is required");
    },
    async readWeb() {
      throw new Error("A web reader is required");
    },
  };
  const { book } = await bookAccess(db, actor, bookId, 3),
    prior = await db
      .selectFrom("knowledge_book_runs")
      .selectAll()
      .where("id", "=", runId)
      .where("book_id", "=", bookId)
      .executeTakeFirstOrThrow(),
    snapshot = await bookInputSnapshot(db, bookId);
  if (
    book.configuration !== prior.configuration ||
    snapshot.hash !== prior.input_hash
  )
    return verified;
  const nodes = await db
    .selectFrom("knowledge_book_node_runs")
    .select("output")
    .where("run_id", "=", runId)
    .where("status", "=", "completed")
    .execute();
  const expected = nodes.flatMap(
    (node) => JSON.parse(node.output).evidence,
  ) as import("./protocol.js").Evidence[];
  for (const source of snapshot.sources) {
    const configuration = bookSourceInputSchema.parse(
      JSON.parse(source.configuration),
    );
    if (
      !runtime &&
      configuration.items.some(
        (binding) => !["manual", "document", "library"].includes(binding.kind),
      )
    )
      continue;
    const unique = new Map(
      expected
        .filter((item) => item.sourceId === source.id)
        .map((item) => [item.id, item]),
    );
    if (!unique.size) continue;
    try {
      const current = await readBookSource(db, source, runtime ?? localOnly);
      if (
        current.length === unique.size &&
        current.every(
          (live) => unique.get(live.id)?.contentHash === live.contentHash,
        )
      )
        verified.add(source.id);
    } catch {
      /* A source which cannot be verified will be read again by fresh workflow nodes. */
    }
  }
  return verified;
}
/** A retry creates a new run. It only reuses complete outputs when the full frozen configuration and inputs match. */
export async function retryBookRun(
  db: DB,
  actor: Actor,
  bookId: string,
  previousRunId: string,
  verifiedExternalSources: ReadonlySet<string> = new Set(),
) {
  const { book } = await bookAccess(db, actor, bookId, 3),
    prior = await db
      .selectFrom("knowledge_book_runs")
      .selectAll()
      .where("id", "=", previousRunId)
      .where("book_id", "=", bookId)
      .executeTakeFirstOrThrow(),
    snapshot = await bookInputSnapshot(db, bookId);
  const queued = await queueBookRun(db, actor, bookId);
  await db
    .insertInto("audit_events")
    .values({
      id: retryAuditId(queued.id),
      actor_id: actor.id,
      resource_id: bookId,
      action: `knowledge_book.retry:${prior.id}`,
      created_at: bookNow(),
    })
    .execute();
  if (
    book.configuration !== prior.configuration ||
    book.revision !== prior.configuration_revision ||
    snapshot.hash !== prior.input_hash
  )
    return queued;
  const configuration = bookConfigurationSchema.parse(
    JSON.parse(prior.configuration),
  );
  const blocked = new Set(
    configuration.workflow.nodes
      .filter((node) => ["human_review", "publish"].includes(node.type))
      .map((node) => node.id),
  );
  const failedChecks = await db
    .selectFrom("knowledge_book_node_runs")
    .select("node_id")
    .where("run_id", "=", prior.id)
    .where("status", "=", "failed")
    .where("type", "=", "acceptance")
    .execute();
  for (const check of failedChecks) {
    const ancestors = new Set([check.node_id]);
    for (let i = 0; i < configuration.workflow.nodes.length; i++)
      for (const edge of configuration.workflow.edges)
        if (ancestors.has(edge.target)) ancestors.add(edge.source);
    for (const node of configuration.workflow.nodes)
      if (
        ancestors.has(node.id) &&
        ["extract", "synthesize", "organize", "acceptance"].includes(node.type)
      )
        blocked.add(node.id);
  }
  for (let i = 0; i < configuration.workflow.nodes.length; i++)
    for (const edge of configuration.workflow.edges)
      if (blocked.has(edge.source)) blocked.add(edge.target);
  const completed = await db
    .selectFrom("knowledge_book_node_runs")
    .selectAll()
    .where("run_id", "=", prior.id)
    .where("status", "=", "completed")
    .execute();
  const reusable = [];
  for (const node of completed) {
    if (blocked.has(node.node_id)) continue;
    const output = JSON.parse(node.output);
    let matches = true;
    for (const evidence of output.evidence)
      if (
        evidence.reference.kind !== "feedback" &&
        !verifiedExternalSources.has(evidence.sourceId)
      )
        matches = false;
    if (matches) reusable.push(node);
  }
  for (const node of reusable) {
    await db
      .insertInto("knowledge_book_node_runs")
      .values({ ...node, run_id: queued.id })
      .execute();
    await db
      .insertInto("audit_events")
      .values({
        id: nodeReuseAuditId(queued.id, node.node_id),
        actor_id: actor.id,
        resource_id: bookId,
        action: `knowledge_book.reuse:${prior.id}`,
        created_at: bookNow(),
      })
      .execute();
  }
  if (reusable.length) {
    await db
      .updateTable("knowledge_book_runs")
      .set({ status: "queued_resume" })
      .where("id", "=", queued.id)
      .execute();
    return {
      id: queued.id,
      status: "queued_resume" as const,
      reusedNodes: reusable.map((node) => node.node_id),
    };
  }
  return queued;
}
