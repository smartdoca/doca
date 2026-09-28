import type { Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import type { Schema } from "../../../../db/src/index.js";
import { type Actor } from "../identity/passwords.js";
export const recordAudit = async (
  tx: Transaction<Schema>,
  actor: Actor,
  id: string,
  action: string,
) => {
  await tx
    .insertInto("audit_events")
    .values({
      id: randomUUID(),
      actor_id: actor.id,
      resource_id: id,
      action,
      created_at: new Date().toISOString(),
    })
    .execute();
};
