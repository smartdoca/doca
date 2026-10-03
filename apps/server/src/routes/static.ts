import { fail } from "@core/shared/errors.js";
import { HOST_VERSION } from "../app/version.js";
import type { DB } from "@db/index.js";
import type { FastifyInstance } from "fastify";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const hashedAssetCache = "public, max-age=31536000, immutable";

export function staticCacheControl(path: string) {
  return path.startsWith("/assets/") ? hashedAssetCache : "no-cache";
}

export function rewriteAssetUrls(html: string, assetBase?: string) {
  if (!assetBase) return html;
  return html
    .replaceAll('"/assets/', `"${assetBase}/assets/`)
    .replaceAll("'/assets/", `'${assetBase}/assets/`);
}

export async function registerStaticRoutes(
  api: FastifyInstance,
  db: DB,
  staticDirectory?: string,
  realtimeReady: () => boolean = () => true,
  assetBase?: string,
) {
  api.get("/api/openapi.json", { schema: { hide: true } }, async () =>
    api.swagger(),
  );
  api.get("/live", { schema: { hide: true } }, async () => ({
    status: "ok",
    version: HOST_VERSION,
  }));
  const ready = async () => {
    await db.selectFrom("settings").select("id").executeTakeFirstOrThrow();
    if (!realtimeReady()) fail(503, "实时集群尚未就绪");
    return { status: "ok", version: HOST_VERSION };
  };
  api.get("/ready", { schema: { hide: true } }, ready);
  api.get("/health", { schema: { hide: true } }, ready);

  if (!staticDirectory) return;
  const directory = await realpath(staticDirectory);
  api.get("/*", { schema: { hide: true } }, async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (
      path !== "/" &&
      path !== "/favicon.svg" &&
      !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)
    )
      fail(404, "页面不存在");
    const file = await realpath(
      resolve(directory, path === "/" ? "index.html" : path.slice(1)),
    ).catch(() => fail(404, "文件不存在"));
    if (!file.startsWith(directory + sep)) fail(404, "文件不存在");
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    const body = await readFile(file);
    return reply
      .header("Cache-Control", staticCacheControl(path))
      .type(mime[extname(file)] ?? "application/octet-stream")
      .send(
        extname(file) === ".html"
          ? rewriteAssetUrls(body.toString("utf8"), assetBase)
          : body,
      );
  });
}
