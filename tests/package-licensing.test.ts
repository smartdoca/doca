import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const expectedLicense = "AGPL-3.0-only";

async function workspacePackageFiles(directory: "apps" | "packages") {
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(directory, entry.name, "package.json"));
}

async function readPackage(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    name: string;
    license?: string;
  };
}

describe("repository licensing", () => {
  test("the root and every workspace package declare the public license", async () => {
    const paths = [
      resolve("package.json"),
      ...(await workspacePackageFiles("apps")),
      ...(await workspacePackageFiles("packages")),
    ];

    for (const path of paths) {
      const manifest = await readPackage(path);
      expect(manifest.license, `${manifest.name} (${path})`).toBe(
        expectedLicense,
      );
    }
  });

  test("the repository includes the complete AGPL notice and dual-license policy", async () => {
    const license = await readFile(resolve("LICENSE"), "utf8");
    const policy = await readFile(resolve("LICENSING.md"), "utf8");

    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 19 November 2007");
    expect(policy).toContain("AGPL-3.0-only");
    expect(policy).toContain("commercial license");
  });
});
