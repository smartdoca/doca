import { createHostFileStore } from "../services/host-file-store.js";
import { createCredentialCipher } from "../services/credential-cipher.js";
import { verifyCredentialKey } from "../services/plugin-credentials.js";
import {
  bindPluginStorage,
  cleanupPluginObjects,
} from "../services/plugin-storage.js";
import {
  pluginDatabaseToken,
  pluginObjectStorageToken,
  pluginCredentialToken,
} from "@smartdoca/plugin-sdk/storage";
import { registerPluginMobileSessions } from "./mobile-session.js";
import { registerNavigation } from "../routes/navigation.js";
import { PluginManager } from "./manager.js";
import { registerPluginManagement } from "../routes/plugins.js";
import { cleanupFileReceipts } from "./file-receipt-cleanup.js";
import { searchServiceToken } from "@smartdoca/plugin-sdk/search";
import { activeActor } from "@core/modules/access/queries.js";
import { provideAI } from "./ai-capability.js";
import { createDocumentsPlugin } from "@doca/plugin-documents";
import { createFilesPlugin } from "@doca/plugin-files";
import { AIContributionHost } from "@doca/ai-host";
import { PluginHost } from "@doca/plugin-host";
import { definePlugin, type DocaPlugin } from "@smartdoca/plugin-sdk";
import type { FilesServiceV1 } from "@smartdoca/files-capability";
import { createFileProcessingWorker } from "../jobs/file-processing-worker.js";
import { waitForFileExtracts } from "../services/ai/file-extract.js";
import { registerAI } from "../routes/ai.js";
import type { AIContributionExecutionContext } from "../services/ai/runner.js";
import { registerFiles } from "../routes/files.js";
import { registerKnowledge } from "../routes/knowledge.js";
import { registerSearch } from "../routes/search.js";
import {
  aiContributionToken,
  searchRegistrationToken,
  searchSourceRegistryToken,
  serverRuntimeToken,
  type SearchRegistration,
  type SearchRegistrationService,
  type ServerRuntimeService,
} from "./contracts.js";
import { mountFastifyAdapter } from "./fastify-adapter.js";
import { createServerFilesCapability } from "./files-capability-adapter.js";
import { createServerDocumentsCapability } from "./documents-capability-adapter.js";
import {
  createDocumentSource,
  createFileSource,
  createKnowledgeSource,
} from "../services/search/sources.js";
import { importInstalledPlugins, pluginDirectory } from "./installation.js";
import { registerPluginAssets, pluginWebUrl } from "./web-assets.js";
import { providePlatform } from "./platform.js";

export interface ServerPluginDescriptor {
  readonly id: string;
  readonly version: string;
}

export interface ServerPluginComposition {
  readonly host: PluginHost;
  readonly search: SearchRegistration;
  readonly plugins: readonly ServerPluginDescriptor[];
}

const runtimeManifest = {
  schemaVersion: 1,
  id: "doca.server-runtime",
  version: "0.1.0",
  displayName: "Doca Server Runtime",
} as const;

const searchManifest = {
  schemaVersion: 1,
  id: "doca.search",
  version: "0.1.0",
  displayName: "Doca Search",
  dependencies: [{ id: "doca.server-runtime", range: "^0.1.0" }],
} as const;

const aiManifest = {
  schemaVersion: 1,
  id: "doca.ai",
  version: "0.1.0",
  displayName: "Doca AI",
  dependencies: [
    { id: "doca.server-runtime", range: "^0.1.0" },
    { id: "doca.search", range: "^0.1.0" },
    { id: "doca.documents", range: "^0.1.0" },
  ],
} as const;

function runtimePlugin(
  runtime: ServerRuntimeService,
  credentialsAvailable: boolean,
) {
  return definePlugin({
    manifest: runtimeManifest,
    async discover(context) {
      context.provide(serverRuntimeToken, runtime);
      context.provide(pluginDatabaseToken, Object.freeze({}) as never);
      context.provide(pluginObjectStorageToken, Object.freeze({}) as never);
      if (credentialsAvailable)
        context.provide(pluginCredentialToken, Object.freeze({}) as never);
      await providePlatform(context, runtime);
    },
  });
}

function searchPlugin() {
  let registration: SearchRegistration | undefined;
  const service: SearchRegistrationService = {
    require() {
      if (!registration) throw new Error("Search registration is not mounted");
      return registration;
    },
  };
  return definePlugin({
    manifest: searchManifest,
    injections: { required: [serverRuntimeToken] },
    discover(context) {
      context.provide(searchRegistrationToken, service);
      context.provide(searchServiceToken, {
        register(source) {
          const contextFor = (ctx: any) => ({
            principalId: ctx.kind === "plugin" ? ctx.principalId : null,
            signal: ctx.signal,
          });
          const handle = service.require().registerSource({
            descriptor: source.descriptor,
            prepareQuery: (request) =>
              request.context.kind !== "plugin"
                ? null
                : source.prepareQuery
                  ? source.prepareQuery({
                      ...request,
                      context: contextFor(request.context),
                    })
                  : { query: request.query },
            authorize: (request) =>
              request.context.kind !== "plugin"
                ? []
                : source.authorize({
                    ...request,
                    context: contextFor(request.context),
                  }),
            hydrate: (request) =>
              request.context.kind !== "plugin"
                ? []
                : source.hydrate({
                    ...request,
                    context: contextFor(request.context),
                  }),
            ...(source.projections
              ? {
                  projections: (request) =>
                    source.projections!({
                      ...request,
                      context: contextFor(request.context),
                    }),
                }
              : {}),
          });
          return () => handle.dispose();
        },
        upsert(source, projections) {
          return service
            .require()
            .searchHost.upsertProjections({ source, projections });
        },
        delete(source, documentIds) {
          return service
            .require()
            .searchHost.deleteProjections({ source, documentIds });
        },
        rebuild(source, signal) {
          return service.require().searchHost.rebuild({
            source,
            signal,
            context: { kind: "system" },
          });
        },
        async query(request, input) {
          const runtime = context.inject(serverRuntimeToken);
          await activeActor(runtime.db, {
            id: request.principal.id,
            display_name: request.principal.displayName,
            public_id: request.principal.publicId,
            admin: Number(request.principal.admin),
          });
          return service.require().searchHost.query({
            query: input.query,
            sources: [input.source],
            offset: input.offset,
            limit: input.limit,
            context: {
              kind: "plugin",
              principalId: request.principal.id,
              signal: request.signal,
            },
          });
        },
      });
      context.provide(searchSourceRegistryToken, {
        register(source) {
          return service.require().registerSource(source);
        },
      });
    },
    async mount(context) {
      const runtime = context.inject(serverRuntimeToken);
      await context.effectAsync(async () => {
        const mounted = await mountFastifyAdapter(runtime.api, (api) =>
          registerSearch(api, runtime.db, runtime.admin, {
            // Credential updates replace these fields on the shared runtime.
            // Copying them here would keep the startup values until restart.
            get allowedOrigins() {
              return runtime.runtime.search.allowedOrigins;
            },
            get apiKey() {
              return runtime.runtime.search.apiKey;
            },
            get fetch() {
              return runtime.runtime.search.fetch;
            },
            sources: {
              documents: false,
              files: false,
              knowledge: false,
            },
          }),
        );
        registration = mounted.value;
        return async () => {
          registration = undefined;
          await mounted.dispose();
        };
      });
    },
  });
}

function documentsPlugin(
  runtimeService: ServerRuntimeService,
  files: FilesServiceV1,
) {
  return createDocumentsPlugin({
    runtimeToken: serverRuntimeToken,
    searchToken: searchRegistrationToken,
    unload: "app-close",
    service: createServerDocumentsCapability(runtimeService.db, files),
    searchSources: [
      createDocumentSource(runtimeService.db),
      createKnowledgeSource(runtimeService.db),
    ],
    async mount({ runtime, search }) {
      const registration = search.require();
      const mounted = await mountFastifyAdapter(runtime.api, (api) =>
        registerKnowledge(api, runtime.db, runtime.auth, {
          indexer: registration.knowledgeIndex,
          answerIndex: registration.answerIndex,
          notify: runtime.realtime.documentChanged,
          storage: runtime.runtime.storage,
          consumeRateLimit: runtime.consumeRateLimit,
        }),
      );
      return mounted.dispose;
    },
  });
}

function aiPlugin(files: FilesServiceV1) {
  const contributions =
    new AIContributionHost<AIContributionExecutionContext>();
  return definePlugin({
    manifest: aiManifest,
    injections: {
      required: [serverRuntimeToken, searchRegistrationToken],
    },
    discover(context) {
      context.provide(aiContributionToken, contributions);
      provideAI(context, context.inject(serverRuntimeToken).db, contributions);
    },
    async mount(context) {
      const runtime = context.inject(serverRuntimeToken);
      const search = context.inject(searchRegistrationToken).require();
      await context.effectAsync(async () => {
        const mounted = await mountFastifyAdapter(runtime.api, (api) =>
          registerAI(api, runtime.db, runtime.auth, runtime.admin, {
            ...runtime.options.ai,
            storage: runtime.runtime.storage,
            files,
            notify: runtime.realtime.documentChanged,
            search: search.search,
            answerIndex: search.answerIndex,
            fileSearch: search.searchFiles,
            contributions,
          }),
        );
        return mounted.dispose;
      });
    },
  });
}

function filesPlugin(
  runtimeService: ServerRuntimeService,
  service: FilesServiceV1,
) {
  return createFilesPlugin({
    runtimeToken: serverRuntimeToken,
    searchToken: searchRegistrationToken,
    unload: "app-close",
    service,
    searchSources: [createFileSource(runtimeService.db)],
    async mount({ runtime, search }) {
      const registration = search.require();
      const routes = await mountFastifyAdapter(runtime.api, (api) =>
        registerFiles(
          api,
          runtime.db,
          runtime.auth,
          runtime.runtime.storage,
          runtime.admin,
          registration.searchFiles,
        ),
      );
      const worker = createFileProcessingWorker(
        runtime.db,
        runtime.runtime.storage,
      );
      let processing: Promise<unknown> | undefined;
      let cleaning: Promise<unknown> | undefined;
      const clean = () => {
        if (cleaning || !runtime.runtime.storage) return;
        cleaning = cleanupFileReceipts(runtime.db, runtime.runtime.storage)
          .catch((error) =>
            runtime.api.log.error(error, "File staging cleanup failed"),
          )
          .finally(() => {
            cleaning = undefined;
          });
      };
      const cleanupTimer = setInterval(clean, 60 * 60 * 1000);
      cleanupTimer.unref();
      clean();
      const timer = setInterval(() => {
        if (processing) return;
        processing = worker
          .pump()
          .catch((error) =>
            runtime.api.log.error(error, "File processing failed"),
          )
          .finally(() => {
            processing = undefined;
          });
      }, 1000);
      timer.unref();
      return async () => {
        clearInterval(timer);
        clearInterval(cleanupTimer);
        await cleaning;
        await processing;
        await waitForFileExtracts(runtime.db);
        await routes.dispose();
      };
    },
  });
}

export async function composeServerPlugins(
  runtime: ServerRuntimeService,
): Promise<ServerPluginComposition> {
  const host = new PluginHost();
  const masterKey = process.env.DOCA_CREDENTIAL_MASTER_KEY;
  const credentialCipher = masterKey
    ? createCredentialCipher(masterKey)
    : undefined;
  runtime.api.addHook("onClose", async () => credentialCipher?.dispose());
  try {
    if (credentialCipher)
      await verifyCredentialKey(runtime.db, credentialCipher);
    const files = createServerFilesCapability(
      runtime.db,
      runtime.runtime.storage,
    );
    const plugins: DocaPlugin[] = [
      runtimePlugin(runtime, !!credentialCipher),
      searchPlugin(),
      documentsPlugin(runtime, files),
      aiPlugin(files),
      filesPlugin(runtime, files),
    ];
    const manager = new PluginManager(
      runtime.options.pluginDirectory ?? pluginDirectory(),
      plugins.map((p) => p.manifest),
      runtime.db,
      undefined,
      createHostFileStore(runtime.runtime.storage),
      credentialCipher,
    );
    let cleanupInFlight: Promise<void> | undefined;
    const cleanup = () => {
      if (cleanupInFlight) return cleanupInFlight;
      cleanupInFlight = cleanupPluginObjects(runtime.db, manager.archiveStore)
        .then((result) => {
          if (result.failed)
            runtime.api.log.warn(result, "Plugin object cleanup pending");
        })
        .catch((error) =>
          runtime.api.log.error(error, "Plugin object cleanup failed"),
        )
        .finally(() => {
          cleanupInFlight = undefined;
        });
      return cleanupInFlight;
    };
    const cleanupTimer = setInterval(() => void cleanup(), 60_000);
    cleanupTimer.unref();
    runtime.api.addHook("onClose", async () => {
      clearInterval(cleanupTimer);
      await cleanupInFlight;
    });
    await cleanup();
    const installed = await manager.prepare(runtime.options.plugins);
    plugins.push(
      ...(await importInstalledPlugins(
        installed,
        plugins.map((p) => p.manifest),
        (p) =>
          bindPluginStorage(
            runtime.db,
            manager.archiveStore,
            p.manifest.id,
            p.dataVersion,
            credentialCipher,
          ),
      )),
    );
    for (const plugin of plugins) host.register(plugin);
    const descriptors = host.order.map((id) => {
      const manifest = plugins.find(
        (plugin) => plugin.manifest.id === id,
      )!.manifest;
      const installedPlugin = installed.find((p) => p.manifest.id === id);
      return {
        id: manifest.id,
        version: manifest.version,
        ...(installedPlugin?.web ? { web: pluginWebUrl(installedPlugin) } : {}),
      };
    });
    await host.start();
    try {
      await manager.confirm();
    } catch (error) {
      await host.dispose();
      throw error;
    }
    registerPluginManagement(runtime.api, runtime.db, runtime.admin, manager);
    registerPluginMobileSessions(
      runtime.api,
      runtime.db,
      runtime.auth,
      installed.flatMap((p) => p.navigation),
      runtime.origin.protocol === "https:",
    );
    registerNavigation(
      runtime.api,
      runtime.db,
      runtime.auth,
      runtime.admin,
      installed.flatMap((p) => p.navigation),
    );
    registerPluginAssets(runtime.api, installed, (id, version) =>
      manager.assetPlugin(id, version),
    );
    const search = host
      .context(searchManifest.id)!
      .inject(searchRegistrationToken)
      .require();
    return { host, search, plugins: descriptors };
  } catch (error) {
    try {
      await host.dispose();
    } finally {
      credentialCipher?.dispose();
    }
    throw error;
  }
}
