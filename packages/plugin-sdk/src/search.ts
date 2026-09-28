import { defineService } from "./index.js";
import type { PluginRequestContext } from "./platform.js";
import type { SearchSource, SearchProjection, SearchSourceDescriptor, FederatedSearchResult, SearchRebuildResult } from "@smartdoca/search-host";
export type * from "@smartdoca/search-host";
export interface PluginSearchContext { readonly principalId: string | null; readonly signal?: AbortSignal }
export interface PluginSearchService {
  register(source: SearchSource<PluginSearchContext>): () => void;
  upsert(source: SearchSourceDescriptor, projections: readonly SearchProjection[]): Promise<void>;
  delete(source: SearchSourceDescriptor, ids: readonly string[]): Promise<void>;
  rebuild(source: SearchSourceDescriptor, signal?: AbortSignal): Promise<SearchRebuildResult>;
  query(context: PluginRequestContext, input: { source: SearchSourceDescriptor; query: string; offset?: number; limit?: number }): Promise<FederatedSearchResult>;
}
export const searchServiceToken = defineService<PluginSearchService>("search.v1");
