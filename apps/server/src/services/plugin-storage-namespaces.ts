/** Host-only names. SDK services bind these once from the installed identity. */
const pluginIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function pluginId(value: string) {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !pluginIdPattern.test(value)
  )
    throw new TypeError("Invalid installed plugin identity");
  return value;
}

function uuid(value: string) {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new TypeError("Invalid storage object identity");
  return value;
}

function generation(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("Invalid storage generation");
  return value;
}

export const HOST_STORAGE_NAMESPACE = "host" as const;

export function hostPluginReleaseKey(sha256: string) {
  if (typeof sha256 !== "string" || !sha256Pattern.test(sha256))
    throw new TypeError("Invalid plugin archive identity");
  return `${HOST_STORAGE_NAMESPACE}/plugin-releases/${sha256}.zip`;
}

export interface PluginStorageNamespace {
  readonly pluginId: string;
  readonly database: string;
  readonly folders: string;
  readonly objects: string;
  /** Keys are private to the host. SDK consumers receive opaque object IDs. */
  objectKey(generation: number, objectId: string, attemptId: string): string;
  /** Check persisted keys against the bound owner and installation generation. */
  assertObjectKey(key: string, generation: number): void;
}

/** Does not normalize identifiers: example.a-b and example.a.b remain distinct. */
export function createPluginStorageNamespace(
  installedPluginId: string,
): PluginStorageNamespace {
  const id = pluginId(installedPluginId);
  const prefix = `plugins/${id}`;
  return Object.freeze({
    pluginId: id,
    database: `plugin:${id}`,
    folders: prefix,
    objects: `${prefix}/`,
    objectKey(currentGeneration: number, objectId: string, attemptId: string) {
      return `${prefix}/objects/${generation(currentGeneration)}/${uuid(objectId)}/${uuid(attemptId)}`;
    },
    assertObjectKey(key: string, currentGeneration: number) {
      const expected = `${prefix}/objects/${generation(currentGeneration)}/`;
      if (typeof key !== "string" || !key.startsWith(expected))
        throw new TypeError(
          "Object does not belong to this plugin installation",
        );
      const parts = key.slice(expected.length).split("/");
      if (parts.length !== 2) throw new TypeError("Invalid plugin object key");
      uuid(parts[0]!);
      uuid(parts[1]!);
    },
  });
}
