import {
  PluginContractError,
  satisfiesPluginVersion,
  validatePluginConfig,
  validatePluginManifest,
  type DocaPlugin,
  type JsonObject,
  type PluginLifecycleContext,
  type PluginManifest,
  type PluginRuntimePhase,
} from "@doca/plugin-contracts";
import {
  Context,
  ContributionStore,
  PluginContext,
} from "@doca/plugin-sdk";

export type PluginHostState =
  "idle" | "starting" | "running" | "disposing" | "disposed";

export class PluginLifecycleError extends Error {
  readonly name = "PluginLifecycleError";
  readonly code = "LIFECYCLE_FAILED";

  constructor(
    readonly pluginId: string,
    readonly phase: PluginRuntimePhase,
    options: { cause: unknown },
  ) {
    super(`Plugin ${pluginId} failed during ${phase}`, options);
  }
}

export interface PluginMigrationStore {
  get(pluginId: string): Promise<string | undefined>;
  set(pluginId: string, version: string): Promise<void>;
}

export class MemoryPluginMigrationStore implements PluginMigrationStore {
  readonly #versions = new Map<string, string>();

  async get(pluginId: string) {
    return this.#versions.get(pluginId);
  }

  async set(pluginId: string, version: string) {
    this.#versions.set(pluginId, version);
  }
}

export interface PluginHostOptions {
  readonly context?: Context;
  readonly contributions?: ContributionStore;
  readonly migrations?: PluginMigrationStore;
  readonly sdkVersion?: string;
}

interface RegisteredPlugin {
  readonly plugin: DocaPlugin<JsonObject>;
  readonly manifest: PluginManifest;
  readonly config: JsonObject;
  context?: PluginContext<JsonObject>;
}

const serviceIdentifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export function validatePluginGraph(
  input: readonly PluginManifest[],
  sdkVersion = "0.1.0",
): readonly PluginManifest[] {
  const manifests = input.map((manifest) => validatePluginManifest(manifest));
  const byId = new Map<string, PluginManifest>();
  for (const manifest of manifests) {
    if (
      manifest.sdkRange &&
      !satisfiesPluginVersion(sdkVersion, manifest.sdkRange)
    )
      throw new PluginContractError(
        "INCOMPATIBLE_DEPENDENCY",
        `plugin ${manifest.id} requires Doca SDK ${manifest.sdkRange}, but ${sdkVersion} is installed`,
        `${manifest.id}.sdkRange`,
      );
    if (byId.has(manifest.id))
      throw new PluginContractError(
        "DUPLICATE_PLUGIN",
        `plugin ${manifest.id} is registered more than once`,
        manifest.id,
      );
    byId.set(manifest.id, manifest);
  }
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies ?? []) {
      const installed = byId.get(dependency.id);
      if (!installed) {
        if (dependency.optional) continue;
        throw new PluginContractError(
          "MISSING_DEPENDENCY",
          `plugin ${manifest.id} requires ${dependency.id} ${dependency.range}`,
          `${manifest.id}.dependencies.${dependency.id}`,
        );
      }
      if (!satisfiesPluginVersion(installed.version, dependency.range))
        throw new PluginContractError(
          "INCOMPATIBLE_DEPENDENCY",
          `plugin ${manifest.id} requires ${dependency.id} ${dependency.range}, but ${installed.version} is installed`,
          `${manifest.id}.dependencies.${dependency.id}`,
        );
    }
  }

  const result: PluginManifest[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (manifest: PluginManifest) => {
    const current = state.get(manifest.id);
    if (current === "visited") return;
    if (current === "visiting") {
      const start = stack.indexOf(manifest.id);
      const cycle = [...stack.slice(start), manifest.id];
      throw new PluginContractError(
        "DEPENDENCY_CYCLE",
        `dependency cycle: ${cycle.join(" -> ")}`,
        manifest.id,
      );
    }
    state.set(manifest.id, "visiting");
    stack.push(manifest.id);
    const dependencies = [...(manifest.dependencies ?? [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    for (const dependency of dependencies) {
      const installed = byId.get(dependency.id);
      if (installed) visit(installed);
    }
    stack.pop();
    state.set(manifest.id, "visited");
    result.push(manifest);
  };
  for (const manifest of [...manifests].sort((left, right) =>
    left.id.localeCompare(right.id),
  ))
    visit(manifest);
  return result;
}

export class PluginHost {
  readonly #root: Context;
  readonly #ownsRoot: boolean;
  readonly #migrations: PluginMigrationStore;
  readonly #sdkVersion: string;
  readonly #registered = new Map<string, RegisteredPlugin>();
  readonly #activated: RegisteredPlugin[] = [];
  #state: PluginHostState = "idle";
  #disposePromise: Promise<void> | undefined;

  readonly contributions: ContributionStore;

  constructor(options: PluginHostOptions = {}) {
    this.#root = options.context ?? new Context("plugins");
    this.#ownsRoot = !options.context;
    this.contributions = options.contributions ?? new ContributionStore();
    this.#migrations = options.migrations ?? new MemoryPluginMigrationStore();
    this.#sdkVersion = options.sdkVersion ?? "0.1.0";
  }

  get state() {
    return this.#state;
  }

  get order(): readonly string[] {
    return validatePluginGraph(
      [...this.#registered.values()].map((entry) => entry.manifest),
      this.#sdkVersion,
    ).map((manifest) => manifest.id);
  }

  register<Config extends JsonObject>(
    plugin: DocaPlugin<Config>,
    config?: unknown,
  ): this {
    if (this.#state !== "idle")
      throw new Error("Plugins can only be registered before the host starts");
    const manifest = validatePluginManifest(plugin.manifest);
    if (this.#registered.has(manifest.id))
      throw new PluginContractError(
        "DUPLICATE_PLUGIN",
        `plugin ${manifest.id} is registered more than once`,
        manifest.id,
      );
    const normalizedConfig = validatePluginConfig<Config>(manifest, config);
    const required = plugin.injections?.required ?? [];
    const optional = plugin.injections?.optional ?? [];
    const seen = new Set<string>();
    for (const token of [...required, ...optional]) {
      if (!serviceIdentifier.test(token.id))
        throw new PluginContractError(
          "INVALID_MANIFEST",
          `invalid service identifier ${token.id}`,
          `${manifest.id}.injections`,
        );
      if (seen.has(token.id))
        throw new PluginContractError(
          "INVALID_MANIFEST",
          `service ${token.id} is declared more than once`,
          `${manifest.id}.injections`,
        );
      seen.add(token.id);
    }
    this.#registered.set(manifest.id, {
      plugin: { ...plugin, manifest } as DocaPlugin<JsonObject>,
      manifest,
      config: normalizedConfig,
    });
    return this;
  }

  context(pluginId: string): PluginLifecycleContext | undefined {
    return this.#registered.get(pluginId)?.context;
  }

  async #invoke(
    entry: RegisteredPlugin,
    phase: PluginRuntimePhase,
    operation: () => unknown | Promise<unknown>,
  ) {
    try {
      await operation();
    } catch (cause) {
      throw new PluginLifecycleError(entry.manifest.id, phase, { cause });
    }
  }

  async start(): Promise<void> {
    if (this.#state !== "idle")
      throw new Error(`Plugin host cannot start from ${this.#state}`);
    const orderedManifests = validatePluginGraph(
      [...this.#registered.values()].map((entry) => entry.manifest),
      this.#sdkVersion,
    );
    const ordered = orderedManifests.map((manifest) =>
      this.#registered.get(manifest.id)!,
    );
    this.#state = "starting";
    try {
      for (const entry of ordered) {
        const scope = await this.#root.createFiberScope(
          `plugin.${entry.manifest.id}`,
        );
        entry.context = new PluginContext(
          scope,
          entry.manifest,
          entry.config,
          this.contributions.forContext(scope, entry.manifest.id),
        );
        this.#activated.push(entry);
        if (entry.plugin.discover)
          await this.#invoke(entry, "discover", () =>
            entry.plugin.discover!(entry.context!),
          );
      }
      for (const entry of ordered) {
        for (const token of entry.plugin.injections?.required ?? []) {
          if (!entry.context!.has(token))
            throw new PluginContractError(
              "MISSING_INJECTION",
              `plugin ${entry.manifest.id} requires service ${token.id}`,
              `${entry.manifest.id}.injections.${token.id}`,
            );
        }
      }
      for (const entry of ordered) {
        await this.#invoke(entry, "migrate", async () => {
          const previous = await this.#migrations.get(entry.manifest.id);
          if (previous === entry.manifest.version) return;
          await entry.plugin.migrate?.(entry.context!, previous);
          await this.#migrations.set(entry.manifest.id, entry.manifest.version);
        });
      }
      for (const entry of ordered)
        if (entry.plugin.mount)
          await this.#invoke(entry, "mount", () =>
            entry.plugin.mount!(entry.context!),
          );
      for (const entry of ordered)
        if (entry.plugin.ready)
          await this.#invoke(entry, "ready", () =>
            entry.plugin.ready!(entry.context!),
          );
      this.#state = "running";
    } catch (startError) {
      const errors: unknown[] = [startError];
      try {
        await this.#teardown();
      } catch (cleanupError) {
        if (cleanupError instanceof AggregateError)
          errors.push(...cleanupError.errors);
        else errors.push(cleanupError);
      }
      if (this.#ownsRoot) {
        try {
          await this.#root.dispose();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      this.#state = "disposed";
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(
        errors,
        "Plugin startup failed and rollback reported errors",
      );
    }
  }

  async #teardown() {
    const errors: unknown[] = [];
    for (let index = this.#activated.length - 1; index >= 0; index--) {
      const entry = this.#activated[index]!;
      if (entry.context && entry.plugin.dispose) {
        try {
          await this.#invoke(entry, "dispose", () =>
            entry.plugin.dispose!(entry.context!),
          );
        } catch (error) {
          errors.push(error);
        }
      }
      if (entry.context) {
        try {
          await entry.context.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.#activated.length = 0;
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "Plugin disposal reported errors");
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    if (this.#state === "starting")
      return Promise.reject(
        new Error("Plugin host cannot be disposed while start is in progress"),
      );
    this.#state = "disposing";
    this.#disposePromise = (async () => {
      const errors: unknown[] = [];
      try {
        await this.#teardown();
      } catch (error) {
        if (error instanceof AggregateError) errors.push(...error.errors);
        else errors.push(error);
      }
      if (this.#ownsRoot) {
        try {
          await this.#root.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      this.#state = "disposed";
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(
          errors,
          "Plugin host disposal reported errors",
        );
    })();
    return this.#disposePromise;
  }
}
