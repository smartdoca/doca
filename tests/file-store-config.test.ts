import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  configuredFileStore,
  parseFileStoreEnvironment,
} from "@server/services/file-store-config.js";

const s3 = {
  provider: "s3",
  bucket: "doca-storage",
  region: "us-east-1",
  forcePathStyle: false,
  credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
};
function environment(
  stores: unknown,
  currentId = "current",
  version: unknown = 1,
) {
  return {
    DOCA_FILE_STORE_ID: currentId,
    DOCA_FILE_STORES_JSON: JSON.stringify({ version, stores }),
  };
}

it("resolves explicit current and historical file stores independently", () => {
  const historicalId = "2438c63f-ec54-409b-a355-dc5b631d4281";
  const config = parseFileStoreEnvironment(
    environment({
      current: s3,
      [historicalId]: { provider: "local", root: "./data/storage" },
    }),
  );
  expect(config.currentId).toBe("current");
  expect(configuredFileStore(config, "current").provider).toBe("s3");
  expect(configuredFileStore(config, historicalId)).toEqual({
    provider: "local",
    root: resolve("./data/storage"),
  });
  expect(() => configuredFileStore(config, "missing-historical-store")).toThrow(
    "Referenced file storage ID is not configured",
  );
});

it("requires explicit environment configuration without backend defaults", () => {
  for (const value of [
    {},
    { DOCA_FILE_STORE_ID: "current" },
    { DOCA_FILE_STORES_JSON: "{}" },
    { DOCA_FILE_STORE_ID: "current", DOCA_FILE_STORES_JSON: "" },
  ])
    expect(() => parseFileStoreEnvironment(value)).toThrow("are required");
  expect(() =>
    parseFileStoreEnvironment(environment({ current: s3 }, "missing")),
  ).toThrow("Current file storage ID is not configured");
});

it("rejects unversioned, unknown, partial, or mixed-provider configurations", () => {
  const malformed = [
    JSON.stringify({ stores: { current: s3 } }),
    JSON.stringify({ version: 2, stores: { current: s3 } }),
    JSON.stringify({ version: 1, stores: {} }),
    JSON.stringify({ version: 1, stores: { current: { provider: "local" } } }),
    JSON.stringify({
      version: 1,
      stores: { current: { ...s3, root: "./data" } },
    }),
    JSON.stringify({
      version: 1,
      stores: { current: { ...s3, forcePathStyle: undefined } },
    }),
    JSON.stringify({
      version: 1,
      stores: { current: { ...s3, credentials: { accessKeyId: "test" } } },
    }),
    JSON.stringify({ version: 1, stores: { current: s3 }, other: true }),
  ];
  for (const raw of malformed)
    expect(() =>
      parseFileStoreEnvironment({
        DOCA_FILE_STORE_ID: "current",
        DOCA_FILE_STORES_JSON: raw,
      }),
    ).toThrow("Invalid file storage configuration");
});

it.each([
  "http://store.example",
  "https://user:secret@store.example",
  "https://store.example/path",
  "https://store.example/?secret=token",
  "https://store.example/#token",
])("rejects invalid deployment endpoint %j", (endpoint) => {
  expect(() =>
    parseFileStoreEnvironment(environment({ current: { ...s3, endpoint } })),
  ).toThrow("Invalid file storage configuration");
});

it("rejects namespace injection and prototype keys in the store mapping", () => {
  for (const id of [
    "../host",
    "current/other",
    "current other",
    "__proto__",
    "constructor",
    "a".repeat(65),
  ]) {
    const stores = JSON.parse(`{${JSON.stringify(id)}:${JSON.stringify(s3)}}`);
    expect(() => parseFileStoreEnvironment(environment(stores, id))).toThrow();
  }
});

it("does not leak malformed JSON, credentials, endpoints or store names in errors", () => {
  for (const raw of [
    "secret-json-that-must-not-be-logged",
    JSON.stringify({
      version: 1,
      stores: {
        current: {
          ...s3,
          endpoint: "https://user:sensitive-password@example.invalid",
        },
      },
    }),
  ]) {
    let failure: unknown;
    try {
      parseFileStoreEnvironment({
        DOCA_FILE_STORE_ID: "current",
        DOCA_FILE_STORES_JSON: raw,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const text = String(failure);
    expect(text).not.toContain("secret-json");
    expect(text).not.toContain("sensitive-password");
    expect(text).not.toContain("test-secret");
    expect(text).not.toContain("example.invalid");
  }
});

it("rejects malformed CDN signing keys before startup without exposing their value", () => {
  const invalidKey = "invalid-secret-key";
  expect(() =>
    parseFileStoreEnvironment(
      environment({
        current: {
          ...s3,
          cdn: {
            domain: "https://cdn.example",
            keyPairId: "test",
            privateKey: invalidKey,
          },
        },
      }),
    ),
  ).toThrow("Invalid file storage configuration");
});
