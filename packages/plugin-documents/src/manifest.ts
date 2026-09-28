export const DOCUMENTS_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: "doca.documents",
  version: "0.1.0",
  displayName: "Doca Documents",
  description: "Mounts the host document knowledge adapter.",
  dependencies: [
    { id: "doca.server-runtime", range: "^0.1.0" },
    { id: "doca.search", range: "^0.1.0" },
    { id: "doca.files", range: "^0.1.0" },
  ],
} as const;

export const DOCUMENTS_CAPABILITY_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: "doca.documents",
  version: "0.1.0",
  displayName: "Doca Documents",
  description: "Provides documents.v1 and the open knowledge source registry.",
  dependencies: [{ id: "doca.files", range: "^0.1.0" }],
} as const;

export const DOCUMENTS_PLUGIN_DECLARATION = {
  id: "doca.documents",
  injections: {
    required: ["files.v1"] as const,
    optional: ["search.sources.v1", "doca.ai.contributions"] as const,
  },
  provides: ["documents.v1", "knowledge.sources.v1"] as const,
  server: {
    entry: "@doca/plugin-documents/server",
    contributions: [
      "documents.v1",
      "documents.routes.v1",
      "documents.collaboration.v1",
      "documents.resource-callbacks.v1",
      "documents.search-source.v1",
      "documents.knowledge-source.v1",
      "knowledge.sources.v1",
    ],
  },
  web: {
    entry: "@doca/plugin-documents/web",
    contributions: [
      "documents.route",
      "documents.navigation",
      "documents.editor",
      "documents.knowledge-source-settings",
    ],
  },
  mobile: {
    entry: "@doca/plugin-documents/mobile",
    contributions: [
      "documents.route",
      "documents.navigation",
      "documents.viewer",
      "documents.knowledge-source-settings",
    ],
  },
} as const;
