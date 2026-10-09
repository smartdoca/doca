import type { AIProgress } from "@core/modules/ai/progress.js";
import type { DeliveryReview } from "./delivery.js";
import type { ImageBatch } from "./image-batch.js";
import type { AIContinuationState } from "./continuations.js";
export type AICheckpoint = {
  modelId: string;
  messages: any[];
  artifacts: string[];
  stage: "execute" | "review";
  round: number;
  feedback?: DeliveryReview;
  plan?: AIProgress["plan"];
  imageBatch?: ImageBatch;
  continuations?: AIContinuationState;
};
// Only complete assistant/tool exchanges are resumable. Never persist partial JSON
// as executable input, and never repeat an outstanding external operation automatically.
export function completeExchanges(messages: any[]): boolean {
  const calls = new Set<string>(),
    results = new Set<string>();
  for (const message of messages) {
    if (
      !["assistant", "tool"].includes(message.role) ||
      !Array.isArray(message.content)
    )
      return false;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result") results.add(part.toolCallId);
      if (part.type === "file" || part.type === "image") return false;
    }
  }
  return messages.length > 0 && [...calls].every((id) => results.has(id));
}

/** Persist source IDs and tool receipts, not copies of every bitmap in every step. */
export function checkpointMessages(messages: any[]) {
  const withoutPixels = (output: any) => {
    if (output?.type !== "content" || !Array.isArray(output.value)) return output;
    const values = output.value.filter((part: any) => !["media", "file"].includes(part.type));
    if (values.length === output.value.length) return output;
    return { ...output, value: [...values, { type: "text", text: "图像像素未复制进检查点；来源、文件与 referenceImageId 仍然有效。需要看图时调用 attachment_read/file_read，生成结果用 image_show，无需用户重传。" }] };
  };
  return messages.map(message => !Array.isArray(message.content) ? message : ({ ...message, content: message.content.map((part: any) => {
    // Mastra attaches modelOutput to both the call and its result.
    if (part.type !== "tool-result" && part.type !== "tool-call") return part;
    const modelOutput = part.providerOptions?.mastra?.modelOutput;
    return { ...part, output: withoutPixels(part.output),
      ...(modelOutput ? { providerOptions: { ...part.providerOptions, mastra: { ...part.providerOptions.mastra, modelOutput: withoutPixels(modelOutput) } } } : {}),
    };
  }) }));
}

/** File/image receipts carry IDs too, but they are not editor documents. */
export function recoveredDocumentArtifacts(
  receipts: { id?: string; resourceId?: string; kind?: string }[],
  artifacts: string[] = [],
): string[] {
  const isDocument = (receipt: (typeof receipts)[number]) =>
    receipt.kind === "document" || receipt.kind === "library" ||
    receipt.kind === "image_insert" || (!receipt.kind && !!receipt.resourceId);
  const nonDocuments = new Set(receipts.filter(r => !isDocument(r)).flatMap(r => [r.id, r.resourceId].filter((id): id is string => !!id)));
  return [...new Set([
    ...receipts.filter(isDocument).map(r => r.resourceId ?? r.id),
    ...artifacts,
  ].filter((id): id is string => typeof id === "string" && !!id && !nonDocuments.has(id)))];
}
