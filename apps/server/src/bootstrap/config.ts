import "dotenv/config";
import { resolve } from "node:path";
import type { DatabaseConfig } from "@db/index.js";
export function assetBase(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DOCA_ASSET_BASE must be an HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "DOCA_ASSET_BASE must be an HTTP(S) URL without credentials, query, or hash",
    );
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("DOCA_ASSET_BASE must use HTTPS in production");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

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
  const port = (value: string | undefined, fallback: number) => {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error("Invalid port or pool size");
    return n;
  };
  const driver = process.env.DOCA_DATABASE ?? "sqlite";
  let database: DatabaseConfig;
  if (driver === "sqlite") {
    const path = resolve(process.env.DOCA_SQLITE_PATH ?? "./data/v1/doca.db");
    database = { driver, path };
  } else if (driver === "postgres" && process.env.DOCA_DATABASE_URL)
    database = {
      driver,
      url: process.env.DOCA_DATABASE_URL,
      poolMax: port(process.env.DOCA_DATABASE_POOL_MAX, 10),
    };
  else throw new Error("Invalid database configuration");
  return {
    origin: origin.origin,
    assetBase: assetBase(process.env.DOCA_ASSET_BASE),
    database,
    host: process.env.DOCA_HOST ?? "127.0.0.1",
    port: port(process.env.DOCA_PORT, 39120),
    webPort: port(process.env.DOCA_WEB_PORT, 39130),
    redisUrl: process.env.DOCA_REDIS_URL?.trim() || undefined,
    redisPrefix: process.env.DOCA_REDIS_PREFIX?.trim() || "doca",
    instanceId: process.env.DOCA_INSTANCE_ID?.trim() || undefined,
    trustProxy: (process.env.DOCA_TRUST_PROXY ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}
