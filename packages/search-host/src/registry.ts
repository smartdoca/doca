import { searchSourceKey, validateSearchSourceDescriptor } from "./naming.js";
import type {
  MaybePromise,
  SearchSource,
  SearchSourceEffect,
} from "./types.js";

export class DuplicateSearchSourceError extends Error {
  readonly sourceKey: string;

  constructor(sourceKey: string) {
    super(`Search source is already registered: ${sourceKey}`);
    this.name = "DuplicateSearchSourceError";
    this.sourceKey = sourceKey;
  }
}

export class DisposedSearchSourceRegistryError extends Error {
  constructor() {
    super("Search source registry has been disposed");
    this.name = "DisposedSearchSourceRegistryError";
  }
}

export interface SearchSourceLease<TContext = unknown, TValue = unknown> {
  readonly key: string;
  readonly source: SearchSource<TContext, TValue>;
  dispose(): Promise<void>;
}

interface RegistryEntry<TContext> {
  readonly token: symbol;
  readonly source: SearchSource<TContext, any>;
  release(): Promise<void>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The registry owns each installed effect until its lease or the registry is
 * disposed. Duplicate effect acquisitions are rolled back immediately.
 */
export class SearchSourceRegistry<TContext = unknown> {
  readonly #entries = new Map<string, RegistryEntry<TContext>>();
  #disposed = false;

  register<TValue>(
    source: SearchSource<TContext, TValue>,
    cleanup?: () => MaybePromise<void>,
  ): SearchSourceLease<TContext, TValue> {
    if (this.#disposed) throw new DisposedSearchSourceRegistryError();
    validateSearchSourceDescriptor(source.descriptor);
    if (
      typeof source.authorize !== "function" ||
      typeof source.hydrate !== "function"
    )
      throw new TypeError("Search sources must provide authorize and hydrate");

    const key = searchSourceKey(source.descriptor);
    if (this.#entries.has(key)) throw new DuplicateSearchSourceError(key);

    const token = Symbol(key);
    let active = true;
    const release = async () => {
      if (!active) return;
      active = false;
      const current = this.#entries.get(key);
      if (current?.token === token) this.#entries.delete(key);
      await cleanup?.();
    };
    this.#entries.set(key, { token, source, release });
    return { key, source, dispose: release };
  }

  async install<TValue>(
    effect: SearchSourceEffect<TContext, TValue>,
  ): Promise<SearchSourceLease<TContext, TValue>> {
    const resource = await effect.acquire();
    try {
      return this.register(resource.source, resource.dispose);
    } catch (error) {
      if (!resource.dispose) throw error;
      try {
        await resource.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          "Search source installation and rollback both failed",
        );
      }
      throw error;
    }
  }

  get(
    source:
      | string
      | Pick<SearchSource<TContext>["descriptor"], "pluginId" | "sourceId">,
  ): SearchSource<TContext, any> | undefined {
    const key = typeof source === "string" ? source : searchSourceKey(source);
    return this.#entries.get(key)?.source;
  }

  list(): readonly SearchSource<TContext, any>[] {
    return [...this.#entries.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, entry]) => entry.source);
  }

  get size(): number {
    return this.#entries.size;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    const results = await Promise.allSettled(
      entries.map((entry) => entry.release()),
    );
    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(failures, "Failed to dispose search sources");
  }
}
