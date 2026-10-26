import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import {
  prepareCaptureImage,
  readCaptureImageResponse,
  MAX_IMAGE_SOURCE_BYTES,
  captureImageInfo,
} from "../apps/browser-extension/image-processing.js";
// @ts-expect-error extension catalogs are runtime-only JavaScript.
import { translate } from "../apps/browser-extension/messages.js";
const source = (
  await readFile(
    new URL("../apps/browser-extension/background.js", import.meta.url),
    "utf8",
  )
)
  .replace(/^import \{[\s\S]*?\} from "\.\/image-processing\.js";\n/, "")
  .replace(/^import \{ translate \} from "\.\/messages\.js";\n/m, "");
const origin = "https://doca.example.test",
  connectionId = randomUUID();
const config = {
  version: 2,
  origin,
  connectionId,
  token: "doca_browser_v2_" + "1".repeat(64),
  expiresAt: "2099-01-01T00:00:00Z",
};
function runtime() {
  const local: Record<string, any> = {
      site: { version: 2, origin },
      installationId: randomUUID(),
    },
    session: Record<string, any> = { authorization: { ...config } };
  const area = (values: Record<string, any>) => ({
    setAccessLevel: async () => {},
    get: async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]),
      ),
    set: async (next: any) => Object.assign(values, next),
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  });
  const context = vm.createContext({
    prepareCaptureImage,
    readCaptureImageResponse,
    MAX_IMAGE_SOURCE_BYTES,
    captureImageInfo,
    translate,
    URL,
    crypto: {
      randomUUID,
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: webcrypto.subtle,
    },
    TextEncoder,
    TextDecoder,
    AbortSignal,
    Blob,
    atob,
    btoa,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    chrome: {
      storage: { local: area(local), session: area(session) },
      runtime: {
        id: "fixture",
        getManifest: () => ({ version: "0.2.7" }),
        getURL: (path: string) => "chrome-extension://fixture/" + path,
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
      },
      tabs: { query: async () => [] },
      commands: { onCommand: { addListener() {} } },
      action: {
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {},
        setTitle: async () => {},
      },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        items: [],
        user: { id: "fixture" },
        connection: { assistant_enabled: 1 },
      }),
    }),
  });
  vm.runInContext(source, context);
  return {
    context,
    local,
    session,
    handle: (message: any, sender: any) => context.handle(message, sender),
  };
}
it("rebuilds an expired capture once without changing its source, images, account or profile", async () => {
  const r = runtime(), oldId = randomUUID();
  const pending = { requestId: oldId, origin, connectionId, profileId: randomUUID(), profileRevision: 3, tabId: 7, capture: { mode: "selection", url: "https://source.test/original", markdown: "Frozen original", images: [{ id: randomUUID(), url: "https://source.test/figure.png" }] } };
  r.session.pending = pending;
  const prepared: any[] = [], commits: string[] = [];
  r.context.prepare = async (value: any) => {
    prepared.push(structuredClone(value));
    if (prepared.length === 1) throw Object.assign(Error("clipper_capture_expired"), { status: 410 });
  };
  r.context.request = async (path: string) => { commits.push(path); return { href: "/#/r/saved", warnings: [] }; };
  const result = await r.context.submit(pending);
  expect(result.url).toBe(origin + "/#/r/saved");
  expect(prepared).toHaveLength(2);
  expect(prepared[1].requestId).not.toBe(oldId);
  expect(prepared[1]).toEqual({ ...prepared[0], requestId: prepared[1].requestId });
  expect(commits).toEqual([`/clips/${prepared[1].requestId}/commit`]);
  expect(r.session.pending).toBeUndefined();
});
it.each(["again", "account", "newer capture", "quota"])("does not loop or overwrite another capture when expiry recovery meets %s", async change => {
  const r = runtime(), pending = { requestId: randomUUID(), origin, connectionId, capture: { markdown: "Frozen", images: [] } };
  r.session.pending = pending;
  let calls = 0;
  r.context.prepare = async () => {
    calls++;
    if (change === "account") r.session.authorization = { ...config, connectionId: randomUUID() };
    if (change === "newer capture") r.session.pending = { requestId: "newer" };
    throw Object.assign(Error(change === "quota" ? "clipper_too_many_pending" : "clipper_capture_expired"), { status: change === "quota" ? 429 : 410 });
  };
  await expect(r.context.submit(pending)).rejects.toThrow();
  expect(calls).toBe(change === "again" ? 2 : 1);
  if (change === "newer capture") expect(r.session.pending).toEqual({ requestId: "newer" });
  if (change === "quota") expect(r.session.pending).toEqual(pending);
});
it("rebuilds an idle AI attachment once while retaining the exact selected material", async () => {
  const r = runtime(), profileId = randomUUID(), requestId = randomUUID();
  const pending = { requestId, origin, connectionId, profileId, profileRevision: 1, tabId: 7, capture: { mode: "selection", title: "Frozen selection", url: "https://source.test/original", markdown: "Original selected text", images: [] } };
  r.session.assistantPending = pending;
  r.session.pending = pending;
  r.context.ensureLogin = async () => config;
  r.context.chrome.tabs.get = async () => ({ id: 7, url: pending.capture.url });
  const prepared: any[] = [];
  r.context.prepare = async (value: any) => {
    prepared.push(structuredClone(value));
    if (prepared.length === 1) throw Object.assign(Error("clipper_capture_expired"), { status: 410 });
  };
  const result = await r.handle({ type: "assistantPreparePage", origin, connectionId, profileId, profileRevision: 1, tabId: 7 }, { id: "fixture", url: "chrome-extension://fixture/ui.html#assistant" });
  expect(result.captureRequestId).not.toBe(requestId);
  expect(prepared).toHaveLength(2);
  expect(prepared[1].capture).toEqual(pending.capture);
  expect(r.session.assistantPending.requestId).toBe(result.captureRequestId);
  expect(r.session.pending.requestId).toBe(result.captureRequestId);
});
it("checks the configured site's package numerically without login or pending-data writes", async () => {
  const r = runtime();
  delete r.session.authorization;
  r.session.pending = { requestId: randomUUID(), markdown: "unsent" };
  r.session.lastError = "existing error";
  const before = JSON.stringify({ local: r.local, session: r.session });
  r.context.chrome.runtime.getManifest = () => ({ version: "0.2.9" });
  const requests: any[] = [];
  let latest = "0.2.10";
  r.context.fetch = async (url: string, options: any) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        version: latest,
        filename: `doca-browser-assistant-${latest}.zip`,
      }),
    };
  };
  const sender = {
    id: "fixture",
    url: "chrome-extension://fixture/ui.html#settings",
  };
  await expect(
    r.handle({ type: "checkForUpdates" }, sender),
  ).resolves.toMatchObject({
    status: "available",
    currentVersion: "0.2.9",
    latestVersion: "0.2.10",
    downloadUrl: origin + "/#/browser-assistant",
  });
  latest = "0.2.9.0";
  expect((await r.handle({ type: "checkForUpdates" }, sender)).status).toBe(
    "current",
  );
  latest = "0.2.8";
  expect((await r.handle({ type: "checkForUpdates" }, sender)).status).toBe(
    "ahead",
  );
  expect(
    requests.every(
      ({ url, options }) =>
        url === origin + "/api/v1/browser-clipper/release" &&
        options.credentials === "omit" &&
        options.redirect === "error" &&
        !options.headers,
    ),
  ).toBe(true);
  expect(JSON.stringify({ local: r.local, session: r.session })).toBe(before);
  await expect(
    r.handle(
      { type: "checkForUpdates" },
      { id: "fixture", url: "https://source.test", tab: { id: 7 }, frameId: 0 },
    ),
  ).rejects.toThrow("clipper_scope_denied");
});

it("reports missing or invalid release metadata and network failures as failed checks", async () => {
  const r = runtime();
  for (const response of [
    { ok: false, status: 404 },
    { ok: true, json: async () => ({}) },
    {
      ok: true,
      json: async () => ({
        version: "65536.1",
        filename: "doca-browser-assistant-65536.1.zip",
      }),
    },
    {
      ok: true,
      json: async () => ({
        version: "0.2.10",
        filename: "https://other.test/package.zip",
      }),
    },
    null,
  ]) {
    r.context.fetch = async () => {
      if (!response) throw Error("network offline");
      return response;
    };
    await expect(r.context.checkForUpdates()).resolves.toEqual({
      status: "failed",
      currentVersion: "0.2.7",
      origin,
    });
  }
  delete r.local.site;
  r.context.boot = async () => {};
  await expect(r.context.checkForUpdates()).resolves.toEqual({
    status: "unconfigured",
    currentVersion: "0.2.7",
  });
});

it("opens standalone settings from a trusted top-frame page without requiring login", async () => {
  const r = runtime();
  delete r.session.authorization;
  const created: unknown[] = [];
  r.context.chrome.tabs.create = async (input: unknown) => created.push(input);
  const sender = {
    id: "fixture",
    url: "https://source.test",
    tab: { id: 7 },
    frameId: 0,
  };
  await expect(r.handle({ type: "openSettings" }, sender)).resolves.toEqual({
    opened: true,
  });
  expect(created).toEqual([
    { url: "chrome-extension://fixture/ui.html#settings" },
  ]);
  await expect(
    r.handle({ type: "openSettings" }, { ...sender, frameId: 1 }),
  ).rejects.toThrow("clipper_scope_denied");
  await expect(
    r.handle({ type: "openSettings" }, { ...sender, id: "other" }),
  ).rejects.toThrow("clipper_scope_denied");
});

it("replaces incompatible images in place with source links, preserving valid images and frozen input", async () => {
  const r = runtime();
  const images = ["valid.png", "logo.svg", "bad.avif", "missing.png"].map(
    (name) => ({ id: randomUUID(), name, url: "https://source.test/" + name }),
  );
  const capture = {
    mode: "page",
    url: "https://source.test/article",
    markdown: images
      .map(
        (image) =>
          `![${image.name}](${"https://clipper.invalid/images/" + image.id})`,
      )
      .join("\n\n"),
    images,
  };
  const before = JSON.stringify(capture);
  r.context.bytes = async (image: any) => {
    if (image.name === "bad.avif") throw Error("clipper_image_invalid");
    if (image.name === "missing.png") throw Error("clipper_image_failed");
    const data = new Uint8Array([1, 2, 3]);
    r.context.cacheImage(image, data, image.name === "logo.svg");
    return data;
  };
  const result = await r.context.prepareCapture(capture, 7);
  expect(result.images.map((image: any) => image.name)).toEqual([
    "valid.png",
    "logo.png",
  ]);
  expect(result.markdown).toContain(
    `![logo.svg](https://clipper.invalid/images/${images[1]!.id})`,
  );
  expect(result.markdown).toContain(
    "[图片未保存：bad.avif（格式不支持或图片内容无效）](https://source.test/bad.avif)",
  );
  expect(result.markdown).toContain(
    "[图片未保存：missing.png（原图无法读取）](https://source.test/missing.png)",
  );
  expect(result.markdown).not.toContain(images[2]!.id);
  expect(JSON.stringify(capture)).toBe(before);
  r.local.locale = "en";
  expect((await r.context.prepareCapture(capture, 7)).markdown).toContain(
    "Image not saved: bad.avif (unsupported format or invalid image)",
  );
});

it("keeps escaped image labels safe and does not insert blob/data sources as permanent links", async () => {
  const r = runtime(),
    id = randomUUID();
  r.context.bytes = async () => {
    throw Error("clipper_image_invalid");
  };
  const result = await r.context.prepareCapture(
    {
      markdown: `before ![a\\]b](https://clipper.invalid/images/${id}) after`,
      images: [{ id, name: "bad.svg", url: "data:image/svg+xml,invalid" }],
    },
    7,
  );
  expect(result.images).toEqual([]);
  expect(result.markdown).toBe(
    "before 图片未保存：a\\]b（格式不支持或图片内容无效） after",
  );
  expect(result.markdown).not.toContain("data:");
});

it("degrades unexpected image conversion exceptions and returns only current in-memory diagnostics", async () => {
  const r = runtime(),
    id = randomUUID();
  r.context.bytes = async () => {
    throw TypeError("unexpected decoder exception");
  };
  const capture = await r.context.prepareCapture(
    {
      url: "https://source.test/article",
      capturedAt: "2026-10-26T00:00:00Z",
      markdown: `Before ![Figure](https://clipper.invalid/images/${id}) After`,
      images: [{ id, url: "https://source.test/f.png", name: "f.png" }],
    },
    7,
  );
  expect(capture.markdown).toContain("图片未保存：Figure（图片处理失败）");
  expect(capture.images).toEqual([]);
  const pending = { requestId: randomUUID(), origin, capture };
  r.context.prepare = async () => {};
  r.context.request = async () => ({
    href: "/#/r/saved",
    warnings: [
      { code: "format-degraded", message: "Formula preserved as source" },
    ],
  });
  const result = await r.context.submit(pending);
  expect(result.warnings).toEqual([
    { code: "imageProcessingFailed", message: "f.png: 图片处理失败" },
    { code: "format-degraded", message: "Formula preserved as source" },
  ]);
  expect(JSON.stringify(r.session)).not.toContain("warnings");
  expect(capture).not.toHaveProperty("warnings");
});

it("does not suppress authorization, quota or extension failures during preflight", async () => {
  const r = runtime();
  for (const code of [
    "clipper_scope_denied",
    "storage_quota_exceeded",
    "Extension context invalidated",
  ]) {
    r.context.bytes = async () => {
      throw Error(code);
    };
    await expect(
      r.context.prepareCapture(
        {
          markdown: "page",
          images: [
            {
              id: randomUUID(),
              url: "https://source.test/photo.png",
              name: "photo.png",
            },
          ],
        },
        7,
      ),
    ).rejects.toThrow(code);
  }
});

it("passes already-fetched SVG bytes to the source decoder and reuses the converted PNG", async () => {
  const r = runtime(),
    id = randomUUID();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const image = { id, url: "https://cdn.test/logo.svg", name: "logo.svg" };
  let reads = 0,
    decodes = 0;
  r.context.fetch = async () => {
    reads++;
    return new Response(svg);
  };
  r.context.chrome.tabs.sendMessage = async (tabId: number, message: any) => {
    expect(tabId).toBe(7);
    expect(message).toMatchObject({
      type: "image",
      id,
      url: image.url,
      convertSvg: true,
    });
    expect(atob(message.source)).toBe(svg);
    return { ok: true, value: png.toString("base64") };
  };
  r.context.createImageBitmap = async () => {
    decodes++;
    return { close() {} };
  };
  const result = await r.context.prepareCapture(
    {
      markdown: `![Logo](https://clipper.invalid/images/${id})`,
      images: [image],
    },
    7,
  );
  expect(result.images[0].name).toBe("logo.png");
  expect(Buffer.from(await r.context.bytes(result.images[0], 7))).toEqual(png);
  expect(reads).toBe(1);
  expect(decodes).toBe(1);
});

it("persists only a validated vertical dock position and leaves invalid stored data for review", async () => {
  const r = runtime();
  delete r.session.authorization;
  const sender = {
    id: "fixture",
    url: "https://source.test",
    tab: { id: 7 },
    frameId: 0,
  };
  await expect(
    r.handle({ type: "dockPreferences", operation: "get" }, sender),
  ).resolves.toEqual({ position: null, locale: "zh" });
  await expect(
    r.handle(
      { type: "dockPreferences", operation: "set", position: 0.25 },
      sender,
    ),
  ).resolves.toEqual({ position: 0.25, locale: "zh" });
  for (const position of [-1, 2, NaN, Infinity, "0.5", null])
    await expect(
      r.handle({ type: "dockPreferences", operation: "set", position }, sender),
    ).rejects.toThrow("clipper_invalid_input");
  expect(r.local.dockPosition).toBe(0.25);
  r.local.dockPosition = "invalid";
  await expect(
    r.handle({ type: "dockPreferences", operation: "get" }, sender),
  ).rejects.toThrow("clipper_invalid_input");
  expect(r.local.dockPosition).toBe("invalid");
});

it("recovers a missing capture receiver after navigation without reloading the page", async () => {
  const r = runtime();
  const capture = {
    mode: "page",
    url: "https://source.test/next",
    markdown: "Next page",
    images: [],
  };
  const calls: unknown[] = [];
  let installed = false;
  r.context.chrome.tabs.get = async (id: number) => ({ id, url: capture.url });
  r.context.chrome.tabs.sendMessage = async (
    id: number,
    message: unknown,
    options: unknown,
  ) => {
    calls.push({ id, message, options });
    if (!installed)
      throw Error(
        "Could not establish connection. Receiving end does not exist.",
      );
    return { ok: true, value: capture };
  };
  r.context.chrome.scripting = {
    executeScript: async (input: unknown) => {
      calls.push(input);
      installed = true;
    },
  };
  await expect(r.context.snapshot("page", 7)).resolves.toEqual({
    capture,
    tabId: 7,
  });
  expect(calls).toEqual([
    {
      id: 7,
      message: { type: "snapshot", mode: "page" },
      options: { frameId: 0 },
    },
    {
      target: { tabId: 7, frameIds: [0] },
      files: ["svg-image.js", "capture.js", "select.js", "content.js"],
      injectImmediately: true,
    },
    {
      id: 7,
      message: { type: "snapshot", mode: "page" },
      options: { frameId: 0 },
    },
  ]);
  await r.context.snapshot("page", 7);
  expect(calls).toHaveLength(4);
});

it("recovers when only an unrelated content listener responds with no capture", async () => {
  const r = runtime();
  const capture = {
    mode: "page",
    url: "https://source.test/next",
    markdown: "Next page",
    images: [],
  };
  r.context.chrome.tabs.get = async (id: number) => ({ id, url: capture.url });
  let installed = false;
  r.context.chrome.tabs.sendMessage = async () =>
    installed ? { ok: true, value: capture } : undefined;
  r.context.chrome.scripting = {
    executeScript: async () => {
      installed = true;
    },
  };
  await expect(r.context.snapshot("page", 7)).resolves.toEqual({
    capture,
    tabId: 7,
  });
});

it("does not reinstall scripts for a capture error or inject into restricted pages", async () => {
  const r = runtime();
  let injections = 0;
  r.context.chrome.scripting = {
    executeScript: async () => {
      injections++;
    },
  };
  r.context.chrome.tabs.get = async (id: number) => ({
    id,
    url: "https://source.test/next",
  });
  r.context.chrome.tabs.sendMessage = async () => ({
    ok: false,
    error: "clipper_selection_missing",
  });
  await expect(r.context.snapshot("selection", 7)).rejects.toThrow(
    "clipper_selection_missing",
  );
  expect(injections).toBe(0);
  r.context.chrome.tabs.get = async (id: number) => ({
    id,
    url: "chrome://settings",
  });
  await expect(r.context.snapshot("page", 7)).rejects.toThrow(
    "clipper_page_unsupported",
  );
  expect(injections).toBe(0);
});

it("stops after one recovery attempt when injection is denied or navigation loses the receiver again", async () => {
  for (const denied of [false, true]) {
    const r = runtime();
    let injections = 0,
      messages = 0;
    r.context.chrome.tabs.get = async (id: number) => ({
      id,
      url: "https://source.test/next",
    });
    r.context.chrome.tabs.sendMessage = async () => {
      messages++;
      throw Error("no receiver");
    };
    r.context.chrome.scripting = {
      executeScript: async () => {
        injections++;
        if (denied) throw Error("Cannot access contents of the page");
      },
    };
    await expect(r.context.snapshot("page", 7)).rejects.toThrow(
      "clipper_page_unsupported",
    );
    expect(injections).toBe(1);
    expect(messages).toBe(denied ? 1 : 2);
  }
});

it("recognizes extension UI opened in a tab and denies privileged page messages", async () => {
  const r = runtime(),
    ui = {
      id: "fixture",
      url: "chrome-extension://fixture/ui.html#assistant",
      tab: { id: 1 },
    };
  await expect(r.handle({ type: "assistantNew" }, ui)).resolves.toEqual({
    sessionId: null,
    jobs: [],
  });
  await expect(
    r.handle(
      { type: "assistantNew" },
      { ...ui, url: "https://source.example.test/" },
    ),
  ).rejects.toThrow("clipper_scope_denied");
  await expect(
    r.handle({ type: "state" }, { ...ui, id: "other" }),
  ).rejects.toThrow("clipper_scope_denied");
});
it("rejects unknown configuration without overwriting current credentials or material", async () => {
  const r = runtime();
  r.session.pending = { requestId: "unsent" };
  await expect(
    r.handle(
      { type: "configure", config: JSON.stringify({ version: 1, origin }) },
      { id: "fixture", url: "chrome-extension://fixture/ui.html" },
    ),
  ).rejects.toThrow("clipper_invalid_config");
  expect(r.local.site).toEqual({ version: 2, origin });
  expect(r.session.authorization).toEqual(config);
  expect(r.session.pending.requestId).toBe("unsent");
});
it("blocks a frozen task from being sent after switching accounts or origins", async () => {
  const r = runtime();
  await expect(
    r.context.request("/clips/" + randomUUID() + "/commit", "POST", {}, false, {
      origin: "https://other.example.test",
      connectionId,
    }),
  ).rejects.toThrow("clipper_scope_denied");
  await expect(r.context.request("/auth/me")).rejects.toThrow(
    "clipper_scope_denied",
  );
});
it("does not silently substitute the default profile when the selected profile disappeared", async () => {
  const r = runtime();
  await expect(r.context.begin({}, randomUUID(), 1, 1)).rejects.toThrow(
    "clipper_profile_unavailable",
  );
});

it("retries an assistant message with the frozen body without reading or uploading a newly active page", async () => {
  const r = runtime(),
    sessionId = randomUUID(),
    requestId = randomUUID(),
    profileId = randomUUID();
  r.session.assistant = { id: sessionId, origin, connectionId, profileId };
  const body = {
    id: requestId,
    modelId: "original-model",
    text: "original instruction",
    captureRequestId: randomUUID(),
  };
  r.session.assistantDraft = {
    origin,
    connectionId,
    requestId,
    sessionId,
    body,
  };
  let posted: any;
  r.context.fetch = async (_url: string, options: any) => {
    if (options.body) posted = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: requestId }) };
  };
  await r.handle(
    {
      type: "assistantSend",
      requestId,
      profileId,
      attachPage: true,
      modelId: "changed",
      text: "changed",
    },
    {
      id: "fixture",
      url: "chrome-extension://fixture/ui.html#assistant",
      tab: { id: 1 },
    },
  );
  expect(posted).toEqual(body);
  expect(r.session.assistantDraft).toBeUndefined();
});

it("keeps drafts isolated when the website signs in as another account", async () => {
  const r = runtime();
  r.session.pending = { requestId: "account-a" };
  const other = { ...config, connectionId: randomUUID(), userId: randomUUID() };
  await r.context.rememberAuthorization(other);
  expect(r.session.pending).toBeNull();
  await r.context.rememberAuthorization(config);
  expect(r.session.pending.requestId).toBe("account-a");
});
it("rejects forged or mismatched website login callbacks", async () => {
  const r = runtime();
  r.session.loginFlow = {
    state: randomUUID(),
    origin,
    tabId: 10,
    expiresAt: Date.now() + 10000,
  };
  await expect(
    r.context.loginResult(
      {
        state: r.session.loginFlow.state,
        status: "authorized",
        code: "a".repeat(64),
      },
      {
        id: "fixture",
        url: origin + "/#/browser-connect?state=x",
        tab: { id: 11 },
      },
    ),
  ).rejects.toThrow("clipper_scope_denied");
});

it("binds the blank authentication tab before navigation can deliver an immediate login callback", async () => {
  const r = runtime();
  const calls: string[] = [];
  const tabId = 31;
  const code = "a".repeat(64);
  const set = r.context.chrome.storage.session.set;
  r.context.chrome.storage.session.set = async (values: any) => {
    if (values.loginFlow)
      calls.push(values.loginFlow.tabId === tabId ? "bind-tab" : "create-flow");
    return set(values);
  };
  r.context.chrome.tabs.create = async (options: any) => {
    calls.push("create-blank");
    expect(options).toEqual({ url: "about:blank", active: false });
    expect(r.session.loginFlow.tabId).toBeUndefined();
    return { id: tabId };
  };
  r.context.chrome.tabs.remove = async (id: number) => {
    expect(id).toBe(tabId);
    calls.push("close-tab");
  };
  r.context.fetch = async (url: string, options: any) => {
    if (url.endsWith("/token")) {
      calls.push("exchange");
      expect(JSON.parse(options.body)).toEqual({
        version: 2,
        code,
        verifier: r.session.loginFlow.verifier,
      });
      return { ok: true, json: async () => ({ ...config }) };
    }
    expect(url).toBe(origin + "/api/v1/browser-clipper/session");
    calls.push("probe");
    return { ok: true };
  };
  r.context.chrome.tabs.update = async (id: number, options: any) => {
    calls.push("navigate");
    const flow = structuredClone(r.session.loginFlow);
    expect(id).toBe(tabId);
    expect(flow.tabId).toBe(tabId);
    const url = new URL(options.url);
    expect(url.origin).toBe(origin);
    const query = new URLSearchParams(url.hash.split("?")[1]);
    expect(query.get("state")).toBe(flow.state);
    expect(query.get("installationId")).toBe(r.local.installationId);
    expect(query.get("challenge")).toBe(
      createHash("sha256").update(flow.verifier).digest("hex"),
    );
    const message = { state: flow.state, status: "authorized", code };
    const sender = { id: "fixture", url: options.url, tab: { id: tabId } };
    await expect(
      r.context.loginResult({ ...message, state: randomUUID() }, sender),
    ).rejects.toThrow("clipper_scope_denied");
    await expect(
      r.context.loginResult(message, {
        ...sender,
        url: "https://other.example.test/" + url.hash,
      }),
    ).rejects.toThrow("clipper_scope_denied");
    expect(r.session.loginFlow).toEqual(flow);
    // Deliver the valid page callback before tabs.update itself resolves.
    await expect(r.context.loginResult(message, sender)).resolves.toEqual({
      connected: true,
    });
    return { id: tabId, url: options.url };
  };
  await expect(r.context.startLogin(false)).resolves.toEqual(config);
  expect(calls).toEqual([
    "create-flow",
    "create-blank",
    "bind-tab",
    "navigate",
    "exchange",
    "probe",
    "close-tab",
  ]);
  expect(r.session.authorization).toEqual(config);
  expect(r.session.loginFlow).toBeUndefined();
  expect(r.session.cookieProbeUnsupported).toBe(false);
});

for (const promoteAt of ["before-navigation", "before-callback"] as const)
  it(`keeps a passive login open when a human requests it ${promoteAt}`, async () => {
    const r = runtime();
    const tabId = 42;
    const next = { ...config, token: "doca_browser_v2_" + "2".repeat(64) };
    let allowPromotion = true;
    let humanLogin: Promise<unknown> | undefined;
    let sender: any;
    let flowState = "";
    let signalWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      signalWaiting = resolve;
    });
    const active: number[] = [];
    const removed: number[] = [];
    r.context.chrome.tabs.create = async (options: any) => {
      expect(options).toEqual({ url: "about:blank", active: false });
      if (allowPromotion && promoteAt === "before-navigation")
        humanLogin = r.context.startLogin(true);
      return { id: tabId };
    };
    r.context.chrome.tabs.remove = async (id: number) => {
      removed.push(id);
    };
    r.context.fetch = async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith("/token") ? next : {}),
    });
    r.context.chrome.tabs.update = async (id: number, options: any) => {
      expect(id).toBe(tabId);
      if (options.active) {
        active.push(id);
        return { id };
      }
      expect(r.session.loginFlow.tabId).toBe(tabId);
      expect(r.session.loginFlow.interactive).toBe(false);
      if (allowPromotion && promoteAt === "before-callback")
        humanLogin = r.context.startLogin(true);
      sender = { id: "fixture", url: options.url, tab: { id } };
      flowState = r.session.loginFlow.state;
      const result = await r.context.loginResult(
        { state: flowState, status: "login-required" },
        sender,
      );
      expect(result).toEqual({ waiting: allowPromotion });
      if (allowPromotion) signalWaiting();
      return { id, url: options.url };
    };
    let settled = false;
    const passive = r.context.startLogin(false);
    void passive.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waiting;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(humanLogin).toBe(passive);
    expect(settled).toBe(false);
    expect(active).toEqual([tabId]);
    expect(removed).toEqual([]);
    expect(r.session.loginFlow.interactive).toBe(false);
    expect(Object.keys(r.session.loginFlow).sort()).toEqual([
      "expiresAt",
      "interactive",
      "origin",
      "state",
      "tabId",
      "verifier",
    ]);

    const authorized = {
      state: flowState,
      status: "authorized",
      code: "a".repeat(64),
    };
    await expect(
      r.context.loginResult({ ...authorized, state: randomUUID() }, sender),
    ).rejects.toThrow("clipper_scope_denied");
    await expect(
      r.context.loginResult(authorized, {
        ...sender,
        url: "https://other.example.test/#/browser-connect?state=" + flowState,
      }),
    ).rejects.toThrow("clipper_scope_denied");
    expect(settled).toBe(false);
    expect(removed).toEqual([]);
    await expect(r.context.loginResult(authorized, sender)).resolves.toEqual({
      connected: true,
    });
    await expect(passive).resolves.toEqual(next);
    await expect(humanLogin).resolves.toEqual(next);
    expect(removed).toEqual([tabId]);
    expect(r.session.loginFlow).toBeUndefined();

    // A later passive attempt must not inherit the earlier human's intent.
    allowPromotion = false;
    await expect(r.context.startLogin(false)).rejects.toThrow(
      "clipper_login_required",
    );
    expect(active).toEqual([tabId]);
    expect(removed).toEqual([tabId, tabId]);
  });

it("avoids repeated authorization tabs while a cookie-blocked browser has a recent same-origin login proof", async () => {
  const r = runtime();
  r.session.cookieProbeUnsupported = true;
  r.session.websiteProofAt = Date.now();
  r.context.fetch = async () => {
    throw Error("Should reuse the recent website proof for passive polling");
  };
  await expect(r.context.ensureLogin(false)).resolves.toEqual(config);
});

it("freezes the shortcut source before sign-in can activate a Doca tab and uses the existing capture path", async () => {
  const r = runtime(),
    calls: string[] = [],
    capture = { markdown: "selected" };
  r.context.snapshot = async (mode: string) => {
    calls.push(mode);
    return { capture, tabId: 17 };
  };
  r.context.ensureLogin = async (interactive: boolean) => {
    expect(interactive).toBe(true);
    calls.push("login");
  };
  r.context.begin = async (body: unknown, profile: unknown, tabId: number) => {
    expect(body).toBe(capture);
    expect(profile).toBeUndefined();
    expect(tabId).toBe(17);
    calls.push("begin");
    return "pending";
  };
  r.context.submit = async (pending: string) => {
    expect(pending).toBe("pending");
    calls.push("submit");
  };
  const badges: string[] = [];
  r.context.chrome.action.setBadgeText = async ({ text }: { text: string }) => {
    badges.push(text);
  };
  await r.context.captureFromShortcut("capture-selection");
  expect(calls).toEqual(["selection", "login", "begin", "submit"]);
  expect(badges).toEqual(["…", "✓"]);
  await r.context.captureFromShortcut("unknown");
  expect(calls).toHaveLength(4);
});
it("reports an unavailable shortcut selection without starting authentication or a capture", async () => {
  const r = runtime();
  let called = false;
  r.context.snapshot = async () => {
    throw Error("clipper_selection_missing");
  };
  r.context.ensureLogin = async () => {
    called = true;
  };
  await r.context.captureFromShortcut("capture-selection");
  expect(called).toBe(false);
  expect(r.session.lastError).toBe("clipper_selection_missing");
});
it("limits the shared AI renderer proxy to dedicated endpoints and the current connection", async () => {
  const r = runtime();
  r.local.site = { version: 2, origin };
  r.session.authorization = config;
  r.context.ensureLogin = async () => config;
  const ui = { id: "fixture", url: "chrome-extension://fixture/ui.html" };
  const message = {
    type: "assistantRequest",
    origin,
    connectionId,
    path: "/assistant/ui/sessions?profileId=selected",
    method: "GET",
  };
  await expect(r.handle(message, ui)).resolves.toBeDefined();
  await expect(
    r.handle({ ...message, path: "/assistant/ui/../../ai/options" }, ui),
  ).rejects.toThrow("clipper_scope_denied");
  await expect(
    r.handle(
      { ...message, path: "https://other.test/assistant/ui/options" },
      ui,
    ),
  ).rejects.toThrow("clipper_scope_denied");
  await expect(
    r.handle({ ...message, connectionId: randomUUID() }, ui),
  ).rejects.toThrow("clipper_scope_denied");
  await expect(
    r.handle(message, {
      id: "fixture",
      url: "https://source.test",
      tab: { id: 2 },
      frameId: 0,
    }),
  ).rejects.toThrow("clipper_scope_denied");
});
it("isolates shared UI session selection by site, browser connection and profile without changing the stored shape", async () => {
  const r = runtime(),
    id = randomUUID();
  r.local.site = { version: 2, origin };
  r.session.authorization = config;
  const ui = { id: "fixture", url: "chrome-extension://fixture/ui.html" };
  const message = {
    type: "assistantSession",
    operation: "set",
    origin,
    connectionId,
    profileId: "profile",
    id,
  };
  await expect(r.handle(message, ui)).resolves.toEqual({ sessionId: id });
  expect(r.session.assistant).toEqual({
    origin,
    connectionId,
    profileId: "profile",
    id,
  });
  await expect(
    r.handle({ ...message, operation: "get", profileId: "other" }, ui),
  ).resolves.toEqual({ sessionId: null });
  await expect(
    r.handle({ ...message, connectionId: randomUUID() }, ui),
  ).rejects.toThrow("clipper_scope_denied");
});
it("checks a saved browser chat before restoring it and preserves stale sessions and pending delivery", async () => {
  const r = runtime(),
    id = randomUUID();
  r.session.assistant = { origin, connectionId, profileId: "profile", id };
  r.session.assistantDraft = { requestId: randomUUID(), text: "Keep my draft" };
  const saved = JSON.parse(JSON.stringify(r.session));
  const ui = { id: "fixture", url: "chrome-extension://fixture/ui.html" };
  const message = {
    type: "assistantSession",
    operation: "get",
    origin,
    connectionId,
    profileId: "profile",
  };
  const urls: string[] = [];
  let status = 200,
    code = "";
  r.context.fetch = async (url: string) => {
    urls.push(url);
    return {
      ok: status === 200,
      status,
      json: async () => ({ id, message: code }),
    };
  };
  await expect(r.handle(message, ui)).resolves.toEqual({ sessionId: id });
  expect(urls).toEqual([
    origin + `/api/v1/browser-clipper/assistant/sessions/${id}`,
  ]);
  for (const failure of [
    { status: 409, code: "clipper_profile_changed" },
    { status: 404, code: "clipper_session_missing" },
  ]) {
    status = failure.status;
    code = failure.code;
    await expect(r.handle(message, ui)).resolves.toEqual({ sessionId: null });
    expect(r.session).toEqual(saved);
  }
  for (const failure of [
    { status: 403, code: "clipper_scope_denied" },
    { status: 503, code: "clipper_connection_failed" },
  ]) {
    status = failure.status;
    code = failure.code;
    await expect(r.handle(message, ui)).rejects.toMatchObject({
      message: code,
      status,
    });
    expect(r.session).toEqual(saved);
  }
});
it("opens the selection's panel with its rule before asynchronous sign-in and keeps its frozen material", async () => {
  const r = runtime(),
    profileId = randomUUID(),
    calls: string[] = [],
    capture = {
      url: "https://source.test/article",
      markdown: "selected",
      images: [],
    };
  r.context.chrome.sidePanel = {
    setOptions: async (options: any) => {
      calls.push("configure");
      expect(options.tabId).toBe(8);
      expect(options.path).toContain("profileId=" + profileId);
      expect(options.path).toContain("profileRevision=3");
    },
    open: async (options: any) => {
      calls.push("open");
      expect(options.tabId).toBe(8);
    },
  };
  r.context.ensureLogin = async (interactive: boolean) => {
    expect(interactive).toBe(true);
    calls.push("login");
  };
  r.context.begin = async (
    value: unknown,
    id: string,
    tabId: number,
    revision: number,
  ) => {
    expect(value).toEqual(capture);
    expect([id, tabId, revision]).toEqual([profileId, 8, 3]);
    return { capture, profileId };
  };
  await expect(
    r.handle(
      { type: "openAssistant", profileId, profileRevision: 3, capture },
      { id: "fixture", url: capture.url, frameId: 0, tab: { id: 8 } },
    ),
  ).resolves.toEqual({ opened: true });
  expect(calls).toEqual(["configure", "open", "login"]);
  expect(r.session.assistantPending.capture).toBe(capture);
});
it("rejects cross-origin selected material before opening a native panel", async () => {
  const r = runtime();
  let opened = false;
  r.context.chrome.sidePanel = {
    open: async () => {
      opened = true;
    },
    setOptions: async () => {
      opened = true;
    },
  };
  await expect(
    r.handle(
      { type: "openAssistant", capture: { url: "https://other.test" } },
      { id: "fixture", url: "https://source.test", frameId: 0, tab: { id: 8 } },
    ),
  ).rejects.toThrow("clipper_scope_denied");
  expect(opened).toBe(false);
});

it("preserves retained selected material when its rule revision differs and reuses it only on the same page and revision", async () => {
  const r = runtime();
  const profileId = randomUUID();
  const pending = {
    origin,
    connectionId,
    requestId: randomUUID(),
    profileId,
    profileRevision: 1,
    tabId: 7,
    capture: {
      mode: "selection",
      title: "Frozen selection",
      url: "https://source.example.test/original",
      capturedAt: "2026-10-21T10:00:00.000Z",
      markdown: "The original selected material.",
      images: [],
    },
  };
  r.session.assistantPending = pending;
  r.session.pending = pending;
  r.context.chrome.tabs.get = async () => ({ id: 7, url: pending.capture.url });
  const before = structuredClone(pending);
  const posted: { url: string; body: any }[] = [];
  let snapshots = 0;
  r.context.ensureLogin = async () => config;
  r.context.snapshot = async () => {
    snapshots++;
    throw Error("must keep the selected material");
  };
  r.context.fetch = async (url: string, options: any) => {
    posted.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ status: "pending", uploadedImageIds: [] }),
    };
  };
  const message = {
    type: "assistantPreparePage",
    origin,
    connectionId,
    profileId,
    profileRevision: 2,
    tabId: 7,
  };
  const ui = {
    id: "fixture",
    url: "chrome-extension://fixture/ui.html#assistant",
  };
  await expect(r.handle(message, ui)).rejects.toThrow(
    "clipper_profile_changed",
  );
  expect(r.session.assistantPending).toEqual(before);
  expect(r.session.pending).toEqual(before);
  expect(posted).toEqual([]);
  expect(snapshots).toBe(0);

  await expect(
    r.handle({ ...message, profileRevision: 1 }, ui),
  ).resolves.toEqual({
    captureRequestId: pending.requestId,
    title: pending.capture.title,
    url: pending.capture.url,
  });
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    url: origin + "/api/v1/browser-clipper/clips",
    body: {
      requestId: pending.requestId,
      profileRevision: 1,
      mode: "selection",
      markdown: pending.capture.markdown,
    },
  });
  expect(snapshots).toBe(0);
  expect(r.session.assistantPending).toEqual(before);
  expect(r.session.pending).toEqual(before);
});

it("rejects retained material with a missing revision instead of inventing one", async () => {
  const r = runtime();
  const profileId = randomUUID();
  const pending = {
    origin,
    connectionId,
    profileId,
    requestId: randomUUID(),
    capture: { markdown: "retained" },
  };
  r.session.assistantPending = pending;
  r.context.ensureLogin = async () => config;
  let touchedMaterial = false;
  r.context.snapshot = r.context.prepare = async () => {
    touchedMaterial = true;
  };
  await expect(
    r.handle(
      {
        type: "assistantPreparePage",
        origin,
        connectionId,
        profileId,
        profileRevision: 1,
      },
      { id: "fixture", url: "chrome-extension://fixture/ui.html#assistant" },
    ),
  ).rejects.toThrow("clipper_profile_changed");
  expect(touchedMaterial).toBe(false);
  expect(r.session.assistantPending).toBe(pending);
  expect(pending).not.toHaveProperty("profileRevision");
});

for (const method of ["GET", "POST"] as const)
  it(`retries an in-flight ${method} once when the same connection has rotated its token`, async () => {
    const r = runtime();
    const next = { ...config, token: "doca_browser_v2_" + "2".repeat(64) };
    const path =
      method === "GET"
        ? `/assistant/ui/sessions/${randomUUID()}`
        : `/assistant/ui/jobs/${randomUUID()}/approval`;
    const body =
      method === "POST"
        ? { approvalId: randomUUID(), approved: false }
        : undefined;
    const sent: { url: string; options: any }[] = [];
    r.context.fetch = async (url: string, options: any) => {
      sent.push({ url, options });
      if (sent.length === 1) {
        r.session.authorization = next;
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: "clipper_login_required" }),
        };
      }
      return { ok: true, json: async () => ({ received: true }) };
    };
    await expect(
      r.context.request(path, method, body, false, { origin, connectionId }),
    ).resolves.toEqual({ received: true });
    expect(sent).toHaveLength(2);
    const first = sent[0]!,
      second = sent[1]!;
    expect(first.options.headers.Authorization).toBe("Bearer " + config.token);
    expect(second.options.headers.Authorization).toBe("Bearer " + next.token);
    expect(second.url).toBe(first.url);
    expect(second.options).toEqual({
      ...first.options,
      headers: {
        ...first.options.headers,
        Authorization: "Bearer " + next.token,
      },
    });
    expect(r.session.authorization).toEqual(next);
  });

it("waits for an already running same-connection rotation before retrying an old-token 401", async () => {
  const r = runtime();
  const next = { ...config, token: "doca_browser_v2_" + "2".repeat(64) };
  let reportRequestStarted!: () => void;
  let releaseOldResponse!: () => void;
  let reportExchangeStarted!: () => void;
  let releaseExchange!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    reportRequestStarted = resolve;
  });
  const oldResponse = new Promise<void>((resolve) => {
    releaseOldResponse = resolve;
  });
  const exchangeStarted = new Promise<void>((resolve) => {
    reportExchangeStarted = resolve;
  });
  const exchange = new Promise<void>((resolve) => {
    releaseExchange = resolve;
  });
  const requestTokens: string[] = [];
  let callback: Promise<unknown> | undefined;
  r.context.chrome.tabs.create = async () => ({ id: 14 });
  r.context.chrome.tabs.remove = async () => {};
  r.context.chrome.tabs.update = async (
    tabId: number,
    options: { url?: string },
  ) => {
    if (!options.url) return;
    const flow = r.session.loginFlow;
    callback = r.context.loginResult(
      { state: flow.state, status: "authorized", code: "a".repeat(64) },
      { id: "fixture", tab: { id: tabId }, url: options.url },
    );
    void callback?.catch(() => {});
  };
  r.context.fetch = async (url: string, options: any) => {
    if (url.endsWith("/token")) {
      reportExchangeStarted();
      return {
        ok: true,
        json: async () => {
          await exchange;
          return next;
        },
      };
    }
    if (url.endsWith("/session")) return { ok: true };
    requestTokens.push(options.headers.Authorization);
    if (requestTokens.length === 1) {
      reportRequestStarted();
      await oldResponse;
      return {
        ok: false,
        status: 401,
        json: async () => ({ message: "clipper_login_required" }),
      };
    }
    return { ok: true, json: async () => ({ received: true }) };
  };
  const outgoing = r.context.request("/me", "GET", undefined, false, {
    origin,
    connectionId,
  });
  let settled = false;
  void outgoing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await requestStarted;
  const login = r.context.startLogin(false);
  void login.catch(() => {});
  let settledBeforeRemember = true;
  try {
    await exchangeStarted;
    expect(r.session.authorization).toEqual(config);
    releaseOldResponse();
    await new Promise((resolve) => setTimeout(resolve, 0));
    settledBeforeRemember = settled;
  } finally {
    releaseOldResponse();
    releaseExchange();
    await Promise.allSettled([login, callback]);
  }
  await expect(outgoing).resolves.toEqual({ received: true });
  expect(settledBeforeRemember).toBe(false);
  expect(requestTokens).toEqual([
    "Bearer " + config.token,
    "Bearer " + next.token,
  ]);
  expect(r.session.authorization).toEqual(next);
});

for (const scenario of [
  { name: "the token did not change", status: 401, next: config },
  {
    name: "the account connection changed",
    status: 401,
    next: {
      ...config,
      connectionId: randomUUID(),
      token: "doca_browser_v2_" + "2".repeat(64),
    },
  },
  {
    name: "the configured site changed",
    status: 401,
    next: {
      ...config,
      origin: "https://other.example.test",
      token: "doca_browser_v2_" + "2".repeat(64),
    },
  },
  {
    name: "authorization was forbidden",
    status: 403,
    next: { ...config, token: "doca_browser_v2_" + "2".repeat(64) },
  },
  {
    name: "the operation conflicted",
    status: 409,
    next: { ...config, token: "doca_browser_v2_" + "2".repeat(64) },
  },
])
  it(`does not replay a failed request when ${scenario.name}`, async () => {
    const r = runtime();
    let calls = 0;
    r.context.fetch = async () => {
      calls++;
      r.session.authorization = scenario.next;
      r.local.site = { version: 2, origin: scenario.next.origin };
      return {
        ok: false,
        status: scenario.status,
        json: async () => ({ message: "clipper_scope_denied" }),
      };
    };
    await expect(
      // Internal state probes have no explicit UI boundary; the original
      // request's connection must still prevent replay into another account/site.
      r.context.request("/me", "GET"),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(r.session.authorization).toEqual(scenario.next);
  });

it("rejects a second 401 after one same-connection token retry", async () => {
  const r = runtime();
  const requestTokens: string[] = [];
  r.context.fetch = async (_url: string, options: any) => {
    requestTokens.push(options.headers.Authorization);
    r.session.authorization = {
      ...config,
      token: "doca_browser_v2_" + String(requestTokens.length + 1).repeat(64),
    };
    return {
      ok: false,
      status: 401,
      json: async () => ({ message: "clipper_login_required" }),
    };
  };
  await expect(
    r.context.request("/me", "GET", undefined, false, { origin, connectionId }),
  ).rejects.toMatchObject({ message: "clipper_login_required", status: 401 });
  expect(requestTokens).toEqual([
    "Bearer " + config.token,
    "Bearer doca_browser_v2_" + "2".repeat(64),
  ]);
});

for (const oldStatus of [200, 401] as const)
  for (const changed of ["token", "account", "site"] as const)
    it(`ignores a stale website session ${oldStatus} after the ${changed} changed and returns the current identity`, async () => {
      const r = runtime();
      const next = {
        ...config,
        token: "doca_browser_v2_" + "2".repeat(64),
        ...(changed !== "token" ? { connectionId: randomUUID() } : {}),
        ...(changed === "site"
          ? { origin: "https://new-doca.example.test" }
          : {}),
      };
      let reportOldStarted!: () => void;
      let releaseOld!: () => void;
      const oldStarted = new Promise<void>((resolve) => {
        reportOldStarted = resolve;
      });
      const oldResponse = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let first = true;
      let authorizationTabs = 0;
      r.context.chrome.tabs.create = async () => {
        authorizationTabs++;
        throw Error("A completed new grant must not open another login tab");
      };
      const observed: { url: string; token: string }[] = [];
      r.context.fetch = async (url: string, options: any) => {
        const token = options.headers.Authorization;
        observed.push({ url, token });
        if (first) {
          first = false;
          expect(url).toBe(origin + "/api/v1/browser-clipper/session");
          expect(token).toBe("Bearer " + config.token);
          reportOldStarted();
          await oldResponse;
          return {
            ok: oldStatus === 200,
            status: oldStatus,
            json: async () => ({ message: "clipper_login_required" }),
          };
        }
        expect(new URL(url).origin).toBe(next.origin);
        expect(token).toBe("Bearer " + next.token);
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.endsWith("/me")
              ? {
                  user: { id: "current-owner", name: "Current owner" },
                  connection: { assistant_enabled: 1 },
                }
              : { items: [] },
        };
      };
      const pendingState = r.context.state(false);
      await oldStarted;
      // The explicit login/configuration has already completed while the old
      // website-session probe is still waiting for its response.
      r.local.site = { version: 2, origin: next.origin };
      r.session.authorization = next;
      releaseOld();
      const result = await pendingState;
      expect(authorizationTabs).toBe(0);
      expect(result.connected).toBe(true);
      expect(result.origin).toBe(next.origin);
      expect(result.connectionId).toBe(next.connectionId);
      expect(result.user).toEqual({
        id: "current-owner",
        name: "Current owner",
      });
      expect(observed.slice(1)).toContainEqual({
        url: next.origin + "/api/v1/browser-clipper/session",
        token: "Bearer " + next.token,
      });
      expect(r.session.authorization).toEqual(next);
      expect(r.session.loginFlow).toBeUndefined();
    });

it("ignores an old revoked response whose body arrives after the current account grant", async () => {
  const r = runtime();
  const next = {
    ...config,
    connectionId: randomUUID(),
    token: "doca_browser_v2_" + "2".repeat(64),
  };
  let reportBodyStarted!: () => void;
  let releaseBody!: () => void;
  const bodyStarted = new Promise<void>((resolve) => {
    reportBodyStarted = resolve;
  });
  const body = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  let currentGrantProbes = 0;
  r.context.fetch = async (_url: string, options: any) => {
    if (options.headers.Authorization === "Bearer " + config.token)
      return {
        ok: false,
        status: 401,
        json: async () => {
          reportBodyStarted();
          await body;
          return { message: "clipper_connection_revoked" };
        },
      };
    expect(options.headers.Authorization).toBe("Bearer " + next.token);
    currentGrantProbes++;
    return { ok: true, status: 200 };
  };
  const pending = r.context.ensureLogin(false);
  void pending.catch(() => {});
  await bodyStarted;
  r.session.authorization = next;
  releaseBody();
  await expect(pending).resolves.toEqual(next);
  expect(currentGrantProbes).toBe(1);
  expect(r.session.authorization).toEqual(next);
  expect(r.session.loginFlow).toBeUndefined();
});

it("still authenticates a real website-session 401 for the unchanged grant", async () => {
  const r = runtime();
  let authenticationCalls = 0;
  r.context.startLogin = async (interactive: boolean) => {
    authenticationCalls++;
    expect(interactive).toBe(true);
    return config;
  };
  r.context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: "clipper_login_required" }),
  });
  await expect(r.context.ensureLogin(true)).resolves.toEqual(config);
  expect(authenticationCalls).toBe(1);
});

it("still rejects a revoked website-session response for the unchanged grant", async () => {
  const r = runtime();
  let authenticationCalls = 0;
  r.context.startLogin = async () => {
    authenticationCalls++;
    return config;
  };
  r.context.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: "clipper_connection_revoked" }),
  });
  await expect(r.context.ensureLogin(false)).rejects.toThrow(
    "clipper_connection_revoked",
  );
  expect(authenticationCalls).toBe(0);
});

const quickNoteSender = {
  id: "fixture",
  url: "chrome-extension://fixture/ui.html",
};
const quickNoteScope = { origin, connectionId };
function quickNotePrepare() {
  return {
    type: "quickNotePrepare",
    ...quickNoteScope,
    requestId: randomUUID(),
    profileId: randomUUID(),
    profileRevision: 2,
    text: "  Literal <tag> & # Markdown\n第二行 `code`  ",
  };
}
function quickNoteCommit() {
  return {
    type: "quickNoteCommit",
    ...quickNoteScope,
    requestId: randomUUID(),
    ticket: "a".repeat(64),
  };
}
it("exposes quick-note operations only to the trusted extension view", async () => {
  const r = runtime();
  let requests = 0;
  r.context.fetch = async () => {
    requests++;
    throw Error("must not fetch");
  };
  for (const message of [
    { type: "quickNoteTargets", ...quickNoteScope },
    quickNotePrepare(),
    quickNoteCommit(),
  ]) {
    for (const sender of [
      { ...quickNoteSender, url: "https://source.test", tab: { id: 1 } },
      { ...quickNoteSender, id: "foreign" },
    ])
      await expect(r.handle(message, sender)).rejects.toThrow(
        "clipper_scope_denied",
      );
  }
  await expect(r.context.request("/quick-note/targets")).rejects.toThrow(
    "clipper_scope_denied",
  );
  expect(requests).toBe(0);
});
it("uses only the three fixed quick-note routes without AI, page capture or storage writes", async () => {
  const r = runtime(),
    requests: { url: string; options: any }[] = [],
    before = JSON.stringify([r.local, r.session]),
    prepare = quickNotePrepare(),
    commit = quickNoteCommit();
  r.context.fetch = async (url: string, options: any) => {
    if (url.endsWith("/session")) return { ok: true, json: async () => ({}) };
    requests.push({ url, options });
    return { ok: true, json: async () => ({ accepted: true }) };
  };
  r.context.snapshot = async () => {
    throw Error("quick notes must not capture a page");
  };
  for (const message of [
    { type: "quickNoteTargets", ...quickNoteScope },
    prepare,
    commit,
  ])
    await expect(r.handle(message, quickNoteSender)).resolves.toEqual({
      accepted: true,
    });
  expect(requests.map(({ url }) => url)).toEqual(
    ["targets", "prepare", "commit"].map(
      (path) => origin + "/api/v1/browser-clipper/quick-note/" + path,
    ),
  );
  expect(requests.map(({ options }) => options.method)).toEqual([
    "GET",
    "POST",
    "POST",
  ]);
  const preparedRequest = requests[1],
    committedRequest = requests[2];
  if (!preparedRequest || !committedRequest)
    throw Error("Expected preparation and commit requests");
  expect(JSON.parse(preparedRequest.options.body)).toEqual({
    requestId: prepare.requestId,
    profileId: prepare.profileId,
    profileRevision: 2,
    text: prepare.text,
  });
  expect(JSON.parse(committedRequest.options.body)).toEqual({
    requestId: commit.requestId,
    ticket: commit.ticket,
  });
  for (const { options } of requests) {
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("error");
    expect(options.headers.Authorization).toBe("Bearer " + config.token);
  }
  expect(JSON.stringify([r.local, r.session])).toBe(before);
});
it("requires the current v2 grant before accessing a quick-note route", async () => {
  const r = runtime();
  r.session.authorization = { ...config, version: 1 };
  let quickNoteCalls = 0;
  r.context.fetch = async (url: string) => {
    if (url.includes("/quick-note/")) quickNoteCalls++;
    return { ok: true, json: async () => ({}) };
  };
  await expect(
    r.handle({ type: "quickNoteTargets", ...quickNoteScope }, quickNoteSender),
  ).rejects.toThrow("clipper_login_required");
  expect(quickNoteCalls).toBe(0);
  expect(r.session.authorization.version).toBe(1);
});
it.each([
  ["extra target", { targetId: randomUUID() }],
  ["extra path", { path: "/resources" }],
  ["invalid request", { requestId: "invalid" }],
  ["array request", { requestId: [randomUUID()] }],
  ["invalid profile", { profileId: "invalid" }],
  ["array profile", { profileId: [randomUUID()] }],
  ["missing revision", { profileRevision: undefined }],
  ["blank text", { text: " \n\t " }],
  ["UTF-8 limit", { text: "中".repeat(21846) }],
])(
  "rejects malformed quick-note preparation before sending: %s",
  async (_label, patch) => {
    const r = runtime();
    let requests = 0;
    r.context.fetch = async () => {
      requests++;
      throw Error("must not fetch");
    };
    await expect(
      r.handle({ ...quickNotePrepare(), ...patch }, quickNoteSender),
    ).rejects.toThrow("clipper_invalid_input");
    expect(requests).toBe(0);
  },
);
it("rejects quick-note ticket fields and old-scope sends without a write", async () => {
  const r = runtime();
  let writes = 0;
  r.context.fetch = async (_url: string, options: any) => {
    if (options.method === "POST") writes++;
    return { ok: true, json: async () => ({}) };
  };
  for (const patch of [
    { ticket: "short" },
    { ticket: ["a".repeat(64)] },
    { requestId: [randomUUID()] },
    { text: "injected" },
  ])
    await expect(
      r.handle({ ...quickNoteCommit(), ...patch }, quickNoteSender),
    ).rejects.toThrow("clipper_invalid_input");
  for (const patch of [
    { origin: "https://other.test" },
    { connectionId: randomUUID() },
  ])
    await expect(
      r.handle({ ...quickNoteCommit(), ...patch }, quickNoteSender),
    ).rejects.toThrow("clipper_scope_denied");
  expect(writes).toBe(0);
});
for (const change of ["token", "connection", "origin"] as const)
  for (const stage of ["headers", "body"] as const)
    it(`rejects a late quick-note response after ${change} changes at ${stage}`, async () => {
      const r = runtime();
      let calls = 0;
      const switchGrant = () => {
        if (change === "origin")
          r.local.site = { version: 2, origin: "https://new.test" };
        else
          r.session.authorization = {
            ...config,
            ...(change === "token"
              ? { token: "doca_browser_v2_" + "2".repeat(64) }
              : { connectionId: randomUUID() }),
          };
      };
      r.context.fetch = async (url: string) => {
        if (url.endsWith("/session"))
          return { ok: true, json: async () => ({}) };
        calls++;
        if (stage === "headers") switchGrant();
        return {
          ok: true,
          json: async () => {
            if (stage === "body") switchGrant();
            return { changed: true };
          },
        };
      };
      await expect(
        r.handle(quickNoteCommit(), quickNoteSender),
      ).rejects.toThrow("quick_note_signin_changed");
      expect(calls).toBe(1);
    });
it.each(["token", "connection", "origin"])(
  "rejects a quick-note grant changed before dispatch: %s",
  async (change) => {
    const r = runtime();
    let writes = 0;
    r.context.fetch = async (_url: string, options: any) => {
      if (options.method === "POST") writes++;
      return { ok: true, json: async () => ({}) };
    };
    r.context.connection = async () => {
      if (change === "origin")
        r.local.site = { version: 2, origin: "https://new.test" };
      else
        r.session.authorization = {
          ...config,
          ...(change === "token"
            ? { token: "rotated" }
            : { connectionId: randomUUID() }),
        };
      return { ...config };
    };
    await expect(r.handle(quickNoteCommit(), quickNoteSender)).rejects.toThrow(
      "quick_note_signin_changed",
    );
    expect(writes).toBe(0);
  },
);
it("does not replay a quick-note 401 with a rotated sign-in token", async () => {
  const r = runtime();
  let commits = 0;
  r.context.fetch = async (url: string) => {
    if (url.endsWith("/session")) return { ok: true, json: async () => ({}) };
    commits++;
    r.session.authorization = { ...config, token: "rotated" };
    return {
      ok: false,
      status: 401,
      json: async () => ({ message: "clipper_token_invalid" }),
    };
  };
  await expect(r.handle(quickNoteCommit(), quickNoteSender)).rejects.toThrow(
    "quick_note_signin_changed",
  );
  expect(commits).toBe(1);
});
it.each([
  [409, "quick_note_ticket_missing"],
  [409, "quick_note_request_conflict"],
  [403, "clipper_scope_denied"],
])(
  "preserves quick-note failure %s/%s without preparing another note",
  async (status, message) => {
    const r = runtime();
    const requests: string[] = [];
    r.context.fetch = async (url: string) => {
      if (url.endsWith("/session")) return { ok: true, json: async () => ({}) };
      requests.push(url);
      return { ok: false, status, json: async () => ({ message }) };
    };
    await expect(
      r.handle(quickNoteCommit(), quickNoteSender),
    ).rejects.toMatchObject({
      message,
      status,
    });
    expect(requests).toEqual([
      origin + "/api/v1/browser-clipper/quick-note/commit",
    ]);
  },
);
it("retries an uncertain commit only with the same request and ticket bytes", async () => {
  const r = runtime(),
    message = quickNoteCommit(),
    bodies: string[] = [],
    before = JSON.stringify([r.local, r.session]);
  r.context.fetch = async (url: string, options: any) => {
    if (url.endsWith("/session")) return { ok: true, json: async () => ({}) };
    expect(url).toBe(origin + "/api/v1/browser-clipper/quick-note/commit");
    bodies.push(options.body);
    if (bodies.length === 1) throw Error("response lost");
    return {
      ok: true,
      json: async () => ({ requestId: message.requestId, changed: false }),
    };
  };
  await expect(r.handle(message, quickNoteSender)).rejects.toThrow(
    "response lost",
  );
  expect(bodies).toHaveLength(1);
  await expect(r.handle(message, quickNoteSender)).resolves.toEqual({
    requestId: message.requestId,
    changed: false,
  });
  expect(bodies).toEqual([bodies[0], bodies[0]]);
  expect(JSON.stringify([r.local, r.session])).toBe(before);
});

for (const mode of ["page", "selection"]) {
  for (const change of ["tab", "url", "content"]) {
    if (mode === "selection" && change === "content") continue;
    it(`captures the current page after ${change} changes instead of reusing an older ${mode}`, async () => {
      const r = runtime(),
        profileId = randomUUID();
      const old = {
        origin,
        connectionId,
        requestId: randomUUID(),
        profileId,
        profileRevision: 1,
        tabId: 7,
        capture: {
          mode,
          title: "First page",
          url: "https://source.test/one",
          markdown: "old content",
          images: [],
        },
      };
      r.session.assistantPending = old;
      const currentTab = {
        id: change === "tab" ? 8 : 7,
        url: change === "url" ? "https://source.test/two" : old.capture.url,
      };
      const capture = {
        ...old.capture,
        mode: "page",
        title: "Current page",
        url: currentTab.url,
        markdown: "new content",
      };
      r.context.ensureLogin = async () => config;
      r.context.chrome.tabs.get = async () => currentTab;
      let snapshots = 0;
      r.context.snapshot = async (mode: string, tabId: number) => {
        snapshots++;
        expect([mode, tabId]).toEqual(["page", currentTab.id]);
        return { capture, tabId };
      };
      r.context.request = async (path: string) =>
        path === "/profiles"
          ? { items: [{ id: profileId, revision: 1 }] }
          : { status: "pending", uploadedImageIds: [] };
      const result = await r.handle(
        {
          type: "assistantPreparePage",
          origin,
          connectionId,
          profileId,
          profileRevision: 1,
          tabId: currentTab.id,
        },
        quickNoteSender,
      );
      expect(snapshots).toBe(1);
      expect(result).toMatchObject({
        title: "Current page",
        url: currentTab.url,
      });
      expect(result.captureRequestId).not.toBe(old.requestId);
      expect(r.session.assistantPending.capture.markdown).toBe("new content");
      expect(old.capture.markdown).toBe("old content");
    });
  }
}

for (const code of ["clipper_image_invalid", "clipper_image_failed"]) {
  it(`keeps AI material and full capture usable after image validation returns ${code}`, async () => {
    const r = runtime(),
      profileId = randomUUID();
    const capture = {
      mode: "page",
      title: "Page with an unavailable image",
      url: "https://source.test/page",
      capturedAt: new Date().toISOString(),
      markdown: "Useful page text",
      images: [
        {
          id: randomUUID(),
          name: "logo.svg",
          url: "https://source.test/logo.svg",
        },
        {
          id: randomUUID(),
          name: "photo.png",
          url: "https://source.test/photo.png",
        },
      ],
    };
    r.context.ensureLogin = async () => config;
    r.context.chrome.tabs.get = async () => ({ id: 7, url: capture.url });
    r.context.snapshot = async () => ({ capture, tabId: 7 });
    r.context.bytes = async () => new Uint8Array([1, 2, 3]);
    const uploaded: string[] = [];
    r.context.request = async (path: string) => {
      if (path === "/profiles")
        return { items: [{ id: profileId, revision: 1 }] };
      if (path.endsWith("/" + capture.images[0]!.id))
        throw Object.assign(Error(code), { status: 400 });
      if (path.includes("/images/")) uploaded.push(path);
      return { status: "pending", uploadedImageIds: [] };
    };
    const result = await r.handle(
      {
        type: "assistantPreparePage",
        origin,
        connectionId,
        profileId,
        profileRevision: 1,
        tabId: 7,
      },
      quickNoteSender,
    );
    expect(result).toMatchObject({ title: capture.title, url: capture.url });
    expect(uploaded).toEqual([
      `/clips/${result.captureRequestId}/images/${capture.images[1]!.id}`,
    ]);
    expect(r.session.assistantPending.capture).toEqual(capture);
    expect(r.session.transfer).toBeUndefined();
    await expect(
      r.context.prepare(r.session.assistantPending),
    ).resolves.toMatchObject({ status: "pending" });
    expect(r.session.assistantPending.capture).toEqual(capture);
  });
}

it("does not suppress authorization or quota failures while preparing AI page images", async () => {
  const r = runtime();
  const pending = {
    origin,
    connectionId,
    requestId: randomUUID(),
    capture: {
      images: [
        {
          id: randomUUID(),
          name: "photo.png",
          url: "https://source.test/photo.png",
        },
      ],
    },
  };
  r.context.bytes = async () => new Uint8Array([1]);
  for (const code of [
    "clipper_scope_denied",
    "clipper_connection_revoked",
    "storage_quota_exceeded",
  ]) {
    r.context.request = async (path: string) => {
      if (path.includes("/images/"))
        throw Object.assign(Error(code), { status: 403 });
      return { status: "pending", uploadedImageIds: [] };
    };
    await expect(r.context.prepare(pending, false)).rejects.toThrow(code);
  }
});

it("keeps newer page material when an older AI message acknowledgement arrives", async () => {
  const r = runtime();
  const pending = { requestId: randomUUID(), origin, connectionId };
  r.session.assistantPending = pending;
  r.session.lastError = "clipper_image_invalid";
  r.context.ensureLogin = async () => config;
  r.context.request = async () => ({ id: randomUUID(), status: "queued" });
  const message = {
    type: "assistantRequest",
    origin,
    connectionId,
    method: "POST",
    path: `/assistant/ui/sessions/${randomUUID()}/messages`,
    body: { captureRequestId: randomUUID() },
  };
  await r.handle(message, quickNoteSender);
  expect(r.session.assistantPending).toEqual(pending);
  expect(r.session.lastError).toBeUndefined();
  await r.handle(
    { ...message, body: { captureRequestId: pending.requestId } },
    quickNoteSender,
  );
  expect(r.session.assistantPending).toBeUndefined();
});

for (const staleResponse of ["success", "failure"]) {
  it(`rechecks current sign-in when an old profile response arrives as ${staleResponse}`, async () => {
    const r = runtime();
    const next = {
      ...config,
      connectionId: randomUUID(),
      token: "doca_browser_v2_" + "2".repeat(64),
    };
    let first = true;
    r.context.ensureLogin = async () => r.session.authorization;
    r.context.fetch = async (url: string, options: any) => {
      const isOld = options.headers.Authorization === "Bearer " + config.token;
      if (first) {
        first = false;
        r.session.authorization = next;
      }
      return {
        ok: !isOld || staleResponse === "success",
        status: isOld ? 401 : 200,
        json: async () =>
          url.endsWith("/me")
            ? {
                user: { id: isOld ? "old-account" : "current-account" },
                connection: { assistant_enabled: 1 },
              }
            : { items: [{ id: isOld ? "old-profile" : "current-profile" }] },
      };
    };
    const result = await r.context.state();
    expect(result.connected).toBe(true);
    expect(result.connectionId).toBe(next.connectionId);
    expect(result.user.id).toBe("current-account");
    expect(result.profiles).toEqual([{ id: "current-profile" }]);
  });
}
