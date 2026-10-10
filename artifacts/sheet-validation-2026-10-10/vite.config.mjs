import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: new URL("./fixture", import.meta.url).pathname,
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom", "yjs"] },
  optimizeDeps: { force: true },
  server: { fs: { allow: [new URL("../..", import.meta.url).pathname] } }
});
