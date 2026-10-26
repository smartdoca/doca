import { translate } from "./messages.js";
const loadAssistant = () => import("./generated/assistant.js");
const isSidebar = /^#assistant(?:\?|$)/.test(location.hash);
const isSettings = location.hash === "#settings";
const launchProfile = new URLSearchParams(location.hash.split("?")[1] || "");
let applyLaunchProfile = true,
  sharedAssistantModule = null,
  rejectedLaunchProfile = false;
const $ = (id) => document.getElementById(id);
let state = { locale: "zh", connected: false, profiles: [] },
  tab = isSidebar ? "assistant" : isSettings ? "connection" : "capture",
  busy = false,
  activeTab = null,
  renderedOrigin,
  pendingReference = null,
  rememberedProfile = null,
  stateLoading = null,
  stateGeneration = 0,
  stateRefreshQueued = false,
  interactiveStateQueued = false,
  stateErrorNotice = "";
let assistant = null,
  assistantKey = null,
  assistantConfig = null,
  assistantGeneration = 0,
  assistantLoading = null;
if (isSidebar) {
  document.body.classList.add("sidebar");
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "generated/assistant.css";
  document.head.append(css);
}
if (isSettings) document.body.classList.add("settings-page");
const dropdowns = [...document.querySelectorAll("select")].map((select) =>
  globalThis.DocaSelect.enhance(select),
);
const t = (key, params) => translate(state.locale, key, params);
let updateState = { status: "unconfigured" },
  updateOrigin,
  updateGeneration = 0,
  updateCheckedAt = 0;
function renderUpdates() {
  $("installed-version").textContent = t("updates.installed", {
    version: chrome.runtime.getManifest().version,
  });
  $("check-updates").disabled = !state.origin || updateState.status === "checking";
  $("extension-update").hidden = updateState.status !== "available";
  $("update-message").textContent = updateState.status === "available"
    ? t("updates.available", { current: updateState.currentVersion, latest: updateState.latestVersion })
    : "";
  $("update-status").textContent = t("updates." + updateState.status, {
    current: updateState.currentVersion,
    latest: updateState.latestVersion,
  });
  for (const id of ["update-download", "download-page"]) {
    $(id).hidden = !state.origin;
    if (state.origin) $(id).href = state.origin + "/#/browser-assistant";
    else $(id).removeAttribute("href");
  }
}
async function refreshUpdates(force = false) {
  const origin = state.origin;
  if (!force && origin === updateOrigin && Date.now() - updateCheckedAt < 300_000) {
    renderUpdates();
    return;
  }
  updateOrigin = origin;
  updateCheckedAt = Date.now();
  const generation = ++updateGeneration;
  updateState = { status: origin ? "checking" : "unconfigured" };
  renderUpdates();
  if (!origin) return;
  try {
    const result = await send({ type: "checkForUpdates" });
    if (generation !== updateGeneration || state.origin !== origin) return;
    updateState = result.origin === origin ? result : { status: "failed" };
  } catch {
    if (generation !== updateGeneration || state.origin !== origin) return;
    updateState = { status: "failed" };
  }
  renderUpdates();
}
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok)
    throw Object.assign(Error(result?.error || "clipper_connection_failed"), {
      status: result?.status,
    });
  return result.value;
}
function notice(message = "", success = false, url) {
  const node = $("notice");
  node.replaceChildren();
  node.hidden = !message;
  node.className = success ? "success" : "";
  node.append(document.createTextNode(message));
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = t("open");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    node.append(link);
  }
}
function errorMessage(error) {
  const translated = t(error.message);
  return translated === error.message && error.message.startsWith("clipper_")
    ? t("generalError")
    : translated;
}
function savedNotice(result) {
  notice(t("saved"), true, result.url);
  if (!result.warnings?.length) return;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = t("captureWarnings").replace(
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
  $("notice").append(details);
}
function selectTab(value) {
  tab = value;
  for (const item of ["capture", "assistant", "connection"]) {
    $(item + "-pane").hidden = item !== value;
  }
  $("back").hidden = isSettings || value !== "connection" || !state.connected;
  $("settings").hidden = value === "connection";
  if (value === "assistant")
    void syncAssistant().catch((error) => notice(errorMessage(error)));
}
function pageReference() {
  const capture =
    pendingReference &&
    pendingReference.tabId === activeTab?.id &&
    pendingReference.capture?.url === activeTab?.url &&
    pendingReference.capture?.mode === "selection" &&
    pendingReference.origin === state.origin &&
    pendingReference.connectionId === state.connectionId &&
    pendingReference.profileId === $("ai-profile").value
      ? pendingReference.capture
      : null;
  const url = capture?.url || activeTab?.url || "";
  return /^https?:\/\//.test(url)
    ? {
        title:
          (capture?.mode === "selection"
            ? t("selectionReference") + " · "
            : "") +
          (capture?.title || activeTab?.title || new URL(url).hostname),
        url,
      }
    : { title: t("pageUnavailable"), url: "" };
}
function renderReference() {
  void syncAssistant().catch((error) => notice(errorMessage(error)));
}
async function syncAssistant() {
  if (!isSidebar) return;
  const profile = state.profiles.find(
    (profile) => profile.id === $("ai-profile").value,
  );
  if (!state.connected || !state.assistantEnabled || !profile) {
    assistantGeneration++;
    assistant?.unmount();
    assistant = null;
    assistantKey = null;
    assistantConfig = null;
    $("assistant-root").textContent = state.connected
      ? t(
          !state.assistantEnabled
            ? "aiDisabled"
            : rejectedLaunchProfile
              ? "clipper_profile_changed"
              : "noProfiles",
        )
      : "";
    return;
  }
  const key = JSON.stringify([
    state.origin,
    state.connectionId,
    state.user.id,
    profile.id,
    profile.revision,
  ]);
  const page = pageReference();
  if (key === assistantKey) {
    if (!assistant) await assistantLoading;
    if (
      assistant &&
      (JSON.stringify(assistantConfig.page) !== JSON.stringify(page) ||
        assistantConfig.locale !== state.locale)
    ) {
      assistantConfig = { ...assistantConfig, page, locale: state.locale };
      assistant.update(assistantConfig);
    }
    return;
  }
  assistantKey = key;
  const generation = ++assistantGeneration;
  assistant?.unmount();
  assistant = null;
  assistantConfig = null;
  const scope = {
    origin: state.origin,
    connectionId: state.connectionId,
    profileId: profile.id,
  };
  assistantLoading = send({
    type: "assistantSession",
    ...scope,
    operation: "get",
  });
  let initial;
  try {
    initial = await assistantLoading;
  } catch (error) {
    if (generation === assistantGeneration) assistantKey = null;
    throw error;
  }
  if (generation !== assistantGeneration) return;
  const config = {
    origin: state.origin,
    connectionId: state.connectionId,
    userId: state.user.id,
    userName: state.user.name,
    locale: state.locale,
    sessionId: initial.sessionId,
    profile: { id: profile.id, revision: profile.revision, name: profile.name },
    page: pageReference(),
    request: async (path, method = "GET", body, signal) => {
      signal?.throwIfAborted();
      if (!path.startsWith("/ai/")) throw Error("clipper_scope_denied");
      const result = await send({
        type: "assistantRequest",
        ...scope,
        path: "/assistant/ui/" + path.slice(4),
        method,
        body,
      });
      signal?.throwIfAborted();
      return result;
    },
    captureCurrentPage: async () => {
      // Query again at send time; tab events may still be queued.
      await refreshTab();
      return send({
        type: "assistantPreparePage",
        ...scope,
        profileRevision: profile.revision,
        tabId: activeTab?.id,
      });
    },
    onSessionChange: (id) => {
      void send({
        type: "assistantSession",
        ...scope,
        operation: "set",
        id,
      }).catch((error) => {
        if (generation === assistantGeneration) notice(errorMessage(error));
      });
    },
    openDoca: (href) => {
      const url = new URL(href);
      if (["https:", "http:"].includes(url.protocol))
        void chrome.tabs.create({ url: url.href });
    },
  };
  const module = await (sharedAssistantModule ||= loadAssistant());
  if (generation !== assistantGeneration) return;
  config.page = pageReference();
  config.locale = state.locale;
  $("assistant-root").replaceChildren();
  assistantConfig = config;
  assistant = module.mountBrowserAssistant($("assistant-root"), config);
}
function render() {
  document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-label]").forEach((node) => {
    node.textContent = t(node.dataset.label);
  });
  document.querySelectorAll("[data-placeholder]").forEach((node) => {
    node.placeholder = t(node.dataset.placeholder);
  });
  $("locale").value = state.locale;
  $("settings").title = $("settings").ariaLabel = t("extensionSettings");
  $("back").title = $("back").ariaLabel = t("back");
  if (renderedOrigin !== state.origin) {
    $("endpoint").value = state.origin || "";
    renderedOrigin = state.origin;
  }
  $("identity").textContent = state.connected
    ? state.user.name
    : t("assistant");
  $("connection-heading").textContent = t(
    state.connected ? "replace" : "notConnected",
  );
  $("connection-detail").textContent = state.connected
    ? `${state.user.name}\n${state.origin}`
    : "";
  for (const id of ["profile", "ai-profile"]) {
    const select = $(id),
      previous =
        select.value ||
        (rememberedProfile &&
        rememberedProfile.origin === state.origin &&
        rememberedProfile.connectionId === state.connectionId
          ? rememberedProfile.id
          : "");
    select.replaceChildren();
    if (!state.profiles.length || rejectedLaunchProfile) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t(
        rejectedLaunchProfile ? "selectProfile" : "noProfiles",
      );
      option.disabled = true;
      select.append(option);
    }
    for (const profile of state.profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent =
        profile.name + (profile.isDefault ? ` · ${t("defaultProfile")}` : "");
      select.append(option);
    }
    select.value = rejectedLaunchProfile
      ? ""
      : state.profiles.some((profile) => profile.id === previous)
        ? previous
        : (
            state.profiles.find((profile) => profile.isDefault) ||
            state.profiles[0]
          )?.id || "";
  }
  if (applyLaunchProfile && state.connected) {
    applyLaunchProfile = false;
    const id = launchProfile.get("profileId"),
      revision = launchProfile.get("profileRevision");
    if (id) {
      const chosen = state.profiles.find((profile) => profile.id === id);
      if (chosen && String(chosen.revision) === revision)
        $("profile").value = $("ai-profile").value = id;
      else {
        rejectedLaunchProfile = true;
        for (const key of ["profile", "ai-profile"]) {
          const select = $(key),
            option = document.createElement("option");
          option.value = "";
          option.disabled = true;
          option.textContent = t("selectProfile");
          select.prepend(option);
          select.value = "";
        }
        notice(t("clipper_profile_changed"));
      }
    }
  }
  $("settings-link").href = state.origin
    ? state.origin + "/#/browser-assistant"
    : "#";
  $("settings-link").hidden = !state.origin;
  for (const id of ["capture-page", "capture-selection"])
    $(id).disabled = busy || !state.connected || !$("profile").value;
  $("open-assistant").disabled =
    busy || !state.connected || !state.assistantEnabled || !$("profile").value;
  $("retry").hidden = !state.pending;
  $("open-assistant").hidden = !state.assistantEnabled;
  profileDetail();
  dropdowns.forEach((dropdown) => dropdown.sync());
  if (!state.connected) {
    const desired = tab;
    selectTab("connection");
    tab = desired;
    void syncAssistant();
  } else selectTab(tab);
  void refreshUpdates();
}
function profileDetail() {
  const profile = state.profiles.find(
    (profile) => profile.id === $("profile").value,
  );
  $("profile-detail").textContent = profile
    ? state.locale === "zh"
      ? `${profile.strategy === "append" ? "追加到文档" : "新建文档"} · ${profile.destinationTitle || (profile.libraryId || profile.targetId ? "保存位置不可用" : "个人文档")}\n${t("captureImagePolicy")}`
      : `${profile.strategy === "append" ? "Append" : "New document"} · ${profile.destinationTitle || (profile.libraryId || profile.targetId ? "Destination unavailable" : "Personal documents")}\n${t("captureImagePolicy")}`
    : t("noProfiles");
}
function rememberProfile() {
  if (state.connected && $("profile").value)
    rememberedProfile = {
      origin: state.origin,
      connectionId: state.connectionId,
      id: $("profile").value,
    };
}
function loadState(interactive = false) {
  stateRefreshQueued = true;
  interactiveStateQueued ||= interactive;
  if (stateLoading || busy) return stateLoading || Promise.resolve();
  stateLoading = (async () => {
    while (stateRefreshQueued && !busy) {
      const interactive = interactiveStateQueued;
      const generation = stateGeneration;
      stateRefreshQueued = interactiveStateQueued = false;
      const result = await send({ type: "state", interactive }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      if (generation !== stateGeneration || busy) {
        stateRefreshQueued = true;
        if (busy) break;
        continue;
      }
      if ("error" in result) throw result.error;
      rememberProfile();
      state = result.value;
      render();
      if (state.error) {
        stateErrorNotice = errorMessage({ message: state.error });
        notice(stateErrorNotice);
      } else {
        if (stateErrorNotice && $("notice").textContent === stateErrorNotice)
          notice();
        stateErrorNotice = "";
      }
    }
  })().finally(() => {
    stateLoading = null;
    if (stateRefreshQueued && !busy) return loadState(false);
  });
  return stateLoading;
}
function refreshConnection() {
  void loadState(false).catch((error) => notice(errorMessage(error)));
}
async function action(work, label) {
  if (busy) return;
  stateGeneration++;
  rememberProfile();
  busy = true;
  render();
  notice(t(label));
  try {
    await work();
  } catch (error) {
    notice(errorMessage(error));
  } finally {
    stateGeneration++;
    busy = false;
    render();
    await loadState(false).catch(() => render());
  }
}
$("settings").onclick = () => selectTab("connection");
$("check-updates").onclick = () => void refreshUpdates(true);
$("back").onclick = () => selectTab(isSidebar ? "assistant" : "capture");
$("locale").onchange = () => {
  const locale = $("locale").value;
  return action(async () => {
    state = await send({ type: "locale", locale });
    render();
    notice();
  }, "working");
};
for (const id of ["profile", "ai-profile"])
  $(id).onchange = () => {
    rejectedLaunchProfile = false;
    const other = id === "profile" ? "ai-profile" : "profile";
    $(other).value = $(id).value;
    if (isSidebar) {
      const profile = state.profiles.find(
        (profile) => profile.id === $(id).value,
      );
      if (profile)
        history.replaceState(
          null,
          "",
          "#assistant?" +
            new URLSearchParams({
              profileId: profile.id,
              profileRevision: String(profile.revision),
            }),
        );
    }
    profileDetail();
    dropdowns.forEach((dropdown) => dropdown.sync());
    renderReference();
  };
$("login").onclick = () =>
  action(async () => {
    state = await send({ type: "login" });
    notice();
  }, "working");
$("endpoint-form").onsubmit = (event) => {
  event.preventDefault();
  const value = $("endpoint").value.trim();
  void action(async () => {
    const parsed = new URL(value);
    if (
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash
    )
      throw Error("clipper_invalid_origin");
    state = await send({
      type: "configure",
      config: JSON.stringify({ version: 2, origin: parsed.origin }),
    });
    pendingReference = null;
    notice(t("connected"), true);
  }, "working");
};
$("configure").onsubmit = (event) => {
  event.preventDefault();
  void action(async () => {
    state = await send({ type: "configure", config: $("config").value });
    $("config").value = "";
    pendingReference = null;
    tab = isSidebar ? "assistant" : isSettings ? "connection" : "capture";
    notice(t("connected"), true);
  }, "working");
};
for (const mode of ["page", "selection"])
  $("capture-" + mode).onclick = () =>
    action(async () => {
      const profile = state.profiles.find(
        (profile) => profile.id === $("profile").value,
      );
      const result = await send({
        type: "capture",
        mode,
        profileId: profile?.id,
        profileRevision: profile?.revision,
        tabId: activeTab?.id,
      });
      savedNotice(result);
    }, "saving");
$("retry").onclick = () =>
  action(async () => {
    const result = await send({ type: "retry" });
    savedNotice(result);
  }, "saving");
$("open-assistant").onclick = async () => {
  try {
    if (!activeTab?.id || !/^https?:\/\//.test(activeTab.url || ""))
      throw Error("clipper_page_unsupported");
    const profile = state.profiles.find(
      (profile) => profile.id === $("profile").value,
    );
    if (!profile) throw Error("clipper_profile_unavailable");
    const query = new URLSearchParams({
      profileId: profile.id,
      profileRevision: String(profile.revision),
    });
    // Issue both Chrome API calls while the click's user gesture is live.
    const configured = chrome.sidePanel.setOptions({
      tabId: activeTab.id,
      path: "ui.html#assistant?" + query,
      enabled: true,
    });
    const opened = chrome.sidePanel.open({ tabId: activeTab.id });
    await Promise.all([configured, opened]);
    window.close();
  } catch (error) {
    notice(errorMessage(error));
  }
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.assistantPending) {
    pendingReference = changes.assistantPending.newValue || null;
    renderReference();
  }
  const keys =
    area === "session"
      ? ["authorization", "lastError"]
      : area === "local"
        ? ["site", "locale"]
        : [];
  if (
    keys.some(
      (key) =>
        changes[key] &&
        JSON.stringify(changes[key].oldValue) !==
          JSON.stringify(changes[key].newValue),
    )
  )
    refreshConnection();
});
window.addEventListener("focus", refreshConnection);
setInterval(() => {
  if (document.visibilityState === "visible") void refreshUpdates();
}, 300_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshConnection();
});
async function refreshTab() {
  activeTab = (
    await chrome.tabs.query({ active: true, currentWindow: true })
  )[0];
  renderReference();
}
chrome.tabs.onActivated.addListener(() => void refreshTab());
chrome.tabs.onUpdated.addListener((id, change) => {
  if (
    id === activeTab?.id &&
    (change.url || change.title || change.status === "complete")
  )
    void refreshTab();
});
await refreshTab();
const commands = await chrome.commands.getAll();
$("shortcuts").textContent = commands
  .filter((command) => command.name.startsWith("capture-"))
  .map(
    (command) =>
      t(command.name === "capture-page" ? "page" : "selection") +
      ": " +
      (command.shortcut || "—"),
  )
  .join(" · ");
render();
await loadState(true);
pendingReference =
  (await chrome.storage.session.get("assistantPending")).assistantPending ||
  null;
renderReference();
