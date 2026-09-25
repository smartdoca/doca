export type MaybePromise<T> = T | Promise<T>;

export interface SearchResultRenderer {
  readonly kind: string;
  readonly version?: number;
}

export interface SearchSourceDescriptor {
  readonly pluginId: string;
  readonly sourceId: string;
  readonly schemaVersion: number;
  readonly renderer: SearchResultRenderer;
}

export interface SearchProjection {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SearchAuthorizationRequest<TContext> {
  readonly context: TContext;
  readonly query: string;
  readonly candidateIds: readonly string[];
}

export interface SearchHydrationRequest<TContext> {
  readonly context: TContext;
  readonly query: string;
  readonly ids: readonly string[];
}

export interface SearchProjectionSnapshotRequest<TContext> {
  readonly context: TContext;
  readonly signal?: AbortSignal;
}

export interface SearchQueryPreparationRequest<TContext> {
  readonly context: TContext;
  readonly query: string;
}

export interface HydratedSearchValue<TValue = unknown> {
  readonly id: string;
  readonly value: TValue;
}

export type SearchHydration<TValue = unknown> =
  ReadonlyMap<string, TValue> | readonly HydratedSearchValue<TValue>[];

export type SearchProjectionBatch =
  SearchProjection | readonly SearchProjection[];

/**
 * A source owns authorization and hydration. The host deliberately receives
 * only opaque IDs from an index, so indexed fields can never bypass the source.
 */
export interface SearchSource<TContext = unknown, TValue = unknown> {
  readonly descriptor: SearchSourceDescriptor;
  /**
   * Narrows provider work to the source-owned query scope. Returning null
   * makes the source inapplicable to this request. Authorization still runs
   * after the provider returns and is never replaced by candidateIds.
   */
  prepareQuery?(
    request: SearchQueryPreparationRequest<TContext>,
  ): MaybePromise<SearchProviderQuery | null>;
  authorize(
    request: SearchAuthorizationRequest<TContext>,
  ): MaybePromise<Iterable<string>>;
  hydrate(
    request: SearchHydrationRequest<TContext>,
  ): MaybePromise<SearchHydration<TValue>>;
  projections?(
    request: SearchProjectionSnapshotRequest<TContext>,
  ):
    | Iterable<SearchProjectionBatch>
    | AsyncIterable<SearchProjectionBatch>
    | Promise<
        Iterable<SearchProjectionBatch> | AsyncIterable<SearchProjectionBatch>
      >;
}

export interface SearchSourceEffectResource<
  TContext = unknown,
  TValue = unknown,
> {
  readonly source: SearchSource<TContext, TValue>;
  readonly dispose?: () => MaybePromise<void>;
}

export interface SearchSourceEffect<TContext = unknown, TValue = unknown> {
  acquire(): MaybePromise<SearchSourceEffectResource<TContext, TValue>>;
}

export interface SearchIndexMetadata {
  readonly name: string;
  readonly descriptor: SearchSourceDescriptor;
  readonly createdAt: string;
}

export interface SearchIndexLifecycle {
  createIndex(name: string, descriptor: SearchSourceDescriptor): Promise<void>;
  deleteIndex(name: string): Promise<void>;
  inspectIndex(name: string): Promise<SearchIndexMetadata | undefined>;
  resolveAlias(alias: string): Promise<string | undefined>;
  swapAlias(alias: string, indexName: string): Promise<SearchAliasSwap>;
}

/**
 * Providers may implement aliases as pointers or as stable physical indexes
 * whose contents are atomically swapped. activeIndex makes both models
 * explicit to the host.
 */
export interface SearchAliasSwap {
  readonly activeIndex: string;
  readonly previousIndex?: string;
}

export interface SearchProjectionIndex {
  upsertProjections(
    indexName: string,
    projections: readonly SearchProjection[],
  ): Promise<void>;
  deleteProjections(
    indexName: string,
    documentIds: readonly string[],
  ): Promise<void>;
}

export interface SearchProviderHit {
  readonly id: string;
  readonly score: number;
}

export interface SearchProviderQuery {
  readonly query: string;
  readonly candidateIds?: readonly string[];
  readonly limit?: number;
  readonly semantic?: boolean;
  readonly rankingScoreThreshold?: number;
}

export interface SearchIndexQuery {
  queryIndex(
    indexName: string,
    request: SearchProviderQuery,
  ): Promise<readonly SearchProviderHit[]>;
}

export interface SearchTombstone {
  readonly sourceKey: string;
  readonly documentId: string;
  readonly deletedAt: string;
}

export interface SearchTombstoneStore {
  putTombstones(tombstones: readonly SearchTombstone[]): Promise<void>;
  deleteTombstones(
    sourceKey: string,
    documentIds: readonly string[],
  ): Promise<void>;
  listTombstones(sourceKey: string): Promise<readonly SearchTombstone[]>;
}

/**
 * Concrete engines implement this boundary. SearchHost has no dependency on
 * any engine SDK or wire format.
 */
export interface SearchProvider
  extends
    SearchIndexLifecycle,
    SearchProjectionIndex,
    SearchIndexQuery,
    SearchTombstoneStore {}

export interface SearchResultItem<TValue = unknown> {
  readonly id: string;
  readonly source: SearchSourceDescriptor;
  readonly renderer: SearchResultRenderer;
  /** Provider-local score retained for source-specific reranking. */
  readonly providerScore: number;
  /** Per-source normalized score used for federation. */
  readonly score: number;
  readonly value: TValue;
}

export type SearchFailureStage =
  | "index"
  | "prepare"
  | "query"
  | "authorize"
  | "hydrate";

export interface SearchSourceFailure {
  readonly source: SearchSourceDescriptor;
  readonly stage: SearchFailureStage;
  readonly error: unknown;
}

export interface FederatedSearchResult<TValue = unknown> {
  readonly items: readonly SearchResultItem<TValue>[];
  readonly failures: readonly SearchSourceFailure[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}
