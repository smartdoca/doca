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

export type AIProgressPhase =
  | "analyzing_request"
  | "waiting_approval"
  | "approval_rejected"
  | "resuming"
  | "waiting_choice"
  | "waiting_access"
  | "waiting_requirements"
  | "plan_ready"
  | "thinking"
  | "answering"
  | "using_tool"
  | "reviewing_delivery"
  | "completed";

export type AIProgressData = Record<string, string | number>;

export type AIProgressEventCode =
  | "checkpoint_resumed"
  | "retry_resumed"
  | "image_saved"
  | "folder_available"
  | "file_available"
  | "local_file_saved"
  | "history_compressing"
  | "history_compressed"
  | "history_compression_failed"
  | "tool_call"
  | "approval_requested"
  | "access_requested"
  | "shrinking_batch"
  | "image_receipt_missing"
  | "folder_receipt_missing"
  | "file_receipt_missing"
  | "secret_receipt_missing"
  | "spreadsheet_image_receipt_missing"
  | "document_receipt_missing"
  | "reviewing_delivery"
  | "review_passed"
  | "review_needs_action";

export type AIProgressDetailCode = "tool_failed_recovering";

export type AIApprovalCode =
  | "download_file"
  | "create_file"
  | "session_document_access"
  | "request_document_read_access"
  | "request_document_edit_access"
  | "update_knowledge_instructions"
  | "update_knowledge_settings"
  | "subscribe_knowledge_source"
  | "curate_knowledge"
  | "configure_knowledge_assistant"
  | "write_knowledge_entry"
  | "review_knowledge_entry"
  | "delete_files"
  | "copy_files"
  | "rename_file"
  | "move_files"
  | "create_folder"
  | "delete_folder"
  | "rename_folder"
  | "copy_folder"
  | "move_folder"
  | "create_documents"
  | "rename_document"
  | "move_document";

export type AIApproval = {
  id: string;
  action: "create" | "move" | "delete" | "access" | "permission_request";
  code: AIApprovalCode;
  data?: AIProgressData;
  resourceId?: string;
  preview?: string;
  state: "pending" | "approved" | "rejected";
  resolvedAt?: string;
};

type AIProgressEventBase = {
  id: string;
  at: string;
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
  status: "loading" | "success" | "error";
};
export type AIProgressEvent = AIProgressEventBase &
  (
    | { kind: "reasoning"; text: string }
    | { kind: "text"; text: string }
    | {
        kind: "tool";
        code: AIProgressEventCode;
        data?: AIProgressData;
        detailCode?: AIProgressDetailCode;
        detailData?: AIProgressData;
      }
    | {
        kind: "status";
        code: AIProgressEventCode;
        data?: AIProgressData;
        detailCode?: AIProgressDetailCode;
        detailData?: AIProgressData;
      }
  );
export type AIProgress = {
  pageState?: { key: string; value: unknown };
  imageGenerationError?: string;
  questions?: { id: string; title: string; options: string[] }[];
  pendingAccess?: { requestId: string; resourceId: string };
  approvals?: AIApproval[];
  events?: AIProgressEvent[];
  phase: AIProgressPhase;
  phaseData?: AIProgressData;
  text: string;
  reasoning: string;
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
    phaseData: patch.phaseData,
    sources: patch.sources,
    plan: patch.plan,
    review: patch.review,
    approvals: patch.approvals,
    questions: patch.questions,
    imageGenerationError: patch.imageGenerationError,
    pendingAccess: patch.pendingAccess,
    pageState: patch.pageState ?? previous?.pageState,
    text: (patch.appendText ? (previous?.text ?? "") : "") + patch.text,
    reasoning:
      (patch.appendReasoning ? (previous?.reasoning ?? "") : "") +
      patch.reasoning,
  };
}
