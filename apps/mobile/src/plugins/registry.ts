import {
  MobilePluginRegistry,
  type ClientPluginManifest,
  type MobilePluginBundle,
} from "@smartdoca/web-plugin-registry";

type AppMobilePluginTypes = {
  readonly View: never;
  readonly Icon: "documents" | "files";
  readonly RouteContext: never;
  readonly NodeContext: never;
  readonly FilePickerContext: never;
};

export const MOBILE_BUILTIN_MANIFESTS = {
  documents: {
    pluginId: "doca.documents",
    version: "0.1.0",
    targets: ["web", "mobile"],
    routes: ["doca.documents.mobile.libraries"],
    navigation: ["doca.documents.mobile-tab.libraries"],
    conversationKinds: ["document"],
  },
  files: {
    pluginId: "doca.files",
    version: "0.1.0",
    targets: ["web", "mobile"],
    routes: ["doca.files.mobile.files", "doca.files.mobile.folder"],
    navigation: ["doca.files.mobile-tab.files"],
    conversationKinds: ["file", "folder"],
  },
} as const satisfies Record<string, ClientPluginManifest>;

const documentsBundle: MobilePluginBundle<AppMobilePluginTypes> = {
  manifest: MOBILE_BUILTIN_MANIFESTS.documents,
  tabs: [
    {
      id: "doca.documents.mobile-tab.libraries",
      pluginId: "doca.documents",
      order: 20,
      route: "libraries",
      labelKey: "doca.documents.mobile.libraries",
      icon: "documents",
    },
  ],
  messages: [
    {
      id: "doca.documents.messages.mobile",
      pluginId: "doca.documents",
      messages: {
        en: {
          "doca.documents.mobile.libraries": "Libraries",
        },
        zh: {
          "doca.documents.mobile.libraries": "知识库",
        },
      },
    },
  ],
};

const filesBundle: MobilePluginBundle<AppMobilePluginTypes> = {
  manifest: MOBILE_BUILTIN_MANIFESTS.files,
  tabs: [
    {
      id: "doca.files.mobile-tab.files",
      pluginId: "doca.files",
      order: 40,
      route: "files",
      labelKey: "doca.files.mobile.files",
      icon: "files",
    },
  ],
  messages: [
    {
      id: "doca.files.messages.mobile",
      pluginId: "doca.files",
      messages: {
        en: {
          "doca.files.mobile.files": "Files",
        },
        zh: {
          "doca.files.mobile.files": "文件",
        },
      },
    },
  ],
};

export function createBuiltinMobilePluginRegistry() {
  const registry = new MobilePluginRegistry<AppMobilePluginTypes>();
  registry.register(documentsBundle);
  registry.register(filesBundle);
  return registry;
}

export const mobilePluginRegistry =
  createBuiltinMobilePluginRegistry();

export function mobilePluginMessage(locale: string, key: string) {
  const selected = locale === "zh" ? "zh" : "en";
  for (const contribution of mobilePluginRegistry.messages.list()) {
    const message =
      contribution.messages[selected][key] ?? contribution.messages.en[key];
    if (message) return message;
  }
  return key;
}
