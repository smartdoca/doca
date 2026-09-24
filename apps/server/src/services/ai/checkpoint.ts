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
