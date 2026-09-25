export const MAIL_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: "doca.mail",
  version: "0.1.0",
  displayName: "Doca Mail",
  description: "Mounts the host mail routes and synchronization adapter.",
  dependencies: [
    { id: "doca.server-runtime", range: "^0.1.0" },
    { id: "doca.files", range: "^0.1.0" },
  ],
} as const;

export const MAIL_CAPABILITY_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: "doca.mail",
  version: "0.1.0",
  displayName: "Doca Mail",
  description: "Contributes the mail domain without host-owned mail imports.",
  dependencies: [
    { id: "doca.files", range: "^0.1.0" },
    {
      id: "doca.documents",
      range: "^0.1.0",
      optional: true,
    },
  ],
} as const;

export const MAIL_PLUGIN_DECLARATION = {
  id: "doca.mail",
  injections: {
    required: ["files.v1"] as const,
    optional: [
      "documents.v1",
      "knowledge.sources.v1",
      "search.sources.v1",
      "doca.ai.contributions",
    ] as const,
  },
  server: {
    entry: "@doca/plugin-mail/server",
    contributions: {
      routes: ["mail.routes.v1"],
      jobs: ["mail.sync.v1"],
      search: ["mail.messages.search-source.v1"],
      knowledge: [
        "mail.messages.knowledge-source.v1",
        "mail.mailboxes.knowledge-source.v1",
      ],
      admin: ["mail.accounts.admin.v1", "mail.settings.admin.v1"],
      ai: [
        "mail.intent.v1",
        "mail.workflow.v1",
        "mail.acceptance.v1",
        "mail.tools.v1",
        "mail.skills.v1",
      ],
    },
  },
  web: {
    entry: "@doca/plugin-mail/web",
    contributions: {
      routes: ["mail.route"],
      navigation: ["mail.navigation"],
      admin: ["mail.accounts.admin", "mail.settings.admin"],
      aiRenderers: ["mail.conversation.renderer"],
      searchRenderers: ["mail.search-result.renderer"],
      knowledgeRenderers: ["mail.knowledge-source.settings"],
    },
  },
  mobile: {
    entry: "@doca/plugin-mail/mobile",
    contributions: {
      routes: ["mail.route"],
      tabs: ["mail.tab"],
      aiRenderers: ["mail.conversation.renderer"],
      searchRenderers: ["mail.search-result.renderer"],
      knowledgeRenderers: ["mail.knowledge-source.settings"],
    },
  },
} as const;

export const MAIL_ADMIN_CONTRIBUTIONS = Object.freeze([
  {
    id: "doca.mail.admin.accounts",
    rendererId: "doca.mail.admin.accounts",
    settingsPrefix: "mail.accounts",
    requiresAdministrator: true,
  },
  {
    id: "doca.mail.admin.settings",
    rendererId: "doca.mail.admin.settings",
    settingsPrefix: "mail.settings",
    requiresAdministrator: true,
  },
] as const);

export const MAIL_UI_CONTRIBUTIONS = Object.freeze({
  web: {
    routeId: "doca.mail.route",
    navigationId: "doca.mail.navigation",
    routePrefix: "/mail",
    conversationRendererId: "doca.mail.conversation",
    searchRendererId: "doca.mail.search-result",
    knowledgeConfigRendererId: "doca.mail.knowledge.settings",
  },
  mobile: {
    routeId: "doca.mail.route",
    tabId: "doca.mail.tab",
    routePrefix: "/mail",
    conversationRendererId: "doca.mail.conversation",
    searchRendererId: "doca.mail.search-result",
    knowledgeConfigRendererId: "doca.mail.knowledge.settings",
  },
} as const);
