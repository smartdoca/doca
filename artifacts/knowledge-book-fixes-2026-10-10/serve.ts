import { createServer } from "vite";
import config from "../../apps/web/vite.config.ts";
const server = await createServer({ ...config, configFile: false, root: import.meta.dirname, server: { host: "127.0.0.1", port: 39141, strictPort: true, fs: { allow: [process.cwd()] } } });
await server.listen();
server.printUrls();
