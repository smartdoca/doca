import { describe, expect, it } from "vitest";
import { rewritePrismLanguageModule } from "../apps/web/prismjs-language-esm";

const languageSource = `(function (Prism) {\n  Prism.languages.typescript = {};\n}(Prism));\n`;

describe("prismjs language ESM rewrite", () => {
  it("injects a Prism import into language components", () => {
    expect(
      rewritePrismLanguageModule(
        languageSource,
        "/app/node_modules/prismjs/components/prism-typescript.js",
      ),
    ).toBe(`import Prism from "prismjs";\n${languageSource}`);
  });

  it("leaves prism-core and unrelated modules unchanged", () => {
    expect(
      rewritePrismLanguageModule(
        "var Prism = {};",
        "/app/node_modules/prismjs/components/prism-core.js",
      ),
    ).toBeNull();
    expect(
      rewritePrismLanguageModule(languageSource, "/app/src/highlighter.ts"),
    ).toBeNull();
  });
});
