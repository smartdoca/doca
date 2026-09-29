import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const expectedLicense = "MIT";

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

  test("the repository includes the MIT license and licensing policy", async () => {
    const license = await readFile(resolve("LICENSE"), "utf8");
    const policy = await readFile(resolve("LICENSING.md"), "utf8");

    expect(license).toContain("MIT License");
    expect(license).toContain("Permission is hereby granted, free of charge");
    expect(policy).toContain("MIT License");
    expect(policy).not.toContain("AGPL-3.0-only");
  });
});
