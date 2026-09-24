import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { S3Client } from "@aws-sdk/client-s3";
import {
  createStorage,
  storageDefaults,
  validateStorage,
  type StorageRuntime,
} from "../apps/server/src/adapters/storage.js";
const runtime: StorageRuntime = {
  root: "/unused",
  credentials: {
    test: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
  },
  endpointHosts: ["storage.example.com"],
  cdnKeyPairId: undefined,
  cdnPrivateKey: undefined,
};
const config = {
  ...storageDefaults,
  provider: "s3" as const,
  bucket: "doca-files",
  credentialRef: "test",
};
const key = objectKey("6c59c39f-3a84-4656-8513-2bfe88336591", "application/octet-stream");
afterEach(() => vi.restoreAllMocks());
describe("storage adapters", () => {
  it("sends S3 uploads to the configured bucket and consumes downloads before closing", async () => {
    const commands: any[] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation((async (
      command: any,
    ) => {
      commands.push(command);
      return {
        Body: Readable.from([Buffer.from("downloaded")]),
      };
    }) as any);
    const store = createStorage(runtime);
    await store.put(
      config,
      key,
      Buffer.from("uploaded"),
      "application/octet-stream",
      "文档.pdf",
    );
    expect(commands[0].input).toMatchObject({
      Bucket: "doca-files",
      Key: key,
      ContentType: "application/octet-stream",
    });
    expect(commands[0].input.Body.toString()).toBe("uploaded");
    expect(commands[0].input.ACL).toBeUndefined();
    expect((await store.read(config, key)).toString()).toBe("downloaded");
    await store.remove(config, key);
    expect(commands.map((c) => c.constructor.name)).toEqual([
      "PutObjectCommand",
      "GetObjectCommand",
      "DeleteObjectCommand",
    ]);
  });
  it("requires configured credentials and explicit HTTPS endpoint allowlisting", () => {
    expect(() =>
      validateStorage({ ...config, credentialRef: "unknown" }, runtime),
    ).toThrow();
    for (const endpoint of [
      "http://storage.example.com",
      "https://127.0.0.1",
      "https://storage.example.com/path",
      "https://user:pw@storage.example.com",
    ])
      expect(() => validateStorage({ ...config, endpoint }, runtime)).toThrow();
    expect(() =>
      validateStorage(
        { ...config, endpoint: "https://storage.example.com" },
        runtime,
      ),
    ).not.toThrow();
  });
  it("never falls back to an unsigned public CDN URL", () => {
    expect(() =>
      validateStorage(
        { ...config, cdnDomain: "https://files.example.com" },
        runtime,
      ),
    ).toThrow();
    expect(() =>
      createStorage(runtime).cdnUrl(
        { ...config, cdnDomain: "https://files.example.com" },
        key,
      ),
    ).toThrow();
    expect(createStorage(runtime).cdnUrl(config, key)).toBeNull();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const url = new URL(
      createStorage({
        ...runtime,
        cdnPrivateKey: privateKey,
        cdnKeyPairId: "test-pair",
      }).cdnUrl(
        { ...config, cdnDomain: "https://files.example.com" },
        key,
      )!,
    );
    expect(url.hostname).toBe("files.example.com");
    expect(url.searchParams.get("Key-Pair-Id")).toBe("test-pair");
    expect(url.searchParams.get("Signature")).toBeTruthy();
    expect(
      Number(url.searchParams.get("Expires")) - Date.now() / 1000,
    ).toBeLessThanOrEqual(60);
  });
  it("rejects non-generated local object paths", async () => {
    await expect(
      createStorage(runtime).read(storageDefaults, "../../etc/passwd"),
    ).rejects.toThrow("Invalid object key");
  });
  it("keeps an S3 client alive until its download stream is consumed or cancelled", async () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy").mockImplementation(() => {});
    const body = new Readable({ read() {} });
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: body } as never);
    const stream = await createStorage(runtime).readStream(config, key, { start: 2, end: 5 });
    expect(destroy).not.toHaveBeenCalled();
    stream.destroy();
    await new Promise<void>(resolve => stream.once("close", resolve));
    expect(destroy).toHaveBeenCalled();
  });
});
