import type { DB } from "@db/index.js";
import type { AIModel } from "@core/modules/ai/config.js";
import type { StorageRuntime } from "../../adapters/storage.js";
import { waitFileExtract, readExtractImages } from "./file-extract.js";
import { describeExtractedImages } from "./attachments.js";

/** Callers authorize the source before invoking this shared stored-file reader. */
export async function recognizeStoredFile(db: DB, input: {
  objectId: string; filename: string; userId: string; model?: AIModel;
  storage?: StorageRuntime; jobId?: string; fetch?: typeof fetch;
}) {
  const extract = await waitFileExtract(db,input.objectId,input.storage);
  if (extract.status !== "ready") return {status:extract.status, text:"", warning:extract.error || "文件仍在解析，请稍后重试"};
  const images = await readExtractImages(db,input.objectId,extract.parts,input.storage);
  let text = extract.markdown;
  let warning = "";
  if (images.length) {
    if (input.model?.vision) {
      const visual = await describeExtractedImages(db,input.userId,input.model,input.filename,
        images.map(item=>({filename:item.part.filename,mime:item.part.mime,data:item.data})),input.jobId,input.fetch);
      text += `\n\n## 页面与图片识别\n${visual}`;
    } else warning = `有${images.length}张页面或图片尚未识别，需要启用图片理解模型，不能据此宣称全文已读。`;
  }
  return {status: warning ? "partial" : "ready", text, warning, imageCount:images.length};
}
