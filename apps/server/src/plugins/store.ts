import { z } from "zod";
import { downloadNpm } from "./npm.js";
export class StoreCursorExpired extends Error {}
export const MAX_PLUGIN_BYTES = 32 * 1024 * 1024;
const id = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
  .max(100);
const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/)
  .max(100);
const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const targets = z
  .array(z.enum(["web", "mobile"]))
  .min(1)
  .max(2);
export const releaseSchema = z.object({
  pluginId: id,
  version,
  sdkRange: z.string().min(1).max(100),
  dataVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  targets,
  mobileHostRange: z.string().max(100).optional(),
  dependencies: z
    .array(
      z.object({
        id,
        range: z.string().max(100),
        optional: z.boolean().optional(),
      }),
    )
    .max(100),
  review: z.enum(["approved", "withdrawn"]),
  reviewedAt: z.string().datetime(),
  publishedAt: z.string().datetime(),
  npm: z.object({
    registry: z.string().url(),
    name: z.string().max(214),
    version,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
    size: z.number().int().positive().max(MAX_PLUGIN_BYTES),
  }),
});
const plugin = z.object({
  id,
  name: z.string().min(1).max(160),
  summary: z.string().max(300),
  author: z.object({
    name: z.string().min(1).max(160),
    url: z.string().url().startsWith("https://").nullable(),
  }),
  categoryId: z.string().regex(/^[a-z0-9-]{1,60}$/),
  icon: z
    .string()
    .max(24576)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
    .nullable(),
  detailPath: z.string().regex(/^\/plugins\/[a-z][a-z0-9.-]*$/),
  targets,
  review: z.enum(["approved", "suspended"]),
  latestVersion: version.nullable(),
  downloads: z.object({
    count,
    period: z.literal("last30Days"),
    source: z.literal("npm"),
    asOf: z.string().datetime().nullable(),
  }),
  likes: z.object({ count, asOf: z.string().datetime().nullable() }),
  updatedAt: z.string().datetime(),
});
const page = z.object({
  nextCursor: z.string().max(2048).nullable(),
  total: count,
  snapshotAt: z.string().datetime(),
});
export const storeQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    category: z
      .string()
      .regex(/^[a-z0-9-]{1,60}$/)
      .optional(),
    target: z.enum(["web", "mobile"]).optional(),
    sort: z.enum(["updated", "downloads", "likes", "name"]).optional(),
    limit: z.coerce.number().int().min(1).max(48).optional(),
    cursor: z.string().max(2048).optional(),
    locale: z.enum(["zh", "en"]).optional(),
  })
  .strict();
export function pluginStoreUrl() {
  const url = new URL(
    process.env.DOCA_PLUGIN_STORE_URL?.trim() || "https://store.smartdoca.cc",
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("DOCA_PLUGIN_STORE_URL must be an HTTPS origin");
  return url.origin;
}
export async function readBounded(response: Response, max: number) {
  if (!response.ok || !response.body)
    throw new Error(`Store HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > max) {
    await response.body.cancel();
    throw new Error("Store response too large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > max) throw new Error("Store response too large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export class PluginStore {
  constructor(
    readonly origin = pluginStoreUrl(),
    private readonly fetcher = fetch,
  ) {}
  private async json(path: string, body?: unknown) {
    const response = await this.fetcher(`${this.origin}/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 410) { await response.body?.cancel(); throw new StoreCursorExpired("Store cursor expired"); }
    return JSON.parse(
      (await readBounded(response, 2 * 1024 * 1024)).toString(),
    );
  }
  async catalog(query: unknown = {}) {
    const parsed = storeQuerySchema.parse(query);
    const search = new URLSearchParams(
      Object.entries(parsed).map(([k, v]) => [k, String(v)]),
    );
    return z
      .object({
        protocolVersion: z.literal(1),
        items: z.array(plugin).max(48),
        page,
      })
      .parse(await this.json(`/plugins?${search}`));
  }
  async categories(locale = "zh") {
    return z
      .object({
        protocolVersion: z.literal(1),
        items: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z0-9-]{1,60}$/),
              name: z.string().max(160),
              count,
            }),
          )
          .max(100),
      })
      .parse(
        await this.json(`/categories?locale=${locale === "en" ? "en" : "zh"}`),
      );
  }
  async detail(pluginId: string, locale = "zh") {
    id.parse(pluginId);
    const result = z
      .object({
        protocolVersion: z.literal(1),
        plugin,
        description: z.object({
          format: z.string().max(40),
          version: z.number().int(),
          nodes: z.array(z.unknown()).max(5000),
        }),
      })
      .parse(
        await this.json(
          `/plugins/${pluginId}?locale=${locale === "en" ? "en" : "zh"}`,
        ),
      );
    if (result.plugin.id !== pluginId || result.plugin.detailPath !== `/plugins/${pluginId}`) throw new Error("Store plugin identity mismatch");
    return result;
  }
  async releases(pluginId: string, cursor?: string) {
    id.parse(pluginId);
    if (cursor && cursor.length > 2048) throw new Error("Invalid cursor");
    return z
      .object({
        protocolVersion: z.literal(1),
        items: z.array(releaseSchema).max(48),
        page,
      })
      .parse(
        await this.json(
          `/plugins/${pluginId}/releases?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      );
  }
  async updates(
    plugins: {
      id: string;
      version: string;
      dataVersion: string;
      npm?: { name: string; registry: string };
    }[],
  ) {
    const results = [];
    for (let offset = 0; offset < plugins.length; offset += 100) {
      const batch = plugins.slice(offset, offset + 100);
      const data = z
        .object({
          protocolVersion: z.literal(1),
          checkedAt: z.string().datetime(),
          items: z
            .array(
              z.object({
                id,
                installedVersion: version,
                status: z.enum([
                  "update_available",
                  "up_to_date",
                  "incompatible",
                  "unknown",
                ]),
                currentReview: z.enum(["approved", "withdrawn", "unknown"]),
                latestVersion: version.nullable(),
                release: releaseSchema.nullable(),
                reason: z.string().max(100).nullable(),
              }),
            )
            .max(100),
        })
        .parse(
          await this.json("/updates/check", {
            protocolVersion: 1,
            host: { sdkVersion: "0.1.0", mobileHostVersion: "1.0.0" },
            plugins: batch,
          }),
        );
      if (
        data.items.length !== batch.length ||
        new Set(data.items.map((x) => x.id)).size !== batch.length ||
        data.items.some(
          (x) =>
            !batch.some(
              (p) => p.id === x.id && p.version === x.installedVersion,
            ) ||
            (x.status === "update_available" &&
              (!x.release ||
                x.release.pluginId !== x.id ||
                x.release.review !== "approved")),
        )
      )
        throw new Error("Invalid update response");
      results.push(...data.items);
    }
    return { items: results };
  }
  async download(pluginId: string, releaseVersion: string) {
    id.parse(pluginId);
    version.parse(releaseVersion);
    const { release } = z
      .object({ protocolVersion: z.literal(1), release: releaseSchema })
      .parse(
        await this.json(`/plugins/${pluginId}/releases/${releaseVersion}`),
      );
    if (
      release.pluginId !== pluginId ||
      release.version !== releaseVersion ||
      release.review !== "approved" ||
      release.npm.version !== releaseVersion
    )
      throw new Error("Release is not approved");
    const result = await downloadNpm(
      release.npm.name,
      releaseVersion,
      release.npm,
      this.fetcher,
    );
    return { ...result, release };
  }
}
