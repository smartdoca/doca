import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { openDatabase } from "@db/index.js";
import { createApp } from "./app/create-app.js";
import { config } from "./bootstrap/config.js";

const cfg = config(),
  dev = process.argv.includes("--dev");
if (dev && process.env.NODE_ENV === "production")
  throw new Error("Development server is disabled in production");
const db = await openDatabase(cfg.database, { schema: cfg.schemaMode });
let api: Awaited<ReturnType<typeof createApp>> | undefined,
  web: ViteDevServer | undefined,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await web?.close();
  await api?.close();
  await db.destroy();
}
try {
  api = await createApp(db, {
    origin: cfg.origin,
    logging: true,
    redisUrl: cfg.redisUrl,
    redisPrefix: cfg.redisPrefix,
    instanceId: cfg.instanceId,
    trustProxy: cfg.trustProxy,
    ...(!dev ? { staticDirectory: resolve("apps/web/dist") } : {}),
  });
  if (dev)
    web = await createServer({
      configFile: resolve("apps/web/vite.config.ts"),
      server: {
        host: cfg.host,
        port: cfg.webPort,
        strictPort: true,
        allowedHosts: [new URL(cfg.origin).hostname],
        proxy: {
          "/api": {
            ws: true,
            target: `http://127.0.0.1:${cfg.port}`,
            changeOrigin: false,
          },
          "/health": {
            target: `http://127.0.0.1:${cfg.port}`,
            changeOrigin: false,
          },
        },
      },
    });
  await api.listen({ host: cfg.host, port: cfg.port });
  await web?.listen();
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  await stop();
  throw error;
}
