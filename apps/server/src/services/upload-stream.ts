import { randomUUID, createHash } from "node:crypto";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fail } from "@core/shared/errors.js";
import { detectFileMime } from "./storage-policy.js";

export async function readUploadBuffer(
  source: AsyncIterable<Uint8Array>,
  limit: number,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > limit) fail(413, "文件超过上传大小限制");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
/** Spool privately to disk while hashing; never retain a whole large upload in RAM. */
export async function stageUpload(
  root: string,
  source: Readable | Buffer,
  filename: string,
  limit: number,
) {
  const directory = join(root, "temporary", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "upload");
  const hash = createHash("sha256");
  let size = 0;
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await pipeline(
      Buffer.isBuffer(source) ? Readable.from([source]) : source,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > limit) {
            try {
              fail(413, "文件超过上传大小限制");
            } catch (error) {
              callback(error as Error);
            }
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    if (!size) fail(400, "请上传非空文件");
    return {
      path,
      size,
      sha256: hash.digest("hex"),
      mime: await detectFileMime(path, filename),
      stream: () => createReadStream(path),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Recover temporary files abandoned by a crashed process; active writes refresh mtime. */
export async function cleanupTemporaryUploads(
  root: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
) {
  const base = join(root, "temporary");
  const entries = await readdir(base, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        entry.name,
      )
    )
      continue;
    const directory = join(base, entry.name);
    try {
      const modified = await stat(join(directory, "upload")).catch((error) => {
        if (error.code === "ENOENT") return stat(directory);
        throw error;
      });
      if (Date.now() - modified.mtimeMs > maxAgeMs)
        await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
