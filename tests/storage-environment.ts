import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
const root = mkdtempSync(join(tmpdir(), "doca-test-store-"));
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({ version: 1, stores: { local: { provider: "local", root } } });
afterAll(() => rmSync(root, { recursive: true, force: true }));
