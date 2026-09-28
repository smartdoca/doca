import type { AIProgress } from "@core/modules/ai/progress.js";
import type { DeliveryReview } from "./delivery.js";
export type AICheckpoint = {
  modelId: string;
  messages: any[];
  artifacts: string[];
  stage: "execute" | "review";
  round: number;
  feedback?: DeliveryReview;
  plan?: AIProgress["plan"];
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
