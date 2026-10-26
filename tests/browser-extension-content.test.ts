import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
// @ts-expect-error jsdom is a runtime-only fixture dependency.
import { JSDOM } from "jsdom";
const source = await readFile(
  new URL("../apps/browser-extension/content.js", import.meta.url),
  "utf8",
);
const selectSource = await readFile(
  new URL("../apps/browser-extension/select.js", import.meta.url),
  "utf8",
);
const flush = async () => {
  for (let i = 0; i < 3; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const connected = (
  profiles = [
    {
      id: "profile",
      revision: 1,
      name: "Research",
      isDefault: true,
      strategy: "create",
    },
  ],
) => ({
  ok: true,
  value: {
    locale: "zh",
    connected: true,
    origin: "https://doca.test",
    assistantEnabled: true,
    profiles,
  },
});
async function fixture(
  replies: any[] = [],
  preferences: { position: number | null; locale: string } = {
    position: null,
    locale: "zh",
  },
  failPositionSave = false,
) {
  const dom = new JSDOM(
    "<title>Article</title><p id='article'>Selected page material</p>",
    { url: "https://source.test/page", runScripts: "outside-only" },
  );
  const calls: any[] = [],
    messageListeners: any[] = [];
  const attach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function () {
    return attach.call(this, { mode: "open" });
  };
  Object.assign(dom.window, {
    chrome: {
      runtime: {
        id: "fixture",
        onMessage: {
          addListener: (listener: any) => messageListeners.push(listener),
        },
        sendMessage: async (message: any) => {
          calls.push(message);
          if (message.type === "dockPreferences") {
            if (message.operation === "set" && failPositionSave)
              throw Error("storage unavailable");
            if (message.operation === "set")
              preferences.position = message.position;
            return { ok: true, value: { ...preferences } };
          }
          if (message.type === "prepareCapture")
            return { ok: true, value: message.capture };
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          return reply ?? { ok: true, value: { opened: true } };
        },
      },
    },
    DocaCapture: {
      capture: (mode: string, range: any) => {
        if (mode === "selection" && !range)
          throw Error("clipper_selection_missing");
        return {
          mode,
          url: "https://source.test/page",
          markdown:
            mode === "selection" ? "Selected page material" : "Entire article",
          images: [],
        };
      },
    },
  });
  dom.window.eval(selectSource);
  dom.window.eval(source);
  await flush();
  const host = dom.window.document.querySelector("[data-doca-capture-ui]")!;
  const shadow = host.shadowRoot!;
  const get = (selector: string) => shadow.querySelector(selector) as any;
  const click = async (action: string) => {
    get('[data-action="' + action + '"]').onclick({ isTrusted: true });
    await flush();
  };
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.getElementById("article"));
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: dom.window.document.getElementById("article").firstChild,
    getRangeAt: () => range,
  };
  dom.window.getSelection = () => selection;
  const select = () =>
    dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
  return {
    dom,
    host,
    shadow,
    get,
    calls,
    messageListeners,
    click,
    select,
    range,
    dispose: () => dom.window.close(),
  };
}
it("mounts four permanent actions without a selection popup and registers one receiver", async () => {
  const f = await fixture();
  try {
    expect(f.shadow.querySelectorAll(".tool")).toHaveLength(4);
    expect(f.get(".panel").hidden).toBe(true);
    f.select();
    f.dom.window.document.dispatchEvent(
      new f.dom.window.MouseEvent("mouseup", { bubbles: true }),
    );
    expect(f.get(".panel").hidden).toBe(true);
    expect(
      f.dom.window.document.querySelectorAll("[data-doca-capture-ui]"),
    ).toHaveLength(1);
    f.dom.window.eval(source);
    expect(f.messageListeners).toHaveLength(1);
    expect(f.calls.map((c) => c.type)).toEqual(["dockPreferences"]);
  } finally {
    f.dispose();
  }
});
it("confirms the chosen rule before capturing the page and freezes retry material", async () => {
  const f = await fixture([
    connected(),
    new Error("network failed"),
    { ok: true, value: { url: "https://doca.test/#/r/saved" } },
  ]);
  try {
    await f.click("page");
    expect(f.get(".confirm").textContent).toBe("确认收录");
    expect(f.calls.some((c) => c.type === "capture")).toBe(false);
    await f.get(".confirm").onclick({ isTrusted: true });
    expect(f.get(".status").textContent).toContain("network failed");
    const first = f.calls.find((c) => c.type === "capture");
    await f.get(".confirm").onclick({ isTrusted: true });
    expect(f.calls.filter((c) => c.type === "capture")).toEqual([first, first]);
    expect(first).toMatchObject({
      profileId: "profile",
      profileRevision: 1,
      capture: { mode: "page", markdown: "Entire article" },
    });
    expect(
      f.calls.filter((call) => call.type === "prepareCapture"),
    ).toHaveLength(1);
    expect(f.get(".status").textContent).toContain("已保存到 Doca");
    expect(f.get(".status a").href).toBe("https://doca.test/#/r/saved");
  } finally {
    f.dispose();
  }
});

it("shows successful capture together with every current processing issue as safe text", async () => {
  const f = await fixture([
    connected(),
    {
      ok: true,
      value: {
        url: "https://doca.test/#/r/saved",
        warnings: [
          { message: "figure.png: 图片转换失败" },
          { message: "<script>unsafe markup</script>" },
        ],
      },
    },
  ]);
  try {
    await f.click("page");
    await f.get(".confirm").onclick({ isTrusted: true });
    expect(f.get(".status").textContent).toContain("已保存到 Doca");
    expect(f.get(".status summary").textContent).toContain(
      "2 处内容未完整处理",
    );
    expect(f.shadow.querySelectorAll(".status li")).toHaveLength(2);
    expect(f.get(".status script")).toBeNull();
    expect(f.get(".status a").href).toBe("https://doca.test/#/r/saved");
  } finally {
    f.dispose();
  }
});
it.each([
  ["zh", "clipper_too_many_pending", "未完成的收录任务过多"],
  ["en", "clipper_too_many_pending", "Too many unfinished captures"],
  ["zh", "clipper_external_rejection", "错误代码：clipper_external_rejection"],
  ["en", "clipper_external_rejection", "error code: clipper_external_rejection"],
])("keeps the current capture failure actionable in %s (%s)", async (locale, code, expected) => {
  const connection = connected();
  connection.value.locale = locale;
  const f = await fixture([connection, { ok: false, error: code }]);
  try {
    await f.click("page");
    await f.get(".confirm").onclick({ isTrusted: true });
    expect(f.get(".status").textContent).toContain(expected);
    expect(f.get(".confirm").disabled).toBe(false);
    expect(f.get(".confirm").hidden).toBe(false);
  } finally { f.dispose(); }
});
it("captures the selected range from the permanent button without showing an automatic selection icon", async () => {
  const f = await fixture([
    connected(),
    { ok: true, value: { url: "https://doca.test/#/r/saved" } },
  ]);
  try {
    f.select();
    await f.click("selection");
    await f.get(".confirm").onclick({ isTrusted: true });
    expect(f.calls.find((c) => c.type === "capture").capture).toMatchObject({
      mode: "selection",
      markdown: "Selected page material",
    });
  } finally {
    f.dispose();
  }
});
it("opens the assistant from the direct click and routes settings through the trusted extension page", async () => {
  const f = await fixture();
  try {
    await f.click("assistant");
    await f.click("settings");
    expect(f.calls.slice(1).map((c) => c.type)).toEqual([
      "openAssistant",
      "openSettings",
    ]);
    expect(
      f.calls.some((c) => c.type === "capture" || c.type === "state"),
    ).toBe(false);
  } finally {
    f.dispose();
  }
});
it("recovers a transient connection failure and rechecks rules on reopening", async () => {
  const f = await fixture([
    new Error("Temporary network failure"),
    connected(),
    connected([
      {
        id: "new",
        revision: 2,
        name: "New account",
        isDefault: true,
        strategy: "create",
      },
    ]),
  ]);
  try {
    await f.click("page");
    expect(f.get(".confirm").textContent).toBe("重试");
    await f.get(".confirm").onclick({ isTrusted: true });
    await flush();
    expect(f.get("select").value).toBe("profile");
    await f.click("page");
    await f.click("page");
    expect(f.get("select").value).toBe("new");
  } finally {
    f.dispose();
  }
});
it("offers settings for missing rules and reconnects before reloading the rule list", async () => {
  const missing = await fixture([connected([])]);
  try {
    await missing.click("page");
    expect(missing.get(".status").textContent).toContain("请先设置收录规则");
    expect(missing.get(".confirm").textContent).toBe("打开设置");
  } finally {
    missing.dispose();
  }
  const f = await fixture([
    {
      ok: true,
      value: {
        connected: false,
        profiles: [],
        locale: "zh",
        error: "clipper_login_required",
      },
    },
    connected(),
    connected(),
  ]);
  try {
    await f.click("page");
    expect(f.get(".confirm").textContent).toBe("登录 Doca");
    await f.get(".confirm").onclick({ isTrusted: true });
    await flush();
    expect(f.calls.map((c) => c.type)).toEqual([
      "dockPreferences",
      "state",
      "login",
      "state",
    ]);
    expect(f.get(".confirm").textContent).toBe("确认收录");
  } finally {
    f.dispose();
  }
});
it("keeps drag adjustments in view and saves their relative position", async () => {
  const f = await fixture();
  try {
    const handle = f.get(".handle");
    handle.onkeydown({ key: "End", preventDefault() {} });
    await flush();
    expect(f.calls.at(-1)).toMatchObject({
      type: "dockPreferences",
      operation: "set",
      position: 1,
    });
    handle.onkeydown({ key: "Home", preventDefault() {} });
    await flush();
    expect(f.calls.at(-1)).toMatchObject({ position: 0 });
    expect(f.host.style.top).toBe("12px");
  } finally {
    f.dispose();
  }
});

it("uses the shared dropdown, keeps it outside the scrolling panel and confirms the chosen rule", async () => {
  const f = await fixture([
    connected([
      {
        id: "profile",
        revision: 1,
        name: "Research",
        isDefault: true,
        strategy: "create",
      },
      {
        id: "other",
        revision: 2,
        name: "Other destination",
        isDefault: false,
        strategy: "append",
      },
    ]),
    { ok: true, value: { url: "https://doca.test/saved" } },
  ]);
  try {
    await f.click("page");
    expect(f.get("select").hidden).toBe(true);
    const trigger = f.get('[role="combobox"]'),
      menu = f.get('[role="listbox"]');
    expect(menu.parentNode).toBe(f.shadow);
    expect(trigger.getAttribute("aria-label")).toBe("收录规则");
    trigger.click();
    expect(menu.hidden).toBe(false);
    menu.children[1].dispatchEvent(
      new f.dom.window.MouseEvent("pointerdown", {
        bubbles: true,
        composed: true,
      }),
    );
    expect(menu.hidden).toBe(false);
    menu.children[1].click();
    expect(trigger.textContent).toContain("Other destination");
    expect(menu.hidden).toBe(true);
    trigger.click();
    trigger.dispatchEvent(
      new f.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        composed: true,
      }),
    );
    expect(menu.hidden).toBe(true);
    expect(f.get(".panel").hidden).toBe(false);
    await f.get(".confirm").onclick({ isTrusted: true });
    expect(f.calls.find((call) => call.type === "capture")).toMatchObject({
      profileId: "other",
      profileRevision: 2,
    });
  } finally {
    f.dispose();
  }
});

it("collapses the actions without moving the dock and restores the same position in a new document", async () => {
  const preferences = { position: 0.3, locale: "zh" };
  const f = await fixture([connected()], preferences);
  let savedTop: string;
  try {
    expect(f.host.style.visibility).toBe("visible");
    await f.click("page");
    f.get('[role="combobox"]').click();
    const top = f.host.style.top;
    await f.click("collapse");
    expect(f.get(".actions").hidden).toBe(true);
    expect(f.get(".panel").hidden).toBe(true);
    expect(f.get('[role="listbox"]').hidden).toBe(true);
    expect(f.get(".collapse").getAttribute("aria-label")).toBe("展开工具条");
    expect(f.host.style.top).toBe(top);
    f.get(".handle").onkeydown({ key: "ArrowDown", preventDefault() {} });
    await flush();
    savedTop = f.host.style.top;
    await f.click("collapse");
    expect(f.get(".actions").hidden).toBe(false);
    expect(f.host.style.top).toBe(savedTop);
  } finally {
    f.dispose();
  }
  const reopened = await fixture([], preferences);
  try {
    expect(reopened.host.style.top).toBe(savedTop!);
  } finally {
    reopened.dispose();
  }
});

it("reports a failed position write and preserves the previous cached value", async () => {
  const preferences = { position: 0.3, locale: "zh" };
  const f = await fixture([], preferences, true);
  try {
    f.get(".handle").onkeydown({ key: "ArrowDown", preventDefault() {} });
    await flush();
    expect(f.get(".panel").hidden).toBe(false);
    expect(f.get(".status").textContent).toContain("位置未能保存");
    expect(preferences.position).toBe(0.3);
  } finally {
    f.dispose();
  }
});
