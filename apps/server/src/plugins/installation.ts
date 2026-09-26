import { isDeepStrictEqual } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validatePluginManifest, type DocaPlugin, type PluginManifest } from "@doca/plugin-sdk";
import { validatePluginGraph } from "@doca/plugin-host";
import { scopeInstalledPlugin } from "./scope.js";

export interface InstalledPlugin {
  readonly packageName: string;
  readonly root: string;
  readonly manifest: PluginManifest;
  readonly server: string;
  readonly web?: { readonly root: string; readonly entry: string };
}
export function pluginDirectory() {
  return path.resolve(process.env.DOCA_PLUGINS_DIR?.trim() || path.join(process.env.DOCA_DATA_DIR?.trim() || "./data", "plugins"));
}
export async function packageFile(root: string, entry: string): Promise<string> {
  if (typeof entry !== "string" || !entry.startsWith("./") || entry.includes("\\"))
    throw new Error("Plugin entry must be a package-relative ./ path");
  const resolved = await realpath(path.resolve(root, entry));
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Plugin entry escapes its package");
  return resolved;
}
export async function discoverInstalledPlugins(
  directory: string,
  options: { readonly disabled?: Readonly<Record<string, boolean | undefined>> } = {},
): Promise<InstalledPlugin[]> {
  const manifestPath = path.resolve(directory, "package.json");
  let install: { dependencies?: Record<string, string> };
  try { install = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (install.dependencies != null && (typeof install.dependencies !== "object" || Array.isArray(install.dependencies)))
    throw new Error("Plugin installation dependencies must be an object");
  const installed: InstalledPlugin[] = [];
  for (const packageName of Object.keys(install.dependencies ?? {}).sort()) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) throw new Error("Invalid installed package name");
    if (options.disabled?.[packageName] === false) continue;
    // Resolve only from this installation, never fall back to the host's dependencies.
    const root = await realpath(path.join(directory, "node_modules", packageName));
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (pkg.name !== packageName) throw new Error(`Installed package name mismatch: ${packageName}`);
    if (!pkg.doca) continue;
    const manifestFile = await packageFile(root, pkg.doca.manifest);
    if (!manifestFile.endsWith(".json")) throw new Error("Plugin manifest must be static JSON");
    const manifest = validatePluginManifest(JSON.parse(await readFile(manifestFile, "utf8")));
    if (options.disabled?.[manifest.id] === false) continue;
    if (manifest.version !== pkg.version) throw new Error(`Plugin version mismatch: ${packageName}`);
    const server = await packageFile(root, pkg.doca.server);
    if (!/\.(?:mjs|cjs|js)$/.test(server) || !(await stat(server)).isFile())
      throw new Error("Plugin server entry must be compiled JavaScript");
    let web: InstalledPlugin["web"];
    if (pkg.doca.web) {
      const webRoot = await packageFile(root, pkg.doca.web.directory);
      const entry = await packageFile(webRoot, pkg.doca.web.entry);
      if (!(await stat(webRoot)).isDirectory() || !entry.endsWith(".js")) throw new Error("Invalid plugin Web entry");
      web = { root: webRoot, entry: path.relative(webRoot, entry).split(path.sep).join("/") };
    }
    installed.push({ packageName, root, manifest, server, web });
  }
  return installed;
}
export async function importInstalledPlugins(installed: readonly InstalledPlugin[], core: readonly PluginManifest[] = []): Promise<DocaPlugin[]> {
  const order = validatePluginGraph([...core, ...installed.map(p => p.manifest)]);
  const plugins: DocaPlugin[] = [];
  for (const manifest of order) {
    const descriptor = installed.find(p => p.manifest.id === manifest.id);
    if (!descriptor) continue;
    const loaded = await import(pathToFileURL(descriptor.server).href);
    if (typeof loaded.default !== "function") throw new Error(`${descriptor.packageName} must export a plugin factory`);
    const plugin = loaded.default() as DocaPlugin;
    if (!isDeepStrictEqual(validatePluginManifest(plugin.manifest), descriptor.manifest))
      throw new Error(`Runtime manifest differs from static manifest: ${descriptor.packageName}`);
    plugins.push(scopeInstalledPlugin(plugin));
  }
  return plugins;
}
export async function loadInstalledPlugins(directory: string, options: { readonly disabled?: Readonly<Record<string, boolean | undefined>> } = {}) {
  return importInstalledPlugins(await discoverInstalledPlugins(directory, options));
}
