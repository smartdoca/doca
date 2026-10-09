import type { DB, Schema } from "@db/index.js";

const idleLimit = 15 * 60 * 1000;

export async function aiJobIsIdle(
  db: DB,
  job: Pick<Schema["ai_jobs"], "id" | "user_id" | "updated_at">,
  now = Date.now(),
) {
  const checkpointAt = Date.parse(job.updated_at);
  if (Number.isFinite(checkpointAt) && now - checkpointAt <= idleLimit) return false;
  // A new scene-analysis correction or independent review is real activity
  // even when it has not produced a complete, durable tool checkpoint yet.
  // Lease renewals alone never advance this clock.
  const call = await db.selectFrom("ai_calls")
    .select("updated_at")
    .where("job_id", "=", job.id)
    .where("user_id", "=", job.user_id)
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  const callAt = call ? Date.parse(call.updated_at) : NaN;
  return !Number.isFinite(callAt) || now - callAt > idleLimit;
}
