import { defineService } from "./index.js";
import type { PluginRequestContext } from "./platform.js";
import type {
  DocumentReadInput,
  DocumentSnapshot,
  DocumentCapabilities,
  PublicResource,
  PublicResourcePage,
  LibraryChildrenInput,
} from "@smartdoca/plugin-contracts";
export type {
  DocumentReadInput,
  DocumentSnapshot,
  DocumentCapabilities,
  PublicResource,
  PublicResourcePage,
  LibraryChildrenInput,
} from "@smartdoca/plugin-contracts";

/** Native content projections, independent from the text-only content.v1 service. */
export interface DocumentReadServiceV1 {
  get(
    context: PluginRequestContext,
    input: DocumentReadInput,
  ): Promise<PublicResource>;
  readSnapshot(
    context: PluginRequestContext,
    input: DocumentReadInput & { expectedRevision?: string },
  ): Promise<DocumentSnapshot>;
  capabilities(
    context: PluginRequestContext,
    input: DocumentReadInput,
  ): Promise<DocumentCapabilities>;
  references(
    context: PluginRequestContext,
    input: DocumentReadInput,
  ): Promise<{
    outgoing: readonly { id: string; title: string; format: string }[];
    incoming: readonly { id: string; title: string; format: string }[];
  }>;
}
export interface LibrariesServiceV1 {
  list(
    context: PluginRequestContext,
    input: { query?: string; cursor?: string | null },
  ): Promise<PublicResourcePage>;
  children(
    context: PluginRequestContext,
    input: LibraryChildrenInput,
  ): Promise<PublicResourcePage>;
  path(
    context: PluginRequestContext,
    input: { resourceId: string },
  ): Promise<readonly PublicResource[]>;
}
export const documentReadServiceToken =
  defineService<DocumentReadServiceV1>("documents.read.v1");
export const librariesServiceToken =
  defineService<LibrariesServiceV1>("libraries.v1");
