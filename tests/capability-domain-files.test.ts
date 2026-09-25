import { expect, it } from "vitest";
import {
  createFileBindingOperationsV1,
  fileOwnerBindingKey,
  stableId,
  type FileBindingRepositoryV1,
  type FileOwnerBinding,
} from "../packages/files-capability/src/index.js";
import {
  createDocumentResourceCallbacksV1,
  type DocumentFilesPortV1,
} from "../packages/documents-capability/src/index.js";

it("stores generic owner bindings as idempotent exact tuples", async () => {
  const rows = new Map<string, FileOwnerBinding>();
  const repository: FileBindingRepositoryV1 = {
    async get(key) {
      return rows.get(key) ?? null;
    },
    async insert(key, binding) {
      const existing = rows.get(key);
      if (existing) return existing;
      rows.set(key, binding);
      return binding;
    },
    async delete(key) {
      return rows.delete(key);
    },
    async list(filter) {
      return [...rows.values()].filter((binding) => {
        if ("fileId" in filter) return binding.fileId === filter.fileId;
        return Object.entries(filter.owner).every(
          ([key, value]) =>
            value === undefined ||
            binding[key as keyof FileOwnerBinding] === value,
        );
      });
    },
  };
  let sequence = 0;
  const operations = createFileBindingOperationsV1({
    repository,
    policy: { authorize: async () => undefined },
    createId: () => stableId(`binding-${++sequence}`, "file-binding"),
    now: () => "2026-09-25T06:00:00.000Z",
  });
  const context = { principalId: "user-01" };
  const fileId = stableId("file-01", "file");
  const attachment = {
    ownerPlugin: "example.calendar",
    ownerType: "event",
    ownerId: "event-01",
    role: "attachment",
  };

  const first = await operations.bind(context, { fileId, owner: attachment });
  const duplicate = await operations.bind(context, {
    fileId,
    owner: attachment,
  });
  const cover = await operations.bind(context, {
    fileId,
    owner: { ...attachment, role: "cover" },
  });

  expect(duplicate).toBe(first);
  expect(cover.id).not.toBe(first.id);
  expect(
    await operations.list(context, {
      owner: {
        ownerPlugin: "example.calendar",
        ownerType: "event",
        ownerId: "event-01",
      },
    }),
  ).toEqual([first, cover]);
  expect(
    await operations.unbind(context, { fileId, owner: attachment }),
  ).toEqual({ removed: true });
  expect(rows.has(fileOwnerBindingKey(fileId, attachment))).toBe(false);
  expect(
    rows.has(fileOwnerBindingKey(fileId, { ...attachment, role: "cover" })),
  ).toBe(true);
});

it("adapts document resource callbacks to uploads and generic bindings", async () => {
  const events: string[] = [];
  const uploadId = stableId("upload-01", "file-upload");
  const fileId = stableId("file-01", "file");
  const filePort = {
    version: 1,
    files: {
      async create(_context, input) {
        events.push(`create:${input.name}`);
        return {
          id: fileId,
          folderId: null,
          name: input.name,
          mime: "image/png",
          size: 3,
          version: 1,
          createdAt: "2026-09-25T06:00:00.000Z",
          updatedAt: "2026-09-25T06:00:00.000Z",
        };
      },
      async get() {
        return null;
      },
      async delete() {
        events.push("delete");
      },
    },
    uploads: {
      async begin() {
        events.push("begin");
        return {
          id: uploadId,
          filename: "image.png",
          receivedBytes: 0,
          state: "open" as const,
          createdAt: "2026-09-25T06:00:00.000Z",
        };
      },
      async write(_context, input) {
        events.push(`write:${input.bytes.byteLength}`);
        return {
          id: uploadId,
          filename: "image.png",
          receivedBytes: input.bytes.byteLength,
          state: "open" as const,
          createdAt: "2026-09-25T06:00:00.000Z",
        };
      },
      async complete() {
        events.push("complete");
        return {
          id: uploadId,
          filename: "image.png",
          receivedBytes: 3,
          state: "completed" as const,
          createdAt: "2026-09-25T06:00:00.000Z",
          completedAt: "2026-09-25T06:00:01.000Z",
        };
      },
      async abort() {
        events.push("abort");
      },
      async get() {
        return null;
      },
    },
    bindings: {
      async bind(_context, input) {
        events.push(`bind:${input.owner.role}`);
        return {
          id: stableId("binding-01", "file-binding"),
          fileId: input.fileId,
          ...input.owner,
          createdAt: "2026-09-25T06:00:01.000Z",
        };
      },
      async unbind() {
        return { removed: false };
      },
      async list() {
        return [];
      },
    },
    content: {
      async resolveContent(_context, input) {
        return {
          fileId: input.fileId,
          href: `/content/${input.fileId}`,
          method: "GET" as const,
          filename: "image.png",
          mime: "image/png",
          size: 3,
          disposition: "inline" as const,
        };
      },
      async resolveDownload(_context, input) {
        return {
          fileId: input.fileId,
          href: `/download/${input.fileId}`,
          method: "GET" as const,
          filename: input.filename ?? "image.png",
          mime: "image/png",
          size: 3,
          disposition: "attachment" as const,
        };
      },
    },
  } satisfies DocumentFilesPortV1;
  const callbacks = createDocumentResourceCallbacksV1({
    files: filePort,
    context: { principalId: "user-01" },
    resourceId: stableId("document-01", "document-resource"),
  });

  await expect(
    callbacks.uploadImage({
      filename: "image.png",
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }),
  ).resolves.toMatchObject({ path: fileId, mime: "image/png", size: 3 });
  await expect(callbacks.resolveUrl(fileId)).resolves.toBe(
    `/content/${fileId}`,
  );
  await expect(callbacks.resolveDownloadUrl(fileId)).resolves.toBe(
    `/download/${fileId}`,
  );
  expect(events).toEqual([
    "begin",
    "write:3",
    "complete",
    "create:image.png",
    "bind:image",
  ]);
});
