import type { DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";

const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const placeholder = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;
const maxSecrets = 50;

export type SecretBinding = {
  fill: (value: string | undefined) => string | undefined;
  hide: (value: string) => string;
};

async function ownedSecrets(db: DB, userId: string) {
  return db
    .selectFrom("ai_secrets")
    .select(["key", "value", "updated_at"])
    .where("user_id", "=", userId)
    .orderBy("key")
    .execute();
}

export async function listSecrets(db: DB, userId: string) {
  return ownedSecrets(db, userId);
}

export async function writeSecret(
  db: DB,
  userId: string,
  key: string,
  value: string,
) {
  const name = key.trim();
  if (!keyPattern.test(name))
    fail(400, "密码本的 key 需以字母开头，只含字母、数字和下划线");
  if (!value || value.length > 4000) fail(400, "密码或密钥不能为空，且不能超过 4000 字");
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("ai_secrets")
    .select("key")
    .where("user_id", "=", userId)
    .where("key", "=", name)
    .executeTakeFirst();
  if (!existing) {
    const count = await db
      .selectFrom("ai_secrets")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (Number(count?.n ?? 0) >= maxSecrets) fail(400, "密码本最多 50 条");
    await db
      .insertInto("ai_secrets")
      .values({ user_id: userId, key: name, value, updated_at: now })
      .execute();
  } else
    await db
      .updateTable("ai_secrets")
      .set({ value, updated_at: now })
      .where("user_id", "=", userId)
      .where("key", "=", name)
      .execute();
  await scrubStoredNote(db, userId);
  return { key: name, saved: true as const };
}

export async function deleteSecret(db: DB, userId: string, key: string) {
  const name = key.trim();
  const removed = await db
    .deleteFrom("ai_secrets")
    .where("user_id", "=", userId)
    .where("key", "=", name)
    .executeTakeFirst();
  if (!Number(removed.numDeletedRows ?? 0)) fail(404, "密码本没有这项");
  return { key: name, deleted: true as const };
}

/** Replace stored secret values with {{KEY}}. Longer values first so one secret cannot hide inside another. */
export function scrubSecretValues(
  text: string,
  items: { key: string; value: string }[],
) {
  const ordered = items
    .filter((item) => item.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const item of ordered) out = out.split(item.value).join(`{{${item.key}}}`);
  return out;
}

export function fillSecretPlaceholders(
  text: string,
  items: { key: string; value: string }[],
) {
  const map = new Map(items.map((item) => [item.key, item.value]));
  const missing = new Set<string>();
  const next = text.replace(placeholder, (token, key: string) => {
    const value = map.get(key);
    if (value == null) {
      missing.add(key);
      return token;
    }
    return value;
  });
  if (missing.size)
    fail(400, `密码本没有 ${[...missing].join("、")}`);
  return next;
}

export async function bindUserSecrets(
  db: DB,
  userId: string,
): Promise<SecretBinding> {
  const items = await ownedSecrets(db, userId);
  return {
    fill: (value) =>
      value == null ? value : fillSecretPlaceholders(value, items),
    hide: (value) => scrubSecretValues(value, items),
  };
}

export async function scrubOwnedSecrets(db: DB, userId: string, text: string) {
  return scrubSecretValues(text, await ownedSecrets(db, userId));
}

async function scrubStoredNote(db: DB, userId: string) {
  const note = await db
    .selectFrom("ai_notes")
    .select("content")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!note) return;
  const next = await scrubOwnedSecrets(db, userId, note.content);
  if (next === note.content) return;
  await db
    .updateTable("ai_notes")
    .set({ content: next, updated_at: new Date().toISOString() })
    .where("user_id", "=", userId)
    .execute();
}
