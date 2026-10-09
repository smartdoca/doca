import type { FastifyInstance, FastifyRequest } from "fastify";
import { fail } from "@core/shared/errors.js";
import type { PluginStore } from "./store.js";

/** Store branding is display-only and never changes the installation registry. */
export function registerStorePluginIcons(
  api: FastifyInstance,
  authenticate: (request: FastifyRequest) => unknown,
  pluginIds: ReadonlySet<string>,
  store: PluginStore,
) {
  const cache = new Map<
    string,
    { expiresAt: number; image: Promise<Buffer | null> }
  >();
  const imageFor = (id: string) => {
    const cached = cache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.image;
    const entry = {
      expiresAt: Infinity,
      image: store
        .detail(id)
        .then(({ plugin }) =>
          plugin.icon
            ? Buffer.from(
                plugin.icon.slice("data:image/png;base64,".length),
                "base64",
              )
            : null,
        )
        .catch((error) => {
          api.log.warn(
            { err: error, pluginId: id },
            "Plugin store icon unavailable",
          );
          return null;
        })
        .finally(() => {
          entry.expiresAt = Date.now() + 60_000;
        }),
    };
    cache.set(id, entry);
    return entry.image;
  };

  api.get<{ Params: { id: string } }>(
    "/api/v1/plugin-icons/:id",
    async (request, reply) => {
      authenticate(request);
      reply.header("Cache-Control", "no-store");
      // Only running store/npm installations may resolve public store branding.
      if (!pluginIds.has(request.params.id)) fail(404, "Plugin icon not found");
      const image = await imageFor(request.params.id);
      if (!image) fail(404, "Plugin icon not found");
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .type("image/png")
        .send(image);
    },
  );
}
