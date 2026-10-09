import { defineService } from "./index.js";
import type { JsonObject, JsonValue } from "@smartdoca/plugin-contracts";
import type { PluginRequestContext } from "./platform.js";
export interface PluginAIToolContext extends PluginRequestContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly jobId: string;
  readonly callId: string;
}
export interface PluginAITool {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly approval?: "never" | "policy" | "always";
  execute(input: JsonObject, context: PluginAIToolContext): Promise<JsonValue>;
}
export interface PluginAISkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly formats: readonly string[];
}
export interface AIServiceV1 {
  registerTool(tool: PluginAITool): () => void;
  registerSkill(skill: PluginAISkill): () => void;
}
export const aiServiceToken = defineService<AIServiceV1>("ai.v1");

export type AIContinuationSnapshot = {
  readonly version: 1;
  readonly state:
    "running" | "waiting_input" | "completed" | "failed" | "cancelled";
  /** Changes whenever an actionable result or human decision changes. */
  readonly revision: string;
  readonly summary: string;
  readonly result?: JsonValue;
};
export interface AIContinuationSource {
  readonly id: string;
  readonly pluginId: string;
  /** Recheck current business permission; null means unavailable or denied. */
  read(
    context: PluginRequestContext,
    input: { readonly operationId: string },
  ): Promise<AIContinuationSnapshot | null>;
}
export type AIContinuationInput = {
  readonly sourceId: string;
  readonly operationId: string;
};
export type AIContinuationReceipt = AIContinuationInput & {
  readonly state: "waiting" | "ready";
  readonly snapshot: AIContinuationSnapshot;
};
/** Server-only, installation-scoped continuation registration and notification. */
export interface AIContinuationsServiceV1 {
  registerSource(source: AIContinuationSource): () => void;
  /** Only the authenticated context supplied to a currently executing AI tool is accepted. */
  wait(
    pluginId: string,
    context: PluginAIToolContext,
    input: AIContinuationInput,
  ): Promise<AIContinuationReceipt>;
  /** Call after committing the business result. Replays are safe; the host also reconciles after restart. */
  wake(
    pluginId: string,
    input: AIContinuationInput,
  ): Promise<{ readonly woken: number }>;
}
export const aiContinuationsServiceToken =
  defineService<AIContinuationsServiceV1>("ai.continuations.v1");
