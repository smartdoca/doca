import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { AppError, fail } from "@core/shared/errors.js";
import { PluginStore } from "@server/plugins/store.js";
import { registerStorePluginIcons } from "@server/plugins/store-icons.js";

const pluginId = "example.tools";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
const icon = `data:image/png;base64,${png.toString("base64")}`;
const detail = (image: string | null = icon, id = pluginId) => ({
  protocolVersion: 1,
  plugin: {
    id,
    official: true,
    name: "Tools",
    summary: "Tools plugin",
    author: { name: "Example", url: null },
    categoryId: "productivity",
    icon: image,
    detailPath: `/plugins/${id}`,
    targets: ["web"],
    review: "approved",
    latestVersion: "0.1.2",
    downloads: { count: 2, period: "last30Days", source: "npm", asOf: null },
    likes: { count: 0, asOf: null },
    updatedAt: "2026-10-05T00:00:00Z",
  },
  description: { format: "doca-slate", version: 1, nodes: [] },
});
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(fetcher: typeof fetch) {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof AppError ? error.status : 500).send({
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  registerStorePluginIcons(
    app,
    (request) => {
      if (request.headers.cookie !== "session=test") fail(401, "Sign in");
    },
    new Set([pluginId]),
    new PluginStore("https://store.example", fetcher),
  );
  const request = (id = pluginId, authenticated = true) =>
    app.inject({
      url: `/api/v1/plugin-icons/${id}`,
      headers: authenticated ? { cookie: "session=test" } : {},
    });
  return { app, request };
}

it("serves the store's exact PNG to signed-in users and shares concurrent reads", async () => {
  const fetcher = vi.fn(async () => Response.json(detail()));
  const { request } = fixture(fetcher as typeof fetch);
  expect((await request(pluginId, false)).statusCode).toBe(401);
  for (const id of [
    "local.plugin",
    "disabled.plugin",
    "doca.files",
    "unknown.plugin",
  ])
    expect((await request(id)).statusCode).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
  const responses = await Promise.all([request(), request(), request()]);
  for (const response of responses) {
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(png);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toMatchObject([
    `https://store.example/api/v1/plugins/${pluginId}?locale=zh`,
    { redirect: "error" },
  ]);
});

it("refreshes changed store branding after the 60-second memory cache expires", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const fetcher = vi.fn(async () => Response.json(detail()));
  const { request } = fixture(fetcher as typeof fetch);
  expect((await request()).statusCode).toBe(200);
  fetcher.mockImplementation(async () => Response.json(detail(null)));
  now += 59_999;
  expect((await request()).rawPayload).toEqual(png);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += 1;
  expect((await request()).statusCode).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  ["missing icon", () => Response.json(detail(null))],
  ["unknown plugin", () => new Response(null, { status: 404 })],
  [
    "store failure",
    () => {
      throw new Error("Store offline");
    },
  ],
  ["wrong identity", () => Response.json(detail(icon, "example.other"))],
  ["remote image", () => Response.json(detail("https://example.com/icon.png"))],
  [
    "SVG image",
    () => Response.json(detail("data:image/svg+xml;base64,PHN2Zz4=")),
  ],
] as const)(
  "returns a cached miss for %s without disrupting plugin loading",
  async (_name, response) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn(async () => response());
    const { request } = fixture(fetcher as typeof fetch);
    expect((await request()).statusCode).toBe(404);
    expect((await request()).statusCode).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60_000;
    fetcher.mockImplementation(async () => Response.json(detail()));
    expect((await request()).rawPayload).toEqual(png);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
