import { aiServiceToken, aiContinuationsServiceToken, type PluginAIToolContext } from "@smartdoca/plugin-sdk/ai";
import { continuationInputSchema, wakeAIContinuations } from "../services/ai/continuations.js";
import type { PluginLifecycleContext } from "@smartdoca/plugin-sdk";
import type { AIContributionHost } from "@doca/ai-host";
import type { AIContributionExecutionContext } from "../services/ai/runner.js";
import { activeActor } from "@core/modules/access/queries.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import type { DB } from "@db/index.js";

export function provideAI(context: PluginLifecycleContext, db: DB, host: AIContributionHost<AIContributionExecutionContext>) {
  const toolContexts = new WeakMap<PluginAIToolContext, { toolId: string; wait: NonNullable<AIContributionExecutionContext["waitForContinuation"]> }>();
  const sources = pluginServices(db).continuations;
  context.provide(aiContinuationsServiceToken, {
    registerSource(source) {
      if (!source.id.startsWith(`${source.pluginId}.`) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(source.id) || source.id.length > 120 || typeof source.read !== "function") throw new Error("Invalid continuation source");
      if (sources.has(source.id)) throw new Error(`Duplicate continuation source: ${source.id}`);
      const value = Object.freeze({ id: source.id, pluginId: source.pluginId, read: source.read.bind(source) });
      sources.set(source.id, value);
      return () => { if (sources.get(source.id) === value) sources.delete(source.id); };
    },
    async wait(pluginId, request, raw) {
      const input = continuationInputSchema.parse(raw), execution = toolContexts.get(request);
      if (!execution || !execution.toolId.startsWith(`${pluginId}.`) || sources.get(input.sourceId)?.pluginId !== pluginId) throw new Error("Continuation must belong to the executing plugin tool");
      request.signal.throwIfAborted();
      return execution.wait(input);
    },
    async wake(pluginId, raw) {
      const input = continuationInputSchema.parse(raw);
      if (!pluginServices(db).continuationsReady) return { woken: 0 };
      if (sources.get(input.sourceId)?.pluginId !== pluginId) throw new Error("Continuation source namespace mismatch");
      return wakeAIContinuations(db, input);
    },
  });
  context.provide(aiServiceToken, {
    registerTool(tool) {
      return host.tools.register({
        id: tool.id, description: tool.description, inputSchema: tool.inputSchema, approval: tool.approval,
        async execute(input, execution) {
          const { actor, jobId } = execution.host;
          await activeActor(db, actor);
          execution.signal.throwIfAborted();
          const current = await db.selectFrom("users").select(["id", "display_name", "public_id", "admin"]).where("id", "=", actor.id).where("status", "=", "active").executeTakeFirst();
          if (!current) throw new Error("Account is unavailable");
          const request: PluginAIToolContext = {
            requestId: execution.callId, callId: execution.callId,
            sessionId: execution.sessionId, turnId: execution.turnId, jobId,
            signal: execution.signal,
            principal: { id: current.id, displayName: current.display_name, publicId: current.public_id ?? "", admin: !!current.admin },
          };
          if (execution.host.waitForContinuation) toolContexts.set(request, { toolId: tool.id, wait: execution.host.waitForContinuation });
          try { return await tool.execute(input, request); }
          finally { toolContexts.delete(request); }
        },
      });
    },
    registerSkill(skill) {
      const registry = pluginServices(db).skills;
      if (registry.has(skill.id)) throw new Error(`Duplicate AI skill: ${skill.id}`);
      registry.set(skill.id, Object.freeze({ ...skill, formats: [...skill.formats] }));
      return () => { registry.delete(skill.id); };
    },
  });
}
