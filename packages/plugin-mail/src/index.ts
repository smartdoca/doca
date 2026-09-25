import {
  defineContributionPoint,
  definePlugin,
  defineService,
  type EffectCleanup,
  type MaybePromise,
  type PluginLifecycleContext,
  type ServiceToken,
} from "@doca/plugin-sdk";
import type { AIContributionHost, DomainAIContribution } from "@doca/ai-host";
import {
  DOCUMENTS_SERVICE_ID,
  type DocumentsServiceV1,
} from "@doca/documents-capability";
import { FILES_SERVICE_ID, type FilesServiceV1 } from "@doca/files-capability";
import {
  KNOWLEDGE_SOURCE_REGISTRY_SERVICE_ID,
  type KnowledgeSourceEffect,
  type KnowledgeSourceRegistryV1,
} from "@doca/knowledge-capability";
import type { SearchSource } from "@doca/search-host";
import { mailAIContribution } from "./ai.js";
import {
  createMailKnowledgeSources,
  type MailKnowledgeReader,
} from "./knowledge.js";
import {
  MAIL_ADMIN_CONTRIBUTIONS,
  MAIL_CAPABILITY_PLUGIN_MANIFEST,
  MAIL_PLUGIN_DECLARATION,
  MAIL_PLUGIN_MANIFEST,
  MAIL_UI_CONTRIBUTIONS,
} from "./manifest.js";

export * from "./manifest.js";
export * from "./knowledge.js";
export * from "./search.js";

export const mailFilesServiceToken =
  defineService<FilesServiceV1>(FILES_SERVICE_ID);
export const mailDocumentsServiceToken =
  defineService<DocumentsServiceV1>(DOCUMENTS_SERVICE_ID);
export const mailKnowledgeSourceRegistryToken =
  defineService<KnowledgeSourceRegistryV1>(
    KNOWLEDGE_SOURCE_REGISTRY_SERVICE_ID,
  );
export const mailSearchSourceRegistryToken =
  defineService<{
    register(source: SearchSource<any, any>): { dispose(): void };
  }>("search.sources.v1");
export const mailAIContributionHostToken = defineService<
  AIContributionHost<any>
>("doca.ai.contributions");

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
export const adminDomainCapabilities = defineContributionPoint<
  (typeof MAIL_ADMIN_CONTRIBUTIONS)[number]
>("doca.admin.capabilities");
export const uiDomainCapabilities = defineContributionPoint<{
  readonly target: "web" | "mobile";
  readonly metadata:
    typeof MAIL_UI_CONTRIBUTIONS.web | typeof MAIL_UI_CONTRIBUTIONS.mobile;
}>("doca.ui.capabilities");

const serverCapabilities = Object.values(
  MAIL_PLUGIN_DECLARATION.server.contributions,
).flat();
const webCapabilities = Object.values(
  MAIL_PLUGIN_DECLARATION.web.contributions,
).flat();
const mobileCapabilities = Object.values(
  MAIL_PLUGIN_DECLARATION.mobile.contributions,
).flat();

export const MAIL_TARGET_CONTRIBUTIONS = Object.freeze({
  server: {
    target: "server",
    entry: MAIL_PLUGIN_DECLARATION.server.entry,
    capabilities: serverCapabilities,
  },
  web: {
    target: "web",
    entry: MAIL_PLUGIN_DECLARATION.web.entry,
    capabilities: webCapabilities,
  },
  mobile: {
    target: "mobile",
    entry: MAIL_PLUGIN_DECLARATION.mobile.entry,
    capabilities: mobileCapabilities,
  },
} satisfies Record<"server" | "web" | "mobile", DomainTargetContribution>);

function registerContributionMetadata(context: PluginLifecycleContext): void {
  context.contributions.register(
    serverDomainCapabilities,
    "doca.mail.server",
    MAIL_TARGET_CONTRIBUTIONS.server,
  );
  context.contributions.register(
    webDomainCapabilities,
    "doca.mail.web",
    MAIL_TARGET_CONTRIBUTIONS.web,
  );
  context.contributions.register(
    mobileDomainCapabilities,
    "doca.mail.mobile",
    MAIL_TARGET_CONTRIBUTIONS.mobile,
  );
  for (const contribution of MAIL_ADMIN_CONTRIBUTIONS) {
    context.contributions.register(
      adminDomainCapabilities,
      contribution.id,
      contribution,
    );
  }
  context.contributions.register(uiDomainCapabilities, "doca.mail.ui.web", {
    target: "web",
    metadata: MAIL_UI_CONTRIBUTIONS.web,
  });
  context.contributions.register(uiDomainCapabilities, "doca.mail.ui.mobile", {
    target: "mobile",
    metadata: MAIL_UI_CONTRIBUTIONS.mobile,
  });
}

interface MailRuntimeContributions<AIContext, SearchContext> {
  readonly knowledgeReader?: MailKnowledgeReader;
  readonly knowledgeSources?: readonly KnowledgeSourceEffect<any, any>[];
  readonly searchSource?: SearchSource<SearchContext, any>;
  readonly ai?: DomainAIContribution<AIContext> | false;
}

async function registerRuntimeContributions<AIContext, SearchContext>(
  context: PluginLifecycleContext,
  contributions: MailRuntimeContributions<AIContext, SearchContext>,
): Promise<void> {
  const knowledgeRegistry = context.injectOptional(
    mailKnowledgeSourceRegistryToken,
  );
  if (knowledgeRegistry) {
    const configured =
      contributions.knowledgeSources ??
      (contributions.knowledgeReader
        ? Object.values(
            createMailKnowledgeSources(contributions.knowledgeReader),
          )
        : []);
    for (const source of configured) {
      const registration = knowledgeRegistry.register(source);
      context.effect(() => () => {
        registration.dispose();
      });
    }
  }
  const searchRegistry = context.injectOptional(
    mailSearchSourceRegistryToken,
  );
  if (searchRegistry && contributions.searchSource) {
    await context.effectAsync(async () => {
      const lease = searchRegistry.register(contributions.searchSource!);
      return () => lease.dispose();
    });
  }
  const aiHost = context.injectOptional(mailAIContributionHostToken) as
    AIContributionHost<AIContext> | undefined;
  if (aiHost && contributions.ai !== false) {
    const contribution =
      contributions.ai === undefined
        ? mailAIContribution<AIContext>()
        : contributions.ai;
    context.effect(() => aiHost.registerDomain(contribution));
  }
}

export interface MailPluginAdapter<
  Runtime,
  AIContext = unknown,
  SearchContext = unknown,
> extends MailRuntimeContributions<AIContext, SearchContext> {
  readonly runtimeToken: ServiceToken<Runtime>;
  /**
   * Fastify cannot remove mounted routes. The host must dispose this adapter
   * only while the application is closing.
   */
  readonly unload: "app-close";
  mount(input: {
    readonly runtime: Runtime;
    readonly context: PluginLifecycleContext;
  }): MaybePromise<EffectCleanup | void>;
}

export function createMailPlugin<Runtime>(adapter: MailPluginAdapter<Runtime>) {
  return definePlugin({
    manifest: MAIL_PLUGIN_MANIFEST,
    injections: {
      required: [adapter.runtimeToken, mailFilesServiceToken],
      optional: [
        mailKnowledgeSourceRegistryToken,
        mailSearchSourceRegistryToken,
        mailAIContributionHostToken,
      ],
    },
    discover(context) {
      registerContributionMetadata(context);
    },
    async mount(context) {
      const runtime = context.inject(adapter.runtimeToken);
      await context.effectAsync(
        async () => (await adapter.mount({ runtime, context })) ?? undefined,
      );
      await registerRuntimeContributions(context, {
        knowledgeReader: adapter.knowledgeReader,
        knowledgeSources: adapter.knowledgeSources,
        searchSource: adapter.searchSource,
        ai: adapter.ai,
      });
    },
  });
}

export interface MailCapabilityPluginOptions<
  AIContext = unknown,
  SearchContext = unknown,
> extends MailRuntimeContributions<AIContext, SearchContext> {}

export function createMailCapabilityPlugin<
  AIContext = unknown,
  SearchContext = unknown,
>(options: MailCapabilityPluginOptions<AIContext, SearchContext> = {}) {
  return definePlugin({
    manifest: MAIL_CAPABILITY_PLUGIN_MANIFEST,
    injections: {
      required: [mailFilesServiceToken],
      optional: [
        mailDocumentsServiceToken,
        mailKnowledgeSourceRegistryToken,
        mailSearchSourceRegistryToken,
        mailAIContributionHostToken,
      ],
    },
    discover(context) {
      // Required injection is intentionally read here: attachments and inline
      // images cannot fall back to mail-owned storage.
      context.inject(mailFilesServiceToken);
      registerContributionMetadata(context);
    },
    async mount(context) {
      await registerRuntimeContributions(context, options);
    },
  });
}
