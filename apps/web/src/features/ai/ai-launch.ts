import type { AssistantLaunchDraft } from "@smartdoca/plugin-sdk/web";

// Host-owned transient state; prompt contents never enter the URL or localStorage.
let draft: AssistantLaunchDraft | null = null;
const listeners = new Set<() => void>();
export function publishAssistantDraft(value: AssistantLaunchDraft | null) {
  draft = value;
  for (const listener of listeners) listener();
}
export function assistantDraft(
  userId: string | undefined,
  sessionId: string | null,
) {
  return draft && draft.userId === userId && draft.sessionId === sessionId
    ? draft
    : null;
}
export function consumeAssistantDraft(value: AssistantLaunchDraft) {
  if (draft === value) publishAssistantDraft(null);
}
export function subscribeAssistantDraft(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
