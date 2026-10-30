import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRegistryEditorSources } from "./verify-editor-package-sources.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await verifyRegistryEditorSources(root);
if (process.argv.length > 3) throw new Error("Usage: node scripts/pack-deployment.mjs [output-directory]");
const output = resolve(process.argv[2] ?? resolve(root, "artifacts/releases"));
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Deployment bundles require an official release version");
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error("Release tag and package.json version must match");
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unexpected Compose structure: ${before.trim()}`);
  return source.replace(before, after);
}

// Derive the image-only configuration from this release's Compose file so its
// environment, mounts, and renderer security settings stay in sync.
let compose = await readFile(resolve(root, "compose.yaml"), "utf8");
if (!compose.includes(`    image: docker.io/smartdoca/doca:${version}\n`)) {
  throw new Error("Compose image and package.json version must match");
}
compose = replaceOnce(compose, "    build:\n      context: .\n      dockerfile: Dockerfile\n", "");
compose = replaceOnce(compose, "    pull_policy: always\n", "    pull_policy: missing\n");
compose = `# Image-only deployment bundle for Doca ${version}.\n# Pull the pinned image, or load a matching image archive before starting.\n# No source checkout, Dockerfile, Node.js, or pnpm is needed on the server.\n${compose.slice(compose.indexOf("services:\n"))}`;

// Explicit allowlist: never include the workspace .env, databases, installed
// plugins, or any other deployment's runtime data.
const files = [
  "docker.env.example",
  "scripts/bootstrap-admin.sh",
  "scripts/reset-admin-password.sh",
  "LICENSE",
];
const staging = await mkdtemp(resolve(tmpdir(), "doca-deployment-"));
const name = `doca-deploy-v${version}`;
try {
  const bundle = resolve(staging, name);
  await mkdir(bundle);
  await writeFile(resolve(bundle, "compose.yaml"), compose);
  for (const file of files) {
    await mkdir(dirname(resolve(bundle, file)), { recursive: true });
    await copyFile(resolve(root, file), resolve(bundle, file));
  }
  for (const [source, target] of [
    ["docs/deployment-without-github.zh-CN.md", "README.zh-CN.md"],
    ["docs/deployment-without-github.md", "README.md"],
  ]) {
    const markdown = await readFile(resolve(root, source), "utf8");
    // The instructions are self-contained; related repository documents are
    // named without creating broken links in the transferred bundle.
    await writeFile(resolve(bundle, target), markdown.replace(/\[([^\]]+)\]\([^\n)]+\.md(?:#[^\n)]*)?\)/g, "$1"));
  }
  await mkdir(output, { recursive: true });
  // A fresh-install alternative: edit this YAML's public placeholders directly.
  // Existing installations keep their Compose project, volume and secret values.
  const standalone = `# Fresh installation only. Uses this release's browser-free image.\n# Edit DOCA_ORIGIN and DOCA_CREDENTIAL_MASTER_KEY, then docker compose up -d.\n# Generate the key once: openssl rand -hex 32. Protect this file with chmod 600.\n# After startup: docker compose exec doca bash docker/admin.sh bootstrap\nservices:\n  doca:\n    image: docker.io/smartdoca/doca:${version}\n    restart: unless-stopped\n    init: true\n    stop_grace_period: 30s\n    environment:\n      DOCA_ORIGIN: https://docs.example.com\n      DOCA_CREDENTIAL_MASTER_KEY: REPLACE_WITH_YOUR_64_HEX_CHARACTER_KEY\n      DOCA_FILE_STORE_ID: local\n      DOCA_FILE_STORES_JSON: '{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'\n    ports:\n      - "127.0.0.1:39120:39120"\n    volumes:\n      - doca_data:/data\n\nvolumes:\n  doca_data:\n`;
  const standalonePath = resolve(output, `doca-compose-v${version}.yaml`);
  await writeFile(standalonePath, standalone);
  await writeFile(`${standalonePath}.sha256`, `${createHash("sha256").update(standalone).digest("hex")}  doca-compose-v${version}.yaml\n`);
  const archive = resolve(output, `${name}.tar.gz`);
  execFileSync("tar", ["-C", staging, "-czf", archive, name]);
  const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(`${archive}.sha256`, `${checksum}  ${name}.tar.gz\n`);
  console.log(`Deployment bundle: ${archive}\nSHA-256: ${archive}.sha256`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
