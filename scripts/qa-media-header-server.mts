import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";

if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated fixture only");
const root = await mkdtemp(join(tmpdir(), "doca-media-header-"));
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root } },
});
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
await createUser(
  db,
  {
    login: "mediaqa",
    displayName: "视频与导航验收",
    password: "isolated-media-header-2026",
  },
  { bootstrap: true },
);
const origin = "http://127.0.0.1:39361";
const app = await createApp(db, {
  origin,
  storage: { ...storageRuntime(), root },
  ai: { memory: { driver: "sqlite", url: ":memory:" } },
});
const web = await createServer({
  configFile: resolve("apps/web/vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 39361,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:39360", ws: true },
      "/health": { target: "http://127.0.0.1:39360" },
    },
  },
});
await app.listen({ host: "127.0.0.1", port: 39360 });
await web.listen();
console.log("Isolated media/header QA ready at " + origin);
async function close() {
  await web.close();
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
  process.exit();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
