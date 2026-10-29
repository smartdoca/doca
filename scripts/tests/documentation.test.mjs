import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  databaseInventory,
  documentLinks,
  headingIds,
  markdownFiles,
  portableSkillReference,
  repositoryTarget,
} from "../lib/documentation.mjs";

test("portable skill copies resolve source links from docs, including parent paths", () => {
  const input =
    "# Contract\n\n[中文](contract.zh-CN.md) · [Source](../apps/web/index.ts) · [Local](#contract) · [Page](storage.md#history)\n";
  const output = portableSkillReference(input, "contract.md");
  assert.ok(
    output.includes(
      "https://github.com/workhold/doca/blob/main/docs/contract.zh-CN.md",
    ),
  );
  assert.ok(
    output.includes(
      "https://github.com/workhold/doca/blob/main/apps/web/index.ts",
    ),
  );
  assert.ok(
    output.includes(
      "https://github.com/workhold/doca/blob/main/docs/storage.md#history",
    ),
  );
  assert.ok(output.includes("[Local](#contract)"));
  assert.equal(portableSkillReference(output, "contract.md"), output);
});

test("link inventory includes HTML, images and reference definitions, excluding code examples", () => {
  const markdown =
    '<a href="README.md">Read</a> <img src="docs/image.png">\n\n[Guide][g]\n\n[g]: guide.md#start\n\n```md\n[Example](missing.md)\n```';
  assert.deepEqual(
    documentLinks(fromMarkdown(markdown)).map((link) => link.href),
    ["README.md", "docs/image.png", "guide.md#start"],
  );
});

test("repository links resolve main paths and encoded names, but detect traversal", () => {
  const root = resolve("/repository");
  const path = resolve(root, "docs/guide.md");
  assert.equal(
    repositoryTarget(root, path, "../README.md").destination,
    resolve(root, "README.md"),
  );
  assert.equal(
    repositoryTarget(root, path, "image%20one.png").destination,
    resolve(root, "docs/image one.png"),
  );
  assert.equal(
    repositoryTarget(root, path, "%2e%2e/%2e%2e/private.md").outside,
    true,
  );
  assert.equal(
    repositoryTarget(
      root,
      path,
      "https://github.com/workhold/doca/blob/main/docs/guide.md#start",
    ).fragment,
    "start",
  );
  assert.equal(
    repositoryTarget(
      root,
      path,
      "https://github.com/workhold/doca/blob/v0.1.0/old.md",
    ),
    null,
  );
  assert.equal(
    repositoryTarget(root, path, "https://example.com/guide.md"),
    null,
  );
  assert.equal(repositoryTarget(root, path, "#/en/"), null);
});

test("heading inventory supports Docsify numeric anchors, Unicode and explicit HTML ids", () => {
  const tree = fromMarkdown(
    '# 0.1.13\n\n## 保存、重连与历史\n\n## Same\n\n## Same\n\n<a id="custom"></a>',
  );
  assert.deepEqual(
    [...headingIds(tree)],
    ["_0113", "保存、重连与历史", "same", "same-1", "custom"],
  );
  assert.ok(headingIds(tree, "github").has("0113"));
  const collision = fromMarkdown("# Same\n\n# Same\n\n# Same-1\n\n# Same");
  assert.deepEqual([...headingIds(collision)], ["same", "same-1", "same-2"]);
});

async function fixture(run) {
  const parent = resolve("artifacts/verification/documentation-check-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "case-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("repository inventory respects ignored generated output and excludes document fixtures", async () => {
  await fixture(async (root) => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    for (const path of ["docs", "artifacts", "tests/fixtures"])
      await mkdir(resolve(root, path), { recursive: true });
    await writeFile(resolve(root, ".gitignore"), "artifacts/\n");
    for (const path of [
      "README.md",
      "docs/guide.md",
      "artifacts/output.md",
      "tests/fixtures/input.md",
    ])
      await writeFile(resolve(root, path), "# Test\n");
    assert.deepEqual(await markdownFiles(root), [
      resolve(root, "README.md"),
      resolve(root, "docs/guide.md"),
    ]);
  });
});

test("schema inventory includes inherited tables and intersection fields", async () => {
  await fixture(async (root) => {
    await mkdir(resolve(root, "packages/db/src"), { recursive: true });
    await writeFile(
      resolve(root, "packages/db/src/extra.ts"),
      "export interface Extra { inherited: { id: string; version: number } }\n",
    );
    await writeFile(
      resolve(root, "packages/db/src/schema.ts"),
      'import type { Extra } from "./extra.js";\ninterface Entry { id: string }\nexport interface Schema extends Extra { local: Entry & { revision: number } }\n',
    );
    assert.deepEqual(databaseInventory(root), [
      { name: "local", fields: ["id", "revision"] },
      { name: "inherited", fields: ["id", "version"] },
    ]);
  });
});
