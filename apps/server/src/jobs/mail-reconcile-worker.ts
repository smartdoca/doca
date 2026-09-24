import type { DB, Schema } from "@db/index.js";
import type { StalwartMail } from "../adapters/stalwart.js";
import { mailboxSyncState, reconcileMailbox } from "../services/mail-store.js";

const staleAfterMs = 2 * 60 * 1000;

export function createMailReconcileWorker(
  db: DB,
  openBackend: (mailbox: Schema["mailboxes"]) => Promise<StalwartMail>,
) {
  let running = false;
  return {
    async pump() {
      if (running) return;
      running = true;
      try {
        const mailbox = await nextMailbox(db);
        if (!mailbox) return;
        const backend = await openBackend(mailbox);
        await reconcileMailbox(db, mailbox, backend, { fillBodies: 24, prune: true });
      } finally {
        running = false;
      }
    },
  };
}

async function nextMailbox(db: DB) {
  const mailboxes = await db
    .selectFrom("mailboxes")
    .selectAll()
    .where("deleted_at", "is", null)
    .orderBy("updated_at", "asc")
    .execute();
  const cutoff = Date.now() - staleAfterMs;
  for (const mailbox of mailboxes) {
    const state = await mailboxSyncState(db, mailbox.id);
    if (!state?.synced_at || new Date(state.synced_at).getTime() < cutoff) return mailbox;
  }
  return null;
}
