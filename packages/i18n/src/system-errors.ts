import type { MessageKey } from "./catalogs/en";
import type { MessageValues } from "./translate";

export type SystemErrorReason = {
  code: string;
  data?: Record<string, string | number>;
};

/** Only presentation fields use this envelope. Model-facing errors keep their message. */
export function encodeSystemError(reason: SystemErrorReason): string {
  return JSON.stringify({ type: "system_error", version: 1, ...reason });
}

/** Old display text is deliberately neither recognised nor translated. */
export function decodeSystemError(value: string): SystemErrorReason | undefined {
  if (!value.startsWith("{")) return undefined;
  try {
    const reason = JSON.parse(value);
    if (
      reason?.type !== "system_error" || reason.version !== 1 ||
      typeof reason.code !== "string" || !/^[a-z][a-z0-9_]{0,95}$/.test(reason.code)
    ) return undefined;
    if (reason.data !== undefined && (
      !reason.data || typeof reason.data !== "object" || Array.isArray(reason.data) ||
      Object.values(reason.data).some(value =>
        typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)),
      )
    )) return undefined;
    return { code: reason.code, ...(reason.data ? { data: reason.data } : {}) };
  } catch {
    return undefined;
  }
}

type Translator = (key: MessageKey, values?: MessageValues) => string;

const reasonKeys = {
  history_snapshot_unavailable: "record.snapshot.unavailable",
  book_invalid:"books.error.book_invalid",
  book_forbidden:"books.error.book_forbidden",
  book_not_found:"books.error.book_not_found",
  book_conflict:"books.error.book_conflict",
  book_size_limit:"books.error.book_size_limit",
  book_acceptance:"books.error.book_acceptance",
  book_model_output:"books.error.book_model_output",
  book_model_unavailable:"books.error.book_model_unavailable",
  book_failed:"books.error.book_failed",
  ai_continuation_invalid: "ai.error.continuationInvalid",
  ai_continuation_unavailable: "ai.error.continuationUnavailable",

  image_revision_batch_upgrade_required:"ai.error.image_revision_batch_upgrade_required",
  image_revision_base_stale:"ai.error.image_revision_base_stale",
  image_revision_local_unsupported:"ai.error.image_revision_local_unsupported",
  image_revision_view_required:"ai.error.image_revision_view_required",
  image_revision_input_invalid:"ai.error.image_revision_input_invalid",
  image_reference_file_large: "ai.error.image_reference_file_large",
  image_profile_required: "ai.error.image_profile_required",
  image_profile_invalid: "ai.error.image_profile_invalid",
  image_generate_references: "ai.error.image_generate_references",
  image_reference_limit: "ai.error.image_reference_limit",
  image_mask_unsupported: "ai.error.image_mask_unsupported",
  image_operation_unsupported: "ai.error.image_operation_unsupported",
  image_qwen_endpoint_invalid: "ai.error.image_qwen_endpoint_invalid",
  image_edit_api_missing: "ai.error.image_edit_api_missing",
  image_edit_api_invalid: "ai.error.image_edit_api_invalid",
  image_page_attempt_limit: "ai.error.image_page_attempt_limit",
  image_reference_ignored: "ai.error.image_reference_ignored",
  image_edit_preview_required: "ai.error.image_edit_preview_required",
  image_edit_preview_vision_required: "ai.error.image_edit_preview_vision_required",
  image_session_unavailable: "ai.error.image_session_unavailable",
  image_reference_duplicate: "ai.error.image_reference_duplicate",
  image_reference_invalid_id: "ai.error.image_reference_invalid_id",
  image_reference_unavailable: "ai.error.image_reference_unavailable",
  image_reference_format: "ai.error.image_reference_format",
  image_reference_changed: "ai.error.image_reference_changed",
  image_reference_mismatch: "ai.error.image_reference_mismatch",
  image_reference_decode: "ai.error.image_reference_decode",
  image_protocol_unsupported: "ai.error.image_protocol_unsupported",
  image_size_invalid: "ai.error.image_size_invalid",
  image_seedream_size_small: "ai.error.image_seedream_size_small",
  image_empty_response: "ai.error.image_empty_response",
  image_response_large: "ai.error.image_response_large",
  image_response_invalid: "ai.error.image_response_invalid",
  image_mflux_request_invalid: "ai.error.image_mflux_request_invalid",
  image_base64_missing: "ai.error.image_base64_missing",
  image_connection_failed: "ai.error.image_connection_failed",
  image_size_conflict: "ai.error.image_size_conflict",
  image_model_missing: "ai.error.image_model_missing",
  image_read_only: "ai.error.image_read_only",
  image_references_invalid: "ai.error.image_references_invalid",
  image_export_invalid: "ai.error.image_export_invalid",
  image_edit_original_missing: "ai.error.image_edit_original_missing",
  image_edit_regions_invalid: "ai.error.image_edit_regions_invalid",
  image_reference_crops_invalid: "ai.error.image_reference_crops_invalid",
  image_seedream_size_invalid: "ai.error.image_seedream_size_invalid",
  image_reference_size_unsupported: "ai.error.image_reference_size_unsupported",
  image_recompose_aspect_mismatch: "ai.error.image_recompose_aspect_mismatch",
  image_destination_missing: "ai.error.image_destination_missing",
  image_operation_conflict: "ai.error.image_operation_conflict",
  image_save_failed_retry_blocked: "ai.error.image_save_failed_retry_blocked",
  image_request_already_executed: "ai.error.image_request_already_executed",
  image_generated_unavailable: "ai.error.image_generated_unavailable",
  image_format_unsupported: "ai.error.image_format_unsupported",
  image_generated_decode: "ai.error.image_generated_decode",
  image_file_large: "ai.error.image_file_large",
  image_save_failed: "ai.error.image_save_failed",
  image_result_uncertain: "ai.error.image_result_uncertain",
  model_config_changed: "ai.error.model_config_changed",
  model_context_large: "ai.error.model_context_large",
  model_not_enabled: "ai.error.model_not_enabled",
  model_inference_not_enabled: "ai.error.model_inference_not_enabled",
  image_model_not_enabled: "ai.error.image_model_not_enabled",
  model_embedding_chat: "ai.error.model_embedding_chat",
  model_azure_deployment: "ai.error.model_azure_deployment",
  model_list_unavailable: "ai.error.model_list_unavailable",
  model_list_failed: "ai.error.model_list_failed",
  image_auth_failed: "ai.error.image_auth_failed",
  image_content_rejected: "ai.error.image_content_rejected",
  image_request_failed: "ai.error.image_request_failed",
  image_request_failed_http: "ai.error.image_request_failed_http",
  image_edit_failed: "ai.error.image_edit_failed",
  image_duplicate_save_failed: "ai.error.image_duplicate_save_failed",
  image_duplicate_pending: "ai.error.image_duplicate_pending",
  image_generation_failed: "ai.error.image_generation_failed",
  ai_workflow_failed: "ai.error.ai_workflow_failed",
  ai_workflow_incomplete: "ai.error.ai_workflow_incomplete",
  ai_workflow_connection_interrupted: "ai.error.ai_workflow_connection_interrupted",
  image_review_reinspection_loop: "ai.error.image_review_reinspection_loop",
  image_review_result_invalid: "ai.error.image_review_result_invalid",
  image_candidate_region_invalid: "ai.error.image_candidate_region_invalid",
  image_mask_segment_inspection_required: "ai.error.image_mask_segment_inspection_required",
  image_mask_proposal_binding_mismatch: "ai.error.image_mask_proposal_binding_mismatch",
  ai_worker_interrupted: "ai.error.ai_worker_interrupted",
  ai_task_stopped: "ai.error.ai_task_stopped",
  ai_task_interrupted: "ai.error.ai_task_interrupted",
  ai_task_failed: "ai.error.ai_task_failed",
  ai_worker_failed: "ai.error.ai_worker_failed",
  model_auth_failed: "ai.error.model_auth_failed",
  model_balance_insufficient: "ai.error.model_balance_insufficient",
  model_access_denied: "ai.error.model_access_denied",
  model_not_found: "ai.error.model_not_found",
  model_rate_limited: "ai.error.model_rate_limited",
  model_payload_large: "ai.error.model_payload_large",
  model_output_limit: "ai.error.model_output_limit",
  model_output_parameters: "ai.error.model_output_parameters",
  model_tool_parameters: "ai.error.model_tool_parameters",
  model_request_rejected: "ai.error.model_request_rejected",
  model_provider_unavailable: "ai.error.model_provider_unavailable",
  model_timeout: "ai.error.model_timeout",
  model_response_not_json: "ai.error.model_response_not_json",
  model_connection_failed: "ai.error.model_connection_failed",
} as const satisfies Record<string, MessageKey>;

/** Translate only explicitly coded new system responses, never historical text. */
export function systemErrorMessage(message: string, t: Translator): string {
  const reason = decodeSystemError(message);
  if (!reason) return message;
  const key = Object.hasOwn(reasonKeys, reason.code)
    ? reasonKeys[reason.code as keyof typeof reasonKeys]
    : "ai.error.unknown";
  const label = t(key, reason.data);
  return reason.data?.detail
    ? t("ai.error.with_detail", { message: label, detail: reason.data.detail })
    : label;
}
