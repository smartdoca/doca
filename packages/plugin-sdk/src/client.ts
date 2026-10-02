import type {
  TemplatesServiceV1,
  MaterialsServiceV1,
} from "./creation-resources.js";
import type {
  DirectorySearchInput,
  DirectoryPage,
  DirectoryUser,
} from "@smartdoca/plugin-contracts";
import type { DocumentReadServiceV1, LibrariesServiceV1 } from "./documents.js";
import type { PluginUser } from "./platform.js";
import type { FilesServiceV1 } from "./files.js";
type WithoutContext<T> = {
  readonly [K in keyof T]: T[K] extends (ctx: any, input: infer I) => infer R
    ? (input: I, options?: { signal?: AbortSignal }) => R
    : never;
};
export interface PluginPlatformClient {
  readonly templates: WithoutContext<
    Pick<
      TemplatesServiceV1,
      "providers" | "tags" | "search" | "describe" | "read" | "consume"
    >
  > & {
    consumers(options?: {
      signal?: AbortSignal;
    }): ReturnType<TemplatesServiceV1["consumers"]>;
  };
  readonly materials: WithoutContext<
    Pick<
      MaterialsServiceV1,
      "providers" | "tags" | "search" | "describe" | "import"
    >
  >;
  readonly users: {
    me(options?: { signal?: AbortSignal }): Promise<PluginUser>;
    searchPage(
      input: DirectorySearchInput,
      options?: { signal?: AbortSignal },
    ): Promise<DirectoryPage>;
    resolveDirectory(
      input: { ids: readonly string[] },
      options?: { signal?: AbortSignal },
    ): Promise<readonly DirectoryUser[]>;
    validateSelection(
      input: { ids: readonly string[] },
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  };
  readonly documents: WithoutContext<DocumentReadServiceV1>;
  readonly libraries: WithoutContext<LibrariesServiceV1>;
  readonly files: {
    readonly folders: WithoutContext<
      Pick<FilesServiceV1["folders"], "get" | "list">
    >;
    readonly files: WithoutContext<
      Pick<FilesServiceV1["files"], "get" | "list">
    >;
  };
}
export function createPluginPlatformClient(
  request: <T>(
    operation: string,
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<T>,
): PluginPlatformClient {
  const call =
    (operation: string) =>
    (input: unknown, options?: { signal?: AbortSignal }) =>
      request<any>(operation, input, options?.signal);
  return Object.freeze({
    templates: Object.freeze({
      providers: call("templates.providers"),
      tags: call("templates.tags"),
      search: call("templates.search"),
      describe: call("templates.describe"),
      read: call("templates.read"),
      consume: call("templates.consume"),
      consumers: (options?: { signal?: AbortSignal }) =>
        request<any>("templates.consumers", {}, options?.signal),
    }),
    materials: Object.freeze({
      providers: call("materials.providers"),
      tags: call("materials.tags"),
      search: call("materials.search"),
      describe: call("materials.describe"),
      import: call("materials.import"),
    }),
    users: Object.freeze({
      me: (options?: { signal?: AbortSignal }) =>
        request<PluginUser>("users.me", {}, options?.signal),
      searchPage: call("users.searchPage"),
      resolveDirectory: call("users.resolveDirectory"),
      validateSelection: call("users.validateSelection"),
    }),
    documents: Object.freeze({
      get: call("documents.get"),
      readSnapshot: call("documents.readSnapshot"),
      capabilities: call("documents.capabilities"),
      references: call("documents.references"),
    }),
    libraries: Object.freeze({
      list: call("libraries.list"),
      children: call("libraries.children"),
      path: call("libraries.path"),
    }),
    files: Object.freeze({
      folders: Object.freeze({
        get: call("files.folders.get"),
        list: call("files.folders.list"),
      }),
      files: Object.freeze({
        get: call("files.files.get"),
        list: call("files.files.list"),
      }),
    }),
  });
}
