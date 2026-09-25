import { ImapFlow, type FetchMessageObject, type ListResponse, type MailboxObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { fail } from "@core/shared/errors.js";
import type { ExternalMailCredentials } from "@core/modules/mail/external.js";
import { mailOauthImapAuth, mailOauthSmtpAuth } from "./mail-oauth.js";
import type {
  MailAttachment,
  MailAddress,
  MailFolder,
  MailFolderRole,
  MailMessage,
  MailMessageDetail,
  MessageListQuery,
  MessagePage,
  SendDraft,
  StalwartMail,
} from "./stalwart.js";

function encodeId(folder: string, uid: number) {
  return `${Buffer.from(folder).toString("base64url")}:${uid}`;
}

function decodeId(id: string) {
  const split = id.lastIndexOf(":");
  if (split < 1) fail(400, "邮件编号无效");
  const folder = Buffer.from(id.slice(0, split), "base64url").toString("utf8");
  const uid = Number(id.slice(split + 1));
  if (!folder || !Number.isInteger(uid) || uid < 1) fail(400, "邮件编号无效");
  return { folder, uid };
}

function asAddress(value?: { name?: string; address?: string } | string | null): MailAddress | null {
  if (!value) return null;
  if (typeof value === "string") {
    const match = /^(.*)<([^>]+)>$/.exec(value.trim());
    return match ? { name: match[1]!.trim() || undefined, email: match[2]!.trim() } : { email: value.trim() };
  }
  if (!value.address) return null;
  return { name: value.name || undefined, email: value.address };
}

function asAddresses(value?: unknown) {
  if (!value) return [];
  if (typeof value === "string")
    return value
      .split(/[,;]+/)
      .map((item) => asAddress(item))
      .filter((item): item is MailAddress => !!item);
  const raw = Array.isArray(value)
    ? value
    : typeof value === "object" && value && "value" in value
      ? (value as { value?: unknown }).value
      : [];
  return (Array.isArray(raw) ? raw : []).map((item) =>
    asAddress(item as { name?: string; address?: string }),
  ).filter((item): item is MailAddress => !!item);
}

function isoDate(value?: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function snippetOf(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function folderRole(box: Pick<ListResponse, "path" | "specialUse" | "specialUseSource">): MailFolderRole {
  const special = String(box.specialUse || box.specialUseSource || "").toLowerCase();
  const path = box.path.toLowerCase();
  if (special.includes("inbox") || path === "inbox") return "inbox";
  if (special.includes("sent") || /(^|\/)(sent|已发送)/.test(path)) return "sent";
  if (special.includes("draft") || /(^|\/)(drafts?|草稿)/.test(path)) return "drafts";
  if (special.includes("junk") || special.includes("spam") || /(^|\/)(junk|spam|垃圾)/.test(path)) return "junk";
  if (
    special.includes("trash") ||
    special.includes("bin") ||
    /(^|\/)(trash|deleted|bin|已删除|废纸篓|已刪除)/.test(path)
  )
    return "trash";
  if (special.includes("archive") || /(^|\/)(archive|归档)/.test(path)) return "archive";
  return "custom";
}

function folderName(box: ListResponse) {
  return box.path.split(/[/.]/).filter(Boolean).at(-1) || box.path;
}

function hasAttachments(msg: FetchMessageObject) {
  const nodes = [msg.bodyStructure];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node) continue;
    if (Array.isArray(node.childNodes)) nodes.push(...node.childNodes);
    if (node.disposition === "attachment" || (node.type && node.type !== "text" && node.type !== "multipart"))
      return true;
  }
  return false;
}

function fromParsed(parsed: ParsedMail, folder: MailFolder, uid: number, unread: boolean, starred: boolean): MailMessageDetail {
  const attachments: MailAttachment[] = (parsed.attachments ?? []).map((item, index) => ({
    id: `${encodeId(folder.id, uid)}:${index}`,
    name: item.filename || `附件${index + 1}`,
    mime: item.contentType || "application/octet-stream",
    size: item.size || item.content?.length || 0,
    data: item.content ? Buffer.from(item.content).toString("base64") : undefined,
  }));
  const text = parsed.text || "";
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const fromValue = Array.isArray(parsed.from) ? parsed.from[0]?.value[0] : parsed.from?.value[0];
  const from = asAddress(fromValue) ?? { email: "" };
  return {
    id: encodeId(folder.id, uid),
    folderId: folder.id,
    folder: folder.name,
    subject: parsed.subject || "",
    from,
    to: asAddresses(parsed.to),
    cc: asAddresses(parsed.cc),
    bcc: asAddresses(parsed.bcc),
    snippet: snippetOf(text || html.replace(/<[^>]+>/g, " ")),
    unread,
    starred,
    hasAttachments: attachments.length > 0,
    sentAt: parsed.date?.toISOString() ?? null,
    receivedAt: parsed.date?.toISOString() ?? new Date().toISOString(),
    text,
    html,
    attachments,
    inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : parsed.inReplyTo?.[0],
  };
}

function fromEnvelope(msg: FetchMessageObject, folder: MailFolder): MailMessage {
  const envelope = msg.envelope;
  const flags = new Set((msg.flags ?? []) as string[]);
  return {
    id: encodeId(folder.id, msg.uid),
    folderId: folder.id,
    folder: folder.name,
    subject: envelope?.subject || "",
    from: asAddress(envelope?.from?.[0]) ?? { email: "" },
    to: asAddresses(envelope?.to),
    cc: asAddresses(envelope?.cc),
    bcc: asAddresses(envelope?.bcc),
    snippet: "",
    unread: !flags.has("\\Seen"),
    starred: flags.has("\\Flagged"),
    hasAttachments: hasAttachments(msg),
    sentAt: isoDate(envelope?.date),
    receivedAt: isoDate(msg.internalDate ?? envelope?.date) ?? new Date().toISOString(),
  };
}

async function compileRaw(from: string, draft: SendDraft) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
    html: draft.html,
    inReplyTo: draft.inReplyTo,
    attachments: draft.attachments?.map((item) => ({
      filename: item.name,
      content: Buffer.from(item.data, "base64"),
      contentType: item.mime,
    })),
  });
  return info.message as Buffer;
}

export function createImapMail(credentials: ExternalMailCredentials): StalwartMail {
  async function withImap<T>(fn: (client: ImapFlow) => Promise<T>) {
    const client = new ImapFlow({
      host: credentials.imap.host,
      port: credentials.imap.port,
      secure: credentials.imap.secure,
      auth: mailOauthImapAuth(credentials),
      logger: false,
    });
    try {
      await client.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : "外部邮箱连接失败";
      fail(400, `外部邮箱连接失败：${message}`);
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async function foldersOf(client: ImapFlow): Promise<MailFolder[]> {
    const listed = await client.list({ statusQuery: { messages: true, unseen: true } });
    return listed
      .filter((item) => !item.flags.has("\\Noselect") && !item.flags.has("\\NonExistent"))
      .map((item) => ({
        id: item.path,
        name: folderName(item),
        role: folderRole(item),
        total: item.status?.messages ?? 0,
        unread: item.status?.unseen ?? 0,
      }));
  }

  async function folderById(client: ImapFlow, folderId?: string) {
    const folders = await foldersOf(client);
    const folder =
      folders.find((item) => item.id === folderId) ??
      folders.find((item) => item.role === "inbox") ??
      folders[0];
    if (!folder) fail(404, "邮件文件夹不存在");
    return { folder, folders };
  }

  async function folderByRole(client: ImapFlow, role: MailFolderRole) {
    const folders = await foldersOf(client);
    return folders.find((item) => item.role === role) ?? null;
  }

  async function openFolder(client: ImapFlow, path: string, readOnly = false) {
    const mailbox: MailboxObject = await client.mailboxOpen(path, { readOnly });
    return mailbox;
  }

  async function fetchPage(client: ImapFlow, folder: MailFolder, query: MessageListQuery = {}): Promise<MessagePage> {
    await openFolder(client, folder.id, true);
    const criteria: Record<string, unknown> = { all: true };
    if (query.unread) criteria.unseen = true;
    if (query.starred) criteria.flagged = true;
    if (query.q?.trim())
      criteria.or = [{ subject: query.q.trim() }, { body: query.q.trim() }, { from: query.q.trim() }];
    const found = await client.search(criteria, { uid: true });
    const uids = Array.isArray(found) ? found : [];
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const slice = uids.slice().reverse().slice(offset, offset + limit);
    const items: MailMessage[] = [];
    if (slice.length) {
      for await (const msg of client.fetch(slice, {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        bodyStructure: true,
      }, { uid: true })) {
        items.push(fromEnvelope(msg, folder));
      }
    }
    items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return {
      items,
      total: uids.length,
      unread: folder.unread,
      nextOffset: offset + slice.length < uids.length ? offset + slice.length : null,
    };
  }

  return {
    async testConnection() {
      await withImap(async () => undefined);
      return { ok: true, version: "imap" };
    },
    async ensureDomain() {},
    async createAccount() {
      return { id: "" };
    },
    bindAccount() {},
    async resolveAccount() {
      return { id: "" };
    },
    async updateAccount() {},
    async deleteAccount() {},
    async listFolders() {
      return withImap(foldersOf);
    },
    async createFolder(_account, name, parentId) {
      return withImap(async (client) => {
        const path = parentId ? `${parentId}/${name}` : name;
        await client.mailboxCreate(path);
        const { folder } = await folderById(client, path);
        return folder;
      });
    },
    async renameFolder(_account, folderId, name) {
      return withImap(async (client) => {
        const parent = folderId.includes("/") ? folderId.slice(0, folderId.lastIndexOf("/")) : "";
        const path = parent ? `${parent}/${name}` : name;
        await client.mailboxRename(folderId, path);
        const { folder } = await folderById(client, path);
        return folder;
      });
    },
    async deleteFolder(_account, folderId) {
      await withImap(async (client) => {
        await client.mailboxDelete(folderId);
      });
    },
    async listMessages(_account, query) {
      return withImap(async (client) => {
        if (query?.starred && !query.folderId) {
          const folders = await foldersOf(client);
          const items: MailMessage[] = [];
          for (const folder of folders) {
            const page = await fetchPage(client, folder, { starred: true, limit: 80 });
            items.push(...page.items);
          }
          items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
          return { items, total: items.length, unread: items.filter((item) => item.unread).length, nextOffset: null };
        }
        const { folder } = await folderById(client, query?.folderId);
        return fetchPage(client, folder, query);
      });
    },
    async getMessage(_account, id) {
      return withImap(async (client) => {
        const { folder: folderId, uid } = decodeId(id);
        const { folder } = await folderById(client, folderId);
        await openFolder(client, folder.id);
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, source: true, flags: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (!msg || !msg.source) fail(404, "邮件不存在");
        const flags = new Set((msg.flags ?? []) as string[]);
        if (!flags.has("\\Seen")) await client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true });
        return fromParsed(await simpleParser(msg.source), folder, msg.uid, false, flags.has("\\Flagged"));
      });
    },
    async sendMessage(_account, draft) {
      const raw = await compileRaw(credentials.address, draft);
      const transport = nodemailer.createTransport({
        host: credentials.smtp.host,
        port: credentials.smtp.port,
        secure: credentials.smtp.secure,
        auth: mailOauthSmtpAuth(credentials),
      });
      try {
        await transport.sendMail({
          envelope: {
            from: credentials.address,
            to: [...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])],
          },
          raw,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "发送失败";
        fail(400, `外部邮箱发送失败：${message}`);
      }
      return withImap(async (client) => {
        const sent = await folderByRole(client, "sent");
        if (sent) await client.append(sent.id, raw, ["\\Seen"]);
        const parsed = await simpleParser(raw);
        const folder = sent ?? { id: "Sent", name: "已发送", role: "sent" as const, total: 1, unread: 0 };
        return fromParsed(parsed, folder, Date.now() % 1_000_000_000, false, false);
      });
    },
    async saveReceipt(_account, receipt) {
      const raw = await compileRaw(credentials.address, {
        to: [credentials.address],
        subject: receipt.subject,
        text: receipt.text,
        html: receipt.html,
      });
      return withImap(async (client) => {
        const inbox = (await folderByRole(client, "inbox")) ?? {
          id: "INBOX",
          name: "收件箱",
          role: "inbox" as const,
          total: 1,
          unread: 1,
        };
        const appended = await client.append(inbox.id, raw, []);
        const parsed = await simpleParser(raw);
        return fromParsed(
          parsed,
          inbox,
          appended === false
            ? Date.now() % 1_000_000_000
            : (appended.uid ?? Date.now() % 1_000_000_000),
          true,
          false,
        );
      });
    },
    async saveDraft(_account, draft) {
      const raw = await compileRaw(credentials.address, draft);
      return withImap(async (client) => {
        const drafts = (await folderByRole(client, "drafts")) ?? { id: "Drafts", name: "草稿箱", role: "drafts" as const, total: 0, unread: 0 };
        const appended = await client.append(drafts.id, raw, ["\\Draft", "\\Seen"]);
        const parsed = await simpleParser(raw);
        const uid = appended === false ? undefined : appended.uid;
        return fromParsed(parsed, drafts, uid ?? Date.now() % 1_000_000_000, false, false);
      });
    },
    async updateMessage(_account, id, patch) {
      return withImap(async (client) => {
        const decoded = decodeId(id);
        let folderId = decoded.folder;
        await openFolder(client, folderId);
        if (patch.unread === false) await client.messageFlagsAdd({ uid: decoded.uid }, ["\\Seen"], { uid: true });
        if (patch.unread === true) await client.messageFlagsRemove({ uid: decoded.uid }, ["\\Seen"], { uid: true });
        if (patch.starred === true) await client.messageFlagsAdd({ uid: decoded.uid }, ["\\Flagged"], { uid: true });
        if (patch.starred === false) await client.messageFlagsRemove({ uid: decoded.uid }, ["\\Flagged"], { uid: true });
        if (patch.folderId && patch.folderId !== folderId) {
          await client.messageMove({ uid: decoded.uid }, patch.folderId, { uid: true });
          folderId = patch.folderId;
        }
        const { folder } = await folderById(client, folderId);
        await openFolder(client, folder.id, true);
        const msg = await client.fetchOne(
          String(decoded.uid),
          { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
          { uid: true },
        );
        if (!msg) fail(404, "邮件不存在");
        return fromEnvelope(msg, folder);
      });
    },
    async deleteMessage(_account, id, permanent) {
      await withImap(async (client) => {
        const { folder, uid } = decodeId(id);
        await openFolder(client, folder);
        const expunge = async () => {
          await client.messageFlagsAdd({ uid }, ["\\Deleted"], { uid: true });
          await client.messageDelete({ uid }, { uid: true });
        };
        if (permanent) {
          await expunge();
          return;
        }
        const trash = await folderByRole(client, "trash");
        if (trash && trash.id !== folder) {
          try {
            await client.messageMove({ uid }, trash.id, { uid: true });
            return;
          } catch {
            try {
              await client.messageCopy({ uid }, trash.id, { uid: true });
            } catch {
              /* Some providers only allow flag+expunge. */
            }
          }
        }
        await expunge();
      });
    },
    async searchMessages(_account, query) {
      return withImap(async (client) => {
        const folders = await foldersOf(client);
        const items: MailMessage[] = [];
        for (const folder of folders) {
          const page = await fetchPage(client, folder, { q: query, limit: 20 });
          items.push(...page.items);
        }
        return items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 50);
      });
    },
    async getAttachment(_account, attachmentId) {
      const split = attachmentId.lastIndexOf(":");
      if (split < 1) fail(404, "附件不存在");
      const messageId = attachmentId.slice(0, split);
      const index = Number(attachmentId.slice(split + 1));
      const message = await this.getMessage(_account, messageId);
      const attachment = message.attachments[index];
      if (!attachment?.data) fail(404, "附件不存在");
      return { name: attachment.name, mime: attachment.mime, size: attachment.size, data: attachment.data };
    },
  };
}
