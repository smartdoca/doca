import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DocaPlugin } from "@doca/plugin-sdk";

interface PluginPackageJson {
  readonly doca?: {
    readonly server?: string;
  };
}

export async function loadInstalledPlugins(
  directory: string,
  options: { readonly disabled?: object } = {},
): Promise<DocaPlugin[]> {
  const disabled = options.disabled as
    | Readonly<Record<string, boolean | undefined>>
    | undefined;
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const plugins: DocaPlugin[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || disabled?.[name] === false) continue;
    const root = path.join(directory, name);
    if (!(await stat(root)).isDirectory()) continue;
    let manifest: PluginPackageJson;
    try {
      manifest = JSON.parse(
        await readFile(path.join(root, "package.json"), "utf8"),
      ) as PluginPackageJson;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    const entry = manifest.doca?.server;
    if (!entry) continue;
    const loaded = (await import(
      pathToFileURL(path.resolve(root, entry)).href
    )) as { default?: () => DocaPlugin };
    if (typeof loaded.default !== "function")
      throw new Error(
        `${name} 的 doca.server 必须默认导出创建插件的函数`,
      );
    plugins.push(loaded.default());
  }
  return plugins;
}
