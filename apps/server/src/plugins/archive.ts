import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { MAX_PLUGIN_BYTES } from "./store.js";
export const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function unpack(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_PLUGIN_BYTES)
    throw new Error("Invalid plugin archive size");
  let expanded = 0,
    count = 0;
  const names = new Set<string>();
  const files = unzipSync(bytes, {
    filter(file) {
      const name = file.name;
      if (
        ++count > 10000 ||
        !name ||
        name.startsWith("/") ||
        name.includes("\\") ||
        name.includes(":") ||
        /[\x00-\x1f]/.test(name) ||
        name.split("/").some((p) => p === ".." || p === ".") ||
        names.has(name)
      )
        throw new Error("Invalid archive path");
      names.add(name);
      expanded += file.originalSize;
      if (expanded > 128 * 1024 * 1024)
        throw new Error("Expanded archive too large");
      return !name.endsWith("/");
    },
  });
  if (!files["package.json"])
    throw new Error("package.json must be at ZIP root");
  return files;
}
async function readPackageFiles(directory: string) {
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Plugin root must be a real directory");
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  async function walk(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error("Release packages must not contain symbolic links");
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const file = path.join(directory, name);
        total += (await lstat(file)).size;
        if (total > 128 * 1024 * 1024 || Object.keys(files).length >= 10000)
          throw new Error("Plugin directory too large");
        files[name] = await readFile(file);
      } else throw new Error("Unsupported plugin file");
    }
  }
  await walk("");
  return files;
}
export async function pack(directory: string) {
  const files = await readPackageFiles(directory);
  const bytes = zipSync(files, { mtime: new Date("2020-01-01T00:00:00Z") });
  unpack(bytes);
  return bytes;
}
/** Check every file, not just the entry point. Reconstruct from the shared archive. */
export async function materialize(
  directory: string,
  hash: string,
  bytes: Uint8Array,
) {
  if (!/^[a-f0-9]{64}$/.test(hash) || digest(bytes) !== hash)
    throw new Error("Plugin checksum mismatch");
  const files = unpack(bytes);
  const root = path.join(directory, ".releases", hash);
  async function matches() {
    try {
      const current = await readPackageFiles(root);
      return (
        Object.keys(current).length === Object.keys(files).length &&
        Object.entries(files).every(
          ([name, content]) =>
            current[name] && digest(current[name]!) === digest(content),
        )
      );
    } catch {
      return false;
    }
  }
  if (await matches()) return root;
  const staging = path.join(directory, ".staging", randomUUID());
  await mkdir(staging, { recursive: true });
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const dest = path.join(staging, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes, { flag: "wx", mode: 0o600 });
    }
    await mkdir(path.dirname(root), { recursive: true });
    // Only invoked at startup for running releases; management writes new immutable hashes.
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return root;
}

/** Trusted database metadata lets a complete local cache start without downloading its ZIP again. */
export function archiveFileIndex(bytes: Uint8Array) {
  return JSON.stringify({
    version: 1,
    files: Object.fromEntries(
      Object.entries(unpack(bytes)).map(([name, content]) => [
        name,
        digest(content),
      ]),
    ),
  });
}
export async function cachedRelease(
  directory: string,
  hash: string,
  rawIndex: string,
) {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid plugin release identity");
  const index = JSON.parse(rawIndex) as { version: unknown; files: unknown };
  if (
    !index ||
    Object.keys(index).sort().join(",") !== "files,version" ||
    index.version !== 1 ||
    !index.files ||
    typeof index.files !== "object" ||
    Array.isArray(index.files)
  )
    throw new Error("Invalid plugin cache index");
  const entries = Object.entries(index.files);
  if (
    !entries.length ||
    entries.length > 10000 ||
    !Object.hasOwn(index.files, "package.json") ||
    entries.some(
      ([name, value]) =>
        !name ||
        name.startsWith("/") ||
        /[\\:\x00-\x1f]/.test(name) ||
        name.split("/").some((p) => p === ".." || p === "." || !p) ||
        typeof value !== "string" ||
        !/^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new Error("Invalid plugin cache index");
  const root = path.join(directory, ".releases", hash);
  try {
    const current = await readPackageFiles(root);
    return Object.keys(current).length === entries.length &&
      entries.every(
        ([name, hash]) =>
          Object.hasOwn(current, name) && digest(current[name]!) === hash,
      )
      ? root
      : null;
  } catch {
    return null;
  }
}
