import {
  PluginContractError,
  validatePluginManifest,
  type DispatchMode,
  type DispatchResult,
  type DocaContext,
  type DocaContributionRegistry,
  type DocaPluginPackage,
  type DocaSystemConfig,
  type DocaPlugin,
  type EffectCleanup,
  type EffectDisposer,
  type EventHandler,
  type EventToken,
  type JsonObject,
  type NonWaterfallDispatchMode,
  type PluginLifecycleContext,
  type PluginManifest,
  type ServiceToken,
  type ContributionPoint,
  type ContributionRecord,
  type WaterfallNext,
} from "@smartdoca/plugin-contracts";
import {
  Context as CordisContext,
  type Fiber as CordisFiber,
} from "@deepseek-ai/cordis";

export { PLUGIN_SDK_VERSION } from "./version.js";
export * from "@smartdoca/plugin-contracts";

const contractIdentifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const contributionIdentifier = /^[A-Za-z0-9][A-Za-z0-9:./_-]*$/;

function assertIdentifier(value: string, kind: string) {
  if (!contractIdentifier.test(value))
    throw new PluginContractError(
      "INVALID_MANIFEST",
      `${kind} must be a stable lowercase dotted or dashed identifier`,
      value || "$",
    );
}

export function plugin(
  packageName: string,
  options: Omit<DocaPluginPackage, "package"> = {},
): DocaPluginPackage {
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(
      packageName,
    )
  )
    throw new TypeError(`Invalid plugin package name: ${packageName}`);
  const targets = options.targets
    ? [...new Set(options.targets)]
    : undefined;
  return Object.freeze({
    package: packageName,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.config === undefined
      ? {}
      : { config: structuredClone(options.config) }),
    ...(targets === undefined ? {} : { targets: Object.freeze(targets) }),
  });
}

export function defineDocaConfig(
  config: DocaSystemConfig,
): DocaSystemConfig {
  const seen = new Set<string>();
  const plugins = config.plugins.map((entry) => {
    if (seen.has(entry.package))
      throw new TypeError(`Duplicate plugin package: ${entry.package}`);
    seen.add(entry.package);
    return plugin(entry.package, entry);
  });
  return Object.freeze({ plugins: Object.freeze(plugins) });
}

export function defineService<T>(id: string): ServiceToken<T> {
  assertIdentifier(id, "service identifier");
  return Object.freeze({ id }) as ServiceToken<T>;
}

export function defineEvent<
  Payload,
  Result = void,
  Mode extends DispatchMode = "emit",
>(id: string, mode: Mode = "emit" as Mode): EventToken<Payload, Result, Mode> {
  assertIdentifier(id, "event identifier");
  if (!["emit", "parallel", "serial", "bail", "waterfall"].includes(mode))
    throw new PluginContractError(
      "INVALID_MANIFEST",
      "unsupported dispatch mode",
      id,
    );
  return Object.freeze({ id, mode }) as EventToken<Payload, Result, Mode>;
}

export function defineContributionPoint<T>(id: string): ContributionPoint<T> {
  assertIdentifier(id, "contribution point identifier");
  return Object.freeze({ id }) as ContributionPoint<T>;
}

interface ContextCore {
  readonly eventModes: Map<string, DispatchMode>;
  nextScopeId: number;
}

interface TrackedEffect {
  active: boolean;
  readonly dispose: () => unknown;
}

export class Context implements DocaContext {
  readonly #native: CordisContext;
  readonly #core: ContextCore;
  readonly #effects: TrackedEffect[] = [];
  readonly #fiber: CordisFiber | undefined;
  readonly #ownsFiber: boolean;
  #state: "active" | "disposing" | "disposed" = "active";
  #disposePromise: Promise<void> | undefined;

  constructor(
    readonly scopeId = "root",
    internal?: {
      native: CordisContext;
      core: ContextCore;
      fiber?: CordisFiber;
      ownsFiber?: boolean;
    },
  ) {
    this.#native = internal?.native ?? new CordisContext();
    this.#core = internal?.core ?? {
      eventModes: new Map(),
      nextScopeId: 0,
    };
    this.#fiber = internal?.fiber;
    this.#ownsFiber = internal?.ownsFiber ?? false;
  }

  get disposed() {
    return this.#state !== "active";
  }

  #assertActive() {
    if (this.#state !== "active")
      throw new PluginContractError(
        "CONTEXT_DISPOSED",
        `context ${this.scopeId} is disposed`,
        this.scopeId,
      );
  }

  #assertReadable() {
    if (this.#state === "disposed")
      throw new PluginContractError(
        "CONTEXT_DISPOSED",
        `context ${this.scopeId} is disposed`,
        this.scopeId,
      );
  }

  #track(dispose: () => unknown): EffectDisposer {
    this.#assertActive();
    const record: TrackedEffect = { active: true, dispose };
    this.#effects.push(record);
    return async () => {
      if (!record.active) return;
      record.active = false;
      await record.dispose();
    };
  }

  effect(setup: () => EffectCleanup | void): EffectDisposer {
    this.#assertActive();
    const dispose = this.#native.fiber.effect(
      () => setup() ?? (() => {}),
      `doca.effect(${this.scopeId})`,
    );
    return this.#track(dispose);
  }

  async effectAsync(
    setup: () => Promise<EffectCleanup | void>,
  ): Promise<EffectDisposer> {
    this.#assertActive();
    const cordisEffect = this.#native.fiber.effect(
      async () => (await setup()) ?? (() => {}),
      `doca.effectAsync(${this.scopeId})`,
    );
    const release = this.#track(cordisEffect);
    await cordisEffect;
    if (this.#state !== "active") {
      await release();
      throw new PluginContractError(
        "CONTEXT_DISPOSED",
        `context ${this.scopeId} was disposed during async effect setup`,
        this.scopeId,
      );
    }
    return release;
  }

  provide<T>(token: ServiceToken<T>, value: T): EffectDisposer {
    this.#assertActive();
    try {
      return this.#track(this.#native.provide(token.id, value));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(`service "${token.id}" has been registered`)
      )
        throw new PluginContractError(
          "DUPLICATE_PROVIDER",
          `service ${token.id} is already provided (${error.message})`,
          token.id,
        );
      throw error;
    }
  }

  inject<T>(token: ServiceToken<T>): T {
    this.#assertReadable();
    const value = this.#native.get(token.id, true) as T | undefined;
    if (value === undefined)
      throw new PluginContractError(
        "MISSING_INJECTION",
        `required service ${token.id} is unavailable`,
        token.id,
      );
    return value;
  }

  injectOptional<T>(token: ServiceToken<T>): T | undefined {
    this.#assertReadable();
    return this.#native.get(token.id, true) as T | undefined;
  }

  has(token: ServiceToken<unknown>) {
    this.#assertReadable();
    return this.#native.get(token.id, true) !== undefined;
  }

  child(scopeId?: string): Context {
    this.#assertActive();
    const child = new Context(
      scopeId ?? `${this.scopeId}.${++this.#core.nextScopeId}`,
      {
        native: this.#native.extend(),
        core: this.#core,
        fiber: this.#fiber,
      },
    );
    this.effect(() => () => child.dispose());
    return child;
  }

  /**
   * Create a Doca scope backed by a live Cordis plugin Fiber.
   * PluginHost uses this for every registered plugin.
   */
  async createFiberScope(scopeId: string): Promise<Context> {
    this.#assertActive();
    const runtime = {
      name: `doca:${scopeId}`,
      apply(_context: CordisContext) {},
    };
    const fiber = this.#native.plugin(runtime);
    await fiber;
    const child = new Context(scopeId, {
      native: fiber.ctx,
      core: this.#core,
      fiber,
      ownsFiber: true,
    });
    this.#track(() => child.dispose());
    return child;
  }

  #assertEventMode(event: EventToken<unknown, unknown, DispatchMode>) {
    const current = this.#core.eventModes.get(event.id);
    if (current && current !== event.mode)
      throw new PluginContractError(
        "INVALID_MANIFEST",
        `event ${event.id} was already defined with ${current} dispatch`,
        event.id,
      );
    this.#core.eventModes.set(event.id, event.mode);
  }

  on<Payload, Result, Mode extends DispatchMode>(
    event: EventToken<Payload, Result, Mode>,
    handler: EventHandler<Payload, Result, Mode>,
  ): EffectDisposer {
    this.#assertActive();
    this.#assertEventMode(event as EventToken<unknown, unknown, DispatchMode>);
    const dispose = (
      this.#native as CordisContext & {
        on(
          name: string,
          listener: (...args: unknown[]) => unknown,
        ): () => unknown;
      }
    ).on(event.id, handler as (...args: unknown[]) => unknown);
    return this.#track(dispose);
  }

  dispatch<Payload, Result>(
    event: EventToken<Payload, Result, "waterfall">,
    payload: Payload,
    next: WaterfallNext<Result>,
  ): Result;
  dispatch<Payload, Result, Mode extends NonWaterfallDispatchMode>(
    event: EventToken<Payload, Result, Mode>,
    payload: Payload,
  ): DispatchResult<Result, Mode>;
  dispatch<Payload, Result>(
    event: EventToken<Payload, Result, DispatchMode>,
    payload: Payload,
    next?: WaterfallNext<Result>,
  ): DispatchResult<Result, DispatchMode> {
    this.#assertReadable();
    this.#assertEventMode(event as EventToken<unknown, unknown, DispatchMode>);
    const native = this.#native as CordisContext &
      Record<DispatchMode, (name: string, ...args: unknown[]) => unknown>;
    if (event.mode === "waterfall") {
      if (!next)
        throw new PluginContractError(
          "INVALID_MANIFEST",
          `waterfall event ${event.id} requires a next continuation`,
          event.id,
        );
      return native.waterfall(event.id, payload, next) as DispatchResult<
        Result,
        DispatchMode
      >;
    }
    return native[event.mode](event.id, payload) as DispatchResult<
      Result,
      DispatchMode
    >;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#state = "disposing";
    this.#disposePromise = (async () => {
      const errors: unknown[] = [];
      for (let index = this.#effects.length - 1; index >= 0; index--) {
        const effect = this.#effects[index]!;
        if (!effect.active) continue;
        effect.active = false;
        try {
          await effect.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (this.#ownsFiber && this.#fiber) {
        try {
          await this.#fiber.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      this.#state = "disposed";
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(
          errors,
          `Failed to dispose context ${this.scopeId}`,
        );
    })();
    return this.#disposePromise;
  }
}

export class ContributionStore {
  readonly #records = new Map<string, ContributionRecord<unknown>>();

  forContext(context: DocaContext, pluginId: string): DocaContributionRegistry {
    assertIdentifier(pluginId, "plugin identifier");
    return new ScopedContributionRegistry(this, context, pluginId);
  }

  register<T>(
    context: DocaContext,
    pluginId: string,
    point: ContributionPoint<T>,
    id: string,
    value: T,
  ): EffectDisposer {
    assertIdentifier(point.id, "contribution point identifier");
    if (!contributionIdentifier.test(id))
      throw new PluginContractError(
        "INVALID_MANIFEST",
        "contribution identifier contains unsupported characters",
        id || "$",
      );
    const key = `${point.id}\u0000${id}`;
    const existing = this.#records.get(key);
    if (existing)
      throw new PluginContractError(
        "CONTRIBUTION_COLLISION",
        `contribution ${point.id}/${id} is already registered by ${existing.pluginId}`,
        `${point.id}.${id}`,
      );
    const record: ContributionRecord<T> = {
      point: point.id,
      id,
      pluginId,
      value,
    };
    this.#records.set(key, record as ContributionRecord<unknown>);
    try {
      return context.effect(() => () => {
        if (this.#records.get(key) === record) this.#records.delete(key);
      });
    } catch (error) {
      this.#records.delete(key);
      throw error;
    }
  }

  get<T>(
    point: ContributionPoint<T>,
    id: string,
  ): ContributionRecord<T> | undefined {
    return this.#records.get(`${point.id}\u0000${id}`) as
      ContributionRecord<T> | undefined;
  }

  list<T>(point: ContributionPoint<T>): readonly ContributionRecord<T>[] {
    return [...this.#records.values()].filter(
      (record) => record.point === point.id,
    ) as ContributionRecord<T>[];
  }
}

class ScopedContributionRegistry implements DocaContributionRegistry {
  constructor(
    readonly store: ContributionStore,
    readonly context: DocaContext,
    readonly pluginId: string,
  ) {}

  register<T>(
    point: ContributionPoint<T>,
    id: string,
    value: T,
  ): EffectDisposer {
    return this.store.register(this.context, this.pluginId, point, id, value);
  }

  get<T>(
    point: ContributionPoint<T>,
    id: string,
  ): ContributionRecord<T> | undefined {
    return this.store.get(point, id);
  }

  list<T>(point: ContributionPoint<T>): readonly ContributionRecord<T>[] {
    return this.store.list(point);
  }
}

export class PluginContext<
  Config extends JsonObject = JsonObject,
> implements PluginLifecycleContext<Config> {
  constructor(
    readonly context: DocaContext,
    readonly manifest: PluginManifest,
    readonly config: Config,
    readonly contributions: DocaContributionRegistry,
  ) {}

  get scopeId() {
    return this.context.scopeId;
  }

  get disposed() {
    return this.context.disposed;
  }

  provide<T>(token: ServiceToken<T>, value: T) {
    return this.context.provide(token, value);
  }

  inject<T>(token: ServiceToken<T>) {
    return this.context.inject(token);
  }

  injectOptional<T>(token: ServiceToken<T>) {
    return this.context.injectOptional(token);
  }

  has(token: ServiceToken<unknown>) {
    return this.context.has(token);
  }

  effect(setup: () => EffectCleanup | void) {
    return this.context.effect(setup);
  }

  effectAsync(setup: () => Promise<EffectCleanup | void>) {
    return this.context.effectAsync(setup);
  }

  child(scopeId?: string) {
    return this.context.child(scopeId);
  }

  on<Payload, Result, Mode extends DispatchMode>(
    event: EventToken<Payload, Result, Mode>,
    handler: EventHandler<Payload, Result, Mode>,
  ) {
    return this.context.on(event, handler);
  }

  dispatch<Payload, Result>(
    event: EventToken<Payload, Result, "waterfall">,
    payload: Payload,
    next: WaterfallNext<Result>,
  ): Result;
  dispatch<Payload, Result, Mode extends NonWaterfallDispatchMode>(
    event: EventToken<Payload, Result, Mode>,
    payload: Payload,
  ): DispatchResult<Result, Mode>;
  dispatch<Payload, Result>(
    event: EventToken<Payload, Result, DispatchMode>,
    payload: Payload,
    next?: WaterfallNext<Result>,
  ): DispatchResult<Result, DispatchMode> {
    if (event.mode === "waterfall")
      return this.context.dispatch(
        event as EventToken<Payload, Result, "waterfall">,
        payload,
        next!,
      );
    return this.context.dispatch(
      event as EventToken<Payload, Result, NonWaterfallDispatchMode>,
      payload,
    );
  }

  dispose() {
    return this.context.dispose();
  }
}

export function definePlugin<Config extends JsonObject = JsonObject>(
  plugin: DocaPlugin<Config>,
): DocaPlugin<Config> {
  const manifest = validatePluginManifest(plugin.manifest);
  const required = plugin.injections?.required ?? [];
  const optional = plugin.injections?.optional ?? [];
  const seen = new Set<string>();
  for (const token of [...required, ...optional]) {
    assertIdentifier(token.id, "service identifier");
    if (seen.has(token.id))
      throw new PluginContractError(
        "INVALID_MANIFEST",
        `service ${token.id} is declared more than once`,
        `${manifest.id}.injections`,
      );
    seen.add(token.id);
  }
  return Object.freeze({ ...plugin, manifest });
}
