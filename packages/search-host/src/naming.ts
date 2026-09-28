import type { SearchSourceDescriptor } from "./types.js";

const encoder = new TextEncoder();

function requireText(value: string, field: string): void {
  if (value.trim().length === 0)
    throw new TypeError(`${field} must be a non-empty string`);
}

export function validateSearchSourceDescriptor(
  descriptor: SearchSourceDescriptor,
): void {
  requireText(descriptor.pluginId, "pluginId");
  requireText(descriptor.sourceId, "sourceId");
  requireText(descriptor.renderer.kind, "renderer.kind");
  if (
    !Number.isSafeInteger(descriptor.schemaVersion) ||
    descriptor.schemaVersion < 1
  )
    throw new TypeError("schemaVersion must be a positive safe integer");
  if (
    descriptor.renderer.version !== undefined &&
    (!Number.isSafeInteger(descriptor.renderer.version) ||
      descriptor.renderer.version < 1)
  )
    throw new TypeError("renderer.version must be a positive safe integer");
}

export function encodeIndexComponent(value: string): string {
  requireText(value, "index component");
  const bytes = encoder.encode(value);
  return `${bytes.length}_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function searchSourceKey(
  descriptor: Pick<SearchSourceDescriptor, "pluginId" | "sourceId">,
): string {
  return `${encodeIndexComponent(descriptor.pluginId)}/${encodeIndexComponent(
    descriptor.sourceId,
  )}`;
}

export interface SearchIndexNames {
  readonly alias: string;
  readonly version: (version: string) => string;
}

/**
 * Alias names are stable across schema changes; physical names carry both the
 * schema and rebuild version so an alias swap can publish atomically.
 */
export function searchIndexNames(
  descriptor: SearchSourceDescriptor,
  namespace = "doca_search",
): SearchIndexNames {
  validateSearchSourceDescriptor(descriptor);
  const prefix = [
    encodeIndexComponent(namespace),
    encodeIndexComponent(descriptor.pluginId),
    encodeIndexComponent(descriptor.sourceId),
  ].join("__");
  return {
    alias: `${prefix}__current`,
    version: (version: string) =>
      `${prefix}__schema_${descriptor.schemaVersion}__version_${encodeIndexComponent(
        version,
      )}`,
  };
}

export function sameSearchSource(
  left: SearchSourceDescriptor,
  right: SearchSourceDescriptor,
): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.sourceId === right.sourceId &&
    left.schemaVersion === right.schemaVersion
  );
}
