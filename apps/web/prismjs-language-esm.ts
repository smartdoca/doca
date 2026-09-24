import type { Plugin } from "vite";

const PRISM_MODULE = /\/prismjs\/(?:components|plugins)\//;
const PRISM_CORE = /\/prism-core(?:\.min)?\.js$/;
const ALREADY_IMPORTS_PRISM = /(?:^|\n)import\s+Prism\s+from\s+["']prismjs["']/;

function prismModulePath(id: string) {
  return id.split("?")[0].replaceAll("\\", "/");
}

export function rewritePrismLanguageModule(code: string, id: string) {
  const file = prismModulePath(id);
  if (!PRISM_MODULE.test(file) || PRISM_CORE.test(file)) return null;
  if (!/\bPrism\b/.test(code) || ALREADY_IMPORTS_PRISM.test(code)) return null;
  return `import Prism from "prismjs";\n${code}`;
}

// Prism language/plugin files are classic scripts: `(function (Prism) { ... })(Prism)`.
// Vite emits them as ESM chunks, where a free `Prism` identifier is a ReferenceError
// even if `window.Prism` was assigned beforehand.
export function prismjsLanguageEsm(): Plugin {
  return {
    name: "prismjs-language-esm",
    enforce: "pre",
    transform(code, id) {
      return rewritePrismLanguageModule(code, id) ?? undefined;
    },
  };
}
