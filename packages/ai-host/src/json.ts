export type JsonPrimitive = null | boolean | number | string;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

function copyJson(value: unknown, seen: Set<object>, path: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not JSON-compatible`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item, index) => copyJson(item, seen, `${path}[${index}]`)),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain object`);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new TypeError(`${path}.${key} must not be undefined`);
      }
      result[key] = copyJson(item, seen, `${path}.${key}`);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

/**
 * Copies an unknown value into immutable JSON. The copy prevents callers from
 * mutating a committed event or tool outcome through an retained reference.
 */
export function freezeJson(value: unknown, label = "value"): JsonValue {
  return copyJson(value, new Set(), label);
}

export function freezeJsonObject(
  value: unknown,
  label = "value",
): JsonObject {
  const frozen = freezeJson(value, label);
  if (frozen === null || Array.isArray(frozen) || typeof frozen !== "object") {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return frozen as JsonObject;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key]!)}`)
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalize(freezeJson(value));
}
