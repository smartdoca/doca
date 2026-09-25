export const FILES_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: "doca.files",
  version: "0.1.0",
  displayName: "Doca Files",
  description: "Mounts the host file routes and background processing adapter.",
  dependencies: [
    { id: "doca.server-runtime", range: "^0.1.0" },
    { id: "doca.search", range: "^0.1.0" },
  ],
} as const;

/** Provider-only manifest for hosts that mount routes through another plugin. */
export const FILES_CAPABILITY_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: "doca.files",
  version: "0.1.0",
  displayName: "Doca Files",
  description: "Provides files.v1 and file domain contributions.",
} as const;

export const FILES_PLUGIN_DECLARATION = {
  id: "doca.files",
  injections: {
    required: [] as const,
    optional: [
      "knowledge.sources.v1",
      "search.sources.v1",
      "doca.ai.contributions",
    ] as const,
  },
  server: {
    entry: "@doca/plugin-files/server",
    contributions: [
      "files.v1",
      "files.routes.v1",
      "files.search-source.v1",
      "files.knowledge-source.v1",
      "files.jobs.v1",
    ],
  },
  web: {
    entry: "@doca/plugin-files/web",
    contributions: [
      "files.route",
      "files.navigation",
      "files.browser",
      "files.picker",
      "files.upload",
      "files.preview",
      "files.download",
    ],
  },
  mobile: {
    entry: "@doca/plugin-files/mobile",
    contributions: [
      "files.route",
      "files.navigation",
      "files.picker",
      "files.upload",
      "files.preview",
      "files.download",
    ],
  },
} as const;
