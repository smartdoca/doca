(() => {
  if (globalThis.docaContentScriptInstalled) return;
  globalThis.docaContentScriptInstalled = true;
  const messages = {
    zh: {
      "dock.page": "收录当前页面",
      "dock.selection": "收录选中区域",
      "dock.assistant": "Doca 助手",
      "dock.settings": "设置",
      "dock.drag": "上下拖动工具条，也可使用方向键",
      "dock.collapse": "收起工具条",
      "dock.expand": "展开工具条",
      "dock.close": "关闭",
      "dock.rule": "收录规则",
      "dock.confirm": "确认收录",
      "dock.loading": "正在读取收录规则…",
      "dock.saving": "正在收录…",
      "dock.saved": "已保存到 Doca",
      "dock.warnings": "有 {count} 处内容未完整处理，文档已保留占位",
      "dock.open": "打开文档",
      "dock.login": "登录 Doca",
      "dock.setup": "打开设置",
      "dock.noProfiles": "请先设置收录规则",
      "dock.retry": "重试",
      "dock.failed": "收录未完成，请重试",
      "dock.failedWithCode": "收录未完成（错误代码：{code}）",
      clipper_too_many_pending:
        "未完成的收录任务过多，请重试已有任务或等待旧任务到期后重新收录。",
      "dock.connectionFailed": "暂时无法连接 Doca，请重试",
      "dock.selectionMissing": "请先选中需要收录的网页内容",
      "dock.updated": "插件已更新，请刷新当前网页",
      "dock.reload": "刷新网页",
      "dock.positionFailed": "位置未能保存，可重试拖动",
      "dock.images": "大图自动压缩，SVG 转为图片；无法保存的图片保留占位",
      "dock.create": "新建文档",
      "dock.append": "追加到文档",
      "dock.personal": "个人文档",
      "dock.default": "默认",
      "dock.compressionFailed": "图片压缩失败，收录尚未完成，请重试",
      "dock.animationLarge":
        "动图超过 20 MiB 或 2500 万像素，请选择更小的图片，不会转成静态图",
    },
    en: {
      "dock.page": "Capture this page",
      "dock.selection": "Capture selection",
      "dock.assistant": "Doca assistant",
      "dock.settings": "Settings",
      "dock.drag": "Drag vertically or use the arrow keys",
      "dock.collapse": "Collapse toolbar",
      "dock.expand": "Expand toolbar",
      "dock.close": "Close",
      "dock.rule": "Capture rule",
      "dock.confirm": "Confirm capture",
      "dock.loading": "Loading capture rules…",
      "dock.saving": "Capturing…",
      "dock.saved": "Saved to Doca",
      "dock.warnings":
        "{count} items could not be fully processed; placeholders were saved",
      "dock.open": "Open document",
      "dock.login": "Sign in to Doca",
      "dock.setup": "Open settings",
      "dock.noProfiles": "Set up a capture rule first",
      "dock.retry": "Retry",
      "dock.failed": "Capture incomplete. Please retry.",
      "dock.failedWithCode": "Capture incomplete (error code: {code}).",
      clipper_too_many_pending:
        "Too many unfinished captures. Retry an existing capture or wait for old tasks to expire.",
      "dock.connectionFailed": "Could not connect to Doca. Please retry.",
      "dock.selectionMissing": "Select the webpage content to capture first",
      "dock.updated": "The extension was updated. Reload this page.",
      "dock.reload": "Reload page",
      "dock.positionFailed": "Could not save the position. Drag to retry.",
      "dock.images":
        "Large images compressed; SVG converted; unavailable images marked",
      "dock.create": "New document",
      "dock.append": "Append to document",
      "dock.personal": "Personal documents",
      "dock.default": "Default",
      "dock.compressionFailed":
        "Image compression failed. Capture is incomplete; please retry.",
      "dock.animationLarge":
        "The animation exceeds 20 MiB or 25 million pixels. Choose a smaller image; it will not be flattened.",
    },
  };
  let locale = "zh",
    snapshot = null,
    selectedRange = null,
    mode = "page",
    prepared = null,
    preparedReady = false,
    state = null,
    busy = false,
    panelGeneration = 0,
    positionRatio = 0.5,
    collapsed = false,
    expandedHeight = 0,
    positionTouched = false,
    drag = null;
  const t = (key) => messages[locale][key];
  const send = async (message) => {
    if (!chrome.runtime?.id) throw Error("Extension context invalidated");
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw Error(result?.error || "clipper_connection_failed");
    return result.value;
  };
  const host = document.createElement("div");
  host.dataset.docaCaptureUi = "true";
  host.style.cssText =
    "position:fixed;right:12px;top:40%;z-index:2147483646;pointer-events:none;visibility:hidden;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = [
    ":host{all:initial;color-scheme:light;--blue:#3370ff;--text:#263040;--muted:#748096;--line:#e4e9f1;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif}",
    "*{box-sizing:border-box}[hidden]{display:none!important}button,select,a{font:inherit}button,a,select{pointer-events:auto}button{cursor:pointer}button:disabled,select:disabled{cursor:wait;opacity:.6}",
    ".dock{position:relative;width:44px;padding:4px;background:#fff;border:1px solid var(--line);border-radius:13px;box-shadow:0 4px 18px #2134521a;pointer-events:auto}:host(.ready) .dock{animation:dock-enter .24s ease-out}.actions{animation:dock-actions .16s ease-out}",
    ".tool,.handle,.collapse{position:relative;display:grid;place-items:center;width:34px;height:38px;padding:0;border:0;border-radius:8px;color:#64718a;background:transparent;transition:background .16s,color .16s,transform .12s}",
    ".tool:hover,.tool:focus-visible,.collapse:hover,.collapse:focus-visible{background:#edf3ff;color:var(--blue)}.tool:active,.collapse:active{transform:scale(.94)}.tool[aria-expanded=true]{background:#edf3ff;color:var(--blue)}.assistant{color:var(--blue)}",
    ".handle{height:24px;color:#5c6e88;background:#edf1f7;border:1px solid #dde4ee;cursor:grab;touch-action:none;transition:background .16s}.handle:hover{color:#405574;background:#e3eaf5}.handle:active{cursor:grabbing}.dragging .dock{box-shadow:0 8px 28px #21345230}.divider{height:1px;background:#edf0f5;margin:4px 2px}",
    "svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.handle svg{width:18px;height:18px;stroke-width:2.4}",
    ".collapse{margin-top:4px;border-top:1px solid #edf0f5;border-radius:0 0 8px 8px}.collapse svg{width:16px;height:16px}",
    ".tip{position:absolute;right:calc(100% + 14px);top:50%;transform:translateY(-50%) translateX(3px);padding:5px 9px;background:#263040;color:#fff;font-size:12px;line-height:1.5;border-radius:6px;white-space:nowrap;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .13s,transform .13s}",
    ".tool:hover .tip,.tool:focus-visible .tip,.handle:focus-visible .tip{opacity:1;visibility:visible;transform:translateY(-50%) translateX(0)}.tool[aria-expanded=true] .tip{visibility:hidden}",
    ".panel{position:fixed;right:68px;width:min(300px,calc(100vw - 84px));max-height:calc(100vh - 24px);overflow:auto;padding:16px;background:#fff;color:var(--text);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px #24365024;pointer-events:auto;animation:panel-enter .18s ease-out;transform-origin:right center}",
    ".heading{display:flex;align-items:center;gap:8px;margin-bottom:14px}.heading strong{flex:1;font-size:15px;font-weight:600}.close{display:grid;place-items:center;border:0;border-radius:6px;width:25px;height:25px;padding:0;color:#8792a5;background:transparent}.close:hover{background:#f0f3f8}.close svg{width:16px;height:16px}",
    "label{display:block;color:#68758b;font-size:12px;margin-bottom:6px}.doca-select{display:block;min-width:0}.doca-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;height:40px;border:1px solid #dce3ee;border-radius:8px;padding:0 10px;background:#fff;color:var(--text);text-align:left}.doca-select-trigger>span:first-child{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.doca-select-arrow{width:6px;height:6px;border-right:1px solid #8792a5;border-bottom:1px solid #8792a5;transform:rotate(45deg);margin:-3px 3px 0 0;flex:none}.doca-select-trigger[aria-expanded=true]{border-color:var(--blue);box-shadow:0 0 0 3px #3370ff18}",
    ".doca-select-menu{position:fixed;z-index:20;padding:4px;border:1px solid var(--line);border-radius:9px;background:#fff;box-shadow:0 8px 24px #21345226;overflow:auto;pointer-events:auto;animation:dropdown-enter .14s ease-out}.doca-select-option{display:block;width:100%;min-height:34px;padding:7px 9px;text-align:left;border:0;border-radius:5px;background:#fff;color:var(--text);font-size:13px;line-height:1.5;overflow-wrap:anywhere}.doca-select-option.is-active,.doca-select-option:hover{background:#edf3ff}.doca-select-option[aria-selected=true]{color:var(--blue);font-weight:600}",
    ".detail{font-size:12px;line-height:1.6;color:var(--muted);margin:8px 0 14px;overflow-wrap:anywhere}.status{font-size:13px;line-height:1.6;overflow-wrap:anywhere;margin:0 0 12px}.status:empty{display:none}.status.success{color:#26815b}.status.error{color:#b0443d}.status a{display:inline-block;margin-left:8px;color:var(--blue);text-decoration:none}",
    ".confirm{width:100%;height:39px;border:0;border-radius:8px;background:var(--blue);color:#fff;font-weight:500;transition:background .16s,transform .12s}.confirm:hover{background:#2862e9}.confirm:active{transform:scale(.98)}button:focus-visible,a:focus-visible{outline:2px solid #3370ff;outline-offset:3px}",
    "@keyframes dock-enter{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}@keyframes panel-enter{from{opacity:0;transform:translateX(5px) scale(.98)}to{opacity:1;transform:translateX(0) scale(1)}}@keyframes dropdown-enter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}@keyframes dock-actions{from{opacity:0}to{opacity:1}}",
    "@media(max-height:260px){.tool{height:30px}.handle{height:14px}.panel{padding:12px}.heading{margin-bottom:8px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}",
  ].join("\n");
  const svg = (paths) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of paths) {
      const child = document.createElementNS(node.namespaceURI, tag);
      for (const [key, value] of Object.entries(attrs))
        child.setAttribute(key, value);
      node.append(child);
    }
    return node;
  };
  const icons = {
    page: [
      ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 3 }],
      ["path", { d: "M3 9h18M7 6.5h.01M10 6.5h.01m-3 7h10m-10 3h7" }],
    ],
    selection: [
      [
        "path",
        {
          d: "M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m8 0h4a1 1 0 0 0 1-1v-4M8 8h8v8H8Z",
        },
      ],
    ],
    assistant: [
      [
        "path",
        {
          d: "m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6ZM20 2v4m-2-2h4",
        },
      ],
    ],
    settings: [
      [
        "path",
        {
          d: "m9 3-.6 2.2-1.7 1L4.5 6l-2 3.5L4 11v2l-1.5 1.5 2 3.5 2.2-.2 1.7 1L9 21h4l.6-2.2 1.7-1 2.2.2 2-3.5L18 13v-2l1.5-1.5-2-3.5-2.2.2-1.7-1L13 3Z",
        },
      ],
      ["circle", { cx: 11, cy: 12, r: 3 }],
    ],
  };
  const dock = document.createElement("div");
  dock.className = "dock";
  dock.setAttribute("role", "toolbar");
  dock.setAttribute("aria-label", "Doca");
  const buttons = new Map();
  const button = (name, paths, className = "tool") => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.dataset.action = name;
    const tip = document.createElement("span");
    tip.className = "tip";
    node.append(svg(paths), tip);
    buttons.set(name, node);
    return node;
  };
  const handle = button(
    "drag",
    [
      [
        "path",
        { d: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" },
      ],
    ],
    "handle",
  );
  dock.append(handle);
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.id = "doca-dock-actions";
  dock.append(actions);
  for (const name of ["page", "selection", "assistant", "settings"]) {
    if (name === "settings") {
      const line = document.createElement("div");
      line.className = "divider";
      actions.append(line);
    }
    actions.append(
      button(
        name,
        icons[name],
        "tool" + (name === "assistant" ? " assistant" : ""),
      ),
    );
  }
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "collapse";
  collapse.dataset.action = "collapse";
  collapse.setAttribute("aria-controls", actions.id);
  dock.append(collapse);
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "doca-dock-heading");
  const heading = document.createElement("div");
  heading.className = "heading";
  const title = document.createElement("strong");
  title.id = "doca-dock-heading";
  const close = document.createElement("button");
  close.className = "close";
  close.append(svg([["path", { d: "m6 6 12 12M6 18 18 6" }]]));
  heading.append(title, close);
  const fields = document.createElement("div");
  const label = document.createElement("label");
  label.htmlFor = "doca-dock-profile";
  const profiles = document.createElement("select");
  profiles.id = label.htmlFor;
  const detail = document.createElement("p");
  detail.className = "detail";
  fields.append(label, profiles, detail);
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const confirm = document.createElement("button");
  confirm.className = "confirm";
  panel.append(heading, fields, status, confirm);
  shadow.append(style, dock, panel);
  document.documentElement.append(host);
  const dropdown = globalThis.DocaSelect.enhance(profiles);
  function translate() {
    for (const [name, node] of buttons) {
      node.setAttribute("aria-label", t("dock." + name));
      node.querySelector(".tip").textContent = t("dock." + name);
    }
    close.setAttribute("aria-label", t("dock.close"));
    label.textContent = t("dock.rule");
    profiles.setAttribute("aria-label", t("dock.rule"));
    dropdown.sync();
    collapse.setAttribute(
      "aria-label",
      t(collapsed ? "dock.expand" : "dock.collapse"),
    );
    collapse.setAttribute(
      "title",
      t(collapsed ? "dock.expand" : "dock.collapse"),
    );
    collapse.setAttribute("aria-expanded", String(!collapsed));
    collapse.replaceChildren(
      svg([["path", { d: collapsed ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6" }]]),
    );
  }
  function verticalSpace() {
    if (!collapsed) expandedHeight = dock.getBoundingClientRect().height;
    return Math.max(0, innerHeight - expandedHeight - 24);
  }
  function position() {
    host.style.top = 12 + positionRatio * verticalSpace() + "px";
    if (!panel.hidden) {
      const anchor =
        buttons.get(mode)?.getBoundingClientRect() ||
        dock.getBoundingClientRect();
      panel.style.top =
        Math.max(
          12,
          Math.min(innerHeight - panel.offsetHeight - 12, anchor.top - 12),
        ) + "px";
    }
  }
  function dismiss() {
    if (busy) return;
    dropdown.close();
    panel.hidden = true;
    panelGeneration++;
    for (const node of buttons.values())
      node.setAttribute("aria-expanded", "false");
  }
  collapse.onclick = (event) => {
    if (!event.isTrusted || busy) return;
    dismiss();
    verticalSpace();
    collapsed = !collapsed;
    actions.hidden = collapsed;
    dock.classList.toggle("collapsed", collapsed);
    translate();
    position();
  };
  function showStatus(message, error = false) {
    status.textContent = message;
    status.className = "status" + (error ? " error" : "");
    position();
  }
  function rememberSelection() {
    const selection = window.getSelection();
    if (
      selection?.rangeCount &&
      !selection.isCollapsed &&
      !host.contains(selection.anchorNode) &&
      !shadow.contains(selection.anchorNode) &&
      !selection.anchorNode?.parentElement?.closest(
        "input,textarea,[contenteditable=true]",
      )
    ) {
      selectedRange = selection.getRangeAt(0).cloneRange();
    } else if (panel.hidden) selectedRange = null;
  }
  function selectionCapture() {
    const range = selectedRange;
    if (!range || range.collapsed || !range.commonAncestorContainer.isConnected)
      throw Error("clipper_selection_missing");
    return globalThis.DocaCapture.capture("selection", range);
  }
  function errorText(error) {
    if (/Extension context invalidated/i.test(error.message))
      return t("dock.updated");
    if (error.message === "clipper_selection_missing")
      return t("dock.selectionMissing");
    if (error.message === "clipper_connection_failed")
      return t("dock.connectionFailed");
    if (error.message === "clipper_image_compression_failed")
      return t("dock.compressionFailed");
    if (error.message === "clipper_animated_image_too_large")
      return t("dock.animationLarge");
    if (messages[locale][error.message]) return t(error.message);
    return /^clipper_[a-z0-9_]{1,120}$/.test(error.message)
      ? t("dock.failedWithCode").replace("{code}", error.message)
      : error.message;
  }
  function profileDetail() {
    const profile = state?.profiles.find((row) => row.id === profiles.value);
    detail.textContent = profile
      ? [
          t(profile.strategy === "append" ? "dock.append" : "dock.create"),
          profile.destinationTitle ||
            (profile.libraryId || profile.targetId ? "" : t("dock.personal")),
          t("dock.images"),
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    position();
  }
  const settings = () => send({ type: "openSettings" });
  async function loadState() {
    const generation = ++panelGeneration;
    confirm.disabled = true;
    profiles.disabled = true;
    fields.hidden = false;
    confirm.textContent = t("dock.confirm");
    showStatus(t("dock.loading"));
    try {
      const next = await send({ type: "state" });
      if (generation !== panelGeneration || panel.hidden) return;
      state = next;
      locale = next.locale === "en" ? "en" : "zh";
      translate();
      title.textContent = t("dock." + mode);
      profiles.replaceChildren();
      for (const profile of next.profiles) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.dataset.revision = String(profile.revision);
        option.textContent =
          profile.name + (profile.isDefault ? " · " + t("dock.default") : "");
        profiles.append(option);
      }
      profiles.value =
        next.profiles.find((row) => row.isDefault)?.id ||
        next.profiles[0]?.id ||
        "";
      profiles.disabled = false;
      confirm.disabled = false;
      confirm.onclick = capture;
      if (!next.connected) {
        fields.hidden = true;
        const needsSettings = [
          "clipper_not_connected",
          "clipper_invalid_config",
        ].includes(next.error);
        confirm.textContent = t(needsSettings ? "dock.setup" : "dock.login");
        showStatus(t("dock.connectionFailed"), true);
        confirm.onclick = async (event) => {
          if (!event.isTrusted) return;
          confirm.disabled = true;
          try {
            if (needsSettings) await settings();
            else {
              await send({ type: "login" });
              await loadState();
            }
          } catch (error) {
            showStatus(errorText(error), true);
          } finally {
            confirm.disabled = false;
          }
        };
      } else if (!next.profiles.length) {
        fields.hidden = true;
        showStatus(t("dock.noProfiles"));
        confirm.textContent = t("dock.setup");
        confirm.onclick = (event) => {
          if (event.isTrusted)
            void settings().catch((error) =>
              showStatus(errorText(error), true),
            );
        };
      } else {
        confirm.textContent = t("dock.confirm");
        showStatus("");
        profileDetail();
      }
    } catch (error) {
      if (generation !== panelGeneration || panel.hidden) return;
      fields.hidden = true;
      showStatus(errorText(error), true);
      confirm.disabled = false;
      const invalidated = /Extension context invalidated/i.test(error.message);
      confirm.textContent = t(invalidated ? "dock.reload" : "dock.retry");
      confirm.onclick = (event) => {
        if (event.isTrusted) invalidated ? location.reload() : void loadState();
      };
    }
    position();
  }
  async function capture(event) {
    if (!event.isTrusted || busy) return;
    const profile = state?.profiles.find((row) => row.id === profiles.value);
    if (!profile) return;
    busy = true;
    handle.disabled = collapse.disabled = true;
    dropdown.close();
    confirm.disabled = profiles.disabled = true;
    dropdown.sync();
    confirm.textContent = t("dock.saving");
    showStatus("");
    try {
      prepared ||= globalThis.DocaCapture.capture("page");
      snapshot = prepared;
      if (!preparedReady) {
        prepared = await send({ type: "prepareCapture", capture: prepared });
        snapshot = prepared;
        preparedReady = true;
      }
      const result = await send({
        type: "capture",
        capture: prepared,
        profileId: profile.id,
        profileRevision: profile.revision,
      });
      fields.hidden = true;
      status.textContent = t("dock.saved");
      status.className = "status success";
      const link = document.createElement("a");
      link.href = result.url;
      link.textContent = t("dock.open");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      status.append(link);
      if (result.warnings?.length) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = t("dock.warnings").replace(
          "{count}",
          result.warnings.length,
        );
        const list = document.createElement("ul");
        for (const warning of result.warnings) {
          const item = document.createElement("li");
          item.textContent = warning.message;
          list.append(item);
        }
        details.append(summary, list);
        status.append(details);
      }
      confirm.hidden = true;
    } catch (error) {
      showStatus(errorText(error), true);
      confirm.textContent = t("dock.retry");
    } finally {
      busy = false;
      handle.disabled = collapse.disabled = false;
      confirm.disabled = profiles.disabled = false;
      dropdown.sync();
      position();
    }
  }
  function openCapture(name, event) {
    if (!event.isTrusted || busy) return;
    if (!panel.hidden && mode === name) {
      dismiss();
      return;
    }
    rememberSelection();
    mode = name;
    prepared = null;
    preparedReady = false;
    panel.hidden = false;
    fields.hidden = false;
    confirm.hidden = false;
    title.textContent = t("dock." + mode);
    for (const [key, node] of buttons)
      node.setAttribute("aria-expanded", String(key === name));
    position();
    if (name === "selection") {
      try {
        prepared = snapshot = selectionCapture();
      } catch (error) {
        panelGeneration++;
        fields.hidden = true;
        confirm.hidden = true;
        showStatus(errorText(error), true);
        return;
      }
    }
    void loadState();
  }
  buttons.get("page").onclick = (event) => openCapture("page", event);
  buttons.get("selection").onclick = (event) => openCapture("selection", event);
  buttons.get("settings").onclick = (event) => {
    if (event.isTrusted)
      void settings().catch((error) => {
        mode = "settings";
        panel.hidden = false;
        fields.hidden = confirm.hidden = true;
        title.textContent = t("dock.settings");
        showStatus(errorText(error), true);
      });
  };
  buttons.get("assistant").onclick = (event) => {
    if (!event.isTrusted) return;
    dismiss();
    // The native side panel must open directly from this click, before any awaits.
    void send({ type: "openAssistant" }).catch((error) => {
      mode = "assistant";
      panel.hidden = false;
      fields.hidden = confirm.hidden = true;
      title.textContent = t("dock.assistant");
      showStatus(errorText(error), true);
    });
  };
  close.onclick = dismiss;
  profiles.onchange = profileDetail;
  shadow.addEventListener("mousedown", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("button") &&
      !event.target.closest('[role="combobox"],[role="option"]')
    )
      event.preventDefault();
  });
  document.addEventListener("selectionchange", rememberSelection);
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.composedPath().includes(host)) dismiss();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key === "Escape" &&
        shadow.querySelector(".doca-select-menu").hidden
      )
        dismiss();
    },
    true,
  );
  async function savePosition() {
    try {
      await send({
        type: "dockPreferences",
        operation: "set",
        position: positionRatio,
      });
    } catch {
      mode = "drag";
      panel.hidden = false;
      fields.hidden = confirm.hidden = true;
      title.textContent = "Doca";
      showStatus(t("dock.positionFailed"), true);
    }
  }
  handle.onpointerdown = (event) => {
    if (!event.isTrusted || event.button !== 0 || busy) return;
    event.preventDefault();
    dismiss();
    positionTouched = true;
    drag = {
      pointerId: event.pointerId,
      y: event.clientY,
      top: host.getBoundingClientRect().top,
    };
    handle.setPointerCapture(event.pointerId);
    host.classList.add("dragging");
  };
  handle.onpointermove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const space = verticalSpace();
    const top = Math.max(
      12,
      Math.min(12 + space, drag.top + event.clientY - drag.y),
    );
    positionRatio = space ? (top - 12) / space : 0;
    position();
  };
  handle.onpointerup = handle.onpointercancel = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    host.classList.remove("dragging");
    if (handle.hasPointerCapture(event.pointerId))
      handle.releasePointerCapture(event.pointerId);
    void savePosition();
  };
  handle.onkeydown = (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || busy)
      return;
    event.preventDefault();
    dismiss();
    positionTouched = true;
    const space = verticalSpace();
    positionRatio =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 1
          : Math.max(
              0,
              Math.min(
                1,
                positionRatio +
                  (event.key === "ArrowUp" ? -20 : 20) / Math.max(1, space),
              ),
            );
    position();
    void savePosition();
  };
  addEventListener("resize", () => {
    dropdown.close();
    position();
  });
  translate();
  position();
  void send({ type: "dockPreferences", operation: "get" })
    .then((preferences) => {
      locale = preferences.locale === "en" ? "en" : "zh";
      translate();
      if (!positionTouched && preferences.position !== null)
        positionRatio = preferences.position;
      position();
    })
    .catch(() => {})
    .finally(() => {
      host.style.visibility = "visible";
      host.classList.add("ready");
    });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "snapshot") {
      try {
        rememberSelection();
        snapshot = globalThis.DocaCapture.capture(
          message.mode,
          message.mode === "selection" ? selectedRange : null,
        );
        respond({ ok: true, value: snapshot });
      } catch (error) {
        respond({ ok: false, error: error.message });
      }
    }
    if (message.type === "image") {
      const image = snapshot?.images.find(
        (image) => image.id === message.id && image.url === message.url,
      );
      if (!image) {
        respond({ ok: false, error: "clipper_image_unlisted" });
        return;
      }
      const respondImage = (bytes) => {
        let binary = "";
        for (let start = 0; start < bytes.length; start += 8192)
          binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        respond({ ok: true, value: btoa(binary) });
      };
      if (message.convertSvg) {
        // Reuse extension-fetched bytes: page fetch would impose CDN CORS.
        void (async () => {
          if (
            typeof message.source !== "string" ||
            message.source.length > Math.ceil((32 * 1024 ** 2) / 3) * 4
          )
            throw Error("clipper_image_invalid");
          const bytes = Uint8Array.from(atob(message.source), (char) =>
            char.charCodeAt(0),
          );
          if (!bytes.length || bytes.length > 32 * 1024 ** 2)
            throw Error("clipper_image_invalid");
          respondImage(await globalThis.DocaSvgImage.rasterize(bytes));
        })().catch((error) => respond({ ok: false, error: error.message }));
        return true;
      }
      fetch(image.url, {
        credentials: "include",
        signal: AbortSignal.timeout(15000),
      })
        .then(async (response) => {
          if (!response.ok) throw Error("clipper_image_failed");
          const limit = 64 * 1024 ** 2;
          if (
            Number(response.headers.get("content-length")) > limit ||
            !response.body
          )
            throw Error("clipper_image_invalid");
          const reader = response.body.getReader(),
            chunks = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > limit) {
                await reader.cancel();
                throw Error("clipper_image_invalid");
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          respondImage(bytes);
        })
        .catch((error) => respond({ ok: false, error: error.message }));
      return true;
    }
  });
})();
