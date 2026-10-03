import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const directory = new URL("./", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", directory), "utf8"),
);
const metadata = JSON.parse(
  await readFile(new URL("package.json", directory), "utf8"),
);
if (metadata.version !== manifest.version)
  throw Error("Package and manifest versions differ");
const source = await readFile(new URL("web-src.js", directory), "utf8");
await writeFile(
  new URL("web/index.js", directory),
  source.replaceAll("__PLUGIN_VERSION__", manifest.version),
);
execFileSync(
  "pnpm",
  [
    "exec",
    "esbuild",
    "examples/plugin-storage/server.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--outfile=examples/plugin-storage/server.js",
    "--minify",
  ],
  { stdio: "inherit" },
);
