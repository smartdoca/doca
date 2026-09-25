import type { DB } from "@db/index.js";
import { emitIntegrationEvent } from "@core/modules/automation/events.js";
export async function publishUserCreated(db: DB, user: { readonly id: string; readonly displayName?: string }) {
  await emitIntegrationEvent(db, "user.created", { userId: user.id, displayName: user.displayName ?? "" });
}
