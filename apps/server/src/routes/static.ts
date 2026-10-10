import { fail } from "@core/shared/errors.js";
import { HOST_VERSION } from "../app/version.js";
import type { DB } from "@db/index.js";
import type { FastifyInstance } from "fastify";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import {
  contentEncoding,
  staticCompressionCache,
} from "../services/static-compression.js";

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
  const compress = staticCompressionCache();
  api.get("/*", { schema: { hide: true } }, async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (
      path !== "/" &&
      path !== "/favicon.svg" &&
      !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path) &&
      !/^\/cad\/(?:libredwg-web\.wasm|libredwg-parser-worker\.js|mtext-renderer-worker\.js)$/.test(
        path,
      )
    )
      fail(404, "页面不存在");
    const file = await realpath(
      resolve(directory, path === "/" ? "index.html" : path.slice(1)),
    ).catch(() => fail(404, "文件不存在"));
    if (!file.startsWith(directory + sep)) fail(404, "文件不存在");
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".wasm": "application/wasm",
      ".ttf": "font/ttf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };
    reply.header("Vary", "Accept-Encoding");
    const encoding = contentEncoding(req.headers["accept-encoding"]);
    if (!encoding) fail(406, "No acceptable content encoding");
    const extension = extname(file);
    const raw = await readFile(file);
    const body =
      extension === ".html"
        ? Buffer.from(rewriteAssetUrls(raw.toString("utf8"), assetBase))
        : raw;
    let payload: Buffer = body;
    if (encoding !== "identity") {
      const info = await stat(file);
      const key = `${file}:${info.mtimeMs}:${info.size}:${extension === ".html" ? (assetBase ?? "") : ""}`;
      payload = await compress(key, body, encoding);
      reply.header("Content-Encoding", encoding);
    }
    return reply
      .header("Cache-Control", staticCacheControl(path))
      .type(mime[extension] ?? "application/octet-stream")
      .send(payload);
  });
}
