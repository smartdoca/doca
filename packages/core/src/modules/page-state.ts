import { isLocale } from "@doca/i18n";

/** Per-user page state. UI keys are shared preferences the assistant can read and update. */

export type PageStateKey =
  | "ui.locale"
  | "ui.filesView"
  | "ai.model";

export function parsePageStateKey(key: string): PageStateKey | null {
  if (key === "ui.locale" || key === "ui.filesView" || key === "ai.model")
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
  throw new Error("Unsupported page state key");
}
