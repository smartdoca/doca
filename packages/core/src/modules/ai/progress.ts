export type FolderDelivery = {
  id: string;
  name: string;
  path?: string;
  href: string;
  shared?: boolean;
};
export type FileDelivery = {
  id: string;
  name: string;
  path?: string;
  href?: string;
  downloadUrl: string;
  mime?: string;
  local?: boolean;
};
export type AIProgressEvent = {
  id: string;
  at: string;
  kind: "reasoning" | "text" | "tool" | "status";
  text: string;
  detail?: string;
  resourceId?: string;
  image?: {
    assetId: string;
    filename: string;
    width: number;
    height: number;
    ready: boolean;
  };
  folder?: FolderDelivery;
  file?: FileDelivery;
  mail?: MailDelivery;
  status: "loading" | "success" | "error";
};
export type MailComposeDraft = {
  mailboxId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
};
export type MailDelivery = {
  id: string;
  mailboxId: string;
  subject: string;
  from: string;
  snippet?: string;
  receivedAt?: string;
  href: string;
};
export type MailOpenTarget = {
  mailboxId: string;
  messageId: string;
  href: string;
};
export type AIProgress = {
  mailCompose?: MailComposeDraft;
  mailOpen?: MailOpenTarget;
  pageState?: { key: string; value: unknown };
  imageGenerationError?: string;
  questions?: { id: string; title: string; options: string[] }[];
  pendingAccess?: { requestId: string; resourceId: string };
  approvals?: {
    id: string;
    action: "create" | "move" | "delete" | "access" | "permission_request";
    resourceId?: string;
    title: string;
    detail: string;
    preview?: string;
    state: "pending" | "approved" | "rejected";
    resolvedAt?: string;
  }[];
  events?: AIProgressEvent[];
  phase: string;
  text: string;
  reasoning: string;
  steps: { title: string; status: "loading" | "success" | "error" }[];
  sources: { title: string; url: string; retrievedAt: string }[];
  plan?: {
    goal: string;
    steps: string[];
    criteria: string[];
    mode: "deliver" | "clarify";
  };
  review?: {
    checks?: {
      requirement: string;
      criterionIndex?: number;
      passed: boolean;
      evidence: string;
    }[];
    snapshots?: { resourceId: string; seq: number; epochId: string }[];
    verdict: "pass" | "revise" | "needs_user";
    summary: string;
    round: number;
  };
};
export type AIProgressPatch = Omit<
  AIProgress,
  "text" | "reasoning" | "events"
> & {
  text: string;
  reasoning: string;
  events?: AIProgressEvent[];
  eventOffset?: number;
  appendText: boolean;
  appendReasoning: boolean;
};
export function progressPatch(
  previous: AIProgress | undefined,
  next: AIProgress,
): AIProgressPatch {
  const appendText = !!previous && next.text.startsWith(previous.text);
  const appendReasoning =
    !!previous && next.reasoning.startsWith(previous.reasoning);
  let eventOffset = 0;
  if (previous?.events && next.events) {
    while (
      eventOffset < Math.min(previous.events.length, next.events.length) &&
      JSON.stringify(previous.events[eventOffset]) ===
        JSON.stringify(next.events[eventOffset])
    )
      eventOffset++;
  }
  return {
    ...next,
    ...(next.events
      ? { events: next.events.slice(eventOffset), eventOffset }
      : {}),
    appendText,
    appendReasoning,
    text: appendText ? next.text.slice(previous!.text.length) : next.text,
    reasoning: appendReasoning
      ? next.reasoning.slice(previous!.reasoning.length)
      : next.reasoning,
  };
}
export function applyProgressPatch(
  previous: AIProgress | undefined,
  patch: AIProgressPatch,
): AIProgress {
  return {
    ...(patch.events
      ? {
          events: [
            ...(previous?.events ?? []).slice(0, patch.eventOffset ?? 0),
            ...patch.events,
          ],
        }
      : {}),
    phase: patch.phase,
    steps: patch.steps,
    sources: patch.sources,
    plan: patch.plan,
    review: patch.review,
    approvals: patch.approvals,
    questions: patch.questions,
    imageGenerationError: patch.imageGenerationError,
    pendingAccess: patch.pendingAccess,
    mailCompose: patch.mailCompose ?? previous?.mailCompose,
    mailOpen: patch.mailOpen ?? previous?.mailOpen,
    pageState: patch.pageState ?? previous?.pageState,
    text: (patch.appendText ? (previous?.text ?? "") : "") + patch.text,
    reasoning:
      (patch.appendReasoning ? (previous?.reasoning ?? "") : "") +
      patch.reasoning,
  };
}
