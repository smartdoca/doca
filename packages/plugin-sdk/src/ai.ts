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
