import type { AssistantLaunchDraft } from "@smartdoca/plugin-sdk/web";
import type { Session } from "./session";

let pending: {
  account: Session;
  key: string;
  draft: AssistantLaunchDraft;
} | null = null;
export function publishAssistantDraft(
  account: Session,
  key: string,
  draft: AssistantLaunchDraft | null,
) {
  pending = draft ? { account, key, draft } : null;
}
export function consumeAssistantDraft(
  account: Session | null,
  key: string | undefined,
  sessionId: string,
) {
  const value = pending;
  if (
    !value ||
    !account ||
    value.key !== key ||
    value.draft.sessionId !== sessionId ||
    value.account.origin !== account.origin ||
    value.account.token !== account.token
  )
    return null;
  pending = null;
  return value.draft;
}
