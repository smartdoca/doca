import {
  prepareCaptureImage,
  readCaptureImageResponse,
  MAX_IMAGE_SOURCE_BYTES,
  captureImageInfo,
} from "./image-processing.js";
import { translate } from "./messages.js";

// Source bytes stay in memory only; frozen tasks retain the existing URL manifest.
const preparedImages = new Map();
// Diagnostics live only for the current worker attempt, never in frozen tasks.
const captureWarnings = new Map();
const warningKey = (capture) =>
  JSON.stringify([capture.url, capture.capturedAt, capture.markdown]);
let preparedImageBytes = 0;
function cacheImage(image, data, convertedSvg) {
  const old = preparedImages.get(image.id);
  if (old) preparedImageBytes -= old.data.length;
  preparedImages.delete(image.id);
  while (
    preparedImageBytes + data.length > 100 * 1024 ** 2 &&
    preparedImages.size
  ) {
    const [id, entry] = preparedImages.entries().next().value;
    preparedImageBytes -= entry.data.length;
    preparedImages.delete(id);
  }
  preparedImages.set(image.id, { url: image.url, data, convertedSvg });
  preparedImageBytes += data.length;
}

const local = chrome.storage.local,
  session = chrome.storage.session;
const storageReady = Promise.all([
  local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
let booting,
  submitting,
  authenticating,
  interactiveLoginRequested = false;
function originOf(value) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("clipper_invalid_origin");
  return url.origin;
}
function validateConfig(config) {
  if (
    !config ||
    config.version !== 2 ||
    Object.keys(config).sort().join(",") !== "origin,version"
  )
    throw Error("clipper_invalid_config");
  originOf(config.origin);
  return config;
}
async function boot() {
  return (booting ||= (async () => {
    await storageReady;
    const site = (await local.get("site")).site;
    if (site) validateConfig(site);
    else {
      const packaged = await (
        await fetch(chrome.runtime.getURL("connection.json"))
      ).json();
      if (packaged !== null) {
        validateConfig(packaged);
        await local.set({ site: packaged });
      }
    }
    if (!(await local.get("installationId")).installationId)
      await local.set({ installationId: crypto.randomUUID() });
  })());
}
async function siteConfig() {
  await boot();
  const site = (await local.get("site")).site;
  if (!site) throw Error("clipper_not_connected");
  return validateConfig(site);
}
async function connection() {
  const site = await siteConfig(),
    auth = (await session.get("authorization")).authorization;
  if (!auth || auth.version !== 2 || auth.origin !== site.origin)
    throw Error("clipper_login_required");
  if (Date.parse(auth.expiresAt) <= Date.now())
    throw Error("clipper_token_expired");
  return auth;
}
async function rememberAuthorization(next) {
  const previous = (await session.get("authorization")).authorization;
  const cache = await session.get([
    "loginSnapshots",
    "pending",
    "assistantPending",
    "assistant",
    "assistantDraft",
    "lastAssistantSent",
  ]);
  const snapshots = cache.loginSnapshots || { version: 2, states: {} };
  if (snapshots.version !== 2) throw Error("clipper_invalid_config");
  if (previous)
    snapshots.states[previous.origin + "#" + previous.connectionId] =
      Object.fromEntries(
        [
          "pending",
          "assistantPending",
          "assistant",
          "assistantDraft",
          "lastAssistantSent",
        ].map((key) => [key, cache[key] || null]),
      );
  const restored = snapshots.states[next.origin + "#" + next.connectionId] || {
    pending: null,
    assistantPending: null,
    assistant: null,
    assistantDraft: null,
    lastAssistantSent: null,
  };
  await session.set({
    authorization: next,
    loginSnapshots: snapshots,
    ...restored,
    loginRequired: false,
    lastError: "",
    transfer: null,
  });
}
function startLogin(interactive) {
  if (authenticating) {
    interactiveLoginRequested ||= interactive;
    return authenticating;
  }
  interactiveLoginRequested = interactive;
  authenticating = (async () => {
    const site = await siteConfig(),
      installationId = (await local.get("installationId")).installationId;
    const verifier = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const challenge = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const state = crypto.randomUUID();
    let timer;
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(Error("clipper_login_required"));
      }, 180_000);
      globalThis.finishDocaLogin = (error, value) => {
        error ? reject(error) : resolve(value);
      };
    });
    // Avoid an unhandled rejection if a tab fails before the result is awaited.
    void result.catch(() => {});
    try {
      await session.set({
        loginFlow: {
          state,
          verifier,
          origin: site.origin,
          interactive: interactiveLoginRequested,
          expiresAt: Date.now() + 180_000,
        },
      });
      const tab = await chrome.tabs.create({
        url: "about:blank",
        active: false,
      });
      const flow = (await session.get("loginFlow")).loginFlow;
      if (flow?.state !== state) throw Error("clipper_login_required");
      await session.set({ loginFlow: { ...flow, tabId: tab.id } });
      await chrome.tabs.update(tab.id, {
        url:
          site.origin +
          "/#/browser-connect?" +
          new URLSearchParams({ state, challenge, installationId }),
      });
      return await result;
    } finally {
      clearTimeout(timer);
      await session.remove("loginFlow");
    }
  })().finally(() => {
    authenticating = null;
    interactiveLoginRequested = false;
    delete globalThis.finishDocaLogin;
  });
  return authenticating;
}
async function loginResult(message, sender) {
  const flow = (await session.get("loginFlow")).loginFlow;
  if (
    sender.id !== chrome.runtime.id ||
    !flow ||
    flow.state !== message.state ||
    flow.tabId !== sender.tab?.id ||
    flow.expiresAt <= Date.now() ||
    new URL(sender.url).origin !== flow.origin ||
    !new URL(sender.url).hash.startsWith("#/browser-connect?")
  )
    throw Error("clipper_scope_denied");
  if (message.status === "login-required") {
    const previous = (await session.get("authorization")).authorization;
    if (previous?.origin === flow.origin) {
      await fetch(flow.origin + "/api/v1/browser-clipper/disconnect", {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { Authorization: "Bearer " + previous.token },
      }).catch(() => {});
    }
    await session.set({ loginRequired: true });
    if (flow.interactive || interactiveLoginRequested) {
      await chrome.tabs.update(flow.tabId, { active: true });
      return { waiting: true };
    }
    await chrome.tabs.remove(flow.tabId).catch(() => {});
    await session.remove("loginFlow");
    globalThis.finishDocaLogin?.(Error("clipper_login_required"));
    return { waiting: false };
  }
  try {
    if (message.status !== "authorized" || !/^[a-f0-9]{64}$/.test(message.code))
      throw Error(message.error || "clipper_login_invalid");
    const response = await fetch(
      flow.origin + "/api/v1/browser-clipper/token",
      {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 2,
          code: message.code,
          verifier: flow.verifier,
        }),
      },
    );
    const next = await response.json();
    if (!response.ok) throw Error(next.message || "clipper_login_invalid");
    if (
      next.version !== 2 ||
      next.origin !== flow.origin ||
      !/^doca_browser_v2_[a-f0-9]{64}$/.test(next.token)
    )
      throw Error("clipper_invalid_config");
    await rememberAuthorization(next);
    const probe = await fetch(flow.origin + "/api/v1/browser-clipper/session", {
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer " + next.token },
    });
    const unavailable = !probe.ok && probe.status === 401;
    await session.set({
      cookieProbeUnsupported: unavailable,
      websiteProofAt: Date.now(),
    });
    await session.remove("loginFlow");
    await chrome.tabs.remove(flow.tabId).catch(() => {});
    globalThis.finishDocaLogin?.(null, next);
    return { connected: true };
  } catch (error) {
    await session.set({ lastError: error.message });
    await session.remove("loginFlow");
    await chrome.tabs.remove(flow.tabId).catch(() => {});
    globalThis.finishDocaLogin?.(error);
    throw error;
  }
}
async function authorizationIsCurrent(site, auth) {
  const currentSite = await siteConfig(),
    current = (await session.get("authorization")).authorization;
  if (currentSite.origin !== site.origin) return false;
  if (!auth || !current) return auth === current;
  return (
    current.version === auth.version &&
    current.origin === auth.origin &&
    current.connectionId === auth.connectionId &&
    current.token === auth.token &&
    current.expiresAt === auth.expiresAt
  );
}
async function ensureLogin(interactive = false) {
  const site = await siteConfig(),
    auth = (await session.get("authorization")).authorization;
  if (
    auth?.origin === site.origin &&
    Date.parse(auth.expiresAt) > Date.now() + 15_000
  ) {
    const proof = await session.get([
      "cookieProbeUnsupported",
      "websiteProofAt",
    ]);
    if (!(await authorizationIsCurrent(site, auth)))
      return ensureLogin(interactive);
    if (proof.cookieProbeUnsupported) {
      if (!interactive && Date.now() - (proof.websiteProofAt || 0) < 30_000)
        return auth;
      return startLogin(interactive);
    }
    const response = await fetch(
      site.origin + "/api/v1/browser-clipper/session",
      {
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: "Bearer " + auth.token },
      },
    );
    // A website probe belongs to the grant it started with. A late result must
    // not return an old account or start another login after a completed one.
    if (!(await authorizationIsCurrent(site, auth)))
      return ensureLogin(interactive);
    if (response.ok) return auth;
    const failure = await response.json();
    if (!(await authorizationIsCurrent(site, auth)))
      return ensureLogin(interactive);
    if (failure.message === "clipper_connection_revoked")
      throw Error(failure.message);
  }
  if (!interactive && (await session.get("loginRequired")).loginRequired) {
    const response = await fetch(site.origin + "/api/v1/bootstrap", {
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    });
    const signedIn = response.ok && (await response.json()).user;
    if (!(await authorizationIsCurrent(site, auth)))
      return ensureLogin(interactive);
    if (!signedIn) throw Error("clipper_login_required");
  }
  if (!(await authorizationIsCurrent(site, auth)))
    return ensureLogin(interactive);
  return startLogin(interactive);
}
const allowedPath =
  /^\/(?:me|profiles|clips(?:\/[a-f0-9-]{36}(?:\/commit|\/images\/[a-f0-9-]{36})?)?|assistant\/(?:options|sessions(?:\/[a-f0-9-]{36}(?:\/messages|\/events)?)?|jobs\/[a-f0-9-]{36}\/(?:cancel|approval)))$/;
async function request(path, method = "GET", body, binary = false, expected) {
  const uiPath =
    /^\/assistant\/ui\/(?:options|sessions(?:\/[a-f0-9-]{36}(?:\/messages)?)?|jobs\/[a-f0-9-]{36}\/(?:cancel|approval))(?:\?[^#]*)?$/;
  if (!allowedPath.test(path) && !uiPath.test(path))
    throw Error("clipper_scope_denied");
  let config = await connection();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (
      expected &&
      (expected.connectionId !== config.connectionId ||
        expected.origin !== config.origin)
    )
      throw Error("clipper_scope_denied");
    const response = await fetch(
      config.origin + "/api/v1/browser-clipper" + path,
      {
        method,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: "Bearer " + config.token,
          ...(body !== undefined
            ? {
                "Content-Type": binary
                  ? "application/octet-stream"
                  : "application/json",
              }
            : {}),
        },
        ...(body !== undefined
          ? { body: binary ? body : JSON.stringify(body) }
          : {}),
      },
    );
    const value = await response.json().catch(() => {
      throw Error("clipper_connection_failed");
    });
    if (response.ok) return value;
    const failure = Object.assign(
      Error(value.message || "clipper_connection_failed"),
      {
        status: response.status,
      },
    );
    if (response.status === 401 && attempt === 0) {
      let next;
      try {
        // A token exchange invalidates the old token before its replacement
        // reaches storage. Only an existing rotation may finish here.
        if (authenticating) await authenticating;
        next = await connection();
      } catch {
        throw failure;
      }
      if (
        next.origin === config.origin &&
        next.connectionId === config.connectionId &&
        next.token !== config.token
      ) {
        config = next;
        continue;
      }
    }
    throw failure;
  }
}
async function quickNoteRequest(message) {
  const operations = {
    quickNoteTargets: { path: "targets", fields: [] },
    quickNotePrepare: {
      path: "prepare",
      fields: ["requestId", "profileId", "profileRevision", "text"],
    },
    quickNoteCommit: { path: "commit", fields: ["requestId", "ticket"] },
  };
  const operation = operations[message.type],
    fields = ["type", "origin", "connectionId", ...operation.fields],
    uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    Object.keys(message).some((key) => !fields.includes(key)) ||
    typeof message.origin !== "string" ||
    typeof message.connectionId !== "string" ||
    (message.type !== "quickNoteTargets" &&
      (typeof message.requestId !== "string" ||
        !uuid.test(message.requestId))) ||
    (message.type === "quickNotePrepare" &&
      (typeof message.profileId !== "string" ||
        !uuid.test(message.profileId) ||
        !Number.isInteger(message.profileRevision) ||
        message.profileRevision < 1 ||
        typeof message.text !== "string" ||
        !message.text.trim() ||
        new TextEncoder().encode(message.text).byteLength > 64 * 1024)) ||
    (message.type === "quickNoteCommit" &&
      (typeof message.ticket !== "string" ||
        !/^[a-f0-9]{64}$/.test(message.ticket)))
  )
    throw Error("clipper_invalid_input");
  await ensureLogin(message.type !== "quickNoteTargets");
  const config = await connection();
  if (
    message.origin !== config.origin ||
    message.connectionId !== config.connectionId
  )
    throw Error("clipper_scope_denied");
  const body = operation.fields.length
    ? Object.fromEntries(operation.fields.map((key) => [key, message[key]]))
    : undefined;
  if (!(await authorizationIsCurrent(config, config)))
    throw Error("quick_note_signin_changed");
  const response = await fetch(
    config.origin + "/api/v1/browser-clipper/quick-note/" + operation.path,
    {
      method: body ? "POST" : "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: {
        Authorization: "Bearer " + config.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  // Tickets bind to the exact sign-in token. Never replay them with a rotated
  // grant or let a delayed response cross a website/account switch.
  if (!(await authorizationIsCurrent(config, config)))
    throw Error("quick_note_signin_changed");
  const value = await response.json().catch(() => {
    throw Error("clipper_connection_failed");
  });
  if (!(await authorizationIsCurrent(config, config)))
    throw Error("quick_note_signin_changed");
  if (!response.ok)
    throw Object.assign(Error(value?.message || "clipper_connection_failed"), {
      status: response.status,
    });
  return value;
}
function extensionVersionParts(version) {
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(version)
  )
    throw Error("clipper_invalid_package_version");
  const parts = version.split(".").map(Number);
  if (parts.some((part) => part > 65535))
    throw Error("clipper_invalid_package_version");
  return Array.from({ length: 4 }, (_, index) => parts[index] ?? 0);
}
async function checkForUpdates() {
  const currentVersion = chrome.runtime.getManifest().version;
  let site;
  try {
    await boot();
    site = (await local.get("site")).site;
    if (!site) return { status: "unconfigured", currentVersion };
    validateConfig(site);
    const response = await fetch(
      site.origin + "/api/v1/browser-clipper/release",
      {
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) throw Error("clipper_update_check_failed");
    const release = await response.json();
    const latest = extensionVersionParts(release.version),
      current = extensionVersionParts(currentVersion);
    if (
      Object.keys(release).sort().join(",") !== "filename,version" ||
      release.filename !== `doca-browser-assistant-${release.version}.zip`
    )
      throw Error("clipper_invalid_package_version");
    const different = latest.findIndex(
      (part, index) => part !== current[index],
    );
    return {
      status:
        different === -1
          ? "current"
          : latest[different] > current[different]
            ? "available"
            : "ahead",
      currentVersion,
      latestVersion: release.version,
      filename: release.filename,
      origin: site.origin,
      downloadUrl: site.origin + "/#/browser-assistant",
    };
  } catch {
    return { status: "failed", currentVersion, origin: site?.origin };
  }
}
async function state(interactive = false) {
  const locale = (await local.get("locale")).locale || "zh";
  let config;
  try {
    config = await ensureLogin(interactive);
    const [me, profiles] = await Promise.all([
      request("/me", "GET", undefined, false, config),
      request("/profiles", "GET", undefined, false, config),
    ]);
    if (!(await authorizationIsCurrent(config, config)))
      return state(interactive);
    return {
      connected: true,
      locale,
      origin: config.origin,
      connectionId: config.connectionId,
      user: me.user,
      assistantEnabled: !!me.connection.assistant_enabled,
      profiles: profiles.items,
      pending: !!(await session.get("pending")).pending,
      error: (await session.get("lastError")).lastError || "",
    };
  } catch (error) {
    if (config && !(await authorizationIsCurrent(config, config)))
      return state(interactive);
    return {
      connected: false,
      locale,
      origin: (await local.get("site")).site?.origin,
      profiles: [],
      error: error.message,
    };
  }
}
async function snapshot(mode = "page", tabId) {
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !/^https?:\/\//.test(tab.url || ""))
    throw Error("clipper_page_unsupported");
  const read = () =>
    chrome.tabs.sendMessage(tab.id, { type: "snapshot", mode }, { frameId: 0 });
  let response = await read().catch(() => null);
  if (!response) {
    // Navigation or a tab opened before installation can leave no receiver.
    // Install our local scripts in the top frame and retry this capture once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ["svg-image.js", "capture.js", "select.js", "content.js"],
        injectImmediately: true,
      });
      response = await read();
    } catch {
      throw Error("clipper_page_unsupported");
    }
  }
  if (!response?.ok) throw Error(response?.error || "clipper_page_unsupported");
  return {
    capture: await prepareCapture(response.value, tab.id),
    tabId: tab.id,
  };
}
async function begin(capture, profileId, tabId, profileRevision) {
  const config = await connection(),
    profiles = (await request("/profiles")).items;
  const profile = profileId
    ? profiles.find((profile) => profile.id === profileId)
    : profiles.find((profile) => profile.isDefault) || profiles[0];
  if (!profile) throw Error("clipper_profile_unavailable");
  if (profileId && profileRevision !== profile.revision)
    throw Error("clipper_profile_changed");
  if (
    !capture ||
    !["page", "selection"].includes(capture.mode) ||
    !/^https?:/.test(capture.url) ||
    typeof capture.markdown !== "string" ||
    !Array.isArray(capture.images)
  )
    throw Error("clipper_invalid_input");
  const existing = (await session.get("pending")).pending;
  // A retry keeps exactly the frozen input/ID. A changed selection starts a new task.
  if (
    existing &&
    existing.origin === config.origin &&
    existing.connectionId === config.connectionId &&
    existing.profileId === profile.id &&
    existing.profileRevision === profile.revision &&
    existing.capture.markdown === capture.markdown &&
    existing.capture.url === capture.url
  )
    return existing;
  const pending = {
    origin: config.origin,
    connectionId: config.connectionId,
    requestId: crypto.randomUUID(),
    profileId: profile.id,
    profileRevision: profile.revision,
    capture,
    tabId,
  };
  await session.set({ pending });
  return pending;
}
async function bytes(image, tabId) {
  const cached = preparedImages.get(image.id);
  if (cached?.url === image.url) return cached.data;
  let data;
  if (!/^(https?:\/\/|data:image\/|blob:)/i.test(image.url))
    throw Error("clipper_image_invalid");
  try {
    const response = await fetch(image.url, {
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    data = await readCaptureImageResponse(response);
  } catch (error) {
    if (!tabId || error.message === "clipper_image_invalid") throw error;
    const fallback = await chrome.tabs.sendMessage(tabId, {
      type: "image",
      id: image.id,
      url: image.url,
    });
    if (!fallback?.ok) throw Error("clipper_image_failed");
    data = Uint8Array.from(atob(fallback.value), (char) => char.charCodeAt(0));
    if (!data.length || data.length > MAX_IMAGE_SOURCE_BYTES)
      throw Error("clipper_image_invalid");
  }
  let convertedSvg = false;
  try {
    captureImageInfo(data);
  } catch (error) {
    convertedSvg = /<(?:[\w.-]+:)?svg[\s/>]/i.test(
      new TextDecoder().decode(data.subarray(0, 65536)),
    );
    if (!convertedSvg) throw error;
  }
  if (convertedSvg) {
    // Stay below Chrome's message size limit, including base64 expansion.
    if (!tabId || data.length > 32 * 1024 ** 2)
      throw Error("clipper_image_invalid");
    let source = "";
    for (let start = 0; start < data.length; start += 8192)
      source += String.fromCharCode(...data.subarray(start, start + 8192));
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "image",
      id: image.id,
      url: image.url,
      convertSvg: true,
      source: btoa(source),
    });
    if (!result?.ok) throw Error(result?.error || "clipper_image_invalid");
    data = Uint8Array.from(atob(result.value), (char) => char.charCodeAt(0));
  }
  data = await prepareCaptureImage(data);
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data]));
  } catch {
    throw Error("clipper_image_invalid");
  } finally {
    bitmap?.close();
  }
  cacheImage(image, data, convertedSvg);
  return data;
}
async function prepareCapture(capture, tabId) {
  if (
    !capture ||
    typeof capture.markdown !== "string" ||
    !Array.isArray(capture.images) ||
    capture.images.length > 100
  )
    throw Error("clipper_invalid_input");
  const locale = (await local.get("locale")).locale || "zh";
  // Extraction diagnostics are transient responses, never part of protocol v1
  // or the persisted frozen capture. Document placeholders carry their context.
  const { warnings: extractionWarnings = [], ...source } = capture;
  const failures = new Map(),
    images = [];
  const reasons = {
    clipper_image_invalid: "imageUnsupported",
    clipper_image_failed: "imageReadFailed",
    clipper_image_compression_failed: "imageCompressionFailed",
    clipper_animated_image_too_large: "imageAnimationTooLarge",
  };
  for (const image of capture.images) {
    try {
      await bytes(image, tabId);
      images.push(
        preparedImages.get(image.id)?.convertedSvg
          ? { ...image, name: image.name.replace(/\.svg$/i, "") + ".png" }
          : image,
      );
    } catch (error) {
      const code = error?.message || "";
      if (
        (code.startsWith("clipper_") && !Object.hasOwn(reasons, code)) ||
        /quota|Extension context invalidated/i.test(code)
      )
        throw error;
      failures.set(image.id, {
        image,
        reason: reasons[code] || "imageProcessingFailed",
      });
    }
  }
  const markdown = capture.markdown.replace(
    /!\[((?:\\.|[^\]\\])*)\]\(https:\/\/clipper\.invalid\/images\/([a-f0-9-]{36})\)/g,
    (marker, alt, id) => {
      const failure = failures.get(id);
      if (!failure) return marker;
      const name =
        alt ||
        failure.image.name
          .replace(/[\\`*_[\]<>]/g, "\\$&")
          .replace(/\s+/g, " ");
      const label = translate(locale, "imagePlaceholder")
        .replace("{name}", name)
        .replace("{reason}", translate(locale, failure.reason));
      return /^https?:\/\//i.test(failure.image.url)
        ? `[${label}](${failure.image.url.replace(/[()<>\s]/g, (char) => encodeURIComponent(char))})`
        : label;
    },
  );
  const prepared = { ...source, markdown, images };
  captureWarnings.set(warningKey(prepared), [
    ...extractionWarnings,
    ...[...failures.values()].map(({ image, reason }) => ({
      code: reason,
      message: `${image.name}: ${translate(locale, reason)}`,
    })),
  ]);
  while (captureWarnings.size > 10)
    captureWarnings.delete(captureWarnings.keys().next().value);
  return prepared;
}
async function prepare(pending) {
  const config = await connection();
  if (
    pending.connectionId !== config.connectionId ||
    pending.origin !== config.origin
  )
    throw Error("clipper_scope_denied");
  const { capture } = pending;
  let progress = await request(
    "/clips",
    "POST",
    {
      ...capture,
      version: 1,
      requestId: pending.requestId,
      profileId: pending.profileId,
      profileRevision: pending.profileRevision,
      images: capture.images.map((image) => ({
        id: image.id,
        name: image.name,
        url: /^https?:/.test(image.url) ? image.url : "embedded:" + image.id,
      })),
    },
    false,
    pending,
  );
  if (progress.status === "completed") return progress;
  for (let index = 0; index < capture.images.length; index++) {
    const image = capture.images[index];
    if (progress.uploadedImageIds.includes(image.id)) continue;
    await session.set({
      transfer: {
        current: index + 1,
        total: capture.images.length,
        name: image.name,
      },
    });
    let data;
    try {
      data = await bytes(image, pending.tabId);
    } catch (error) {
      const code = error?.message || "";
      if (
        (code.startsWith("clipper_") &&
          ![
            "clipper_image_invalid",
            "clipper_image_failed",
            "clipper_image_compression_failed",
            "clipper_animated_image_too_large",
          ].includes(code)) ||
        /quota|Extension context invalidated/i.test(code)
      )
        throw error;
      continue;
    }
    try {
      await request(
        `/clips/${pending.requestId}/images/${image.id}`,
        "PUT",
        data,
        true,
        pending,
      );
    } catch (error) {
      // Conversion/decoding failures are local to this image, including errors
      // detected by server-side image validation. Commit writes its placeholder.
      // Network, authorization, quota and storage-write failures still reject.
      if (
        ![
          "clipper_image_invalid",
          "clipper_image_failed",
          "clipper_image_compression_failed",
          "clipper_animated_image_too_large",
        ].includes(error.message)
      )
        throw error;
    }
  }
  await session.remove("transfer");
  return progress;
}
async function rebuildExpiredCapture(pending, error, key) {
  if (error.status !== 410 || error.message !== "clipper_capture_expired") throw error;
  const config = await connection();
  if (config.origin !== pending.origin || config.connectionId !== pending.connectionId)
    throw Error("clipper_scope_denied");
  const cache = await session.get(["pending", "assistantPending"]);
  if (cache[key]?.requestId !== pending.requestId) throw error;
  const fresh = { ...pending, requestId: crypto.randomUUID() }, updates = { [key]: fresh };
  for (const other of ["pending", "assistantPending"])
    if (cache[other]?.requestId === pending.requestId && cache[other].origin === pending.origin && cache[other].connectionId === pending.connectionId)
      updates[other] = fresh;
  await session.set(updates);
  return fresh;
}
async function prepareAssistantCapture(pending) {
  try { await prepare(pending); }
  catch (error) {
    pending = await rebuildExpiredCapture(pending, error, "assistantPending");
    await prepare(pending);
  }
  return pending;
}
async function submit(pending) {
  if (submitting) {
    if (submitting.id !== pending.requestId) throw Error("clipper_busy");
    return submitting.promise;
  }
  const promise = (async () => {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await prepare(pending);
        result = await request(
          `/clips/${pending.requestId}/commit`, "POST", {}, false, pending,
        );
        break;
      } catch (error) {
        if (attempt) throw error;
        // Rebuild a reclaimed slot once using the same material and scope;
        // never rewrite the old frozen task or refetch another page.
        pending = await rebuildExpiredCapture(pending, error, "pending");
        submitting.id = pending.requestId;
      }
    }
    if ((await session.get("pending")).pending?.requestId === pending.requestId)
      await session.remove(["pending", "lastError", "transfer"]);
    const warnings = [
      ...(captureWarnings.get(warningKey(pending.capture)) || []),
      ...(result.warnings || []),
    ];
    return { ...result, warnings, url: pending.origin + result.href };
  })()
    .catch(async (error) => {
      await session.set({ lastError: error.message });
      throw error;
    })
    .finally(() => {
      submitting = null;
    });
  submitting = { id: pending.requestId, promise };
  return promise;
}
async function handle(message, sender) {
  if (message.type === "loginResult") return loginResult(message, sender);
  const ui = chrome.runtime.getURL("ui.html");
  const fromUi =
    sender.id === chrome.runtime.id &&
    (sender.url === ui || sender.url?.startsWith(ui + "#"));
  const fromPage =
    !fromUi &&
    sender.id === chrome.runtime.id &&
    !!sender.tab &&
    /^https?:/.test(sender.url || "") &&
    !sender.frameId;
  if (!fromUi && !fromPage) throw Error("clipper_scope_denied");
  if (
    fromPage &&
    ![
      "state",
      "login",
      "capture",
      "prepareCapture",
      "openAssistant",
      "openSettings",
      "dockPreferences",
    ].includes(message.type)
  )
    throw Error("clipper_scope_denied");
  if (!fromPage && !fromUi) throw Error("clipper_scope_denied");
  if (message.type === "checkForUpdates") return checkForUpdates();
  if (message.type === "openSettings") {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("ui.html#settings"),
    });
    return { opened: true };
  }
  if (message.type === "dockPreferences") {
    await storageReady;
    if (message.operation === "set") {
      if (
        typeof message.position !== "number" ||
        !Number.isFinite(message.position) ||
        message.position < 0 ||
        message.position > 1
      )
        throw Error("clipper_invalid_input");
      await local.set({ dockPosition: message.position });
    } else if (message.operation !== "get")
      throw Error("clipper_invalid_input");
    const preferences = await local.get(["dockPosition", "locale"]);
    if (
      preferences.dockPosition !== undefined &&
      (typeof preferences.dockPosition !== "number" ||
        !Number.isFinite(preferences.dockPosition) ||
        preferences.dockPosition < 0 ||
        preferences.dockPosition > 1)
    )
      throw Error("clipper_invalid_input");
    return {
      position: preferences.dockPosition ?? null,
      locale: preferences.locale || "zh",
    };
  }
  if (message.type === "state") return state(fromUi && !!message.interactive);
  if (message.type === "login") {
    await ensureLogin(true);
    return state();
  }
  if (message.type === "configure") {
    const site = validateConfig(JSON.parse(message.config));
    await local.set({ site });
    return state(true);
  }
  if (message.type === "locale") {
    if (!["zh", "en"].includes(message.locale))
      throw Error("clipper_invalid_input");
    await local.set({ locale: message.locale });
    return state();
  }
  if (
    ["quickNoteTargets", "quickNotePrepare", "quickNoteCommit"].includes(
      message.type,
    )
  )
    return quickNoteRequest(message);
  if (message.type === "assistantRequest") {
    if (
      !fromUi ||
      typeof message.path !== "string" ||
      !message.path.startsWith("/assistant/") ||
      !["GET", "POST", "PATCH", "DELETE"].includes(message.method || "GET")
    )
      throw Error("clipper_scope_denied");
    await ensureLogin(message.method && message.method !== "GET");
    const result = await request(
      message.path,
      message.method || "GET",
      message.body,
      false,
      {
        origin: message.origin,
        connectionId: message.connectionId,
      },
    );
    if (
      message.method === "POST" &&
      /\/sessions\/[a-f0-9-]{36}\/messages$/.test(message.path)
    ) {
      const pending = (await session.get("assistantPending")).assistantPending;
      if (pending?.requestId === message.body?.captureRequestId)
        await session.remove("assistantPending");
      await session.remove("lastError");
    }
    return result;
  }
  if (message.type === "assistantSession") {
    const config = await connection();
    if (
      message.origin !== config.origin ||
      message.connectionId !== config.connectionId
    )
      throw Error("clipper_scope_denied");
    if (message.operation === "set") {
      if (message.id !== null && !/^[a-f0-9-]{36}$/.test(message.id))
        throw Error("clipper_invalid_input");
      if (message.id)
        await session.set({
          assistant: {
            origin: config.origin,
            connectionId: config.connectionId,
            profileId: message.profileId,
            id: message.id,
          },
        });
      else await session.remove("assistant");
    }
    const saved = (await session.get("assistant")).assistant;
    const matches =
      saved?.origin === config.origin &&
      saved?.connectionId === config.connectionId &&
      saved?.profileId === message.profileId;
    if (matches && message.operation === "get") {
      try {
        // Validate the stored selection against the current rule before mounting
        // its chat UI. Keep the original session and queued messages intact.
        await request(
          `/assistant/sessions/${saved.id}`,
          "GET",
          undefined,
          false,
          saved,
        );
      } catch (error) {
        if (
          (error.status === 409 &&
            error.message === "clipper_profile_changed") ||
          (error.status === 404 && error.message === "clipper_session_missing")
        )
          return { sessionId: null };
        throw error;
      }
    }
    return {
      sessionId: matches ? saved.id : null,
    };
  }
  if (message.type === "assistantPreparePage") {
    await ensureLogin(true);
    const config = await connection();
    if (
      message.origin !== config.origin ||
      message.connectionId !== config.connectionId
    )
      throw Error("clipper_scope_denied");
    let pending = (await session.get("assistantPending")).assistantPending;
    const sameProfile =
      pending &&
      pending.origin === config.origin &&
      pending.connectionId === config.connectionId &&
      pending.profileId === message.profileId;
    if (sameProfile && pending.profileRevision !== message.profileRevision)
      throw Error("clipper_profile_changed");
    const currentTab = message.tabId
      ? await chrome.tabs.get(message.tabId)
      : null;
    if (
      !sameProfile ||
      pending.capture.mode !== "selection" ||
      pending.tabId !== currentTab?.id ||
      pending.capture.url !== currentTab?.url
    ) {
      const source = await snapshot("page", message.tabId);
      pending = await begin(
        source.capture,
        message.profileId,
        source.tabId,
        message.profileRevision,
      );
      await session.set({ assistantPending: pending });
    }
    pending = await prepareAssistantCapture(pending);
    return {
      captureRequestId: pending.requestId,
      title: pending.capture.title,
      url: pending.capture.url,
    };
  }
  if (message.type === "openAssistant") {
    const tabId = sender.tab?.id || message.tabId;
    if (!tabId) throw Error("clipper_page_unsupported");
    if (
      fromPage &&
      message.capture &&
      new URL(message.capture.url).origin !== new URL(sender.url).origin
    )
      throw Error("clipper_scope_denied");
    let path = "ui.html#assistant";
    if (message.profileId) {
      if (
        !/^[a-f0-9-]{36}$/.test(message.profileId) ||
        !Number.isInteger(message.profileRevision) ||
        message.profileRevision < 1
      )
        throw Error("clipper_profile_unavailable");
      path +=
        "?" +
        new URLSearchParams({
          profileId: message.profileId,
          profileRevision: String(message.profileRevision),
        });
    }
    // Preserve the originating click while opening the native panel, then verify sign-in.
    const configured = chrome.sidePanel.setOptions({
      tabId,
      path,
      enabled: true,
    });
    const opened = chrome.sidePanel.open({ tabId });
    await Promise.all([configured, opened]);
    await ensureLogin(true);
    if (message.capture) {
      const pending = await begin(
        await prepareCapture(message.capture, tabId),
        message.profileId,
        tabId,
        message.profileRevision,
      );
      await session.set({ assistantPending: pending });
    }
    return { opened: true };
  }
  if (!["locale", "assistantNew"].includes(message.type))
    await ensureLogin(
      ["capture", "retry", "assistantSend", "assistantJob"].includes(
        message.type,
      ),
    );
  if (message.type === "capture") {
    if (
      fromPage &&
      new URL(message.capture.url).origin !== new URL(sender.url).origin
    )
      throw Error("clipper_scope_denied");
    const source = message.capture
      ? { capture: message.capture, tabId: sender.tab?.id }
      : await snapshot(message.mode || "page", message.tabId);
    return submit(
      await begin(
        source.capture,
        message.profileId,
        source.tabId,
        message.profileRevision,
      ),
    );
  }
  if (message.type === "prepareCapture") {
    if (
      !fromPage ||
      new URL(message.capture.url).origin !== new URL(sender.url).origin
    )
      throw Error("clipper_scope_denied");
    return prepareCapture(message.capture, sender.tab.id);
  }
  if (message.type === "retry") {
    const pending = (await session.get("pending")).pending;
    if (!pending) throw Error("clipper_capture_missing");
    return submit(pending);
  }
  if (message.type === "assistantOptions") return request("/assistant/options");
  if (message.type === "assistantLoad") {
    const saved = (await session.get("assistant")).assistant,
      config = await connection();
    if (
      !saved ||
      saved.origin !== config.origin ||
      saved.connectionId !== config.connectionId ||
      saved.profileId !== message.profileId
    )
      return { sessionId: null, jobs: [] };
    return {
      ...(await request(
        `/assistant/sessions/${saved.id}`,
        "GET",
        undefined,
        false,
        saved,
      )),
      sessionId: saved.id,
    };
  }
  if (message.type === "assistantSend") {
    const config = await connection();
    let saved = (await session.get("assistant")).assistant;
    const previousResult = (await session.get("lastAssistantSent"))
      .lastAssistantSent;
    if (
      previousResult?.requestId === message.requestId &&
      previousResult.origin === config.origin &&
      previousResult.connectionId === config.connectionId
    )
      return previousResult.result;
    if (
      !saved ||
      saved.origin !== config.origin ||
      saved.connectionId !== config.connectionId ||
      saved.profileId !== message.profileId
    ) {
      const created = await request("/assistant/sessions", "POST", {
        profileId: message.profileId,
        profileRevision: message.profileRevision,
      });
      saved = {
        origin: config.origin,
        connectionId: config.connectionId,
        profileId: message.profileId,
        id: created.id,
      };
      await session.set({ assistant: saved });
    }
    const draft = (await session.get("assistantDraft")).assistantDraft;
    let body;
    if (
      draft?.requestId === message.requestId &&
      draft.origin === config.origin &&
      draft.connectionId === config.connectionId &&
      draft.sessionId === saved.id
    )
      body = draft.body;
    else {
      let captureRequestId = null;
      if (message.attachPage) {
        let pending = (await session.get("assistantPending")).assistantPending;
        if (
          !pending ||
          pending.profileId !== message.profileId ||
          pending.connectionId !== config.connectionId ||
          pending.origin !== config.origin
        ) {
          const source = await snapshot("page", message.tabId);
          pending = await begin(
            source.capture,
            message.profileId,
            source.tabId,
            message.profileRevision,
          );
          await session.set({ assistantPending: pending });
        }
        pending = await prepareAssistantCapture(pending);
        captureRequestId = pending.requestId;
      }
      body = {
        id: message.requestId,
        modelId: message.modelId,
        text: message.text,
        captureRequestId,
      };
      await session.set({
        assistantDraft: {
          origin: config.origin,
          connectionId: config.connectionId,
          requestId: message.requestId,
          sessionId: saved.id,
          body,
        },
      });
    }
    const result = await request(
      `/assistant/sessions/${saved.id}/messages`,
      "POST",
      body,
      false,
      saved,
    );
    await session.set({
      lastAssistantSent: {
        origin: config.origin,
        connectionId: config.connectionId,
        requestId: message.requestId,
        result: { ...result, sessionId: saved.id },
      },
    });
    await session.remove("assistantDraft");
    await session.remove("assistantPending");
    return { ...result, sessionId: saved.id };
  }
  if (message.type === "assistantJob")
    return request(
      `/assistant/jobs/${message.jobId}/${message.operation}`,
      "POST",
      message.body || {},
    );
  if (message.type === "assistantNew") {
    await session.remove("assistant");
    return { sessionId: null, jobs: [] };
  }
  throw Error("clipper_invalid_input");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender)
    .then((value) => respond({ ok: true, value }))
    .catch(async (error) => {
      await session.set({ lastError: error.message });
      respond({ ok: false, error: error.message, status: error.status });
    });
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  void boot().catch(async (error) => session.set({ lastError: error.message }));
});

// Browser commands are user gestures. Freeze the source before sign-in can activate another tab.
async function captureFromShortcut(command) {
  if (!["capture-page", "capture-selection"].includes(command)) return;
  await chrome.action.setBadgeBackgroundColor({ color: "#7051be" });
  await chrome.action.setBadgeText({ text: "…" });
  try {
    const source = await snapshot(
      command === "capture-page" ? "page" : "selection",
    );
    await ensureLogin(true);
    await submit(await begin(source.capture, undefined, source.tabId));
    await chrome.action.setBadgeText({ text: "✓" });
    await chrome.action.setTitle({ title: "Doca · ✓" });
  } catch (error) {
    await session.set({ lastError: error.message });
    await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
    await chrome.action.setBadgeText({ text: "!" });
    const locale = (await local.get("locale")).locale;
    await chrome.action.setTitle({
      title:
        "Doca · " +
        (locale === "en" ? "Open extension for details" : "打开扩展查看详情"),
    });
  }
}
chrome.commands.onCommand.addListener((command) => {
  void captureFromShortcut(command);
});
