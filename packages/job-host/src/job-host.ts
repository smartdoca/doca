import { JobHandlerRegistry, type JobHandlerDisposer } from "./registry.js";
import type {
  JobHandler,
  JobRunResult,
  JobSchedulerAdapter,
  LeasedJob,
} from "./types.js";

export interface JobHostOptions<TContext> {
  readonly scheduler: JobSchedulerAdapter;
  readonly context: TContext;
  readonly registry?: JobHandlerRegistry<TContext>;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: (attempts: number, job: LeasedJob) => number;
  readonly now?: () => Date;
}

export class StaleJobLeaseError extends Error {
  readonly name = "StaleJobLeaseError";

  constructor(readonly jobId: string) {
    super(`Job lease is no longer active: ${jobId}`);
  }
}

export function jobErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .replace(/Bearer\s+\S+/gi, "Bearer ***")
      .replace(/(api[-_ ]?key\s*[:=]\s*)\S+/gi, "$1***")
      .trim()
      .slice(0, 500) || "Job handler failed"
  );
}

async function requireTransition(
  job: LeasedJob,
  transition: Promise<boolean | void>,
) {
  if ((await transition) === false) throw new StaleJobLeaseError(job.id);
}

/**
 * Leases jobs from a scheduler and dispatches each lease to one registered
 * owner. Handler effects stay scoped to this host's registry.
 */
export class JobHost<TContext = unknown> {
  readonly registry: JobHandlerRegistry<TContext>;
  readonly #scheduler: JobSchedulerAdapter;
  readonly #context: TContext;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: (attempts: number, job: LeasedJob) => number;
  readonly #now: () => Date;
  #disposed = false;

  constructor(options: JobHostOptions<TContext>) {
    this.#scheduler = options.scheduler;
    this.#context = options.context;
    this.registry = options.registry ?? new JobHandlerRegistry<TContext>();
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#retryDelayMs =
      options.retryDelayMs ??
      ((attempts) => Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)));
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs <= 0)
      throw new TypeError("leaseMs must be a positive safe integer");
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts <= 0)
      throw new TypeError("maxAttempts must be a positive safe integer");
  }

  register(handler: JobHandler<TContext>): JobHandlerDisposer {
    if (this.#disposed) throw new Error("Job host has been disposed");
    return this.registry.register(handler);
  }

  async runOnce(signal: AbortSignal = new AbortController().signal) {
    if (this.#disposed) throw new Error("Job host has been disposed");
    if (signal.aborted) throw signal.reason;

    const leasedAt = this.#now();
    const job = await this.#scheduler.lease({
      now: leasedAt.toISOString(),
      leaseMs: this.#leaseMs,
    });
    if (!job) return { state: "idle" } as const satisfies JobRunResult;

    const handler = this.registry.get(job.kind);
    if (
      !handler ||
      (job.pluginId !== undefined && handler.pluginId !== job.pluginId)
    ) {
      const error = handler
        ? `Plugin ${job.pluginId} does not own job kind ${job.kind}`
        : `Plugin handler for job kind ${job.kind} is not installed`;
      await requireTransition(
        job,
        this.#scheduler.blockPluginMissing(job, {
          attempts: job.attempts,
          error,
        }),
      );
      return {
        state: "blocked-plugin-missing",
        job,
        attempts: job.attempts,
        error,
      } as const satisfies JobRunResult;
    }

    try {
      await handler.run(job.payload, {
        host: this.#context,
        job,
        signal,
      });
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = jobErrorMessage(error);
      const maxAttempts = job.maxAttempts ?? this.#maxAttempts;
      if (attempts >= maxAttempts) {
        await requireTransition(
          job,
          this.#scheduler.deadLetter(job, {
            attempts,
            error: message,
          }),
        );
        return {
          state: "dead-letter",
          job,
          attempts,
          error: message,
        } as const satisfies JobRunResult;
      }

      const delay = this.#retryDelayMs(attempts, job);
      if (!Number.isFinite(delay) || delay < 0)
        throw new TypeError("retryDelayMs must return a non-negative number");
      const availableAt = new Date(this.#now().getTime() + delay).toISOString();
      await requireTransition(
        job,
        this.#scheduler.retry(job, {
          attempts,
          error: message,
          availableAt,
        }),
      );
      return {
        state: "retry",
        job,
        attempts,
        availableAt,
        error: message,
      } as const satisfies JobRunResult;
    }
    await requireTransition(job, this.#scheduler.complete(job));
    return {
      state: "completed",
      job,
    } as const satisfies JobRunResult;
  }

  processOne(signal?: AbortSignal) {
    return this.runOnce(signal);
  }

  async drain(
    limit = 25,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly JobRunResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new TypeError("limit must be a positive safe integer");
    const results: JobRunResult[] = [];
    for (let index = 0; index < limit; index++) {
      const result = await this.runOnce(signal);
      if (result.state === "idle") break;
      results.push(result);
    }
    return Object.freeze(results);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.registry.dispose();
  }
}

export function createJobHost<TContext>(options: JobHostOptions<TContext>) {
  return new JobHost(options);
}
