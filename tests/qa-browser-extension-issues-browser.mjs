import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const output = process.env.DOCA_QA_OUTPUT;
const extension = process.env.DOCA_QA_EXTENSION;
const browserProfile = process.env.DOCA_QA_BROWSER_PROFILE;
const webMode = process.env.DOCA_QA_WEB_MODE ?? "development";
const expectedWebIndexSha256 = process.env.DOCA_QA_WEB_INDEX_SHA256;
assert(["development", "production-build"].includes(webMode));
if (webMode === "production-build")
  assert(
    /^[a-f0-9]{64}$/.test(expectedWebIndexSha256 ?? ""),
    "The production-build driver requires the compiled index fingerprint",
  );
assert(
  output && extension && browserProfile,
  "The native QA driver must provide isolated paths",
);
const artifact = (name) => join(output, name);
const context = await chromium.launchPersistentContext(browserProfile, {
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
context.setDefaultTimeout(20000);
context.setDefaultNavigationTimeout(60000);
await context.addInitScript(() => {
  if (
    location.protocol !== "chrome-extension:" ||
    !globalThis.chrome?.runtime?.sendMessage
  )
    return;
  globalThis.qaRuntimeFailures = [];
  globalThis.qaStateReplies = [];
  globalThis.qaRuntimeTrace = [];
  globalThis.qaQuickNoteCalls = [];
  globalThis.qaPendingProbe = async ({ docaOrigin, userId, connectionId }) => {
    if (
      new URL(docaOrigin).origin !== docaOrigin ||
      !/^https?:/.test(docaOrigin) ||
      typeof userId !== "string" ||
      !userId ||
      typeof connectionId !== "string" ||
      !connectionId ||
      connectionId === "website"
    )
      throw Error("QA pending probe requires the actual extension identity");
    const existing = (await indexedDB.databases()).find(
      (database) => database.name === "doca-ai-pending",
    );
    if (!existing) return [];
    if (existing.version !== 1)
      throw Error("QA pending probe requires an existing version-1 database");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("doca-ai-pending", 1);
      request.onupgradeneeded = () => {
        request.transaction?.abort();
        reject(
          Error("QA readonly probe must never create or upgrade a database"),
        );
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error("QA readonly probe was blocked"));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        try {
          if (
            db.version !== 1 ||
            db.objectStoreNames.length !== 1 ||
            !db.objectStoreNames.contains("entries")
          )
            throw Error("Unexpected pending database structure");
          const transaction = db.transaction("entries", "readonly");
          const store = transaction.objectStore("entries");
          const index = store.index("scope");
          if (
            store.autoIncrement ||
            store.indexNames.length !== 1 ||
            index.multiEntry ||
            JSON.stringify(store.keyPath) !==
              JSON.stringify([
                "docaOrigin",
                "userId",
                "connectionId",
                "messageId",
              ]) ||
            JSON.stringify(index.keyPath) !==
              JSON.stringify(["docaOrigin", "userId", "connectionId"]) ||
            index.unique
          )
            throw Error("Unexpected pending scope index");
          const read = index.getAll(
            IDBKeyRange.only([docaOrigin, userId, connectionId]),
          );
          transaction.onabort = () => {
            db.close();
            reject(
              transaction.error || Error("QA readonly transaction aborted"),
            );
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
          transaction.oncomplete = () => {
            db.close();
            try {
              for (const entry of read.result) {
                const allowed = [
                  "recordVersion",
                  "docaOrigin",
                  "userId",
                  "connectionId",
                  "messageId",
                  "profile",
                  "sessionId",
                  "item",
                  "payloadHash",
                  "state",
                  "createdAt",
                  "updatedAt",
                  "source",
                  "serverJobId",
                ];
                if (
                  Object.keys(entry).some((key) => !allowed.includes(key)) ||
                  entry.recordVersion !== 1 ||
                  entry.docaOrigin !== docaOrigin ||
                  entry.userId !== userId ||
                  entry.connectionId !== connectionId ||
                  !entry.messageId ||
                  entry.item?.id !== entry.messageId ||
                  !entry.profile ||
                  Object.keys(entry.profile).sort().join(",") !==
                    "id,revision" ||
                  typeof entry.profile.id !== "string" ||
                  !entry.profile.id ||
                  !Number.isSafeInteger(entry.profile.revision) ||
                  entry.profile.revision < 1 ||
                  (entry.sessionId !== null &&
                    (typeof entry.sessionId !== "string" ||
                      !entry.sessionId)) ||
                  !/^[a-f0-9]{64}$/.test(entry.payloadHash) ||
                  !["pending", "accepted", "withdrawn"].includes(entry.state) ||
                  !Number.isFinite(Date.parse(entry.createdAt)) ||
                  !Number.isFinite(Date.parse(entry.updatedAt)) ||
                  (entry.source !== undefined &&
                    (!entry.source ||
                      Object.keys(entry.source).sort().join(",") !==
                        "hash,sessionKey,storageKey" ||
                      typeof entry.source.storageKey !== "string" ||
                      !entry.source.storageKey ||
                      typeof entry.source.sessionKey !== "string" ||
                      !entry.source.sessionKey ||
                      !/^[a-f0-9]{64}$/.test(entry.source.hash))) ||
                  (entry.state === "accepted"
                    ? typeof entry.serverJobId !== "string" ||
                      !entry.serverJobId
                    : entry.serverJobId !== undefined)
                )
                  throw Error(
                    "Unexpected pending record: refusing a lossy QA read",
                  );
              }
              resolve(read.result);
            } catch (error) {
              reject(error);
            }
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  };
  globalThis.qaDeliveryAttempts = () => ({
    captures: Number(sessionStorage.getItem("qaCaptureAttempts") || "0"),
    messagePosts: Number(
      sessionStorage.getItem("qaMessagePostAttempts") || "0",
    ),
  });
  const timer = window.setTimeout.bind(window);
  const frame = window.requestAnimationFrame.bind(window);
  window.setTimeout = (callback, ms, ...args) =>
    globalThis.qaEarlyHoldPaint && ms === 100
      ? timer(() => {}, 60000)
      : timer(callback, ms, ...args);
  window.requestAnimationFrame = (callback) =>
    globalThis.qaEarlyHoldPaint ? timer(() => {}, 60000) : frame(callback);
  const resumeWaiters = [];
  globalThis.qaReleaseEarlyResume = () => {
    sessionStorage.removeItem("qaEarlyResumeHeld");
    for (const resolve of resumeWaiters.splice(0)) resolve();
  };
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = async (...args) => {
    const message = args[0];
    const quickNote = message.type.startsWith("quickNote")
      ? { message: structuredClone(message), started: Date.now() }
      : null;
    if (quickNote) globalThis.qaQuickNoteCalls.push(quickNote);
    if (message.type === "quickNoteCommit" && globalThis.qaMissingNoteTicket)
      args[0] = { ...message, ticket: "0".repeat(64) };
    const trace =
      message.type.startsWith("assistant") ||
      ["state", "login"].includes(message.type)
        ? {
            type: message.type,
            path: message.path,
            method: message.method,
            id: message.body?.id,
            started: Date.now(),
          }
        : null;
    if (trace) globalThis.qaRuntimeTrace.push(trace);
    if (message.type === "assistantPreparePage")
      sessionStorage.setItem(
        "qaCaptureAttempts",
        String(globalThis.qaDeliveryAttempts().captures + 1),
      );
    if (
      message.type === "assistantRequest" &&
      message.method === "POST" &&
      /\/messages$/.test(message.path)
    )
      sessionStorage.setItem(
        "qaMessagePostAttempts",
        String(globalThis.qaDeliveryAttempts().messagePosts + 1),
      );
    const stage = sessionStorage.getItem("qaEarlyStage");
    if (
      sessionStorage.getItem("qaEarlyInterrupt") === "armed" &&
      ((stage === "create-session" &&
        message.type === "assistantRequest" &&
        message.method === "POST" &&
        message.path === "/assistant/ui/sessions") ||
        (stage === "prepare-page" && message.type === "assistantPreparePage"))
    ) {
      sessionStorage.setItem("qaEarlyInterrupt", "entered");
      return new Promise(() => {});
    }
    if (
      sessionStorage.getItem("qaEarlyResumeHeld") === "1" &&
      message.type === "assistantPreparePage"
    ) {
      globalThis.qaEarlyResumeWaiting = true;
      await new Promise((resolve) => resumeWaiters.push(resolve));
    }
    const result = await original(...args);
    if (quickNote)
      Object.assign(quickNote, {
        finished: Date.now(),
        result: structuredClone(result),
      });
    if (
      message.type === "quickNotePrepare" &&
      result?.ok &&
      globalThis.qaHoldNotePreparation
    ) {
      globalThis.qaNotePreparationWaiting = true;
      await new Promise((resolve) => {
        globalThis.qaReleaseNotePreparation = resolve;
      });
    }
    if (
      message.type === "quickNoteCommit" &&
      result?.ok &&
      globalThis.qaLoseNoteCommitResponse
    ) {
      globalThis.qaLoseNoteCommitResponse = false;
      globalThis.qaNoteCommitResponseLost = true;
      return { ok: false, error: "clipper_connection_failed" };
    }
    if (trace)
      Object.assign(trace, {
        finished: Date.now(),
        ok: result?.ok,
        status: result?.status,
        error: result?.error,
      });
    if (message.type === "state")
      globalThis.qaStateReplies.push({
        connected: result?.value?.connected,
        name: result?.value?.user?.name,
        error: result?.value?.error,
      });
    if (result?.ok === false)
      globalThis.qaRuntimeFailures.push({
        type: message.type,
        path: message.path,
        method: message.method,
        error: result.error,
        status: result.status,
      });
    if (
      globalThis.qaHoldAcceptedMessage &&
      result?.ok &&
      message.type === "assistantRequest" &&
      message.method === "POST" &&
      /\/messages$/.test(message.path)
    ) {
      globalThis.qaHoldAcceptedMessage = false;
      sessionStorage.setItem(
        "qaAcceptedMessage",
        JSON.stringify({ id: message.body.id, path: message.path }),
      );
      globalThis.qaAcceptedMessageHeld = true;
      return new Promise(() => {});
    }
    return result;
  };
});
const errors = [];
const aiUiRequests = [];
const apiResponses = [];
const earlySendResponses = [];
const failedResponses = [];
const failedRequests = [];
const pendingRequests = new Map();
const developmentSourceRequests = new Set();
const compiledScriptRequests = new Set();
let firstBuiltDocumentRead = null;
const safeRequest = (request) => {
  const url = new URL(request.url());
  return {
    origin: url.origin,
    path: url.pathname,
    method: request.method(),
    type: request.resourceType(),
  };
};
context.on("request", (request) => {
  if (webMode === "production-build") {
    const url = new URL(request.url());
    if (url.origin === "http://localhost:39646") {
      if (
        /^\/(?:@vite\/|@react-refresh|@fs\/|src\/|node_modules\/\.vite\/)/.test(
          url.pathname,
        )
      )
        developmentSourceRequests.add(url.pathname);
      if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js"))
        compiledScriptRequests.add(url.pathname);
    }
  }
  if (/^https?:/.test(request.url()))
    pendingRequests.set(request, {
      ...safeRequest(request),
      started: Date.now(),
    });
});
context.on("requestfinished", (request) => pendingRequests.delete(request));
context.on("requestfailed", (request) => {
  pendingRequests.delete(request);
  failedRequests.push({
    ...safeRequest(request),
    error: request.failure()?.errorText,
  });
});
context.on("response", (response) => {
  const url = new URL(response.url());
  if (
    webMode === "production-build" &&
    !firstBuiltDocumentRead &&
    url.origin === "http://localhost:39646" &&
    url.pathname === "/" &&
    response.request().resourceType() === "document" &&
    response.ok()
  )
    firstBuiltDocumentRead = response.body().then(
      (bytes) => ({
        status: response.status(),
        indexSha256: createHash("sha256").update(bytes).digest("hex"),
        indexBytes: bytes.length,
      }),
      (error) => ({ error: String(error) }),
    );
  if (
    response.request().method() === "POST" &&
    (url.pathname === "/api/v1/browser-clipper/clips" ||
      /^\/api\/v1\/browser-clipper\/assistant\/ui\/sessions\/[^/]+\/messages$/.test(
        url.pathname,
      ))
  ) {
    const body = response.request().postDataJSON();
    earlySendResponses.push({
      path: url.pathname,
      status: response.status(),
      messageId: body?.id,
      captureRequestId: body?.captureRequestId ?? body?.requestId,
      profileId: body?.profileId,
    });
  }
  if (response.status() >= 400)
    failedResponses.push({
      ...safeRequest(response.request()),
      status: response.status(),
    });
  if (
    url.hostname === "localhost" &&
    (url.pathname.startsWith("/api/") || response.status() >= 400)
  ) {
    apiResponses.push({
      path: url.pathname,
      method: response.request().method(),
      status: response.status(),
    });
    if (apiResponses.length > 100) apiResponses.shift();
  }
});
context.on("request", (request) => {
  if (request.url().includes("/browser-clipper/assistant/ui/"))
    aiUiRequests.push({ url: request.url(), method: request.method() });
});
context.on("page", (page) =>
  page.on("pageerror", (error) => errors.push(error.message)),
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const extensionId = worker.url().split("/")[2];
  await worker.evaluate(() => {
    globalThis.qaFetchTrace = [];
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (...args) => {
      const url = new URL(typeof args[0] === "string" ? args[0] : args[0].url);
      const trace = {
        path: url.pathname,
        pendingId: url.searchParams.get("pendingId"),
        method: args[1]?.method || "GET",
        started: Date.now(),
      };
      globalThis.qaFetchTrace.push(trace);
      try {
        const response = await originalFetch(...args);
        Object.assign(trace, {
          headersAt: Date.now(),
          status: response.status,
        });
        const json = response.json.bind(response);
        response.json = async () => {
          trace.jsonStartedAt = Date.now();
          try {
            return await json();
          } finally {
            trace.jsonAt = Date.now();
          }
        };
        return response;
      } catch (error) {
        Object.assign(trace, { failedAt: Date.now(), error: error.message });
        throw error;
      }
    };
    globalThis.qaFastAuthSeen = false;
    globalThis.qaQuickNoteSnapshots = [];
    const sendTabMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (...args) => {
      if (globalThis.qaTrackQuickNotes && args[1]?.type === "snapshot")
        globalThis.qaQuickNoteSnapshots.push({
          tabId: args[0],
          mode: args[1].mode,
        });
      return sendTabMessage(...args);
    };
    chrome.runtime.onMessage.addListener((message) => {
      if (
        message.type === "loginResult" &&
        message.state === "qa-fast-inline-callback"
      )
        globalThis.qaFastAuthSeen = true;
    });
  });
  const fastAuth = await context.newPage();
  await fastAuth.goto(
    "http://localhost:39647/auth-fast/#/browser-connect?state=qa-fast-inline-callback",
  );
  assert.equal(
    await worker.evaluate(() => globalThis.qaFastAuthSeen),
    true,
    "login bridge observes a callback emitted by the first page script",
  );
  await fastAuth.close();
  const source = await context.newPage();
  await source.goto("http://localhost:39647/");
  await source.waitForSelector("#article img");
  await source.evaluate(() =>
    Promise.all([...document.images].map((image) => image.decode())),
  );
  let ui = await context.newPage();
  await ui.setViewportSize({ width: 390, height: 650 });
  await ui.goto(`chrome-extension://${extensionId}/ui.html`);
  async function loginPage(login = "clipperqa") {
    let page;
    const deadline = Date.now() + 20000;
    while (!page && Date.now() < deadline) {
      page = context
        .pages()
        .find((page) => page.url().includes("/#/browser-connect?"));
      if (!page) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(
      page,
      "authorization tab navigates after its callback binding is ready",
    );
    try {
      await page.locator('input[name="login"]').fill(login, { timeout: 60000 });
      await page
        .locator('input[name="password"]')
        .fill("isolated-browser-qa-password");
      await Promise.all([
        page.waitForEvent("close", { timeout: 60000 }),
        page.locator("form .primary").last().click(),
      ]);
    } catch (error) {
      console.log("LOGIN_PAGE_FAILURE", {
        closed: page.isClosed(),
        body: page.isClosed()
          ? "closed"
          : (await page.locator("body").textContent()).slice(0, 2500),
        flow: await worker.evaluate(async () => {
          const { loginFlow, lastError, loginRequired } =
            await chrome.storage.session.get([
              "loginFlow",
              "lastError",
              "loginRequired",
            ]);
          return {
            pending: !!loginFlow,
            interactive: loginFlow?.interactive,
            expiresAt: loginFlow?.expiresAt,
            lastError,
            loginRequired,
          };
        }),
      });
      throw error;
    }
  }
  async function verifyConnectedConfiguration() {
    await ui.waitForFunction(
      () =>
        document.querySelector("#identity").textContent === "浏览器验收账户" &&
        !document.querySelector("#capture-page").disabled,
    );
    const current = await ui.evaluate(
      async () => (await chrome.runtime.sendMessage({ type: "state" })).value,
    );
    assert.equal(current.connected, true);
    assert.equal(current.user.name, "浏览器验收账户");
    assert.equal(current.origin, "http://localhost:39646");
    assert.deepEqual(
      await worker.evaluate(
        async () => (await chrome.storage.local.get("site")).site,
      ),
      { version: 2, origin: "http://localhost:39646" },
    );
  }
  try {
    await loginPage();
  } catch (error) {
    console.log(
      "LOGIN_DEBUG",
      errors,
      context.pages().map((page) => page.url()),
      await ui.locator("body").innerText(),
    );
    console.log(
      "LOGIN_DEBUG_STORAGE",
      await worker.evaluate(async () => ({
        configured: !!(await chrome.storage.local.get("site")).site,
        loginFlow: !!(await chrome.storage.session.get("loginFlow")).loginFlow,
      })),
    );
    throw error;
  }
  try {
    await ui.waitForSelector("#capture-pane:not([hidden])", {
      timeout: 15000,
    });
  } catch (error) {
    await ui.screenshot({
      path: artifact("login-failure.png"),
      fullPage: true,
    });
    console.log("LOGIN_BODY", await ui.locator("body").innerText());
    throw error;
  }
  assert((await ui.locator("#identity").innerText()).includes("验收账户"));
  await ui.screenshot({
    path: artifact("extension-capture.png"),
    fullPage: true,
  });
  const state = await ui.evaluate(
    async () => await chrome.runtime.sendMessage({ type: "state" }),
  );
  assert(state.ok && state.value.connected);
  const sourceTab = await ui.evaluate(
    async () =>
      (await chrome.tabs.query({ url: "http://localhost:39647/*" }))[0],
  );
  assert(sourceTab.id);
  await source.bringToFront();
  assert.equal(await ui.locator("body.sidebar").count(), 0);
  assert.equal(await ui.locator("#assistant-root .ai-chat").count(), 0);
  assert.equal(await ui.locator("#attach-page").count(), 0);
  assert.equal(
    await ui
      .locator(
        "[data-tab], #quick-actions, #capture-mode, #quick-capture, #quick-organize",
      )
      .count(),
    0,
  );
  assert.equal(await ui.locator("select:visible").count(), 0);
  assert.deepEqual(
    aiUiRequests,
    [],
    "opening the capture popup does not initialize AI APIs",
  );
  const quickNoteFixtures = JSON.parse(process.env.DOCA_QA_QUICK_NOTES);
  assert.deepEqual(
    quickNoteFixtures.map((fixture) => fixture.format),
    ["rich_text", "markdown"],
  );
  await worker.evaluate(() => {
    globalThis.qaTrackQuickNotes = true;
    globalThis.qaQuickNoteStartedAt = Date.now();
  });
  async function openQuickNote() {
    await ui.locator("#quick-note > summary").click();
    await ui.waitForFunction(
      () =>
        !document.querySelector("#quick-note-target").disabled &&
        document.querySelector("#quick-note-target").options.length > 1,
    );
  }
  async function chooseQuickNote(fixture) {
    const label = await ui
      .locator(`#quick-note-target option[value="${fixture.profileId}"]`)
      .textContent();
    assert(label, "The authorized append target is present");
    await ui
      .locator("#quick-note-target")
      .locator("..")
      .getByRole("combobox")
      .click();
    await ui.getByRole("option", { name: label, exact: true }).click();
    assert.equal(
      await ui.locator("#quick-note-target").inputValue(),
      fixture.profileId,
    );
    assert.equal(
      await ui.locator("#quick-note-target-link").getAttribute("href"),
      `http://localhost:39646/#/r/${fixture.targetId}`,
    );
  }
  async function reopenCapturePopup() {
    await ui.close();
    ui = await context.newPage();
    await ui.setViewportSize({ width: 390, height: 650 });
    await ui.goto(`chrome-extension://${extensionId}/ui.html`);
    await verifyConnectedConfiguration();
    assert.equal(await ui.locator("#quick-note-target").inputValue(), "");
    assert.equal(await ui.locator("#quick-note-text").inputValue(), "");
    assert.equal(await ui.locator("#quick-note-retry").isVisible(), false);
  }
  async function verifyQuickNoteMemoryOnly() {
    const persisted = await ui.evaluate(async () => {
      const storage = JSON.stringify({
        local: await chrome.storage.local.get(null),
        session: await chrome.storage.session.get(null),
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      });
      const prepares = globalThis.qaQuickNoteCalls.filter(
        (entry) => entry.message.type === "quickNotePrepare",
      );
      const candidates = prepares.flatMap((entry) => [
        entry.message.text.split("\n")[0],
        entry.message.profileId,
        entry.result?.value?.targetId,
        entry.result?.value?.ticket,
      ]);
      candidates.push(
        document.querySelector("#quick-note-text").value.split("\n")[0],
      );
      return {
        values: candidates.filter((value) => value && storage.includes(value))
          .length,
        databases: await indexedDB.databases(),
      };
    });
    assert.deepEqual(
      persisted,
      { values: 0, databases: [] },
      "Quick-note text, selected target and ticket remain in UI memory",
    );
  }
  const quickNoteReport = {
    cases: [],
    rejectedRequestIds: [],
  };
  await openQuickNote();
  assert.equal(await ui.locator("#quick-note-target").inputValue(), "");
  const availableQuickNoteProfiles = await ui
    .locator("#quick-note-target option")
    .evaluateAll((options) =>
      options.map((option) => option.value).filter(Boolean),
    );
  assert.deepEqual(
    [...availableQuickNoteProfiles].sort(),
    [
      process.env.DOCA_QA_APPEND,
      ...quickNoteFixtures.map((fixture) => fixture.profileId),
    ].sort(),
    "Only exact enabled append profiles are offered; the default create profile is not a document grant",
  );
  assert.equal(await ui.locator("#quick-note-save").isDisabled(), true);
  const richNote = quickNoteFixtures[0];
  await chooseQuickNote(richNote);
  const richNoteText =
    "速记富文本_唯一追加\n# **原样文字** <>&\n\n最后一行 <script>不会执行</script>";
  await ui.locator("#quick-note-text").fill(richNoteText);
  await ui.evaluate(() => {
    globalThis.qaLoseNoteCommitResponse = true;
    const button = document.querySelector("#quick-note-save");
    button.click();
    button.click();
  });
  await ui.waitForFunction(
    () =>
      globalThis.qaNoteCommitResponseLost &&
      !document.querySelector("#quick-note-retry").hidden &&
      !document.querySelector("#quick-note-retry").disabled,
  );
  assert.equal(await ui.locator("#quick-note-text").inputValue(), richNoteText);
  assert.match(await ui.locator("#quick-note-status").innerText(), /无法确认/);
  assert.equal(await ui.locator("#quick-note-save").isDisabled(), true);
  const newerNoteDraft = "后续草稿_收到原记录确认时仍须保留";
  await ui.locator("#quick-note-text").fill(newerNoteDraft);
  await ui.locator("#quick-note-retry").click();
  await ui.locator("#quick-note-status.success").waitFor();
  assert.equal(
    await ui.locator("#quick-note-text").inputValue(),
    newerNoteDraft,
  );
  const richNoteDelivery = await ui.evaluate(() => {
    const prepared = globalThis.qaQuickNoteCalls.filter(
      (entry) => entry.message.type === "quickNotePrepare",
    );
    const commits = globalThis.qaQuickNoteCalls.filter(
      (entry) => entry.message.type === "quickNoteCommit",
    );
    return {
      preparations: prepared.length,
      commits: commits.length,
      originalText: prepared[0]?.message.text,
      requestId: prepared[0]?.message.requestId,
      sameTicketAndId:
        commits.length === 2 &&
        commits.every(
          (entry) =>
            entry.message.requestId === prepared[0].message.requestId &&
            entry.message.ticket === commits[0].message.ticket,
        ),
      acknowledgements: commits.map((entry) => entry.result),
    };
  });
  assert.equal(
    richNoteDelivery.preparations,
    1,
    "A repeated click prepares only one note",
  );
  assert.equal(richNoteDelivery.commits, 2);
  assert.equal(richNoteDelivery.originalText, richNoteText);
  assert.equal(richNoteDelivery.sameTicketAndId, true);
  const [richAccepted, richReplayed] = richNoteDelivery.acknowledgements;
  assert(richAccepted.ok && richReplayed.ok);
  assert.equal(richAccepted.value.changed, true);
  assert.equal(richReplayed.value.changed, false);
  assert.equal(richAccepted.value.seq, richReplayed.value.seq);
  assert.equal(richAccepted.value.epochId, richReplayed.value.epochId);
  quickNoteReport.cases.push({
    format: richNote.format,
    targetId: richNote.targetId,
    profileId: richNote.profileId,
    requestId: richNoteDelivery.requestId,
    text: richNoteText,
    seq: richReplayed.value.seq,
    epochId: richReplayed.value.epochId,
    preparations: richNoteDelivery.preparations,
    commits: richNoteDelivery.commits,
    repeatedClickSinglePreparation: true,
    acceptedResponseLost: true,
    sameTicketReplayWithoutSequenceIncrease: true,
    newerDraftPreserved: true,
  });
  await ui.screenshot({
    path: artifact("quick-note-rich-text-saved.png"),
    fullPage: true,
  });
  const markdownNote = quickNoteFixtures[1];
  await chooseQuickNote(markdownNote);
  const markdownNoteText =
    "速记Markdown_唯一追加\n# **普通 Markdown 源码** <>&\n\n- 第二行\n`代码` <script>不会执行</script>";
  await ui.locator("#quick-note-text").fill(markdownNoteText);
  await ui.locator("#quick-note-save").click();
  await ui.waitForFunction(
    () =>
      !document.querySelector("#quick-note-text").value &&
      document
        .querySelector("#quick-note-status")
        .classList.contains("success"),
  );
  const markdownDelivery = await ui.evaluate((profileId) => {
    const prepared = globalThis.qaQuickNoteCalls.filter(
      (entry) =>
        entry.message.type === "quickNotePrepare" &&
        entry.message.profileId === profileId,
    );
    const commits = globalThis.qaQuickNoteCalls.filter(
      (entry) =>
        entry.message.type === "quickNoteCommit" &&
        entry.message.requestId === prepared[0]?.message.requestId,
    );
    return {
      preparations: prepared.length,
      commits: commits.length,
      prepared: prepared[0]?.message,
      result: commits[0]?.result,
    };
  }, markdownNote.profileId);
  assert.equal(markdownDelivery.preparations, 1);
  assert.equal(markdownDelivery.commits, 1);
  assert.equal(markdownDelivery.prepared.text, markdownNoteText);
  assert(markdownDelivery.result.ok && markdownDelivery.result.value.changed);
  quickNoteReport.cases.push({
    format: markdownNote.format,
    targetId: markdownNote.targetId,
    profileId: markdownNote.profileId,
    requestId: markdownDelivery.prepared.requestId,
    text: markdownNoteText,
    seq: markdownDelivery.result.value.seq,
    epochId: markdownDelivery.result.value.epochId,
    preparations: markdownDelivery.preparations,
    commits: markdownDelivery.commits,
    acknowledgedDraftCleared: true,
    ordinaryMarkdownSource: true,
  });
  await ui.screenshot({
    path: artifact("quick-note-markdown-saved.png"),
    fullPage: true,
  });
  const missingTicketText = "速记票据丢失_不得自动重新追加 <>&";
  await ui.locator("#quick-note-text").fill(missingTicketText);
  await ui.evaluate(() => {
    globalThis.qaMissingNoteTicket = true;
  });
  await ui.locator("#quick-note-save").click();
  await ui.waitForFunction(() =>
    globalThis.qaQuickNoteCalls.some(
      (entry) =>
        entry.message.type === "quickNoteCommit" &&
        entry.result?.error === "quick_note_ticket_missing",
    ),
  );
  await ui.locator("#quick-note-status.error").waitFor();
  assert.equal(
    await ui.locator("#quick-note-text").inputValue(),
    missingTicketText,
  );
  assert.match(
    await ui.locator("#quick-note-status").innerText(),
    /请先检查目标文档/,
  );
  assert.equal(await ui.locator("#quick-note-save").isDisabled(), true);
  assert.equal(await ui.locator("#quick-note-retry").isVisible(), false);
  assert.equal(await ui.locator("#quick-note-target-link").isVisible(), true);
  assert.equal(
    await ui.locator("#quick-note-target-link").getAttribute("href"),
    `http://localhost:39646/#/r/${markdownNote.targetId}`,
  );
  const missingTicketCalls = await ui.evaluate((text) => {
    const prepares = globalThis.qaQuickNoteCalls.filter(
      (entry) =>
        entry.message.type === "quickNotePrepare" &&
        entry.message.text === text,
    );
    const commits = globalThis.qaQuickNoteCalls.filter(
      (entry) =>
        entry.message.type === "quickNoteCommit" &&
        entry.message.requestId === prepares[0]?.message.requestId,
    );
    return {
      prepares: prepares.length,
      commits: commits.length,
      requestId: prepares[0]?.message.requestId,
      status: commits[0]?.result?.status,
    };
  }, missingTicketText);
  assert.equal(missingTicketCalls.prepares, 1);
  assert.equal(missingTicketCalls.commits, 1);
  assert.equal(missingTicketCalls.status, 409);
  quickNoteReport.rejectedRequestIds.push(missingTicketCalls.requestId);
  quickNoteReport.missingTicket = {
    backendStatus: 409,
    draftPreserved: true,
    explicitDocumentLink: true,
    automaticReprepare: false,
    method:
      "Unknown ticket forwarded to the real backend; expiry is covered by the isolated backend QA",
  };
  await ui.screenshot({
    path: artifact("quick-note-ticket-missing.png"),
    fullPage: true,
  });
  await verifyQuickNoteMemoryOnly();
  // Ending an uncertain operation requires an explicit confirmation and never sends it again.
  await ui.locator("#quick-note-clear").click();
  await ui.locator("#quick-note-cancel-reset").click();
  assert.equal(await ui.locator("#quick-note-save").isDisabled(), true);
  await ui.locator("#quick-note-clear").click();
  await ui.locator("#quick-note-confirm-reset").scrollIntoViewIfNeeded();
  await ui.screenshot({
    path: artifact("quick-note-ticket-missing-confirmation.png"),
    fullPage: true,
  });
  await ui.locator("#quick-note-confirm-reset").click();
  assert.equal(
    await ui.locator("#quick-note-text").inputValue(),
    missingTicketText,
  );
  assert.equal(await ui.locator("#quick-note-save").isDisabled(), false);
  assert.equal(
    await ui.evaluate(
      () =>
        globalThis.qaQuickNoteCalls.filter(
          (entry) => entry.message.type === "quickNotePrepare",
        ).length,
    ),
    3,
  );
  await reopenCapturePopup();
  await openQuickNote();
  await chooseQuickNote(markdownNote);
  const withdrawnNoteText = "速记规则停用_不得写入原文档";
  await ui.locator("#quick-note-text").fill(withdrawnNoteText);
  await ui.evaluate(() => {
    globalThis.qaHoldNotePreparation = true;
  });
  await ui.locator("#quick-note-save").click();
  await ui.waitForFunction(() => globalThis.qaNotePreparationWaiting === true);
  const withdrawnProfile = await context.request.put(
    `http://localhost:39646/api/v1/me/browser-clipper/profiles/${markdownNote.profileId}`,
    {
      headers: { origin: "http://localhost:39646" },
      data: {
        ...markdownNote.profileInput,
        revision: markdownNote.profileRevision,
        enabled: false,
      },
    },
  );
  assert.equal(withdrawnProfile.status(), 200, await withdrawnProfile.text());
  await ui.evaluate(() => {
    globalThis.qaHoldNotePreparation = false;
    globalThis.qaReleaseNotePreparation();
  });
  await ui.waitForFunction(() =>
    globalThis.qaQuickNoteCalls.some(
      (entry) =>
        entry.message.type === "quickNoteCommit" &&
        entry.result?.error === "clipper_profile_changed",
    ),
  );
  await ui.locator("#quick-note-status.error").waitFor();
  assert.equal(
    await ui.locator("#quick-note-text").inputValue(),
    withdrawnNoteText,
  );
  assert.equal(await ui.locator("#quick-note-save").isDisabled(), true);
  assert.equal(await ui.locator("#quick-note-retry").isVisible(), false);
  assert.equal(
    await ui.locator("#quick-note-target-link").getAttribute("href"),
    `http://localhost:39646/#/r/${markdownNote.targetId}`,
  );
  assert.equal(
    await ui.locator("#quick-note-target").inputValue(),
    "",
    "A rejected profile cannot remain a selectable destination",
  );
  const withdrawnCalls = await ui.evaluate(() => {
    const prepares = globalThis.qaQuickNoteCalls.filter(
      (entry) => entry.message.type === "quickNotePrepare",
    );
    const commits = globalThis.qaQuickNoteCalls.filter(
      (entry) => entry.message.type === "quickNoteCommit",
    );
    return {
      prepares: prepares.length,
      commits: commits.length,
      requestId: prepares[0]?.message.requestId,
      status: commits[0]?.result?.status,
    };
  });
  assert.equal(withdrawnCalls.prepares, 1);
  assert.equal(withdrawnCalls.commits, 1);
  assert.equal(withdrawnCalls.status, 409);
  quickNoteReport.rejectedRequestIds.push(withdrawnCalls.requestId);
  quickNoteReport.profileWithdrawal = {
    backendStatus: 409,
    draftPreserved: true,
    frozenTargetRetained: true,
    automaticRetarget: false,
  };
  await ui.screenshot({
    path: artifact("quick-note-target-withdrawn.png"),
    fullPage: true,
  });
  await ui.locator("#quick-note-clear").click();
  await ui.locator("#quick-note-confirm-reset").scrollIntoViewIfNeeded();
  await ui.screenshot({
    path: artifact("quick-note-target-withdrawn-confirmation.png"),
    fullPage: true,
  });
  await ui.locator("#quick-note-confirm-reset").click();
  await ui.waitForFunction(
    () => !document.querySelector("#quick-note-target").disabled,
  );
  assert.equal(await ui.locator("#quick-note-target").inputValue(), "");
  assert.equal(
    await ui.locator("#quick-note-text").inputValue(),
    withdrawnNoteText,
  );
  assert.equal(await ui.locator("#quick-note-save").isDisabled(), true);
  assert.deepEqual(
    await ui.evaluate(() => ({
      prepares: globalThis.qaQuickNoteCalls.filter(
        (entry) => entry.message.type === "quickNotePrepare",
      ).length,
      commits: globalThis.qaQuickNoteCalls.filter(
        (entry) => entry.message.type === "quickNoteCommit",
      ).length,
    })),
    { prepares: 1, commits: 1 },
    "Ending a withdrawn attempt neither prepares nor commits another record",
  );
  await verifyQuickNoteMemoryOnly();
  const quickNoteRuntime = await worker.evaluate(() => {
    globalThis.qaTrackQuickNotes = false;
    return {
      snapshots: globalThis.qaQuickNoteSnapshots,
      sideEffects: globalThis.qaFetchTrace.filter(
        (entry) =>
          entry.started >= globalThis.qaQuickNoteStartedAt &&
          /\/browser-clipper\/(clips|captures|assistant\/)|\/assets(?:\/|$)/.test(
            entry.path,
          ),
      ),
    };
  });
  assert.deepEqual(quickNoteRuntime.snapshots, []);
  assert.deepEqual(quickNoteRuntime.sideEffects, []);
  assert.deepEqual(
    aiUiRequests,
    [],
    "Quick notes never initialize or call the AI assistant",
  );
  await reopenCapturePopup();
  await openQuickNote();
  assert.equal(
    await ui
      .locator(`#quick-note-target option[value="${markdownNote.profileId}"]`)
      .count(),
    0,
    "A withdrawn profile is absent when the new popup reads current targets",
  );
  quickNoteReport.completedAt = Date.now();
  quickNoteReport.targetSelectionExplicit = true;
  quickNoteReport.targetAndDraftResetOnReopen = true;
  quickNoteReport.noBrowserStorage = true;
  quickNoteReport.snapshotCalls = 0;
  quickNoteReport.aiUiRequests = 0;
  quickNoteReport.captureOrImageRequests = 0;
  await ui.screenshot({
    path: artifact("quick-note-popup-reopened.png"),
    fullPage: true,
  });
  await ui.locator("#quick-note > summary").click();
  await source.bringToFront();
  assert.equal(
    await ui.locator("#profile").inputValue(),
    process.env.DOCA_QA_PROFILE,
  );
  const profileTrigger = ui
    .locator("#profile")
    .locator("..")
    .getByRole("combobox");
  await profileTrigger.click();
  await ui.getByRole("option", { name: "排查摘录", exact: true }).click();
  assert.equal(
    await ui.locator("#profile").inputValue(),
    process.env.DOCA_QA_APPEND,
  );
  await ui.click("#settings");
  await ui.waitForSelector("#connection-pane:not([hidden])");
  assert.equal(
    await ui.locator("#settings-link").getAttribute("href"),
    "http://localhost:39646/#/browser-assistant",
  );
  assert.equal(await ui.locator("#connection-pane #endpoint").count(), 1);
  assert.equal(await ui.locator("#connection-pane #config").count(), 1);
  assert.equal(await ui.locator("#connection-pane #locale").count(), 1);
  await ui.click("#back");
  await ui.waitForSelector("#capture-pane:not([hidden])");
  assert.equal(
    await ui.locator("#profile").inputValue(),
    process.env.DOCA_QA_APPEND,
  );
  await profileTrigger.click();
  await ui
    .getByRole("option", { name: "故障案例 · 默认", exact: true })
    .click();
  await ui.screenshot({
    path: artifact("extension-popup-home.png"),
    fullPage: true,
  });
  assert.equal(await ui.locator("#assistant-root .ai-chat").count(), 0);
  assert.deepEqual(
    aiUiRequests,
    [],
    "settings and profile changes leave AI uninitialized in the popup",
  );
  // A trusted mouse release exposes the actual closed-shadow selection toolbar.
  await source.bringToFront();
  const point = await source.locator("#article").boundingBox();
  await source.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("article"));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await source.mouse.move(point.x + 30, point.y + 35);
  await source.mouse.up();
  await source.waitForSelector("[data-doca-capture-ui]");
  const cdp = await context.newCDPSession(source);
  async function toolbarTree() {
    return (await cdp.send("DOM.getDocument", { depth: -1, pierce: true }))
      .root;
  }
  function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of [
      ...(node.children || []),
      ...(node.shadowRoots || []),
    ]) {
      const result = find(child, predicate);
      if (result) return result;
    }
    return null;
  }
  const textOf = (node) =>
    (node.nodeValue || "") +
    [...(node.children || []), ...(node.shadowRoots || [])]
      .map(textOf)
      .join("");
  async function motionFrames(nodeId, prefix, parent = false) {
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
    const objectId = object.objectId;
    const invoke = async (functionDeclaration, args = []) =>
      cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      });
    // Restart the actual CSS entry animation solely to sample its three phases.
    const animated = await invoke(
      `function(parent) {
      const element = parent ? this.parentElement : this;
      element.style.animation = 'none'; void element.offsetWidth; element.style.animation = '';
      this.qaAnimations = element.getAnimations().filter(animation => animation.effect.getTiming().duration > 0);
      this.qaAnimations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
      return this.qaAnimations.length;
    }`,
      [parent],
    );
    assert(
      animated.result.value > 0,
      `${prefix} uses the application CSS animation`,
    );
    for (const [name, progress] of [
      ["start", 0],
      ["middle", 0.5],
      ["end", 1],
    ]) {
      await invoke(
        "function(progress) { this.qaAnimations.forEach(animation => { animation.currentTime = Number(animation.effect.getTiming().duration) * progress; }); }",
        [progress],
      );
      await source.screenshot({
        path: artifact(`${prefix}-${name}.png`),
        fullPage: true,
      });
    }
    await invoke(
      "function() { this.qaAnimations.forEach(animation => animation.finish()); delete this.qaAnimations; }",
    );
  }
  let tree = await toolbarTree();
  const icon = find(
    tree,
    (node) => node.nodeName === "BUTTON" && node.attributes.includes("logo"),
  );
  assert(icon, "collapsed Doca launcher");
  const iconBox = (await cdp.send("DOM.getBoxModel", { nodeId: icon.nodeId }))
    .model.border;
  await motionFrames(icon.nodeId, "selection-launcher", true);
  await source.screenshot({
    path: artifact("selection-collapsed.png"),
    fullPage: true,
  });
  await source.mouse.click(
    (iconBox[0] + iconBox[4]) / 2,
    (iconBox[1] + iconBox[5]) / 2,
  );
  tree = await toolbarTree();
  const panel = find(
    tree,
    (node) => node.nodeName === "DIV" && node.attributes.includes("panel"),
  );
  assert(panel, "expanded capture panel");
  await motionFrames(panel.nodeId, "selection-expand");
  await source.screenshot({
    path: artifact("selection-expanded.png"),
    fullPage: true,
  });
  const deadline = Date.now() + 12000;
  let button;
  while (Date.now() < deadline) {
    const tree = await toolbarTree();
    button = find(
      tree,
      (node) =>
        node.nodeName === "BUTTON" && textOf(node).includes("收录到 Doca"),
    );
    if (button && !button.attributes.includes("disabled")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(button, "selection capture button");
  tree = await toolbarTree();
  const dropdown = find(
    tree,
    (node) =>
      node.nodeName === "BUTTON" && node.attributes.includes("combobox"),
  );
  const dropdownBox = (
    await cdp.send("DOM.getBoxModel", { nodeId: dropdown.nodeId })
  ).model.border;
  await source.mouse.click(
    (dropdownBox[0] + dropdownBox[4]) / 2,
    (dropdownBox[1] + dropdownBox[5]) / 2,
  );
  tree = await toolbarTree();
  const menu = find(
    tree,
    (node) => node.nodeName === "DIV" && node.attributes.includes("listbox"),
  );
  assert(menu, "expanded capture rule dropdown");
  await motionFrames(menu.nodeId, "selection-dropdown");
  await source.screenshot({
    path: artifact("selection-dropdown.png"),
    fullPage: true,
  });
  const closeDropdown = find(
    await toolbarTree(),
    (node) =>
      node.nodeName === "BUTTON" && node.attributes.includes("combobox"),
  );
  const closeDropdownBox = (
    await cdp.send("DOM.getBoxModel", { nodeId: closeDropdown.nodeId })
  ).model.border;
  await source.mouse.click(
    (closeDropdownBox[0] + closeDropdownBox[4]) / 2,
    (closeDropdownBox[1] + closeDropdownBox[5]) / 2,
  );
  button = find(
    await toolbarTree(),
    (node) =>
      node.nodeName === "BUTTON" && textOf(node).includes("收录到 Doca"),
  );
  const box = (await cdp.send("DOM.getBoxModel", { nodeId: button.nodeId }))
    .model.border;
  await source.mouse.click((box[0] + box[4]) / 2, (box[1] + box[5]) / 2);
  let saved = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (textOf(await toolbarTree()).includes("已保存，打开文档")) {
      saved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!saved) {
    console.log("TOOLBAR_SAVE_FAILURE", textOf(await toolbarTree()));
    await source.screenshot({
      path: artifact("selection-save-failure.png"),
      fullPage: true,
    });
  }
  assert(saved, "selected content and image saved from the actual toolbar");
  await source.screenshot({
    path: artifact("selection-toolbar.png"),
    fullPage: true,
  });
  // Exercise the popup selection button separately from the floating toolbar.
  await source.bringToFront();
  await source.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("article"));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  // This fixture renders a popup in a tab. DOM activation leaves the actual source
  // tab active, as it is when a browser popup or native side panel is in use.
  await ui.evaluate(() => document.querySelector("#capture-selection").click());
  await ui
    .locator("#notice.success")
    .filter({ hasText: "已保存到 Doca" })
    .waitFor();
  await ui.screenshot({
    path: artifact("extension-popup-selection-saved.png"),
    fullPage: true,
  });
  await ui.locator("#capture-page:not([disabled])").waitFor();
  await ui.evaluate(() => document.querySelector("#capture-page").click());
  try {
    await ui
      .locator("#notice.success")
      .filter({ hasText: "已保存到 Doca" })
      .waitFor();
  } catch (error) {
    console.log("CAPTURE_BODY", await ui.locator("body").innerText());
    throw error;
  }
  // Invoke the real MV3 sidePanel APIs from a trusted click. Only window.close is
  // suppressed because this popup fixture is an inspected extension tab.
  await profileTrigger.click();
  await ui.getByRole("option", { name: "排查摘录", exact: true }).click();
  await ui.evaluate(() => {
    globalThis.qaSidePanelCalls = [];
    globalThis.qaPopupCloseRequested = false;
    const setOptions = chrome.sidePanel.setOptions.bind(chrome.sidePanel);
    const open = chrome.sidePanel.open.bind(chrome.sidePanel);
    chrome.sidePanel.setOptions = async (options) => {
      const call = { type: "setOptions", options };
      globalThis.qaSidePanelCalls.push(call);
      await setOptions(options);
      call.resolved = true;
    };
    chrome.sidePanel.open = async (options) => {
      const call = { type: "open", options };
      globalThis.qaSidePanelCalls.push(call);
      await open(options);
      call.resolved = true;
    };
    window.close = () => {
      globalThis.qaPopupCloseRequested = true;
    };
  });
  await source.bringToFront();
  await ui.locator("#open-assistant").click();
  await ui.waitForFunction(() => globalThis.qaPopupCloseRequested);
  const sidePanelCalls = await ui.evaluate(() => globalThis.qaSidePanelCalls);
  assert.deepEqual(
    sidePanelCalls.map((call) => call.type),
    ["setOptions", "open"],
  );
  assert(
    sidePanelCalls.every((call) => call.resolved),
    "both real sidePanel API calls resolved",
  );
  const panelOptions = sidePanelCalls[0].options;
  assert.equal(panelOptions.tabId, sourceTab.id);
  assert.equal(panelOptions.enabled, true);
  assert.equal(sidePanelCalls[1].options.tabId, sourceTab.id);
  const panelPath = new URL(
    panelOptions.path,
    `chrome-extension://${extensionId}/`,
  );
  assert(panelPath.hash.startsWith("#assistant?"));
  const panelParameters = new URLSearchParams(
    panelPath.hash.slice("#assistant?".length),
  );
  assert.equal(panelParameters.get("profileId"), process.env.DOCA_QA_APPEND);
  assert.equal(panelParameters.get("profileRevision"), "1");
  const nativeSidePanelTarget = context
    .pages()
    .find(
      (page) =>
        page !== ui &&
        page
          .url()
          .startsWith(
            `chrome-extension://${extensionId}${panelPath.pathname}#assistant`,
          ),
    );
  const nativeSidePanelInspection = nativeSidePanelTarget
    ? "native panel target exposed by Chromium"
    : "headless Chromium resolved native open; no inspectable native panel target, shared UI checked in an extension-tab fixture";
  const settings = await context.newPage();
  await settings.setViewportSize({ width: 1440, height: 1000 });
  await settings.goto("http://localhost:39646/#/browser-assistant", {
    waitUntil: "domcontentloaded",
  });
  await settings
    .getByRole("heading", { name: "浏览器助手", exact: true })
    .waitFor();
  await settings.getByText("故障案例", { exact: true }).waitFor();
  const file = settings.waitForEvent("download");
  await settings
    .getByRole("button", { name: /^下载扩展 v\d+(?:\.\d+){0,3}$/ })
    .click();
  const downloadedName = (await file).suggestedFilename();
  assert.match(downloadedName, /^doca-browser-assistant-\d+(?:\.\d+){0,3}\.zip$/);
  assert.equal(await settings.locator(".clipper-package-filename").textContent(), downloadedName);
  await settings.locator(".account-menu > summary").click();
  await settings.locator('.account-menu [data-entry-id="doca.mcp"]').waitFor();
  const entries = await settings
    .locator(".account-menu [data-entry-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.entryId));
  assert.equal(
    entries[entries.indexOf("doca.mcp") + 1],
    "doca.browser-assistant",
  );
  const menuMcp = await settings
    .locator('.account-menu [data-entry-id="doca.mcp"] svg')
    .boundingBox();
  const menuBrowser = await settings
    .locator('.account-menu [data-entry-id="doca.browser-assistant"] svg')
    .boundingBox();
  assert.equal(menuMcp.x, menuBrowser.x);
  await settings.screenshot({ path: artifact("account-menu.png") });
  await settings.keyboard.press("Escape");
  await settings.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await settings.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await settings.screenshot({
    path: artifact("doca-profiles.png"),
    fullPage: true,
  });
  const firstReplica = await context.newPage(),
    secondReplica = await context.newPage();
  await firstReplica.goto(
    `http://localhost:39646/#/r/${process.env.DOCA_QA_TARGET}`,
    { waitUntil: "domcontentloaded" },
  );
  await secondReplica.goto(
    `http://localhost:39646/#/r/${process.env.DOCA_QA_TARGET}`,
    { waitUntil: "domcontentloaded" },
  );
  async function waitBody(page, text) {
    try {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        text,
        { timeout: 60000 },
      );
    } catch (error) {
      await page.screenshot({
        path: artifact("document-failure.png"),
        fullPage: true,
      });
      console.log(
        "DOCUMENT_BODY",
        (await page.locator("body").innerText()).slice(-10000),
      );
      throw error;
    }
  }
  await waitBody(firstReplica, "原有排查内容");
  await waitBody(secondReplica, "原有排查内容");
  const appended = await ui.evaluate(
    async ({ tabId, profileId }) =>
      await chrome.runtime.sendMessage({
        type: "capture",
        mode: "page",
        tabId,
        profileId,
        profileRevision: 1,
      }),
    { tabId: sourceTab.id, profileId: process.env.DOCA_QA_APPEND },
  );
  assert(appended.ok, JSON.stringify(appended));
  await waitBody(firstReplica, "接线端子松动");
  await waitBody(secondReplica, "接线端子松动");
  await firstReplica.screenshot({
    path: artifact("append-live-document.png"),
    fullPage: true,
  });
  await secondReplica.close();
  // A real popup has already closed after opening the native panel. Stop this
  // inspected popup fixture before mounting the side-panel fixture as well.
  await ui.close();
  ui = await context.newPage();
  await ui.goto(panelPath.href);
  await ui.reload();
  await ui.setViewportSize({ width: 410, height: 850 });
  await ui.waitForSelector("#assistant-pane:not([hidden])");
  assert.equal(await ui.locator("body.sidebar").count(), 1);
  assert.equal(
    await ui.locator("#ai-profile").inputValue(),
    process.env.DOCA_QA_APPEND,
  );
  await ui.locator("#ai-profile").locator("..").getByRole("combobox").click();
  await ui
    .getByRole("option", { name: "故障案例 · 默认", exact: true })
    .click();
  assert.equal(
    await ui.locator("#ai-profile").inputValue(),
    process.env.DOCA_QA_PROFILE,
  );
  await source.bringToFront();
  await ui.waitForFunction(() =>
    document
      .querySelector(".ai-browser-page-context")
      .textContent.includes("设备启动故障排查"),
  );
  await ui
    .getByRole("combobox", { name: "选择 AI 模型", exact: true })
    .waitFor();
  await ui.getByRole("combobox", { name: "选择 AI 模型", exact: true }).click();
  await ui.getByRole("option", { name: "验收模型", exact: true }).click();
  assert.equal(await ui.locator("#attach-page").count(), 0);
  const earlyRefreshRecovery = [];
  const earlyScope = await ui.evaluate(
    async () => (await chrome.runtime.sendMessage({ type: "state" })).value,
  );
  assert(earlyScope.connected);
  const pendingScope = {
    docaOrigin: new URL(earlyScope.origin).origin,
    userId: earlyScope.user.id,
    connectionId: earlyScope.connectionId,
  };
  const legacyKey = `doca.ai.pending-send.browser:${earlyScope.user.id}:${earlyScope.connectionId}`;
  const legacyRaw = await ui.evaluate(
    (key) => localStorage.getItem(key),
    legacyKey,
  );
  const originalProfile = process.env.DOCA_QA_PROFILE;
  const alternateProfile = process.env.DOCA_QA_APPEND;
  const assistantScope = {
    origin: earlyScope.origin,
    connectionId: earlyScope.connectionId,
    profileId: originalProfile,
  };
  for (const stage of ["paint", "create-session", "prepare-page"]) {
    await ui.getByTitle("新建会话", { exact: true }).click();
    await ui.waitForFunction(async (scope) => {
      const result = await chrome.runtime.sendMessage({
        type: "assistantSession",
        ...scope,
        operation: "get",
      });
      return result.ok && result.value.sessionId === null;
    }, assistantScope);
    const composer = ui.locator('.ai-composer [contenteditable="true"]');
    await composer.waitFor();
    const marker = `QA_EARLY_${stage}_ORIGINAL。只在对话里回答。`;
    const newDraft = `NEW_LOCAL_DRAFT_${stage}`;
    await composer.fill(marker);
    await ui.waitForFunction(() => {
      const button = document.querySelector('button[aria-label="发送"]');
      return button && !button.disabled;
    });
    const responseStart = earlySendResponses.length;
    await source.bringToFront();
    await ui.evaluate((stage) => {
      sessionStorage.setItem("qaEarlyStage", stage);
      sessionStorage.setItem("qaEarlyInterrupt", "armed");
      globalThis.qaEarlyHoldPaint = stage === "paint";
      document.querySelector('button[aria-label="发送"]').click();
    }, stage);
    await ui.waitForFunction(
      async ({ scope, marker }) =>
        (await globalThis.qaPendingProbe(scope)).some(
          (entry) => entry.state === "pending" && entry.item.text === marker,
        ),
      { scope: pendingScope, marker },
      { polling: 50 },
    );
    if (stage !== "paint")
      await ui.waitForFunction(
        () => sessionStorage.getItem("qaEarlyInterrupt") === "entered",
      );
    const retained = await ui.evaluate(
      async ({ scope, marker }) =>
        (await globalThis.qaPendingProbe(scope)).find(
          (entry) => entry.state === "pending" && entry.item.text === marker,
        ),
      { scope: pendingScope, marker },
    );
    assert(
      retained.item?.id,
      `${stage}: original message is durable before navigation`,
    );
    assert.equal(
      retained.sessionId === null,
      stage !== "prepare-page",
      `${stage}: the pending item has the expected session binding`,
    );
    assert.equal(retained.recordVersion, 1);
    assert.equal(retained.messageId, retained.item.id);
    assert.deepEqual(retained.profile, { id: originalProfile, revision: 1 });
    assert.equal(
      earlySendResponses.length,
      responseStart,
      `${stage}: neither page preparation nor message POST reached the backend`,
    );
    await ui.screenshot({
      path: artifact(`early-${stage}-before-refresh.png`),
      fullPage: true,
    });
    // Even an unbound IDB draft retains its explicit profile. Reopen under
    // another profile before allowing delivery of the original item.
    await ui.evaluate((profileId) => {
      sessionStorage.setItem("qaEarlyResumeHeld", "1");
      history.replaceState(
        null,
        "",
        "#assistant?" +
          new URLSearchParams({ profileId, profileRevision: "1" }),
      );
    }, alternateProfile);
    await ui.reload({ waitUntil: "domcontentloaded" });
    await ui.waitForFunction(
      (profileId) => document.querySelector("#ai-profile")?.value === profileId,
      alternateProfile,
    );
    await ui
      .getByRole("combobox", { name: "选择 AI 模型", exact: true })
      .waitFor();
    assert.equal(
      await ui.locator(".ai-pending-item").filter({ hasText: marker }).count(),
      0,
      "another profile does not display the original pending item",
    );
    assert.equal(
      await ui
        .locator(".ai-user-message-text")
        .filter({ hasText: marker })
        .count(),
      0,
      "another profile does not display the original conversation",
    );
    assert.equal(
      earlySendResponses.length,
      responseStart,
      `${stage}: switching profiles never sends the retained original`,
    );
    const afterReload = await ui.evaluate(
      async ({ scope, id }) =>
        (await globalThis.qaPendingProbe(scope)).find(
          (entry) => entry.messageId === id,
        ),
      { scope: pendingScope, id: retained.item.id },
    );
    assert.deepEqual(
      afterReload,
      retained,
      "the exact original snapshot survives reload",
    );
    await ui.locator("#ai-profile").locator("..").getByRole("combobox").click();
    await ui
      .getByRole("option", { name: "故障案例 · 默认", exact: true })
      .click();
    await ui.waitForFunction(
      (profileId) => document.querySelector("#ai-profile")?.value === profileId,
      originalProfile,
    );
    await composer.waitFor();
    await composer.fill(newDraft);
    const pendingRow = ui
      .locator(".ai-pending-item")
      .filter({ hasText: marker });
    await pendingRow.waitFor();
    await source.bringToFront();
    // Current-session pending entries drain automatically on return to the
    // original profile. Unbound drafts still require an explicit Continue.
    if (stage !== "prepare-page")
      await pendingRow
        .getByRole("button", { name: "立即发送", exact: true })
        .evaluate((button) => button.click());
    await ui.waitForFunction(
      () => globalThis.qaEarlyResumeWaiting === true,
      undefined,
      { timeout: 60000 },
    );
    // IndexedDB and service-worker network events use different CDP channels.
    // Observe the exact responses before taking the immutable count snapshot.
    await Promise.all([
      context.waitForEvent("response", {
        predicate: (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            "/api/v1/browser-clipper/clips" &&
          response.status() >= 200 &&
          response.status() < 300 &&
          response.request().postDataJSON()?.profileId === originalProfile,
      }),
      context.waitForEvent("response", {
        predicate: (response) =>
          response.request().method() === "POST" &&
          /^\/api\/v1\/browser-clipper\/assistant\/ui\/sessions\/[^/]+\/messages$/.test(
            new URL(response.url()).pathname,
          ) &&
          response.status() >= 200 &&
          response.status() < 300 &&
          response.request().postDataJSON()?.id === retained.item.id,
      }),
      ui.evaluate(() => globalThis.qaReleaseEarlyResume()),
    ]);
    await ui.waitForFunction(
      async ({ scope, id }) =>
        (await globalThis.qaPendingProbe(scope)).some(
          (entry) =>
            entry.messageId === id &&
            entry.state === "accepted" &&
            entry.serverJobId === id,
        ),
      { scope: pendingScope, id: retained.item.id },
    );
    const acceptedEntry = await ui.evaluate(
      async ({ scope, id }) =>
        (await globalThis.qaPendingProbe(scope)).find(
          (entry) => entry.messageId === id,
        ),
      { scope: pendingScope, id: retained.item.id },
    );
    assert.equal(acceptedEntry.recordVersion, 1);
    assert.equal(acceptedEntry.messageId, retained.messageId);
    assert.deepEqual(acceptedEntry.profile, retained.profile);
    assert.deepEqual(acceptedEntry.item, retained.item);
    assert.equal(acceptedEntry.payloadHash, retained.payloadHash);
    assert.equal(acceptedEntry.source, undefined);
    assert.equal(
      await ui.evaluate((key) => localStorage.getItem(key), legacyKey),
      legacyRaw,
      "New IDB sends preserve the original legacy localStorage bytes",
    );
    const sent = earlySendResponses.slice(responseStart);
    const accepted = sent.filter(
      (entry) =>
        entry.path.endsWith("/messages") &&
        entry.status >= 200 &&
        entry.status < 300,
    );
    assert.equal(
      accepted.length,
      1,
      `${stage}: the original ID has one accepted message POST`,
    );
    assert.equal(accepted[0].messageId, retained.item.id);
    const captureRequestId = accepted[0].captureRequestId;
    assert(captureRequestId);
    const preparations = sent.filter(
      (entry) =>
        entry.path === "/api/v1/browser-clipper/clips" &&
        entry.status >= 200 &&
        entry.status < 300,
    );
    assert.equal(
      preparations.length,
      1,
      `${stage}: one page preparation is committed`,
    );
    assert.equal(preparations[0].captureRequestId, captureRequestId);
    assert.equal(preparations[0].profileId, originalProfile);
    const sessionId = accepted[0].path.split("/").at(-2);
    assert.equal(acceptedEntry.sessionId, sessionId);
    await ui.waitForFunction(
      async ({ scope, sessionId, id }) => {
        const result = await chrome.runtime.sendMessage({
          type: "assistantRequest",
          ...scope,
          path: `/assistant/ui/sessions/${sessionId}?pendingId=${id}`,
          method: "GET",
        });
        return (
          result.ok &&
          result.value.jobs.filter((job) => job.id === id).length === 1 &&
          result.value.jobs.find((job) => job.id === id)?.status ===
            "completed" &&
          result.value.messages.filter(
            (message) => message.id === id && message.role === "user",
          ).length === 1
        );
      },
      { scope: assistantScope, sessionId, id: retained.item.id },
      { polling: 250, timeout: 20000 },
    );
    await ui
      .locator(".ai-user-message-text")
      .filter({ hasText: marker })
      .waitFor();
    await ui
      .locator(".ai-messages h2")
      .filter({ hasText: "排查建议" })
      .waitFor();
    await ui.locator(".ai-messages table").waitFor();
    await ui
      .locator(".ai-messages code")
      .filter({ hasText: "检查接线" })
      .waitFor();
    assert.equal(
      (await composer.innerText()).trim(),
      newDraft,
      "continuing the original preserves the later local draft",
    );
    await ui.screenshot({
      path: artifact(`early-${stage}-resumed.png`),
      fullPage: true,
    });
    earlyRefreshRecovery.push({
      stage,
      messageId: retained.item.id,
      sessionId,
      profileId: originalProfile,
      captureRequestId,
      acceptedMessagePosts: accepted.length,
      capturePreparations: preparations.length,
      messagePostAttempts: sent.filter(
        (entry) => entry.messageId === retained.item.id,
      ).length,
      newDraftPreserved: true,
      profileIsolation: true,
      indexedDBAcceptedTombstone: true,
      legacyBytesPreserved: true,
    });
    await ui.evaluate(() => {
      sessionStorage.removeItem("qaEarlyStage");
      sessionStorage.removeItem("qaEarlyInterrupt");
      globalThis.qaEarlyHoldPaint = false;
    });
    console.log("AI_EARLY_REFRESH_RECOVERED", stage);
  }
  await ui.getByTitle("新建会话", { exact: true }).click();
  await ui.waitForFunction(async (scope) => {
    const result = await chrome.runtime.sendMessage({
      type: "assistantSession",
      ...scope,
      operation: "get",
    });
    return result.ok && result.value.sessionId === null;
  }, assistantScope);
  await source.bringToFront();
  await ui.fill(
    '.ai-composer [contenteditable="true"]',
    "请介绍故障排查的步骤，只在对话里回答。",
  );
  await ui.evaluate(() => {
    globalThis.qaHoldAcceptedMessage = true;
  });
  await ui.evaluate(() =>
    document.querySelector('button[aria-label="发送"]').click(),
  );
  await ui.waitForFunction(() => globalThis.qaAcceptedMessageHeld === true);
  console.log("AI_POST_ACCEPTED_RESPONSE_HELD");
  const acceptedMessage = await ui.evaluate(() =>
    JSON.parse(sessionStorage.getItem("qaAcceptedMessage")),
  );
  const pendingBeforeLostReply = await ui.evaluate(
    async ({ scope, id }) =>
      (await globalThis.qaPendingProbe(scope)).find(
        (entry) => entry.messageId === id,
      ),
    { scope: pendingScope, id: acceptedMessage.id },
  );
  assert.equal(pendingBeforeLostReply.state, "pending");
  assert.equal(pendingBeforeLostReply.recordVersion, 1);
  assert.equal(pendingBeforeLostReply.item.id, acceptedMessage.id);
  assert.deepEqual(pendingBeforeLostReply.profile, {
    id: originalProfile,
    revision: 1,
  });
  const attemptsBeforeLostReplyReload = await ui.evaluate(() =>
    globalThis.qaDeliveryAttempts(),
  );
  const responsesBeforeLostReplyReload = earlySendResponses.length;
  const requestsBeforeLostReplyReload = aiUiRequests.length;
  // Simulate closing/reopening after the backend accepted the POST but before its
  // response reaches React. History must restore it without another model job.
  await ui.reload();
  await source.bringToFront();
  console.log("AI_PANEL_RELOADED");
  try {
    await ui.waitForFunction(
      () =>
        document
          .querySelector(".ai-messages")
          ?.innerText.includes(
            "这是模拟 AI 的回答，用于验证会话、页面和积分。",
          ),
      null,
      { timeout: 20000 },
    );
  } catch (error) {
    await ui.screenshot({
      path: artifact("assistant-failure.png"),
      fullPage: true,
    });
    console.log("ASSISTANT_BODY", await ui.locator("body").innerText());
    throw error;
  }
  await ui.waitForFunction(
    async ({ scope, id }) =>
      (await globalThis.qaPendingProbe(scope)).some(
        (entry) =>
          entry.messageId === id &&
          entry.state === "accepted" &&
          entry.serverJobId === id,
      ),
    { scope: pendingScope, id: acceptedMessage.id },
    { polling: 100, timeout: 20000 },
  );
  const acceptedAfterLostReply = await ui.evaluate(
    async ({ scope, id }) =>
      (await globalThis.qaPendingProbe(scope)).find(
        (entry) => entry.messageId === id,
      ),
    { scope: pendingScope, id: acceptedMessage.id },
  );
  assert.equal(acceptedAfterLostReply.recordVersion, 1);
  assert.equal(acceptedAfterLostReply.serverJobId, acceptedMessage.id);
  assert.equal(
    acceptedAfterLostReply.sessionId,
    pendingBeforeLostReply.sessionId,
  );
  assert.deepEqual(
    acceptedAfterLostReply.profile,
    pendingBeforeLostReply.profile,
  );
  assert.deepEqual(acceptedAfterLostReply.item, pendingBeforeLostReply.item);
  assert.equal(
    acceptedAfterLostReply.payloadHash,
    pendingBeforeLostReply.payloadHash,
  );
  assert.equal(acceptedAfterLostReply.source, undefined);
  assert.deepEqual(
    await ui.evaluate(() => globalThis.qaDeliveryAttempts()),
    attemptsBeforeLostReplyReload,
    "Accepted-reply recovery must not even attempt another capture or message POST",
  );
  assert.equal(
    earlySendResponses.length,
    responsesBeforeLostReplyReload,
    "Accepted-reply recovery makes zero new capture/message POSTs",
  );
  assert(
    aiUiRequests
      .slice(requestsBeforeLostReplyReload)
      .some(
        (request) =>
          request.method === "GET" &&
          request.url.includes(`pendingId=${acceptedMessage.id}`),
      ),
    "The active sender must prove acceptance by readonly pendingId reconciliation",
  );
  assert.equal(
    await ui.evaluate((key) => localStorage.getItem(key), legacyKey),
    legacyRaw,
    "All IDB sends and reconciliation preserve the original legacy bytes",
  );
  const acceptedReplyLostRecovery = {
    messageId: acceptedMessage.id,
    indexedDBAcceptedTombstone: true,
    serverJobId: acceptedAfterLostReply.serverJobId,
    exactPendingReconciliation: true,
    capturesAfterRefresh: 0,
    messagePostsAfterRefresh: 0,
    captureAttemptsAfterRefresh: 0,
    legacyBytesPreserved: true,
  };
  const recovered = await ui.evaluate(async ({ path, id }) => {
    const { value: current } = await chrome.runtime.sendMessage({
      type: "state",
    });
    const response = await chrome.runtime.sendMessage({
      type: "assistantRequest",
      origin: current.origin,
      connectionId: current.connectionId,
      path: path.replace(/\/messages$/, `?pendingId=${id}`),
      method: "GET",
    });
    return response.value;
  }, acceptedMessage);
  console.log("AI_RESPONSE_RECOVERED");
  assert.equal(
    recovered.messages.filter(
      (message) => message.id === acceptedMessage.id && message.role === "user",
    ).length,
    1,
  );
  assert.equal(
    recovered.jobs.filter((job) => job.id === acceptedMessage.id).length,
    1,
  );
  await ui.locator(".ai-messages h2").filter({ hasText: "排查建议" }).waitFor();
  assert.equal(
    await ui.locator(".ai-messages h2").filter({ hasText: "排查建议" }).count(),
    1,
  );
  assert.equal(await ui.locator(".ai-messages table").count(), 1);
  assert(
    (await ui.locator(".ai-messages code").allTextContents()).some((text) =>
      text.includes("检查接线"),
    ),
  );
  const defaultSessionId = recovered.session.id;
  await ui.locator("#ai-profile").locator("..").getByRole("combobox").click();
  await ui.getByRole("option", { name: "排查摘录", exact: true }).click();
  console.log("AI_OTHER_PROFILE_SELECTED");
  await ui
    .getByRole("combobox", { name: "选择 AI 模型", exact: true })
    .waitFor();
  assert.equal(
    await ui.locator(".ai-messages h2").count(),
    0,
    "another profile does not show the default profile conversation",
  );
  await ui.reload();
  await ui.waitForFunction(
    (id) => document.querySelector("#ai-profile").value === id,
    process.env.DOCA_QA_APPEND,
  );
  assert.equal(
    await ui.locator("#ai-profile").inputValue(),
    process.env.DOCA_QA_APPEND,
  );
  await ui.locator("#ai-profile").locator("..").getByRole("combobox").click();
  await ui
    .getByRole("option", { name: "故障案例 · 默认", exact: true })
    .click();
  console.log("AI_DEFAULT_PROFILE_RESELECTED");
  await ui.getByRole("button", { name: "会话列表", exact: true }).click();
  await ui
    .locator(".ai-session-list .ai-session-title")
    .filter({ hasText: "浏览器助手" })
    .first()
    .click();
  await ui
    .locator(".ai-messages h2")
    .filter({ hasText: "排查建议" })
    .waitFor({ state: "attached" });
  const restoredSession = await ui.evaluate(async () => {
    const { value: current } = await chrome.runtime.sendMessage({
      type: "state",
    });
    return (
      await chrome.runtime.sendMessage({
        type: "assistantSession",
        operation: "get",
        origin: current.origin,
        connectionId: current.connectionId,
        profileId: document.querySelector("#ai-profile").value,
      })
    ).value;
  });
  assert.equal(restoredSession.sessionId, defaultSessionId);
  await ui.getByRole("button", { name: "会话列表", exact: true }).click();
  await ui.locator(".ai-messages h2").filter({ hasText: "排查建议" }).waitFor();
  await source.bringToFront();
  await ui.fill(
    '.ai-composer [contenteditable="true"]',
    "请把当前页面收录，先让我确认。",
  );
  await ui.evaluate(() =>
    document.querySelector('button[aria-label="发送"]').click(),
  );
  await ui.locator(".ai-approval-card").waitFor();
  await ui
    .locator(".ai-approval-card")
    .evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
  const approvalText = await ui.locator(".ai-approval-card").innerText();
  assert(
    approvalText.includes("故障知识库"),
    "approval identifies the actual capture destination",
  );
  assert(
    approvalText.includes("设备启动故障排查"),
    "approval identifies the actual document title",
  );
  assert(
    !approvalText.includes("{items}"),
    "approval does not expose an unresolved template variable",
  );
  await ui.screenshot({
    path: artifact("extension-assistant-approval.png"),
    fullPage: true,
  });
  await ui
    .locator(".ai-approval-card")
    .getByRole("button", { name: /拒\s*绝/ })
    .click();
  await ui.locator(".ai-approval-card").waitFor({ state: "hidden" });
  const rejectedApproval = await ui.evaluate(async (id) => {
    const { value: current } = await chrome.runtime.sendMessage({
      type: "state",
    });
    return (
      await chrome.runtime.sendMessage({
        type: "assistantRequest",
        origin: current.origin,
        connectionId: current.connectionId,
        path: `/assistant/ui/sessions/${id}`,
        method: "GET",
      })
    ).value;
  }, defaultSessionId);
  assert(
    rejectedApproval.jobs.some((job) =>
      job.progress?.approvals?.some(
        (approval) => approval.state === "rejected",
      ),
    ),
    "rejection persisted on the actual AI job",
  );
  // Locale changes come from the settings page and update the mounted shared UI.
  await ui.click("#settings");
  await ui.locator("#locale").locator("..").getByRole("combobox").click();
  await ui.getByRole("option", { name: "English", exact: true }).click();
  await ui.waitForFunction(() => document.documentElement.lang === "en");
  await ui.click("#back");
  await ui
    .getByRole("combobox", { name: "Select AI model", exact: true })
    .waitFor();
  assert(
    (await ui.locator(".ai-browser-page-context").innerText()).includes(
      "设备启动故障排查",
    ),
  );
  await ui.screenshot({
    path: artifact("extension-assistant-en.png"),
    fullPage: true,
  });
  await ui.click("#settings");
  await ui.locator("#locale").locator("..").getByRole("combobox").click();
  await ui.getByRole("option", { name: "中文", exact: true }).click();
  await ui.waitForFunction(() => document.documentElement.lang === "zh-CN");
  await ui.click("#back");
  await ui
    .getByRole("combobox", { name: "选择 AI 模型", exact: true })
    .waitFor();
  const normalAssistantFailures = await ui.evaluate(
    () => globalThis.qaRuntimeFailures,
  );
  console.log("ASSISTANT_RUNTIME_FAILURES", normalAssistantFailures);
  assert.deepEqual(
    normalAssistantFailures,
    [],
    "normal shared AI startup and first send must not fail",
  );
  assert.equal(
    await ui.locator(".ai-composer .ant-alert-error").count(),
    0,
    "normal conversation has no stale error banner",
  );
  await ui.screenshot({
    path: artifact("extension-assistant.png"),
    fullPage: true,
  });
  await ui.setViewportSize({ width: 300, height: 850 });
  await ui.screenshot({ path: artifact("extension-assistant-narrow.png") });
  await ui.setViewportSize({ width: 620, height: 1000 });
  const uiCDP = await context.newCDPSession(ui);
  await ui.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoom(tab.id, 2);
  });
  await ui.screenshot({ path: artifact("extension-assistant-200.png") });
  await ui.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoom(tab.id, 1);
  });
  await ui.setViewportSize({ width: 410, height: 850 });
  await settings
    .getByRole("button", { name: "下载已配置扩展", exact: true })
    .waitFor();
  await settings.getByRole("tab", { name: "浏览器连接", exact: true }).click();
  await settings.getByText("Doca Browser", { exact: true }).waitFor();
  await settings.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await settings.screenshot({
    path: artifact("doca-connections.png"),
    fullPage: true,
  });
  await settings.setViewportSize({ width: 720, height: 960 });
  await settings.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await settings.screenshot({
    path: artifact("doca-connections-narrow.png"),
    fullPage: true,
  });
  // The public site config contains no account credential. An invalid config keeps the site.
  const replacement = JSON.stringify({
    version: 2,
    origin: "http://localhost:39646",
  });
  await ui.click("#settings");
  await ui.locator("#advanced-config summary").click();
  await ui.fill("#config", '{"version":1}');
  await ui.locator("#configure button[type=submit]").click();
  await ui
    .getByText("配置格式无效或版本不支持，原站点配置已保留。", { exact: true })
    .waitFor();
  const retained = await ui.evaluate(
    async () => await chrome.runtime.sendMessage({ type: "state" }),
  );
  assert(retained.value.connected);
  await ui.fill("#config", replacement);
  await ui.locator("#configure button[type=submit]").click();
  await verifyConnectedConfiguration();
  await worker.evaluate(async () => {
    // Expire a settled grant. Overwriting a new grant while its login callback is
    // still completing tests an artificial storage mutation, not time expiry.
    const deadline = Date.now() + 20000;
    while (
      typeof globalThis.finishDocaLogin === "function" ||
      (await chrome.storage.session.get("loginFlow")).loginFlow
    ) {
      if (Date.now() >= deadline)
        throw Error(
          "Website authorization did not finish before expiry injection",
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const auth = (await chrome.storage.session.get("authorization"))
      .authorization;
    if (!auth || Date.parse(auth.expiresAt) <= Date.now())
      throw Error("Expiry injection requires an active, settled grant");
    globalThis.qaPreviousConnection = auth;
    await chrome.storage.session.set({
      authorization: { ...auth, expiresAt: "2000-01-01T00:00:00Z" },
    });
  });
  const renewed = await ui.evaluate(
    async () =>
      await chrome.runtime.sendMessage({ type: "state", interactive: true }),
  );
  if (!renewed.value?.connected) {
    console.log("RENEWAL_DEBUG", {
      renewed,
      shell: await ui.evaluate(() => ({
        replies: globalThis.qaStateReplies.slice(-12),
        failures: globalThis.qaRuntimeFailures,
      })),
      background: await worker.evaluate(async () => {
        const values = await chrome.storage.session.get([
          "authorization",
          "loginFlow",
          "loginRequired",
          "lastError",
          "websiteProofAt",
          "cookieProbeUnsupported",
        ]);
        return {
          authorization: values.authorization && {
            expiresAt: values.authorization.expiresAt,
            origin: values.authorization.origin,
            connectionId: values.authorization.connectionId,
          },
          loginFlow: values.loginFlow && {
            interactive: values.loginFlow.interactive,
            expiresAt: values.loginFlow.expiresAt,
            tabId: values.loginFlow.tabId,
          },
          loginRequired: values.loginRequired,
          lastError: values.lastError,
          websiteProofAt: values.websiteProofAt,
          cookieProbeUnsupported: values.cookieProbeUnsupported,
        };
      }),
    });
  }
  assert(
    renewed.value.connected,
    "Short token renews through the signed-in website without prompting",
  );
  const oldStatus = await worker.evaluate(async () => {
    const previous = globalThis.qaPreviousConnection;
    const response = await fetch(
      previous.origin + "/api/v1/browser-clipper/me",
      {
        headers: { Authorization: "Bearer " + previous.token },
        credentials: "omit",
      },
    );
    delete globalThis.qaPreviousConnection;
    return response.status;
  });
  assert.equal(oldStatus, 401);
  const logout = await settings.evaluate(
    async () =>
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((response) => response.status),
  );
  assert.equal(logout, 200);
  const loggedOut = await ui.evaluate(
    async () => await chrome.runtime.sendMessage({ type: "state" }),
  );
  assert(!loggedOut.value.connected);
  assert.equal(loggedOut.value.error, "clipper_login_required");
  await ui.bringToFront();
  await ui.locator("#connection-pane:not([hidden])").waitFor();
  await ui.waitForFunction(
    () => !document.querySelector("#identity").textContent.includes("验收账户"),
  );
  assert.equal(await ui.locator("#assistant-root .ai-chat").count(), 0);
  const reconnect = ui.evaluate(
    async () => await chrome.runtime.sendMessage({ type: "login" }),
  );
  void reconnect.catch(() => {});
  await loginPage();
  assert((await reconnect).value.connected);
  const ownerState = (
    await ui.evaluate(
      async () => await chrome.runtime.sendMessage({ type: "state" }),
    )
  ).value;
  await ui.getByText("浏览器验收账户", { exact: true }).waitFor();
  await worker.evaluate(
    async (owner) =>
      chrome.storage.session.set({
        pending: {
          origin: owner.origin,
          connectionId: owner.connectionId,
          requestId: "unsent-owner-material",
        },
      }),
    ownerState,
  );
  await settings.evaluate(async () =>
    fetch("/api/v1/auth/logout", { method: "POST" }),
  );
  const secondLogin = ui.evaluate(
    async () => await chrome.runtime.sendMessage({ type: "login" }),
  );
  void secondLogin.catch(() => {});
  await loginPage("clipperqasecond");
  const second = (await secondLogin).value;
  assert(second.connected && second.user.name === "第二个验收账户");
  assert(!second.pending);
  assert.notEqual(second.connectionId, ownerState.connectionId);
  await ui.reload();
  try {
    await ui.getByText("第二个验收账户", { exact: true }).waitFor();
  } catch (error) {
    await ui.screenshot({
      path: artifact("account-switch-failure.png"),
      fullPage: true,
    });
    console.log("SECOND_ACCOUNT_BODY", await ui.locator("body").innerText());
    console.log(
      "SECOND_ACCOUNT_STATE_REPLIES",
      await ui.evaluate(() => globalThis.qaStateReplies),
    );
    console.log(
      "SECOND_ACCOUNT_STATE",
      await ui.evaluate(
        async () => (await chrome.runtime.sendMessage({ type: "state" })).value,
      ),
    );
    throw error;
  }
  await settings.evaluate(async () =>
    fetch("/api/v1/auth/logout", { method: "POST" }),
  );
  const ownerLogin = ui.evaluate(
    async () => await chrome.runtime.sendMessage({ type: "login" }),
  );
  void ownerLogin.catch(() => {});
  await loginPage();
  const restored = (await ownerLogin).value;
  assert(restored.connected && restored.pending);
  assert.equal(restored.connectionId, ownerState.connectionId);
  await worker.evaluate(async () => chrome.storage.session.remove("pending"));
  await ui.reload();
  await ui
    .getByText("浏览器验收账户", { exact: true })
    .waitFor({ timeout: 60000 });
  await ui.click("#settings");
  await ui.fill("#endpoint", "http://localhost:39646/api/v1");
  await ui.locator("#endpoint-form button").click();
  await ui
    .getByText("请输入 HTTPS 的 Doca 根地址，本机开发可用 HTTP。", {
      exact: true,
    })
    .waitFor();
  await ui.fill("#endpoint", "http://localhost:39646/");
  await ui.locator("#endpoint-form button").click();
  await verifyConnectedConfiguration();
  await ui.screenshot({
    path: artifact("extension-connection.png"),
    fullPage: true,
  });
  // Logging out may have redirected this old platform tab to its login route.
  await settings.goto("http://localhost:39646/#/browser-assistant", {
    waitUntil: "domcontentloaded",
  });
  await settings.getByRole("tab", { name: "浏览器连接", exact: true }).click();
  await settings
    .getByRole("button", { name: "撤销全部连接", exact: true })
    .click();
  await settings.getByRole("button", { name: "撤销授权", exact: true }).click();
  await settings.getByText("浏览器授权已撤销", { exact: true }).waitFor();
  const revoked = await ui.evaluate(
    async () => await chrome.runtime.sendMessage({ type: "state" }),
  );
  assert(revoked.ok && !revoked.value.connected);
  assert.equal(revoked.value.error, "clipper_connection_revoked");
  await ui.waitForFunction(
    () => !document.querySelector("#identity").textContent.includes("验收账户"),
  );
  await ui.locator("#connection-pane:not([hidden])").waitFor();
  const rejected = await ui.evaluate(
    async ({ tabId, profileId }) =>
      await chrome.runtime.sendMessage({
        type: "capture",
        mode: "page",
        tabId,
        profileId,
        profileRevision: 1,
      }),
    { tabId: sourceTab.id, profileId: process.env.DOCA_QA_PROFILE },
  );
  assert(!rejected.ok);
  assert.equal(rejected.error, "clipper_connection_revoked");
  await firstReplica.reload();
  await waitBody(firstReplica, "接线端子松动");
  let websiteRuntime = { mode: webMode };
  if (webMode === "production-build") {
    assert(firstBuiltDocumentRead, "A compiled website document was loaded");
    const document = await firstBuiltDocumentRead;
    assert.equal(document.indexSha256, expectedWebIndexSha256);
    assert.deepEqual([...developmentSourceRequests], []);
    assert(
      compiledScriptRequests.size > 0,
      "The website loaded compiled JS assets",
    );
    websiteRuntime = {
      mode: webMode,
      document,
      compiledScriptRequests: [...compiledScriptRequests].sort(),
      developmentSourceRequests: [],
    };
  }
  const report = {
    status: "passed",
    websiteRuntime,
    runtime:
      "Native macOS Chrome for Testing; direct localhost; isolated profile",
    extensionVersion: await worker.evaluate(
      () => chrome.runtime.getManifest().version,
    ),
    browserVersion: context.browser()?.version(),
    followsWebsiteLogin: true,
    loginPromptAndReturn: true,
    earlyInlineAuthorizationCallbackDelivered: true,
    websiteLogoutDisconnects: true,
    liveShellDisconnectAndReconnect: true,
    accountSwitchIsolatesDrafts: true,
    editableServerAddress: true,
    automaticShortTokenRenewal: true,
    expiryInjectedAfterAuthorizationSettled: true,
    selectionToolbar: true,
    collapsedLauncherAndExpansion: true,
    customDropdownSwitching: true,
    defaultProfilePreselected: true,
    automaticPageReference: true,
    popupCaptureHome: true,
    popupSelectionCapture: true,
    popupDoesNotInitializeAI: true,
    settingsIconAndReturn: true,
    aiEntryOpensNativeSidePanel: true,
    selectedProfilePassedToSidePanel: true,
    languageUpdatesSharedAssistant: true,
    nativeSidePanelInspection,
    aiEntryRequiresExplicitSend: true,
    nativeGlobalShortcuts: "unit-tested dispatch; OS key routing not simulated",
    responsiveScreenshots: [300, 390, 410],
    zoomScreenshot: "200%",
    motionFrames: [
      "selection-launcher",
      "selection-expand",
      "selection-dropdown",
    ].flatMap((prefix) =>
      ["start", "middle", "end"].map((phase) => `${prefix}-${phase}.png`),
    ),
    downloadThroughSettings: true,
    accountMenuAfterMcpAndAligned: true,
    wholePage: true,
    originalImageTransfer: true,
    appendBroadcastToTwoReplicas: true,
    assistantConversation: true,
    quickNotes: quickNoteReport,
    earlyRefreshRecovery,
    acceptedReplyLostRecovery,
    acceptedResponseLossReloadRestoresOneJob: true,
    profileConversationIsolationAndReload: true,
    sharedMarkdownHeadingTableAndCode: true,
    sharedApprovalRejectionWithoutCapture: true,
    approvalShowsFrozenDocumentAndDestination: true,
    publicSiteConfiguration: true,
    invalidConfigPreservesConnection: true,
    keyRotationRejectsOldToken: true,
    revokeAllThroughSettings: true,
    oldTokenRejected: true,
    savedDocumentRetained: true,
    pageErrors: errors,
  };
  await writeFile(
    artifact("browser-report.json"),
    JSON.stringify(report, null, 2),
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report));
} catch (error) {
  try {
    const shells = [];
    for (const page of context.pages()) {
      if (!/^(chrome-extension:|http:\/\/localhost:)/.test(page.url()))
        continue;
      shells.push({
        origin: new URL(page.url()).origin,
        hash: new URL(page.url()).hash.split("?")[0],
        body: (await page.locator("body").innerText()).slice(0, 8000),
        runtime: await page.evaluate(async () => ({
          readyState: document.readyState,
          failures: globalThis.qaRuntimeFailures,
          replies: globalThis.qaStateReplies?.slice(-12),
          trace: globalThis.qaRuntimeTrace?.slice(-40),
          quickNotes: globalThis.qaQuickNoteCalls?.map((entry) => ({
            type: entry.message.type,
            requestId: entry.message.requestId,
            profileId: entry.message.profileId,
            started: entry.started,
            finished: entry.finished,
            ok: entry.result?.ok,
            error: entry.result?.error,
            status: entry.result?.status,
          })),
          early: globalThis.qaDeliveryAttempts && {
            stage: sessionStorage.getItem("qaEarlyStage"),
            interrupt: sessionStorage.getItem("qaEarlyInterrupt"),
            holdPaint: globalThis.qaEarlyHoldPaint,
            resumeHeld: sessionStorage.getItem("qaEarlyResumeHeld"),
            resumeWaiting: globalThis.qaEarlyResumeWaiting,
            attempts: globalThis.qaDeliveryAttempts(),
            locks: await navigator.locks.query(),
          },
        })),
      });
      await page.screenshot({ path: artifact("current-failure.png") });
    }
    const diagnostic = {
      error: error.message,
      earlySendResponses,
      background: await context.serviceWorkers()[0]?.evaluate(async () => {
        const stored = await chrome.storage.session.get([
          "authorization",
          "loginFlow",
          "loginRequired",
          "lastError",
          "websiteProofAt",
          "cookieProbeUnsupported",
        ]);
        return {
          authorization: stored.authorization && {
            origin: stored.authorization.origin,
            connectionId: stored.authorization.connectionId,
            expiresAt: stored.authorization.expiresAt,
          },
          flow: stored.loginFlow && {
            tabId: stored.loginFlow.tabId,
            interactive: stored.loginFlow.interactive,
            expiresAt: stored.loginFlow.expiresAt,
          },
          loginRequired: stored.loginRequired,
          lastError: stored.lastError,
          websiteProofAt: stored.websiteProofAt,
          cookieProbeUnsupported: stored.cookieProbeUnsupported,
          finishCallbackInstalled:
            typeof globalThis.finishDocaLogin === "function",
          unfinishedFetches: globalThis.qaFetchTrace?.filter(
            (entry) =>
              !entry.headersAt || (entry.jsonStartedAt && !entry.jsonAt),
          ),
          trace: globalThis.qaFetchTrace?.slice(-50),
        };
      }),
      apiResponses,
      failedResponses,
      failedRequests,
      pendingRequests: [...pendingRequests.values()].map(
        ({ started, ...request }) => ({
          ...request,
          elapsed: Date.now() - started,
        }),
      ),
      shells,
      errors,
    };
    await writeFile(
      artifact("failure-diagnostic.json"),
      JSON.stringify(diagnostic, null, 2),
    );
    console.log("BROWSER_FAILURE_DIAGNOSTIC", JSON.stringify(diagnostic));
  } catch (diagnosticError) {
    console.log("FAILURE_DIAGNOSTIC_UNAVAILABLE", diagnosticError.message);
  }
  throw error;
} finally {
  await context.close();
}
