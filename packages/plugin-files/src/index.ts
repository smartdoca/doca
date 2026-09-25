import {
  defineContributionPoint,
  definePlugin,
  defineService,
  type EffectCleanup,
  type MaybePromise,
  type PluginLifecycleContext,
  type ServiceToken,
} from "@doca/plugin-sdk";
import {
  FILES_SERVICE_ID,
  defineFilesServiceV1,
  type FilesServiceV1,
} from "@doca/files-capability";
import {
  KNOWLEDGE_SOURCE_REGISTRY_SERVICE_ID,
  type KnowledgeSourceEffect,
  type KnowledgeSourceRegistryV1,
} from "@doca/knowledge-capability";
import type { AIContributionHost, DomainAIContribution } from "@doca/ai-host";
import type { SearchSource } from "@doca/search-host";
import { filesAIContribution } from "./ai.js";
import { createFilesKnowledgeSource } from "./knowledge.js";
import {
  FILES_CAPABILITY_PLUGIN_MANIFEST,
  FILES_PLUGIN_DECLARATION,
  FILES_PLUGIN_MANIFEST,
} from "./manifest.js";

export * from "./manifest.js";
export * from "./knowledge.js";

export const filesServiceToken =
  defineService<FilesServiceV1>(FILES_SERVICE_ID);
export const filesKnowledgeSourceRegistryToken =
  defineService<KnowledgeSourceRegistryV1>(
    KNOWLEDGE_SOURCE_REGISTRY_SERVICE_ID,
  );
export const filesSearchSourceRegistryToken = defineService<{
  register(source: SearchSource<any, any>): { dispose(): void };
}>("search.sources.v1");
export const filesAIContributionHostToken =
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

export const FILES_TARGET_CONTRIBUTIONS = Object.freeze({
  server: {
    target: "server",
    entry: FILES_PLUGIN_DECLARATION.server.entry,
    capabilities: FILES_PLUGIN_DECLARATION.server.contributions,
  },
  web: {
    target: "web",
    entry: FILES_PLUGIN_DECLARATION.web.entry,
    capabilities: FILES_PLUGIN_DECLARATION.web.contributions,
  },
  mobile: {
    target: "mobile",
    entry: FILES_PLUGIN_DECLARATION.mobile.entry,
    capabilities: FILES_PLUGIN_DECLARATION.mobile.contributions,
  },
} satisfies Record<"server" | "web" | "mobile", DomainTargetContribution>);

function registerTargetContributions(context: PluginLifecycleContext): void {
  context.contributions.register(
    serverDomainCapabilities,
    "doca.files.server",
    FILES_TARGET_CONTRIBUTIONS.server,
  );
  context.contributions.register(
    webDomainCapabilities,
    "doca.files.web",
    FILES_TARGET_CONTRIBUTIONS.web,
  );
  context.contributions.register(
    mobileDomainCapabilities,
    "doca.files.mobile",
    FILES_TARGET_CONTRIBUTIONS.mobile,
  );
}

function registerKnowledgeSource(
  context: PluginLifecycleContext,
  service: FilesServiceV1,
  effect?: KnowledgeSourceEffect<any, any> | false,
): void {
  if (effect === false) return;
  const registry = context.injectOptional(filesKnowledgeSourceRegistryToken);
  if (!registry) return;
  const registration = registry.register(
    effect ?? createFilesKnowledgeSource(service),
  );
  context.effect(() => () => {
    registration.dispose();
  });
}

function registerRuntimeContributions(
  context: PluginLifecycleContext,
  service: FilesServiceV1,
  options: {
    readonly knowledgeSource?: KnowledgeSourceEffect<any, any> | false;
    readonly searchSources?: readonly SearchSource<any, any>[];
    readonly ai?: DomainAIContribution<any> | false;
  },
): void {
  registerKnowledgeSource(context, service, options.knowledgeSource);
  const search = context.injectOptional(filesSearchSourceRegistryToken);
  for (const source of options.searchSources ?? []) {
    const registration = search?.register(source);
    if (registration) context.effect(() => () => registration.dispose());
  }
  const aiHost = context.injectOptional(filesAIContributionHostToken);
  const ai =
    options.ai === undefined ? filesAIContribution<any>() : options.ai;
  if (aiHost && ai !== false) {
    context.effect(() => aiHost.registerDomain(ai));
  }
}

export interface FilesPluginAdapter<Runtime, Search> {
  readonly runtimeToken: ServiceToken<Runtime>;
  readonly searchToken: ServiceToken<Search>;
  /**
   * Fastify cannot remove mounted routes. The host must dispose this adapter
   * only while the application is closing.
   */
  readonly unload: "app-close";
  /** Authoritative files.v1 provider used by routes and other plugins. */
  readonly service: FilesServiceV1;
  readonly knowledgeSource?: KnowledgeSourceEffect<any, any> | false;
  readonly searchSources?: readonly SearchSource<any, any>[];
  readonly ai?: DomainAIContribution<any> | false;
  mount(input: {
    readonly runtime: Runtime;
    readonly search: Search;
    readonly context: PluginLifecycleContext;
  }): MaybePromise<EffectCleanup | void>;
}

export function createFilesPlugin<Runtime, Search>(
  adapter: FilesPluginAdapter<Runtime, Search>,
) {
  return definePlugin({
    manifest: FILES_PLUGIN_MANIFEST,
    injections: {
      required: [adapter.runtimeToken, adapter.searchToken],
      optional: [
        filesKnowledgeSourceRegistryToken,
        filesSearchSourceRegistryToken,
        filesAIContributionHostToken,
      ],
    },
    discover(context) {
      registerTargetContributions(context);
      context.provide(
        filesServiceToken,
        defineFilesServiceV1(adapter.service),
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

export interface FilesCapabilityPluginOptions {
  readonly service: FilesServiceV1;
  readonly knowledgeSource?: KnowledgeSourceEffect<any, any> | false;
  readonly searchSources?: readonly SearchSource<any, any>[];
  readonly ai?: DomainAIContribution<any> | false;
}

/**
 * Provider-only plugin for hosts whose HTTP/UI composition consumes the
 * declared target contributions independently.
 */
export function createFilesCapabilityPlugin(
  options: FilesCapabilityPluginOptions,
) {
  return definePlugin({
    manifest: FILES_CAPABILITY_PLUGIN_MANIFEST,
    injections: {
      optional: [
        filesKnowledgeSourceRegistryToken,
        filesSearchSourceRegistryToken,
        filesAIContributionHostToken,
      ],
    },
    discover(context) {
      registerTargetContributions(context);
      context.provide(filesServiceToken, defineFilesServiceV1(options.service));
    },
    mount(context) {
      registerRuntimeContributions(context, options.service, options);
    },
  });
}
