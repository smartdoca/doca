import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedSkillReferences } from "./lib/documentation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = process.argv[2];
if (process.argv.length > 3)
  throw new Error(
    "Usage: node scripts/sync-docs-skills.mjs [installed-skills-directory]",
  );
const references = await expectedSkillReferences(root);
for (const base of [
  resolve(root, "skills"),
  ...(installed ? [resolve(installed)] : []),
]) {
  for (const [target, markdown] of references) {
    const path = resolve(base, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown);
  }
}
console.log(
  `Synchronized ${references.length} skill references${installed ? " and installed copies" : ""}.`,
);
