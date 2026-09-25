import { expect, it } from "vitest";
import { AIContributionHost } from "../packages/ai-host/src/index.js";
import {
  createDocumentFilesPortV1,
  defineDocumentsServiceV1,
  type DocumentsServiceV1,
} from "../packages/documents-capability/src/index.js";
import {
  FILES_WEB_CAPABILITIES_V1,
  defineFilesServiceV1,
  type FilesServiceV1,
} from "../packages/files-capability/src/index.js";
import { createDocumentsCapabilityPlugin } from "../packages/plugin-documents/src/index.js";
import {
  adminDomainCapabilities,
  createMailCapabilityPlugin,
  type MailKnowledgeReader,
} from "../plugins/mail/src/index.js";
import {
  createFilesCapabilityPlugin,
  serverDomainCapabilities,
} from "../packages/plugin-files/src/index.js";
import { PluginHost } from "../packages/plugin-host/src/index.js";
import { SearchSourceRegistry } from "../packages/search-host/src/index.js";
import {
  definePlugin,
  defineService,
} from "../packages/plugin-sdk/src/index.js";
import { knowledgeSourceRegistryToken } from "../packages/plugin-documents/src/index.js";

const unavailable = async (): Promise<never> => {
  throw new Error("not exercised by lifecycle contract");
};

function filesService(): FilesServiceV1 {
  return defineFilesServiceV1({
    version: 1,
    folders: {
      create: unavailable,
      get: async () => null,
      list: async () => ({ items: [], cursor: null }),
      update: unavailable,
      delete: unavailable,
    },
    files: {
      create: unavailable,
      get: async () => null,
      list: async () => ({ items: [], cursor: null }),
      update: unavailable,
      delete: unavailable,
    },
    uploads: {
      begin: unavailable,
      write: unavailable,
      complete: unavailable,
      abort: unavailable,
      get: async () => null,
    },
    bindings: {
      bind: unavailable,
      unbind: unavailable,
      list: async () => [],
    },
    content: {
      resolveContent: unavailable,
      resolveDownload: unavailable,
    },
    webCapabilities: FILES_WEB_CAPABILITIES_V1,
  });
}

function documentsService(files: FilesServiceV1): DocumentsServiceV1 {
  return defineDocumentsServiceV1({
    version: 1,
    resources: {
      create: unavailable,
      get: async () => null,
      list: async () => ({ items: [], cursor: null }),
      update: unavailable,
      move: unavailable,
      copy: unavailable,
      trash: unavailable,
      restore: unavailable,
      purge: unavailable,
    },
    access: {
      authorize: unavailable,
      listGrants: async () => [],
      putGrant: unavailable,
      revokeGrant: unavailable,
    },
    collaboration: {
      join: unavailable,
      sync: unavailable,
      commit: unavailable,
      publishPresence: async () => undefined,
      leave: async () => undefined,
    },
    files: createDocumentFilesPortV1(files),
  });
}

const mailReader: MailKnowledgeReader = {
  async getMailbox() {
    return null;
  },
  async listMailboxes() {
    return { items: [], cursor: null };
  },
  async listMessages() {
    return { items: [], cursor: null };
  },
};

it("removes domain services, sources, and metadata when plugins stop", async () => {
  const files = filesService();
  const host = new PluginHost();
  host.register(createFilesCapabilityPlugin({ service: files }));
  host.register(
    createDocumentsCapabilityPlugin({
      createService: (injectedFiles) => documentsService(injectedFiles),
    }),
  );
  host.register(
    createMailCapabilityPlugin({
      knowledgeReader: mailReader,
    }),
  );

  await host.start();
  const registry = host
    .context("doca.documents")!
    .inject(knowledgeSourceRegistryToken);
  expect(
    registry
      .list()
      .map(({ ownerPlugin, sourceType }) => `${ownerPlugin}/${sourceType}`),
  ).toEqual([
    "doca.files/files",
    "doca.documents/documents",
    "doca.mail/mailboxes",
    "doca.mail/messages",
  ]);
  expect(
    host.contributions
      .list(serverDomainCapabilities)
      .map((record) => record.id),
  ).toEqual(["doca.files.server", "doca.documents.server", "doca.mail.server"]);
  expect(host.contributions.list(adminDomainCapabilities)).toHaveLength(2);

  await host.dispose();
  expect(registry.list()).toEqual([]);
  expect(host.contributions.list(serverDomainCapabilities)).toEqual([]);
  expect(host.contributions.list(adminDomainCapabilities)).toEqual([]);
});

it("does not leave mail registrations when the mail plugin is disabled", async () => {
  const files = filesService();
  const host = new PluginHost();
  host.register(createFilesCapabilityPlugin({ service: files }));
  host.register(
    createDocumentsCapabilityPlugin({
      createService: (injectedFiles) => documentsService(injectedFiles),
    }),
  );
  await host.start();
  const registry = host
    .context("doca.documents")!
    .inject(knowledgeSourceRegistryToken);

  expect(
    registry.has({ ownerPlugin: "doca.mail", sourceType: "messages" }),
  ).toBe(false);
  expect(host.contributions.list(adminDomainCapabilities)).toEqual([]);
  await host.dispose();
});

it("lets domain plugins own AI and search registrations", async () => {
  const files = filesService();
  const ai = new AIContributionHost();
  const search = new SearchSourceRegistry();
  const aiToken = defineService<AIContributionHost<any>>(
    "doca.ai.contributions",
  );
  const searchToken = defineService<SearchSourceRegistry<any>>(
    "search.sources.v1",
  );
  const mailSearch = {
    descriptor: {
      pluginId: "doca.mail",
      sourceId: "messages",
      schemaVersion: 1,
      renderer: { kind: "mail-search-result", version: 1 },
    },
    authorize: async () => [],
    hydrate: async () => new Map(),
  };
  const host = new PluginHost();
  host.register(
    definePlugin({
      manifest: {
        schemaVersion: 1,
        id: "doca.contribution-hosts",
        version: "0.1.0",
        displayName: "Contribution hosts",
      },
      discover(context) {
        context.provide(aiToken, ai);
        context.provide(searchToken, search);
      },
    }),
  );
  host.register(createFilesCapabilityPlugin({ service: files }));
  host.register(
    createDocumentsCapabilityPlugin({
      createService: (injectedFiles) => documentsService(injectedFiles),
    }),
  );
  host.register(
    createMailCapabilityPlugin({
      knowledgeReader: mailReader,
      searchSource: mailSearch,
    }),
  );

  await host.start();
  expect(ai.catalog().intents.map((entry) => entry.id)).toEqual([
    "doca.documents.edit",
    "doca.files.manage",
    "doca.mail.manage",
  ]);
  expect(ai.catalog().tools.map((entry) => entry.id)).toEqual([
    "doca.mail.browse",
    "doca.mail.compose",
    "doca.mail.manage",
    "doca.mail.read",
    "doca.mail.search",
    "doca.mail.send",
  ]);
  expect(search.list().map((source) => source.descriptor.sourceId)).toEqual([
    "messages",
  ]);

  await host.dispose();
  expect(ai.catalog().tools).toEqual([]);
  expect(search.list()).toEqual([]);
});
