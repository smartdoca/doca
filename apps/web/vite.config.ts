import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { prismjsLanguageEsm } from "./prismjs-language-esm.ts";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), prismjsLanguageEsm()],
  css: {
    postcss: {
      plugins: [
        {
          postcssPlugin: "doca-scope-markdown-sdk",
          Once(root) {
            const filename = root.source?.input.file ?? "";
            const scope = filename.includes("exmd-collaborative-editor")
              ? ".doca-markdown"
              : null;
            if (!scope) return;
            root.walkRules((rule) => {
              if (
                rule.parent?.type === "atrule" &&
                /keyframes$/.test(rule.parent.name)
              )
                return;
              rule.selectors = rule.selectors.map(
                (selector) => `${scope} ${selector}`,
              );
            });
          },
        },
      ],
    },
  },
  // v0.1.0 exports style.css but tsup currently emits index.css.
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "yjs",
      "@codemirror/state",
      "@codemirror/view",
    ],
    alias: {
      "@web": fileURLToPath(new URL("./src", import.meta.url)),
      "@core": fileURLToPath(new URL("../../packages/core/src", import.meta.url)),
      "@db": fileURLToPath(new URL("../../packages/db/src", import.meta.url)),
      "@napi-rs/canvas": fileURLToPath(new URL("./src/shared/shims/napi-canvas.ts", import.meta.url)),
      "@online-office/univer-sheet/style.css": fileURLToPath(
        new URL(
          "../../node_modules/@online-office/univer-sheet/dist/index.css",
          import.meta.url,
        ),
      ),
    },
  },
  // Local hash-qualified SDK tarballs need fresh prebundles after replacement.
  optimizeDeps: { force: process.env.DOCA_REBUILD_DEPS === "1" },
  build: { outDir: "dist" },
});
