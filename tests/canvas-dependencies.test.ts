import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
it("canvas plugins register against the same Leafer core as the canvas engine", () => {
  const host = createRequire(import.meta.url);
  const canvas = createRequire(host.resolve("@smartdoca/canvas"));
  const engine = createRequire(canvas.resolve("leafer-ui"));
  const canonical = realpathSync(engine.resolve("@leafer-ui/core"));
  for (const name of [
    "@leafer-in/editor",
    "@leafer-in/text-editor",
    "@leafer-in/viewport",
  ]) {
    const plugin = createRequire(canvas.resolve(name));
    expect(realpathSync(plugin.resolve("@leafer-ui/core"))).toBe(canonical);
  }
  expect(
    readFileSync(join(dirname(canonical), "../package.json"), "utf8"),
  ).toContain('"2.1.0"');
});
