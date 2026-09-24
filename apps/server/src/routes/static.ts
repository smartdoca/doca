import { fail } from "@core/shared/errors.js";
import type { DB } from "@db/index.js";
import type { FastifyInstance } from "fastify";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export async function registerStaticRoutes(
  api: FastifyInstance,
  db: DB,
  staticDirectory?: string,
) {
  api.get("/api/openapi.json", { schema: { hide: true } }, async () =>
    api.swagger(),
  );
  api.get("/health", { schema: { hide: true } }, async () => {
    await db.selectFrom("settings").select("id").executeTakeFirstOrThrow();
    return { status: "ok", version: "0.1.0" };
  });

  if (!staticDirectory) return;
  const directory = await realpath(staticDirectory);
  api.get("/*", { schema: { hide: true } }, async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (path !== "/" && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path))
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
    return reply
      .type(mime[extname(file)] ?? "application/octet-stream")
      .send(await readFile(file));
  });
}
