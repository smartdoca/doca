import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";

/** Keep operator-facing errors useful without leaking credentials or huge bodies. */
export function projectionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/(api[-_ ]?key\s*[:=]\s*)\S+/gi, "$1***")
    .trim()
    .slice(0, 500);
  return sanitized || "未知错误";
}
/** Coalesces repeated work, preserving the active consumer's lease. Call in the fact transaction. */
export async function enqueueProjection(
  db: DB,
  kind: string,
  key: string,
  payload: Record<string, unknown>,
  delayMs = 0,
) {
  const available_at = new Date(Date.now() + delayMs).toISOString();
  await db
    .insertInto("projection_jobs")
    .values({
      id: `${kind}:${key}`,
      kind,
      payload: JSON.stringify(payload),
      revision: 1,
      attempts: 0,
      available_at,
      last_error: null,
    })
    .onConflict((oc) =>
      oc
        .column("id")
        .doUpdateSet((eb) => ({
          payload: JSON.stringify(payload),
          revision: eb("projection_jobs.revision", "+", 1),
          attempts: 0,
          available_at,
          last_error: null,
        })),
    )
    .execute();
  if (kind === "search") {
    const row = await db.selectFrom("moderation_settings").select("config").where("id", "=", "system").executeTakeFirst();
    const config = row ? JSON.parse(row.config) : null;
    if (config?.enabled) await enqueueProjection(db, "moderation-text", key, { resourceId: key }, config.delaySeconds * 1000);
  }
}
export async function processProjections(
  db: DB,
  kind: string,
  handle: (payload: Record<string, unknown>) => Promise<void>,
  limit = 25,
  leaseMs = 60000,
) {
  let completed = 0;
  for (let i = 0; i < limit; i++) {
    const token = randomUUID(),
      now = new Date().toISOString();
    const job = await transact(db, async (tx) => {
      const candidate = await tx
        .selectFrom("projection_jobs")
        .selectAll()
        .where("kind", "=", kind)
        .where("available_at", "<=", now)
        .where((eb) =>
          eb.or([eb("lease_until", "is", null), eb("lease_until", "<", now)]),
        )
        .orderBy("available_at")
        .orderBy("id")
        .limit(1)
        .executeTakeFirst();
      if (!candidate) return null;
      const leased = await tx
        .updateTable("projection_jobs")
        .set({
          lease_token: token,
          lease_until: new Date(Date.now() + leaseMs).toISOString(),
        })
        .where("id", "=", candidate.id)
        .where("revision", "=", candidate.revision)
        .where((eb) =>
          eb.or([eb("lease_until", "is", null), eb("lease_until", "<", now)]),
        )
        .executeTakeFirst();
      return leased.numUpdatedRows ? candidate : null;
    });
    if (!job) break;
    try {
      await handle(JSON.parse(job.payload));
      await transact(db, async (tx) => {
        await tx
          .deleteFrom("projection_jobs")
          .where("id", "=", job.id)
          .where("revision", "=", job.revision)
          .where("lease_token", "=", token)
          .execute();
        await tx
          .updateTable("projection_jobs")
          .set({ lease_token: null, lease_until: null })
          .where("id", "=", job.id)
          .where("lease_token", "=", token)
          .execute();
      });
      completed++;
    } catch (error) {
      await transact(db, async (tx) => {
        await tx
          .updateTable("projection_jobs")
          .set({
            attempts: job.attempts + 1,
            last_error: `同步失败：${projectionErrorMessage(error)}`,
            available_at: new Date(
              Date.now() +
                Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)),
            ).toISOString(),
          })
          .where("id", "=", job.id)
          .where("revision", "=", job.revision)
          .where("lease_token", "=", token)
          .execute();
        await tx
          .updateTable("projection_jobs")
          .set({ lease_token: null, lease_until: null })
          .where("id", "=", job.id)
          .where("lease_token", "=", token)
          .execute();
      });
    }
  }
  return completed;
}
