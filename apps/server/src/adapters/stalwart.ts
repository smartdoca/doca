import { randomBytes, randomUUID } from "node:crypto";
import { fail } from "@core/shared/errors.js";
import type { MailSettingsConfig } from "@core/modules/mail/settings.js";
import { parseAddresses, validEmailAddress } from "@core/modules/mail/addresses.js";
import { seedMockMessages } from "../services/mail-mock.js";
import { createHttpWildduck } from "./wildduck-http.js";

export type MailFolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "junk"
  | "trash"
  | "archive"
  | "custom";

export type MailFolder = {
  id: string;
  name: string;
  role: MailFolderRole;
  total: number;
  unread: number;
};

export type MailAddress = { name?: string; email: string };

export type MailAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  data?: string;
  fileId?: string;
};

export type MailMessage = {
  id: string;
  folderId: string;
  folder: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  snippet: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  sentAt: string | null;
  receivedAt: string;
  files?: Array<{ name: string; size: number }>;
};

export type MailMessageDetail = MailMessage & {
  text: string;
  html: string;
  attachments: MailAttachment[];
  inReplyTo?: string | null;
};

export type MessageListQuery = {
  folderId?: string;
  q?: string;
  unread?: boolean;
  starred?: boolean;
  offset?: number;
  limit?: number;
};

export type MessagePage = {
  items: MailMessage[];
  total: number;
  unread: number;
  nextOffset: number | null;
};

export type SendDraft = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  draftId?: string;
  inReplyTo?: string;
  attachments?: Array<{ name: string; mime: string; data: string }>;
};

export type MessagePatch = {
  unread?: boolean;
  starred?: boolean;
  folderId?: string;
};

export interface StalwartMail {
  testConnection(): Promise<{ ok: true; version?: string }>;
  ensureDomain(domain: string): Promise<void>;
  createAccount(input: {
    name: string;
    address: string;
    secret: string;
  }): Promise<{ id: string }>;
  bindAccount(input: { address: string; userId: string }): void;
  resolveAccount(address: string): Promise<{ id: string }>;
  updateAccount(input: { userId: string; address: string; name?: string }): Promise<void>;
  deleteAccount(name: string): Promise<void>;
  listFolders(account: string, secret?: string): Promise<MailFolder[]>;
  createFolder(
    account: string,
    name: string,
    parentId?: string | null,
    secret?: string,
  ): Promise<MailFolder>;
  renameFolder(
    account: string,
    folderId: string,
    name: string,
    secret?: string,
  ): Promise<MailFolder>;
  deleteFolder(account: string, folderId: string, secret?: string): Promise<void>;
  listMessages(
    account: string,
    query?: MessageListQuery,
    secret?: string,
  ): Promise<MessagePage>;
  getMessage(account: string, id: string, secret?: string): Promise<MailMessageDetail>;
  sendMessage(account: string, draft: SendDraft, secret?: string): Promise<MailMessageDetail>;
  saveReceipt(
    account: string,
    receipt: { subject: string; text: string; html?: string },
    secret?: string,
  ): Promise<MailMessageDetail>;
  saveDraft(account: string, draft: SendDraft, secret?: string): Promise<MailMessageDetail>;
  updateMessage(
    account: string,
    id: string,
    patch: MessagePatch,
    secret?: string,
  ): Promise<MailMessage>;
  deleteMessage(
    account: string,
    id: string,
    permanent?: boolean,
    secret?: string,
  ): Promise<void>;
  searchMessages(account: string, query: string, secret?: string): Promise<MailMessage[]>;
  getAttachment(
    account: string,
    attachmentId: string,
    secret?: string,
  ): Promise<{ name: string; mime: string; size: number; data: string }>;
}

const defaultFolders: Array<{ name: string; role: MailFolderRole }> = [
  { name: "收件箱", role: "inbox" },
  { name: "已发送", role: "sent" },
  { name: "草稿箱", role: "drafts" },
  { name: "垃圾邮件", role: "junk" },
  { name: "已删除", role: "trash" },
  { name: "归档", role: "archive" },
];

type StoredMessage = MailMessageDetail & { account: string };

function snippetOf(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function asAddress(value: string): MailAddress {
  const match = /^(.*)<([^>]+)>$/.exec(value.trim());
  if (match) return { name: match[1]!.trim() || undefined, email: match[2]!.trim() };
  return { email: value.trim() };
}

function requireAddresses(values: string[], label: string) {
  const emails = values.map((value) => asAddress(value).email);
  if (!emails.length) fail(400, `请填写${label}`);
  for (const email of emails)
    if (!validEmailAddress(email)) fail(400, `${label}「${email}」不是有效邮箱`);
  return emails.map(asAddress);
}

export function createMemoryStalwart(options: { seed?: boolean } = {}): StalwartMail {
  const domains = new Set<string>();
  const accounts = new Map<
    string,
    { id: string; address: string; secret: string; folders: Map<string, MailFolder> }
  >();
  const messages = new Map<string, StoredMessage>();

  function accountOf(name: string) {
    const account =
      accounts.get(name) ??
      [...accounts.values()].find((item) => item.address === name || item.id === name);
    if (!account) fail(404, "邮箱账户不存在");
    return account;
  }

  function folderOf(account: ReturnType<typeof accountOf>, folderId?: string) {
    const folder = folderId
      ? account.folders.get(folderId)
      : [...account.folders.values()].find((item) => item.role === "inbox");
    if (!folder) fail(404, "邮件文件夹不存在");
    return folder;
  }

  function recount(account: ReturnType<typeof accountOf>) {
    for (const folder of account.folders.values()) {
      const items = [...messages.values()].filter(
        (item) => item.account === account.address && item.folderId === folder.id,
      );
      folder.total = items.length;
      folder.unread = items.filter((item) => item.unread).length;
    }
  }

  function deliver(
    to: MailAddress[],
    message: Omit<StoredMessage, "account" | "id" | "folderId" | "folder">,
  ) {
    for (const recipient of to) {
      const target = [...accounts.values()].find(
        (item) => item.address === recipient.email,
      );
      if (!target) continue;
      const inbox = [...target.folders.values()].find((item) => item.role === "inbox")!;
      const id = randomUUID();
      messages.set(id, {
        ...message,
        id,
        account: target.address,
        folderId: inbox.id,
        folder: inbox.name,
        unread: true,
      });
    }
    for (const account of accounts.values()) recount(account);
  }

  return {
    async testConnection() {
      return { ok: true, version: "memory" };
    },
    async ensureDomain(domain) {
      domains.add(domain);
    },
    async createAccount({ address, secret }) {
      const existing = accounts.get(address) ?? [...accounts.values()].find((item) => item.address === address);
      if (existing) return { id: existing.id };
      const id = randomUUID();
      const folders = new Map<string, MailFolder>();
      for (const folder of defaultFolders) {
        const folderId = randomUUID();
        folders.set(folderId, { id: folderId, name: folder.name, role: folder.role, total: 0, unread: 0 });
      }
      accounts.set(address, { id, address, secret, folders });
      if (options.seed) seedMockMessages(accounts.get(address)!, messages);
      return { id };
    },
    bindAccount() {},
    async resolveAccount(address) {
      const account = accounts.get(address) ?? [...accounts.values()].find((item) => item.address === address);
      if (!account) fail(404, "邮箱账户不存在");
      return { id: account.id };
    },
    async updateAccount({ userId, address }) {
      const entry = [...accounts.entries()].find(([, account]) => account.id === userId);
      if (!entry) fail(404, "邮箱账户不存在");
      const [key, account] = entry;
      const previous = account.address;
      accounts.delete(key);
      account.address = address;
      accounts.set(address, account);
      for (const message of messages.values())
        if (message.account === previous) message.account = address;
    },
    async deleteAccount(name) {
      const entry = [...accounts.entries()].find(
        ([key, account]) => key === name || account.address === name || account.id === name,
      );
      if (!entry) return;
      const [key, account] = entry;
      for (const [id, message] of messages)
        if (message.account === account.address) messages.delete(id);
      accounts.delete(key);
    },
    async listFolders(account) {
      const current = accountOf(account);
      if (options.seed) {
        seedMockMessages(current, messages);
        recount(current);
      }
      return [...current.folders.values()];
    },
    async createFolder(account, name) {
      const current = accountOf(account);
      const folder: MailFolder = {
        id: randomUUID(),
        name: name.trim() || "新文件夹",
        role: "custom",
        total: 0,
        unread: 0,
      };
      current.folders.set(folder.id, folder);
      return folder;
    },
    async renameFolder(account, folderId, name) {
      const folder = folderOf(accountOf(account), folderId);
      if (folder.role !== "custom") fail(400, "系统文件夹不能改名");
      folder.name = name.trim() || folder.name;
      return folder;
    },
    async deleteFolder(account, folderId) {
      const current = accountOf(account);
      const folder = folderOf(current, folderId);
      if (folder.role !== "custom") fail(400, "系统文件夹不能删除");
      current.folders.delete(folder.id);
    },
    async listMessages(account, query = {}) {
      const current = accountOf(account);
      const folder = query.folderId ? folderOf(current, query.folderId) : null;
      const q = query.q?.trim().toLowerCase() ?? "";
      const offset = query.offset ?? 0;
      const limit = Math.min(100, query.limit ?? 30);
      const items = [...messages.values()]
        .filter((item) => item.account === current.address)
        .filter((item) => !folder || item.folderId === folder.id)
        .filter((item) => query.unread == null || item.unread === query.unread)
        .filter((item) => query.starred == null || item.starred === query.starred)
        .filter((item) => {
          if (!q) return true;
          return [item.subject, item.from.email, item.from.name, item.snippet, item.text]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(q));
        })
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      return {
        items: items.slice(offset, offset + limit).map(summaryOf),
        total: items.length,
        unread: items.filter((item) => item.unread).length,
        nextOffset: offset + limit < items.length ? offset + limit : null,
      };
    },
    async getMessage(account, id) {
      const current = accountOf(account);
      const message = messages.get(id);
      if (!message || message.account !== current.address) fail(404, "邮件不存在");
      message.unread = false;
      recount(current);
      return { ...message, attachments: message.attachments.map((item) => ({ ...item })) };
    },
    async sendMessage(account, draft) {
      const current = accountOf(account);
      const sent = [...current.folders.values()].find((item) => item.role === "sent")!;
      const to = requireAddresses(draft.to, "收件人");
      const cc = (draft.cc ?? []).length ? requireAddresses(draft.cc!, "抄送") : [];
      const bcc = (draft.bcc ?? []).length ? requireAddresses(draft.bcc!, "密送") : [];
      const text = draft.text?.trim() || htmlToText(draft.html ?? "");
      const now = new Date().toISOString();
      const attachments = (draft.attachments ?? []).map((item) => ({
        id: randomUUID(),
        name: item.name,
        mime: item.mime,
        size: Buffer.from(item.data, "base64").length,
        data: item.data,
      }));
      const message: StoredMessage = {
        id: draft.draftId && messages.get(draft.draftId)?.account === current.address ? draft.draftId : randomUUID(),
        account: current.address,
        folderId: sent.id,
        folder: sent.name,
        subject: draft.subject.trim() || "（无主题）",
        from: { email: current.address },
        to,
        cc,
        bcc,
        snippet: snippetOf(text),
        unread: false,
        starred: false,
        hasAttachments: !!attachments.length,
        sentAt: now,
        receivedAt: now,
        text,
        html: draft.html ?? "",
        attachments,
        inReplyTo: draft.inReplyTo ?? null,
      };
      messages.set(message.id, message);
      deliver([...to, ...cc, ...bcc], {
        subject: message.subject,
        from: message.from,
        to,
        cc,
        bcc: [],
        snippet: message.snippet,
        unread: true,
        starred: false,
        hasAttachments: message.hasAttachments,
        sentAt: now,
        receivedAt: now,
        text,
        html: message.html,
        attachments,
        inReplyTo: message.inReplyTo,
      });
      recount(current);
      return message;
    },
    async saveReceipt(account, receipt) {
      const current = accountOf(account);
      const inbox = [...current.folders.values()].find((item) => item.role === "inbox");
      if (!inbox) fail(404, "邮件文件夹不存在");
      const now = new Date().toISOString();
      const message: StoredMessage = {
        id: randomUUID(),
        account: current.address,
        folderId: inbox.id,
        folder: inbox.name,
        subject: receipt.subject,
        from: { name: "邮件回执", email: current.address },
        to: [{ email: current.address }],
        cc: [],
        bcc: [],
        snippet: snippetOf(receipt.text),
        unread: true,
        starred: false,
        hasAttachments: false,
        sentAt: now,
        receivedAt: now,
        text: receipt.text,
        html: receipt.html || "",
        attachments: [],
        inReplyTo: null,
      };
      messages.set(message.id, message);
      recount(current);
      return message;
    },
    async saveDraft(account, draft) {
      const current = accountOf(account);
      const drafts = [...current.folders.values()].find((item) => item.role === "drafts")!;
      const text = draft.text?.trim() || htmlToText(draft.html ?? "");
      const now = new Date().toISOString();
      const attachments = (draft.attachments ?? []).map((item) => ({
        id: randomUUID(),
        name: item.name,
        mime: item.mime,
        size: Buffer.from(item.data, "base64").length,
        data: item.data,
      }));
      const id =
        draft.draftId && messages.get(draft.draftId)?.account === current.address
          ? draft.draftId
          : randomUUID();
      const message: StoredMessage = {
        id,
        account: current.address,
        folderId: drafts.id,
        folder: drafts.name,
        subject: draft.subject.trim() || "（无主题）",
        from: { email: current.address },
        to: parseAddresses(draft.to).map(asAddress),
        cc: parseAddresses(draft.cc).map(asAddress),
        bcc: parseAddresses(draft.bcc).map(asAddress),
        snippet: snippetOf(text),
        unread: false,
        starred: false,
        hasAttachments: !!attachments.length,
        sentAt: null,
        receivedAt: now,
        text,
        html: draft.html ?? "",
        attachments,
        inReplyTo: draft.inReplyTo ?? null,
      };
      messages.set(id, message);
      recount(current);
      return message;
    },
    async updateMessage(account, id, patch) {
      const current = accountOf(account);
      const message = messages.get(id);
      if (!message || message.account !== current.address) fail(404, "邮件不存在");
      if (patch.unread != null) message.unread = patch.unread;
      if (patch.starred != null) message.starred = patch.starred;
      if (patch.folderId) {
        const folder = folderOf(current, patch.folderId);
        message.folderId = folder.id;
        message.folder = folder.name;
      }
      recount(current);
      return summaryOf(message);
    },
    async deleteMessage(account, id, permanent) {
      const current = accountOf(account);
      const message = messages.get(id);
      if (!message || message.account !== current.address) fail(404, "邮件不存在");
      const trash = [...current.folders.values()].find((item) => item.role === "trash")!;
      if (permanent || message.folderId === trash.id) messages.delete(id);
      else {
        message.folderId = trash.id;
        message.folder = trash.name;
      }
      recount(current);
    },
    async searchMessages(account, query) {
      const page = await this.listMessages(account, { q: query, limit: 50 });
      return page.items;
    },
    async getAttachment(account, attachmentId) {
      const current = accountOf(account);
      for (const message of messages.values()) {
        if (message.account !== current.address) continue;
        const attachment = message.attachments.find((item) => item.id === attachmentId);
        if (attachment?.data)
          return {
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
            data: attachment.data,
          };
      }
      fail(404, "附件不存在");
    },
  };
}

function summaryOf(message: MailMessageDetail): MailMessage {
  return {
    id: message.id,
    folderId: message.folderId,
    folder: message.folder,
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    snippet: message.snippet,
    unread: message.unread,
    starred: message.starred,
    hasAttachments: message.hasAttachments,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    files: message.attachments.map((item) => ({ name: item.name, size: item.size })),
  };
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mailboxSecret() {
  return randomBytes(24).toString("base64url");
}

export { createHttpWildduck };

export function createHttpStalwart(
  settings: MailSettingsConfig,
  fetchImpl?: typeof fetch,
) {
  return createHttpWildduck(settings, fetchImpl);
}

export function createStalwart(
  settings: MailSettingsConfig,
  options: { client?: StalwartMail; fetch?: typeof fetch } = {},
) {
  if (options.client) return options.client;
  if (!settings.endpoint) return createMemoryStalwart();
  return createHttpWildduck(settings, options.fetch);
}

