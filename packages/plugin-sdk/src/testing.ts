import {
  Context,
  ContributionStore,
  PluginContext,
} from "./index.js";
import {
  validatePluginConfig,
  validatePluginManifest,
  type ContributionPoint,
  type DocaContributionRegistry,
  type DocaPlugin,
  type JsonObject,
  type ServiceToken,
} from "../../plugin-contracts/src/index.js";

export interface PluginContractHarnessOptions {
  readonly config?: JsonObject;
  readonly previousVersion?: string;
  readonly services?: readonly {
    readonly token: ServiceToken<any>;
    readonly value: any;
  }[];
}

export interface PluginContractHarnessResult {
  readonly pluginId: string;
  readonly phases: readonly string[];
  readonly disposed: boolean;
}

/**
 * Runs one plugin through the public lifecycle without application globals.
 * Domain harnesses can provide fake capability Services and inspect them after
 * this function returns. Provider/contribution collisions and missing required
 * injections use the same SDK stores as production.
 */
export async function runPluginContractHarness<
  Config extends JsonObject = JsonObject,
>(
  plugin: DocaPlugin<Config>,
  options: PluginContractHarnessOptions = {},
): Promise<PluginContractHarnessResult> {
  const manifest = validatePluginManifest(plugin.manifest);
  const config = validatePluginConfig<Config>(manifest, options.config);
  const root = new Context();
  const scope = await root.createFiberScope(`testing.${manifest.id}`);
  const store = new ContributionStore();
  const contributions: DocaContributionRegistry = {
    register<T>(point: ContributionPoint<T>, id: string, value: T) {
      return store.register(scope, manifest.id, point, id, value);
    },
    get<T>(point: ContributionPoint<T>, id: string) {
      return store.get(point, id);
    },
    list<T>(point: ContributionPoint<T>) {
      return store.list(point);
    },
  };
  const context = new PluginContext(scope, manifest, config, contributions);
  const phases: string[] = [];
  let lifecycleStarted = false;
  try {
    for (const service of options.services ?? [])
      root.provide(service.token, service.value);
    lifecycleStarted = true;
    phases.push("discover");
    await plugin.discover?.(context);
    for (const token of plugin.injections?.required ?? [])
      context.inject(token);
    phases.push("migrate");
    await plugin.migrate?.(context, options.previousVersion);
    phases.push("mount");
    await plugin.mount?.(context);
    phases.push("ready");
    await plugin.ready?.(context);
  } finally {
    if (lifecycleStarted) {
      phases.push("dispose");
      await plugin.dispose?.(context);
    }
    await scope.dispose();
    await root.dispose();
  }
  return Object.freeze({
    pluginId: manifest.id,
    phases: Object.freeze(phases),
    disposed: scope.disposed,
  });
}
