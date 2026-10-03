import { defineService } from "./index.js";
import type { PluginRequestContext } from "./platform.js";
import type {
  JsonValue,
  MaterialCard,
  MaterialResult,
  MaterialRetrievalHit,
  MaterialCollectionCard,
  MaterialCollectionRetrievalHit,
  MaterialCollectionResult,
  MaterialFilter,
  MaterialQueryFilter,
  MaterialSearch,
  MaterialSearchPage,
  MaterialRetrieval,
  MaterialRetrievalPage,
  MaterialTagPage,
  MaterialCollectionItems,
  MaterialProviderDescriptor,
  ResourceProviderDescriptor,
  ResourceFilter,
  ResourceSearch,
  ResourcePage,
  CreationResourceRef,
  CreationResourceCard,
  CreationResourceResult,
  ResourceRetrieval,
  ResourceRetrievalHit,
  ResourceRetrievalMode,
  ResourceRetrievalPage,
  ResourceTag,
  TemplatePayload,
  TemplateReadResult,
  ResourceSourceInfo,
  TemplateSelection,
  ResourceConsumerDescriptor,
} from "@smartdoca/plugin-contracts";
export type * from "@smartdoca/plugin-contracts";
export interface ResourceProvider<
  C = CreationResourceCard,
  H = ResourceRetrievalHit,
  F extends ResourceFilter = ResourceFilter,
> extends ResourceProviderDescriptor {
  /** Optional indexed/remote retrieval; host never emulates it by paging search. */
  retrieve?(
    context: PluginRequestContext,
    input: Omit<F, "query" | "sort"> &
      ResourceRetrieval & {
        topK: number;
        mode: "auto" | ResourceRetrievalMode;
      },
  ): Promise<{
    items: readonly H[];
    mode: ResourceRetrievalMode;
    hasMore: boolean;
  }>;
  tags(
    context: PluginRequestContext,
    filter: F,
  ): Promise<readonly ResourceTag[]>;
  search(
    context: PluginRequestContext,
    input: F & { cursor: string | null; limit: number },
  ): Promise<{
    items: readonly C[];
    nextCursor: string | null;
  }>;
  /** Current permission check; return null when hidden/deleted. No body here. */
  describe(
    context: PluginRequestContext,
    ref: CreationResourceRef,
  ): Promise<C | null>;
}
export interface TemplateProvider extends ResourceProvider {
  readonly version: 1;
  read(
    context: PluginRequestContext,
    input: TemplateSelection,
  ): Promise<TemplatePayload>;
}
export type MaterialCollectionMethods = Pick<
  ResourceProvider<MaterialCollectionCard, MaterialCollectionRetrievalHit>,
  "tags" | "search" | "describe" | "retrieve" | "retrieval"
>;
export interface MaterialProvider extends ResourceProvider<
  MaterialCard,
  MaterialRetrievalHit,
  MaterialFilter
> {
  readonly version: 2;
  readonly collections: MaterialCollectionMethods | null;
  /** Import through files.v1 with this operationKey as its idempotencyKey. */
  import(
    context: PluginRequestContext,
    input: { ref: CreationResourceRef; operationKey: string },
  ): Promise<{ fileId: string }>;
}
export interface TemplateConsumer extends ResourceConsumerDescriptor {
  execute(
    context: PluginRequestContext,
    input: {
      template: TemplatePayload;
      selection: TemplateSelection;
      input: import("@smartdoca/plugin-contracts").JsonObject;
    },
  ): Promise<JsonValue>;
}
export interface ResourceDirectoryV1<P extends ResourceProvider> {
  register(provider: P): () => void;
  retrieve(
    context: PluginRequestContext,
    input: ResourceRetrieval,
  ): Promise<ResourceRetrievalPage>;
  providers(
    context: PluginRequestContext,
    filter: ResourceFilter,
  ): Promise<readonly ResourceProviderDescriptor[]>;
  tags(
    context: PluginRequestContext,
    filter: ResourceFilter,
  ): Promise<{
    items: readonly ResourceTag[];
    complete: boolean;
    failures: readonly string[];
  }>;
  search(
    context: PluginRequestContext,
    input: ResourceSearch,
  ): Promise<ResourcePage>;
  describe(
    context: PluginRequestContext,
    ref: CreationResourceRef,
  ): Promise<CreationResourceResult>;
}
export interface TemplatesServiceV1 extends ResourceDirectoryV1<TemplateProvider> {
  read(
    context: PluginRequestContext,
    input: TemplateSelection,
  ): Promise<TemplateReadResult>;
  registerConsumer(consumer: TemplateConsumer): () => void;
  consumers(
    context: PluginRequestContext,
  ): Promise<readonly ResourceConsumerDescriptor[]>;
  consume(
    context: PluginRequestContext,
    input: {
      consumerId: string;
      selection: TemplateSelection;
      input: import("@smartdoca/plugin-contracts").JsonObject;
    },
  ): Promise<JsonValue>;
}
export interface MaterialsServiceV2 {
  register(provider: MaterialProvider): () => void;
  providers(
    context: PluginRequestContext,
    filter: ResourceFilter,
  ): Promise<readonly MaterialProviderDescriptor[]>;
  tags(
    context: PluginRequestContext,
    filter: MaterialQueryFilter,
  ): Promise<MaterialTagPage>;
  search(
    context: PluginRequestContext,
    input: MaterialSearch,
  ): Promise<MaterialSearchPage>;
  retrieve(
    context: PluginRequestContext,
    input: MaterialRetrieval,
  ): Promise<MaterialRetrievalPage>;
  describe(
    context: PluginRequestContext,
    ref: CreationResourceRef,
  ): Promise<MaterialResult>;
  collectionDescribe(
    context: PluginRequestContext,
    ref: CreationResourceRef,
  ): Promise<MaterialCollectionResult>;
  collectionItems(
    context: PluginRequestContext,
    input: MaterialCollectionItems,
  ): Promise<ResourcePage<MaterialResult>>;
  import(
    context: PluginRequestContext,
    input: { ref: CreationResourceRef; operationKey: string },
  ): Promise<{
    fileId: string;
    name: string;
    mime: string;
    size: number;
    source: ResourceSourceInfo;
  }>;
}
export const templatesServiceToken =
  defineService<TemplatesServiceV1>("templates.v1");
export const materialsServiceToken =
  defineService<MaterialsServiceV2>("materials.v2");
