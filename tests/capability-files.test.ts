import { expect, expectTypeOf, it } from "vitest";
import {
  FILES_WEB_CAPABILITIES_V1,
  defineFilesServiceV1,
  fileOwnerBindingKey,
  stableId,
  type FilesServiceV1,
} from "../packages/files-capability/src/index.js";

const notImplemented = async (): Promise<never> => {
  throw new Error("interface-only test double");
};

it("defines the storage-independent files v1 interface", () => {
  const service = defineFilesServiceV1({
    version: 1,
    receipts: { get: notImplemented },
    folders: {
      create: notImplemented,
      get: notImplemented,
      list: notImplemented,
      update: notImplemented,
      delete: notImplemented,
    },
    files: {
      create: notImplemented,
      get: notImplemented,
      list: notImplemented,
      update: notImplemented,
      delete: notImplemented,
    },
    uploads: {
      begin: notImplemented,
      write: notImplemented,
      complete: notImplemented,
      abort: notImplemented,
      get: notImplemented,
    },
    bindings: {
      bind: notImplemented,
      unbind: notImplemented,
      list: notImplemented,
    },
    content: {
      resolveContent: notImplemented,
      resolveDownload: notImplemented,
    },
    webCapabilities: FILES_WEB_CAPABILITIES_V1,
  } satisfies FilesServiceV1);

  expect(service.version).toBe(1);
  expectTypeOf(service).toMatchTypeOf<FilesServiceV1>();
  expect(FILES_WEB_CAPABILITIES_V1.map(({ id }) => id)).toEqual([
    "files.browser",
    "files.picker",
    "files.upload",
    "files.preview",
    "files.download",
  ]);
  expect(
    FILES_WEB_CAPABILITIES_V1.every(
      ({ serviceVersion, requiresAuthorization }) =>
        serviceVersion === 1 && requiresAuthorization,
    ),
  ).toBe(true);
});

it("keys owner bindings by the complete owner tuple", () => {
  const fileId = stableId("file-01", "file");
  const owner = {
    ownerPlugin: "calendar",
    ownerType: "event",
    ownerId: "event-01",
    role: "attachment",
  };

  const key = fileOwnerBindingKey(fileId, owner);
  expect(JSON.parse(key)).toEqual([
    fileId,
    "calendar",
    "event",
    "event-01",
    "attachment",
  ]);
  expect(fileOwnerBindingKey(fileId, { ...owner, role: "cover" })).not.toBe(
    key,
  );
  expect(() => stableId("  ", "file")).toThrow("cannot be empty");
});
