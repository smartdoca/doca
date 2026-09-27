import {
  BookOpen,
  Bot,
  FolderOpen,
  Home,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  FileDelivery,
  FolderDelivery,
} from "@core/modules/ai/progress.js";
import {
  FilesExplorer,
  FolderFilePicker,
  SharedFoldersPage,
  type FileLocation,
} from "@web/features/files/files.js";
import { FileDeliveryCard } from "@web/features/ai/ai-file-card.js";
import { FolderDeliveryCard } from "@web/features/ai/ai-folder-card.js";
import type { FileItem } from "@web/shared/api.js";
import {
  WebPluginRegistry,
  type ClientPluginManifest,
  type PluginLocale,
  type WebPluginBundle,
} from "@doca/web-plugin-registry";

export interface AppPluginRouteContext {
  readonly sharedFolderName: string;
  readonly onFileNavigationChange: (trail: FileLocation[]) => void;
}

export interface AIBlockRenderContext {
  readonly onOpen?: (href: string) => void;
  renderLink(label: string, href: string): ReactNode;
}

export interface DelegatedRenderContext {
  render(kind: string, value: unknown): ReactNode;
}

export interface KnowledgeSourceRenderContext extends DelegatedRenderContext {
  bind?: (target: { sourceId?: string; url?: string }) => void;
}

export interface FilePickerRenderContext {
  readonly close: () => void;
  readonly select?: (item: FileItem) => Promise<void> | void;
  readonly accept?: (item: FileItem) => boolean;
  readonly selectFolder?: (folder: {
    id: string;
    name: string;
  }) => Promise<void> | void;
}

type AppWebPluginTypes = {
  readonly View: ReactNode;
  readonly Icon: LucideIcon;
  readonly RouteContext: AppPluginRouteContext;
  readonly AdminContext: Record<never, never>;
  readonly SettingsContext: DelegatedRenderContext;
  readonly AIBlockContext: AIBlockRenderContext;
  readonly SearchResultContext: DelegatedRenderContext;
  readonly KnowledgeSourceContext: KnowledgeSourceRenderContext;
  readonly FilePickerContext: FilePickerRenderContext;
};

export const BUILTIN_CLIENT_MANIFESTS = {
  documents: {
    pluginId: "doca.documents",
    version: "0.1.0",
    targets: ["web", "mobile"],
    routes: ["doca.documents.route.home", "doca.documents.route.libraries"],
    navigation: [
      "doca.documents.navigation.home",
      "doca.documents.navigation.libraries",
      "doca.documents.navigation.knowledge-qa",
    ],
    conversationKinds: ["document"],
  },
  files: {
    pluginId: "doca.files",
    version: "0.1.0",
    targets: ["web", "mobile"],
    routes: [
      "doca.files.route.files",
      "doca.files.route.shared",
      "doca.files.route.shared-folder",
    ],
    navigation: ["doca.files.navigation.files", "doca.files.navigation.shared"],
    conversationKinds: ["file", "folder"],
  },
} as const satisfies Record<string, ClientPluginManifest>;

const documentsBundle: WebPluginBundle<AppWebPluginTypes> = {
  manifest: BUILTIN_CLIENT_MANIFESTS.documents,
  routes: [
    {
      id: "doca.documents.route.home",
      pluginId: "doca.documents",
      path: "/home",
      // The host owns the dashboard shell; this marker delegates its body.
      render: () => undefined,
    },
    {
      id: "doca.documents.route.libraries",
      pluginId: "doca.documents",
      path: "/libraries",
      render: () => undefined,
    },
  ],
  navigation: [
    {
      id: "doca.documents.navigation.home",
      pluginId: "doca.documents",
      order: 10,
      scope: "home",
      path: "/home",
      labelKey: "doca.documents.nav.documents",
      icon: Home,
    },
    {
      id: "doca.documents.navigation.libraries",
      pluginId: "doca.documents",
      order: 40,
      scope: "libraries",
      path: "/libraries",
      labelKey: "doca.documents.nav.libraries",
      icon: BookOpen,
    },
    {
      id: "doca.documents.navigation.knowledge-qa",
      pluginId: "doca.documents",
      order: 41,
      scope: "knowledge-assistants",
      path: "/knowledge-assistants",
      labelKey: "doca.documents.nav.knowledge-qa",
      icon: Bot,
    },
  ],
  searchResults: [
    {
      id: "doca.documents.search.result",
      pluginId: "doca.documents",
      kind: "document",
      render: (result, context) => context.render("document", result),
    },
  ],
  knowledgeSources: [
    {
      id: "doca.documents.knowledge.source",
      pluginId: "doca.documents",
      sourceKind: "document",
      labelKey: "doca.documents.knowledge.source",
      selection: "document",
      render: (config, context) => context.render("document", config),
    },
    {
      id: "doca.documents.knowledge.url-source",
      pluginId: "doca.documents",
      sourceKind: "url",
      labelKey: "doca.documents.knowledge.url",
      selection: "url",
      render: () => null,
    },
  ],
  messages: [
    {
      id: "doca.documents.messages.client",
      pluginId: "doca.documents",
      messages: {
        en: {
          "doca.documents.nav.documents": "Documents",
          "doca.documents.nav.libraries": "Libraries",
          "doca.documents.nav.knowledge-qa": "Knowledge Q&A",
          "doca.documents.search.result": "Document",
          "doca.documents.knowledge.source": "Document source",
          "doca.documents.knowledge.url": "Link",
        },
        zh: {
          "doca.documents.nav.documents": "文档",
          "doca.documents.nav.libraries": "知识库",
          "doca.documents.nav.knowledge-qa": "知识库问答",
          "doca.documents.search.result": "文档",
          "doca.documents.knowledge.source": "文档来源",
          "doca.documents.knowledge.url": "链接",
        },
      },
    },
  ],
};

const filesBundle: WebPluginBundle<AppWebPluginTypes> = {
  manifest: BUILTIN_CLIENT_MANIFESTS.files,
  routes: [
    {
      id: "doca.files.route.files",
      pluginId: "doca.files",
      path: "/files",
      render: (context) => (
        <FilesExplorer onNavigationChange={context.onFileNavigationChange} />
      ),
    },
    {
      id: "doca.files.route.shared",
      pluginId: "doca.files",
      path: "/shared-files",
      render: () => <SharedFoldersPage />,
    },
    {
      id: "doca.files.route.shared-folder",
      pluginId: "doca.files",
      path: "/shared-files/:id",
      render: (context, match) => (
        <FilesExplorer
          key={match.params.id}
          initialRoot={{
            type: "folder",
            id: match.params.id!,
            name: context.sharedFolderName,
          }}
          routeBase={`/shared-files/${match.params.id}`}
          sharedRoot
          onNavigationChange={context.onFileNavigationChange}
        />
      ),
    },
  ],
  navigation: [
    {
      id: "doca.files.navigation.files",
      pluginId: "doca.files",
      order: 50,
      scope: "files",
      path: "/files",
      labelKey: "doca.files.nav.files",
      icon: FolderOpen,
    },
    {
      id: "doca.files.navigation.shared",
      pluginId: "doca.files",
      order: 60,
      scope: "shared-files",
      path: "/shared-files",
      labelKey: "doca.files.nav.shared",
      icon: Users,
    },
  ],
  aiBlocks: [
    {
      id: "doca.files.ai-block.folder",
      pluginId: "doca.files",
      kind: "folder",
      render: (payload, context) => {
        const folder = payload as FolderDelivery;
        return context.onOpen ? (
          <FolderDeliveryCard folder={folder} onOpen={context.onOpen} />
        ) : (
          context.renderLink(folder.path ?? folder.name, folder.href)
        );
      },
    },
    {
      id: "doca.files.ai-block.file",
      pluginId: "doca.files",
      kind: "file",
      render: (payload, context) => (
        <FileDeliveryCard
          file={payload as FileDelivery}
          onOpen={context.onOpen}
        />
      ),
    },
  ],
  searchResults: [
    {
      id: "doca.files.search.result",
      pluginId: "doca.files",
      kind: "file",
      render: (result, context) => context.render("file", result),
    },
  ],
  knowledgeSources: [
    {
      id: "doca.files.knowledge.file-source",
      pluginId: "doca.files",
      sourceKind: "file",
      labelKey: "doca.files.knowledge.file",
      selection: "file",
      render: (config, context) => context.render("file", config),
    },
    {
      id: "doca.files.knowledge.folder-source",
      pluginId: "doca.files",
      sourceKind: "folder",
      labelKey: "doca.files.knowledge.folder",
      selection: "folder",
      render: (config, context) => context.render("folder", config),
    },
  ],
  filePickers: [
    {
      id: "doca.files.file-picker.default",
      pluginId: "doca.files",
      capability: "files.v1",
      render: (context) => (
        <FolderFilePicker
          close={context.close}
          select={context.select}
          accept={context.accept}
          selectFolder={context.selectFolder}
        />
      ),
    },
  ],
  messages: [
    {
      id: "doca.files.messages.client",
      pluginId: "doca.files",
      messages: {
        en: {
          "doca.files.nav.files": "Files",
          "doca.files.nav.shared": "Shared files",
          "doca.files.search.result": "File",
          "doca.files.knowledge.file": "File source",
          "doca.files.knowledge.folder": "Folder source",
          "doca.files.picker.title": "Choose from Doca files",
        },
        zh: {
          "doca.files.nav.files": "文件",
          "doca.files.nav.shared": "共享文件夹",
          "doca.files.search.result": "文件",
          "doca.files.knowledge.file": "文件来源",
          "doca.files.knowledge.folder": "文件夹来源",
          "doca.files.picker.title": "从 Doca 文件夹选择",
        },
      },
    },
  ],
};

export function createBuiltinWebPluginRegistry() {
  const registry = new WebPluginRegistry<AppWebPluginTypes>();
  registry.register(documentsBundle);
  registry.register(filesBundle);
  return registry;
}

export function pluginInstalled(pluginId: string) {
  return (
    webPluginRegistry.routes
      .list()
      .some((route) => route.pluginId === pluginId) ||
    webPluginRegistry.navigation
      .list()
      .some((item) => item.pluginId === pluginId)
  );
}

/**
 * Build-time singleton: locale changes only change translate/render inputs and
 * never reconstruct editor, collaboration, or plugin instances.
 */
export const webPluginRegistry = createBuiltinWebPluginRegistry();

export function renderPluginAIBlock(
  kind: string,
  payload: unknown,
  onOpen?: (href: string) => void,
) {
  const block = webPluginRegistry.aiBlocks
    .list()
    .find((item) => item.kind === kind);
  if (!block) return null;
  return block.render(payload, {
    onOpen,
    renderLink: (label, href) => label || href,
  });
}

export function pluginMessage(
  locale: PluginLocale | string,
  key: string,
  values?: Readonly<Record<string, unknown>>,
) {
  return webPluginRegistry.translate(locale, key, values);
}
