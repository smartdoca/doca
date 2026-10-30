import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

// Build the installed SDK once; production rendering never starts Vite or fetches code.
export default defineConfig({
  plugins: [
    {
      name: "renderer-font",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "NotoSansSC-Regular.ttf",
          source: readFileSync(
            new URL(
              "../web/src/features/documents/assets/NotoSansSC-Regular.ttf",
              import.meta.url,
            ),
          ),
        });
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL("./dist/canvas-render", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: Infinity,
    lib: {
      entry: fileURLToPath(
        new URL("./src/renderers/canvas-sdk.ts", import.meta.url),
      ),
      name: "DocaCanvasSDK",
      formats: ["iife"],
      fileName: () => "sdk.js",
    },
  },
});
