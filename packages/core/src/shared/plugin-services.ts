import type { PluginAISkill } from "@doca/plugin-sdk/ai";
import type { DirectorySource, OperationPolicy, PermissionSource } from "@doca/plugin-sdk/platform";
import type { JsonObject } from "@doca/plugin-sdk";
import type { DB } from "../../../db/src/index.js";
import { databaseRuntimeScope } from "../../../db/src/runtime-scope.js";

export interface PluginServices {
  readonly skills: Map<string, PluginAISkill>;
  readonly directories: Map<string, DirectorySource>;
  readonly permissions: Map<string, PermissionSource>;
  readonly policies: Map<string, OperationPolicy>;
}
export function pluginServices(db: DB): PluginServices {
  const scope = databaseRuntimeScope(db);
  let services = scope.get("plugin-services") as PluginServices | undefined;
  if (!services) {
    services = { skills: new Map(), directories: new Map(), permissions: new Map(), policies: new Map() };
    scope.set("plugin-services", services);
  }
  return services;
}
export async function checkOperation(db: DB, principalId: string, action: string, facts: JsonObject = {}) {
  for (const policy of pluginServices(db).policies.values())
    await policy.check({ principalId, action, facts });
}
