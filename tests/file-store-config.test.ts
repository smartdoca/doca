import { generateKeyPairSync } from "node:crypto";
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
  "http://rustfs:9000",
  "http://10.0.0.10:9000",
  "http://[fd00::1]:9000",
  "https://store.example",
])("accepts explicit HTTP(S) deployment endpoint %j", (endpoint) => {
  const config = parseFileStoreEnvironment(
    environment({ current: { ...s3, endpoint, forcePathStyle: true } }),
  );
  expect(configuredFileStore(config, "current")).toMatchObject({
    endpoint,
    forcePathStyle: true,
  });
});

it.each([
  "ftp://store.example",
  "http://user:secret@rustfs:9000",
  "http://rustfs:9000/path",
  "http://rustfs:9000/?secret=token",
  "http://rustfs:9000/#token",
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

it("accepts HTTP(S) CDN origins with signing keys and rejects other protocols", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const store = {
    ...s3,
    endpoint: "http://rustfs:9000",
    cdn: { domain: "https://cdn.example", keyPairId: "test", privateKey },
  };
  for (const domain of ["http://cdn.internal", "https://cdn.example"])
    expect(() =>
      parseFileStoreEnvironment(
        environment({ current: { ...store, cdn: { ...store.cdn, domain } } }),
      ),
    ).not.toThrow();
  expect(() =>
    parseFileStoreEnvironment(
      environment({
        current: {
          ...store,
          cdn: { ...store.cdn, domain: "ftp://cdn.example" },
        },
      }),
    ),
  ).toThrow("Invalid file storage configuration");
});
