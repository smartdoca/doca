// Isolated reasoning-display QA: openai-protocol model without any interface setting.
// Never pass a production origin or real credentials.
if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Isolated AI QA only: set DOCA_QA_ISOLATED=1");
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { createApp } from "../apps/server/src/bootstrap/app.js";
import { mockAI } from "../tests/ai-mock.js";

const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
await createUser(
  db,
  { login: "aiqa", displayName: "AI 验收员", password: "isolated-ai-qa-2026" },
  { bootstrap: true },
);
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    enabled: true,
    defaultModel: "mock",
    limits: { standard: { day: 1000000, week: 5000000, month: 20000000 } },
    models: [
      {
        id: "mock",
        model: "gpt-5-mini-ui-qa",
        alias: "创作助手（模拟）",
        provider: "openai" as const,
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
      },
    ],
  },
  0,
);
const port = Number(process.env.DOCA_QA_PORT ?? 39260),
  origin = `http://127.0.0.1:${port}`;
const staticRoot = await mkdtemp(resolve(tmpdir(), "doca-ai-qa-web-"));
await cp(resolve("apps/web/dist"), staticRoot, { recursive: true });
const app = await createApp(db, {
  origin,
  staticDirectory: staticRoot,
  ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    fetch: mockAI({
      reasoning: "先理解问题，再给出回答。",
      chunkDelay: 30,
    }),
  },
});
await app.listen({ host: "127.0.0.1", port });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const login = await ctx.request.post(origin + "/api/v1/auth/login", {
    headers: { origin },
    data: { login: "aiqa", password: "isolated-ai-qa-2026" },
  });
  assert.equal(login.status(), 200, await login.text());
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "AI 助手", exact: true }).first().click();
  const sender = page.locator('.ai-composer [contenteditable="true"]').first();
  await sender.waitFor();
  await sender.click();
  await page.keyboard.type("你好");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // While the model thinks, the reasoning panel streams in place.
  await page
    .getByText("正在思考", { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  console.log("PASS streaming: 正在思考 panel streams while the model reasons");
  await page
    .getByText("这是模拟 AI 的回答", { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  const sessions = await (
    await ctx.request.get(origin + "/api/v1/ai/sessions", {
      headers: { origin },
    })
  ).json();
  const detail: any = await (
    await ctx.request.get(origin + "/api/v1/ai/sessions/" + sessions[0].id, {
      headers: { origin },
    })
  ).json();
  console.log(
    "messages:",
    JSON.stringify(
      detail.messages.map((m: any) => ({ role: m.role, reasoning: m.reasoning })),
    ),
  );
  // After completion the thinking stays under the collapsed process details.
  await page.getByText("用时 ", { exact: false }).first().click();
  await page.getByText("思考过程", { exact: true }).first().click();
  await page
    .getByText("先理解问题，再给出回答。", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  await page.screenshot({ path: "/tmp/doca-ai-reasoning.png" });
  console.log("PASS completed: 思考过程内容在执行详情中展示");
  // Reload: the persisted assistant reasoning still displays.
  await page.reload();
  await page.getByText("用时 ", { exact: false }).first().click();
  await page.getByText("思考过程", { exact: true }).first().click();
  await page
    .getByText("先理解问题，再给出回答。", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  console.log("PASS reload: persisted reasoning still displays");
  // Admin model dialog no longer asks for the wire protocol.
  await page.goto(origin + "/#/admin?tab=ai");
  await page.getByRole("button", { name: "添加模型", exact: true }).waitFor();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page.getByText("真实模型 ID", { exact: false }).waitFor();
  assert.equal(await page.getByText("接口协议", { exact: false }).count(), 0);
  await page.screenshot({ path: "/tmp/doca-ai-admin-model.png" });
  console.log("PASS admin: 模型录入没有接口协议选项，只填地址/密钥/模型");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await app.close();
  await db.destroy();
  await rm(staticRoot, { recursive: true, force: true });
}
console.log("QA-REASONING-OK");
