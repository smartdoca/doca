import type { DB } from "../../../../db/src/index.js";
import { mailKnowledgeIncluded, parseMailAttachment } from "./scope.js";

/** Mail files follow the mailbox knowledge scope. Other files stay searchable. */
export async function mailAttachmentIncluded(
  db: DB,
  parentId: string,
  metadata: string | null | undefined,
) {
  const link = parseMailAttachment(parentId, metadata);
  if (!link) return true;
  if (!link.mailboxId || !link.messageId) return false;
  const row = await db
    .selectFrom("mail_messages as m")
    .innerJoin("mailboxes as b", "b.id", "m.mailbox_id")
    .select(["m.starred", "b.knowledge_scope", "b.deleted_at"])
    .where("m.mailbox_id", "=", link.mailboxId)
    .where("m.remote_id", "=", link.messageId)
    .executeTakeFirst();
  if (!row || row.deleted_at) return false;
  return mailKnowledgeIncluded(row.knowledge_scope, row.starred);
}
