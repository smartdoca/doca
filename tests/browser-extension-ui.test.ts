import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
// @ts-expect-error jsdom is a runtime-only fixture dependency in this workspace.
import { JSDOM } from "jsdom";

const read = (file: string) =>
  readFile(
    new URL("../apps/browser-extension/" + file, import.meta.url),
    "utf8",
  );
const flush = async () => {
  for (let turn = 0; turn < 4; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
async function fixture(
  hash = "",
  options: {
    pendingReference?: any;
    moduleReady?: Promise<void>;
    configuredState?: any;
    updateReply?: any;
  } = {},
) {
  const dom = new JSDOM(await read("ui.html"), {
    url: "https://extension.test/ui.html" + hash,
    runScripts: "outside-only",
  });
  const dispose = dom.window.close.bind(dom.window);
  const mounts: any[] = [],
    calls: any[] = [],
    panelCalls: any[] = [],
    closes: boolean[] = [],
    storageListeners: ((changes: any, area: string) => void)[] = [],
    stateReplies: (() => Promise<any>)[] = [],
    operationReplies: (() => Promise<any>)[] = [],
    unmounts: any[] = [],
    storageWrites: any[] = [];
  const state = {
    locale: "zh",
    connected: true,
    assistantEnabled: true,
    origin: "https://doca.test",
    connectionId: "connection",
    user: { id: "user", name: "User" },
    profiles: [
      { id: "other", name: "Other", revision: 2 },
      { id: "default", name: "Default", isDefault: true, revision: 1 },
    ],
  };
  const currentTab = {
    id: 9,
    windowId: 11,
    title: "Current article",
    url: "https://article.test/page",
  };
  const tabListeners: {
    activated?: () => void;
    updated?: (id: number, change: any) => void;
  } = {};
  Object.assign(dom.window, {
    TextEncoder,
    setInterval() {},
    assistantFixtureReady: options.moduleReady,
    close: () => closes.push(true),
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.2.7" }),
        sendMessage: async (message: any) => {
          calls.push(message);
          if (message.type === "checkForUpdates") return {
            ok: true,
            value: { status: "current", currentVersion: "0.2.7", origin: state.origin, ...options.updateReply },
          };
          if (message.type === "locale") state.locale = message.locale;
          if (message.type === "configure")
            Object.assign(
              state,
              { origin: JSON.parse(message.config).origin },
              options.configuredState,
            );
          const stateReply = message.type === "state" && stateReplies.shift();
          if (stateReply) return { ok: true, value: await stateReply() };
          const operationReply =
            ["locale", "configure"].includes(message.type) &&
            operationReplies.shift();
          if (operationReply)
            return { ok: true, value: await operationReply() };
          return {
            ok: true,
            value:
              message.type === "state" ||
              message.type === "locale" ||
              message.type === "configure"
                ? structuredClone(state)
                : message.type === "capture"
                  ? { url: "https://doca.test/#/r/saved" }
                  : message.type === "assistantSession"
                    ? { sessionId: null }
                    : { jobs: [], sessionId: null },
          };
        },
      },
      tabs: {
        query: async () => [{ ...currentTab }],
        onActivated: {
          addListener: (listener: () => void) => {
            tabListeners.activated = listener;
          },
        },
        onUpdated: {
          addListener: (listener: (id: number, change: any) => void) => {
            tabListeners.updated = listener;
          },
        },
      },
      sidePanel: {
        setOptions: async (options: unknown) =>
          panelCalls.push({ type: "setOptions", options }),
        open: async (options: unknown) =>
          panelCalls.push({ type: "open", options }),
      },
      commands: { getAll: async () => [] },
      storage: {
        onChanged: {
          addListener: (listener: (changes: any, area: string) => void) =>
            storageListeners.push(listener),
        },
        session: {
          get: async () => ({ assistantPending: options.pendingReference }),
          set: async (value: any) => {
            storageWrites.push(value);
          },
        },
        local: {
          set: async (value: any) => {
            storageWrites.push(value);
          },
        },
      },
    },
    mountFixture: (_element: unknown, config: any) => {
      mounts.push(config);
      return {
        update: (next: any) => mounts.push(next),
        unmount: () => unmounts.push(config),
        compose() {},
      };
    },
  });
  dom.window.eval(await read("select.js"));
  const messages = (await read("messages.js")).replaceAll("export ", "");
  const ui = (await read("ui.js"))
    .replace('import { translate } from "./messages.js";', "")
    .replace(
      'const loadAssistant = () => import("./generated/assistant.js");',
      "const loadAssistant = async () => { await globalThis.assistantFixtureReady; return { mountBrowserAssistant: globalThis.mountFixture }; };",
    );
  await dom.window.eval("(async () => {" + messages + "\n" + ui + "})()");
  await flush();
  const doc = dom.window.document;
  const element = <T extends HTMLElement>(id: string) =>
    doc.getElementById(id) as T;
  return {
    dom,
    doc,
    element,
    mounts,
    calls,
    panelCalls,
    closes,
    dispose,
    storageListeners,
    serverState: state,
    stateReplies,
    operationReplies,
    unmounts,
    storageWrites,
    currentTab,
    tabListeners,
  };
}

it.each(["", "#assistant", "#settings"])("shows a localized upgrade notice and the current site's download page in %s", async (hash) => {
  const f = await fixture(hash, { updateReply: { status: "available", currentVersion: "0.2.7", latestVersion: "0.2.10" } });
  try {
    expect(f.element("extension-update").hidden).toBe(false);
    expect(f.element("update-message").textContent).toContain("新版 v0.2.10");
    expect(f.element("installed-version").textContent).toBe("当前版本 v0.2.7");
    expect(f.element<HTMLAnchorElement>("update-download").href).toBe("https://doca.test/#/browser-assistant");
    const locale = f.element<HTMLSelectElement>("locale");
    locale.value = "en";
    locale.dispatchEvent(new f.dom.window.Event("change", { bubbles: true }));
    await flush();
    expect(f.element("update-message").textContent).toContain("Version 0.2.10 is available");
    expect(f.element("update-download").textContent).toBe("Download the new package in Doca");
  } finally { f.dispose(); }
});

it("keeps failed checks separate from connection errors and retries from settings", async () => {
  const updateReply = { status: "failed" };
  const f = await fixture("#settings", { updateReply });
  try {
    expect(f.element("extension-update").hidden).toBe(true);
    expect(f.element("update-status").textContent).toBe("无法检查更新，请稍后重试。");
    expect(f.element("notice").hidden).toBe(true);
    updateReply.status = "current";
    f.element("check-updates").click();
    await flush();
    expect(f.element("update-status").textContent).toBe("已是本站提供的最新版本。");
    expect(f.calls.filter((message) => message.type === "checkForUpdates")).toHaveLength(2);
    f.element<HTMLInputElement>("endpoint").value = "https://other-doca.test";
    f.element("endpoint-form").dispatchEvent(new f.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(f.element<HTMLAnchorElement>("download-page").href).toBe("https://other-doca.test/#/browser-assistant");
    expect(f.calls.filter((message) => message.type === "checkForUpdates")).toHaveLength(3);
  } finally { f.dispose(); }
});

it.each([
  ["clipper_too_many_pending", "当前未完成的任务较多", "Too many tasks are currently active"],
  ["clipper_external_rejection", "错误代码：clipper_external_rejection", "error code: clipper_external_rejection"],
])("retains the current failure reason in settings and across a language change (%s)", async (code, chinese, english) => {
  const f = await fixture("#settings");
  try {
    Object.assign(f.serverState, { error: code });
    f.storageListeners[0]!({ lastError: { newValue: code } }, "session");
    await flush();
    expect(f.element("notice").textContent).toContain(chinese);
    const locale = f.element<HTMLSelectElement>("locale");
    locale.value = "en";
    locale.dispatchEvent(new f.dom.window.Event("change", { bubbles: true }));
    await flush();
    expect(f.element("notice").textContent).toContain(english);
    expect((f.serverState as any).error).toBe(code);
  } finally { f.dispose(); }
});

it("opens the capture home and saves the page or selection using the chosen rule without mounting AI", async () => {
  const { dom, doc, element, mounts, calls, dispose } = await fixture();
  try {
    expect(element("capture-pane").hidden).toBe(false);
    expect(element("assistant-pane").hidden).toBe(true);
    expect(doc.querySelector("#quick-note")).toBeNull();
    expect(calls.some((message) => message.type.startsWith("quickNote"))).toBe(
      false,
    );
    expect(element("connection-pane").hidden).toBe(true);
    expect(element<HTMLSelectElement>("profile").value).toBe("default");
    expect(mounts).toEqual([]);
    expect(calls.some((message) => message.type.startsWith("assistant"))).toBe(
      false,
    );
    expect(
      doc.querySelector(
        "[data-tab], #quick-actions, #capture-mode, #quick-capture, #quick-organize",
      ),
    ).toBeNull();
    expect(doc.querySelector("#attach-page")).toBeNull();
    expect(
      [...doc.querySelectorAll("select")].every((select) => select.hidden),
    ).toBe(true);
    element("capture-page").click();
    await flush();
    expect(calls.find((message) => message.type === "capture")).toMatchObject({
      mode: "page",
      profileId: "default",
      profileRevision: 1,
      tabId: 9,
    });
    const profile = element<HTMLSelectElement>("profile");
    profile.value = "other";
    profile.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    element("capture-selection").click();
    await flush();
    expect(
      calls.filter((message) => message.type === "capture").at(-1),
    ).toMatchObject({
      mode: "selection",
      profileId: "other",
      profileRevision: 2,
      tabId: 9,
    });
    expect(mounts).toEqual([]);
  } finally {
    dispose();
  }
});

it("shows current processing failures alongside the saved document link", async () => {
  const f = await fixture();
  try {
    const send = f.dom.window.chrome.runtime.sendMessage;
    f.dom.window.chrome.runtime.sendMessage = async (message: any) => message.type === "capture" ? {ok:true,value:{url:"https://doca.test/#/r/saved",warnings:[{message:"Figure: image conversion failed"},{message:"<img src=x onerror=bad()>"}]}} : send(message);
    f.element("capture-page").click();
    await flush();
    expect(f.element("notice").textContent).toContain("已保存到 Doca");
    expect(f.doc.querySelector("#notice summary")?.textContent).toContain("2 处内容未完整处理");
    expect(f.doc.querySelectorAll("#notice li")).toHaveLength(2);
    expect(f.doc.querySelector("#notice img")).toBeNull();
    expect(f.doc.querySelector("#notice a")?.getAttribute("href")).toBe("https://doca.test/#/r/saved");
  } finally { f.dispose(); }
});

it("opens settings from the top-right action and returns to the capture home with its chosen rule", async () => {
  const { dom, element, mounts, dispose } = await fixture();
  try {
    element<HTMLSelectElement>("profile").value = "other";
    element("settings").click();
    expect(element("connection-pane").hidden).toBe(false);
    expect(element("capture-pane").hidden).toBe(true);
    expect(element("assistant-pane").hidden).toBe(true);
    expect(element<HTMLAnchorElement>("settings-link").href).toBe(
      "https://doca.test/#/browser-assistant",
    );
    expect(element("connection-pane").contains(element("settings-link"))).toBe(
      true,
    );
    expect(element("connection-pane").contains(element("endpoint"))).toBe(true);
    expect(element("connection-pane").contains(element("config"))).toBe(true);
    expect(element("connection-pane").contains(element("locale"))).toBe(true);
    element("back").click();
    expect(element("capture-pane").hidden).toBe(false);
    expect(element("connection-pane").hidden).toBe(true);
    expect(element<HTMLSelectElement>("profile").value).toBe("other");
    expect(mounts).toEqual([]);
  } finally {
    dispose();
  }
});

it("opens the native AI side panel for the source tab and passes the selected rule without sending a model request", async () => {
  const { dom, element, panelCalls, closes, calls, mounts, dispose } =
    await fixture();
  try {
    const profile = element<HTMLSelectElement>("profile");
    profile.value = "other";
    profile.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    element("open-assistant").click();
    await flush();
    const configured = panelCalls.find((call) => call.type === "setOptions");
    expect(configured.options).toMatchObject({ tabId: 9 });
    const panelUrl = new URL(
      configured.options.path,
      "https://extension.test/",
    );
    expect(panelUrl.pathname).toBe("/ui.html");
    expect(panelUrl.hash.startsWith("#assistant?")).toBe(true);
    const parameters = new URLSearchParams(
      panelUrl.hash.slice("#assistant?".length),
    );
    expect(parameters.get("profileId")).toBe("other");
    expect(parameters.get("profileRevision")).toBe("2");
    expect(panelCalls.find((call) => call.type === "open")).toMatchObject({
      options: { tabId: 9 },
    });
    expect(panelCalls.map((call) => call.type)).toEqual(["setOptions", "open"]);
    expect(closes).toEqual([true]);
    expect(mounts).toEqual([]);
    expect(calls.some((message) => message.type.startsWith("assistant"))).toBe(
      false,
    );
  } finally {
    dispose();
  }
});

it("mounts the shared AI UI only in the sidebar, adopts the chosen rule and returns from settings to AI", async () => {
  const { dom, doc, element, mounts, calls, dispose } = await fixture(
    "#assistant?profileId=other&profileRevision=2",
  );
  try {
    expect(doc.body.classList.contains("sidebar")).toBe(true);
    expect(element("assistant-pane").hidden).toBe(false);
    expect(element("capture-pane").hidden).toBe(true);
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("other");
    expect(mounts.at(-1).profile).toEqual({
      id: "other",
      revision: 2,
      name: "Other",
    });
    expect(mounts.at(-1).page).toEqual({
      title: "Current article",
      url: "https://article.test/page",
    });
    expect(
      calls.find((message) => message.type === "assistantSession"),
    ).toMatchObject({ profileId: "other", operation: "get" });
    expect(doc.querySelector("#attach-page")).toBeNull();
    expect(
      calls.some((message) => message.type === "assistantPreparePage"),
    ).toBe(false);
    element("settings").click();
    expect(element("connection-pane").hidden).toBe(false);
    element("back").click();
    await flush();
    expect(element("assistant-pane").hidden).toBe(false);
    expect(element("capture-pane").hidden).toBe(true);
    element<HTMLSelectElement>("locale").value = "en";
    element("locale").dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await flush();
    expect(mounts.at(-1).locale).toBe("en");
    expect(mounts.at(-1).profile.id).toBe("other");
  } finally {
    dispose();
  }
});

it("requires an explicit rule selection when the rule passed to the sidebar has changed", async () => {
  const { dom, element, mounts, calls, dispose } = await fixture(
    "#assistant?profileId=other&profileRevision=999",
  );
  try {
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("");
    expect(element("notice").textContent).toContain("收录方案已修改");
    expect(mounts).toEqual([]);
    expect(calls.some((message) => message.type.startsWith("assistant"))).toBe(
      false,
    );
    element("settings").click();
    element<HTMLSelectElement>("locale").value = "en";
    element("locale").dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await flush();
    element("back").click();
    await flush();
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("");
    expect(mounts).toEqual([]);

    element<HTMLSelectElement>("ai-profile").value = "default";
    element("ai-profile").dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await flush();
    expect(mounts.at(-1).profile.id).toBe("default");
  } finally {
    dispose();
  }
});

it("keeps the explicit launch rule when another rule has retained unsent page material", async () => {
  const { element, mounts, dispose } = await fixture(
    "#assistant?profileId=default&profileRevision=1",
    {
      pendingReference: {
        origin: "https://doca.test",
        connectionId: "connection",
        profileId: "other",
        capture: {
          mode: "selection",
          title: "Earlier article",
          url: "https://earlier.test/page",
        },
      },
    },
  );
  try {
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("default");
    expect(mounts.at(-1).profile.id).toBe("default");
    expect(mounts.at(-1).page.url).toBe("https://article.test/page");
  } finally {
    dispose();
  }
});

it("does not replace the user's chosen rule when retained material changes in another panel", async () => {
  const { dom, element, mounts, dispose, storageListeners } =
    await fixture("#assistant");
  try {
    element<HTMLSelectElement>("ai-profile").value = "other";
    element("ai-profile").dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await flush();
    for (const listener of storageListeners)
      listener(
        {
          assistantPending: {
            newValue: {
              origin: "https://doca.test",
              connectionId: "connection",
              profileId: "default",
              capture: {
                mode: "selection",
                title: "Other panel's article",
                url: "https://other-panel.test/page",
              },
            },
          },
        },
        "session",
      );
    await flush();
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("other");
    expect(element<HTMLSelectElement>("profile").value).toBe("other");
    expect(mounts.at(-1).profile.id).toBe("other");
    expect(mounts.at(-1).page.url).toBe("https://article.test/page");
  } finally {
    dispose();
  }
});

it("mounts with the latest page reference and locale when the local AI module finishes loading", async () => {
  let finishModule!: () => void;
  const moduleReady = new Promise<void>((resolve) => {
    finishModule = resolve;
  });
  const { dom, element, mounts, dispose, storageListeners } = await fixture(
    "#assistant",
    { moduleReady },
  );
  try {
    expect(mounts).toEqual([]);
    for (const listener of storageListeners)
      listener(
        {
          assistantPending: {
            newValue: {
              origin: "https://doca.test",
              connectionId: "connection",
              profileId: "default",
              capture: {
                mode: "selection",
                title: "Latest article",
                url: "https://latest.test/page",
              },
            },
          },
        },
        "session",
      );
    element<HTMLSelectElement>("locale").value = "en";
    element("locale").dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await flush();
    finishModule();
    await flush();
    expect(mounts.at(-1).locale).toBe("en");
    expect(mounts.at(-1).page.url).toBe("https://article.test/page");
    expect(mounts.at(-1).page.title).toBe("Current article");
  } finally {
    finishModule();
    dispose();
  }
});

it("refreshes sign-in on focus and visibility without prompting, then restores the chosen rule and locale", async () => {
  const { dom, doc, element, mounts, calls, dispose, serverState, unmounts } =
    await fixture("#assistant?profileId=other&profileRevision=2");
  try {
    const profiles = serverState.profiles;
    Object.assign(serverState, {
      connected: false,
      profiles: [],
      error: "clipper_connection_revoked",
    });
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await flush();
    expect(element("connection-pane").hidden).toBe(false);
    expect(element("assistant-pane").hidden).toBe(true);
    expect(unmounts).toHaveLength(1);
    expect(element("assistant-root").textContent).toBe("");
    expect(element("notice").textContent).toContain("连接已撤销");

    Object.assign(serverState, {
      connected: true,
      profiles,
      error: "",
      locale: "en",
    });
    Object.defineProperty(doc, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    doc.dispatchEvent(new dom.window.Event("visibilitychange"));
    await flush();
    expect(element("assistant-pane").hidden).toBe(false);
    expect(element("connection-pane").hidden).toBe(true);
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("other");
    expect(mounts.at(-1).profile.id).toBe("other");
    expect(mounts.at(-1).locale).toBe("en");
    expect(element("notice").hidden).toBe(true);
    const probes = calls.filter((message) => message.type === "state");
    expect(probes[0].interactive).toBe(true);
    expect(
      probes.slice(1).every((message) => message.interactive === false),
    ).toBe(true);
  } finally {
    dispose();
  }
});

it("observes authorization, site, error and locale storage changes without changing the selected rule", async () => {
  const {
    element,
    mounts,
    calls,
    dispose,
    serverState,
    storageListeners,
    unmounts,
  } = await fixture("#assistant?profileId=other&profileRevision=2");
  const notify = (changes: any, area: string) => {
    for (const listener of storageListeners) listener(changes, area);
  };
  try {
    const profiles = serverState.profiles;
    Object.assign(serverState, {
      connected: false,
      profiles: [],
      error: "clipper_login_required",
    });
    notify(
      {
        authorization: {
          oldValue: { token: "synthetic" },
          newValue: undefined,
        },
      },
      "session",
    );
    await flush();
    expect(element("connection-pane").hidden).toBe(false);
    expect(unmounts).toHaveLength(1);

    Object.assign(serverState, {
      connected: true,
      profiles,
      error: "",
      locale: "en",
    });
    notify(
      {
        site: { oldValue: undefined, newValue: { origin: serverState.origin } },
      },
      "local",
    );
    await flush();
    expect(element("assistant-pane").hidden).toBe(false);
    expect(mounts.at(-1).locale).toBe("en");
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("other");

    Object.assign(serverState, { locale: "zh" });
    notify({ locale: { oldValue: "en", newValue: "zh" } }, "local");
    await flush();
    expect(mounts.at(-1).locale).toBe("zh");
    const beforeError = calls.filter(
      (message) => message.type === "state",
    ).length;
    notify(
      {
        lastError: { oldValue: "clipper_login_required", newValue: undefined },
      },
      "session",
    );
    await flush();
    expect(calls.filter((message) => message.type === "state")).toHaveLength(
      beforeError + 1,
    );
    expect(element<HTMLSelectElement>("ai-profile").value).toBe("other");
    notify({ locale: { oldValue: "zh", newValue: "zh" } }, "local");
    await flush();
    expect(calls.filter((message) => message.type === "state")).toHaveLength(
      beforeError + 1,
    );
    expect(
      calls
        .filter((message) => message.type === "state")
        .slice(1)
        .every((message) => !message.interactive),
    ).toBe(true);
  } finally {
    dispose();
  }
});

it("coalesces overlapping refresh events and applies a fresh result after an in-flight probe", async () => {
  const {
    dom,
    element,
    calls,
    dispose,
    serverState,
    stateReplies,
    storageListeners,
  } = await fixture("#assistant");
  let finishProbe!: (state: unknown) => void;
  stateReplies.push(
    () =>
      new Promise((resolve) => {
        finishProbe = resolve;
      }),
  );
  try {
    const before = calls.filter((message) => message.type === "state").length;
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await flush();
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    for (const listener of storageListeners)
      listener(
        {
          lastError: {
            oldValue: undefined,
            newValue: "clipper_login_required",
          },
        },
        "session",
      );
    await flush();
    expect(calls.filter((message) => message.type === "state")).toHaveLength(
      before + 1,
    );
    const earlier = structuredClone(serverState);
    Object.assign(serverState, {
      connected: false,
      profiles: [],
      error: "clipper_login_required",
    });
    finishProbe(earlier);
    await flush();
    expect(calls.filter((message) => message.type === "state")).toHaveLength(
      before + 2,
    );
    expect(element("connection-pane").hidden).toBe(false);
    expect(element("assistant-pane").hidden).toBe(true);
  } finally {
    dispose();
  }
});

it("discards a pre-action state reply that arrives after a successful locale change", async () => {
  const { dom, doc, element, calls, dispose, serverState, stateReplies } =
    await fixture("#assistant");
  let finishOld!: (state: unknown) => void;
  let finishFresh!: (state: unknown) => void;
  const previous = {
    ...structuredClone(serverState),
    error: "clipper_login_required",
  };
  stateReplies.push(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  stateReplies.push(
    () =>
      new Promise((resolve) => {
        finishFresh = resolve;
      }),
  );
  try {
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await flush();
    element("settings").click();
    element<HTMLSelectElement>("locale").value = "en";
    element("locale").dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await flush();
    expect(doc.documentElement.lang).toBe("en");
    finishOld(previous);
    await flush();
    expect(doc.documentElement.lang).toBe("en");
    expect(element<HTMLSelectElement>("locale").value).toBe("en");
    expect(element("notice").hidden).toBe(true);
    expect(calls.filter((message) => message.type === "state")).toHaveLength(3);
    finishFresh(structuredClone(serverState));
    await flush();
    expect(doc.documentElement.lang).toBe("en");
  } finally {
    dispose();
  }
});

it("keeps a successful new connection and its notice when an earlier connection probe finishes late", async () => {
  const { dom, element, mounts, dispose, serverState, stateReplies } =
    await fixture("#assistant", {
      configuredState: {
        connectionId: "new-connection",
        user: { id: "new-user", name: "New account" },
        locale: "en",
      },
    });
  let finishOld!: (state: unknown) => void;
  let finishFresh!: (state: unknown) => void;
  const previous = {
    ...structuredClone(serverState),
    error: "clipper_login_required",
  };
  stateReplies.push(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  stateReplies.push(
    () =>
      new Promise((resolve) => {
        finishFresh = resolve;
      }),
  );
  try {
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await flush();
    element("settings").click();
    element<HTMLInputElement>("endpoint").value = "https://next-doca.test";
    element("endpoint-form").dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(element("identity").textContent).toBe("New account");
    const success = element("notice").textContent;
    expect(element("notice").classList.contains("success")).toBe(true);
    finishOld(previous);
    await flush();
    expect(element("identity").textContent).toBe("New account");
    expect(element<HTMLInputElement>("endpoint").value).toBe(
      "https://next-doca.test",
    );
    expect(element("notice").textContent).toBe(success);
    expect(element("notice").classList.contains("success")).toBe(true);
    finishFresh(structuredClone(serverState));
    await flush();
    element("back").click();
    await flush();
    expect(mounts.at(-1).connectionId).toBe("new-connection");
    expect(mounts.at(-1).locale).toBe("en");
  } finally {
    dispose();
  }
});

it("defers refresh work while an action is busy and drains its queued probe after completion", async () => {
  const {
    dom,
    doc,
    element,
    calls,
    dispose,
    serverState,
    stateReplies,
    operationReplies,
  } = await fixture("#assistant");
  let finishOld!: (state: unknown) => void;
  let finishLocale!: (state: unknown) => void;
  const previous = structuredClone(serverState);
  stateReplies.push(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  operationReplies.push(
    () =>
      new Promise((resolve) => {
        finishLocale = resolve;
      }),
  );
  try {
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await flush();
    element<HTMLSelectElement>("locale").value = "en";
    element("locale").dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await flush();
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    finishOld(previous);
    await flush();
    expect(calls.filter((message) => message.type === "state")).toHaveLength(2);
    finishLocale(structuredClone(serverState));
    await flush();
    expect(calls.filter((message) => message.type === "state")).toHaveLength(3);
    expect(doc.documentElement.lang).toBe("en");
    expect(element<HTMLSelectElement>("locale").value).toBe("en");
  } finally {
    dispose();
  }
});

it("follows tab activation and in-page navigation instead of an older retained capture", async () => {
  const f = await fixture("#assistant", {
    pendingReference: {
      origin: "https://doca.test",
      connectionId: "connection",
      profileId: "default",
      tabId: 9,
      capture: {
        mode: "selection",
        title: "Selected article",
        url: "https://article.test/page",
      },
    },
  });
  try {
    expect(f.mounts.at(-1).page.title).toContain("Selected article");
    Object.assign(f.currentTab, {
      id: 10,
      title: "Next article",
      url: "https://next.test/page",
    });
    f.tabListeners.activated!();
    await flush();
    expect(f.mounts.at(-1).page).toEqual({
      title: "Next article",
      url: "https://next.test/page",
    });
    Object.assign(f.currentTab, {
      title: "Next route",
      url: "https://next.test/route-two",
    });
    f.tabListeners.updated!(10, { url: f.currentTab.url });
    await flush();
    expect(f.mounts.at(-1).page).toEqual({
      title: "Next route",
      url: "https://next.test/route-two",
    });
    // A click can arrive before Chrome delivers its onActivated event.
    f.currentTab.id = 11;
    await f.mounts.at(-1).captureCurrentPage();
    expect(f.calls.at(-1)).toMatchObject({
      type: "assistantPreparePage",
      tabId: 11,
    });
  } finally {
    f.dispose();
  }
});

it("opens settings directly as a standalone page without initializing AI", async () => {
  const f = await fixture("#settings");
  try {
    expect(f.dom.window.document.body.classList.contains("settings-page")).toBe(
      true,
    );
    expect(f.dom.window.document.getElementById("connection-pane").hidden).toBe(
      false,
    );
    expect(f.dom.window.document.getElementById("capture-pane").hidden).toBe(
      true,
    );
    expect(f.dom.window.document.getElementById("back").hidden).toBe(true);
    expect(f.mounts).toEqual([]);
  } finally {
    f.dispose();
  }
});

it("does not attach another tab's selection even when both tabs have the same URL", async () => {
  const f = await fixture("#assistant", {
    pendingReference: {
      origin: "https://doca.test",
      connectionId: "connection",
      profileId: "default",
      tabId: 99,
      capture: {
        mode: "selection",
        title: "Another tab",
        url: "https://article.test/page",
      },
    },
  });
  try {
    expect(f.mounts.at(-1).page.title).toBe("Current article");
  } finally {
    f.dispose();
  }
});
