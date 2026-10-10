import { promisify } from "node:util";
import { brotliCompress, gzip, constants } from "node:zlib";

type Encoding = "br" | "gzip";
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

export function contentEncoding(
  header: string | undefined,
): Encoding | "identity" | undefined {
  if (!header?.trim()) return "identity";
  const qualities = new Map<string, number>();
  for (const item of header.split(",")) {
    const [token, ...parameters] = item.trim().toLowerCase().split(";");
    const name = token?.trim();
    if (!name) continue;
    const quality = parameters.find((parameter) =>
      parameter.trim().startsWith("q="),
    );
    const value = quality?.trim().slice(2);
    const q =
      value === undefined
        ? 1
        : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)
          ? Number(value)
          : 0;
    qualities.set(name, q);
  }
  const wildcard = qualities.get("*") ?? 0;
  const candidates = (["br", "gzip"] as const)
    .map((encoding) => ({ encoding, q: qualities.get(encoding) ?? wildcard }))
    .filter(({ q }) => q > 0)
    .sort((a, b) => b.q - a.q);
  const identity = qualities.get("identity");
  if (
    identity !== undefined &&
    identity > 0 &&
    identity > (candidates[0]?.q ?? 0)
  )
    return "identity";
  if (candidates[0]) return candidates[0].encoding;
  return identity === 0 || (identity === undefined && qualities.get("*") === 0)
    ? undefined
    : "identity";
}

/** Cache only encoded bytes, with a bounded budget and shared in-flight work. */
export function staticCompressionCache(maxBytes = 32 * 1024 * 1024) {
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  let bytes = 0;
  return async (key: string, body: Buffer, encoding: Encoding) => {
    const id = `${key}:${encoding}`;
    const cached = cache.get(id);
    if (cached) {
      cache.delete(id);
      cache.set(id, cached);
      return cached;
    }
    const inFlight = pending.get(id);
    if (inFlight) return inFlight;
    const work = (
      encoding === "br"
        ? compressBrotli(body, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
          })
        : compressGzip(body, { level: 6 })
    )
      .then((encoded) => {
        if (encoded.length <= maxBytes) {
          while (bytes + encoded.length > maxBytes && cache.size) {
            const oldest = cache.keys().next().value!;
            bytes -= cache.get(oldest)!.length;
            cache.delete(oldest);
          }
          cache.set(id, encoded);
          bytes += encoded.length;
        }
        return encoded;
      })
      .finally(() => pending.delete(id));
    pending.set(id, work);
    return work;
  };
}
