// This server never connects to user databases, storage or model providers.
if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated QA only");
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { createApp } from "../apps/server/src/bootstrap/app.js";
const root = await mkdtemp(join(tmpdir(), "doca-notes-qa-"));
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
await createUser(
  db,
  {
    login: "notesqa",
    displayName: "随手记验收",
    password: "isolated-notes-qa-2026",
  },
  { bootstrap: true },
);
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    defaultModel: "test",
    models: [
      {
        id: "test",
        model: "test",
        alias: "隔离测试模型",
        baseUrl: "https://isolated.invalid/v1",
        apiKey: "not-real",
        enabled: true,
        levels: [],
        tools: true,
        inputRate: 0,
        outputRate: 0,
        cacheRate: 0,
        maxInput: 64000,
        maxOutput: 6000,
      },
    ],
  },
  0,
);
const app = await createApp(db, {
  origin: "http://127.0.0.1:39252",
  staticDirectory: resolve("apps/web/dist"),
  storage: {
    root,
    credentials: {},
    endpointHosts: [],
    cdnKeyPairId: undefined,
    cdnPrivateKey: undefined,
  },
  ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    fetch: (async () =>
      Response.json({
        id: "test",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "# 随手记功能方案\n\n## 需求背景\n让一闪而过的想法有地方保存。\n\n## 功能\n- 私人卡片，随时修改\n- 图片和附件\n- AI 整理成文档\n\n## 待确认\n下周评审具体时间。",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
          total_tokens: 200,
        },
      })) as typeof fetch,
  },
});
await app.listen({ host: "127.0.0.1", port: 39252 });
console.log("Isolated notes QA ready: http://127.0.0.1:39252");
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
