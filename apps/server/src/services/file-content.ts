import type { FastifyReply, FastifyRequest } from "fastify";
import { createStorage, type StorageConfig } from "../adapters/storage.js";

/** Single-range responses support seeking without buffering the original file. */
export async function sendFileContent(
  req: FastifyRequest,
  reply: FastifyReply,
  storage: ReturnType<typeof createStorage>,
  config: StorageConfig,
  file: { object_key: string; size: number; mime: string; filename: string },
  download = false,
) {
  const size = Number(file.size);
  const activeContent =
    /^(text\/html|application\/xhtml\+xml|application\/xml|text\/xml)$/.test(
      file.mime,
    );
  reply
    .header("Accept-Ranges", "bytes")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; sandbox")
    .header(
      "Content-Disposition",
      `${download || activeContent ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    )
    .type(activeContent ? "application/octet-stream" : file.mime);
  let range: { start: number; end: number } | undefined;
  const invalidRange = () => reply
    .header("Cache-Control", "no-store")
    .removeHeader("ETag")
    .code(416)
    .header("Content-Range", `bytes */${size}`)
    .send();
  // If-Range conservatively requests the full body, including for weak image ETags.
  if (req.headers.range && !req.headers["if-range"]) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || !(match[1] || match[2]))
      return invalidRange();
    const start = match[1]
      ? Number(match[1])
      : Math.max(0, size - Number(match[2]));
    const end =
      match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    )
      return invalidRange();
    range = { start, end };
    reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  reply.header("Content-Length", range ? range.end - range.start + 1 : size);
  if (req.method === "HEAD") return reply.send();
  return reply.send(await storage.readStream(config, file.object_key, range));
}
