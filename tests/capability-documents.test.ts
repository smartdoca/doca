import { expect, expectTypeOf, it } from "vitest";
import {
  DOCUMENT_FILE_OWNER_PLUGIN,
  defineDocumentsServiceV1,
  documentFileOwner,
  type DocumentFilesPortV1,
  type DocumentsServiceV1,
} from "../packages/documents-capability/src/index.js";
import {
  FILES_WEB_CAPABILITIES_V1,
  stableId,
  type FileOwnerBindingTarget,
} from "../packages/files-capability/src/index.js";

const notImplemented = async (): Promise<never> => {
  throw new Error("interface-only test double");
};

it("keeps resource, access, and collaboration services as separate ports", async () => {
  let boundOwner: FileOwnerBindingTarget | undefined;
  const filePort = {
    version: 1,
    files: {
      create: notImplemented,
      get: notImplemented,
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
      async bind(_context, input) {
        boundOwner = input.owner;
        return {
          id: stableId("binding-01", "file-binding"),
          fileId: input.fileId,
          ...input.owner,
          createdAt: "2026-09-25T04:00:00.000Z",
        };
      },
      unbind: notImplemented,
      list: notImplemented,
    },
    content: {
      resolveContent: notImplemented,
      resolveDownload: notImplemented,
    },
  } satisfies DocumentFilesPortV1;

  const service = defineDocumentsServiceV1({
    version: 1,
    resources: {
      create: notImplemented,
      get: notImplemented,
      list: notImplemented,
      update: notImplemented,
      move: notImplemented,
      copy: notImplemented,
      trash: notImplemented,
      restore: notImplemented,
      purge: notImplemented,
    },
    access: {
      authorize: notImplemented,
      listGrants: notImplemented,
      putGrant: notImplemented,
      revokeGrant: notImplemented,
    },
    collaboration: {
      join: notImplemented,
      sync: notImplemented,
      async commit(_context, input) {
        return {
          protocolVersion: 1,
          resourceId: input.resourceId,
          messageId: input.messageId,
          epochId: input.epochId,
          seq: 9,
          changed: true,
        };
      },
      publishPresence: async () => {},
      leave: async () => {},
    },
    files: filePort,
  } satisfies DocumentsServiceV1);

  const resourceId = stableId("document-01", "document-resource");
  const fileId = stableId("file-01", "file");
  const owner = documentFileOwner(resourceId, "attachment");
  await service.files.bindings.bind(
    { principalId: "user-01" },
    { fileId, owner },
  );
  const ack = await service.collaboration.commit(
    { principalId: "user-01", sessionId: "session-01" },
    {
      protocolVersion: 1,
      resourceId,
      messageId: "message-01",
      codec: "example-codec",
      schemaVersion: 3,
      epochId: "epoch-01",
      update: new Uint8Array([1, 2, 3]),
    },
  );

  expect(Object.keys(service)).toEqual([
    "version",
    "resources",
    "access",
    "collaboration",
    "files",
  ]);
  expect(boundOwner).toEqual({
    ownerPlugin: DOCUMENT_FILE_OWNER_PLUGIN,
    ownerType: "document",
    ownerId: resourceId,
    role: "attachment",
  });
  expect(ack).toEqual({
    protocolVersion: 1,
    resourceId,
    messageId: "message-01",
    epochId: "epoch-01",
    seq: 9,
    changed: true,
  });
  expectTypeOf(service.files).toMatchTypeOf<DocumentFilesPortV1>();
});

it("does not require folder or web implementation details from documents", () => {
  expectTypeOf<DocumentFilesPortV1>().not.toHaveProperty("folders");
  expectTypeOf<DocumentFilesPortV1>().not.toHaveProperty("webCapabilities");
  expect(FILES_WEB_CAPABILITIES_V1).toHaveLength(5);
});
