import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import type {
  JobFailureTransition,
  JobJson,
  JobRetryTransition,
  JobSchedulerAdapter,
  LeasedJob,
} from "../../../../job-host/src/index.js";

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
      status: "queued",
      plugin_id: null,
      max_attempts: 5,
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
          status: "queued",
          plugin_id: null,
          max_attempts: 5,
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
          eb.and([
            eb("status", "in", ["queued", "retry", "leased"]),
            eb.or([eb("lease_until", "is", null), eb("lease_until", "<", now)]),
          ]),
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
          status: "leased",
        })
        .where("id", "=", candidate.id)
        .where("revision", "=", candidate.revision)
        .where((eb) =>
          eb.and([
            eb("status", "in", ["queued", "retry", "leased"]),
            eb.or([eb("lease_until", "is", null), eb("lease_until", "<", now)]),
          ]),
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
            status: "retry",
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

export interface RuntimeJobInput {
  readonly id: string;
  readonly kind: string;
  readonly payload: JobJson;
  readonly pluginId?: string;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
}

/** Adds a plugin-owned job without changing the legacy projection API. */
export async function enqueueRuntimeJob(db: DB, input: RuntimeJobInput) {
  if (!input.id) throw new TypeError("Job id must not be empty");
  if (!input.kind) throw new TypeError("Job kind must not be empty");
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0)
    throw new TypeError("maxAttempts must be a positive safe integer");
  const availableAt = input.availableAt ?? new Date().toISOString();
  const payload = JSON.stringify(input.payload);
  if (payload === undefined)
    throw new TypeError("Job payload must be JSON-compatible");

  await db
    .insertInto("projection_jobs")
    .values({
      id: input.id,
      kind: input.kind,
      payload,
      revision: 1,
      attempts: 0,
      available_at: availableAt,
      last_error: null,
      status: "queued",
      plugin_id: input.pluginId ?? null,
      max_attempts: maxAttempts,
    })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet((eb) => ({
        kind: input.kind,
        payload,
        revision: eb("projection_jobs.revision", "+", 1),
        attempts: 0,
        available_at: availableAt,
        last_error: null,
        status: "queued",
        plugin_id: input.pluginId ?? null,
        max_attempts: maxAttempts,
      })),
    )
    .execute();
}

function leaseRevision(job: LeasedJob): number {
  const separator = job.leaseToken.lastIndexOf(":");
  const revision = Number(job.leaseToken.slice(separator + 1));
  if (separator < 0 || !Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError("Projection job lease token is invalid");
  return revision;
}

/**
 * Adapts the existing durable projection queue to the job host's leasing
 * boundary. Legacy enqueueProjection/processProjections callers remain valid.
 */
export function createProjectionJobSchedulerAdapter(
  db: DB,
  options: { readonly kinds?: readonly string[] } = {},
): JobSchedulerAdapter {
  const transition = async (
    job: LeasedJob,
    values: {
      readonly status: string;
      readonly attempts: number;
      readonly last_error: string;
      readonly available_at?: string;
    },
  ) => {
    return transact(db, async (tx) => {
      const result = await tx
        .updateTable("projection_jobs")
        .set({
          status: values.status,
          attempts: values.attempts,
          last_error: values.last_error,
          ...(values.available_at === undefined
            ? {}
            : { available_at: values.available_at }),
          lease_token: null,
          lease_until: null,
        })
        .where("id", "=", job.id)
        .where("revision", "=", leaseRevision(job))
        .where("lease_token", "=", job.leaseToken)
        .executeTakeFirst();
      if (result.numUpdatedRows) return true;
      const released = await tx
        .updateTable("projection_jobs")
        .set({ lease_token: null, lease_until: null })
        .where("id", "=", job.id)
        .where("lease_token", "=", job.leaseToken)
        .executeTakeFirst();
      return released.numUpdatedRows > 0n;
    });
  };

  return {
    async lease(request) {
      const token = randomUUID();
      return transact(db, async (tx) => {
        let query = tx
          .selectFrom("projection_jobs")
          .selectAll()
          .where("available_at", "<=", request.now)
          .where((eb) =>
            eb.and([
              eb("status", "in", ["queued", "retry", "leased"]),
              eb.or([
                eb("lease_until", "is", null),
                eb("lease_until", "<", request.now),
              ]),
            ]),
          );
        if (options.kinds?.length)
          query = query.where("kind", "in", [...options.kinds]);
        const candidate = await query
          .orderBy("available_at")
          .orderBy("id")
          .limit(1)
          .executeTakeFirst();
        if (!candidate) return undefined;

        const leaseToken = `${token}:${candidate.revision}`;
        const leaseUntil = new Date(
          new Date(request.now).getTime() + request.leaseMs,
        ).toISOString();
        const leased = await tx
          .updateTable("projection_jobs")
          .set({
            status: "leased",
            lease_token: leaseToken,
            lease_until: leaseUntil,
          })
          .where("id", "=", candidate.id)
          .where("revision", "=", candidate.revision)
          .where((eb) =>
            eb.and([
              eb("status", "in", ["queued", "retry", "leased"]),
              eb.or([
                eb("lease_until", "is", null),
                eb("lease_until", "<", request.now),
              ]),
            ]),
          )
          .executeTakeFirst();
        if (!leased.numUpdatedRows) return undefined;
        return Object.freeze({
          id: candidate.id,
          kind: candidate.kind,
          payload: JSON.parse(candidate.payload) as JobJson,
          ...(candidate.plugin_id ? { pluginId: candidate.plugin_id } : {}),
          attempts: candidate.attempts,
          maxAttempts: candidate.max_attempts ?? 5,
          availableAt: candidate.available_at,
          leaseToken,
          leaseUntil,
        });
      });
    },

    async complete(job) {
      return transact(db, async (tx) => {
        const result = await tx
          .deleteFrom("projection_jobs")
          .where("id", "=", job.id)
          .where("revision", "=", leaseRevision(job))
          .where("lease_token", "=", job.leaseToken)
          .executeTakeFirst();
        if (result.numDeletedRows) return true;
        const released = await tx
          .updateTable("projection_jobs")
          .set({ lease_token: null, lease_until: null })
          .where("id", "=", job.id)
          .where("lease_token", "=", job.leaseToken)
          .executeTakeFirst();
        return released.numUpdatedRows > 0n;
      });
    },

    retry(job, failure: JobRetryTransition) {
      return transition(job, {
        status: "retry",
        attempts: failure.attempts,
        last_error: failure.error,
        available_at: failure.availableAt,
      });
    },

    deadLetter(job, failure: JobFailureTransition) {
      return transition(job, {
        status: "dead-letter",
        attempts: failure.attempts,
        last_error: failure.error,
      });
    },

    blockPluginMissing(job, failure: JobFailureTransition) {
      return transition(job, {
        status: "blocked-plugin-missing",
        attempts: failure.attempts,
        last_error: failure.error,
      });
    },
  };
}
