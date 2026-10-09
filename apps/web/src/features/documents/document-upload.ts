import { MAX_ASSET_UPLOAD_BYTES } from "@web/shared/api.js";
import type { MessageValues } from "@doca/i18n";

/** Reject invalid new files before the SDK creates a persisted upload placeholder. */
export function documentUploadProblem(file: { name: string; size: number }): {
  key: "editor.uploadEmpty" | "editor.uploadTooLarge";
  values: MessageValues;
} | null {
  if (!file.size)
    return { key: "editor.uploadEmpty" as const, values: { name: file.name } };
  if (file.size > MAX_ASSET_UPLOAD_BYTES)
    return {
      key: "editor.uploadTooLarge" as const,
      values: { name: file.name, limit: MAX_ASSET_UPLOAD_BYTES / 1024 / 1024 },
    };
  return null;
}
