import { extensionSlots, extensionMatches, type ExtensionCommand, type ExtensionView, type ExtensionPlacement, type ExtensionContext, type ExtensionSlot } from "./extensions.js";
export * from "./extensions.js";
import { validateElementContribution, type PluginElementContribution } from "./editor-elements.js";
export * from "./editor-elements.js";
export type ClientPluginTarget = "web" | "mobile";
export type PluginLocale = "zh" | "en";
export type RegistryDisposer = () => void;

export type RegistryConflictCode =
  | "DUPLICATE_CONTRIBUTION_ID"
  | "DUPLICATE_CONTRIBUTION_PATH"
  | "INVALID_CONTRIBUTION"
  | "EVENT_SEQUENCE_CONFLICT";

export class RegistryConflictError extends Error {
  readonly name = "RegistryConflictError";

  constructor(
    readonly code: RegistryConflictCode,
    message: string,
    readonly contributionId: string,
  ) {
    super(`${contributionId}: ${message}`);
  }
}

export interface ClientPluginManifest {
  readonly pluginId: string;
  readonly version: string;
  readonly targets: readonly ClientPluginTarget[];
  readonly routes?: readonly string[];
  readonly navigation?: readonly string[];
  readonly adminPanels?: readonly string[];
  readonly conversationKinds?: readonly string[];
}

export interface OwnedContribution {
  readonly id: string;
  readonly pluginId: string;
  readonly order?: number;
}

const pluginIdentifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const messageIdentifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const semanticVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function assertClientManifest(
  manifest: ClientPluginManifest,
  target: ClientPluginTarget,
) {
  if (!pluginIdentifier.test(manifest.pluginId))
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      "manifest pluginId must be a stable lowercase dotted or dashed identifier",
      manifest.pluginId,
    );
  if (!semanticVersion.test(manifest.version))
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      "manifest version must be semantic",
      manifest.pluginId,
    );
  if (
    new Set(manifest.targets).size !== manifest.targets.length ||
    !manifest.targets.includes(target)
  )
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      `manifest must declare the ${target} target exactly once`,
      manifest.pluginId,
    );
}

function assertOwnedContribution(contribution: OwnedContribution) {
  if (!pluginIdentifier.test(contribution.pluginId))
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      "pluginId must be a stable lowercase dotted or dashed identifier",
      contribution.id,
    );
  if (
    !messageIdentifier.test(contribution.id) ||
    !contribution.id.startsWith(`${contribution.pluginId}.`)
  )
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      `id must be namespaced by ${contribution.pluginId}`,
      contribution.id,
    );
  if (
    contribution.order !== undefined &&
    !Number.isFinite(contribution.order)
  )
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      "order must be finite",
      contribution.id,
    );
}

function compareContributions(
  left: OwnedContribution,
  right: OwnedContribution,
) {
  return (left.order ?? 0) - (right.order ?? 0) ||
    left.id.localeCompare(right.id);
}

/**
 * A synchronous, effect-owned registry. Registration either succeeds
 * atomically or leaves no record behind; the returned disposer is idempotent.
 */
export class EffectRegistry<T extends OwnedContribution> {
  #revision = 0;
  readonly #listeners = new Set<() => void>();
  readonly snapshot = () => this.#revision;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  #emit() {
    this.#revision++;
    for (const listener of this.#listeners) {
      // Observers cannot prevent atomic registration/disposal or other observers.
      try { listener(); } catch { /* consumer error stays outside registry state */ }
    }
  }
  readonly #byId = new Map<string, T>();
  readonly #byConflictKey = new Map<string, T>();

  constructor(
    readonly point: string,
    readonly conflictKey?: (contribution: T) => string | undefined,
  ) {}

  register(contribution: T): RegistryDisposer {
    assertOwnedContribution(contribution);
    const existing = this.#byId.get(contribution.id);
    if (existing)
      throw new RegistryConflictError(
        "DUPLICATE_CONTRIBUTION_ID",
        `${this.point} id is already registered by ${existing.pluginId}`,
        contribution.id,
      );
    const conflictKey = this.conflictKey?.(contribution);
    const conflicting = conflictKey
      ? this.#byConflictKey.get(conflictKey)
      : undefined;
    if (conflicting)
      throw new RegistryConflictError(
        "DUPLICATE_CONTRIBUTION_PATH",
        `${this.point} key ${conflictKey} is already registered by ${conflicting.pluginId}`,
        contribution.id,
      );
    this.#byId.set(contribution.id, contribution);
    if (conflictKey) this.#byConflictKey.set(conflictKey, contribution);
    this.#emit();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#byId.get(contribution.id) === contribution)
        this.#byId.delete(contribution.id);
      if (
        conflictKey &&
        this.#byConflictKey.get(conflictKey) === contribution
      )
        this.#byConflictKey.delete(conflictKey);
      this.#emit();
    };
  }

  get(id: string): T | undefined {
    return this.#byId.get(id);
  }

  getByConflictKey(key: string): T | undefined {
    return this.#byConflictKey.get(key);
  }

  list(): readonly T[] {
    return [...this.#byId.values()].sort(compareContributions);
  }
}

function registerOwned<T extends OwnedContribution>(
  registry: EffectRegistry<T>,
  contributions: readonly T[] | undefined,
  pluginId: string,
  effects: RegistryDisposer[],
) {
  for (const contribution of contributions ?? []) {
    if (contribution.pluginId !== pluginId)
      throw new RegistryConflictError(
        "INVALID_CONTRIBUTION",
        `contribution owner does not match ${pluginId}`,
        contribution.id,
      );
    effects.push(registry.register(contribution));
  }
}

function normalizeRoutePath(path: string) {
  const clean = path.trim().split(/[?#]/, 1)[0] || "/";
  const prefixed = clean.startsWith("/") ? clean : `/${clean}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : prefixed;
}

function assertRoutePath(path: string, contributionId: string) {
  const normalized = normalizeRoutePath(path);
  if (
    !/^\/(?:[a-z0-9._-]+|:[a-z][A-Za-z0-9]*)(?:\/(?:[a-z0-9._-]+|:[a-z][A-Za-z0-9]*))*$/i.test(
      normalized,
    ) &&
    normalized !== "/"
  )
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      `invalid route path ${path}`,
      contributionId,
    );
  return normalized;
}

export interface RouteMatch {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

function matchRoute(pattern: string, input: string): RouteMatch | undefined {
  const path = normalizeRoutePath(input);
  const patternParts = normalizeRoutePath(pattern).split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index++) {
    const expected = patternParts[index]!;
    const actual = pathParts[index]!;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return { path, params };
}

export interface WebRouteContribution<Context = unknown, View = unknown>
  extends OwnedContribution {
  readonly path: string;
  render(context: Context, match: RouteMatch): View;
}

export interface WebNavigationContribution<Icon = unknown>
  extends OwnedContribution {
  readonly scope: string;
  readonly path: string;
  readonly labelKey: string;
  readonly icon?: Icon;
  readonly entitlement?: string;
}

export interface WebAdminPanelContribution<
  Context = unknown,
  View = unknown,
  Icon = unknown,
> extends OwnedContribution {
  readonly tab: string;
  readonly group: string;
  readonly labelKey: string;
  readonly icon?: Icon;
  render(context: Context): View;
}

export interface WebSettingsFieldContribution<Context = unknown, View = unknown>
  extends OwnedContribution {
  readonly path: string;
  readonly labelKey: string;
  render(context: Context): View;
}

export interface WebAIBlockContribution<Context = unknown, View = unknown>
  extends OwnedContribution {
  readonly kind: string;
  render(payload: unknown, context: Context): View;
}

export interface WebSearchResultContribution<Context = unknown, View = unknown>
  extends OwnedContribution {
  readonly kind: string;
  render(result: unknown, context: Context): View;
}

export type KnowledgeSourceSelection =
  | "document"
  | "file"
  | "folder"
  | "url"
  | "config";

export interface WebKnowledgeSourceContribution<
  Context = unknown,
  View = unknown,
> extends OwnedContribution {
  readonly sourceKind: string;
  /** Plugin catalog key shown on the knowledge-relations page. */
  readonly labelKey?: string;
  /**
   * Host picker used to bind one target.
   * `config` means the plugin renders its own form and calls `context.bind`.
   */
  readonly selection?: KnowledgeSourceSelection;
  render(config: unknown, context: Context): View;
}

export interface WebFilePickerContribution<Context = unknown, View = unknown>
  extends OwnedContribution {
  readonly capability: string;
  render(context: Context): View;
}

export interface PluginMessagesContribution extends OwnedContribution {
  readonly messages: Readonly<Record<PluginLocale, Readonly<Record<string, string>>>>;
}

export interface WebPluginTypes {
  readonly View: unknown;
  readonly Icon: unknown;
  readonly RouteContext: unknown;
  readonly AdminContext: unknown;
  readonly SettingsContext: unknown;
  readonly AIBlockContext: unknown;
  readonly SearchResultContext: unknown;
  readonly KnowledgeSourceContext: unknown;
  readonly FilePickerContext: unknown;
}

export type DefaultWebPluginTypes = {
  readonly View: unknown;
  readonly Icon: unknown;
  readonly RouteContext: unknown;
  readonly AdminContext: unknown;
  readonly SettingsContext: unknown;
  readonly AIBlockContext: unknown;
  readonly SearchResultContext: unknown;
  readonly KnowledgeSourceContext: unknown;
  readonly FilePickerContext: unknown;
};

export interface WebPluginBundle<T extends WebPluginTypes = DefaultWebPluginTypes> {
  readonly manifest: ClientPluginManifest;
  readonly elements?: readonly PluginElementContribution<T["View"]>[];
  readonly commands?: readonly ExtensionCommand[];
  readonly views?: readonly ExtensionView<T["View"]>[];
  readonly placements?: readonly ExtensionPlacement[];
  readonly routes?: readonly WebRouteContribution<
    T["RouteContext"],
    T["View"]
  >[];
  readonly navigation?: readonly WebNavigationContribution<T["Icon"]>[];
  readonly adminPanels?: readonly WebAdminPanelContribution<
    T["AdminContext"],
    T["View"],
    T["Icon"]
  >[];
  readonly settingsFields?: readonly WebSettingsFieldContribution<
    T["SettingsContext"],
    T["View"]
  >[];
  readonly aiBlocks?: readonly WebAIBlockContribution<
    T["AIBlockContext"],
    T["View"]
  >[];
  readonly searchResults?: readonly WebSearchResultContribution<
    T["SearchResultContext"],
    T["View"]
  >[];
  readonly knowledgeSources?: readonly WebKnowledgeSourceContribution<
    T["KnowledgeSourceContext"],
    T["View"]
  >[];
  readonly filePickers?: readonly WebFilePickerContribution<
    T["FilePickerContext"],
    T["View"]
  >[];
  readonly messages?: readonly PluginMessagesContribution[];
}

function validateMessages(contribution: PluginMessagesContribution) {
  const englishKeys = Object.keys(contribution.messages.en).sort();
  const chineseKeys = Object.keys(contribution.messages.zh).sort();
  if (
    englishKeys.length !== chineseKeys.length ||
    englishKeys.some((key, index) => key !== chineseKeys[index])
  )
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      "zh and en dictionaries must contain exactly the same keys",
      contribution.id,
    );
  for (const key of englishKeys) {
    if (
      !messageIdentifier.test(key) ||
      !key.startsWith(`${contribution.pluginId}.`)
    )
      throw new RegistryConflictError(
        "INVALID_CONTRIBUTION",
        `message key ${key} must be a stable key namespaced by ${contribution.pluginId}`,
        contribution.id,
      );
  }
}

function interpolate(message: string, values?: Readonly<Record<string, unknown>>) {
  if (!values) return message;
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key: string) =>
    values[key] === undefined ? `{${key}}` : String(values[key]),
  );
}

function validateExtension(item: ExtensionCommand | ExtensionView, method: unknown) {
  if (!item.title || typeof item.title.zh !== "string" || !item.title.zh.trim() || typeof item.title.en !== "string" || !item.title.en.trim() ||
      !Array.isArray(item.supportedContexts) || !item.supportedContexts.length ||
      item.supportedContexts.some(scope => !["global", "home", "document", "library", "folder", "resources"].includes(scope)) || typeof method !== "function")
    throw new RegistryConflictError("INVALID_CONTRIBUTION", "invalid extension definition", item.id);
}

export class WebPluginRegistry<
  T extends WebPluginTypes = DefaultWebPluginTypes,
> {
  readonly elements = new EffectRegistry<PluginElementContribution<T["View"]>>("web editor element");
  readonly commands = new EffectRegistry<ExtensionCommand>("web command");
  readonly views = new EffectRegistry<ExtensionView<T["View"]>>("web view");
  readonly placements = new EffectRegistry<ExtensionPlacement>("web placement");

  extensions(slot: ExtensionSlot, context: ExtensionContext): readonly ExtensionPlacement[] {
    return this.placements.list().filter(item => item.slot === slot && extensionMatches(item.conditions, context) &&
      (item.commandId ? this.commands.get(item.commandId) : this.views.get(item.viewId!))?.supportedContexts.includes(context.scope));
  }

  readonly routes = new EffectRegistry<
    WebRouteContribution<T["RouteContext"], T["View"]>
  >("web route", (route) =>
    assertRoutePath(route.path, route.id)
  );
  readonly navigation = new EffectRegistry<
    WebNavigationContribution<T["Icon"]>
  >("web navigation", (item) => item.scope);
  readonly adminPanels = new EffectRegistry<
    WebAdminPanelContribution<T["AdminContext"], T["View"], T["Icon"]>
  >("web admin panel", (panel) => panel.tab);
  readonly settingsFields = new EffectRegistry<
    WebSettingsFieldContribution<T["SettingsContext"], T["View"]>
  >("web settings field", (field) => field.path);
  readonly aiBlocks = new EffectRegistry<
    WebAIBlockContribution<T["AIBlockContext"], T["View"]>
  >("web AI block", (block) => block.kind);
  readonly searchResults = new EffectRegistry<
    WebSearchResultContribution<T["SearchResultContext"], T["View"]>
  >("web search result", (result) => result.kind);
  readonly knowledgeSources = new EffectRegistry<
    WebKnowledgeSourceContribution<T["KnowledgeSourceContext"], T["View"]>
  >("web knowledge source", (source) => source.sourceKind);
  readonly filePickers = new EffectRegistry<
    WebFilePickerContribution<T["FilePickerContext"], T["View"]>
  >("web file picker", (picker) => picker.capability);
  readonly messages = new EffectRegistry<PluginMessagesContribution>(
    "web messages",
  );
  readonly #messageOwners = new Map<string, string>();
  readonly #manifests = new Map<string, ClientPluginManifest>();

  register(bundle: WebPluginBundle<T>): RegistryDisposer {
    assertClientManifest(bundle.manifest, "web");
    if (this.#manifests.has(bundle.manifest.pluginId))
      throw new RegistryConflictError(
        "DUPLICATE_CONTRIBUTION_ID",
        "web plugin manifest is already registered",
        bundle.manifest.pluginId,
      );
    const effects: RegistryDisposer[] = [];
    try {
      const pluginId = bundle.manifest.pluginId;
      for (const item of bundle.elements ?? []) {
        try { validateElementContribution(item); } catch {
          throw new RegistryConflictError("INVALID_CONTRIBUTION", "invalid editor element definition", item.id);
        }
      }
      registerOwned(this.elements, bundle.elements, pluginId, effects);
      for (const item of bundle.commands ?? []) validateExtension(item, item.execute);
      for (const item of bundle.views ?? []) validateExtension(item, item.render);
      registerOwned(this.commands, bundle.commands, pluginId, effects);
      registerOwned(this.views, bundle.views, pluginId, effects);
      for (const item of bundle.placements ?? []) {
        const reference = item.commandId ? this.commands.get(item.commandId) : this.views.get(item.viewId!);
        if (!extensionSlots.includes(item.slot) || !!item.commandId === !!item.viewId || !reference || reference.pluginId !== pluginId ||
            (item.presentation && (!!item.commandId || !["dialog", "drawer", "sidebar"].includes(item.presentation))) ||
            (item.conditions?.targets && (!Array.isArray(item.conditions.targets) || item.conditions.targets.some(target => !["web", "mobile"].includes(target)))) ||
            (item.conditions?.resourceKinds && (!Array.isArray(item.conditions.resourceKinds) || item.conditions.resourceKinds.some(kind => typeof kind !== "string"))) ||
            (item.conditions?.formats && (!Array.isArray(item.conditions.formats) || item.conditions.formats.some(format => typeof format !== "string"))) ||
            (item.conditions?.capabilities && (!Array.isArray(item.conditions.capabilities) || item.conditions.capabilities.some(capability => typeof capability !== "string"))))
          throw new RegistryConflictError("INVALID_CONTRIBUTION", "invalid extension placement or reference", item.id);
      }
      registerOwned(this.placements, bundle.placements, pluginId, effects);
      registerOwned(this.routes, bundle.routes, pluginId, effects);
      registerOwned(this.navigation, bundle.navigation, pluginId, effects);
      registerOwned(this.adminPanels, bundle.adminPanels, pluginId, effects);
      registerOwned(
        this.settingsFields,
        bundle.settingsFields,
        pluginId,
        effects,
      );
      registerOwned(this.aiBlocks, bundle.aiBlocks, pluginId, effects);
      registerOwned(
        this.searchResults,
        bundle.searchResults,
        pluginId,
        effects,
      );
      registerOwned(
        this.knowledgeSources,
        bundle.knowledgeSources,
        pluginId,
        effects,
      );
      registerOwned(this.filePickers, bundle.filePickers, pluginId, effects);
      for (const contribution of bundle.messages ?? []) {
        if (contribution.pluginId !== bundle.manifest.pluginId)
          throw new RegistryConflictError(
            "INVALID_CONTRIBUTION",
            `message owner does not match ${bundle.manifest.pluginId}`,
            contribution.id,
          );
        validateMessages(contribution);
        for (const key of Object.keys(contribution.messages.en)) {
          const owner = this.#messageOwners.get(key);
          if (owner)
            throw new RegistryConflictError(
              "DUPLICATE_CONTRIBUTION_ID",
              `message key ${key} is already registered by ${owner}`,
              contribution.id,
            );
        }
        effects.push(this.messages.register(contribution));
        for (const key of Object.keys(contribution.messages.en))
          this.#messageOwners.set(key, contribution.id);
        effects.push(() => {
          for (const key of Object.keys(contribution.messages.en))
            if (this.#messageOwners.get(key) === contribution.id)
              this.#messageOwners.delete(key);
        });
      }
      this.#manifests.set(bundle.manifest.pluginId, bundle.manifest);
      effects.push(() => {
        if (this.#manifests.get(bundle.manifest.pluginId) === bundle.manifest)
          this.#manifests.delete(bundle.manifest.pluginId);
      });
    } catch (error) {
      for (let index = effects.length - 1; index >= 0; index--)
        effects[index]!();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (let index = effects.length - 1; index >= 0; index--)
        effects[index]!();
    };
  }

  manifests(): readonly ClientPluginManifest[] {
    return [...this.#manifests.values()].sort((left, right) =>
      left.pluginId.localeCompare(right.pluginId)
    );
  }

  resolveRoute(
    path: string,
  ):
    | {
        readonly contribution: WebRouteContribution<
          T["RouteContext"],
          T["View"]
        >;
        readonly match: RouteMatch;
      }
    | undefined {
    for (const contribution of this.routes.list()) {
      const match = matchRoute(contribution.path, path);
      if (match) return { contribution, match };
    }
    return undefined;
  }

  translate(
    locale: string | undefined,
    key: string,
    values?: Readonly<Record<string, unknown>>,
  ) {
    const selected: PluginLocale = locale === "zh"
      ? "zh"
      : locale === undefined
        ? "zh"
        : "en";
    for (const contribution of this.messages.list()) {
      const message =
        contribution.messages[selected][key] ?? contribution.messages.en[key];
      if (message !== undefined) return interpolate(message, values);
    }
    return key;
  }
}

export interface MobileRouteContribution<Context = unknown, View = unknown>
  extends OwnedContribution {
  readonly path: string;
  render(context: Context, match: RouteMatch): View;
}

export interface MobileTabContribution<Icon = unknown>
  extends OwnedContribution {
  readonly route: string;
  readonly labelKey: string;
  readonly icon?: Icon;
}

export interface MobilePluginTypes {
  readonly View: unknown;
  readonly Icon: unknown;
  readonly RouteContext: unknown;
  readonly NodeContext: unknown;
  readonly FilePickerContext: unknown;
}

export type DefaultMobilePluginTypes = {
  readonly View: unknown;
  readonly Icon: unknown;
  readonly RouteContext: unknown;
  readonly NodeContext: unknown;
  readonly FilePickerContext: unknown;
};

export interface MobilePluginBundle<
  T extends MobilePluginTypes = DefaultMobilePluginTypes,
> {
  readonly manifest: ClientPluginManifest;
  readonly routes?: readonly MobileRouteContribution<
    T["RouteContext"],
    T["View"]
  >[];
  readonly tabs?: readonly MobileTabContribution<T["Icon"]>[];
  readonly aiNodes?: readonly WebAIBlockContribution<
    T["NodeContext"],
    T["View"]
  >[];
  readonly searchResults?: readonly WebSearchResultContribution<
    T["NodeContext"],
    T["View"]
  >[];
  readonly filePickers?: readonly WebFilePickerContribution<
    T["FilePickerContext"],
    T["View"]
  >[];
  readonly messages?: readonly PluginMessagesContribution[];
}

export class MobilePluginRegistry<
  T extends MobilePluginTypes = DefaultMobilePluginTypes,
> {
  readonly routes = new EffectRegistry<
    MobileRouteContribution<T["RouteContext"], T["View"]>
  >("mobile route", (route) =>
    assertRoutePath(route.path, route.id)
  );
  readonly tabs = new EffectRegistry<MobileTabContribution<T["Icon"]>>(
    "mobile tab",
    (tab) => tab.route,
  );
  readonly aiNodes = new EffectRegistry<
    WebAIBlockContribution<T["NodeContext"], T["View"]>
  >("mobile AI node", (node) => node.kind);
  readonly searchResults = new EffectRegistry<
    WebSearchResultContribution<T["NodeContext"], T["View"]>
  >("mobile search result", (result) => result.kind);
  readonly filePickers = new EffectRegistry<
    WebFilePickerContribution<T["FilePickerContext"], T["View"]>
  >("mobile file picker", (picker) => picker.capability);
  readonly messages = new EffectRegistry<PluginMessagesContribution>(
    "mobile messages",
  );
  readonly #manifests = new Map<string, ClientPluginManifest>();

  register(bundle: MobilePluginBundle<T>): RegistryDisposer {
    assertClientManifest(bundle.manifest, "mobile");
    if (this.#manifests.has(bundle.manifest.pluginId))
      throw new RegistryConflictError(
        "DUPLICATE_CONTRIBUTION_ID",
        "mobile plugin manifest is already registered",
        bundle.manifest.pluginId,
      );
    const effects: RegistryDisposer[] = [];
    try {
      const pluginId = bundle.manifest.pluginId;
      registerOwned(this.routes, bundle.routes, pluginId, effects);
      registerOwned(this.tabs, bundle.tabs, pluginId, effects);
      registerOwned(this.aiNodes, bundle.aiNodes, pluginId, effects);
      registerOwned(
        this.searchResults,
        bundle.searchResults,
        pluginId,
        effects,
      );
      registerOwned(this.filePickers, bundle.filePickers, pluginId, effects);
      for (const contribution of bundle.messages ?? [])
        validateMessages(contribution);
      registerOwned(this.messages, bundle.messages, pluginId, effects);
      this.#manifests.set(bundle.manifest.pluginId, bundle.manifest);
      effects.push(() => {
        if (this.#manifests.get(bundle.manifest.pluginId) === bundle.manifest)
          this.#manifests.delete(bundle.manifest.pluginId);
      });
    } catch (error) {
      for (let index = effects.length - 1; index >= 0; index--)
        effects[index]!();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (let index = effects.length - 1; index >= 0; index--)
        effects[index]!();
    };
  }

  manifests(): readonly ClientPluginManifest[] {
    return [...this.#manifests.values()].sort((left, right) =>
      left.pluginId.localeCompare(right.pluginId)
    );
  }
}

export interface ConversationEvent<Payload = unknown> {
  readonly kind: string;
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: Payload;
  readonly schemaVersion?: number;
  readonly settled?: boolean;
  readonly turnId?: string;
  readonly stepId?: string;
}

export interface ConversationDefinition<
  State = unknown,
  Node = unknown,
> extends OwnedContribution {
  readonly kind: string;
  isStart(event: ConversationEvent): boolean;
  start(event: ConversationEvent): State;
  update(state: State, event: ConversationEvent): State;
  materialize(
    state: State,
    context: {
      readonly key: string;
      readonly events: readonly ConversationEvent[];
    },
  ): Node;
}

export interface MaterializedConversationNode<Node = unknown> {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly settled: boolean;
  readonly definitionId: string;
  readonly value: Node;
}

export interface GenericConversationFact {
  readonly type: "generic-event";
  readonly kind: string;
  readonly id: string;
  readonly events: readonly ConversationEvent[];
}

export type ConversationNode<Node = unknown> =
  | MaterializedConversationNode<Node>
  | MaterializedConversationNode<GenericConversationFact>;

function conversationKey(kind: string, id: string) {
  return `${kind}\u0000${id}`;
}

function assertConversationEvent(event: ConversationEvent) {
  if (!event.kind.trim() || !event.id.trim() || !event.type.trim())
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      "conversation event kind, id and type are required",
      `${event.kind}/${event.id}`,
    );
  if (!Number.isSafeInteger(event.seq) || event.seq < 0)
    throw new RegistryConflictError(
      "INVALID_CONTRIBUTION",
      "conversation event seq must be a non-negative safe integer",
      `${event.kind}/${event.id}`,
    );
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError("conversation events must be JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key])}`
  ).join(",")}}`;
}

/**
 * Stores events by stable (kind,id,seq) and replays each stream from sorted
 * sequence numbers for every projection. Arrival order never affects output.
 */
export class ConversationAssembler<Node = unknown> {
  readonly definitions = new EffectRegistry<
    ConversationDefinition<unknown, Node>
  >("conversation definition", (definition) => definition.kind);
  readonly #streams = new Map<
    string,
    Map<number, ConversationEvent>
  >();

  append(event: ConversationEvent): boolean {
    assertConversationEvent(event);
    const key = conversationKey(event.kind, event.id);
    let stream = this.#streams.get(key);
    if (!stream) {
      stream = new Map();
      this.#streams.set(key, stream);
    }
    const existing = stream.get(event.seq);
    if (existing) {
      if (canonical(existing) === canonical(event)) return false;
      throw new RegistryConflictError(
        "EVENT_SEQUENCE_CONFLICT",
        `seq ${event.seq} already contains a different event`,
        `${event.kind}/${event.id}`,
      );
    }
    stream.set(event.seq, event);
    return true;
  }

  appendAll(events: readonly ConversationEvent[]) {
    for (const event of events) this.append(event);
    return this.snapshot();
  }

  clear(kind?: string, id?: string) {
    if (kind !== undefined && id !== undefined) {
      this.#streams.delete(conversationKey(kind, id));
      return;
    }
    this.#streams.clear();
  }

  snapshot(): readonly ConversationNode<Node>[] {
    const nodes: ConversationNode<Node>[] = [];
    for (const [key, stream] of this.#streams) {
      const events = [...stream.values()].sort(
        (left, right) => left.seq - right.seq,
      );
      if (!events.length) continue;
      const first = events[0]!;
      const last = events.at(-1)!;
      const definition = this.definitions.getByConflictKey(first.kind);
      if (!definition) {
        nodes.push({
          key,
          kind: first.kind,
          id: first.id,
          firstSeq: first.seq,
          lastSeq: last.seq,
          settled: events.some((event) => event.settled === true),
          definitionId: "generic",
          value: Object.freeze({
            type: "generic-event",
            kind: first.kind,
            id: first.id,
            events: Object.freeze(events),
          }),
        });
        continue;
      }
      let state: unknown;
      let started = false;
      for (const event of events) {
        if (!started) {
          if (!definition.isStart(event)) continue;
          state = definition.start(event);
          started = true;
        } else {
          state = definition.update(state, event);
        }
      }
      // Known updates remain pending until their start fact is available.
      if (!started) continue;
      nodes.push({
        key,
        kind: first.kind,
        id: first.id,
        firstSeq: first.seq,
        lastSeq: last.seq,
        settled: events.some((event) => event.settled === true),
        definitionId: definition.id,
        value: definition.materialize(state, {
          key,
          events: Object.freeze(events),
        }),
      });
    }
    return nodes.sort(
      (left, right) =>
        left.firstSeq - right.firstSeq || left.key.localeCompare(right.key),
    );
  }
}

export * from "./navigation.js";
