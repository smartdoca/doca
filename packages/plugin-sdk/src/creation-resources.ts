import { defineService } from "./index.js";
import type { PluginRequestContext } from "./platform.js";
import type {
  JsonValue,
  ResourceProviderDescriptor,
  ResourceFilter,
  ResourceSearch,
  ResourcePage,
  CreationResourceRef,
  CreationResourceCard,
  ResourceTag,
  TemplatePayload,
  TemplateSelection,
  ResourceConsumerDescriptor,
} from "@smartdoca/plugin-contracts";
export type * from "@smartdoca/plugin-contracts";
export interface ResourceProvider extends ResourceProviderDescriptor {
  tags(
    context: PluginRequestContext,
    filter: ResourceFilter,
  ): Promise<readonly ResourceTag[]>;
  search(
    context: PluginRequestContext,
    input: ResourceFilter & { cursor: string | null; limit: number },
  ): Promise<{
    items: readonly CreationResourceCard[];
    nextCursor: string | null;
  }>;
  /** Current permission check; return null when hidden/deleted. No body here. */
  describe(
    context: PluginRequestContext,
    ref: CreationResourceRef,
  ): Promise<CreationResourceCard | null>;
}
export interface TemplateProvider extends ResourceProvider {
  read(
    context: PluginRequestContext,
    input: TemplateSelection,
  ): Promise<TemplatePayload>;
}
export interface MaterialProvider extends ResourceProvider {
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
  ): Promise<CreationResourceCard>;
}
export interface TemplatesServiceV1 extends ResourceDirectoryV1<TemplateProvider> {
  read(
    context: PluginRequestContext,
    input: TemplateSelection,
  ): Promise<TemplatePayload>;
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
export interface MaterialsServiceV1 extends ResourceDirectoryV1<MaterialProvider> {
  import(
    context: PluginRequestContext,
    input: { ref: CreationResourceRef; operationKey: string },
  ): Promise<{ fileId: string; name: string; mime: string; size: number }>;
}
export const templatesServiceToken =
  defineService<TemplatesServiceV1>("templates.v1");
export const materialsServiceToken =
  defineService<MaterialsServiceV1>("materials.v1");
