import { isLocale } from "@doca/i18n";

/** Per-user page state. UI keys are shared preferences the assistant can read and update. */

/** Floating quick-notes window. Shared by the web client and page-state writes. */
export type NotesFloatState = {
  open: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const notesFloatDefaults: NotesFloatState = {
  open: false,
  collapsed: false,
  x: 28,
  y: 76,
  width: 380,
  height: 560,
};

export type PageStateKey =
  | "ui.locale"
  | "ui.filesView"
  | "ui.notesFloat"
  | "ai.model";

export function parsePageStateKey(key: string): PageStateKey | null {
  if (key === "ui.locale" || key === "ui.filesView" || key === "ui.notesFloat" || key === "ai.model")
    return key;
  return null;
}

export function normalizePageStateValue(key: PageStateKey, value: unknown): unknown {
  if (key === "ui.locale") {
    if (!isLocale(value)) throw new Error("invalid_locale");
    return value;
  }
  if (key === "ui.filesView") {
    if (value !== "columns" && value !== "grid" && value !== "list")
      throw new Error("文件夹样式只能是分栏、图标或列表");
    return value;
  }
  if (key === "ai.model") {
    if (typeof value !== "string" || !value.trim() || value.length > 80)
      throw new Error("模型标识无效");
    return value.trim();
  }
  if (key === "ui.notesFloat") return normalizeNotesFloat(value);
  throw new Error("Unsupported page state key");
}

export function normalizeNotesFloat(value: unknown): NotesFloatState {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const num = (field: string, fallback: number, min: number, max: number) => {
    const raw = record[field];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    open: record.open === true,
    collapsed: record.collapsed === true,
    x: num("x", notesFloatDefaults.x, -4000, 8000),
    y: num("y", notesFloatDefaults.y, -4000, 8000),
    width: num("width", notesFloatDefaults.width, 280, 960),
    height: num("height", notesFloatDefaults.height, 320, 960),
  };
}
