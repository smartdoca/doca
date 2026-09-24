import { createHash, randomUUID } from "node:crypto";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import type { MailboxRecord } from "@core/modules/mail/access.js";
import type { DB, Schema } from "@db/index.js";
import {
  createStorage,
  storageDefaults,
  type StorageRuntime,
} from "../adapters/storage.js";
import type { MailAttachment, MailMessageDetail } from "../adapters/stalwart.js";
import { filePolicy, objectKey } from "./storage-policy.js";
import { registerStoredObject } from "./stored-objects.js";

export async function persistMailAttachments(
  db: DB,
  mailbox: Pick<MailboxRecord, "id" | "owner_id">,
  message: MailMessageDetail,
  options: {
    storage?: StorageRuntime;
    loadData?: (attachment: MailAttachment) => Promise<string | undefined>;
  } = {},
) {
  if (!options.storage || !message.attachments.length) return message.attachments;
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirst();
  if (!profile) return message.attachments;
  const storage = createStorage(options.storage);
  const config = {
    ...storageDefaults,
    ...JSON.parse(profile.config),
    provider: profile.provider,
  };
  const stored: MailAttachment[] = [];
  for (const attachment of message.attachments) {
    const existing = await db
      .selectFrom("file_items")
      .select(["id"])
      .where("parent_type", "=", "system")
      .where("parent_id", "=", `mail:${mailbox.id}`)
      .where("deleted_at", "is", null)
      .where("metadata", "like", `%"attachmentId":"${attachment.id}"%`)
      .executeTakeFirst();
    if (existing) {
      stored.push({ ...attachment, fileId: existing.id });
      continue;
    }
    const data =
      attachment.data ||
      (options.loadData ? await options.loadData(attachment) : undefined);
    if (!data) {
      stored.push(attachment);
      continue;
    }
    const buffer = Buffer.from(data, "base64");
    const mime = attachment.mime || "application/octet-stream";
    const objectId = randomUUID();
    const key = objectKey(objectId, mime);
    await storage.put(config, key, buffer, mime, attachment.name);
    const now = new Date().toISOString();
    const object: Schema["file_storage_objects"] = {
      id: objectId,
      profile_id: profile.id,
      object_key: key,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: buffer.length,
      mime,
      category: filePolicy(mime, buffer.length).category,
      ai_description: null,
      ai_status: "skipped",
      ai_model: null,
      ai_generated_at: null,
      created_at: now,
    };
    const item: Schema["file_items"] = {
      id: randomUUID(),
      owner_id: mailbox.owner_id,
      parent_type: "system",
      parent_id: `mail:${mailbox.id}`,
      storage_object_id: object.id,
      name: attachment.name.slice(0, 255) || "附件",
      mime,
      size: buffer.length,
      metadata: JSON.stringify({
        mailboxId: mailbox.id,
        messageId: message.id,
        attachmentId: attachment.id,
      }),
      ai_description_override: null,
      locked: 1,
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
    };
    await registerStoredObject(db, object);
    await db.insertInto("file_items").values(item).execute();
    await enqueueProjection(db, "search-file", item.id, { fileId: item.id });
    stored.push({ ...attachment, data, fileId: item.id, size: buffer.length });
  }
  return stored;
}
