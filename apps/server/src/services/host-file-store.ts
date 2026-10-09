import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  createStorage,
  storageConfigForProfile,
  type StorageRuntime,
} from "../adapters/storage.js";
import { configuredFileStore } from "./file-store-config.js";
import { validateObjectKey } from "./storage-policy.js";

export function createHostFileStore(runtime: StorageRuntime) {
  const backend = createStorage(runtime);
  const sha = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  async function read(
    storeId: string,
    key: string,
    size: number,
    hash: string,
  ) {
    validateObjectKey(key);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 32 * 1024 ** 2 ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error("Invalid stored object metadata");
    const bytes = await backend.read(
      storageConfigForProfile(runtime, { id: storeId }),
      key,
      size,
    );
    if (bytes.length !== size || sha(bytes) !== hash)
      throw new Error("Stored object integrity check failed");
    return bytes;
  }
  return {
    currentId: runtime.configuration.currentId,
    read,
    /** Complete immutable bytes become visible atomically, before publishing database references. */
    async putImmutable(key: string, data: Uint8Array, mime: string) {
      validateObjectKey(key);
      if (data.length > 32 * 1024 ** 2)
        throw new Error("Stored object exceeds 32 MiB");
      const bytes = Buffer.from(data);
      const storeId = runtime.configuration.currentId;
      const c = configuredFileStore(runtime.configuration, storeId);
      let exists = false;
      if (c.provider === "local") {
        const root = storageConfigForProfile(runtime, { id: storeId }).root!;
        const target = resolve(root, key);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.pending-${randomUUID()}`;
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            await link(temporary, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            exists = true;
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
      } else {
        const client = new S3Client({
          region: c.region,
          endpoint: c.endpoint,
          forcePathStyle: c.forcePathStyle,
          // The SDK adds credential metadata; keep deployment configuration immutable.
          credentials: { ...c.credentials },
          requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
        });
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: c.bucket,
              Key: key,
              Body: bytes,
              ContentType: mime,
              ContentLength: bytes.length,
              IfNoneMatch: "*",
              ChecksumSHA256: createHash("sha256")
                .update(bytes)
                .digest("base64"),
            }),
          );
        } catch (error) {
          if (
            (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode !== 412
          )
            throw error;
          exists = true;
        } finally {
          client.destroy();
        }
      }
      const hash = sha(bytes);
      // Verify both a pre-existing immutable object and newly completed uploads before committing references.
      await read(storeId, key, bytes.length, hash);
      return {
        storeId,
        key,
        size: bytes.length,
        sha256: hash,
        existed: exists,
      };
    },
    async remove(storeId: string, key: string) {
      await backend.remove(
        storageConfigForProfile(runtime, { id: storeId }),
        key,
      );
    },
  };
}
export type HostFileStore = ReturnType<typeof createHostFileStore>;
