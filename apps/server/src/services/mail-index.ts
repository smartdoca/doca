import { randomUUID } from "node:crypto";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { enqueueKnowledge } from "@core/modules/knowledge/service.js";
import { queueMobilePush } from "@core/modules/mobile/push.js";
import { mailKnowledgeIncluded } from "@core/modules/mail/scope.js";
import type { MailboxRecord } from "@core/modules/mail/access.js";
import type { DB, Schema } from "@db/index.js";
import type { MailMessage, MailMessageDetail } from "../adapters/stalwart.js";

function asDetail(message: MailMessage | MailMessageDetail): message is MailMessageDetail {
  return "text" in message || "html" in message;
}

export async function indexMailMessage(
  db: DB,
  mailbox: Pick<MailboxRecord, "id">,
  message: MailMessage | MailMessageDetail,
) {
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("mail_messages")
    .select(["id", "body_text", "body_html", "body_ready", "ai_tags"])
    .where("mailbox_id", "=", mailbox.id)
    .where("remote_id", "=", message.id)
    .executeTakeFirst();
  const detailed = asDetail(message);
  const text = detailed ? message.text || message.snippet : message.snippet;
  const html = detailed ? message.html || "" : "";
  const bodyReady = detailed && !!(message.text || message.html);
  const row: Schema["mail_messages"] = {
    id: existing?.id ?? randomUUID(),
    mailbox_id: mailbox.id,
    remote_id: message.id,
    folder: message.folder,
    folder_id: message.folderId,
    subject: message.subject.slice(0, 500),
    from_addr: message.from.email.slice(0, 320),
    to_addrs: JSON.stringify(message.to.map((item) => item.email)),
    cc_addrs: JSON.stringify(message.cc.map((item) => item.email)),
    bcc_addrs: JSON.stringify((message.bcc ?? []).map((item) => item.email)),
    snippet: (message.snippet || text).replace(/\s+/g, " ").trim().slice(0, 500),
    body_text: bodyReady ? text.slice(0, 200000) : existing?.body_text || text.slice(0, 200000),
    body_html: bodyReady ? html.slice(0, 400000) : existing?.body_html || "",
    body_ready: bodyReady || existing?.body_ready ? 1 : 0,
    unread: message.unread ? 1 : 0,
    starred: message.starred ? 1 : 0,
    has_attachments: message.hasAttachments ? 1 : 0,
    sent_at: message.sentAt,
    received_at: message.receivedAt,
    ai_tags: existing?.ai_tags ?? "",
    updated_at: now,
  };
  await db
    .insertInto("mail_messages")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["mailbox_id", "remote_id"]).doUpdateSet({
        folder: row.folder,
        folder_id: row.folder_id,
        subject: row.subject,
        from_addr: row.from_addr,
        to_addrs: row.to_addrs,
        cc_addrs: row.cc_addrs,
        bcc_addrs: row.bcc_addrs,
        snippet: row.snippet,
        body_text: row.body_text,
        body_html: row.body_html,
        body_ready: row.body_ready,
        unread: row.unread,
        starred: row.starred,
        has_attachments: row.has_attachments,
        sent_at: row.sent_at,
        received_at: row.received_at,
        updated_at: row.updated_at,
      }),
    )
    .execute();
  if (!existing && message.unread) {
    const owner = await db
      .selectFrom("mailboxes")
      .select("owner_id")
      .where("id", "=", mailbox.id)
      .executeTakeFirst();
    if (owner)
      queueMobilePush({
        userId: owner.owner_id,
        title: "新邮件",
        body: message.subject || message.snippet || "你收到一封新邮件",
        path: `#/mail/${mailbox.id}`,
      });
  }
  const stored = existing ?? (await db
    .selectFrom("mail_messages")
    .select("id")
    .where("mailbox_id", "=", mailbox.id)
    .where("remote_id", "=", message.id)
    .executeTakeFirst());
  const messageId = stored?.id ?? row.id;
  await queueMailIndex(db, messageId);
  return messageId;
}

export async function queueMailIndex(db: DB, messageId: string) {
  const row = await db
    .selectFrom("mail_messages as m")
    .leftJoin("mailboxes as b", "b.id", "m.mailbox_id")
    .select(["m.starred", "m.ai_tags", "b.knowledge_scope", "b.deleted_at"])
    .where("m.id", "=", messageId)
    .executeTakeFirst();
  await enqueueProjection(db, "search-mail", messageId, { messageId });
  await enqueueKnowledge(db, "mail", messageId);
  if (row && !row.deleted_at && mailKnowledgeIncluded(row.knowledge_scope, row.starred) && !row.ai_tags.trim())
    await enqueueProjection(db, "mail-tag", messageId, { messageId });
}

export async function queueMailboxIndex(db: DB, mailboxId: string) {
  const rows = await db.selectFrom("mail_messages").select("id").where("mailbox_id", "=", mailboxId).execute();
  for (const row of rows) await queueMailIndex(db, row.id);
}

export async function reconcileMailIndex(db: DB) {
  const rows = await db.selectFrom("mail_messages").select("id").execute();
  for (const row of rows) await queueMailIndex(db, row.id);
}

export async function unindexMailMessage(db: DB, mailboxId: string, remoteId: string) {
  const stored = await db
    .selectFrom("mail_messages")
    .select("id")
    .where("mailbox_id", "=", mailboxId)
    .where("remote_id", "=", remoteId)
    .executeTakeFirst();
  if (!stored) return;
  await db.deleteFrom("mail_messages").where("id", "=", stored.id).execute();
  await queueMailIndex(db, stored.id);
}
