import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { mkdir, open, unlink, rename, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { uploadLimits, validateObjectKey } from "../services/storage-policy.js";
import {
  parseFileStoreEnvironment,
  configuredFileStore,
  type HostFileStoreConfiguration,
} from "../services/file-store-config.js";
import { fail } from "@core/shared/errors.js";

export interface StorageConfig {
  provider: "local" | "s3";
  bucket: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  credentialRef: string;
  cdnDomain: string;
  root?: string;
  cdnKeyPairId?: string;
  cdnPrivateKey?: string;
}
export const storageDefaults: StorageConfig = {
  provider: "local",
  bucket: "",
  region: "us-east-1",
  endpoint: "",
  forcePathStyle: false,
  credentialRef: "default",
  cdnDomain: "",
};
type Credential = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
export function storageRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const configuration = parseFileStoreEnvironment(environment);
  const current = configuredFileStore(configuration, configuration.currentId);
  const credentials: Record<string, Credential> = {};
  const endpointHosts: string[] = [];
  for (const [id, store] of configuration.stores)
    if (store.provider === "s3") {
      credentials[id] = { ...store.credentials };
      if (store.endpoint) endpointHosts.push(new URL(store.endpoint).host);
    }
  return {
    configuration,
    root: current.provider === "local" ? current.root : "",
    credentials,
    endpointHosts,
    cdnKeyPairId:
      current.provider === "s3" ? current.cdn?.keyPairId : undefined,
    cdnPrivateKey:
      current.provider === "s3" ? current.cdn?.privateKey : undefined,
  };
}
/** Profiles contain only a stable store ID. Infrastructure is resolved from deployment configuration. */
export function storageConfigForProfile(
  runtime: StorageRuntime,
  profile: { id: string },
): StorageConfig {
  const c = configuredFileStore(runtime.configuration, profile.id);
  return c.provider === "local"
    ? {
        ...storageDefaults,
        root:
          profile.id === runtime.configuration.currentId
            ? runtime.root
            : c.root,
      }
    : {
        provider: "s3",
        bucket: c.bucket,
        region: c.region,
        endpoint: c.endpoint ?? "",
        forcePathStyle: c.forcePathStyle,
        credentialRef: profile.id,
        cdnDomain: c.cdn?.domain ?? "",
        cdnKeyPairId: c.cdn?.keyPairId,
        cdnPrivateKey: c.cdn?.privateKey,
      };
}
export type StorageRuntime = ReturnType<typeof storageRuntime>;
export function validateStorage(c: StorageConfig, runtime: StorageRuntime) {
  if (c.provider === "local") return;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket))
    fail(400, "存储桶名称无效");
  if (
    !runtime.credentials[c.credentialRef]?.secretAccessKey ||
    !runtime.credentials[c.credentialRef]?.accessKeyId
  )
    fail(400, "请通过文件存储环境变量配置此存储凭据");
  if (c.endpoint) {
    let u: URL;
    try {
      u = new URL(c.endpoint);
    } catch {
      return fail(400, "云存储端点格式无效");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      !runtime.endpointHosts.includes(u.host)
    )
      fail(400, "云存储端点必须为 HTTPS，且位于文件存储环境变量配置中");
  }
  if (c.cdnDomain) {
    let u: URL;
    try {
      u = new URL(c.cdnDomain);
    } catch {
      return fail(400, "CDN 域名格式无效");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      fail(400, "CDN 请填写 HTTPS 域名，不带路径或参数");
    if (
      !(c.cdnKeyPairId ?? runtime.cdnKeyPairId) ||
      !(c.cdnPrivateKey ?? runtime.cdnPrivateKey)
    )
      fail(400, "CDN 需要配置 CloudFront 签名密钥，以保护私有文件");
  }
}
export function createStorage(runtime: StorageRuntime) {
  function path(c: StorageConfig, key: string) {
    validateObjectKey(key);
    return resolve(c.root ?? runtime.root, key);
  }
  function client(c: StorageConfig) {
    const credentials = runtime.credentials[c.credentialRef];
    if (!credentials?.accessKeyId || !credentials.secretAccessKey)
      fail(503, "云存储凭据不可用");
    return new S3Client({
      region: c.region,
      endpoint: c.endpoint || undefined,
      forcePathStyle: c.forcePathStyle,
      credentials,
      maxAttempts: 2,
      requestHandler: { requestTimeout: 30000, connectionTimeout: 5000 },
    });
  }
  async function send(
    c: StorageConfig,
    command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand,
  ) {
    const s3 = client(c);
    try {
      return await s3.send(command as GetObjectCommand);
    } finally {
      s3.destroy();
    }
  }
  async function putStream(
    c: StorageConfig,
    key: string,
    source: Readable,
    size: number,
    mime: string,
    filename: string,
  ) {
    validateObjectKey(key);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Invalid object size");
    async function* checked() {
      let received = 0;
      for await (const chunk of source) {
        received += chunk.length;
        if (received > size) throw new Error("Upload size mismatch");
        yield chunk;
      }
      if (received !== size) throw new Error("Upload size mismatch");
    }
    if (c.provider === "local") {
      const target = path(c, key);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", 0o600);
      try {
        await pipeline(Readable.from(checked()), handle.createWriteStream());
      } catch (error) {
        await unlink(target).catch(() => {});
        throw error;
      } finally {
        source.destroy();
        await handle.close();
      }
      return;
    }
    const s3 = client(c);
    const metadata = {
      Bucket: c.bucket,
      Key: key,
      ContentType: mime,
      ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      CacheControl: "private, max-age=60",
    };
    let uploadId: string | undefined;
    try {
      if (size < uploadLimits.multipartThreshold) {
        await s3.send(
          new PutObjectCommand({
            ...metadata,
            Body: Readable.from(checked(), { objectMode: false }),
            ContentLength: size,
          }),
        );
      } else {
        uploadId = (await s3.send(new CreateMultipartUploadCommand(metadata)))
          .UploadId;
        if (!uploadId) throw new Error("Missing multipart upload ID");
        const parts: { ETag: string; PartNumber: number }[] = [];
        let pending: Buffer[] = [];
        let pendingSize = 0;
        const sendPart = async (body: Buffer) => {
          const PartNumber = parts.length + 1;
          const result = await s3.send(
            new UploadPartCommand({
              Bucket: c.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber,
              Body: body,
              ContentLength: body.length,
            }),
          );
          if (!result.ETag) throw new Error("Missing uploaded part ETag");
          parts.push({ ETag: result.ETag, PartNumber });
        };
        for await (const chunk of checked()) {
          let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          while (bytes.length) {
            const n = Math.min(
              uploadLimits.multipartPart - pendingSize,
              bytes.length,
            );
            pending.push(bytes.subarray(0, n));
            pendingSize += n;
            bytes = bytes.subarray(n);
            if (pendingSize === uploadLimits.multipartPart) {
              await sendPart(Buffer.concat(pending, pendingSize));
              pending = [];
              pendingSize = 0;
            }
          }
        }
        if (pendingSize) await sendPart(Buffer.concat(pending, pendingSize));
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: c.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
      }
    } catch (error) {
      if (uploadId)
        await s3
          .send(
            new AbortMultipartUploadCommand({
              Bucket: c.bucket,
              Key: key,
              UploadId: uploadId,
            }),
          )
          .catch(() => {});
      throw error;
    } finally {
      source.destroy();
      s3.destroy();
    }
  }
  async function readStream(
    c: StorageConfig,
    key: string,
    range?: { start: number; end: number },
  ) {
    validateObjectKey(key);
    if (c.provider === "local") {
      const handle = await open(path(c, key), "r");
      return handle.createReadStream(range);
    }
    const s3 = client(c);
    try {
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: c.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!out.Body) fail(503, "云端文件暂时不可用");
      const body = out.Body as Readable;
      body.once("close", () => s3.destroy());
      body.once("end", () => s3.destroy());
      body.once("error", () => s3.destroy());
      return body;
    } catch (error) {
      s3.destroy();
      throw error;
    }
  }
  return {
    putStream,
    readStream,
    async put(
      c: StorageConfig,
      key: string,
      data: Buffer,
      mime: string,
      filename: string,
      reservedReplay = false,
    ) {
      validateObjectKey(key);
      if (c.provider === "local" && reservedReplay) {
        // Only the durable operation owner may replace this key, after checking
        // the immutable content fingerprint. Readers never see partial bytes.
        const target = path(c, key);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.pending-${randomUUID()}`;
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(data);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, target);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      } else if (c.provider === "local")
        await putStream(
          c,
          key,
          Readable.from([data]),
          data.length,
          mime,
          filename,
        );
      else
        await send(
          c,
          new PutObjectCommand({
            Bucket: c.bucket,
            Key: key,
            Body: data,
            ContentType: mime,
            ContentDisposition: `${mime === "image/webp" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
            CacheControl: "private, max-age=60",
          }),
        );
    },
    async read(c: StorageConfig, key: string, maxBytes = uploadLimits.asset) {
      const stream = await readStream(c, key);
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > maxBytes) fail(413, "文件超过当前处理任务的大小限制");
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks, size);
      } finally {
        stream.destroy();
      }
    },
    /** Called with the durable operation lock held; never scan unrelated directories. */
    async removeReservedTemporaries(c: StorageConfig, key: string) {
      if (c.provider !== "local") return;
      const target = path(c, key);
      const prefix = target.slice(target.lastIndexOf("/") + 1) + ".pending-";
      const names = await readdir(dirname(target)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const name of names)
        if (
          name.startsWith(prefix) &&
          /^[a-f0-9-]{36}$/.test(name.slice(prefix.length))
        )
          await unlink(resolve(dirname(target), name));
    },
    async remove(c: StorageConfig, key: string) {
      validateObjectKey(key);
      if (c.provider === "local") await unlink(path(c, key));
      else
        await send(c, new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
    },
    cdnUrl(c: StorageConfig, key: string) {
      if (c.provider !== "s3" || !c.cdnDomain) return null;
      validateObjectKey(key);
      if (
        !(c.cdnKeyPairId ?? runtime.cdnKeyPairId) ||
        !(c.cdnPrivateKey ?? runtime.cdnPrivateKey)
      )
        fail(503, "CDN 签名配置不可用");
      return getSignedUrl({
        url: new URL(key, c.cdnDomain.replace(/\/$/, "") + "/").href,
        keyPairId: (c.cdnKeyPairId ?? runtime.cdnKeyPairId)!,
        privateKey: (c.cdnPrivateKey ?? runtime.cdnPrivateKey)!,
        dateLessThan: new Date(
          (Math.floor(Date.now() / 1000) + 60) * 1000,
        ).toISOString(),
      });
    },
  };
}
