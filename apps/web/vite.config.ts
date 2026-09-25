import { createReadStream, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { prismjsLanguageEsm } from "./prismjs-language-esm";

const cadFiles = [
  ["@mlightcad/libredwg-converter", "libredwg-parser-worker.js"],
  ["@mlightcad/libredwg-converter", "libredwg-web.wasm"],
  ["@mlightcad/cad-simple-viewer", "mtext-renderer-worker.js"],
] as const;

function packageRoot(pkg: string) {
  const entry = fileURLToPath(import.meta.resolve(pkg));
  let dir = dirname(entry);
  while (true) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (parsed.name === pkg) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`找不到 ${pkg}`);
    dir = parent;
  }
}

function cadAssetPath(pkg: string, file: string) {
  return join(packageRoot(pkg), "dist", file);
}

function cadPreviewAssets(): Plugin {
  const files = () =>
    cadFiles.flatMap(([pkg, file]) => {
      try {
        const path = cadAssetPath(pkg, file);
        return existsSync(path) ? [{ file, path }] : [];
      } catch {
        return [];
      }
    });
  return {
    name: "doca-cad-preview-assets",
    configureServer(server) {
      server.middlewares.use("/cad", (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const name = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\//, ""));
        const hit = files().find((item) => item.file === name);
        if (!hit) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.setHeader("Cache-Control", "no-cache");
        if (req.method === "HEAD") {
          res.statusCode = 200;
          res.end();
          return;
        }
        createReadStream(hit.path).pipe(res);
      });
    },
    generateBundle() {
      for (const item of files()) {
        this.emitFile({
          type: "asset",
          fileName: `cad/${item.file}`,
          source: readFileSync(item.path),
        });
      }
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), prismjsLanguageEsm(), cadPreviewAssets()],
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
      "@doca/i18n": fileURLToPath(new URL("../../packages/i18n/src/index.ts", import.meta.url)),
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
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL("../..", import.meta.url)),
      ],
    },
  },
  build: { outDir: "dist" },
});
