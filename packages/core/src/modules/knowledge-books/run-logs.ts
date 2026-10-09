import { randomUUID } from "node:crypto";
import type { DB, Schema } from "@db/index.js";
import type { BookConfiguration } from "./protocol.js";

const codes = {
  run_queued: "rq",
  run_started: "rs",
  node_started: "ns",
  source_loading: "sl",
  source_loaded: "sd",
  model_request: "mr",
  model_output: "mo",
  model_retry: "mt",
  batch_started: "bs",
  batch_completed: "bc",
  model_invalid_json: "ij",
  model_invalid_schema: "is",
  model_invalid_evidence: "ie",
  node_completed: "nc",
  node_failed: "nf",
  node_cancelled: "nx",
  waiting_input: "wi",
  waiting_publication: "wp",
  run_published: "rp",
  run_failed: "rf",
  worker_recovered: "wr",
} as const;
export type BookRunLogCode = keyof typeof codes;
export type BookRunProgress = {
  code: BookRunLogCode;
  value?: number;
  total?: number;
};
export type BookRunReporter = (event: BookRunProgress) => Promise<void>;
export type BookRunLog = {
  id: string;
  at: string;
  code: BookRunLogCode;
  nodeId: string | null;
  nodeType: string | null;
  value: number | null;
  total: number | null;
};
type Run = Pick<Schema["knowledge_book_runs"], "id" | "book_id" | "actor_id">;
const prefix = (runId: string) => `kb1:${runId}:`;
const number = (value: number | undefined) => {
  if (value === undefined) return "-";
  if (!Number.isSafeInteger(value) || value < 0 || value > 999999999)
    throw new Error("Invalid run-log metric");
  return value.toString(36);
};
/** Versioned numeric facts fit the existing 64-character audit action column; no content or secret payloads. */
export async function appendBookRunLog(
  db: DB,
  run: Run,
  nodeIndex: number | null,
  event: BookRunProgress,
) {
  if (
    nodeIndex !== null &&
    (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= 40)
  )
    throw new Error("Invalid run-log node index");
  const action = `${prefix(run.id)}${nodeIndex === null ? "-" : number(nodeIndex)}:${codes[event.code]}:${number(event.value)}:${number(event.total)}`;
  if (action.length > 64)
    throw new Error("Run-log action exceeds audit limits");
  await db
    .insertInto("audit_events")
    .values({
      id: randomUUID(),
      actor_id: run.actor_id,
      resource_id: run.book_id,
      action,
      created_at: new Date().toISOString(),
    })
    .execute();
}
export async function readBookRunLogs(
  db: DB,
  bookId: string,
  runId: string,
  configuration: BookConfiguration,
) {
  const rows = await db
    .selectFrom("audit_events")
    .select(["id", "created_at", "action"])
    .where("resource_id", "=", bookId)
    .where("action", "like", `${prefix(runId)}%`)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(200)
    .execute();
  const decode = (value: string) => {
    if (value === "-") return null;
    if (!/^[0-9a-z]{1,6}$/.test(value))
      throw new Error("Invalid version-1 run log");
    const decoded = parseInt(value, 36);
    if (decoded > 999999999)
      throw new Error("Invalid version-1 run-log metric");
    return decoded;
  };
  return rows.reverse().map((row) => {
    const parts = row.action.slice(prefix(runId).length).split(":");
    if (parts.length !== 4) throw new Error("Invalid version-1 run log");
    const [index, token, value, total] = parts as [
      string,
      string,
      string,
      string,
    ];
    const nodeIndex = decode(index),
      node =
        nodeIndex === null ? null : configuration.workflow.nodes[nodeIndex];
    const code = (Object.keys(codes) as BookRunLogCode[]).find(
      (key) => codes[key] === token,
    );
    if (!code || (nodeIndex !== null && !node))
      throw new Error("Unknown version-1 run-log event or node");
    return {
      id: row.id,
      at: row.created_at,
      code,
      nodeId: node?.id ?? null,
      nodeType: node?.type ?? null,
      value: decode(value),
      total: decode(total),
    } satisfies BookRunLog;
  });
}

export type BookRunTrigger = {
  kind: "user" | "schedule";
  actorId: string;
  actorName: string;
  schedule: "daily" | "weekly" | null;
};
/** Trigger identity is a recorded queue fact, never inferred from a later publication actor. */
export async function readBookRunTriggers(
  db: DB,
  bookId: string,
  runs: readonly { id: string; trigger_key: string | null }[],
) {
  const triggers = new Map<string, BookRunTrigger>();
  if (!runs.length) return triggers;
  const actions = runs.map((run) => `${prefix(run.id)}-:rq:-:-`);
  const rows = await db
    .selectFrom("audit_events as event")
    .innerJoin("users as user", "user.id", "event.actor_id")
    .select(["event.action", "event.actor_id", "user.display_name"])
    .where("event.resource_id", "=", bookId)
    .where("event.action", "in", actions)
    .execute();
  for (const row of rows) {
    const id = row.action.slice(4, 40),
      run = runs.find((run) => run.id === id)!;
    const schedule = run.trigger_key?.startsWith("daily:")
      ? "daily"
      : run.trigger_key?.startsWith("weekly:")
        ? "weekly"
        : null;
    triggers.set(id, {
      kind: schedule ? "schedule" : "user",
      actorId: row.actor_id,
      actorName: row.display_name,
      schedule,
    });
  }
  return triggers;
}
