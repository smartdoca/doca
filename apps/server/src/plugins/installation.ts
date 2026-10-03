import type { PluginStorageServices } from "../services/plugin-storage.js";
import { pluginNavigationSchema } from "./navigation-schema.js";
import type { NavigationEntry } from "@smartdoca/web-plugin-registry";
import { isDeepStrictEqual } from "node:util";
import { readFile, realpath, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validatePluginManifest,
  satisfiesPluginVersion,
  comparePluginVersions,
  type DocaPlugin,
  type PluginManifest,
} from "@smartdoca/plugin-sdk";
import { validatePluginGraph } from "@doca/plugin-host";
import { scopeInstalledPlugin } from "./scope.js";

export interface InstalledPlugin {
  readonly mobileHostRange?: string;
  readonly navigation: NavigationEntry[];
  readonly packageName: string;
  readonly dataVersion: string;
  readonly root: string;
  readonly manifest: PluginManifest;
  readonly server: string;
  readonly web?: { readonly root: string; readonly entry: string };
}
export function pluginDirectory() {
  return path.resolve(
    process.env.DOCA_PLUGINS_DIR?.trim() ||
      path.join(process.env.DOCA_DATA_DIR?.trim() || "./data", "plugins"),
  );
}
export async function packageFile(
  root: string,
  entry: string,
): Promise<string> {
  if (
    typeof entry !== "string" ||
    !entry.startsWith("./") ||
    entry.includes("\\")
  )
    throw new Error("Plugin entry must be a package-relative ./ path");
  const resolved = await realpath(path.resolve(root, entry));
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Plugin entry escapes its package");
  return resolved;
}
export async function discoverInstalledPlugins(
  directory: string,
  options: {
    readonly disabled?: Readonly<Record<string, boolean | undefined>>;
  } = {},
): Promise<InstalledPlugin[]> {
  const installed: InstalledPlugin[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const plugin = await inspectPlugin(path.join(directory, entry.name));
    if (entry.name !== plugin.manifest.id)
      throw new Error("Plugin directory must equal manifest id");
    if (options.disabled?.[plugin.manifest.id] !== false)
      installed.push(plugin);
  }
  return installed;
}
export async function inspectPlugin(
  directory: string,
): Promise<InstalledPlugin> {
  const root = await realpath(directory);
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const packageName = pkg.name;
  if (
    typeof packageName !== "string" ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)
  )
    throw new Error("Invalid package name");
  if (
    !pkg.doca ||
    typeof pkg.doca.dataVersion !== "string" ||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(pkg.doca.dataVersion)
  )
    throw new Error("doca.dataVersion is required");
  if (pkg.doca.storage !== "host")
    throw new Error(
      'doca.storage must be "host": plugins must use host-managed storage',
    );
  const manifestFile = await packageFile(root, pkg.doca.manifest);
  if (!manifestFile.endsWith(".json"))
    throw new Error("Plugin manifest must be static JSON");
  const manifest = validatePluginManifest(
    JSON.parse(await readFile(manifestFile, "utf8")),
  );
  if (Object.hasOwn(Object.prototype, manifest.id))
    throw new Error("Reserved plugin identifier");
  if (!manifest.sdkRange) throw new Error("sdkRange is required");
  const sdkFloor = manifest.sdkRange.replace(/^[~^]/, "");
  if (
    !/^\d+\.\d+\.\d+$/.test(sdkFloor) ||
    comparePluginVersions(sdkFloor, "0.1.7") < 0
  )
    throw new Error("Installed plugins must require SDK 0.1.7 or newer");
  if (manifest.version !== pkg.version)
    throw new Error(`Plugin version mismatch: ${packageName}`);
  const server = await packageFile(root, pkg.doca.server);
  if (!/\.(?:mjs|cjs|js)$/.test(server) || !(await stat(server)).isFile())
    throw new Error("Plugin server entry must be compiled JavaScript");
  let web: InstalledPlugin["web"];
  if (pkg.doca.web) {
    const webRoot = await packageFile(root, pkg.doca.web.directory);
    const entry = await packageFile(webRoot, pkg.doca.web.entry);
    if (!(await stat(webRoot)).isDirectory() || !entry.endsWith(".js"))
      throw new Error("Invalid plugin Web entry");
    web = {
      root: webRoot,
      entry: path.relative(webRoot, entry).split(path.sep).join("/"),
    };
  }
  const navigation = pluginNavigationSchema
    .parse(pkg.doca.navigation ?? [])
    .map((entry) => {
      if (
        !web ||
        !entry.id.startsWith(`${manifest.id}.`) ||
        !entry.webPath.startsWith(`/plugins/${manifest.id}/`) ||
        entry.defaults.some((slot) => !entry.allowedSlots.includes(slot)) ||
        (!entry.mobile &&
          entry.allowedSlots.some((slot) => slot.startsWith("mobile.")))
      )
        throw new Error("Invalid plugin navigation declaration");
      return { ...entry, pluginId: manifest.id };
    });
  if (
    navigation.some((e) => e.mobile) &&
    (typeof pkg.doca.mobileHostRange !== "string" ||
      pkg.doca.mobileHostRange.length > 100)
  )
    throw new Error("mobileHostRange is required");
  if (
    pkg.doca.mobileHostRange &&
    !satisfiesPluginVersion("1.0.0", pkg.doca.mobileHostRange)
  )
    throw new Error("Unsupported mobile host version");
  if (
    navigation.some(
      (e) =>
        new Set(e.allowedSlots).size !== e.allowedSlots.length ||
        new Set(e.defaults).size !== e.defaults.length,
    )
  )
    throw new Error("Duplicate navigation slot");
  if (new Set(navigation.map((entry) => entry.id)).size !== navigation.length)
    throw new Error("Duplicate navigation entry");
  return {
    navigation,
    mobileHostRange: pkg.doca.mobileHostRange,
    packageName,
    root,
    manifest,
    server,
    web,
    dataVersion: pkg.doca.dataVersion,
  };
}
export async function instantiateInstalledPlugin(
  descriptor: InstalledPlugin,
  storage?: PluginStorageServices,
): Promise<DocaPlugin> {
  const loaded = await import(pathToFileURL(descriptor.server).href);
  if (typeof loaded.default !== "function")
    throw new Error(`${descriptor.packageName} must export a plugin factory`);
  const plugin = loaded.default() as DocaPlugin;
  if (
    !isDeepStrictEqual(
      validatePluginManifest(plugin.manifest),
      descriptor.manifest,
    )
  )
    throw new Error(
      `Runtime manifest differs from static manifest: ${descriptor.packageName}`,
    );
  if (typeof plugin.uninstall !== "function")
    throw new Error(
      `Plugin ${descriptor.manifest.id} must implement uninstall`,
    );
  return scopeInstalledPlugin(plugin, storage);
}
export async function importInstalledPlugins(
  installed: readonly InstalledPlugin[],
  core: readonly PluginManifest[] = [],
  storageFor?: (plugin: InstalledPlugin) => Promise<PluginStorageServices>,
): Promise<DocaPlugin[]> {
  const order = validatePluginGraph([
    ...core,
    ...installed.map((p) => p.manifest),
  ]);
  const plugins: DocaPlugin[] = [];
  for (const manifest of order) {
    const descriptor = installed.find((p) => p.manifest.id === manifest.id);
    if (!descriptor) continue;
    plugins.push(
      await instantiateInstalledPlugin(
        descriptor,
        await storageFor?.(descriptor),
      ),
    );
  }
  return plugins;
}
export async function loadInstalledPlugins(
  directory: string,
  options: {
    readonly disabled?: Readonly<Record<string, boolean | undefined>>;
  } = {},
) {
  return importInstalledPlugins(
    await discoverInstalledPlugins(directory, options),
  );
}
