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
  readonly providerId?: string;
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
  readonly version: 1;
  readonly title: { readonly zh: string; readonly en: string };
  readonly contracts: readonly ResourceType[];
  readonly contentTypes: readonly ResourceType[];
  readonly sorts: readonly ResourceSort[];
}
export interface ResourcePage {
  readonly items: readonly CreationResourceCard[];
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
