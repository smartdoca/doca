import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import { fail } from "@core/shared/errors.js";
import { encodeSystemError } from "@doca/i18n";
import type { AIProgress } from "@core/modules/ai/progress.js";
import type {
  AIContinuationInput,
  AIContinuationReceipt,
} from "@smartdoca/plugin-sdk/ai";

const sourceId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
export const continuationInputSchema = z
  .object({ sourceId, operationId: z.string().min(1).max(200) })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    state: z.enum([
      "running",
      "waiting_input",
      "completed",
      "failed",
      "cancelled",
    ]),
    revision: z.string().min(1).max(200),
    summary: z.string().max(2000),
    result: z.json().optional(),
  })
  .strict();
const waitSchema = continuationInputSchema
  .extend({
    pluginId: sourceId,
    revision: z.string().min(1).max(200),
    state: z.enum(["running", "waiting_input"]),
  })
  .strict();
export const continuationStateSchema = z
  .object({
    version: z.literal(1),
    waits: z.array(waitSchema).max(20),
    ready: z
      .array(
        continuationInputSchema
          .extend({ pluginId: sourceId, snapshot: snapshotSchema })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type AIContinuationState = z.infer<typeof continuationStateSchema>;
export const newContinuationState = (): AIContinuationState => ({
  version: 1,
  waits: [],
  ready: [],
});
const same = (a: AIContinuationInput, b: AIContinuationInput) =>
  a.sourceId === b.sourceId && a.operationId === b.operationId;

/** The provider owns business authorization; every read uses fresh host identity and a bounded deadline. */
export async function readContinuationSnapshot(
  db: DB,
  actor: Actor,
  input: AIContinuationInput,
  signal?: AbortSignal,
): Promise<z.infer<typeof snapshotSchema>> {
  continuationInputSchema.parse(input);
  const current = await db
    .selectFrom("users")
    .select(["id", "display_name", "public_id", "admin", "status"])
    .where("id", "=", actor.id)
    .executeTakeFirst();
  if (current?.status !== "active")
    fail(403, "Continuation owner is unavailable");
  const source = pluginServices(db).continuations.get(input.sourceId);
  if (!source) fail(503, "Background continuation source is unavailable");
  const controller = new AbortController();
  const bounded = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      source.read(
        {
          requestId: randomUUID(),
          signal: bounded,
          principal: {
            id: current.id,
            displayName: current.display_name,
            publicId: current.public_id ?? "",
            admin: !!current.admin,
          },
        },
        { operationId: input.operationId },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Continuation source timed out"));
        }, 20000);
        timer.unref();
      }),
    ]);
    bounded.throwIfAborted();
    if (pluginServices(db).continuations.get(input.sourceId) !== source)
      fail(503, "Continuation source changed during authorization");
    const latest = await db
      .selectFrom("users")
      .select(["status", "admin"])
      .where("id", "=", actor.id)
      .executeTakeFirst();
    if (latest?.status !== "active" || latest.admin !== current.admin)
      fail(403, "Continuation identity changed during authorization");
    if (raw === null)
      fail(403, "Background task is unavailable or no longer authorized");
    const result = snapshotSchema.parse(raw);
    if (JSON.stringify(result).length > 24000)
      fail(413, "Background result exceeds continuation limits");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function registerContinuationWait(
  db: DB,
  actor: Actor,
  state: AIContinuationState,
  raw: AIContinuationInput,
  signal: AbortSignal,
): Promise<AIContinuationReceipt> {
  const input = continuationInputSchema.parse(raw);
  const snapshot = await readContinuationSnapshot(db, actor, input, signal);
  const pending =
    snapshot.state === "running" || snapshot.state === "waiting_input";
  const waits = state.waits.filter((item) => !same(item, input));
  if (pending)
    waits.push({
      ...input,
      pluginId: pluginServices(db).continuations.get(input.sourceId)!.pluginId,
      revision: snapshot.revision,
      state: snapshot.state as "running" | "waiting_input",
    });
  if (waits.length > 20)
    fail(413, "Too many background dependencies in one assistant turn");
  state.waits = waits;
  return { ...input, snapshot, state: pending ? "waiting" : "ready" };
}

/** Read-only reconciliation first; the original persisted ticket is checked again when claiming a wake. */
export async function refreshContinuations(
  db: DB,
  actor: Actor,
  state: AIContinuationState,
  signal?: AbortSignal,
) {
  const snapshots = await Promise.all(
    state.waits.map(async (wait) => {
      if (
        pluginServices(db).continuations.get(wait.sourceId)?.pluginId !==
        wait.pluginId
      )
        fail(503, "Continuation source ownership changed or is unavailable");
      return {
        wait,
        snapshot: await readContinuationSnapshot(
          db,
          actor,
          { sourceId: wait.sourceId, operationId: wait.operationId },
          signal,
        ),
      };
    }),
  );
  let changed = false;
  const remaining: AIContinuationState["waits"] = [];
  const ready = [...state.ready];
  for (const { wait, snapshot } of snapshots) {
    const actionable =
      snapshot.state !== "running" &&
      (snapshot.state !== wait.state || snapshot.revision !== wait.revision);
    if (actionable) {
      changed = true;
      const index = ready.findIndex((item) => same(item, wait));
      const result = {
        sourceId: wait.sourceId,
        operationId: wait.operationId,
        pluginId: wait.pluginId,
        snapshot,
      };
      if (index < 0) ready.push(result);
      else ready[index] = result;
    }
    if (snapshot.state === "running" || snapshot.state === "waiting_input")
      remaining.push({
        ...wait,
        state: snapshot.state,
        revision: snapshot.revision,
      });
  }
  state.waits = remaining;
  state.ready = ready;
  return changed;
}

export async function wakeAIContinuations(
  db: DB,
  filter?: AIContinuationInput,
) {
  if (filter) continuationInputSchema.parse(filter);
  if (!pluginServices(db).continuationsReady) return { woken: 0 };
  let woken = 0;
  const reconcile = async (job: Awaited<ReturnType<typeof page>>[number]) => {
    let saved: any,
      invalid = false;
    try {
      saved = JSON.parse(job.result);
      if (
        saved.checkpoint?.continuations === undefined ||
        saved.progress?.phase !== "waiting_dependency"
      )
        return;
      const state = continuationStateSchema.parse(
        saved.checkpoint.continuations,
      );
      if (filter && !state.waits.some((wait) => same(wait, filter))) return;
      const actor = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", job.user_id)
        .where("status", "=", "active")
        .executeTakeFirst();
      const session = await db
        .selectFrom("ai_sessions")
        .select("user_id")
        .where("id", "=", job.session_id)
        .executeTakeFirst();
      if (!actor || session?.user_id !== job.user_id)
        fail(403, "Continuation owner is unavailable");
      if (!(await refreshContinuations(db, actor, state))) return;
      saved.checkpoint.continuations = state;
      saved.checkpoint.stage = "execute";
      const progress = saved.progress as AIProgress;
      progress.phase = "resuming";
      progress.phaseData = undefined;
      progress.events ??= [];
      progress.events.push({
        id: randomUUID(),
        kind: "status",
        code: "continuation_resumed",
        status: "success",
        at: new Date().toISOString(),
      });
    } catch (error) {
      invalid = error instanceof z.ZodError || error instanceof SyntaxError;
      saved = undefined;
    }
    if (!pluginServices(db).continuationsReady) return;
    const claimed = await transact(db, async (tx) => {
      if (!pluginServices(tx).continuationsReady) return false;
      await lockAIUser(tx, job.user_id);
      const owner = await tx
        .selectFrom("users")
        .select("status")
        .where("id", "=", job.user_id)
        .executeTakeFirst();
      if (owner?.status !== "active") saved = undefined;
      const updated = await tx
        .updateTable("ai_jobs")
        .set(
          saved
            ? {
                status: "queued",
                result: JSON.stringify(saved),
                error: "",
                updated_at: new Date().toISOString(),
              }
            : {
                status: "failed",
                error: encodeSystemError({
                  code: invalid
                    ? "ai_continuation_invalid"
                    : "ai_continuation_unavailable",
                }),
                updated_at: new Date().toISOString(),
              },
        )
        .where("id", "=", job.id)
        .where("status", "=", "awaiting_approval")
        .where("cancelled", "=", 0)
        .where("result", "=", job.result)
        .executeTakeFirst();
      return !!saved && Number(updated.numUpdatedRows) > 0;
    });
    if (claimed) woken++;
  };
  // Keyset paging avoids starving tickets beyond the first page. Four reads at
  // a time keep slow plugin sources from monopolizing reconciliation.
  const page = (after: string | undefined) => {
    let query = db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("status", "=", "awaiting_approval")
      .where("cancelled", "=", 0);
    if (after) query = query.where("id", ">", after);
    return query.orderBy("id").limit(50).execute();
  };
  let cursor: string | undefined;
  for (;;) {
    if (!pluginServices(db).continuationsReady) break;
    const jobs = await page(cursor);
    if (!jobs.length) break;
    for (let index = 0; index < jobs.length; index += 4)
      await Promise.all(jobs.slice(index, index + 4).map(reconcile));
    cursor = jobs.at(-1)!.id;
    if (jobs.length < 50) break;
  }
  return { woken };
}

/** Public presentation of an explicitly registered wait; storage keeps its existing status constraint. */
export function continuationJobStatus(job: { status: string; result: string }) {
  if (job.status !== "awaiting_approval" || !job.result) return job.status;
  const saved = JSON.parse(job.result);
  return saved.progress?.phase === "waiting_dependency" &&
    saved.checkpoint?.continuations?.version === 1
    ? "awaiting_dependency"
    : job.status;
}
