import { expect, it } from "vitest";
import {
  createPluginStorageNamespace,
  hostPluginReleaseKey,
} from "@server/services/plugin-storage-namespaces.js";

const objectId = "ad2936ac-903c-47af-bcdc-6b2139f22ac2";
const attemptId = "1025c7a7-d958-477b-9f50-6bb8d43103c7";

it("separates host releases, plugin folders, and each plugin's private objects", () => {
  const first = createPluginStorageNamespace("example.a-b");
  const second = createPluginStorageNamespace("example.a.b");
  expect(first.database).toBe("plugin:example.a-b");
  expect(first.folders).toBe("plugins/example.a-b");
  const key = first.objectKey(1, objectId, attemptId);
  expect(() => first.assertObjectKey(key, 1)).not.toThrow();
  expect(() => second.assertObjectKey(key, 1)).toThrow("does not belong");
  expect(first.database).not.toBe(second.database);
  expect(first.folders).not.toBe(second.folders);
  expect(first.objectKey(1, objectId, attemptId)).not.toBe(
    second.objectKey(1, objectId, attemptId),
  );
  const release = hostPluginReleaseKey("a".repeat(64));
  expect(release).toBe(`host/plugin-releases/${"a".repeat(64)}.zip`);
  expect(() => first.assertObjectKey(release, 1)).toThrow("does not belong");
  expect(Object.isFrozen(first)).toBe(true);
});

it.each([
  "",
  "../host",
  "host/releases",
  "example%2fhost",
  "example\\host",
  "Example",
  "example..a",
  "example-a/../host",
  " a",
  "a ",
  "a\n",
  "a".repeat(101),
])("rejects untrusted plugin identity %j", (id) => {
  expect(() => createPluginStorageNamespace(id)).toThrow(
    "Invalid installed plugin identity",
  );
});

it("does not truncate or sanitize long and similar plugin IDs into collisions", () => {
  const ids = [
    "a".repeat(100),
    "a".repeat(99) + "b",
    "example.a-b",
    "example.a.b",
    "example-a.b",
    "host",
    "plugins",
  ];
  const namespaces = ids.map(createPluginStorageNamespace);
  expect(new Set(namespaces.map((x) => x.database)).size).toBe(ids.length);
  expect(new Set(namespaces.map((x) => x.folders)).size).toBe(ids.length);
});

it("rejects old installation keys and distinguishes concurrent write attempts", () => {
  const namespace = createPluginStorageNamespace("example.demo");
  const key = namespace.objectKey(1, objectId, attemptId);
  expect(() => namespace.assertObjectKey(key, 2)).toThrow("does not belong");
  expect(namespace.objectKey(2, objectId, attemptId)).not.toBe(key);
  expect(namespace.objectKey(1, objectId, objectId)).not.toBe(key);
  for (const invalid of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() => namespace.objectKey(invalid, objectId, attemptId)).toThrow(
      "Invalid storage generation",
    );
});

it("rejects traversal, extra segments, malformed IDs, and neighboring plugin prefixes", () => {
  const namespace = createPluginStorageNamespace("example.demo");
  const prefix = "plugins/example.demo/objects/1/";
  for (const key of [
    `${prefix}${objectId}/${attemptId}/../host`,
    `${prefix}${objectId}/%2e%2e`,
    `${prefix}${objectId}/${attemptId}/extra`,
    `plugins/example.demo-other/objects/1/${objectId}/${attemptId}`,
    `${prefix}${objectId.toUpperCase()}/${attemptId}`,
  ])
    expect(() => namespace.assertObjectKey(key, 1)).toThrow();
  expect(() => namespace.objectKey(1, "../host", attemptId)).toThrow(
    "Invalid storage object identity",
  );
  for (const hash of [
    "",
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    "../host",
  ])
    expect(() => hostPluginReleaseKey(hash)).toThrow(
      "Invalid plugin archive identity",
    );
});
