// Verify real search UI against disposable data and deliberately noisy search hits.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { openTestDatabase } from "../tests/database.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";

const builtWeb = process.env.DOCA_QA_BUILT_WEB === "1";
const output = resolve(
  `artifacts/verification/search-relevance${builtWeb ? "-built" : ""}`,
);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "doca-search-relevance-"));
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: temporary } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
const password = "isolated-search-relevance-2026";
const owner = {
  ...(await createUser(
    db,
    { login: "searchqa", displayName: "Search QA", password },
    { bootstrap: true },
  )),
  admin: 1,
};
const content = createContent(db);
const target = await content.create(owner, {
  kind: "document",
  format: "markdown",
  title: "🎯 doca问题记录2.0",
  markdown: "# doca问题记录2.0",
});
const neighbour = await content.create(owner, {
  kind: "document",
  format: "markdown",
  title: "绘本项目说明 DOCA",
  markdown: "# 绘本项目说明 DOCA",
});
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    vendors: [
      {
        id: "test",
        name: "Test",
        provider: "openai",
        baseUrl: "https://mock.invalid/v1",
        apiKey: "test-only-key",
        enabled: true,
      },
    ],
    models: [
      {
        id: "embedding",
        vendorId: "test",
        model: "test-embedding",
        alias: "Test",
        enabled: true,
        embedding: true,
        tools: false,
        maxInput: 8000,
        maxOutput: 32,
      },
    ],
  },
  0,
);
await db
  .updateTable("search_settings")
  .set({
    enabled: 1,
    generation: 1,
    endpoint: "http://127.0.0.1:7700",
    index_name: "doca",
  })
  .where("id", "=", "system")
  .execute();
let remote: Record<string, unknown> = {};
const port = 39831,
  origin = `http://127.0.0.1:${port}`;
const app = await createApp(db, {
  origin,
  ...(builtWeb ? { staticDirectory: resolve("apps/web/dist") } : {}),
  storage: storageRuntime(),
  ai: { memory: { driver: "sqlite", url: ":memory:" } },
  search: {
    allowedOrigins: ["http://127.0.0.1:7700"],
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/settings/embedders")) {
        if (init?.method === "PATCH") {
          remote = { ...remote, ...JSON.parse(String(init.body)) };
          return Response.json({ taskUid: 42 });
        }
        return Response.json(remote);
      }
      if (path.startsWith("/tasks/"))
        return Response.json({ status: "succeeded" });
      if (path.endsWith("/search"))
        return Response.json({
          hits: [
            { id: neighbour.id, _rankingScore: 0.99 },
            { id: target.id, _rankingScore: 0.8 },
          ],
        });
      return Response.json({ results: [], total: 0, taskUid: 43 });
    },
  },
});
await app.listen({ host: "127.0.0.1", port: builtWeb ? port : 0 });
const address = app.server.address();
assert(address && typeof address !== "string");
const web = builtWeb
  ? undefined
  : await createServer({
      configFile: resolve("apps/web/vite.config.ts"),
      cacheDir: join(output, "vite-cache"),
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        hmr: false,
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
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  assert.equal(
    (
      await context.request.post(origin + "/api/v1/auth/login", {
        headers: { origin },
        data: { login: "searchqa", password },
      })
    ).status(),
    200,
  );
  const applied = await context.request.put(
    origin + "/api/v1/admin/search/embeddings",
    {
      headers: { origin },
      data: {
        generation: 1,
        name: "knowledge_v1",
        modelId: "embedding",
        aiRevision: 1,
        documentTemplate: "{{doc.title}}\n{{doc.text}}",
        documentTemplateMaxBytes: 8000,
      },
    },
  );
  assert.equal(applied.status(), 202, await applied.text());
  await context.request.get(origin + "/api/v1/admin/search/embeddings");
  await page.goto(origin + "/#/home");
  await page.locator(".sidebar-search").click();
  const panel = page.locator(".global-search");
  await panel.getByRole("tab", { name: "AI", exact: true }).click();
  const search = async (query: string) => {
    await panel.locator(".search-input input").fill(query);
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/search/documents?") && r.url().includes("mode=ai"),
    );
    await panel.locator(".search-input button[type=submit]").click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    return result.json();
  };
  const matched = await search("帮我找一下doca问题记录文档");
  assert.deepEqual(
    matched.items.map((item: { id: string }) => item.id),
    [target.id],
  );
  await panel
    .locator(".search-result strong")
    .filter({ hasText: "doca问题记录2.0" })
    .waitFor();
  assert.equal(
    await panel.getByText("绘本项目说明 DOCA", { exact: true }).count(),
    0,
  );
  await page.screenshot({ path: join(output, "relevant-only.png") });
  const empty = await search("火星火箭发射流程");
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.nextOffset, null);
  await panel.locator(".empty").filter({ hasText: "没有相近的结果" }).waitFor();
  assert.equal(await panel.locator(".search-hit").count(), 0);
  assert.equal(await panel.locator(".load-more").count(), 0);
  await page.screenshot({ path: join(output, "empty-results.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      { relevantOnly: true, noMatchEmpty: true, noPagination: true, errors },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({
    url: page.url(), text: await page.locator("body").innerText(), errors,
  }, null, 2));
  throw error;
} finally {
  await browser.close();
  await web?.close();
  await app.close();
  await db.destroy();
  await rm(temporary, { recursive: true, force: true });
}
