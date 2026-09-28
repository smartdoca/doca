import { aiServiceToken } from "@smartdoca/plugin-sdk/ai";
import type { PluginLifecycleContext } from "@smartdoca/plugin-sdk";
import type { AIContributionHost } from "@doca/ai-host";
import type { AIContributionExecutionContext } from "../services/ai/runner.js";
import { activeActor } from "@core/modules/access/queries.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import type { DB } from "@db/index.js";

export function provideAI(context: PluginLifecycleContext, db: DB, host: AIContributionHost<AIContributionExecutionContext>) {
  context.provide(aiServiceToken, {
    registerTool(tool) {
      return host.tools.register({
        id: tool.id, description: tool.description, inputSchema: tool.inputSchema, approval: tool.approval,
        async execute(input, execution) {
          const { actor, jobId } = execution.host;
          await activeActor(db, actor);
          execution.signal.throwIfAborted();
          return tool.execute(input, {
            requestId: execution.callId, callId: execution.callId,
            sessionId: execution.sessionId, turnId: execution.turnId, jobId,
            signal: execution.signal,
            principal: { id: actor.id, displayName: actor.display_name, publicId: actor.public_id ?? "", admin: !!actor.admin },
          });
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
