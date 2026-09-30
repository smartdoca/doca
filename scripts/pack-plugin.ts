import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pack, digest } from "../apps/server/src/plugins/archive.js";
import { inspectPlugin } from "../apps/server/src/plugins/installation.js";
const [source, target] = process.argv.slice(2);
if (!source || !target)
  throw new Error(
    "Usage: tsx scripts/pack-plugin.ts <built-directory> <output.zip>",
  );
const descriptor = await inspectPlugin(path.resolve(source));
const bytes = await pack(path.resolve(source));
await writeFile(path.resolve(target), bytes, { flag: "wx" });
console.log(
  JSON.stringify(
    {
      id: descriptor.manifest.id,
      version: descriptor.manifest.version,
      dataVersion: descriptor.dataVersion,
      size: bytes.length,
      sha256: digest(bytes),
    },
    null,
    2,
  ),
);
