import type { JsonObject, JsonValue, ObjectConfigSchema } from "./index.js";
export type ResourceSort = "updated" | "name" | "usage" | "popular";
export interface ResourceType {
  readonly id: string;
  readonly version: number;
}
export interface CreationResourceRef {
  readonly providerId: string;
  readonly id: string;
  readonly revision: string;
}
export interface ResourceTag {
  readonly id: string;
  readonly title: { readonly zh: string; readonly en: string };
}
export interface ResourceFilter {
  readonly contract?: ResourceType;
  readonly contentType?: ResourceType;
  readonly query?: string;
  readonly tags?: readonly string[];
  /** Omitted means all sources; an empty array means no sources. */
  readonly providerIds?: readonly string[];
  readonly sort?: ResourceSort;
}
export interface ResourceSearch extends ResourceFilter {
  readonly cursor?: string | null;
  readonly limit?: number;
}
export interface CreationResourceCard {
  readonly ref: CreationResourceRef;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
  /** Required for templates: actual style thumbnail, PNG/JPEG/WebP data URL. Optional for materials. */
  readonly preview?: string;
  readonly contract: ResourceType;
  readonly contentType: ResourceType;
  readonly parameters: ObjectConfigSchema;
  readonly usage?: number;
  readonly popularity?: number;
  readonly license: string;
}
export interface ResourceProviderDescriptor {
  readonly id: string;
  readonly pluginId: string;
  readonly version: 1 | 2;
  readonly title: { readonly zh: string; readonly en: string };
  readonly contracts: readonly ResourceType[];
  readonly contentTypes: readonly ResourceType[];
  readonly sorts: readonly ResourceSort[];
  readonly description?: { readonly zh: string; readonly en: string };
  /** Declare together with the provider's retrieve method. */
  readonly retrieval?: { readonly modes: readonly ResourceRetrievalMode[] };
}
export interface ResourcePage<T = CreationResourceResult> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly failures: readonly string[];
}
export interface TemplatePayload {
  readonly contract: ResourceType;
  readonly contentType: ResourceType;
  readonly content: JsonValue;
  /** Replace exact material:key strings with target-document asset IDs. */
  readonly assets: readonly {
    readonly key: string;
    readonly ref: CreationResourceRef;
  }[];
}
export interface TemplateSelection {
  readonly ref: CreationResourceRef;
  readonly parameters: JsonObject;
}
export interface ResourceConsumerDescriptor {
  readonly version: 1;
  readonly inputSchema: ObjectConfigSchema;
  readonly id: string;
  readonly pluginId: string;
  readonly title: { readonly zh: string; readonly en: string };
  readonly accepts: readonly {
    readonly contract: ResourceType;
    readonly contentType: ResourceType;
  }[];
}

export type ResourceRetrievalMode = "keyword" | "semantic" | "hybrid";
export interface ResourceSourceInfo {
  readonly id: string;
  readonly pluginId: string;
  readonly title: { readonly zh: string; readonly en: string };
  readonly description?: { readonly zh: string; readonly en: string };
}
/** Host-enriched metadata; providers return CreationResourceCard. */
export interface CreationResourceResult extends CreationResourceCard {
  readonly source: ResourceSourceInfo;
}
export interface ResourceRetrieval extends Omit<
  ResourceFilter,
  "query" | "sort"
> {
  readonly query: string;
  readonly mode?: "auto" | ResourceRetrievalMode;
  readonly topK?: number;
}
/** Lightweight candidates in provider relevance order; no previews or bodies. */
export interface ResourceRetrievalHit {
  readonly ref: CreationResourceRef;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly contract: ResourceType;
  readonly contentType: ResourceType;
  readonly matchText?: string;
}
export interface ResourceRetrievalResult extends ResourceRetrievalHit {
  readonly source: ResourceSourceInfo;
  /** Rank within this source, never a globally comparable relevance score. */
  readonly rank: number;
}
export interface ResourceRetrievalPage<T = ResourceRetrievalResult> {
  readonly items: readonly T[];
  readonly sources: readonly {
    readonly source: ResourceSourceInfo;
    readonly mode: ResourceRetrievalMode;
    readonly count: number;
    readonly truncated: boolean;
  }[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly failures: readonly {
    readonly providerId: string;
    readonly code: "unsupported" | "failed" | "timeout";
  }[];
}

export interface TemplateReadResult extends TemplatePayload {
  readonly source: ResourceSourceInfo;
}

/** A material may be ungrouped or referenced by multiple collections in its source. */
export interface MaterialCard extends CreationResourceCard {
  readonly collections: readonly CreationResourceRef[];
}
export interface MaterialResult extends MaterialCard {
  readonly source: ResourceSourceInfo;
}
export interface MaterialRetrievalHit extends ResourceRetrievalHit {
  readonly collections: readonly CreationResourceRef[];
}
export interface MaterialRetrievalResult extends MaterialRetrievalHit {
  readonly source: ResourceSourceInfo;
  readonly rank: number;
}
/** Collection metadata only. Members are fetched separately, never embedded. */
export interface MaterialCollectionCard {
  readonly ref: CreationResourceRef;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
  readonly preview?: string;
  readonly contracts: readonly ResourceType[];
  readonly contentTypes: readonly ResourceType[];
  /** Optional number of members visible to the current principal. */
  readonly count?: number;
  readonly usage?: number;
  readonly popularity?: number;
}
export interface MaterialCollectionResult extends MaterialCollectionCard {
  readonly source: ResourceSourceInfo;
}
export interface MaterialCollectionRetrievalHit extends Omit<
  MaterialCollectionCard,
  "preview" | "updatedAt" | "usage" | "popularity"
> {
  readonly matchText?: string;
}
export interface MaterialCollectionRetrievalResult extends MaterialCollectionRetrievalHit {
  readonly source: ResourceSourceInfo;
  readonly rank: number;
}
export interface MaterialFilter extends ResourceFilter {
  /** OR membership, scoped to the owning source; omitted = all, [] = none. */
  readonly collectionRefs?: readonly CreationResourceRef[];
}
export interface MaterialQueryFilter extends MaterialFilter {
  /** Independent collection tags; asset tags never inherit these tags. */
  readonly collectionTags?: readonly string[];
}
export interface MaterialSearch extends MaterialQueryFilter {
  readonly target?: "all" | "materials" | "collections";
  /** Independent cursors; limit applies separately to each result group. */
  readonly cursors?: {
    readonly materials?: string | null;
    readonly collections?: string | null;
  };
  readonly limit?: number;
}
export interface MaterialRetrieval extends Omit<
  MaterialQueryFilter,
  "query" | "sort"
> {
  readonly query: string;
  readonly mode?: "auto" | ResourceRetrievalMode;
  /** Per result group, bounded at 20. */
  readonly topK?: number;
  readonly target?: "all" | "materials" | "collections";
}
export interface MaterialSearchPage {
  readonly materials: ResourcePage<MaterialResult>;
  readonly collections: ResourcePage<MaterialCollectionResult>;
}
export interface MaterialRetrievalPage {
  readonly materials: ResourceRetrievalPage<MaterialRetrievalResult>;
  readonly collections: ResourceRetrievalPage<MaterialCollectionRetrievalResult>;
}
export interface ResourceTagPage {
  readonly items: readonly ResourceTag[];
  readonly complete: boolean;
  readonly failures: readonly string[];
}
export interface MaterialTagPage {
  readonly materials: ResourceTagPage;
  readonly collections: ResourceTagPage;
}
export interface MaterialCollectionItems extends Omit<
  ResourceSearch,
  "contract" | "contentType"
> {
  readonly ref: CreationResourceRef;
  readonly contract?: ResourceType;
  readonly contentType?: ResourceType;
}
export interface MaterialProviderDescriptor extends ResourceProviderDescriptor {
  readonly version: 2;
  /** Explicit null declares a source with only individual materials. */
  readonly collections: {
    readonly retrieval?: { readonly modes: readonly ResourceRetrievalMode[] };
  } | null;
}
