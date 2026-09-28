import type { DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
import {
  normalizePageStateValue,
  parsePageStateKey,
} from "@core/modules/page-state.js";

export type PageStateItem = {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
};

function present(row: { key: string; value: string; version: number; updated_at: string }): PageStateItem {
  return {
    key: row.key,
    value: JSON.parse(row.value),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export async function readPageState(db: DB, userId: string, key: string) {
  const parsed = parsePageStateKey(key);
  if (!parsed) fail(400, "不支持的页面状态");
  const row = await db
    .selectFrom("user_page_state")
    .selectAll()
    .where("user_id", "=", userId)
    .where("key", "=", parsed)
    .executeTakeFirst();
  return row ? present(row) : null;
}

export async function listPageState(db: DB, userId: string, prefix: string) {
  if (prefix !== "ui." && prefix !== "ai.")
    fail(400, "不支持的页面状态");
  const rows = await db
    .selectFrom("user_page_state")
    .selectAll()
    .where("user_id", "=", userId)
    .where("key", "like", `${prefix}%`)
    .orderBy("key")
    .execute();
  return rows.map(present);
}

export async function writePageState(
  db: DB,
  userId: string,
  key: string,
  value: unknown,
  version: number,
  options?: { force?: boolean },
): Promise<{ item: PageStateItem | null; conflict: boolean }> {
  const parsed = parsePageStateKey(key);
  if (!parsed) fail(400, "不支持的页面状态");
  let normalized: unknown;
  try {
    normalized = normalizePageStateValue(parsed, value);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "页面状态无效");
  }
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("user_page_state")
    .selectAll()
    .where("user_id", "=", userId)
    .where("key", "=", parsed)
    .executeTakeFirst();
  if (existing && !options?.force && existing.version !== version)
    return { item: present(existing), conflict: true };
  const nextVersion = (existing?.version ?? 0) + 1;
  const stored = JSON.stringify(normalized);
  if (existing) {
    await db
      .updateTable("user_page_state")
      .set({ value: stored, version: nextVersion, updated_at: now })
      .where("user_id", "=", userId)
      .where("key", "=", parsed)
      .execute();
  } else {
    await db
      .insertInto("user_page_state")
      .values({
        user_id: userId,
        key: parsed,
        value: stored,
        version: nextVersion,
        updated_at: now,
      })
      .execute();
  }
  return {
    item: { key: parsed, value: normalized, version: nextVersion, updatedAt: now },
    conflict: false,
  };
}

export async function clearPageState(db: DB, userId: string, key: string) {
  const parsed = parsePageStateKey(key);
  if (!parsed) fail(400, "不支持的页面状态");
  await db
    .deleteFrom("user_page_state")
    .where("user_id", "=", userId)
    .where("key", "=", parsed)
    .execute();
}
