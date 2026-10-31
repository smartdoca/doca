// Real host UI and history APIs, using only an isolated account, database and model.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { mockAI } from "../tests/ai-mock.js";

const output = resolve(
  process.env.DOCA_QA_OUTPUT ?? "artifacts/verification/ai-session-selection",
);
assert(output.startsWith(resolve("artifacts") + "/"));
const runtime = join(output, randomUUID());
await mkdir(runtime, { recursive: true });
await rm(join(output, "results.json"), { force: true });
await rm(join(output, "failure.json"), { force: true });
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: join(runtime, "objects") } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
await createUser(
  db,
  {
    login: "sessionqa",
    displayName: "Session QA",
    password: "isolated-session-qa",
  },
  { bootstrap: true },
);
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    defaultModel: "test",
    vendors: [
      {
        id: "test",
        name: "Synthetic",
        provider: "compatible",
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "synthetic-key",
        enabled: true,
      },
    ],
    models: [
      {
        id: "test",
        vendorId: "test",
        model: "test",
        alias: "Synthetic model",
        enabled: true,
        maxInput: 64000,
        maxOutput: 1000,
        tools: true,
      },
    ],
  },
  0,
);
const port = Number(process.env.DOCA_QA_PORT ?? 39497),
  origin = `http://127.0.0.1:${port}`;
const built = process.env.DOCA_QA_BUILT === "1";
const app = await createApp(db, {
  origin,
  staticDirectory: built ? resolve("apps/web/dist") : undefined,
  storage: storageRuntime(),
  ai: {
    memory: { driver: "sqlite", url: join(runtime, "memory.sqlite") },
    fetch: mockAI(),
  },
});
await app.listen({ host: "127.0.0.1", port: built ? port : 0 });
const address = app.server.address();
assert(address && typeof address !== "string");
const web = built
  ? undefined
  : await createServer({
      configFile: resolve("apps/web/vite.config.ts"),
      cacheDir: join(runtime, "vite-cache"),
      server: {
        hmr: false,
        watch: { ignored: ["**/*"] },
        host: "127.0.0.1",
        port,
        strictPort: true,
        proxy: {
          "/api": { target: `http://127.0.0.1:${address.port}`, ws: true },
        },
      },
    });
await web?.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [],
  historyRequests: unknown[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", async (response) => {
  if (/\/ai\/sessions\/[a-f0-9-]+(?:\?|$)/.test(response.url())) {
    historyRequests.push({
      url: response.url(),
      status: response.status(),
      body: await response.json().catch(() => null),
    });
  }
});
const request = async (path: string, data?: unknown, method = "GET") => {
  const response = await context.request.fetch(origin + "/api/v1" + path, {
    method,
    headers: { origin },
    data,
  });
  assert(response.ok(), await response.text());
  return response.json();
};
try {
  await request(
    "/auth/login",
    { login: "sessionqa", password: "isolated-session-qa" },
    "POST",
  );
  const sessions: {
    id: string;
    title: string;
    marker: string;
    snapshot: any;
  }[] = [];
  for (const name of ["A", "B"]) {
    const session = await request(
      "/ai/sessions",
      { modelId: "test", resourceIds: [] },
      "POST",
    );
    const marker = `HISTORY_${name}_QUESTION`;
    await request(
      `/ai/sessions/${session.id}/messages`,
      {
        id: randomUUID(),
        text: marker,
        modelId: "test",
        scope: "all",
        references: [],
      },
      "POST",
    );
    let snapshot: any;
    for (let i = 0; i < 200; i++) {
      snapshot = await request(`/ai/sessions/${session.id}`);
      if (
        snapshot.jobs[0] &&
        !["queued", "running"].includes(snapshot.jobs[0].status)
      )
        break;
      await delay(30);
    }
    assert(snapshot.messages.some((message: any) => message.text === marker));
    const title = `历史会话 ${name}`;
    await request(`/ai/sessions/${session.id}`, { title }, "PATCH");
    sessions.push({ id: session.id, title, marker, snapshot });
  }
  // A task can fail during setup before the model-history message is saved.
  // Its accepted input is still retained in the current ai_jobs record.
  const failed = await request(
    "/ai/sessions",
    { modelId: "test", resourceIds: [] },
    "POST",
  );
  const now = new Date().toISOString(),
    failedId = randomUUID();
  const failedTitle = "初始化失败的历史会话",
    failedMarker = "HISTORY_SETUP_FAILED_QUESTION";
  await db
    .insertInto("ai_jobs")
    .values({
      id: failedId,
      session_id: failed.id,
      user_id: failed.user_id,
      model_id: "test",
      status: "failed",
      input: JSON.stringify({
        text: failedMarker,
        scope: "all",
        references: [],
        attachments: [],
        files: [],
        skillIds: [],
        webSearch: false,
      }),
      digest: "synthetic-setup-failure",
      result: "",
      error: "Synthetic setup failure",
      lease: null,
      lease_until: null,
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await request(`/ai/sessions/${failed.id}`, { title: failedTitle }, "PATCH");
  // A new accepted task hits a real storage failure before attachment parsing.
  const upload = await context.request.post(
    origin + "/api/v1/assets?purpose=ai_attachment&filename=setup-failure.txt",
    {
      headers: { origin, "content-type": "application/octet-stream" },
      data: Buffer.from("Synthetic attachment for a setup failure"),
    },
  );
  assert(upload.ok(), await upload.text());
  const asset = await upload.json();
  const assetRow = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", asset.id)
    .executeTakeFirstOrThrow();
  const objectPath = resolve(runtime, "objects", assetRow.object_key);
  assert(objectPath.startsWith(resolve(runtime, "objects") + "/"));
  await rm(objectPath);
  const current = await request(
    "/ai/sessions",
    { modelId: "test", resourceIds: [] },
    "POST",
  );
  const currentTitle = "新任务初始化失败",
    currentMarker = "NEW_SETUP_FAILED_QUESTION",
    currentId = randomUUID();
  await request(
    `/ai/sessions/${current.id}/messages`,
    {
      id: currentId,
      text: currentMarker,
      modelId: "test",
      scope: "all",
      references: [],
      attachments: [asset.id],
    },
    "POST",
  );
  let currentSnapshot: any;
  for (let i = 0; i < 200; i++) {
    currentSnapshot = await request(`/ai/sessions/${current.id}`);
    if (currentSnapshot.jobs[0]?.status === "failed") break;
    await delay(30);
  }
  assert.equal(currentSnapshot.jobs[0]?.status, "failed");
  assert.equal(
    currentSnapshot.messages.find((message: any) => message.id === currentId)
      ?.attachments[0]?.id,
    asset.id,
  );
  await request(`/ai/sessions/${current.id}`, { title: currentTitle }, "PATCH");
  await page.goto(origin + "/#/ai");
  await page.locator(".ai-session-list .ai-session-title").first().waitFor();
  for (const index of [0, 1, 0]) {
    const session = sessions[index]!;
    await page
      .locator(".ai-session-title")
      .getByText(session.title, { exact: true })
      .click();
    await page
      .locator(".ai-user-message-text")
      .getByText(session.marker, { exact: true })
      .waitFor({ timeout: 10000 });
    assert(new URL(page.url()).hash.includes(session.id));
    assert.equal(await page.locator(".ai-user-message-text").count(), 1);
    assert.equal(
      await page.locator(".ant-conversations-item-active").count(),
      1,
    );
  }
  await page.reload();
  await page
    .locator(".ai-user-message-text")
    .getByText(sessions[0]!.marker, { exact: true })
    .waitFor();
  const oldLoaded = page.waitForResponse((response) =>
    response.url().endsWith(`/ai/sessions/${failed.id}`),
  );
  await page
    .locator(".ai-session-title")
    .getByText(failedTitle, { exact: true })
    .click();
  await oldLoaded;
  assert.equal((await request(`/ai/sessions/${failed.id}`)).messages.length, 0);
  assert.equal(
    await page
      .locator(".ai-user-message-text")
      .getByText(failedMarker, { exact: true })
      .count(),
    0,
  );
  await page
    .locator(".ai-session-title")
    .getByText(currentTitle, { exact: true })
    .click();
  await page
    .locator(".ai-user-message-text")
    .getByText(currentMarker, { exact: true })
    .waitFor();
  await page.getByText("任务失败", { exact: true }).waitFor();
  await page.getByText("setup-failure.txt", { exact: true }).waitFor();
  await page.reload();
  await page
    .locator(".ai-user-message-text")
    .getByText(currentMarker, { exact: true })
    .waitFor();
  await page.screenshot({ path: join(output, "history-selected.png") });
  // The job stream/history may arrive before its persisted user message.
  // Loading an existing session and rendering that job must never append Welcome.
  let phase: "queued" | "running" = "queued";
  let releaseHistory!: () => void,
    historyEntered = false;
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page.route(
    origin + `/api/v1/ai/sessions/${current.id}`,
    async (route) => {
      historyEntered = true;
      await historyGate;
      await route.fulfill({
        json: {
          ...currentSnapshot,
          messages: [],
          operations: [],
          jobs: [
            {
              ...currentSnapshot.jobs[0],
              status: phase,
              error: "",
              progress: {
                phase: "analyzing_request",
                text: "",
                reasoning: "",
                sources: [],
                events: [],
              },
            },
          ],
        },
      });
    },
  );
  await page.route(
    origin + `/api/v1/ai/sessions/${current.id}/stream`,
    (route) =>
      route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: "",
      }),
  );
  try {
    await page
      .locator(".ai-session-list")
      .getByRole("button", { name: /新对话/ })
      .click();
    await page.locator(".ai-welcome").waitFor();
    await page
      .locator(".ai-session-title")
      .getByText(currentTitle, { exact: true })
      .click();
    for (let i = 0; !historyEntered && i < 100; i++) await delay(10);
    assert(historyEntered, "Selecting a session must request its history");
    await page.locator(".ai-welcome").waitFor({ state: "hidden" });
    releaseHistory();
    await page.getByText("任务排队中", { exact: true }).waitFor();
    assert.equal(await page.locator(".ai-user-message-text").count(), 0);
    assert.equal(await page.locator(".ai-welcome").count(), 0);
    await page.screenshot({ path: join(output, "queued-without-welcome.png") });
    phase = "running";
    await page.reload();
    await page.getByText("正在分析请求", { exact: true }).waitFor();
    assert.equal(await page.locator(".ai-user-message-text").count(), 0);
    assert.equal(await page.locator(".ai-welcome").count(), 0);
    await page.screenshot({
      path: join(output, "running-without-welcome.png"),
    });
    await page
      .locator(".ai-session-list")
      .getByRole("button", { name: /新对话/ })
      .click();
    await page.locator(".ai-welcome").waitFor();
    assert.equal(
      await page.getByText("正在分析请求", { exact: true }).count(),
      0,
    );
  } finally {
    releaseHistory();
  }
  await page.unrouteAll();
  const openDelete = async (title: string) => {
    const row = page
      .locator(".ant-conversations-item")
      .filter({ hasText: title });
    await row.locator(".ant-conversations-menu-icon").click();
    await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.waitForFunction(() => {
      const modal = document.querySelector(".ant-modal");
      return modal && getComputedStyle(modal).transform === "none";
    });
    return dialog;
  };
  // Server failures must remain visible inside the confirmation, with retry.
  const retrySession = sessions[1]!;
  await page.route(
    origin + `/api/v1/ai/sessions/${retrySession.id}`,
    async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await route.fulfill({
        status: 500,
        json: { message: "Synthetic deletion failure" },
      });
    },
  );
  const failedDelete = await openDelete(retrySession.title);
  await failedDelete.getByRole("button", { name: /确\s*定/ }).click();
  await failedDelete
    .getByRole("alert")
    .getByText("Synthetic deletion failure", { exact: true })
    .waitFor();
  assert(
    await db
      .selectFrom("ai_sessions")
      .select("id")
      .where("id", "=", retrySession.id)
      .executeTakeFirst(),
  );
  await page.screenshot({ path: join(output, "delete-error-visible.png") });
  await page.unrouteAll();
  await failedDelete.getByRole("button", { name: /确\s*定/ }).click();
  await failedDelete.waitFor({ state: "hidden" });
  await page
    .locator(".ai-session-title")
    .getByText(retrySession.title, { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    await db
      .selectFrom("ai_sessions")
      .select("id")
      .where("id", "=", retrySession.id)
      .executeTakeFirst(),
    undefined,
  );
  // A task may become active after the list was loaded. The real 409 must be
  // shown in the modal, keeping the conversation and files intact.
  const racingDelete = await openDelete(currentTitle);
  const racingConfirm = racingDelete.getByRole("button", { name: /确\s*定/ });
  assert.equal(await racingConfirm.isEnabled(), true);
  await db
    .updateTable("ai_jobs")
    .set({ status: "awaiting_approval" })
    .where("id", "=", currentId)
    .execute();
  await racingConfirm.click();
  await racingDelete
    .getByRole("alert")
    .getByText("请先停止该会话的运行任务", { exact: true })
    .waitFor();
  assert.equal(await racingConfirm.isEnabled(), false);
  assert(
    await db
      .selectFrom("ai_sessions")
      .select("id")
      .where("id", "=", current.id)
      .executeTakeFirst(),
  );
  await page.screenshot({
    path: join(output, "delete-active-error-visible.png"),
  });
  await racingDelete.getByRole("button", { name: /取\s*消/ }).click();
  // An already known active task shows the stop action before any delete request.
  await page.reload();
  const activeDelete = await openDelete(currentTitle);
  const confirmDelete = activeDelete.getByRole("button", { name: /确\s*定/ });
  assert.equal(await confirmDelete.isEnabled(), false);
  await activeDelete
    .getByRole("button", { name: "停止任务", exact: true })
    .click();
  await activeDelete
    .getByText("已请求停止任务，请等待任务结束后再次确认删除。", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (
      await db
        .selectFrom("ai_jobs")
        .select("status")
        .where("id", "=", currentId)
        .executeTakeFirstOrThrow()
    ).status,
    "cancelled",
  );
  assert(
    await db
      .selectFrom("ai_sessions")
      .select("id")
      .where("id", "=", current.id)
      .executeTakeFirst(),
  );
  await page.screenshot({ path: join(output, "delete-after-stop.png") });
  await confirmDelete.click();
  await activeDelete.waitFor({ state: "hidden" });
  await page
    .locator(".ai-session-title")
    .getByText(currentTitle, { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    await db
      .selectFrom("ai_sessions")
      .select("id")
      .where("id", "=", current.id)
      .executeTakeFirst(),
    undefined,
  );
  assert(
    await db
      .selectFrom("ai_sessions")
      .select("id")
      .where("id", "=", sessions[0]!.id)
      .executeTakeFirst(),
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ result: "passed", errors, historyRequests }, null, 2),
  );
  console.log(
    "PASS history selection and presentation; deletion errors stay visible and retry succeeds; active tasks require explicit stop before deletion",
  );
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        errors,
        historyRequests,
        url: page.url(),
        text: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await web?.close();
  await app.close();
  await db.destroy();
}
