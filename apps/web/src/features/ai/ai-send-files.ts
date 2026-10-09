import { api, uploadFile } from "@web/shared/api.js";
import type { ChatFileSnapshot } from "./ai-session-ux.js";

export type SendFile = {
  uid: string;
  filename: string;
  mime: string;
  size: number;
  local?: File;
  preview?: string;
  uploaded?: ChatFileSnapshot & { extractStatus?: "pending" | "ready" | "failed" };
};
export type SendFileProgress = {
  uid: string;
  status: "uploading" | "parsing" | "ready" | "error";
  percent?: number;
  uploaded?: SendFile["uploaded"];
};
type Dependencies = {
  upload: (file: File, signal: AbortSignal, progress: (percent: number) => void) => Promise<NonNullable<SendFile["uploaded"]>>;
  extract: (id: string, signal: AbortSignal) => Promise<{ status: "pending" | "ready" | "failed"; error?: string }>;
  pause: (signal: AbortSignal) => Promise<void>;
};
const defaults: Dependencies = {
  upload: (file, signal, progress) => uploadFile(file, "ai_attachment", undefined, signal, ({ percent }) => progress(percent)),
  extract: (id, signal) => api(`/assets/${id}/extract`, "GET", undefined, signal),
  pause: signal => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 700);
    signal.addEventListener("abort", stop, { once: true });
  }),
};

/** Only called after Send. Uploaded IDs remain on the snapshot for a safe retry. */
export async function prepareSendFiles(
  files: SendFile[],
  signal: AbortSignal,
  update: (progress: SendFileProgress) => void,
  dependencies: Dependencies = defaults,
) {
  const results = await Promise.allSettled(files.map(async file => {
    try {
      signal.throwIfAborted();
      if (!file.uploaded) {
        if (!file.local) throw new Error("upload_body_invalid");
        update({ uid: file.uid, status: "uploading", percent: 0 });
        file.uploaded = await dependencies.upload(file.local, signal, percent =>
          update({ uid: file.uid, status: "uploading", percent }));
      }
      while (file.uploaded.extractStatus === "pending") {
        update({ uid: file.uid, status: "parsing", uploaded: file.uploaded });
        const extract = await dependencies.extract(file.uploaded.id, signal);
        if (extract.status === "pending") {
          await dependencies.pause(signal);
          continue;
        }
        file.uploaded = { ...file.uploaded, extractStatus: extract.status };
        if (extract.status === "failed") throw new Error(extract.error || "upload_parse_failed");
      }
      if (file.uploaded.extractStatus === "failed") throw new Error("upload_parse_failed");
      update({ uid: file.uid, status: "ready", uploaded: file.uploaded });
      return file.uploaded;
    } catch (error) {
      update({ uid: file.uid, status: "error", uploaded: file.uploaded });
      throw error;
    }
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.map(result => (result as PromiseFulfilledResult<NonNullable<SendFile["uploaded"]>>).value);
}
