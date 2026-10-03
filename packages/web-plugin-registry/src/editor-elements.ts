import {
  isPluginElementPayload,
  validatePluginElementPayload,
  type JsonObject,
  type PluginElementFormat,
  type PluginElementPayload,
} from "@smartdoca/plugin-contracts";
import type { OwnedContribution, PluginLocale } from "./index.js";

export interface PluginElementContext {
  readonly documentId: string;
  readonly format: PluginElementFormat;
  readonly locale: PluginLocale;
  readonly readOnly: boolean;
  readonly signal: AbortSignal;
}
export interface PluginElementEditorContext extends PluginElementContext {
  readonly initialData: JsonObject | null;
  submit(data: JsonObject): void;
  cancel(): void;
}
export interface PluginElementCellContext extends PluginElementContext {
  readonly canvas: CanvasRenderingContext2D;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly payload: PluginElementPayload;
}
export interface PluginElementContribution<
  View = unknown,
> extends OwnedContribution {
  readonly title: { readonly zh: string; readonly en: string };
  readonly dataVersion: number;
  readonly formats: readonly PluginElementFormat[];
  /** Exact version validation; never converts content. */
  validate(data: JsonObject): boolean;
  text(data: JsonObject, locale: PluginLocale): string;
  renderEditor(context: PluginElementEditorContext): View;
  render?(payload: PluginElementPayload, context: PluginElementContext): View;
  renderCell?(context: PluginElementCellContext): void;
  onCellClick?(
    payload: PluginElementPayload,
    context: PluginElementContext,
  ): void;
  /** View-only canvas refresh. No persisted ticking values. */
  readonly refreshIntervalMs?: number;
}
export function validateElementContribution(item: PluginElementContribution) {
  if (
    !Number.isSafeInteger(item.dataVersion) ||
    item.dataVersion < 1 ||
    !item.title ||
    !item.title.zh?.trim() ||
    !item.title.en?.trim() ||
    !Array.isArray(item.formats) ||
    !item.formats.length ||
    new Set(item.formats).size !== item.formats.length ||
    item.formats.some(
      (format) => !["rich_text", "spreadsheet"].includes(format),
    ) ||
    typeof item.validate !== "function" ||
    typeof item.text !== "function" ||
    typeof item.renderEditor !== "function" ||
    (item.formats.includes("rich_text") && typeof item.render !== "function") ||
    (item.formats.includes("spreadsheet") &&
      typeof item.renderCell !== "function") ||
    (item.onCellClick !== undefined &&
      typeof item.onCellClick !== "function") ||
    (item.refreshIntervalMs !== undefined &&
      (!Number.isSafeInteger(item.refreshIntervalMs) ||
        item.refreshIntervalMs < 1000 ||
        item.refreshIntervalMs > 60000))
  )
    throw Error("Invalid plugin element contribution");
}
export type PluginElementState = "ready" | "unsupported" | "invalid";
export function pluginElementState(
  value: unknown,
  provider: PluginElementContribution | undefined,
  format: PluginElementFormat,
): PluginElementState {
  if (
    !isPluginElementPayload(value) ||
    !provider ||
    provider.pluginId !== value.pluginId ||
    provider.id !== value.type ||
    provider.dataVersion !== value.dataVersion ||
    !provider.formats.includes(format)
  )
    return "unsupported";
  try {
    return provider.validate(structuredClone(value.data)) === true
      ? "ready"
      : "invalid";
  } catch {
    return "invalid";
  }
}
export function createPluginElementPayload(
  provider: PluginElementContribution,
  data: JsonObject,
  locale: PluginLocale,
): PluginElementPayload {
  validatePluginElementPayload(data);
  if (provider.validate(structuredClone(data)) !== true)
    throw Error("Invalid plugin element data");
  const value = {
    version: 1 as const,
    pluginId: provider.pluginId,
    type: provider.id,
    dataVersion: provider.dataVersion,
    data: structuredClone(data),
    text: provider.text(structuredClone(data), locale),
  };
  if (!isPluginElementPayload(value))
    throw Error("Invalid plugin element envelope");
  return value;
}
