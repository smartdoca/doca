import type { FileId } from "@doca/files-capability";
import {
  createValidatedKnowledgeSourceEffect,
  type KnowledgeJsonValue,
  type KnowledgeSourceContext,
  type KnowledgeSourceEffect,
  type KnowledgeSourceReaderMapping,
} from "@doca/knowledge-capability";

export interface MailKnowledgeMailbox {
  readonly id: string;
  readonly externalVersion: string;
  readonly title: string;
  readonly address: string;
  readonly observedAt: string;
  readonly readers: readonly KnowledgeSourceReaderMapping[];
  readonly deleted?: boolean;
}

export interface MailKnowledgeMessage {
  readonly id: string;
  readonly mailboxId: string;
  readonly externalVersion: string;
  readonly title: string;
  readonly text: string;
  readonly from?: string;
  readonly to?: readonly string[];
  readonly receivedAt?: string;
  readonly observedAt: string;
  readonly readers: readonly KnowledgeSourceReaderMapping[];
  readonly fileIds: readonly FileId[];
  readonly metadata?: Readonly<Record<string, KnowledgeJsonValue>>;
  readonly deleted?: boolean;
}

export type MailKnowledgeCursor = {
  readonly cursor: string | null;
};

export interface MailKnowledgeReader {
  getMailbox(
    mailboxId: string,
    context: KnowledgeSourceContext,
  ): Promise<MailKnowledgeMailbox | null>;
  listMailboxes(
    input: { readonly cursor: string | null; readonly limit?: number },
    context: KnowledgeSourceContext,
  ): Promise<{
    readonly items: readonly MailKnowledgeMailbox[];
    readonly cursor: string | null;
  }>;
  listMessages(
    input: {
      readonly mailboxId: string;
      readonly scope: "all" | "starred";
      readonly cursor: string | null;
      readonly limit?: number;
    },
    context: KnowledgeSourceContext,
  ): Promise<{
    readonly items: readonly MailKnowledgeMessage[];
    readonly cursor: string | null;
  }>;
}

export interface MailMessagesKnowledgeConfig {
  readonly mailboxId: string;
  readonly scope: "all" | "starred";
}

export type MailboxesKnowledgeConfig = Record<string, never>;

const mailboxesConfigSchema = {
  id: "doca.mail.mailboxes.knowledge.config.v1",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  parse(input: unknown): MailboxesKnowledgeConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Mailboxes knowledge config must be an object");
    }
    if (Object.keys(input).length) {
      throw new TypeError("Mailboxes knowledge config has no fields");
    }
    return {};
  },
} as const;

const messagesConfigSchema = {
  id: "doca.mail.messages.knowledge.config.v1",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["mailboxId"],
    properties: {
      mailboxId: { type: "string", minLength: 1 },
      scope: { type: "string", enum: ["all", "starred"] },
    },
  },
  parse(input: unknown): MailMessagesKnowledgeConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Mail messages knowledge config must be an object");
    }
    const value = input as { mailboxId?: unknown; scope?: unknown };
    if (typeof value.mailboxId !== "string" || !value.mailboxId.trim()) {
      throw new TypeError("mailboxId is required");
    }
    if (
      value.scope !== undefined &&
      value.scope !== "all" &&
      value.scope !== "starred"
    ) {
      throw new TypeError("scope must be all or starred");
    }
    return {
      mailboxId: value.mailboxId,
      scope: value.scope ?? "all",
    };
  },
} as const;

const mailboxRecord = (mailbox: MailKnowledgeMailbox) => ({
  externalId: mailbox.id,
  externalVersion: mailbox.externalVersion,
  title: mailbox.title,
  payload: {
    kind: "mailbox",
    mailboxId: mailbox.id,
    address: mailbox.address,
  },
  provenance: {
    ownerPlugin: "doca.mail",
    sourceType: "mailboxes",
    externalId: mailbox.id,
    uri: `doca://mail/mailboxes/${encodeURIComponent(mailbox.id)}`,
    observedAt: mailbox.observedAt,
  },
  readers: mailbox.readers,
  fileIds: [] as const,
  ...(mailbox.deleted ? { deleted: true } : {}),
});

const messageRecord = (message: MailKnowledgeMessage) => ({
  externalId: message.id,
  externalVersion: message.externalVersion,
  title: message.title,
  payload: {
    kind: "mail",
    messageId: message.id,
    mailboxId: message.mailboxId,
    title: message.title,
    text: message.text,
    ...(message.from ? { from: message.from } : {}),
    ...(message.to ? { to: message.to } : {}),
    ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
  },
  provenance: {
    ownerPlugin: "doca.mail",
    sourceType: "messages",
    externalId: message.id,
    uri: `doca://mail/messages/${encodeURIComponent(message.id)}`,
    observedAt: message.observedAt,
    parentExternalIds: [message.mailboxId],
  },
  readers: message.readers,
  fileIds: message.fileIds,
  ...(message.deleted ? { deleted: true } : {}),
});

export interface MailKnowledgeSources {
  readonly mailboxes: KnowledgeSourceEffect<
    MailboxesKnowledgeConfig,
    MailKnowledgeCursor
  >;
  readonly messages: KnowledgeSourceEffect<
    MailMessagesKnowledgeConfig,
    MailKnowledgeCursor
  >;
}

export function createMailKnowledgeSources(
  reader: MailKnowledgeReader,
): MailKnowledgeSources {
  const mailboxes = createValidatedKnowledgeSourceEffect<
    MailboxesKnowledgeConfig,
    MailKnowledgeCursor
  >({
    version: 1,
    ownerPlugin: "doca.mail",
    sourceType: "mailboxes",
    configRendererId: "doca.mail.knowledge.mailboxes.settings",
    configSchema: mailboxesConfigSchema,
    async validate({ config }) {
      return { valid: true, config, issues: [] };
    },
    async preview(_input, context) {
      const page = await reader.listMailboxes(
        { cursor: null, limit: 1 },
        context,
      );
      return {
        title: "Mailboxes",
        description: "Mailboxes visible to the source principal",
        estimatedRecords: page.items.length,
        sampleExternalIds: page.items.map((mailbox) => mailbox.id),
      };
    },
    async pull({ cursor, limit }, context) {
      const page = await reader.listMailboxes(
        { cursor: cursor?.cursor.cursor ?? null, limit },
        context,
      );
      return {
        records: page.items.map(mailboxRecord),
        nextCursor: page.cursor ? { cursor: page.cursor } : null,
        done: page.cursor === null,
      };
    },
  });
  const messages = createValidatedKnowledgeSourceEffect<
    MailMessagesKnowledgeConfig,
    MailKnowledgeCursor
  >({
    version: 1,
    ownerPlugin: "doca.mail",
    sourceType: "messages",
    configRendererId: "doca.mail.knowledge.messages.settings",
    configSchema: messagesConfigSchema,
    async validate({ config }, context) {
      const mailbox = await reader.getMailbox(config.mailboxId, context);
      return mailbox
        ? { valid: true, config, issues: [] }
        : {
            valid: false,
            issues: [
              { path: ["mailboxId"], message: "Mailbox is unavailable" },
            ],
          };
    },
    async preview({ config }, context) {
      const mailbox = await reader.getMailbox(config.mailboxId, context);
      if (!mailbox) throw new Error("Mailbox is unavailable");
      const page = await reader.listMessages(
        { ...config, cursor: null, limit: 3 },
        context,
      );
      return {
        title: mailbox.title,
        description: `${config.scope} messages from ${mailbox.address}`,
        estimatedRecords: page.items.length,
        sampleExternalIds: page.items.map((message) => message.id),
      };
    },
    async pull({ config, cursor, limit }, context) {
      const page = await reader.listMessages(
        {
          ...config,
          cursor: cursor?.cursor.cursor ?? null,
          limit,
        },
        context,
      );
      return {
        records: page.items.map(messageRecord),
        nextCursor: page.cursor ? { cursor: page.cursor } : null,
        done: page.cursor === null,
      };
    },
  });
  return Object.freeze({ mailboxes, messages });
}
