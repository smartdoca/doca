import "dotenv/config";
import { resolve } from "node:path";
import type { DatabaseConfig } from "@db/index.js";
import { webhookDatabaseConfig } from "@db/webhook-database.js";
import { sessionDurations } from "../app/session-policy.js";
import { createCredentialCipher } from "../services/credential-cipher.js";
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
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function config() {
  // Validate before opening databases, including one-off administrator commands.
  createCredentialCipher().dispose();
  sessionDurations();
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
  const webhookUrl = process.env.DOCA_WEBHOOK_DATABASE_URL?.trim();
  let webhookDatabase: DatabaseConfig;
  if (webhookUrl) {
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      throw new Error("DOCA_WEBHOOK_DATABASE_URL must be a PostgreSQL URL");
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
      throw new Error("DOCA_WEBHOOK_DATABASE_URL must be a PostgreSQL URL");
    webhookDatabase = { driver: "postgres", url: webhookUrl, poolMax: 4 };
  } else webhookDatabase = webhookDatabaseConfig(database);
  return {
    origin: origin.origin,
    assetBase: assetBase(process.env.DOCA_ASSET_BASE),
    database,
    webhookDatabase,
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
