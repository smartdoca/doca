import type { MailboxRecord } from "@core/modules/mail/access.js";
import type { MailAttachment, MailMessageDetail } from "../adapters/stalwart.js";
import {
  stableId,
  type FilesServiceV1,
} from "@doca/files-capability";

export async function persistMailAttachments(
  mailbox: Pick<MailboxRecord, "id" | "owner_id">,
  message: MailMessageDetail,
  options: {
    files: FilesServiceV1;
    principalId?: string;
    loadData?: (attachment: MailAttachment) => Promise<string | undefined>;
  },
) {
  if (!message.attachments.length) return message.attachments;
  const context = { principalId: options.principalId ?? mailbox.owner_id };
  const owner = {
    ownerPlugin: "doca.mail",
    ownerType: "message",
    ownerId: `${mailbox.id}:${message.id}`,
  };
  const existing = await options.files.bindings.list(context, {
    owner,
  });
  const stored: MailAttachment[] = [];
  for (const attachment of message.attachments) {
    const binding = existing.find(
      (candidate) => candidate.role === attachment.id,
    );
    if (binding) {
      stored.push({ ...attachment, fileId: binding.fileId });
      continue;
    }
    const data =
        attachment.data ||
        (options.loadData ? await options.loadData(attachment) : undefined);
    if (!data) {
      stored.push(attachment);
      continue;
    }
    const body = Buffer.from(data, "base64");
    const upload = await options.files.uploads.begin(context, {
      filename: attachment.name,
      mime: attachment.mime,
      size: body.byteLength,
    });
    await options.files.uploads.write(context, {
      uploadId: upload.id,
      offset: 0,
      bytes: body,
    });
    await options.files.uploads.complete(context, {
      uploadId: upload.id,
    });
    const file = await options.files.files.create(context, {
      folderId: null,
      name: attachment.name,
      uploadId: upload.id,
    });
    await options.files.bindings.bind(context, {
      fileId: stableId(file.id, "file"),
      owner: { ...owner, role: attachment.id },
    });
    stored.push({
      ...attachment,
      data,
      fileId: file.id,
      size: body.byteLength,
    });
  }
  return stored;
}
