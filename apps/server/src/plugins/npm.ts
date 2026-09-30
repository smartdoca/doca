import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { zipSync } from "fflate";
import { readBounded, MAX_PLUGIN_BYTES } from "./store.js";
export function npmRegistry() {
  const url = new URL(
    process.env.DOCA_PLUGIN_NPM_REGISTRY?.trim() ||
      "https://registry.npmjs.org",
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid npm registry origin");
  return url.origin;
}
export function unpackNpm(bytes: Uint8Array) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const files: Record<string, Uint8Array> = Object.create(null);
  let offset = 0,
    count = 0;
  const string = (start: number, size: number) =>
    tar
      .subarray(start, start + size)
      .toString("utf8")
      .split("\0")[0]!;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((x) => x === 0)) break;
    const octal = (start: number, len: number) => {
      const value = string(offset + start, len).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar number");
      return parseInt(value, 8);
    };
    const sum = header.reduce(
      (a, b, i) => a + (i >= 148 && i < 156 ? 32 : b),
      0,
    );
    if (octal(148, 8) !== sum) throw new Error("Invalid tar checksum");
    const prefix = string(offset + 345, 155),
      name = (prefix ? prefix + "/" : "") + string(offset, 100),
      size = octal(124, 12),
      type = string(offset + 156, 1);
    if (
      ++count > 10000 ||
      !name.startsWith("package/") ||
      name.includes("\\") ||
      /[\x00-\x1f:]/.test(name) ||
      name.split("/").some((x) => x === ".." || x === ".")
    )
      throw new Error("Invalid npm archive path");
    if (!["", "0", "5"].includes(type))
      throw new Error("Links and special tar entries are forbidden");
    const end = offset + 512 + size;
    if (end > tar.length) throw new Error("Truncated npm archive");
    if (type !== "5") {
      const key = name.slice(8);
      if (!key || Object.hasOwn(files, key))
        throw new Error("Duplicate npm file");
      files[key] = tar.subarray(offset + 512, end);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files["package.json"]) throw new Error("Missing package.json");
  return files;
}
export async function downloadNpm(
  name: string,
  version: string,
  expected?: { registry: string; integrity: string; size: number },
  fetcher = fetch,
) {
  if (
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)
  )
    throw new Error("An exact npm package version is required");
  const registry = npmRegistry();
  if (expected && expected.registry !== registry)
    throw new Error("Untrusted npm registry");
  const response = await fetcher(
    `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  const metadata = JSON.parse(
    (await readBounded(response, 2 * 1024 * 1024)).toString(),
  );
  const integrity = metadata.dist?.integrity;
  if (
    metadata.name !== name ||
    metadata.version !== version ||
    typeof integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
    (expected && integrity !== expected.integrity)
  )
    throw new Error("npm metadata integrity mismatch");
  const url = new URL(metadata.dist.tarball);
  if (
    url.origin !== registry ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Untrusted npm tarball URL");
  const tgz = await readBounded(
    await fetcher(url.href, {
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    }),
    expected?.size ?? MAX_PLUGIN_BYTES,
  );
  if (
    (expected && tgz.length !== expected.size) ||
    `sha512-${createHash("sha512").update(tgz).digest("base64")}` !== integrity
  )
    throw new Error("npm archive checksum mismatch");
  const files = unpackNpm(tgz),
    pkg = JSON.parse(Buffer.from(files["package.json"]!).toString());
  if (pkg.name !== name || pkg.version !== version)
    throw new Error("npm package identity mismatch");
  const entries = Object.fromEntries(
    Object.entries(files).map(([key, value]) => [
      key,
      [value, { mtime: new Date("2020-01-01T00:00:00Z") }],
    ]),
  );
  const bytes = zipSync(entries as Parameters<typeof zipSync>[0]);
  if (bytes.length > MAX_PLUGIN_BYTES)
    throw new Error("Normalized package too large");
  return {
    bytes,
    npm: { registry, name, version, integrity, size: tgz.length },
  };
}
