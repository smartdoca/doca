import type { DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
import { scrubOwnedSecrets } from "./secrets.js";

export const noteLimit = 8000;

export async function readNote(db: DB, userId: string) {
  const row = await db
    .selectFrom("ai_notes")
    .select(["content", "updated_at"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return { content: row?.content ?? "", updatedAt: row?.updated_at ?? null };
}

export async function writeNote(db: DB, userId: string, content: string) {
  const text = await scrubOwnedSecrets(
    db,
    userId,
    content.replace(/\r\n/g, "\n"),
  );
  if (text.length > noteLimit) fail(400, `备忘最多 ${noteLimit} 字`);
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("ai_notes")
    .select("user_id")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (existing)
    await db
      .updateTable("ai_notes")
      .set({ content: text, updated_at: now })
      .where("user_id", "=", userId)
      .execute();
  else
    await db
      .insertInto("ai_notes")
      .values({ user_id: userId, content: text, updated_at: now })
      .execute();
  return { content: text, updatedAt: now, saved: true as const };
}
