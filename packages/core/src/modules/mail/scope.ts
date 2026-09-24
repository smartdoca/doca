export const mailKnowledgeScopes = ["off", "starred", "all"] as const;
export type MailKnowledgeScope = (typeof mailKnowledgeScopes)[number];

export function normalizeMailKnowledgeScope(value: unknown): MailKnowledgeScope {
  return value === "off" || value === "all" || value === "starred" ? value : "starred";
}

export function mailKnowledgeIncluded(scope: unknown, starred: number) {
  const normalized = normalizeMailKnowledgeScope(scope);
  if (normalized === "all") return true;
  if (normalized === "off") return false;
  return Number(starred) === 1;
}

export function parseMailAttachment(parentId: string, metadata: string | null | undefined) {
  if (!parentId.startsWith("mail:")) return null;
  let parsed: { mailboxId?: unknown; messageId?: unknown } = {};
  try {
    parsed = JSON.parse(metadata || "{}") as { mailboxId?: unknown; messageId?: unknown };
  } catch {
    parsed = {};
  }
  const mailboxId = typeof parsed.mailboxId === "string" && parsed.mailboxId
    ? parsed.mailboxId
    : parentId.slice("mail:".length);
  const messageId = typeof parsed.messageId === "string" ? parsed.messageId : "";
  return { mailboxId, messageId };
}
