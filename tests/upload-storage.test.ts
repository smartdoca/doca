import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { S3Client } from "@aws-sdk/client-s3";
import {
  createStorage,
  storageDefaults,
  type StorageRuntime,
} from "../apps/server/src/adapters/storage.js";
import {
  objectKey,
  derivativeKey,
  filePolicy,
  detectBufferMime,
  validateObjectKey,
  uploadLimits,
} from "../apps/server/src/services/storage-policy.js";
import { stageUpload, cleanupTemporaryUploads } from "../apps/server/src/services/upload-stream.js";

let root: string;
let runtime: StorageRuntime;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-upload-storage-"));
  runtime = {
    root,
    credentials: {
      test: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    },
    endpointHosts: [],
    cdnKeyPairId: undefined,
    cdnPrivateKey: undefined,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("detects content instead of trusting an extension and keeps size policy separate from physical paths", async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  expect(await detectBufferMime(png, "pretend-video.mp4")).toBe("image/png");
  expect(
    await detectBufferMime(Buffer.from("a text file"), "pretend-video.mp4"),
  ).toBe("text/plain");
  expect(
    await detectBufferMime(Buffer.from([0, 1, 0, 255]), "pretend-image.png"),
  ).toBe("application/octet-stream");
  const id = randomUUID();
  expect(objectKey(id, "image/png")).toBe(
    `objects/image/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}/original`,
  );
  expect(filePolicy("video/mp4", 10)).toMatchObject({
    category: "video",
    large: false,
    upload: "single",
  });
  expect(filePolicy("application/zip", 40 * 1024 ** 2)).toMatchObject({
    category: "archive",
    large: true,
    upload: "multipart",
  });
  expect(() =>
    validateObjectKey(
      derivativeKey(id, "image/png", "thumbnail-v1", "preview.webp"),
    ),
  ).not.toThrow();
  for (const key of [
    "objects/" + id,
    "../../etc/passwd",
    objectKey(id, "image/png") + "/../private",
    objectKey(id, "image/png").replace("/original", "/%2e%2e"),
  ])
    expect(() => validateObjectKey(key)).toThrow("Invalid object key");
});

it("stages bounded streams, hashes originals, and removes partial uploads on error or overflow", async () => {
  const bytes = Buffer.from("original bytes");
  const staged = await stageUpload(
    root,
    Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
    "notes.txt",
    100,
  );
  expect(staged).toMatchObject({ size: bytes.length, mime: "text/plain" });
  expect(await readFile(staged.path)).toEqual(bytes);
  expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/);
  await staged.cleanup();
  await expect(
    stageUpload(root, Readable.from([Buffer.alloc(11)]), "big.bin", 10),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    stageUpload(
      root,
      Readable.from(
        (async function* () {
          yield bytes;
          throw new Error("connection lost");
        })(),
      ),
      "lost.bin",
      100,
    ),
  ).rejects.toThrow("connection lost");
  expect(await readdir(join(root, "temporary"))).toEqual([]);
});

it("streams local originals and byte ranges and never leaves a partially written object", async () => {
  const storage = createStorage(runtime),
    key = objectKey(randomUUID(), "video/mp4");
  const bytes = Buffer.from("0123456789");
  await storage.putStream(
    storageDefaults,
    key,
    Readable.from([bytes]),
    bytes.length,
    "video/mp4",
    "video.mp4",
  );
  expect(await storage.read(storageDefaults, key)).toEqual(bytes);
  const chunks = [];
  for await (const chunk of await storage.readStream(storageDefaults, key, {
    start: 2,
    end: 5,
  }))
    chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe("2345");
  await expect(storage.read(storageDefaults, key, 5)).rejects.toMatchObject({
    status: 413,
  });
  await expect(
    storage.putStream(
      storageDefaults,
      key,
      Readable.from([Buffer.from("overwrite")]),
      9,
      "video/mp4",
      "x",
    ),
  ).rejects.toThrow();
  expect(await storage.read(storageDefaults, key)).toEqual(bytes);
  const broken = objectKey(randomUUID(), "video/mp4");
  await expect(
    storage.putStream(
      storageDefaults,
      broken,
      Readable.from([bytes]),
      100,
      "video/mp4",
      "broken",
    ),
  ).rejects.toThrow("Upload size mismatch");
  await expect(readFile(join(root, broken))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("cleans abandoned temporary uploads while retaining recent uploads and originals", async () => {
  const old = await stageUpload(root, Buffer.from("old"), "old.txt", 10);
  const recent = await stageUpload(root, Buffer.from("recent"), "new.txt", 10);
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(old.path, past, past);
  const key = objectKey(randomUUID(), "text/plain");
  await createStorage(runtime).put(storageDefaults, key, Buffer.from("saved"), "text/plain", "saved.txt");
  await cleanupTemporaryUploads(root);
  await expect(readFile(old.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readFile(recent.path)).toString()).toBe("recent");
  expect((await readFile(join(root, key))).toString()).toBe("saved");
});

it.each([false, true])(
  "S3 multipart uploads finish or abort without keeping whole files in memory (failure=%s)",
  async (failure) => {
    const commands: any[] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation((async (
      command: any,
    ) => {
      commands.push(command);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload-1" };
      if (command.constructor.name === "UploadPartCommand") {
        if (failure && command.input.PartNumber === 2)
          throw new Error("storage unavailable");
        return { ETag: `part-${command.input.PartNumber}` };
      }
      return {};
    }) as any);
    const config = {
      ...storageDefaults,
      provider: "s3" as const,
      bucket: "test-files",
      credentialRef: "test",
    };
    const part = Buffer.alloc(uploadLimits.multipartPart, 7);
    const operation = createStorage(runtime).putStream(
      config,
      objectKey(randomUUID(), "video/mp4"),
      Readable.from(
        (async function* () {
          for (let i = 0; i < 5; i++) yield part;
        })(),
      ),
      part.length * 5,
      "video/mp4",
      "video.mp4",
    );
    if (failure) await expect(operation).rejects.toThrow("storage unavailable");
    else await operation;
    const names = commands.map((c) => c.constructor.name);
    expect(names[0]).toBe("CreateMultipartUploadCommand");
    expect(names.at(-1)).toBe(
      failure
        ? "AbortMultipartUploadCommand"
        : "CompleteMultipartUploadCommand",
    );
    if (!failure) {
      const parts = commands.filter(
        (c) => c.constructor.name === "UploadPartCommand",
      );
      expect(parts).toHaveLength(5);
      expect(
        parts.every((c) => c.input.Body.length === uploadLimits.multipartPart),
      ).toBe(true);
      expect(commands.at(-1).input.MultipartUpload.Parts).toHaveLength(5);
    } else expect(names).not.toContain("CompleteMultipartUploadCommand");
  },
);
