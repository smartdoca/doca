/** Mail and file side panels remember whether the assistant was open, and which chat. */
const KEY = "doca.ai.side-open";
const WIDTH_KEY = "doca.ai.panel-width";
export const PANEL_WIDTH_DEFAULT = 460;
export const PANEL_WIDTH_MIN = 300;
const SESSION = /^[a-f0-9-]{36}$/i;

export type SideSurface = "files" | "mail";
export type SidePanelMemory = { open: boolean; sessionId: string | null };

export function sidePanelSurface(hash: string): SideSurface | null {
  const route = hash.replace(/^#/, "").split("?")[0] ?? "";
  if (route === "/files" || /^\/shared-files\/[a-f0-9-]{36}$/.test(route))
    return "files";
  if (route === "/mail" || route.startsWith("/mail/") || route === "/mail-preview")
    return "mail";
  return null;
}

export function sessionFromHash(hash: string) {
  const carried = new URLSearchParams(hash.split("?")[1] ?? "").get("session");
  return carried && SESSION.test(carried) ? carried : null;
}

function readRaw(userId: string) {
  try {
    return JSON.parse(localStorage.getItem(`${KEY}.${userId}`) ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readSidePanel(userId: string, surface: SideSurface): SidePanelMemory {
  const raw = readRaw(userId)[surface];
  if (raw === true) return { open: true, sessionId: null };
  if (!raw || typeof raw !== "object") return { open: false, sessionId: null };
  const record = raw as { open?: unknown; sessionId?: unknown };
  const sessionId = typeof record.sessionId === "string" && SESSION.test(record.sessionId)
    ? record.sessionId
    : null;
  return { open: record.open === true, sessionId };
}

export function readSideOpen(userId: string, surface: SideSurface) {
  return readSidePanel(userId, surface).open;
}

export function writeSidePanel(userId: string, surface: SideSurface, memory: SidePanelMemory) {
  try {
    const key = `${KEY}.${userId}`;
    const raw = readRaw(userId);
    localStorage.setItem(key, JSON.stringify({
      ...raw,
      [surface]: {
        open: memory.open,
        sessionId: memory.sessionId && SESSION.test(memory.sessionId) ? memory.sessionId : null,
      },
    }));
  } catch {
    /* Private browsing. */
  }
}

export function writeSideOpen(userId: string, surface: SideSurface, open: boolean) {
  writeSidePanel(userId, surface, { open, sessionId: readSidePanel(userId, surface).sessionId });
}

export function panelWidthMax(viewport: number) {
  return Math.max(PANEL_WIDTH_MIN, Math.min(960, Math.floor(viewport - 240)));
}

export function clampPanelWidth(width: number, viewport: number) {
  if (!Number.isFinite(width)) return PANEL_WIDTH_DEFAULT;
  return Math.round(
    Math.min(panelWidthMax(viewport), Math.max(PANEL_WIDTH_MIN, width)),
  );
}

export function readPanelWidth(viewport = 1280) {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw == null || raw === "")
      return clampPanelWidth(PANEL_WIDTH_DEFAULT, viewport);
    return clampPanelWidth(Number(raw), viewport);
  } catch {
    return clampPanelWidth(PANEL_WIDTH_DEFAULT, viewport);
  }
}

export function writePanelWidth(width: number, viewport: number) {
  const next = clampPanelWidth(width, viewport);
  try {
    localStorage.setItem(WIDTH_KEY, String(next));
  } catch {
    /* Private browsing. */
  }
  return next;
}
