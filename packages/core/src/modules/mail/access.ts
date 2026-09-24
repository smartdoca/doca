import { fail } from "../../shared/errors.js";
import { normalizeMailKnowledgeScope } from "./scope.js";
import type { Actor } from "../identity/passwords.js";
import { isExternalMailbox, mailProviderLabel } from "./external.js";
import {
  mailboxRoleRank,
  type MailboxAccessRole,
  type MailboxRole,
} from "./settings.js";

export type MailboxRecord = {
  id: string;
  owner_id: string;
  address: string;
  local_part: string;
  display_name: string;
  kind: "personal" | "shared";
  locked: number;
  secret: string;
  backend_user_id: string;
  source: "internal" | "external";
  provider: string;
  knowledge_scope: "off" | "starred" | "all";
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export function mailboxAccessRole(
  actor: Actor,
  mailbox: MailboxRecord,
  share?: { role: MailboxRole } | null,
): MailboxAccessRole {
  if (mailbox.owner_id === actor.id) return "owner";
  if (share?.role === "admin" || share?.role === "sender" || share?.role === "reader")
    return share.role;
  return "none";
}

export function requireMailboxRole(
  actor: Actor,
  mailbox: MailboxRecord,
  share: { role: MailboxRole } | null | undefined,
  minimum: MailboxAccessRole,
  missing = "邮箱不存在",
) {
  const role = mailboxAccessRole(actor, mailbox, share);
  if (mailboxRoleRank(role) < mailboxRoleRank(minimum))
    fail(minimum === "reader" ? 404 : 403, minimum === "reader" ? missing : "没有这个邮箱的操作权限");
  return role;
}

export function canShareMailbox(mailbox: MailboxRecord) {
  return !mailbox.locked && mailbox.kind === "shared" && !isExternalMailbox(mailbox);
}

export function canDeleteMailbox(mailbox: MailboxRecord) {
  return !mailbox.locked;
}

export function publicMailbox(
  mailbox: MailboxRecord,
  role: MailboxAccessRole,
  extras: Record<string, unknown> = {},
) {
  return {
    id: mailbox.id,
    address: mailbox.address,
    localPart: mailbox.local_part,
    displayName: mailbox.display_name,
    kind: mailbox.kind,
    source: isExternalMailbox(mailbox) ? "external" : "internal",
    provider: isExternalMailbox(mailbox) ? mailbox.provider : "",
    providerLabel: isExternalMailbox(mailbox) ? mailProviderLabel(mailbox.provider) : "",
    locked: !!mailbox.locked,
    shareable: canShareMailbox(mailbox),
    deletable: canDeleteMailbox(mailbox) && role === "owner",
    role,
    knowledgeScope: normalizeMailKnowledgeScope(mailbox.knowledge_scope),
    version: mailbox.version,
    createdAt: mailbox.created_at,
    updatedAt: mailbox.updated_at,
    ...extras,
  };
}
