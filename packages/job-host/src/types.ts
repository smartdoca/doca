export type MaybePromise<T> = T | Promise<T>;

export type JobJson =
  | null
  | boolean
  | number
  | string
  | readonly JobJson[]
  | { readonly [key: string]: JobJson };

export type SchedulableJobState = "queued" | "retry";
export type JobState =
  | SchedulableJobState
  | "leased"
  | "completed"
  | "dead-letter"
  | "blocked-plugin-missing";

export interface JobEnvelope<TPayload extends JobJson = JobJson> {
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly pluginId?: string;
  /** Number of failed deliveries before this lease. */
  readonly attempts: number;
  readonly maxAttempts?: number;
  readonly availableAt: string;
}

export interface LeasedJob<
  TPayload extends JobJson = JobJson,
> extends JobEnvelope<TPayload> {
  readonly leaseToken: string;
  readonly leaseUntil: string;
}

export interface JobLeaseRequest {
  readonly now: string;
  readonly leaseMs: number;
}

export interface JobFailureTransition {
  readonly attempts: number;
  readonly error: string;
}

export interface JobRetryTransition extends JobFailureTransition {
  readonly availableAt: string;
}

/**
 * Storage boundary for the host. Implementations own atomic lease acquisition
 * and must reject stale transition calls by lease token.
 */
export interface JobSchedulerAdapter {
  lease(request: JobLeaseRequest): Promise<LeasedJob | undefined>;
  complete(job: LeasedJob): Promise<boolean | void>;
  retry(
    job: LeasedJob,
    transition: JobRetryTransition,
  ): Promise<boolean | void>;
  deadLetter(
    job: LeasedJob,
    transition: JobFailureTransition,
  ): Promise<boolean | void>;
  blockPluginMissing(
    job: LeasedJob,
    transition: JobFailureTransition,
  ): Promise<boolean | void>;
}

export type SchedulerLeasingAdapter = JobSchedulerAdapter;

export interface JobRunContext<TContext> {
  readonly host: TContext;
  readonly job: LeasedJob;
  readonly signal: AbortSignal;
}

export interface JobHandlerDefinition<
  TContext = unknown,
  TPayload extends JobJson = JobJson,
> {
  readonly kind: string;
  /** Owning plugin. Used to reject a lease routed to the wrong owner. */
  readonly pluginId?: string;
  readonly run: (
    payload: TPayload,
    context: JobRunContext<TContext>,
  ) => MaybePromise<void>;
}

export type JobHandler<TContext = unknown> = JobHandlerDefinition<
  TContext,
  JobJson
>;

export type JobRunResult =
  | { readonly state: "idle" }
  | { readonly state: "completed"; readonly job: LeasedJob }
  | {
      readonly state: "retry";
      readonly job: LeasedJob;
      readonly attempts: number;
      readonly availableAt: string;
      readonly error: string;
    }
  | {
      readonly state: "dead-letter";
      readonly job: LeasedJob;
      readonly attempts: number;
      readonly error: string;
    }
  | {
      readonly state: "blocked-plugin-missing";
      readonly job: LeasedJob;
      readonly attempts: number;
      readonly error: string;
    };
