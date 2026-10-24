// Isolated MV3 regression: synthetic account, SQLite, web pages and model only.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";
import { build as buildVite, createServer as createViteServer } from "vite";
import sharp from "sharp";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { completionResponse, mockAI } from "../tests/ai-mock.js";

const output = resolve(
  process.argv[2] ?? "artifacts/verification/browser-assistant-fixes/native",
);
assert(output.startsWith(resolve("artifacts") + "/"));
const runtime = join(output, "runtime");
await mkdir(runtime, { recursive: true });
// Other local workflows also build the extension. Freeze this run's production
// assets outside the shared generated/ directory before starting the dev server.
const productionGenerated = join(runtime, "production-generated");
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
await buildVite({
  configFile: resolve("apps/browser-extension/vite.config.ts"),
  mode: "production",
  build: { outDir: productionGenerated },
});
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
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
const origin = "http://localhost:39786";
const actor = await createUser(
  db,
  {
    login: "assistant-fixes",
    displayName: "插件回归账户",
    password: "isolated-assistant-fixes-password",
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
        id: "fixture",
        name: "Fixture",
        provider: "compatible",
        baseUrl: "https://model.example.test/v1",
        apiKey: "synthetic-only",
        enabled: true,
      },
    ],
    models: [
      {
        id: "test",
        vendorId: "fixture",
        model: "test",
        apiMode: "chat",
        alias: "回归模型",
        enabled: true,
        tools: true,
        maxInput: 64000,
        maxOutput: 2000,
      },
    ],
  },
  0,
);
const markers: string[] = [];
const modelRequests: any[] = [];
const fallback = mockAI();
const fetcher = (async (url, init) => {
  const body = JSON.parse(String(init?.body));
  modelRequests.push(body);
  const current = body.messages.slice(
    body.messages.findLastIndex((message: any) => message.role === "user"),
  );
  const requestId = JSON.stringify(
    current.filter((message: any) => message.role === "user"),
  ).match(/收录任务ID：([a-f0-9-]{36})/)?.[1];
  if (!requestId) return fallback(url, init);
  const tool = current.find((message: any) => message.role === "tool");
  const marker =
    tool &&
    JSON.stringify(tool)
      .replaceAll("\\", "")
      .match(/PAGE_ONE|PAGE_TWO|SPA_CURRENT/)?.[0];
  if (tool) {
    assert(marker, JSON.stringify(tool));
    markers.push(marker);
  }
  const message = tool
    ? { role: "assistant", content: `已读取当前页面：${marker}` }
    : {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-material",
            type: "function",
            function: {
              name: "browser_material_read",
              arguments: JSON.stringify({ requestId, offset: 0 }),
            },
          },
        ],
      };
  return completionResponse(
    {
      id: randomUUID(),
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        { index: 0, message, finish_reason: tool ? "stop" : "tool_calls" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    !!body.stream,
  );
}) as typeof fetch;
const app = await createApp(db, {
  origin,
  storage: storageRuntime(),
  ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: fetcher },
});
let cookie = "";
const request = (method: any, path: string, payload?: any, token?: string) =>
  app.inject({
    method,
    url: "/api/v1" + path,
    headers: {
      host: "localhost:39786",
      origin,
      cookie,
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    payload,
  });
const png = await sharp({
  create: { width: 16, height: 16, channels: 3, background: "#3370ff" },
})
  .png()
  .toBuffer();
const fixture = createServer((req, res) => {
  if (req.url === "/photo.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(png);
    return;
  }
  if (req.url === "/logo.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#3370ff"/></svg>',
    );
    return;
  }
  const one = req.url === "/one";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${one ? "第一篇网页" : "第二篇网页"}</title><style>body{font:18px/1.8 system-ui;padding:50px;color:#263449}article{max-width:650px}img{margin:20px}</style><article><h1>${one ? "第一篇网页" : "第二篇网页"}</h1><p id="material">${one ? "PAGE_ONE：第一篇网页包含正文、SVG 标识和 PNG 图片。" : "PAGE_TWO：第二篇网页有完全不同的内容。"}</p>${one ? '<img src="/logo.svg" alt="标识"><img src="/photo.png" alt="照片">' : ""}</article>`,
  );
});
await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
const sourceOrigin = `http://127.0.0.1:${(fixture.address() as any).port}`;
let browser:
  Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
let web: Awaited<ReturnType<typeof createViteServer>> | undefined;
try {
  await app.listen({ host: "127.0.0.1", port: 39785 });
  web = await createViteServer({
    configFile: resolve("apps/web/vite.config.ts"),
    cacheDir: join(runtime, "vite-cache"),
    server: {
      host: "127.0.0.1",
      port: 39786,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:39785",
          ws: true,
          changeOrigin: false,
        },
      },
    },
  });
  await web.listen();
  const login = await request("POST", "/auth/login", {
    login: "assistant-fixes",
    password: "isolated-assistant-fixes-password",
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const profileReply = await request("POST", "/me/browser-clipper/profiles", {
    name: "网页收录",
    enabled: true,
    isDefault: true,
    strategy: "create",
    libraryId: null,
    parentId: null,
    targetId: null,
    titleTemplate: "{title}",
    aiInstruction: "",
  });
  assert.equal(profileReply.statusCode, 200, profileReply.body);
  const profile = profileReply.json();
  const installationId = randomUUID(),
    verifier = randomBytes(32).toString("hex");
  const grant = await request("POST", "/me/browser-clipper/authorize", {
    version: 2,
    installationId,
    challenge: createHash("sha256").update(verifier).digest("hex"),
  });
  assert.equal(grant.statusCode, 200, grant.body);
  const exchange = await request("POST", "/browser-clipper/token", {
    version: 2,
    code: grant.json().code,
    verifier,
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  const auth = exchange.json();
  const zip = await request("POST", "/me/browser-clipper/download", {});
  assert.equal(zip.statusCode, 200, zip.body);
  const extension = join(runtime, "extension");
  for (const [name, bytes] of Object.entries(unzipSync(zip.rawPayload))) {
    assert(/^[\w./-]+$/.test(name) && !name.split("/").includes(".."));
    await mkdir(dirname(join(extension, name)), { recursive: true });
    await writeFile(join(extension, name), bytes);
  }
  await rm(join(extension, "generated"), { recursive: true, force: true });
  await cp(productionGenerated, join(extension, "generated"), {
    recursive: true,
  });
  browser = await chromium.launchPersistentContext(join(runtime, "browser"), {
    executablePath: chromium.executablePath(),
    headless: true,
    args: [
      "--disable-extensions-except=" + extension,
      "--load-extension=" + extension,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  browser.setDefaultTimeout(20000);
  await browser.addCookies([
    {
      name: cookie.split("=")[0]!,
      value: cookie.split("=")[1]!,
      url: origin,
      sameSite: "Lax",
    },
  ]);
  const worker =
    browser.serviceWorkers()[0] ??
    (await browser.waitForEvent("serviceworker"));
  await worker.evaluate(
    async ({ auth, origin, installationId }) => {
      await chrome.storage.local.set({
        site: { version: 2, origin },
        installationId,
      });
      await chrome.storage.session.set({ authorization: auth });
    },
    { auth, origin, installationId },
  );
  const id = worker.url().split("/")[2];
  const source = await browser.newPage();
  await source.goto(sourceOrigin + "/one");
  const ui = await browser.newPage();
  await ui.setViewportSize({ width: 410, height: 850 });
  await ui.goto(`chrome-extension://${id}/ui.html`);
  await ui.waitForSelector("#capture-pane:not([hidden])");
  assert.equal(await ui.locator("#quick-note").count(), 0);
  await ui.screenshot({
    path: join(output, "capture-home.png"),
    fullPage: true,
  });
  await ui.goto(`chrome-extension://${id}/ui.html#assistant`);
  await ui.reload();
  await source.bringToFront();
  await ui.getByText("想收录这个网页吗？", { exact: true }).waitFor();
  for (const label of ["收录网页", "总结页面", "提炼要点", "整理收录"])
    assert(await ui.getByText(label, { exact: true }).isVisible());
  assert.equal(await ui.getByText("起草文档", { exact: true }).count(), 0);
  await ui.waitForFunction(
    () =>
      document.querySelector(".ai-browser-page-context")?.textContent ===
      "第一篇网页",
  );
  await ui.screenshot({
    path: join(output, "assistant-welcome.png"),
    fullPage: true,
  });
  const send = async (page: typeof source, marker: string) => {
    await ui
      .locator('.ai-composer [contenteditable="true"]')
      .fill("总结当前网页，只在对话中回答。");
    await ui.waitForFunction(
      () =>
        !(
          document.querySelector(
            'button[aria-label="发送"]',
          ) as HTMLButtonElement
        )?.disabled,
    );
    await page.bringToFront();
    await ui.evaluate(() =>
      (
        document.querySelector('button[aria-label="发送"]') as HTMLButtonElement
      ).click(),
    );
    await ui.waitForFunction(
      (marker) =>
        document
          .querySelector(".ai-messages")
          ?.textContent?.includes(`已读取当前页面：${marker}`),
      marker,
    );
    await ui.waitForFunction(
      () => !document.querySelector(".ai-pending-queue"),
    );
  };
  await send(source, "PAGE_ONE");
  const first = await db
    .selectFrom("browser_clipper_receipts")
    .selectAll()
    .where("user_id", "=", actor.id)
    .executeTakeFirstOrThrow();
  assert.equal(JSON.parse(first.payload_json).images.length, 2);
  assert.equal(JSON.parse(first.images_json).length, 1);
  const strictCommit = await request(
    "POST",
    `/browser-clipper/clips/${first.request_id}/commit`,
    {},
    auth.token,
  );
  assert.equal(strictCommit.statusCode, 409, strictCommit.body);
  assert.equal(strictCommit.json().message, "clipper_images_missing");
  const second = await browser.newPage();
  await second.goto(sourceOrigin + "/two");
  await second.bringToFront();
  await ui.waitForFunction(
    () =>
      document.querySelector(".ai-browser-page-context")?.textContent ===
      "第二篇网页",
  );
  await send(second, "PAGE_TWO");
  await second.evaluate(() => {
    history.pushState({}, "", "/route-three");
    document.title = "站内跳转后的网页";
    document.getElementById("material")!.textContent =
      "SPA_CURRENT：站内路由更新后的内容。";
  });
  await ui.waitForFunction(() =>
    document
      .querySelector(".ai-browser-page-context")
      ?.getAttribute("href")
      ?.endsWith("/route-three"),
  );
  await send(second, "SPA_CURRENT");
  const originalSession = await db.selectFrom("ai_sessions").selectAll().executeTakeFirstOrThrow();
  assert(originalSession.title.includes("第一篇网页") && originalSession.title.includes("127.0.0.1"));
  assert(originalSession.title.startsWith("总结当前网页"));
  const sourceBadge = ui.locator('.ai-chat-header .ai-session-source');
  assert.equal(await sourceBadge.innerText(), "");
  assert.equal(await sourceBadge.getAttribute("aria-label"), "浏览器助手");
  assert.equal(await sourceBadge.locator("svg").count(), 1);
  await ui.getByRole("button", { name: "操作过的资源", exact: true }).click();
  const resourceLinks = ui.locator(".ai-resource-history a");
  await resourceLinks.first().waitFor();
  assert.equal(await resourceLinks.count(), 3);
  for (const path of ["/one", "/two", "/route-three"]) {
    const link = ui.locator(`.ai-resource-history a[href="${sourceOrigin + path}"]`);
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  }
  await ui.screenshot({ path: join(output, "assistant-page-resources.png"), fullPage: true });
  await ui.getByRole("button", { name: "操作过的资源", exact: true }).click();
  await ui.locator(".ai-resource-history").waitFor({ state: "hidden" });
  await ui.screenshot({
    path: join(output, "assistant-current-page.png"),
    fullPage: true,
  });
  // Use trusted mouse events against the actual closed-shadow selection toolbar.
  await second.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("material")!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await second.mouse.up();
  await second.waitForSelector("[data-doca-capture-ui]");
  const cdp = await browser.newCDPSession(second);
  const find = (node: any, predicate: (value: any) => boolean): any => {
    if (predicate(node)) return node;
    for (const child of [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
    ]) {
      const result = find(child, predicate);
      if (result) return result;
    }
  };
  const tree = async () =>
    (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root;
  const clickIcon = async () => {
    const icon = find(
      await tree(),
      (node) => node.nodeName === "BUTTON" && node.attributes?.includes("data-action") && node.attributes.includes("page"),
    );
    assert(icon);
    const { model } = await cdp.send("DOM.getBoxModel", {
      nodeId: icon.nodeId,
    });
    const point = {
      x: (model.content[0]! + model.content[4]!) / 2,
      y: (model.content[1]! + model.content[5]!) / 2,
      button: "left" as const,
      clickCount: 1,
    };
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
    });
  };
  const waitToolbar = async (text: string) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const currentTree = await tree();
      if (
        find(
          currentTree,
          (node) => node.nodeName === "#text" && node.nodeValue?.includes(text),
        )
      ) {
        const panel = find(currentTree, (node) =>
          node.attributes?.includes("panel"),
        );
        const { object } = await cdp.send("DOM.resolveNode", {
          nodeId: panel.nodeId,
        });
        const opacity = await cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration:
            "function () { return Number(getComputedStyle(this).opacity); }",
          returnByValue: true,
        });
        if (opacity.result.value >= 0.99) return;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw Error("Toolbar did not show: " + text);
  };
  await clickIcon();
  await waitToolbar("网页收录");
  await second.screenshot({
    path: join(output, "toolbar-signed-in.png"),
  });
  await second.keyboard.press("Escape");
  // Reopening after a rule edit must validate the old selection before mounting
  // chat. The historical session/binding and its three jobs remain unchanged.
  const originalBinding = await db.selectFrom("browser_clipper_assistant_sessions").selectAll().where("session_id", "=", originalSession.id).executeTakeFirstOrThrow();
  const { id: profileId, ...profileValues } = profile;
  const changed = await request("PUT", `/me/browser-clipper/profiles/${profileId}`, { ...profileValues, titleTemplate: "更新后 {title}" });
  assert.equal(changed.statusCode, 200, changed.body);
  await ui.reload();
  await second.bringToFront();
  await ui.getByText("想收录这个网页吗？", { exact: true }).waitFor();
  assert.equal(await ui.getByText("会话或引用资料的访问权限已变化，请重新打开会话", { exact: true }).count(), 0);
  assert.deepEqual(await db.selectFrom("browser_clipper_assistant_sessions").selectAll().where("session_id", "=", originalSession.id).executeTakeFirstOrThrow(), originalBinding);
  const historical = await request("GET", `/ai/sessions/${originalSession.id}`);
  assert.equal(historical.statusCode, 200, historical.body);
  assert.equal(historical.json().session.title, originalSession.title);
  assert.equal(historical.json().resources.filter((resource: any) => resource.kind === "webpage").length, 3);
  await send(second, "SPA_CURRENT");
  const newBinding = await db.selectFrom("browser_clipper_assistant_sessions").selectAll().where("session_id", "!=", originalSession.id).executeTakeFirstOrThrow();
  assert.equal(newBinding.profile_revision, changed.json().revision);
  assert.equal(JSON.parse(originalBinding.job_ids).ids.length, 3);
  await ui.screenshot({ path: join(output, "assistant-after-rule-change.png"), fullPage: true });
  // Verify the same source icon and external links in the regular Doca UI.
  const website = await browser.newPage();
  await website.setViewportSize({ width: 1280, height: 900 });
  await website.goto(origin + `/#/ai?session=${originalSession.id}`);
  await website.locator('.ai-session-source[aria-label="浏览器助手"]').first().waitFor();
  assert.equal(await website.locator('.ai-session-source').first().innerText(), "");
  await website.getByRole("button", { name: "操作过的资源", exact: true }).click();
  await website.locator(".ai-resource-history a").first().waitFor();
  assert.equal(await website.locator(".ai-resource-history a").count(), 3);
  await website.screenshot({ path: join(output, "website-page-resources.png"), fullPage: true });
  await website.getByRole("button", { name: "操作过的资源", exact: true }).click();
  await website.locator(".ai-resource-history").waitFor({ state: "hidden" });
  await website.screenshot({ path: join(output, "website-session-icon.png"), fullPage: true });
  await second.bringToFront();
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await clickIcon();
  await waitToolbar("插件已更新");
  await second.screenshot({ path: join(output, "toolbar-extension-updated.png") });
  assert.deepEqual(markers, ["PAGE_ONE", "PAGE_TWO", "SPA_CURRENT", "SPA_CURRENT"]);
  const jobs = await db.selectFrom("ai_jobs").select(["status"]).execute();
  assert.equal(jobs.length, 4);
  assert(jobs.every((job) => job.status === "completed"));
  assert.equal(
    (
      await db
        .selectFrom("resources")
        .select("id")
        .where("kind", "=", "document")
        .execute()
    ).length,
    0,
  );
  const result = {
    status: "passed",
    browser: "real Chromium MV3",
    database: "isolated SQLite",
    realModelProvider: false,
    markers,
    unsupportedImageDoesNotBlockAI: true,
    imageManifestPreserved: true,
    strictArchiveRejectsMissingImage: true,
    tabAndRouteReferences: true,
    capturePrompts: true,
    quickNoteRemoved: true,
    toolbarSignedIn: true,
    invalidatedToolbarOffersReload: true,
    ruleChangeStartsCurrentSession: true,
    originalHistoryRetained: true,
    webpageResourcesOnBothSurfaces: true,
    contextualTitleAndSourceIcon: true,
    completedJobs: jobs.length,
  };
  await writeFile(join(output, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        modelRequests: modelRequests.slice(-10),
        markers,
        jobs: await db
          .selectFrom("ai_jobs")
          .select(["status", "error"])
          .execute(),
      },
      null,
      2,
    ),
  );
  for (const [index, page] of (browser?.pages() ?? []).entries())
    await page
      .screenshot({ path: join(output, `failure-${index}.png`) })
      .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await app.close();
  await db.destroy();
  await new Promise<void>((done) => fixture.close(() => done()));
  await rm(runtime, { recursive: true, force: true });
}
