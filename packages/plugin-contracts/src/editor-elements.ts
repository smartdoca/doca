import type { JsonObject } from "./index.js";

export type PluginElementFormat = "rich_text" | "spreadsheet";
/** Content, never a renderer, credential, timer state or temporary asset URL. */
export interface PluginElementPayload extends JsonObject {
  readonly version: 1;
  readonly pluginId: string;
  readonly type: string;
  readonly dataVersion: number;
  readonly data: JsonObject;
  readonly text: string;
}
export const PLUGIN_ELEMENT_BYTES = 32 * 1024;
/** Bounds opaque content even when its provider/type/version is unavailable. */
export function validatePluginElementPayload(
  value: unknown,
): asserts value is JsonObject {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 20)
      throw Error("Plugin element structure exceeds limit");
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return;
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (
      !item ||
      typeof item !== "object" ||
      Object.getPrototypeOf(item) !== Object.prototype
    )
      throw Error("Plugin element must contain JSON only");
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw Error("Unsafe plugin element property");
      visit(child, depth + 1);
    }
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Plugin element payload must be an object");
  visit(value, 0);
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    PLUGIN_ELEMENT_BYTES
  )
    throw Error("Plugin element exceeds 32 KiB");
}
/** Recognizes exactly the current envelope. Unknown envelopes remain opaque. */
export function isPluginElementPayload(
  value: unknown,
): value is PluginElementPayload {
  try {
    validatePluginElementPayload(value);
  } catch {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.pluginId === "string" &&
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(v.pluginId) &&
    typeof v.type === "string" &&
    v.type.startsWith(`${v.pluginId}.`) &&
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(v.type) &&
    v.type.length <= 200 &&
    Number.isSafeInteger(v.dataVersion) &&
    (v.dataVersion as number) > 0 &&
    !!v.data &&
    typeof v.data === "object" &&
    !Array.isArray(v.data) &&
    typeof v.text === "string" &&
    v.text.length <= 2000 &&
    Object.keys(v).every((key) =>
      ["version", "pluginId", "type", "dataVersion", "data", "text"].includes(
        key,
      ),
    )
  );
}
