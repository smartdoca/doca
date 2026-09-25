import type { DB } from "@db/index.js";

export interface MailBridgeMailbox {
  readonly id: string;
  readonly address: string;
  readonly secret: string;
  readonly backend_user_id: string | null;
  readonly source?: string | null;
}

export interface MailBridgeClient {
  getMessage(
    address: string,
    messageId: string,
    secret: string,
  ): Promise<{
    id: string;
    subject: string;
    from: { name?: string; email: string } | string;
    to: unknown;
    text: string;
    receivedAt?: string;
    attachments: readonly {
      id: string;
      name: string;
      mime: string;
      size: number;
      data?: string;
    }[];
  }>;
  getAttachment(
    address: string,
    attachmentId: string,
    secret: string,
  ): Promise<{ data?: string }>;
  listFolders(
    address: string,
    secret: string,
  ): Promise<readonly { id: string; role?: string }[]>;
  saveDraft(address: string, payload: unknown, secret: string): Promise<{
    id: string;
    subject: string;
  }>;
  sendMessage(address: string, payload: unknown, secret: string): Promise<{
    id: string;
    subject: string;
  }>;
  deleteMessage(
    address: string,
    messageId: string,
    permanent: boolean,
    secret: string,
  ): Promise<unknown>;
  updateMessage(
    address: string,
    messageId: string,
    patch: unknown,
    secret: string,
  ): Promise<{
    id: string;
    subject: string;
  }>;
}

export interface MailRuntimeBridge {
  client(
    db: DB,
    mailbox: MailBridgeMailbox,
    options: {
      fetch?: typeof fetch;
      mail?: { client?: unknown; fetch?: typeof fetch };
    },
  ): Promise<MailBridgeClient>;
  cachedFolders(
    db: DB,
    mailboxId: string,
  ): Promise<readonly { id: string; role?: string }[]>;
  storedMessage(
    db: DB,
    mailboxId: string,
    remoteId: string,
  ): Promise<{
    row: { body_ready?: number | boolean };
    message: {
      id: string;
      subject: string;
      from: { name?: string; email: string } | string;
      to: unknown;
      text: string;
      html: string;
      receivedAt?: string;
      attachments: readonly { id: string; name: string; mime: string; size: number }[];
    };
  } | undefined>;
  indexMessage(db: DB, mailbox: MailBridgeMailbox, message: unknown): Promise<unknown>;
  unindexMessage(db: DB, mailboxId: string, messageId: string): Promise<unknown>;
  persistAttachments(
    mailbox: MailBridgeMailbox & { owner_id?: string },
    message: { attachments: readonly { id: string; data?: string }[] },
    options: {
      files: unknown;
      principalId?: string;
      loadData?: (attachment: { id: string; data?: string }) => Promise<string | undefined>;
    },
  ): Promise<unknown>;
  parseAddresses(value: string): unknown;
}

const bridgeKey = Symbol.for("doca.mail.runtime-bridge");

function bridgeSlot(): { current?: MailRuntimeBridge } {
  const host = globalThis as typeof globalThis & {
    [bridgeKey]?: { current?: MailRuntimeBridge };
  };
  return (host[bridgeKey] ??= {});
}

export function registerMailRuntimeBridge(value: MailRuntimeBridge) {
  const slot = bridgeSlot();
  const previous = slot.current;
  slot.current = value;
  return () => {
    if (slot.current === value) slot.current = previous;
  };
}

export function mailRuntimeBridge(): MailRuntimeBridge {
  const bridge = bridgeSlot().current;
  if (!bridge) throw new Error("邮箱插件未安装");
  return bridge;
}
