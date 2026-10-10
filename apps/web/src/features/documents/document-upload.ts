import { MAX_ASSET_UPLOAD_BYTES, uploadFile } from "@web/shared/api.js";
import type { MessageValues } from "@doca/i18n";
import type { UploadContext, UploadResult } from "@smartdoca/slate";

export async function uploadDocumentResource(
  file: File,
  context: UploadContext,
  resourceId: string,
): Promise<UploadResult> {
  const asset = await uploadFile(
    file,
    "attachment",
    resourceId,
    context.signal,
    (progress) => {
      // Completion follows the server response, after storage and ACL checks.
      context.onProgress(
        progress.total ? Math.min(0.99, progress.loaded / progress.total) : 0,
      );
    },
  );
  context.onProgress(1);
  return {
    path: asset.id,
    name: asset.filename,
    size: asset.size,
    mimeType: asset.mime,
  };
}

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
