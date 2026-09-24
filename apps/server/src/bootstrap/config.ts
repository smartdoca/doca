import "dotenv/config";
import { resolve } from "node:path";
import type { DatabaseConfig } from "@db/index.js";
export function config() {
  const origin = new URL(process.env.DOCA_ORIGIN ?? "http://127.0.0.1:39130");
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("DOCA_ORIGIN must be an HTTP(S) origin");
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:")
    throw new Error("Production requires HTTPS origin behind a TLS gateway");
  const driver = process.env.DOCA_DATABASE ?? "sqlite";
  let database: DatabaseConfig;
  if (driver === "sqlite") {
    const path = resolve(process.env.DOCA_SQLITE_PATH ?? "./data/v1/doca.db");
    database = { driver, path };
  } else if (driver === "postgres" && process.env.DOCA_DATABASE_URL)
    database = { driver, url: process.env.DOCA_DATABASE_URL };
  else throw new Error("Invalid database configuration");
  const port = (value: string | undefined, fallback: number) => {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error("Invalid port");
    return n;
  };
  return {
    origin: origin.origin,
    database,
    host: process.env.DOCA_HOST ?? "127.0.0.1",
    port: port(process.env.DOCA_PORT, 39120),
    webPort: port(process.env.DOCA_WEB_PORT, 39130),
  };
}
