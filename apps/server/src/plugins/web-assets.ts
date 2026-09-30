import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { packageFile, type InstalledPlugin } from "./installation.js";
import { fail } from "@core/shared/errors.js";

export function pluginWebUrl(plugin: InstalledPlugin) {
  return plugin.web
    ? `/api/v1/plugin-assets/${plugin.manifest.id}/${plugin.manifest.version}/${plugin.web.entry}`
    : undefined;
}
export function registerPluginAssets(
  api: FastifyInstance,
  plugins: readonly InstalledPlugin[],
  resolve?: (
    id: string,
    version: string,
  ) => Promise<InstalledPlugin | undefined>,
) {
  api.get<{ Params: { id: string; version: string; "*": string } }>(
    "/api/v1/plugin-assets/:id/:version/*",
    async (request, reply) => {
      const plugin =
        plugins.find(
          (p) =>
            p.manifest.id === request.params.id &&
            p.manifest.version === request.params.version,
        ) ?? (await resolve?.(request.params.id, request.params.version));
      if (!plugin?.web) fail(404, "Plugin asset not found");
      const file = await packageFile(
        plugin.web.root,
        `./${request.params["*"]}`,
      ).catch(() => fail(404, "Plugin asset not found"));
      if (!(await stat(file)).isFile()) fail(404, "Plugin asset not found");
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".woff2": "font/woff2",
        ".json": "application/json",
      };
      const type = types[extname(file)];
      if (!type) fail(404, "Plugin asset not found");
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-cache")
        .type(type)
        .send(await readFile(file));
    },
  );
}
