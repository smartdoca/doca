import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { enqueueKnowledge } from "../knowledge/service.js";
import { enqueueProjection } from "./jobs.js";
/** Business commits append independent rows; they never allocate a global sequence. */
export async function emitIntegrationEvent(
  db: DB,
  type: string,
  payload: Record<string, unknown>,
) {
  await db
    .insertInto("pending_integration_events")
    .values({
      id: randomUUID(),
      type,
      payload: JSON.stringify({ version: 1, ...payload }),
      created_at: new Date().toISOString(),
    })
    .execute();
  if (
    typeof payload.resourceId === "string" &&
    (type.startsWith("resource.") || type === "document.created")
  ) {
    await enqueueProjection(db, "search", payload.resourceId, {
      resourceId: payload.resourceId,
    });
    await enqueueKnowledge(db, "document", payload.resourceId);
  }
}
/** Serializes only stream publication, after facts commit; consumers cannot skip late commits. */
export async function publishIntegrationEvents(db: DB) {
  return transact(db, async (tx) => {
    await tx
      .updateTable("projection_cursors")
      .set((eb) => ({ revision: eb("revision", "+", 1) }))
      .where("id", "=", "integration-stream")
      .execute();
    const rows = await tx
      .selectFrom("pending_integration_events")
      .selectAll()
      .orderBy("created_at")
      .orderBy("id")
      .limit(500)
      .execute();
    if (!rows.length) return 0;
    let seq =
      (
        await tx
          .selectFrom("integration_events")
          .select("seq")
          .orderBy("seq", "desc")
          .limit(1)
          .executeTakeFirst()
      )?.seq ?? 0;
    for (const row of rows)
      await tx
        .insertInto("integration_events")
        .values({ ...row, seq: ++seq })
        .execute();
    await tx
      .deleteFrom("pending_integration_events")
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    return rows.length;
  });
}
