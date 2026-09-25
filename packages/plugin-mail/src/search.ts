import type {
  SearchAuthorizationRequest,
  SearchHydration,
  SearchHydrationRequest,
  SearchProjectionBatch,
  SearchProjectionSnapshotRequest,
  SearchSource,
} from "@doca/search-host";

export interface MailSearchAdapter<TContext, TValue> {
  authorize(
    request: SearchAuthorizationRequest<TContext>,
  ): Iterable<string> | Promise<Iterable<string>>;
  hydrate(
    request: SearchHydrationRequest<TContext>,
  ): SearchHydration<TValue> | Promise<SearchHydration<TValue>>;
  projections(
    request: SearchProjectionSnapshotRequest<TContext>,
  ):
    | Iterable<SearchProjectionBatch>
    | AsyncIterable<SearchProjectionBatch>
    | Promise<
        Iterable<SearchProjectionBatch> | AsyncIterable<SearchProjectionBatch>
      >;
}

/**
 * SearchHost adapter for mail. Candidate authorization and hydration remain
 * mail-owned, so an index never becomes an authorization source.
 */
export function createMailSearchSource<TContext, TValue>(
  adapter: MailSearchAdapter<TContext, TValue>,
): SearchSource<TContext, TValue> {
  return {
    descriptor: {
      pluginId: "doca.mail",
      sourceId: "messages",
      schemaVersion: 1,
      renderer: {
        kind: "doca.mail.search-result",
        version: 1,
      },
    },
    authorize: (request) => adapter.authorize(request),
    hydrate: (request) => adapter.hydrate(request),
    projections: (request) => adapter.projections(request),
  };
}
