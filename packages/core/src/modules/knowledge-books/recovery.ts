import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, systemErrorText } from "../../shared/errors.js";
import { bookConfigurationSchema } from "./protocol.js";
import { bookNow } from "./management.js";
import { appendBookRunLog } from "./run-logs.js";

/** Preserve interrupted outputs and make the interrupted node visible to human operators. */
export async function recoverBookRuns(db: DB, cutoff: string) {
  const runs = await db
    .selectFrom("knowledge_book_runs")
    .selectAll()
    .where("status", "=", "running")
    .where("heartbeat_at", "<", cutoff)
    .execute();
  for (const run of runs)
    await transact(db, async (tx) => {
      const now = bookNow(),
        error = systemErrorText(
          new AppError(503, "Run worker stopped; continue this pipeline", {
            code: "book_failed",
          }),
        );
      const changed = await tx
        .updateTable("knowledge_book_runs")
        .set({ status: "failed", error, lease_id: null, updated_at: now })
        .where("id", "=", run.id)
        .where("status", "=", "running")
        .where("heartbeat_at", "<", cutoff)
        .executeTakeFirst();
      if (!Number(changed.numUpdatedRows)) return;
      await appendBookRunLog(tx, run, null, { code: "worker_recovered" });
      const nodes = await tx
        .selectFrom("knowledge_book_node_runs")
        .select("node_id")
        .where("run_id", "=", run.id)
        .where("status", "=", "running")
        .execute();
      await tx
        .updateTable("knowledge_book_node_runs")
        .set({ status: "failed", error, completed_at: now })
        .where("run_id", "=", run.id)
        .where("status", "=", "running")
        .execute();
      const configuration = bookConfigurationSchema.parse(
        JSON.parse(run.configuration),
      );
      const ids = nodes.length
        ? nodes.map((node) => node.node_id)
        : [
            configuration.workflow.nodes.find(
              (node) => node.type === "publish",
            )!.id,
          ];
      for (const nodeId of ids)
        await tx
          .insertInto("knowledge_book_human_tasks")
          .values({
            id: randomUUID(),
            book_id: run.book_id,
            run_id: run.id,
            node_id: nodeId,
            kind: "repair",
            title: configuration.workflow.nodes.find(
              (node) => node.id === nodeId,
            )!.label,
            status: "pending",
            revision: 1,
            input_hash: run.input_hash,
            resolution: "",
            created_at: now,
            updated_at: now,
          })
          .onConflict(conflict => conflict.columns(["run_id", "node_id", "kind"]).doUpdateSet({
            status: "pending", revision: sql`knowledge_book_human_tasks.revision + 1`, updated_at: now,
          }))
          .execute();
    });
}
