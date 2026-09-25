import { emitIntegrationEvent } from "../automation/events.js";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { securityAudit } from "./accounts.js";
import type { Actor } from "./passwords.js";
export async function registrationReview(db: DB, userId: string) {
  const now = new Date().toISOString();
  await db
    .insertInto("registration_reviews")
    .values({
      user_id: userId,
      status: "pending",
      reviewer_id: null,
      message: "",
      created_at: now,
      updated_at: now,
    })
    .onConflict((o) => o.column("user_id").doNothing())
    .execute();
  return { status: "pending" as const };
}
export async function decideRegistration(
  db: DB,
  actor: Actor,
  userId: string,
  decision: "approved" | "rejected",
  message = "",
) {
  if (!actor.admin) fail(403, "需要系统管理员权限");
  return transact(db, async (tx) => {
    const changed = await tx
      .updateTable("users")
      .set({ status: decision === "approved" ? "active" : "disabled" })
      .where("id", "=", userId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (!changed.numUpdatedRows) fail(409, "注册申请已处理，请刷新");
    await emitIntegrationEvent(tx, "user.status.changed", { userId, previousStatus: "pending", status: decision === "approved" ? "active" : "disabled" });
    await tx
      .updateTable("registration_reviews")
      .set({
        status: decision,
        reviewer_id: actor.id,
        message,
        updated_at: new Date().toISOString(),
      })
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .execute();
    await securityAudit(tx, actor.id, userId, "registration." + decision, {
      message,
    });
    return { ok: true };
  });
}
