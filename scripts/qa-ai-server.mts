if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Isolated AI QA only: set DOCA_QA_ISOLATED=1");
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { readAIDocument } from "../packages/core/src/workflows/ai-documents.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { createApp } from "../apps/server/src/bootstrap/app.js";
import sharp from "sharp";
import { mockAI } from "../tests/ai-mock.js";
import { resolve } from "node:path";
import { mkdtemp, rm, appendFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
// Optional real-model loader is local-only and must return credentials in memory.
const realModel = process.env.DOCA_QA_MODEL_LOADER
  ? await (await import(process.env.DOCA_QA_MODEL_LOADER)).configuredTestModel()
  : null;
const realImageModel = process.env.DOCA_QA_IMAGE_LOADER
  ? await (
      await import(process.env.DOCA_QA_IMAGE_LOADER)
    ).configuredTestImageModel()
  : null;
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const owner = {
  ...(await createUser(
    db,
    {
      login: "aiqa",
      displayName: "AI 验收员",
      password: "isolated-ai-qa-2026",
    },
    { bootstrap: true },
  )),
  admin: 1,
};
await createUser(
  db,
  {
    login: "aiviewer",
    displayName: "权限验收员",
    password: "isolated-ai-qa-2026",
  },
  { actor: owner },
);
const content = createContent(db),
  docs = [];
for (const [format, title] of [
  ["rich_text", "项目说明"],
  ["markdown", "研发笔记"],
  ["spreadsheet", "季度预算"],
  ["canvas", "业务流程"],
  ["presentation", "项目汇报"],
] as const) {
  const r = await content.create(owner, { kind: "document", format, title });
  await readAIDocument(db, { actor: owner }, r.id);
  docs.push({ id: r.id, title, format });
}
await content.create(owner, {
  kind: "library",
  format: "rich_text",
  title: "团队知识库",
});
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    enabled: true,
    memoryEnabled: true,
    defaultModel: realModel?.id ?? "mock",
    ...(process.env.DOCA_QA_WEB_SEARCH === "1"
      ? {
          webSearch: {
            provider: "tavily" as const,
            apiKey: "isolated-search-fixture",
          },
        }
      : {}),
    limits: { standard: { day: 1000000, week: 5000000, month: 20000000 } },
    ...(realImageModel
      ? { imageModel: realImageModel.id }
      : process.env.DOCA_QA_IMAGE === "1"
        ? { imageModel: "image-qa" }
        : {}),
    models: [
      ...(realModel
        ? [realModel]
        : [
            {
              id: "mock",
              model: "isolated-mock",
              alias: "创作助手（模拟）",
              baseUrl: "https://isolated.invalid/v1",
              apiKey: "not-a-real-key",
              enabled: true,
              levels: [],
              inputRate: 1,
              outputRate: 2,
              cacheRate: 0.5,
              maxInput: 64000,
              maxOutput: 2000,
              tools: true,
              vision: true,
            },
          ]),
      ...(realImageModel
        ? [realImageModel]
        : process.env.DOCA_QA_IMAGE === "1"
          ? [
              {
                id: "image-qa",
                model: "image-fixture",
                alias: "图片生成（隔离模拟）",
                provider: "compatible" as const,
                baseUrl: "https://isolated.invalid/v1",
                apiKey: "fixture",
                enabled: true,
                levels: [],
                tools: false,
                imageGeneration: true,
                imageRate: 1,
                inputRate: 0,
                outputRate: 0,
                cacheRate: 0,
                maxInput: 32000,
                maxOutput: 1000,
              },
            ]
          : []),
    ],
  },
  0,
);
const port = Number(process.env.DOCA_QA_PORT ?? 39241),
  origin = `http://${process.env.DOCA_QA_HOSTNAME ?? "127.0.0.1"}:${port}`;
const uploadRoot = await mkdtemp(resolve(tmpdir(), "doca-ai-qa-"));
const staticRoot = await mkdtemp(resolve(tmpdir(), "doca-ai-qa-web-"));
await cp(resolve("apps/web/dist"), staticRoot, { recursive: true });
if (process.env.DOCA_QA_NATIVE_ELEMENTS === "1") {
  const { seedNativeElements } =
    await import("./qa-native-elements-fixture.mjs");
  await seedNativeElements(db, owner, docs, {
    ...storageRuntime(),
    root: uploadRoot,
  });
}
const app = await createApp(db, {
  storage: { ...storageRuntime(), root: uploadRoot },
  origin,
  staticDirectory: staticRoot,
  ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    ...(process.env.DOCA_QA_IMAGE === "1" && !realImageModel
      ? {
          imageFetch: (async () =>
            Response.json({
              data: [
                {
                  b64_json: (
                    await sharp({
                      create: {
                        width: 1024,
                        height: 1024,
                        channels: 3,
                        background: "#248a66",
                      },
                    })
                      .png()
                      .toBuffer()
                  ).toString("base64"),
                },
              ],
            })) as typeof fetch,
        }
      : {}),
    ...(process.env.DOCA_QA_WEB_SEARCH === "1"
      ? {
          webFetch: (async () =>
            Response.json({
              results: [
                {
                  title: "SearXNG 官方文档（隔离模拟）",
                  url: "https://docs.searxng.org/dev/search_api.html",
                  content:
                    "SearXNG 搜索接口支持 JSON 格式。此内容仅用于隔离测试。",
                },
              ],
            })) as typeof fetch,
        }
      : {}),
    fetch: realModel
      ? ((async (input, init) => {
          const response = await fetch(input, init);
          if (process.env.DOCA_QA_TRACE) {
            await appendFile(
              process.env.DOCA_QA_TRACE,
              JSON.stringify({
                status: response.status,
                contentType: response.headers.get("content-type"),
              }) + "\n",
            );
          }
          return response;
        }) as typeof fetch)
      : mockAI({
          delay: Number(process.env.DOCA_QA_DELAY ?? 350),
          chunkDelay: Number(process.env.DOCA_QA_CHUNK_DELAY ?? 0),
          reasoning: "这是模拟模型返回的思考内容，仅用于验证 Think 展示。",
        }),
  },
});
await app.listen({ host: "127.0.0.1", port });
console.log(
  JSON.stringify({
    origin,
    model: realModel?.model ?? "isolated-mock",
    login: "aiqa",
    password: "isolated-ai-qa-2026",
    documents: docs,
  }),
);
const close = async () => {
  await app.close();
  await db.destroy();
  await rm(uploadRoot, { recursive: true, force: true });
  await rm(staticRoot, { recursive: true, force: true });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
