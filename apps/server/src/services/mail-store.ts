import type { MailboxRecord } from "@core/modules/mail/access.js";
import type { DB } from "@db/index.js";
import type {
  MailFolder,
  MailMessage,
  MailMessageDetail,
  MessageListQuery,
  MessagePage,
  StalwartMail,
} from "../adapters/stalwart.js";
import { indexMailMessage, unindexMailMessage } from "./mail-index.js";

function parseEmails(raw: string): MailMessage["to"] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (Array.isArray(parsed) ? parsed : [])
      .map((item) => (typeof item === "string" ? { email: item } : null))
      .filter((item): item is { email: string } => !!item?.email);
  } catch {
    return [];
  }
}

function like(value: string) {
  return `%${value.replace(/[%_]/g, "\\$&")}%`;
}

export function messageFromRow(row: {
  remote_id: string;
  folder: string;
  folder_id: string;
  subject: string;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string;
  bcc_addrs?: string;
  snippet: string;
  body_text: string;
  body_html?: string;
  unread: number;
  starred: number;
  has_attachments: number;
  sent_at: string | null;
  received_at: string;
}): MailMessageDetail {
  return {
    id: row.remote_id,
    folderId: row.folder_id,
    folder: row.folder,
    subject: row.subject,
    from: { email: row.from_addr },
    to: parseEmails(row.to_addrs),
    cc: parseEmails(row.cc_addrs),
    bcc: parseEmails(row.bcc_addrs || "[]"),
    snippet: row.snippet,
    unread: !!row.unread,
    starred: !!row.starred,
    hasAttachments: !!row.has_attachments,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    text: row.body_text,
    html: row.body_html || "",
    attachments: [],
  };
}

export async function mailboxSyncState(db: DB, mailboxId: string) {
  return (
    (await db
      .selectFrom("mail_mailbox_sync")
      .selectAll()
      .where("mailbox_id", "=", mailboxId)
      .executeTakeFirst()) ?? null
  );
}

export async function cachedFolders(db: DB, mailboxId: string): Promise<MailFolder[]> {
  const state = await mailboxSyncState(db, mailboxId);
  if (!state?.folders_json) return [];
  try {
    const parsed = JSON.parse(state.folders_json) as MailFolder[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveMailboxFolders(db: DB, mailboxId: string, folders: MailFolder[]) {
  const now = new Date().toISOString();
  await db
    .insertInto("mail_mailbox_sync")
    .values({
      mailbox_id: mailboxId,
      folders_json: JSON.stringify(folders),
      synced_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("mailbox_id").doUpdateSet({
        folders_json: JSON.stringify(folders),
        synced_at: now,
        updated_at: now,
      }),
    )
    .execute();
  return folders;
}

export async function listStoredMessages(
  db: DB,
  mailboxId: string,
  query: MessageListQuery = {},
): Promise<MessagePage> {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  let rows = db
    .selectFrom("mail_messages")
    .selectAll()
    .where("mailbox_id", "=", mailboxId);
  if (query.folderId) rows = rows.where("folder_id", "=", query.folderId);
  if (query.unread) rows = rows.where("unread", "=", 1);
  if (query.starred) rows = rows.where("starred", "=", 1);
  if (query.q?.trim()) {
    const pattern = like(query.q.trim());
    rows = rows.where((eb) =>
      eb.or([
        eb("subject", "like", pattern),
        eb("from_addr", "like", pattern),
        eb("snippet", "like", pattern),
        eb("body_text", "like", pattern),
      ]),
    );
  }
  const items = await rows
    .orderBy("received_at", "desc")
    .offset(offset)
    .limit(limit + 1)
    .execute();
  const page = items.slice(0, limit);
  const unread = page.filter((item) => item.unread).length;
  return {
    items: page.map(messageFromRow),
    total: offset + items.length,
    unread,
    nextOffset: items.length > limit ? offset + limit : null,
  };
}

export async function storedMessage(db: DB, mailboxId: string, remoteId: string) {
  const row = await db
    .selectFrom("mail_messages")
    .selectAll()
    .where("mailbox_id", "=", mailboxId)
    .where("remote_id", "=", remoteId)
    .executeTakeFirst();
  return row ? { row, message: messageFromRow(row) } : null;
}

export async function syncMailboxFolders(
  db: DB,
  mailbox: Pick<MailboxRecord, "id" | "address" | "secret">,
  backend: StalwartMail,
) {
  const folders = await backend.listFolders(mailbox.address, mailbox.secret);
  await saveMailboxFolders(db, mailbox.id, folders);
  return folders;
}

export async function patchStoredMessage(
  db: DB,
  mailboxId: string,
  remoteId: string,
  patch: { unread?: boolean; starred?: boolean; folderId?: string; folder?: string },
) {
  const current = await storedMessage(db, mailboxId, remoteId);
  if (!current) return null;
  const now = new Date().toISOString();
  await db
    .updateTable("mail_messages")
    .set({
      ...(patch.unread == null ? {} : { unread: patch.unread ? 1 : 0 }),
      ...(patch.starred == null ? {} : { starred: patch.starred ? 1 : 0 }),
      ...(patch.folderId
        ? { folder_id: patch.folderId, folder: patch.folder || current.row.folder }
        : {}),
      updated_at: now,
    })
    .where("id", "=", current.row.id)
    .execute();
  return storedMessage(db, mailboxId, remoteId);
}

export async function syncMailboxFolder(
  db: DB,
  mailbox: Pick<MailboxRecord, "id" | "address" | "secret">,
  backend: StalwartMail,
  folderId?: string,
) {
  const page = await backend.listMessages(
    mailbox.address,
    { folderId, limit: 200 },
    mailbox.secret,
  );
  const remoteIds = new Set<string>();
  const rows = await db
    .selectFrom("mail_messages")
    .select(["remote_id", "folder_id", "folder"])
    .where("mailbox_id", "=", mailbox.id)
    .execute();
  const byRemote = new Map(rows.map((item) => [item.remote_id, item]));
  for (const item of page.items) {
    remoteIds.add(item.id);
    const existing = byRemote.get(item.id);
    if (!existing) {
      await indexMailMessage(db, mailbox, item);
      continue;
    }
    if (existing.folder_id !== item.folderId || existing.folder !== item.folder) {
      await db
        .updateTable("mail_messages")
        .set({
          folder_id: item.folderId,
          folder: item.folder,
          updated_at: new Date().toISOString(),
        })
        .where("mailbox_id", "=", mailbox.id)
        .where("remote_id", "=", item.id)
        .execute();
    }
  }
  return { page, remoteIds };
}

export async function fillStoredBodies(
  db: DB,
  mailbox: Pick<MailboxRecord, "id" | "address" | "secret">,
  backend: StalwartMail,
  limit = 8,
) {
  const pending = await db
    .selectFrom("mail_messages")
    .select(["remote_id"])
    .where("mailbox_id", "=", mailbox.id)
    .where("body_ready", "=", 0)
    .orderBy("received_at", "desc")
    .limit(limit)
    .execute();
  let filled = 0;
  for (const item of pending) {
    try {
      const detail = await backend.getMessage(mailbox.address, item.remote_id, mailbox.secret);
      await indexMailMessage(db, mailbox, detail);
      filled += 1;
    } catch {
      // Keep the list row; the next reconcile pass retries the body.
    }
  }
  return filled;
}

export async function reconcileMailbox(
  db: DB,
  mailbox: Pick<MailboxRecord, "id" | "address" | "secret">,
  backend: StalwartMail,
  options: { folderId?: string; fillBodies?: number; prune?: boolean } = {},
) {
  const folders = await syncMailboxFolders(db, mailbox, backend);
  const targets = options.folderId
    ? folders.filter((item) => item.id === options.folderId)
    : folders;
  const seen = new Set<string>();
  for (const folder of targets) {
    const { remoteIds } = await syncMailboxFolder(db, mailbox, backend, folder.id);
    for (const id of remoteIds) seen.add(id);
  }
  const prune = options.prune ?? !options.folderId;
  if (prune) {
    const stored = await db
      .selectFrom("mail_messages")
      .select(["remote_id"])
      .where("mailbox_id", "=", mailbox.id)
      .execute();
    for (const item of stored) {
      if (!seen.has(item.remote_id)) await unindexMailMessage(db, mailbox.id, item.remote_id);
    }
  }
  if (options.fillBodies) await fillStoredBodies(db, mailbox, backend, options.fillBodies);
  return {
    folders,
    syncedAt: (await mailboxSyncState(db, mailbox.id))?.synced_at ?? new Date().toISOString(),
  };
}
