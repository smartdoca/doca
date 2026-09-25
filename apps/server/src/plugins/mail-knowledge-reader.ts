import { stableId } from "@doca/files-capability";
import type {
  MailKnowledgeMailbox,
  MailKnowledgeMessage,
  MailKnowledgeReader,
} from "@doca/plugin-mail";
import type { KnowledgeSourceReaderMapping } from "@doca/knowledge-capability";
import type { DB, Schema } from "@db/index.js";

const pageLimit = (value?: number) =>
  Math.max(1, Math.min(100, Math.floor(value ?? 50)));

function strings(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function visibleMailboxIds(db: DB, principalId: string) {
  const [owned, shared] = await Promise.all([
    db
      .selectFrom("mailboxes")
      .select("id")
      .where("owner_id", "=", principalId)
      .where("deleted_at", "is", null)
      .execute(),
    db
      .selectFrom("mailbox_shares")
      .innerJoin("mailboxes", "mailboxes.id", "mailbox_shares.mailbox_id")
      .select("mailboxes.id")
      .where("mailbox_shares.user_id", "=", principalId)
      .where("mailboxes.deleted_at", "is", null)
      .execute(),
  ]);
  return [...new Set([...owned, ...shared].map((row) => row.id))];
}

async function mailboxReaders(
  db: DB,
  mailbox: Pick<Schema["mailboxes"], "id" | "owner_id">,
): Promise<readonly KnowledgeSourceReaderMapping[]> {
  const shares = await db
    .selectFrom("mailbox_shares")
    .select(["user_id", "version", "updated_at"])
    .where("mailbox_id", "=", mailbox.id)
    .execute();
  return [
    {
      externalReaderId: `owner:${mailbox.owner_id}`,
      readerId: mailbox.owner_id,
    },
    ...shares.map((share) => ({
      externalReaderId: `share:${share.user_id}:${share.version}:${share.updated_at}`,
      readerId: share.user_id,
    })),
  ];
}

async function mailboxRecord(
  db: DB,
  row: Schema["mailboxes"],
): Promise<MailKnowledgeMailbox> {
  const readers = await mailboxReaders(db, row);
  return {
    id: row.id,
    externalVersion: `${row.version}:${row.updated_at}:${readers
      .map((reader) => reader.externalReaderId)
      .join("|")}`,
    title: row.display_name || row.address,
    address: row.address,
    observedAt: row.updated_at,
    readers,
  };
}

export function createMailKnowledgeReader(db: DB): MailKnowledgeReader {
  return {
    async getMailbox(mailboxId, context) {
      context.signal?.throwIfAborted();
      const visible = await visibleMailboxIds(db, context.principalId);
      if (!visible.includes(mailboxId)) return null;
      const row = await db
        .selectFrom("mailboxes")
        .selectAll()
        .where("id", "=", mailboxId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return row ? mailboxRecord(db, row) : null;
    },
    async listMailboxes(input, context) {
      context.signal?.throwIfAborted();
      const visible = await visibleMailboxIds(db, context.principalId);
      if (!visible.length) return { items: [], cursor: null };
      const limit = pageLimit(input.limit);
      let query = db
        .selectFrom("mailboxes")
        .selectAll()
        .where("id", "in", visible)
        .where("deleted_at", "is", null);
      if (input.cursor) query = query.where("id", ">", input.cursor);
      const rows = await query.orderBy("id").limit(limit + 1).execute();
      const page = rows.slice(0, limit);
      return {
        items: await Promise.all(page.map((row) => mailboxRecord(db, row))),
        cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
    async listMessages(input, context) {
      context.signal?.throwIfAborted();
      const visible = await visibleMailboxIds(db, context.principalId);
      if (!visible.includes(input.mailboxId))
        return { items: [], cursor: null };
      const mailbox = await db
        .selectFrom("mailboxes")
        .selectAll()
        .where("id", "=", input.mailboxId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!mailbox) return { items: [], cursor: null };
      const limit = pageLimit(input.limit);
      let query = db
        .selectFrom("mail_messages")
        .selectAll()
        .where("mailbox_id", "=", input.mailboxId);
      if (input.scope === "starred") query = query.where("starred", "=", 1);
      if (input.cursor) query = query.where("id", ">", input.cursor);
      const rows = await query.orderBy("id").limit(limit + 1).execute();
      const page = rows.slice(0, limit);
      const readers = await mailboxReaders(db, mailbox);
      const ownerIds = page.map(
        (row) => `${row.mailbox_id}:${row.remote_id}`,
      );
      const bindings = ownerIds.length
        ? await db
            .selectFrom("file_bindings as b")
            .innerJoin("file_items as f", "f.id", "b.file_id")
            .select(["b.owner_id", "b.file_id"])
            .where("b.owner_plugin", "=", "doca.mail")
            .where("b.owner_type", "=", "message")
            .where("b.owner_id", "in", ownerIds)
            .where("f.deleted_at", "is", null)
            .execute()
        : [];
      const fileIds = new Map<string, string[]>();
      for (const binding of bindings) {
        const values = fileIds.get(binding.owner_id) ?? [];
        values.push(binding.file_id);
        fileIds.set(binding.owner_id, values);
      }
      const items: MailKnowledgeMessage[] = page.map((row) => ({
        id: `${row.mailbox_id}:${row.remote_id}`,
        mailboxId: row.mailbox_id,
        externalVersion: `${row.updated_at}:${row.starred}:${readers
          .map((reader) => reader.externalReaderId)
          .join("|")}`,
        title: row.subject || "（无主题）",
        text: row.body_text || row.snippet,
        from: row.from_addr || undefined,
        to: strings(row.to_addrs),
        receivedAt: row.received_at,
        observedAt: row.updated_at,
        readers,
        fileIds: (fileIds.get(`${row.mailbox_id}:${row.remote_id}`) ?? []).map(
          (id) => stableId(id, "file"),
        ),
        metadata: {
          folder: row.folder,
          unread: !!row.unread,
          starred: !!row.starred,
        },
      }));
      return {
        items,
        cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  };
}
