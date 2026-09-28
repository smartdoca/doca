import {
  defineContributionPoint,
  definePlugin,
  defineService,
  type EffectCleanup,
  type MaybePromise,
  type PluginLifecycleContext,
  type ServiceToken,
} from "@smartdoca/plugin-sdk";
import {
  DOCUMENTS_SERVICE_ID,
  defineDocumentsServiceV1,
  type DocumentsServiceV1,
} from "@doca/documents-capability";
import { FILES_SERVICE_ID, type FilesServiceV1 } from "@smartdoca/files-capability";
import {
  KNOWLEDGE_SOURCE_REGISTRY_SERVICE_ID,
  createKnowledgeSourceEffectRegistry,
  type KnowledgeSourceEffect,
  type KnowledgeSourceRegistryV1,
} from "@smartdoca/knowledge-capability";
import type { AIContributionHost, DomainAIContribution } from "@doca/ai-host";
import type { SearchSource } from "@smartdoca/search-host";
import { documentsAIContribution } from "./ai.js";
import { createDocumentsKnowledgeSource } from "./knowledge.js";
import {
  DOCUMENTS_CAPABILITY_PLUGIN_MANIFEST,
  DOCUMENTS_PLUGIN_DECLARATION,
  DOCUMENTS_PLUGIN_MANIFEST,
} from "./manifest.js";

export * from "./manifest.js";
export * from "./knowledge.js";

export const documentsServiceToken =
  defineService<DocumentsServiceV1>(DOCUMENTS_SERVICE_ID);
export const documentsFilesServiceToken =
  defineService<FilesServiceV1>(FILES_SERVICE_ID);
export const knowledgeSourceRegistryToken =
  defineService<KnowledgeSourceRegistryV1>(
    KNOWLEDGE_SOURCE_REGISTRY_SERVICE_ID,
  );
export const documentsSearchSourceRegistryToken = defineService<{
  register(source: SearchSource<any, any>): { dispose(): void };
}>("search.sources.v1");
export const documentsAIContributionHostToken =
  defineService<AIContributionHost<any>>("doca.ai.contributions");

export interface DomainTargetContribution {
  readonly target: "server" | "web" | "mobile";
  readonly entry: string;
  readonly capabilities: readonly string[];
}

export const serverDomainCapabilities =
  defineContributionPoint<DomainTargetContribution>("doca.server.capabilities");
export const webDomainCapabilities =
  defineContributionPoint<DomainTargetContribution>("doca.web.capabilities");
export const mobileDomainCapabilities =
  defineContributionPoint<DomainTargetContribution>("doca.mobile.capabilities");

export const DOCUMENTS_TARGET_CONTRIBUTIONS = Object.freeze({
  server: {
    target: "server",
    entry: DOCUMENTS_PLUGIN_DECLARATION.server.entry,
    capabilities: DOCUMENTS_PLUGIN_DECLARATION.server.contributions,
  },
  web: {
    target: "web",
    entry: DOCUMENTS_PLUGIN_DECLARATION.web.entry,
    capabilities: DOCUMENTS_PLUGIN_DECLARATION.web.contributions,
  },
  mobile: {
    target: "mobile",
    entry: DOCUMENTS_PLUGIN_DECLARATION.mobile.entry,
    capabilities: DOCUMENTS_PLUGIN_DECLARATION.mobile.contributions,
  },
} satisfies Record<"server" | "web" | "mobile", DomainTargetContribution>);

function registerTargetContributions(context: PluginLifecycleContext): void {
  context.contributions.register(
    serverDomainCapabilities,
    "doca.documents.server",
    DOCUMENTS_TARGET_CONTRIBUTIONS.server,
  );
  context.contributions.register(
    webDomainCapabilities,
    "doca.documents.web",
    DOCUMENTS_TARGET_CONTRIBUTIONS.web,
  );
  context.contributions.register(
    mobileDomainCapabilities,
    "doca.documents.mobile",
    DOCUMENTS_TARGET_CONTRIBUTIONS.mobile,
  );
}

function provideKnowledgeRegistry(
  context: PluginLifecycleContext,
  registry?: KnowledgeSourceRegistryV1,
): KnowledgeSourceRegistryV1 {
  const existing = context.injectOptional(knowledgeSourceRegistryToken);
  if (existing) return existing;
  const created = registry ?? createKnowledgeSourceEffectRegistry();
  context.provide(knowledgeSourceRegistryToken, created);
  return created;
}

function registerDocumentsKnowledgeSource(
  context: PluginLifecycleContext,
  service: DocumentsServiceV1,
  effect?: KnowledgeSourceEffect<any, any> | false,
): void {
  if (effect === false) return;
  const registry = context.inject(knowledgeSourceRegistryToken);
  const registration = registry.register(
    effect ?? createDocumentsKnowledgeSource(service),
  );
  context.effect(() => () => {
    registration.dispose();
  });
}

function registerRuntimeContributions(
  context: PluginLifecycleContext,
  service: DocumentsServiceV1,
  options: {
    readonly knowledgeSource?: KnowledgeSourceEffect<any, any> | false;
    readonly searchSources?: readonly SearchSource<any, any>[];
    readonly ai?: DomainAIContribution<any> | false;
  },
): void {
  registerDocumentsKnowledgeSource(
    context,
    service,
    options.knowledgeSource,
  );
  const search = context.injectOptional(documentsSearchSourceRegistryToken);
  for (const source of options.searchSources ?? []) {
    const registration = search?.register(source);
    if (registration) context.effect(() => () => registration.dispose());
  }
  const aiHost = context.injectOptional(documentsAIContributionHostToken);
  const ai =
    options.ai === undefined ? documentsAIContribution<any>() : options.ai;
  if (aiHost && ai !== false) {
    context.effect(() => aiHost.registerDomain(ai));
  }
}

export interface DocumentsPluginAdapter<Runtime, Search> {
  readonly runtimeToken: ServiceToken<Runtime>;
  readonly searchToken: ServiceToken<Search>;
  /**
   * Fastify cannot remove mounted routes. The host must dispose this adapter
   * only while the application is closing.
   */
  readonly unload: "app-close";
  readonly service: DocumentsServiceV1;
  readonly knowledgeRegistry?: KnowledgeSourceRegistryV1;
  readonly knowledgeSource?: KnowledgeSourceEffect<any, any> | false;
  readonly searchSources?: readonly SearchSource<any, any>[];
  readonly ai?: DomainAIContribution<any> | false;
  mount(input: {
    readonly runtime: Runtime;
    readonly search: Search;
    readonly context: PluginLifecycleContext;
  }): MaybePromise<EffectCleanup | void>;
}

export function createDocumentsPlugin<Runtime, Search>(
  adapter: DocumentsPluginAdapter<Runtime, Search>,
) {
  return definePlugin({
    manifest: DOCUMENTS_PLUGIN_MANIFEST,
    injections: {
      required: [
        adapter.runtimeToken,
        adapter.searchToken,
        documentsFilesServiceToken,
      ],
      optional: [
        documentsSearchSourceRegistryToken,
        documentsAIContributionHostToken,
      ],
    },
    discover(context) {
      registerTargetContributions(context);
      provideKnowledgeRegistry(context, adapter.knowledgeRegistry);
      context.provide(
        documentsServiceToken,
        defineDocumentsServiceV1(adapter.service),
      );
    },
    async mount(context) {
      const runtime = context.inject(adapter.runtimeToken);
      const search = context.inject(adapter.searchToken);
      await context.effectAsync(
        async () =>
          (await adapter.mount({ runtime, search, context })) ?? undefined,
      );
      registerRuntimeContributions(context, adapter.service, adapter);
    },
  });
}

export interface DocumentsCapabilityPluginOptions {
  readonly createService: (files: FilesServiceV1) => DocumentsServiceV1;
  readonly knowledgeRegistry?: KnowledgeSourceRegistryV1;
  readonly knowledgeSource?:
    | KnowledgeSourceEffect<any, any>
    | false
    | ((service: DocumentsServiceV1) => KnowledgeSourceEffect<any, any>);
  readonly searchSources?: readonly SearchSource<any, any>[];
  readonly ai?: DomainAIContribution<any> | false;
}

export function createDocumentsCapabilityPlugin(
  options: DocumentsCapabilityPluginOptions,
) {
  let service: DocumentsServiceV1 | undefined;
  return definePlugin({
    manifest: DOCUMENTS_CAPABILITY_PLUGIN_MANIFEST,
    injections: {
      required: [documentsFilesServiceToken],
      optional: [
        documentsSearchSourceRegistryToken,
        documentsAIContributionHostToken,
      ],
    },
    discover(context) {
      registerTargetContributions(context);
      provideKnowledgeRegistry(context, options.knowledgeRegistry);
      service = defineDocumentsServiceV1(
        options.createService(context.inject(documentsFilesServiceToken)),
      );
      context.provide(documentsServiceToken, service);
    },
    mount(context) {
      if (!service) throw new Error("documents.v1 was not discovered");
      const configured = options.knowledgeSource;
      registerRuntimeContributions(context, service, {
        ...options,
        knowledgeSource:
          typeof configured === "function" ? configured(service) : configured,
      });
    },
  });
}
