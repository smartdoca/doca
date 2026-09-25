import type { JobHandler } from "./types.js";

export class DuplicateJobKindError extends Error {
  readonly name = "DuplicateJobKindError";
  readonly code = "DUPLICATE_JOB_KIND";

  constructor(readonly kind: string) {
    super(`Job kind "${kind}" is already registered`);
  }
}

export class DisposedJobHandlerRegistryError extends Error {
  readonly name = "DisposedJobHandlerRegistryError";

  constructor() {
    super("Job handler registry has been disposed");
  }
}

export interface JobHandlerDisposer {
  (): void;
  readonly kind: string;
  dispose(): void;
}

interface RegistryEntry<TContext> {
  readonly token: symbol;
  readonly handler: JobHandler<TContext>;
  readonly cleanup?: () => void;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * An instance-scoped, effect-owned handler registry. The disposer returned by
 * register is the only capability that can remove that exact registration.
 */
export class JobHandlerRegistry<TContext = unknown> {
  readonly #entries = new Map<string, RegistryEntry<TContext>>();
  #disposed = false;

  register(
    handler: JobHandler<TContext>,
    cleanup?: () => void,
  ): JobHandlerDisposer {
    if (this.#disposed) throw new DisposedJobHandlerRegistryError();
    if (!handler.kind) throw new TypeError("Job kind must not be empty");
    if (typeof handler.run !== "function")
      throw new TypeError(`Job handler "${handler.kind}" must provide run`);
    if (this.#entries.has(handler.kind))
      throw new DuplicateJobKindError(handler.kind);

    const token = Symbol(handler.kind);
    this.#entries.set(handler.kind, {
      token,
      handler: Object.freeze({ ...handler }),
      cleanup,
    });
    let disposed = false;
    const release = (() => {
      if (disposed) return;
      disposed = true;
      const current = this.#entries.get(handler.kind);
      if (current?.token !== token) return;
      this.#entries.delete(handler.kind);
      current.cleanup?.();
    }) as JobHandlerDisposer;
    Object.defineProperties(release, {
      kind: { value: handler.kind, enumerable: true },
      dispose: { value: release },
    });
    return release;
  }

  get(kind: string): JobHandler<TContext> | undefined {
    return this.#entries.get(kind)?.handler;
  }

  has(kind: string): boolean {
    return this.#entries.has(kind);
  }

  list(): readonly JobHandler<TContext>[] {
    return Object.freeze(
      [...this.#entries.values()]
        .map((entry) => entry.handler)
        .sort((left, right) => compareText(left.kind, right.kind)),
    );
  }

  get size(): number {
    return this.#entries.size;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const entries = [...this.#entries.values()].reverse();
    this.#entries.clear();
    const failures: unknown[] = [];
    for (const entry of entries) {
      try {
        entry.cleanup?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Failed to dispose job handlers");
  }
}

export function createJobHandlerRegistry<TContext = unknown>() {
  return new JobHandlerRegistry<TContext>();
}
