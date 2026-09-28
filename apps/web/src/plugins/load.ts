import { createWebHost, isolatePluginBundle } from "./web-host.js";
import { webPluginRegistry } from "./registry.js";

/** Browser plugins export default(host) and bundle their own dependencies except React.
 * React is explicitly injected, so dynamically installed packages cannot create a second renderer.
 */
export async function loadWebPlugins() {
  const response = await fetch("/api/v1/bootstrap", { credentials: "same-origin", signal: AbortSignal.timeout(10000) });
  if (!response.ok) return;
  const bootstrap = await response.json();
  const loaded = await Promise.all((bootstrap.plugins ?? []).map(async (plugin: { id: string; version: string; web?: string }) => {
    if (!plugin.web) return;
    const expected = `/api/v1/plugin-assets/${plugin.id}/${plugin.version}/`;
    if (typeof plugin.web !== "string" || !plugin.web.startsWith(expected)) return;
    try {
      const bundle = await bounded((async () => {
        const module = await import(/* @vite-ignore */ plugin.web!);
        return module.default(createWebHost(plugin.id));
      })());
      if (bundle.manifest.pluginId !== plugin.id || bundle.manifest.version !== plugin.version)
        throw new Error("Plugin client/server version mismatch");
      return bundle;
    } catch (error) {
      console.error(`Unable to load plugin ${plugin.id}`, error);
    }
  }));
  for (const bundle of loaded) {
    if (!bundle) continue;
    try { webPluginRegistry.register(isolatePluginBundle(bundle)); }
    catch (error) { console.error(`Unable to register plugin ${bundle.manifest.pluginId}`, error); }
  }
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Plugin load timed out")), 10000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
