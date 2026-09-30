import { defineService, type JsonObject } from "./index.js";
import type { PluginRequestContext } from "./platform.js";

export type ContentPurpose = "knowledge" | "analysis" | "search";
export interface ContentReference {
  sourceId: string;
  resourceId: string;
  blockId: string;
}
/** Lightweight inventory item. Body text is returned only by read. */
export interface ContentItem {
  ref: ContentReference;
  fingerprint: string;
  title: string;
  order?: number;
  anchor?: JsonObject;
  excerpt?: string;
}
export interface ContentRecord extends ContentItem {
  text: string;
}
export interface ContentContext {
  principalId: string;
  purpose: ContentPurpose;
  signal: AbortSignal;
}
export interface ContentListInput {
  config: JsonObject;
  cursor: string | null;
  limit: number;
}
export interface ContentReadInput {
  config: JsonObject;
  ref: ContentReference;
  fingerprint: string;
}
export interface ContentPage {
  items: readonly ContentItem[];
  nextCursor: string | null;
  /** Stable traversal identity. Expired/inconsistent traversals must fail. */
  snapshot: string;
}
export interface ContentSourceDescriptor {
  id: string;
  pluginId: string;
  version: 1;
  title: { zh: string; en: string };
  contentTypes: readonly string[];
  purposes: readonly ContentPurpose[];
  capabilities: { search: boolean };
  configSchema: JsonObject;
}
export interface ContentSource extends ContentSourceDescriptor {
  list(context: ContentContext, input: ContentListInput): Promise<ContentPage>;
  /** Reauthorize and compare fingerprint; never return new text under an old fingerprint. */
  read(
    context: ContentContext,
    input: ContentReadInput,
  ): Promise<ContentRecord | null>;
  resolve(
    context: ContentContext,
    ref: ContentReference,
  ): Promise<{ path: string; fingerprint: string } | null>;
  search?(
    context: ContentContext,
    input: ContentListInput & { query: string },
  ): Promise<ContentPage>;
}
export interface ContentServiceV1 {
  register(source: ContentSource): () => void;
  sources(
    context: PluginRequestContext,
    purpose: ContentPurpose,
  ): Promise<readonly ContentSourceDescriptor[]>;
  list(
    context: PluginRequestContext,
    input: ContentListInput & { sourceId: string; purpose: ContentPurpose },
  ): Promise<ContentPage>;
  read(
    context: PluginRequestContext,
    input: ContentReadInput & { sourceId: string; purpose: ContentPurpose },
  ): Promise<ContentRecord | null>;
  resolve(
    context: PluginRequestContext,
    input: { ref: ContentReference; purpose: ContentPurpose },
  ): Promise<{ path: string; fingerprint: string } | null>;
  search(
    context: PluginRequestContext,
    input: ContentListInput & {
      sourceId: string;
      purpose: ContentPurpose;
      query: string;
    },
  ): Promise<ContentPage>;
}
export const contentServiceToken =
  defineService<ContentServiceV1>("content.v1");
