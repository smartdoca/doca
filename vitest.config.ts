import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@web": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      "@core": fileURLToPath(new URL("./packages/core/src", import.meta.url)),
      "@db": fileURLToPath(new URL("./packages/db/src", import.meta.url)),
      "@server": fileURLToPath(new URL("./apps/server/src", import.meta.url)),
    },
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
