// Drop node_modules that the production server never loads.
// The web app is already built into apps/web/dist. Vite is only used with --dev,
// which the production image refuses to start.
import { readdirSync, readFileSync, lstatSync, rmSync, unlinkSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const apply = process.argv.includes("--apply");
const root = path.resolve(process.argv.slice(2).find((arg) => arg !== "--apply") ?? ".");
const devOnly = new Set(["vite"]);
// These packages declare browser UI dependencies that the server entrypoints do not load.
const traceOnly = new Set([
  "@smartdoca/sheet",
  "@smartdoca/markdown",
  "@smartdoca/slate",
  "@smartdoca/slides",
  "@smartdoca/canvas",
]);
// Mermaid is imported by the markdown editor's browser diagram component.
// Loading the package on the server does not execute that import.
const browserDynamic = new Set(["mermaid"]);
const required = [
  "tsx",
  "esbuild",
  "fastify",
  "better-sqlite3",
  "kysely",
  "pg",
  "sharp",
  "pdfjs-dist",
  "@napi-rs/canvas",
  "@mastra/core",
  "@mastra/memory",
  "@mastra/libsql",
  "@mastra/pg",
  "yjs",
  "slate",
  "zod",
  "ws",
  "@aws-sdk/client-s3",
  "@aws-sdk/cloudfront-signer",
  "file-type",
  "redis",
  "@fastify/websocket",
  "@fastify/swagger",
  "@modelcontextprotocol/sdk",
  "@mendable/firecrawl-js",
  "qrcode",
  "htmlparser2",
  "fflate",
  "ipaddr.js",
  "openid-client",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "@ai-sdk/azure",
  "@ai-sdk/openai-compatible",
  "@sinclair/typebox",
  "dotenv",
  "@deepseek-ai/cordis",
  "@smartdoca/sheet",
  "@smartdoca/slate",
  "@smartdoca/canvas",
  "@smartdoca/slides",
  "@smartdoca/markdown",
];

const sourceRoots = [path.join(root, "apps/server"), path.join(root, "packages")];
const queue = [];
const seenFiles = new Set();
const keptDirs = new Set();
const skippedDynamic = new Map();

function walkSource(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSource(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
}

function packageName(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("\0")) return null;
  if (specifier.startsWith("@core/") || specifier.startsWith("@db/") || specifier.startsWith("@server/") || specifier.startsWith("@web/")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function typeOnly(clause) {
  const text = clause.trim();
  if (text.startsWith("type ") || text.startsWith("type{")) return true;
  if (!text.startsWith("{")) return false;
  const body = text.slice(1, text.lastIndexOf("}"));
  const parts = body.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => part.startsWith("type "));
}

function specifiersIn(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  const typescript = /\.(ts|tsx|mts|cts)$/.test(file);
  for (const match of text.matchAll(/\b(?:import|export)\s+([\s\S]*?)\sfrom\s*['"]([^'"]+)['"]/g)) {
    if (typescript && typeOnly(match[1])) continue;
    specs.push(match[2]);
  }
  for (const match of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(match[1]);
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const own = file.startsWith(path.join(root, "node_modules") + path.sep);
  for (const match of text.matchAll(dynamic)) {
    if (own && browserDynamic.has(packageName(match[1]) ?? match[1])) {
      const list = skippedDynamic.get(match[1]) ?? 0;
      skippedDynamic.set(match[1], list + 1);
      continue;
    }
    specs.push(match[1]);
  }
  for (const match of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  return specs;
}

const resolvers = new Map();
function resolveSpecifier(specifier, fromFile) {
  // The server is ESM, so follow the import condition. createRequire follows the
  // require condition and misses packages that only the ESM entry loads.
  const viaExport = resolveImportExport(specifier, fromFile);
  if (viaExport) return viaExport;
  try {
    let resolver = resolvers.get(fromFile);
    if (!resolver) {
      resolver = createRequire(fromFile);
      resolvers.set(fromFile, resolver);
    }
    return resolver.resolve(specifier);
  } catch {
    return null;
  }
}

function pickExportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickExportTarget(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const key of ["import", "default", "node", "require"]) {
    if (key in value) return pickExportTarget(value[key]);
  }
  return null;
}

function resolveImportExport(specifier, fromFile) {
  const name = packageName(specifier);
  if (!name) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, "index.js")].find((file) => existsSync(file)) ?? null;
  }
  const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
  let dir = path.dirname(fromFile);
  while (true) {
    const pkgDir = path.join(dir, "node_modules", ...name.split("/"));
    const manifestPath = path.join(pkgDir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const target = manifest.exports
        ? pickExportTarget(manifest.exports[subpath])
        : subpath === "."
          ? manifest.module || manifest.main
          : subpath.slice(2);
      if (!target || target.startsWith(".")) {
        const file = target ? path.join(pkgDir, target) : null;
        if (file && existsSync(file)) return file;
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function existingRealpath(file) {
  let current = file;
  const suffix = [];
  while (true) {
    try {
      return path.join(realpathSync(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return file;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function pnpmDir(file) {
  const normal = file.split(path.sep).join("/");
  const marker = "/node_modules/.pnpm/";
  const index = normal.indexOf(marker);
  if (index < 0) return null;
  const id = normal.slice(index + marker.length).split("/")[0];
  return path.join(normal.slice(0, index), "node_modules/.pnpm", id);
}

function ownManifest(dir) {
  const modules = path.join(dir, "node_modules");
  if (!existsSync(modules)) return null;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    const full = path.join(modules, entry.name);
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const child of readdirSync(full, { withFileTypes: true })) {
        if (child.isSymbolicLink() || !child.isDirectory()) continue;
        const manifest = path.join(full, child.name, "package.json");
        if (existsSync(manifest)) return manifest;
      }
    } else if (entry.isDirectory()) {
      const manifest = path.join(full, "package.json");
      if (existsSync(manifest)) return manifest;
    }
  }
  return null;
}

function installedPackage(name, fromFile) {
  const segments = name.split("/");
  let dir = path.dirname(fromFile);
  while (true) {
    const candidate = path.join(dir, "node_modules", ...segments);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function enqueue(specifier, fromFile) {
  if (devOnly.has(specifier) || devOnly.has(packageName(specifier))) return;
  const resolved = resolveSpecifier(specifier, fromFile);
  if (resolved) consider(resolved);
}

function consider(file) {
  const canonical = existingRealpath(file);
  if (seenFiles.has(canonical)) return;
  seenFiles.add(canonical);
  const dir = pnpmDir(canonical);
  if (dir && !keptDirs.has(dir)) {
    keptDirs.add(dir);
    const manifestPath = ownManifest(dir);
    if (manifestPath) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const declared = [
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...(traceOnly.has(manifest.name) ? [] : Object.keys(manifest.dependencies ?? {})),
      ];
      for (const name of declared) {
        const located = resolveSpecifier(name, manifestPath) ?? installedPackage(name, manifestPath);
        if (located) consider(located);
      }
    }
  }
  if (/\.(js|mjs|cjs|ts|tsx|mts|cts)$/.test(canonical)) queue.push(canonical);
}

const sources = [];
for (const dir of sourceRoots) if (existsSync(dir)) walkSource(dir, sources);
for (const file of sources) for (const specifier of specifiersIn(file)) enqueue(specifier, file);
enqueue("tsx", path.join(root, "package.json"));

while (queue.length) {
  const file = queue.pop();
  if (!existsSync(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  for (const specifier of specifiersIn(file)) enqueue(specifier, file);
}

function inodesUnder(dir) {
  const inodes = new Map();
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
    } else if (stat.isFile()) inodes.set(stat.ino, stat.size);
  }
  return inodes;
}

const store = path.join(root, "node_modules/.pnpm");
const allDirs = existsSync(store)
  ? readdirSync(store, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(store, entry.name))
  : [];
const keptInodes = new Map();
const dropped = [];
for (const dir of allDirs) {
  const inodes = inodesUnder(dir);
  if (keptDirs.has(dir)) {
    for (const [inode, size] of inodes) keptInodes.set(inode, size);
  } else dropped.push([dir, inodes]);
}
let mapBytes = 0;
function sumMaps(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
    } else if (current.endsWith(".map")) mapBytes += stat.size;
  }
}
for (const dir of keptDirs) sumMaps(dir);

const keptNames = new Set();
for (const dir of keptDirs) {
  const manifestPath = ownManifest(dir);
  if (!manifestPath) continue;
  keptNames.add(JSON.parse(readFileSync(manifestPath, "utf8")).name);
}
const missing = required.filter((name) => !keptNames.has(name));

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const droppedBytes = dropped.reduce((sum, [, inodes]) => {
  let local = 0;
  for (const [inode, size] of inodes) if (!keptInodes.has(inode)) local += size;
  return sum + local;
}, 0);
const keptBytes = [...keptInodes.values()].reduce((sum, size) => sum + size, 0);
console.log(`runtime packages ${keptDirs.size}/${allDirs.length}`);
console.log(`keep ${mb(keptBytes)}, drop ${mb(droppedBytes)}, source maps inside kept packages ${mb(mapBytes)}`);
if (missing.length) {
  console.error(`missing required packages: ${missing.join(", ")}`);
  process.exit(1);
}
const ranked = dropped
  .map(([dir, inodes]) => {
    let size = 0;
    for (const [inode, bytes] of inodes) if (!keptInodes.has(inode)) size += bytes;
    return [size, path.basename(dir).split("_")[0]];
  })
  .sort((a, b) => b[0] - a[0])
  .slice(0, 15);
for (const [size, name] of ranked) if (size > 1024 * 1024) console.log(`  drop ${mb(size)} ${name}`);
const dynamic = [...skippedDynamic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
if (dynamic.length) {
  console.log("skipped dynamic imports in dependencies:");
  for (const [specifier, count] of dynamic) console.log(`  ${count} ${specifier}`);
}

if (!apply) process.exit(0);

for (const dir of allDirs) if (!keptDirs.has(dir)) rmSync(dir, { recursive: true, force: true });
function removeMaps(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
    } else if (current.endsWith(".map")) unlinkSync(current);
  }
}
removeMaps(path.join(root, "node_modules"));

function removeBrokenLinks(dir, depth) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".pnpm") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        realpathSync(full);
      } catch {
        unlinkSync(full);
      }
    } else if (entry.isDirectory() && depth < 3) removeBrokenLinks(full, depth + 1);
  }
}
removeBrokenLinks(path.join(root, "node_modules"), 0);
console.log("pruned node_modules");
