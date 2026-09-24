export const mailKnowledgeScopes = ["off", "starred", "all"] as const;
export type MailKnowledgeScope = (typeof mailKnowledgeScopes)[number];

export function normalizeMailKnowledgeScope(value: unknown): MailKnowledgeScope {
  return value === "off" || value === "all" || value === "starred" ? value : "starred";
}

export function mailKnowledgeIncluded(scope: unknown, starred: number) {
  const normalized = normalizeMailKnowledgeScope(scope);
  if (normalized === "all") return true;
  if (normalized === "off") return false;
  return starred === 1;
}
