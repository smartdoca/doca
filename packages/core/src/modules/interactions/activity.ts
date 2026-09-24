import type { Transaction } from "kysely";
import { sql } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import { accessibleQuery } from "../access/queries.js";
import type { Actor } from "../identity/passwords.js";
// One installation-wide day boundary; clients label the calendar explicitly.
export const activityDay = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
export async function recordActivity(
  tx: DB | Transaction<Schema>,
  userId: string,
  resourceId: string,
  kind: "read" | "edit",
  now = new Date(),
) {
  const stamp = now.toISOString(),
    field = kind === "read" ? "read_at" : "edited_at";
  await tx
    .insertInto("user_activity")
    .values({
      user_id: userId,
      resource_id: resourceId,
      day: activityDay(now),
      read_at: kind === "read" ? stamp : null,
      edited_at: kind === "edit" ? stamp : null,
    })
    .onConflict((oc) =>
      oc
        .columns(["user_id", "day", "resource_id"])
        .doUpdateSet({
          [field]: sql<string>`case when ${sql.ref("user_activity." + field)} is null or ${sql.ref("user_activity." + field)} < ${stamp} then ${stamp} else ${sql.ref("user_activity." + field)} end`,
        }),
    )
    .execute();
}
export async function activityCalendar(
  db: DB,
  actor: Actor,
  from: string,
  to: string,
  day?: string,
) {
  const rows = await db
    .selectFrom("user_activity")
    .innerJoin("resources as r", "r.id", "user_activity.resource_id")
    .selectAll("user_activity")
    .select(["r.title", "r.format"])
    .where("r.kind", "=", "document")
    .where(accessibleQuery(sql.ref("r.id"), actor))
    .where("user_id", "=", actor.id)
    .where("day", ">=", from)
    .where("day", "<=", to)
    .orderBy("day")
    .execute();
  const days = new Map<string, { day: string; read: number; edited: number }>();
  for (const row of rows) {
    const value = days.get(row.day) ?? { day: row.day, read: 0, edited: 0 };
    value.read += Number(!!row.read_at);
    value.edited += Number(!!row.edited_at);
    days.set(row.day, value);
  }
  return {
    timeZone: "Asia/Shanghai",
    today: activityDay(),
    days: [...days.values()],
    documents: day
      ? rows
          .filter((r) => r.day === day)
          .map((r) => ({
            id: r.resource_id,
            title: r.title,
            format: r.format,
            readAt: r.read_at,
            editedAt: r.edited_at,
          }))
      : [],
  };
}
