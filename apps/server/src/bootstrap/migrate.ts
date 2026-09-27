import { openDatabase } from "@db/index.js";
import { config } from "./config.js";

const cfg = config();
const db = await openDatabase(cfg.database, { schema: "migrate" });
await db.destroy();
console.log("Doca database schema is ready");
