import { createHash } from "node:crypto";
import { fail } from "@core/shared/errors.js";
import type { MailSettingsConfig } from "@core/modules/mail/settings.js";
import { validEmailAddress } from "@core/modules/mail/addresses.js";
import type {
  MailAddress,
  MailFolder,
  MailFolderRole,
  MailMessage,
  MailMessageDetail,
  StalwartMail,
} from "./stalwart.js";

const folderLabels: Record<string, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿箱",
  junk: "垃圾邮件",
  trash: "已删除",
  archive: "归档",
};

const specialUseRole: Record<string, MailFolderRole> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\junk": "junk",
  "\\trash": "trash",
  "\\archive": "archive",
};

type UserRef = { id: string; address: string };

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

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function usernameOf(address: string) {
  const email = address.trim().toLowerCase();
  if (/^[a-z0-9-]+(?:[._=:][a-z0-9-]+)*@[a-z0-9-]+(?:[._=:][a-z0-9-]+)*$/.test(email))
    return email;
  const local = email.split("@")[0] ?? email;
  const cleaned = local.replace(/[^a-z0-9]/g, "").slice(0, 20);
  const hash = createHash("sha1").update(email).digest("hex").slice(0, 8);
  return `${cleaned || "u"}${hash}`.slice(0, 32);
}

function roleOf(item: { path?: string; specialUse?: string; name?: string }): MailFolderRole {
  const special = String(item.specialUse || "").toLowerCase();
  if (specialUseRole[special]) return specialUseRole[special];
  const path = String(item.path || item.name || "").toLowerCase();
  if (path === "inbox" || path.endsWith("/inbox")) return "inbox";
  if (path === "sent mail" || path === "sent") return "sent";
  if (path === "drafts" || path === "draft") return "drafts";
  if (path === "junk" || path === "spam") return "junk";
  if (path === "trash" || path === "deleted items") return "trash";
  if (path === "archive") return "archive";
  return "custom";
}

function encodeMessageId(mailboxId: string, messageId: string) {
  return `${mailboxId}:${messageId}`;
}

function decodeMessageId(id: string) {
  const index = id.indexOf(":");
  if (index <= 0) return { mailboxId: "", messageId: id };
  return { mailboxId: id.slice(0, index), messageId: id.slice(index + 1) };
}

function encodeAttachmentId(mailboxId: string, messageId: string, attachmentId: string) {
  return `${mailboxId}:${messageId}:${attachmentId}`;
}

function decodeAttachmentId(id: string) {
  const parts = id.split(":");
  if (parts.length < 3) return { mailboxId: "", messageId: "", attachmentId: id };
  return {
    mailboxId: parts[0]!,
    messageId: parts[1]!,
    attachmentId: parts.slice(2).join(":"),
  };
}

function fromWildduckAddresses(value: unknown): MailAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") return asAddress(item);
      const email = String(item.address || item.email || "").trim();
      if (!email) return null;
      const name = String(item.name || "").trim();
      return { email, name: name || undefined };
    })
    .filter((item): item is MailAddress => !!item);
}

function fromWildduckMessage(item: any, folder: MailFolder): MailMessage {
  const mailboxId = String(item.mailbox || folder.id);
  const messageId = String(item.id);
  const from = fromWildduckAddresses(item.from)[0] ?? { email: "" };
  return {
    id: encodeMessageId(mailboxId, messageId),
    folderId: mailboxId,
    folder: folder.name,
    subject: item.subject || "（无主题）",
    from,
    to: fromWildduckAddresses(item.to),
    cc: fromWildduckAddresses(item.cc),
    bcc: fromWildduckAddresses(item.bcc),
    snippet: String(item.intro || item.preview || "").replace(/\s+/g, " ").trim().slice(0, 180),
    unread: item.unseen !== false && item.seen !== true,
    starred: !!item.flagged,
    hasAttachments: Array.isArray(item.attachments)
      ? item.attachments.length > 0
      : !!item.attachments,
    sentAt: item.date ? new Date(item.date).toISOString() : null,
    receivedAt: item.idate
      ? new Date(item.idate).toISOString()
      : item.date
        ? new Date(item.date).toISOString()
        : new Date().toISOString(),
    files: Array.isArray(item.attachments)
      ? item.attachments.map((file: any) => ({
          name: file.filename || file.name || "附件",
          size: file.size ?? 0,
        }))
      : undefined,
  };
}

function isWildduckAuthError(status: number, code: string, message: string) {
  return (
    status === 401 ||
    status === 403 ||
    code === "InvalidToken" ||
    /invalidtoken|invalid accesstoken|missing.*token|api密钥不存在|密钥不存在/i.test(
      `${code} ${message}`,
    )
  );
}

function htmlOf(item: any) {
  if (typeof item.html === "string") return item.html;
  if (Array.isArray(item.html)) return item.html.filter((part) => typeof part === "string").join("\n");
  return "";
}

function textOf(item: any, html: string) {
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  return htmlToText(html);
}

export function createHttpWildduck(
  settings: MailSettingsConfig,
  fetchImpl: typeof fetch = fetch,
): StalwartMail {
  const userCache = new Map<string, UserRef>();

  function resolveUrl(path: string) {
    if (!settings.endpoint) fail(400, "尚未配置邮箱服务绑定地址");
    try {
      return new URL(path, settings.endpoint.endsWith("/") ? settings.endpoint : `${settings.endpoint}/`);
    } catch {
      fail(400, "邮箱服务绑定地址无效");
    }
  }

  function accessToken() {
    const token = settings.token.trim();
    if (!token) fail(400, "尚未配置 WildDuck API Token");
    return token;
  }

  async function request(path: string, method = "GET", body?: unknown, accept = "application/json") {
    const token = accessToken();
    const headers: Record<string, string> = {
      Accept: accept,
      "X-Access-Token": token,
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(resolveUrl(path), {
        method,
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(method === "GET" ? 15000 : 30000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const reason = String((error as Error).message || "");
      if (/abort|timeout/i.test(reason)) fail(502, "连接 WildDuck 超时，请检查绑定地址");
      fail(502, "无法连接 WildDuck，请检查绑定地址与网络");
    }
    if (accept !== "application/json") {
      if (!response.ok)
        fail(response.status === 404 ? 404 : 502, `无法下载邮件附件（${response.status}）`);
      const data = Buffer.from(await response.arrayBuffer());
      return {
        name: "附件",
        mime: response.headers.get("content-type") || "application/octet-stream",
        size: data.length,
        data: data.toString("base64"),
      };
    }
    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok || data?.success === false) {
      const code = String(data?.code || "");
      const message = String(data?.error || data?.message || `WildDuck 请求失败（${response.status}）`);
      if (isWildduckAuthError(response.status, code, message))
        fail(400, "WildDuck API 密钥不存在或无效，请填写与绑定地址匹配的 api.accessToken");
      if (response.status === 404 || /notfound/i.test(code)) fail(404, message);
      fail(response.status >= 400 && response.status < 500 ? response.status : 502, message);
    }
    return data;
  }

  async function userOf(account: string): Promise<UserRef> {
    const address = account.includes("@") ? account : `${account}@${settings.domain}`;
    const cached = userCache.get(address);
    if (cached) return cached;
    let id = "";
    try {
      const resolved = await request(`/addresses/resolve/${encodeURIComponent(address)}`);
      id = String(resolved.user || "");
    } catch {
      const resolved = await request(`/users/resolve/${encodeURIComponent(address)}`);
      id = String(resolved.id || resolved.user || "");
    }
    if (!id) fail(404, "邮箱账户不存在");
    const ref = { id, address };
    userCache.set(address, ref);
    return ref;
  }

  function folderFrom(item: any): MailFolder {
    const role = roleOf(item);
    return {
      id: String(item.id),
      name: folderLabels[role] || item.name || item.path || "文件夹",
      role,
      total: item.total ?? 0,
      unread: item.unseen ?? item.unread ?? 0,
    };
  }

  async function foldersOf(userId: string) {
    const data = await request(`/users/${encodeURIComponent(userId)}/mailboxes?counters=true`);
    return (data.results ?? []).map(folderFrom) as MailFolder[];
  }

  async function ensureSpecialFolders(userId: string) {
    const folders = await foldersOf(userId);
    if (!folders.some((item) => item.role === "archive")) {
      try {
        await request(`/users/${encodeURIComponent(userId)}/mailboxes`, "POST", { path: "Archive" });
      } catch {
        /* ignore */
      }
      return foldersOf(userId);
    }
    return folders;
  }

  async function deliverLocally(
    from: string,
    recipients: MailAddress[],
    draft: {
      to: MailAddress[];
      cc: MailAddress[];
      bcc: MailAddress[];
      subject: string;
      text: string;
      html?: string;
      attachments?: Array<{ name: string; mime: string; data: string }>;
    },
  ) {
    const seen = new Set<string>();
    for (const recipient of recipients) {
      const email = recipient.email.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      let userId = "";
      try {
        const resolved = await request(`/addresses/resolve/${encodeURIComponent(email)}`);
        userId = String(resolved.user || "");
      } catch {
        continue;
      }
      if (!userId) continue;
      const folders = await foldersOf(userId);
      const inbox = folders.find((item) => item.role === "inbox");
      if (!inbox) continue;
      try {
        await request(`/users/${encodeURIComponent(userId)}/mailboxes/${encodeURIComponent(inbox.id)}/messages`, "POST", {
          from: { address: from },
          to: draft.to.map((item) => ({ name: item.name, address: item.email })),
          cc: draft.cc.map((item) => ({ name: item.name, address: item.email })),
          bcc: draft.bcc.map((item) => ({ name: item.name, address: item.email })),
          subject: draft.subject,
          text: draft.text,
          html: draft.html || undefined,
          unseen: true,
          attachments: (draft.attachments ?? []).map((item) => ({
            filename: item.name,
            contentType: item.mime,
            encoding: "base64",
            content: item.data,
          })),
        });
      } catch {
        /* remote addresses stay in the outbound queue */
      }
    }
  }

  async function folderById(userId: string, folderId?: string) {
    const folders = await ensureSpecialFolders(userId);
    if (folderId) {
      const folder = folders.find((item) => item.id === folderId);
      if (!folder) fail(404, "邮件文件夹不存在");
      return { folder, folders };
    }
    const inbox = folders.find((item) => item.role === "inbox") ?? folders[0];
    if (!inbox) fail(404, "邮件文件夹不存在");
    return { folder: inbox, folders };
  }

  async function locateMessage(userId: string, id: string) {
    const decoded = decodeMessageId(id);
    if (decoded.mailboxId) return decoded;
    const folders = await foldersOf(userId);
    for (const folder of folders) {
      try {
        await request(
          `/users/${encodeURIComponent(userId)}/mailboxes/${encodeURIComponent(folder.id)}/messages/${encodeURIComponent(decoded.messageId)}`,
        );
        return { mailboxId: folder.id, messageId: decoded.messageId };
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
    fail(404, "邮件不存在");
  }

  async function messageDetail(userId: string, mailboxId: string, messageId: string, markSeen = false) {
    const query = markSeen ? "?markAsSeen=true" : "";
    const item = await request(
      `/users/${encodeURIComponent(userId)}/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}${query}`,
    );
    const { folders } = await folderById(userId, mailboxId);
    const folder = folders.find((entry) => entry.id === mailboxId) ?? folders[0]!;
    const html = htmlOf(item);
    const text = textOf(item, html);
    const attachments = (Array.isArray(item.attachments) ? item.attachments : []).map((file: any) => ({
      id: encodeAttachmentId(mailboxId, messageId, String(file.id)),
      name: file.filename || file.name || "附件",
      mime: file.contentType || file.mime || "application/octet-stream",
      size: file.size ?? 0,
    }));
    return {
      ...fromWildduckMessage(item, folder),
      unread: markSeen ? false : fromWildduckMessage(item, folder).unread,
      text,
      html,
      attachments,
      inReplyTo: item.inReplyTo ?? null,
    } satisfies MailMessageDetail;
  }

  const self: StalwartMail = {
    async testConnection() {
      try {
        const data = await request("/health");
        return { ok: true as const, version: String(data.version || "wildduck") };
      } catch {
        await request("/users?limit=1");
        return { ok: true as const, version: "wildduck" };
      }
    },
    async ensureDomain(domain) {
      try {
        await request("/dkim", "POST", { domain, selector: "wd" });
      } catch (error) {
        const message = String((error as Error).message || "");
        if (!/exists|duplicate|already/i.test(message) && (error as { status?: number }).status !== 400)
          return;
      }
    },
    async createAccount({ name, address, secret }) {
      const username = usernameOf(address);
      try {
        const created = await request("/users", "POST", {
          username,
          password: secret,
          address,
          name: name || address,
          hashedPassword: false,
          allowUnsafe: true,
        });
        const id = String(created.id || created.user || "");
        if (id) userCache.set(address, { id, address });
      } catch (error) {
        const message = String((error as Error).message || "");
        if (!/exists|taken|already/i.test(message) && (error as { status?: number }).status !== 409)
          throw error;
        const user = await userOf(address);
        await request(`/users/${encodeURIComponent(user.id)}`, "PUT", {
          password: secret,
          hashedPassword: false,
          allowUnsafe: true,
        });
      }
      const user = await userOf(address);
      await ensureSpecialFolders(user.id);
      return { id: user.id };
    },
    bindAccount({ address, userId }) {
      const email = address.trim().toLowerCase();
      if (!userId) return;
      userCache.set(email, { id: userId, address: email });
    },
    async resolveAccount(address) {
      const user = await userOf(address);
      return { id: user.id };
    },
    async updateAccount({ userId, address, name }) {
      const email = address.trim().toLowerCase();
      try {
        await request(`/users/${encodeURIComponent(userId)}`, "PUT", {
          address: email,
          name: name || email,
        });
      } catch {
        await request(`/users/${encodeURIComponent(userId)}/addresses`, "POST", {
          address: email,
          main: true,
        });
      }
      for (const [key, value] of userCache)
        if (value.id === userId) userCache.delete(key);
      userCache.set(email, { id: userId, address: email });
    },
    async deleteAccount(name) {
      try {
        const user = await userOf(name);
        await request(`/users/${encodeURIComponent(user.id)}`, "DELETE");
        userCache.delete(user.address);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    },
    async listFolders(account) {
      const user = await userOf(account);
      return ensureSpecialFolders(user.id);
    },
    async createFolder(account, name) {
      const user = await userOf(account);
      const created = await request(`/users/${encodeURIComponent(user.id)}/mailboxes`, "POST", {
        path: name.trim() || "新文件夹",
      });
      const id = String(created.id || created.mailbox || "");
      if (!id) fail(502, "无法在 WildDuck 创建文件夹");
      return { id, name: name.trim() || "新文件夹", role: "custom", total: 0, unread: 0 };
    },
    async renameFolder(account, folderId, name) {
      const user = await userOf(account);
      const folder = (await folderById(user.id, folderId)).folder;
      if (folder.role !== "custom") fail(400, "系统文件夹不能改名");
      await request(
        `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(folderId)}`,
        "PUT",
        { path: name.trim() || folder.name },
      );
      return { ...folder, name: name.trim() || folder.name };
    },
    async deleteFolder(account, folderId) {
      const user = await userOf(account);
      const folder = (await folderById(user.id, folderId)).folder;
      if (folder.role !== "custom") fail(400, "系统文件夹不能删除");
      await request(
        `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(folderId)}`,
        "DELETE",
      );
    },
    async listMessages(account, query = {}) {
      const user = await userOf(account);
      const { folder, folders } = await folderById(user.id, query.folderId);
      const limit = Math.min(100, query.limit ?? 30);
      const offset = query.offset ?? 0;
      const page = Math.floor(offset / limit) + 1;
      const params = new URLSearchParams({
        limit: String(limit),
        page: String(page),
      });
      if (query.unread === true) params.set("unseen", "true");
      if (query.unread === false) params.set("unseen", "false");
      if (query.starred) params.set("flagged", "true");
      if (query.q) params.set("query", query.q);
      const data = await request(
        `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(folder.id)}/messages?${params}`,
      );
      const folderName = (id: string) => folders.find((item) => item.id === id)?.name ?? folder.name;
      const items = (data.results ?? []).map((item: any) => {
        const mailboxId = String(item.mailbox || folder.id);
        const current = folders.find((entry) => entry.id === mailboxId) ?? {
          ...folder,
          id: mailboxId,
          name: folderName(mailboxId),
        };
        return fromWildduckMessage(item, current);
      });
      const total = data.total ?? items.length;
      return {
        items,
        total,
        unread: items.filter((item: MailMessage) => item.unread).length,
        nextOffset: offset + items.length < total ? offset + items.length : null,
      };
    },
    async getMessage(account, id) {
      const user = await userOf(account);
      const located = await locateMessage(user.id, id);
      return messageDetail(user.id, located.mailboxId, located.messageId, true);
    },
    async sendMessage(account, draft) {
      const to = requireAddresses(draft.to, "收件人");
      const cc = (draft.cc ?? []).length ? requireAddresses(draft.cc!, "抄送") : [];
      const bcc = (draft.bcc ?? []).length ? requireAddresses(draft.bcc!, "密送") : [];
      const user = await userOf(account);
      const payload: Record<string, unknown> = {
        from: { address: user.address },
        to: to.map((item) => ({ name: item.name, address: item.email })),
        cc: cc.map((item) => ({ name: item.name, address: item.email })),
        bcc: bcc.map((item) => ({ name: item.name, address: item.email })),
        subject: draft.subject.trim() || "（无主题）",
        text: draft.text?.trim() || htmlToText(draft.html ?? ""),
        html: draft.html || undefined,
        attachments: (draft.attachments ?? []).map((item) => ({
          filename: item.name,
          contentType: item.mime,
          encoding: "base64",
          content: item.data,
        })),
      };
      if (draft.inReplyTo) {
        const located = await locateMessage(user.id, draft.inReplyTo);
        payload.reference = {
          mailbox: located.mailboxId,
          id: located.messageId,
          action: "reply",
        };
      }
      const submitted = await request(`/users/${encodeURIComponent(user.id)}/submit`, "POST", payload);
      const message = submitted.message ?? submitted;
      const mailboxId = String(message.mailbox || "");
      const messageId = String(message.id || "");
      if (!mailboxId || !messageId) fail(502, "WildDuck 未返回已发送邮件");
      const text = String(payload.text || "");
      await deliverLocally(user.address, [...to, ...cc, ...bcc], {
        to,
        cc,
        bcc,
        subject: String(payload.subject),
        text,
        html: draft.html,
        attachments: draft.attachments,
      });
      if (draft.draftId) {
        try {
          await self.deleteMessage(account, draft.draftId, true);
        } catch {
          /* ignore */
        }
      }
      return messageDetail(user.id, mailboxId, messageId);
    },
    async saveReceipt(account, receipt) {
      const user = await userOf(account);
      const folders = await ensureSpecialFolders(user.id);
      const inbox = folders.find((item) => item.role === "inbox");
      if (!inbox) fail(404, "邮件文件夹不存在");
      const created = await request(
        `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(inbox.id)}/messages`,
        "POST",
        {
          from: { name: "邮件回执", address: user.address },
          to: [{ address: user.address }],
          subject: receipt.subject,
          text: receipt.text,
          html: receipt.html || undefined,
          unseen: true,
        },
      );
      const messageId = String(created.id || created.message?.id || "");
      if (!messageId) fail(502, "无法保存发送回执");
      return messageDetail(user.id, inbox.id, messageId);
    },
    async saveDraft(account, draft) {
      const user = await userOf(account);
      const folders = await ensureSpecialFolders(user.id);
      const drafts = folders.find((item) => item.role === "drafts");
      if (!drafts) fail(502, "WildDuck 未提供草稿箱");
      const payload: Record<string, unknown> = {
        from: { address: user.address },
        to: (draft.to ?? []).map((email) => ({ address: asAddress(email).email, name: asAddress(email).name })),
        cc: (draft.cc ?? []).map((email) => ({ address: asAddress(email).email, name: asAddress(email).name })),
        bcc: (draft.bcc ?? []).map((email) => ({ address: asAddress(email).email, name: asAddress(email).name })),
        subject: draft.subject.trim() || "（无主题）",
        text: draft.text?.trim() || htmlToText(draft.html ?? ""),
        html: draft.html || undefined,
        isDraft: true,
        uploadOnly: true,
        mailbox: drafts.id,
        attachments: (draft.attachments ?? []).map((item) => ({
          filename: item.name,
          contentType: item.mime,
          encoding: "base64",
          content: item.data,
        })),
      };
      const submitted = await request(`/users/${encodeURIComponent(user.id)}/submit`, "POST", payload);
      const message = submitted.message ?? submitted;
      const mailboxId = String(message.mailbox || drafts.id);
      const messageId = String(message.id || "");
      if (!messageId) fail(502, "无法保存草稿");
      if (draft.draftId && draft.draftId !== encodeMessageId(mailboxId, messageId)) {
        try {
          await self.deleteMessage(account, draft.draftId, true);
        } catch {
          /* ignore */
        }
      }
      return messageDetail(user.id, mailboxId, messageId);
    },
    async updateMessage(account, id, patch) {
      const user = await userOf(account);
      const located = await locateMessage(user.id, id);
      const body: Record<string, unknown> = {};
      if (patch.unread != null) body.seen = !patch.unread;
      if (patch.starred != null) body.flagged = patch.starred;
      if (patch.folderId) body.moveTo = patch.folderId;
      await request(
        `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(located.mailboxId)}/messages/${encodeURIComponent(located.messageId)}`,
        "PUT",
        body,
      );
      const mailboxId = patch.folderId || located.mailboxId;
      return messageDetail(user.id, mailboxId, located.messageId);
    },
    async deleteMessage(account, id, permanent) {
      const user = await userOf(account);
      const located = await locateMessage(user.id, id);
      const folders = await ensureSpecialFolders(user.id);
      const trash = folders.find((item) => item.role === "trash");
      const inTrash = trash && located.mailboxId === trash.id;
      if (permanent || !trash || inTrash) {
        await request(
          `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(located.mailboxId)}/messages/${encodeURIComponent(located.messageId)}`,
          "DELETE",
        );
        return;
      }
      await request(
        `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(located.mailboxId)}/messages/${encodeURIComponent(located.messageId)}`,
        "PUT",
        { moveTo: trash.id },
      );
    },
    async searchMessages(account, query) {
      const page = await self.listMessages(account, { q: query, limit: 50 });
      return page.items;
    },
    async getAttachment(account, attachmentId) {
      const user = await userOf(account);
      const decoded = decodeAttachmentId(attachmentId);
      if (!decoded.mailboxId || !decoded.messageId) fail(404, "附件不存在");
      const blob = await request(
        `/users/${encodeURIComponent(user.id)}/mailboxes/${encodeURIComponent(decoded.mailboxId)}/messages/${encodeURIComponent(decoded.messageId)}/attachments/${encodeURIComponent(decoded.attachmentId)}`,
        "GET",
        undefined,
        "*/*",
      );
      return blob as { name: string; mime: string; size: number; data: string };
    },
  };
  return self;
}
