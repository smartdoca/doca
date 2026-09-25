import { randomUUID } from "node:crypto";
import type {
  JobEnvelope,
  JobFailureTransition,
  JobJson,
  JobRetryTransition,
  JobSchedulerAdapter,
  JobState,
  LeasedJob,
} from "./types.js";

export interface EnqueueMemoryJob<TPayload extends JobJson = JobJson> {
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly pluginId?: string;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
}

export interface MemoryJobRecord extends JobEnvelope {
  readonly state: JobState;
  readonly leaseToken?: string;
  readonly leaseUntil?: string;
  readonly lastError?: string;
}

interface MutableJobRecord {
  id: string;
  kind: string;
  payload: JobJson;
  pluginId?: string;
  attempts: number;
  maxAttempts?: number;
  availableAt: string;
  state: JobState;
  leaseToken?: string;
  leaseUntil?: string;
  lastError?: string;
}

function copyPayload<T extends JobJson>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

function snapshot(record: MutableJobRecord): MemoryJobRecord {
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    payload: copyPayload(record.payload),
    ...(record.pluginId === undefined ? {} : { pluginId: record.pluginId }),
    attempts: record.attempts,
    ...(record.maxAttempts === undefined
      ? {}
      : { maxAttempts: record.maxAttempts }),
    availableAt: record.availableAt,
    state: record.state,
    ...(record.leaseToken === undefined
      ? {}
      : { leaseToken: record.leaseToken }),
    ...(record.leaseUntil === undefined
      ? {}
      : { leaseUntil: record.leaseUntil }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  });
}

export class MemoryJobSchedulerAdapter implements JobSchedulerAdapter {
  readonly #jobs = new Map<string, MutableJobRecord>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  enqueue(input: EnqueueMemoryJob): MemoryJobRecord {
    if (!input.id) throw new TypeError("Job id must not be empty");
    if (!input.kind) throw new TypeError("Job kind must not be empty");
    if (this.#jobs.has(input.id))
      throw new Error(`Job "${input.id}" is already scheduled`);
    const attempts = input.attempts ?? 0;
    if (!Number.isSafeInteger(attempts) || attempts < 0)
      throw new TypeError("Job attempts must be a non-negative safe integer");
    if (
      input.maxAttempts !== undefined &&
      (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0)
    )
      throw new TypeError("maxAttempts must be a positive safe integer");
    const record: MutableJobRecord = {
      id: input.id,
      kind: input.kind,
      payload: copyPayload(input.payload),
      ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId }),
      attempts,
      ...(input.maxAttempts === undefined
        ? {}
        : { maxAttempts: input.maxAttempts }),
      availableAt: input.availableAt ?? this.#now().toISOString(),
      state: attempts ? "retry" : "queued",
    };
    this.#jobs.set(record.id, record);
    return snapshot(record);
  }

  async lease(request: {
    readonly now: string;
    readonly leaseMs: number;
  }): Promise<LeasedJob | undefined> {
    const nowMs = new Date(request.now).getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError("Lease time is invalid");
    if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs <= 0)
      throw new TypeError("leaseMs must be a positive safe integer");
    const candidate = [...this.#jobs.values()]
      .filter(
        (job) =>
          ((job.state === "queued" || job.state === "retry") &&
            job.availableAt <= request.now) ||
          (job.state === "leased" &&
            job.leaseUntil !== undefined &&
            job.leaseUntil <= request.now),
      )
      .sort((left, right) =>
        left.availableAt < right.availableAt
          ? -1
          : left.availableAt > right.availableAt
            ? 1
            : left.id < right.id
              ? -1
              : left.id > right.id
                ? 1
                : 0,
      )[0];
    if (!candidate) return undefined;

    candidate.state = "leased";
    candidate.leaseToken = randomUUID();
    candidate.leaseUntil = new Date(nowMs + request.leaseMs).toISOString();
    const record = snapshot(candidate);
    return Object.freeze({
      id: record.id,
      kind: record.kind,
      payload: record.payload,
      ...(record.pluginId === undefined ? {} : { pluginId: record.pluginId }),
      attempts: record.attempts,
      ...(record.maxAttempts === undefined
        ? {}
        : { maxAttempts: record.maxAttempts }),
      availableAt: record.availableAt,
      leaseToken: record.leaseToken!,
      leaseUntil: record.leaseUntil!,
    });
  }

  async complete(job: LeasedJob) {
    const current = this.#leased(job);
    if (!current) return false;
    current.state = "completed";
    this.#clearLease(current);
    return true;
  }

  async retry(job: LeasedJob, transition: JobRetryTransition) {
    const current = this.#leased(job);
    if (!current) return false;
    current.state = "retry";
    current.attempts = transition.attempts;
    current.availableAt = transition.availableAt;
    current.lastError = transition.error;
    this.#clearLease(current);
    return true;
  }

  async deadLetter(job: LeasedJob, transition: JobFailureTransition) {
    const current = this.#leased(job);
    if (!current) return false;
    current.state = "dead-letter";
    current.attempts = transition.attempts;
    current.lastError = transition.error;
    this.#clearLease(current);
    return true;
  }

  async blockPluginMissing(job: LeasedJob, transition: JobFailureTransition) {
    const current = this.#leased(job);
    if (!current) return false;
    current.state = "blocked-plugin-missing";
    current.attempts = transition.attempts;
    current.lastError = transition.error;
    this.#clearLease(current);
    return true;
  }

  unblock(jobId: string, availableAt = this.#now().toISOString()): boolean {
    const job = this.#jobs.get(jobId);
    if (!job || job.state !== "blocked-plugin-missing") return false;
    job.state = "queued";
    job.availableAt = availableAt;
    job.lastError = undefined;
    return true;
  }

  get(jobId: string): MemoryJobRecord | undefined {
    const job = this.#jobs.get(jobId);
    return job ? snapshot(job) : undefined;
  }

  list(): readonly MemoryJobRecord[] {
    return Object.freeze(
      [...this.#jobs.values()]
        .sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        )
        .map(snapshot),
    );
  }

  #leased(job: LeasedJob): MutableJobRecord | undefined {
    const current = this.#jobs.get(job.id);
    return current?.state === "leased" && current.leaseToken === job.leaseToken
      ? current
      : undefined;
  }

  #clearLease(job: MutableJobRecord) {
    job.leaseToken = undefined;
    job.leaseUntil = undefined;
  }
}

export const MemorySchedulerLeasingAdapter = MemoryJobSchedulerAdapter;
