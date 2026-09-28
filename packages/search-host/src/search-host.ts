import {
  sameSearchSource,
  searchIndexNames,
  searchSourceKey,
  type SearchIndexNames,
} from "./naming.js";
import { SearchSourceRegistry } from "./registry.js";
import type {
  FederatedSearchResult,
  SearchFailureStage,
  SearchHydration,
  SearchProjection,
  SearchProvider,
  SearchProviderHit,
  SearchResultItem,
  SearchSource,
  SearchSourceDescriptor,
  SearchSourceFailure,
} from "./types.js";

export type SearchSourceReference =
  string | Pick<SearchSourceDescriptor, "pluginId" | "sourceId">;

export interface ProjectionUpsertRequest {
  readonly source: SearchSourceReference;
  readonly projections: readonly SearchProjection[];
}

export interface ProjectionDeleteRequest {
  readonly source: SearchSourceReference;
  readonly documentIds: readonly string[];
  readonly deletedAt?: Date;
}

export interface SearchRebuildRequest<TContext> {
  readonly source: SearchSourceReference;
  readonly context: TContext;
  readonly version?: string;
  readonly retainPrevious?: boolean;
  readonly signal?: AbortSignal;
}

export interface SearchRebuildResult {
  readonly alias: string;
  readonly indexName: string;
  readonly previousIndex?: string;
  readonly projectionCount: number;
}

export interface SearchIndexSwitchRequest {
  readonly source: SearchSourceReference;
  readonly indexName: string;
  readonly deletePrevious?: boolean;
}

export interface SearchIndexSwitchResult {
  readonly alias: string;
  readonly indexName: string;
  readonly previousIndex?: string;
}

export interface FederatedSearchRequest<TContext> {
  readonly query: string;
  readonly context: TContext;
  readonly sources?: readonly SearchSourceReference[];
  readonly offset?: number;
  readonly limit?: number;
}

export interface SearchHostOptions<TContext> {
  readonly registry?: SearchSourceRegistry<TContext>;
  readonly namespace?: string;
  readonly now?: () => Date;
  readonly rebuildBatchSize?: number;
}

export interface SearchHost<TContext = unknown> {
  readonly registry: SearchSourceRegistry<TContext>;
  indexNames(source: SearchSourceReference): SearchIndexNames;
  upsertProjections(request: ProjectionUpsertRequest): Promise<void>;
  deleteProjections(request: ProjectionDeleteRequest): Promise<void>;
  rebuild(
    request: SearchRebuildRequest<TContext>,
  ): Promise<SearchRebuildResult>;
  switchIndex(
    request: SearchIndexSwitchRequest,
  ): Promise<SearchIndexSwitchResult>;
  query<TValue = unknown>(
    request: FederatedSearchRequest<TContext>,
  ): Promise<FederatedSearchResult<TValue>>;
  dispose(): Promise<void>;
}

export class SearchSourceNotFoundError extends Error {
  constructor(readonly source: SearchSourceReference) {
    super(
      `Search source is not registered: ${
        typeof source === "string"
          ? source
          : `${source.pluginId}/${source.sourceId}`
      }`,
    );
    this.name = "SearchSourceNotFoundError";
  }
}

interface RankedValue {
  readonly id: string;
  readonly key: string;
  readonly rawScore: number;
  readonly source: SearchSourceDescriptor;
  readonly value: unknown;
}

interface SourceQueryResult {
  readonly values: readonly RankedValue[];
  readonly failure?: SearchSourceFailure;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyDescriptor(
  descriptor: SearchSourceDescriptor,
): SearchSourceDescriptor {
  return {
    pluginId: descriptor.pluginId,
    sourceId: descriptor.sourceId,
    schemaVersion: descriptor.schemaVersion,
    renderer: { ...descriptor.renderer },
  };
}

function validatePagination(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError("offset must be a non-negative safe integer");
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("limit must be a non-negative safe integer");
}

function compactIds(ids: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0)
      throw new TypeError("Document IDs must be non-empty strings");
    unique.add(id);
  }
  return [...unique].sort(compareText);
}

function validateProjection(projection: SearchProjection): void {
  if (typeof projection.id !== "string" || projection.id.trim().length === 0)
    throw new TypeError("Projection IDs must be non-empty strings");
  if (typeof projection.text !== "string")
    throw new TypeError("Projection text must be a string");
}

function hydrationMap(
  hydration: SearchHydration<unknown>,
): ReadonlyMap<string, unknown> {
  if (!Array.isArray(hydration))
    return hydration as ReadonlyMap<string, unknown>;
  const values = new Map<string, unknown>();
  for (const item of hydration) values.set(item.id, item.value);
  return values;
}

function abortError(): Error {
  const error = new Error("Search rebuild was aborted");
  error.name = "AbortError";
  return error;
}

class DefaultSearchHost<TContext> implements SearchHost<TContext> {
  readonly registry: SearchSourceRegistry<TContext>;
  readonly #provider: SearchProvider;
  readonly #namespace: string;
  readonly #now: () => Date;
  readonly #rebuildBatchSize: number;
  readonly #locks = new Map<string, Promise<void>>();
  #sequence = 0;

  constructor(provider: SearchProvider, options: SearchHostOptions<TContext>) {
    this.#provider = provider;
    this.registry = options.registry ?? new SearchSourceRegistry<TContext>();
    this.#namespace = options.namespace ?? "doca_search";
    this.#now = options.now ?? (() => new Date());
    this.#rebuildBatchSize = options.rebuildBatchSize ?? 100;
    if (
      !Number.isSafeInteger(this.#rebuildBatchSize) ||
      this.#rebuildBatchSize < 1
    )
      throw new RangeError("rebuildBatchSize must be a positive safe integer");
  }

  indexNames(source: SearchSourceReference): SearchIndexNames {
    return searchIndexNames(
      this.#requireSource(source).descriptor,
      this.#namespace,
    );
  }

  async upsertProjections(request: ProjectionUpsertRequest): Promise<void> {
    const source = this.#requireSource(request.source);
    const key = searchSourceKey(source.descriptor);
    const projections = [...request.projections];
    for (const projection of projections) validateProjection(projection);
    await this.#exclusive(key, async () => {
      const indexName = await this.#ensureIndex(source);
      await this.#provider.upsertProjections(indexName, projections);
      await this.#provider.deleteTombstones(
        key,
        projections.map((projection) => projection.id),
      );
    });
  }

  async deleteProjections(request: ProjectionDeleteRequest): Promise<void> {
    const source = this.#requireSource(request.source);
    const key = searchSourceKey(source.descriptor);
    const documentIds = compactIds(request.documentIds);
    await this.#exclusive(key, async () => {
      await this.#provider.putTombstones(
        documentIds.map((documentId) => ({
          sourceKey: key,
          documentId,
          deletedAt: (request.deletedAt ?? this.#now()).toISOString(),
        })),
      );
      const active = await this.#provider.resolveAlias(
        searchIndexNames(source.descriptor, this.#namespace).alias,
      );
      if (active) await this.#provider.deleteProjections(active, documentIds);
    });
  }

  async rebuild(
    request: SearchRebuildRequest<TContext>,
  ): Promise<SearchRebuildResult> {
    const source = this.#requireSource(request.source);
    if (!source.projections)
      throw new TypeError(
        `Search source ${searchSourceKey(
          source.descriptor,
        )} does not provide projections()`,
      );
    const key = searchSourceKey(source.descriptor);
    return this.#exclusive(key, async () => {
      if (request.signal?.aborted) throw abortError();
      const names = searchIndexNames(source.descriptor, this.#namespace);
      const version = request.version ?? this.#nextVersion("rebuild");
      const indexName = names.version(version);
      let created = false;
      let published = false;
      try {
        await this.#provider.createIndex(indexName, source.descriptor);
        created = true;
        const iterable = await source.projections!({
          context: request.context,
          signal: request.signal,
        });
        let count = 0;
        let batch: SearchProjection[] = [];
        const flush = async () => {
          if (!batch.length) return;
          await this.#provider.upsertProjections(indexName, batch);
          batch = [];
        };
        for await (const output of iterable) {
          if (request.signal?.aborted) throw abortError();
          const projections = Array.isArray(output) ? output : [output];
          for (const projection of projections) {
            validateProjection(projection);
            batch.push(projection);
            count++;
            if (batch.length >= this.#rebuildBatchSize) await flush();
          }
        }
        await flush();
        if (request.signal?.aborted) throw abortError();
        const tombstones = await this.#provider.listTombstones(key);
        if (tombstones.length)
          await this.#provider.deleteProjections(
            indexName,
            tombstones.map((tombstone) => tombstone.documentId),
          );
        const switched = await this.#provider.swapAlias(
          names.alias,
          indexName,
        );
        published = true;
        if (
          switched.previousIndex &&
          switched.previousIndex !== switched.activeIndex &&
          !request.retainPrevious
        )
          await this.#provider.deleteIndex(switched.previousIndex);
        return {
          alias: names.alias,
          indexName: switched.activeIndex,
          previousIndex: switched.previousIndex,
          projectionCount: count,
        };
      } catch (error) {
        if (created && !published) await this.#provider.deleteIndex(indexName);
        throw error;
      }
    });
  }

  async switchIndex(
    request: SearchIndexSwitchRequest,
  ): Promise<SearchIndexSwitchResult> {
    const source = this.#requireSource(request.source);
    const key = searchSourceKey(source.descriptor);
    return this.#exclusive(key, async () => {
      const metadata = await this.#provider.inspectIndex(request.indexName);
      if (!metadata)
        throw new Error(`Search index does not exist: ${request.indexName}`);
      if (!sameSearchSource(metadata.descriptor, source.descriptor))
        throw new Error(
          `Search index ${request.indexName} belongs to a different source or schema`,
        );
      const alias = searchIndexNames(source.descriptor, this.#namespace).alias;
      const switched = await this.#provider.swapAlias(
        alias,
        request.indexName,
      );
      if (
        request.deletePrevious &&
        switched.previousIndex &&
        switched.previousIndex !== switched.activeIndex
      )
        await this.#provider.deleteIndex(switched.previousIndex);
      return {
        alias,
        indexName: switched.activeIndex,
        previousIndex: switched.previousIndex,
      };
    });
  }

  async query<TValue = unknown>(
    request: FederatedSearchRequest<TContext>,
  ): Promise<FederatedSearchResult<TValue>> {
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    validatePagination(offset, limit);
    const sources = request.sources
      ? [
          ...new Map(
            request.sources.map((reference) => {
              const source = this.#requireSource(reference);
              return [searchSourceKey(source.descriptor), source] as const;
            }),
          ).values(),
        ]
      : this.registry.list();
    const sourceResults = await Promise.all(
      sources.map((source) => this.#querySource(source, request)),
    );
    const failures = sourceResults
      .flatMap((result) => (result.failure ? [result.failure] : []))
      .sort((left, right) => {
        const sourceOrder = compareText(
          searchSourceKey(left.source),
          searchSourceKey(right.source),
        );
        return sourceOrder || compareText(left.stage, right.stage);
      });
    const ranked: SearchResultItem<unknown>[] = [];
    for (const result of sourceResults) {
      if (!result.values.length) continue;
      const scores = result.values.map((value) => value.rawScore);
      const minimum = Math.min(...scores);
      const maximum = Math.max(...scores);
      for (const value of result.values) {
        const score =
          maximum === minimum
            ? 1
            : (value.rawScore - minimum) / (maximum - minimum);
        ranked.push({
          id: value.id,
          source: value.source,
          renderer: { ...value.source.renderer },
          providerScore: value.rawScore,
          score,
          value: value.value,
        });
      }
    }
    ranked.sort((left, right) => {
      const scoreOrder = right.score - left.score;
      if (scoreOrder) return scoreOrder;
      const sourceOrder = compareText(
        searchSourceKey(left.source),
        searchSourceKey(right.source),
      );
      return sourceOrder || compareText(left.id, right.id);
    });
    return {
      items: ranked.slice(offset, offset + limit) as SearchResultItem<TValue>[],
      failures,
      offset,
      limit,
      total: ranked.length,
    };
  }

  async dispose(): Promise<void> {
    await this.registry.dispose();
  }

  async #querySource(
    source: SearchSource<TContext, unknown>,
    request: FederatedSearchRequest<TContext>,
  ): Promise<SourceQueryResult> {
    const descriptor = copyDescriptor(source.descriptor);
    const fail = (
      stage: SearchFailureStage,
      error: unknown,
    ): SourceQueryResult => ({
      values: [],
      failure: { source: descriptor, stage, error },
    });
    const names = searchIndexNames(descriptor, this.#namespace);
    let providerQuery;
    try {
      providerQuery = source.prepareQuery
        ? await source.prepareQuery({
            context: request.context,
            query: request.query,
          })
        : { query: request.query };
      if (providerQuery === null) return { values: [] };
      if (
        providerQuery.limit !== undefined &&
        (!Number.isSafeInteger(providerQuery.limit) || providerQuery.limit < 0)
      )
        throw new RangeError(
          "Search provider query limit must be a non-negative safe integer",
        );
    } catch (error) {
      return fail("prepare", error);
    }
    let indexName: string | undefined;
    try {
      indexName = await this.#provider.resolveAlias(names.alias);
      if (!indexName) return { values: [] };
      const metadata = await this.#provider.inspectIndex(indexName);
      if (!metadata || !sameSearchSource(metadata.descriptor, descriptor))
        throw new Error(
          `Active index is missing or incompatible: ${indexName}`,
        );
    } catch (error) {
      return fail("index", error);
    }

    let hits: readonly SearchProviderHit[];
    try {
      const raw = await this.#provider.queryIndex(indexName, providerQuery);
      const scopedCandidates = providerQuery.candidateIds
        ? new Set(compactIds(providerQuery.candidateIds))
        : undefined;
      const byId = new Map<string, number>();
      for (const hit of raw) {
        if (
          typeof hit.id !== "string" ||
          hit.id.trim().length === 0 ||
          !Number.isFinite(hit.score)
        )
          throw new TypeError("Search provider returned an invalid hit");
        if (scopedCandidates && !scopedCandidates.has(hit.id)) continue;
        byId.set(hit.id, Math.max(byId.get(hit.id) ?? -Infinity, hit.score));
      }
      hits = [...byId.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort(
          (left, right) =>
            right.score - left.score || compareText(left.id, right.id),
        );
    } catch (error) {
      return fail("query", error);
    }

    let authorized: readonly SearchProviderHit[];
    try {
      const candidateIds = hits.map((hit) => hit.id);
      const candidates = new Set(candidateIds);
      const allowed = new Set(
        await source.authorize({
          context: request.context,
          query: request.query,
          candidateIds,
        }),
      );
      authorized = hits.filter(
        (hit) => candidates.has(hit.id) && allowed.has(hit.id),
      );
    } catch (error) {
      return fail("authorize", error);
    }

    try {
      const ids = authorized.map((hit) => hit.id);
      const hydration = hydrationMap(
        await source.hydrate({
          context: request.context,
          query: request.query,
          ids,
        }),
      );
      const key = searchSourceKey(descriptor);
      return {
        values: authorized.flatMap((hit): RankedValue[] =>
          hydration.has(hit.id)
            ? [
                {
                  id: hit.id,
                  key,
                  rawScore: hit.score,
                  source: descriptor,
                  value: hydration.get(hit.id),
                },
              ]
            : [],
        ),
      };
    } catch (error) {
      return fail("hydrate", error);
    }
  }

  #requireSource(source: SearchSourceReference): SearchSource<TContext, any> {
    const registered = this.registry.get(source);
    if (!registered) throw new SearchSourceNotFoundError(source);
    return registered;
  }

  async #ensureIndex(source: SearchSource<TContext, unknown>): Promise<string> {
    const names = searchIndexNames(source.descriptor, this.#namespace);
    const active = await this.#provider.resolveAlias(names.alias);
    if (active) {
      const metadata = await this.#provider.inspectIndex(active);
      if (metadata && sameSearchSource(metadata.descriptor, source.descriptor))
        return active;
    }
    const indexName = names.version(this.#nextVersion("bootstrap"));
    await this.#provider.createIndex(indexName, source.descriptor);
    return (await this.#provider.swapAlias(names.alias, indexName)).activeIndex;
  }

  #nextVersion(prefix: string): string {
    this.#sequence++;
    return `${prefix}-${this.#now().getTime().toString(36)}-${this.#sequence.toString(
      36,
    )}`;
  }

  async #exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(action);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }
}

export function createSearchHost<TContext = unknown>(
  provider: SearchProvider,
  options: SearchHostOptions<TContext> = {},
): SearchHost<TContext> {
  return new DefaultSearchHost(provider, options);
}
