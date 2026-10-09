import type { MessageKey } from "@doca/i18n";

const codes: Record<string, MessageKey> = {
  upload_count_exceeded: "aiUpload.error.count",
  upload_file_size_exceeded: "aiUpload.error.fileSize",
  upload_total_size_exceeded: "aiUpload.error.totalSize",
  upload_file_empty: "aiUpload.error.empty",
  upload_duplicate_attachments: "aiUpload.error.duplicate",
  upload_format_unsupported: "aiUpload.error.format",
  upload_policy_changed: "aiUpload.error.changed",
  upload_policy_user_missing: "aiUpload.error.userMissing",
};
export function uploadErrorMessage(
  error: unknown,
  t: (key: MessageKey) => string,
) {
  const message = error instanceof Error ? error.message : String(error);
  return codes[message] ? t(codes[message]!) : message;
}
