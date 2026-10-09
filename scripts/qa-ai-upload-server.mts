if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Isolated upload QA only: set DOCA_QA_ISOLATED=1");
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { saveUploadPolicy } from "../packages/core/src/modules/ai/upload-policy.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
import { mockAI } from "../tests/ai-mock.js";
const root = await mkdtemp(join(tmpdir(), "doca-upload-qa-"));
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root } },
});
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const owner = await createUser(
  db,
  {
    login: "uploadqa",
    displayName: "上传验收",
    password: "isolated-upload-qa-2026",
  },
  { bootstrap: true },
);
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    defaultModel: "mock",
    vendors: [
      {
        id: "test-vendor",
        name: "隔离测试",
        provider: "compatible",
        baseUrl: "https://mock.invalid/v1",
        apiKey: "not-real",
        enabled: true,
      },
    ],
    models: [
      {
        id: "mock",
        vendorId: "test-vendor",
        model: "mock",
        alias: "隔离模拟模型",
        enabled: true,
        maxInput: 64000,
        maxOutput: 2000,
        vision: true,
        tools: true,
      },
    ],
  },
  0,
);
await saveUploadPolicy(
  db,
  {
    version: 1,
    global: { maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 },
    users: {},
  },
  0,
);
const origin = "http://127.0.0.1:39351";
const app = await createApp(db, {
  origin,
  staticDirectory: resolve("apps/web/dist"),
  storage: { ...storageRuntime(), root },
  ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    fetch: mockAI({ delay: 150 }),
  },
});
const login = await app.inject({
  method: "POST",
  url: "/api/v1/auth/login",
  headers: { origin, host: "127.0.0.1:39351" },
  payload: { login: "uploadqa", password: "isolated-upload-qa-2026" },
});
const headers = {
  origin,
  host: "127.0.0.1:39351",
  cookie: String(login.headers["set-cookie"]).split(";")[0]!,
};
async function post(path: string, payload: any, extra: any = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1" + path,
    headers: { ...headers, ...extra },
    payload,
  });
  if (response.statusCode >= 300) throw Error(response.body);
  return response.json();
}
const folder = await post("/files/folders", {
  name: "故事书素材",
  parentId: null,
});
await post(
  "/files/items?parentType=folder&parentId=" +
    folder.id +
    "&filename=book-pages.txt",
  Buffer.from("QA_BOOK_MARKER"),
  { "content-type": "application/octet-stream" },
);
const nested = await post("/files/folders", {
  name: "妈妈六视图",
  parentId: folder.id,
});
await post(
  "/files/items?parentType=folder&parentId=" + nested.id + "&filename=mom.txt",
  Buffer.from("QA_MOM_MARKER"),
  { "content-type": "application/octet-stream" },
);
await post(
  "/files/items?parentType=system&parentId=root&filename=sample-one.txt",
  Buffer.from("one"),
  { "content-type": "application/octet-stream" },
);
await post(
  "/files/items?parentType=system&parentId=root&filename=sample-two.txt",
  Buffer.from("two"),
  { "content-type": "application/octet-stream" },
);
const sessions = [];
for (let i = 0; i < 2; i++)
  sessions.push(
    await post("/ai/sessions", { modelId: "mock", resourceIds: [] }),
  );
await mkdir(".cache", { recursive: true });
await writeFile(
  ".cache/qa-ai-upload-fixture.json",
  JSON.stringify({
    origin,
    owner: owner.id,
    folder: folder.id,
    sessions: sessions.map((s) => s.id),
  }),
);
await app.listen({ host: "127.0.0.1", port: 39351 });
console.log("Isolated upload QA ready at " + origin);
const close = async () => {
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
  process.exit();
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
