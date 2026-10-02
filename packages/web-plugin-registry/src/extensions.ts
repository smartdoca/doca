import type {
  OwnedContribution,
  ClientPluginTarget,
  PluginLocale,
} from "./index.js";
export const extensionSlots = [
  "global.more",
  "global.leftMore",
  "home.cards",
  "home.actions",
  "document.toolbar",
  "document.menu",
  "document.sidebar",
  "document.status",
  "library.toolbar",
  "library.nodeMenu",
  "folder.toolbar",
  "folder.rowMenu",
  "resource.bulkActions",
  "resource.details",
] as const;
export type ExtensionSlot = (typeof extensionSlots)[number];
export type ExtensionScope =
  "global" | "home" | "document" | "library" | "folder" | "resources";
export type ExtensionPresentation = "dialog" | "drawer" | "sidebar";
export interface ExtensionResource {
  readonly id: string;
  readonly kind: string;
  readonly format?: string;
  readonly title?: string;
  readonly role?: string;
}
export interface ExtensionContext {
  readonly scope: ExtensionScope;
  readonly target: ClientPluginTarget;
  readonly locale: PluginLocale;
  readonly resource?: ExtensionResource;
  readonly resources?: readonly ExtensionResource[];
  readonly capabilities: readonly string[];
  readonly signal: AbortSignal;
}
export interface ExtensionCommand extends OwnedContribution {
  readonly title: { readonly zh: string; readonly en: string };
  readonly supportedContexts: readonly ExtensionScope[];
  execute(context: ExtensionContext): void | Promise<void>;
}
export interface ExtensionView<View = unknown> extends OwnedContribution {
  readonly title: { readonly zh: string; readonly en: string };
  readonly supportedContexts: readonly ExtensionScope[];
  render(context: ExtensionContext): View;
}
export interface ExtensionConditions {
  readonly targets?: readonly ClientPluginTarget[];
  readonly resourceKinds?: readonly string[];
  readonly formats?: readonly string[];
  readonly capabilities?: readonly string[];
}
export type ExtensionPlacement = OwnedContribution & {
  readonly slot: ExtensionSlot;
  readonly conditions?: ExtensionConditions;
} & (
    | {
        readonly commandId: string;
        readonly viewId?: never;
        readonly presentation?: never;
      }
    | {
        readonly viewId: string;
        readonly commandId?: never;
        readonly presentation?: ExtensionPresentation;
      }
  );
export interface OpenExtensionView {
  readonly viewId: string;
  readonly presentation: ExtensionPresentation;
  readonly context: ExtensionContext;
}
export interface PluginExtensionUI {
  openView(input: OpenExtensionView): { close(): void };
}
export function extensionMatches(
  conditions: ExtensionConditions | undefined,
  context: ExtensionContext,
): boolean {
  return (
    !context.signal.aborted &&
    (!conditions?.targets || conditions.targets.includes(context.target)) &&
    (!conditions?.resourceKinds ||
      (!!context.resource &&
        conditions.resourceKinds.includes(context.resource.kind))) &&
    (!conditions?.formats ||
      (!!context.resource?.format &&
        conditions.formats.includes(context.resource.format))) &&
    (!conditions?.capabilities ||
      conditions.capabilities.every((capability) =>
        context.capabilities.includes(capability),
      ))
  );
}

export interface ActiveExtensionView extends OpenExtensionView {
  readonly pluginId: string;
  readonly signal: AbortSignal;
}
/** One controller per host registry; does not use a global runtime bridge. */
export class ExtensionViewController {
  #active: ActiveExtensionView | null = null;
  #abort: AbortController | undefined;
  #removeParent: (() => void) | undefined;
  #listeners = new Set<() => void>();
  constructor(readonly lookup: (id: string) => ExtensionView | undefined) {}
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  readonly snapshot = () => this.#active;
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  close = () => {
    this.#removeParent?.();
    this.#removeParent = undefined;
    this.#abort?.abort();
    this.#abort = undefined;
    if (this.#active) {
      this.#active = null;
      this.#emit();
    }
  };
  open(pluginId: string, input: OpenExtensionView): { close(): void } {
    const view = this.lookup(input.viewId);
    if (
      !view ||
      view.pluginId !== pluginId ||
      !view.supportedContexts.includes(input.context.scope) ||
      input.context.signal.aborted ||
      !["dialog", "drawer", "sidebar"].includes(input.presentation)
    )
      throw new Error("Extension view unavailable in this context");
    this.close();
    const abort = new AbortController();
    this.#abort = abort;
    const active = {
      ...input,
      pluginId,
      signal: abort.signal,
      context: {
        ...input.context,
        signal: AbortSignal.any([input.context.signal, abort.signal]),
      },
    };
    this.#active = active;
    const close = () => {
      if (this.#active === active) this.close();
    };
    input.context.signal.addEventListener("abort", close, { once: true });
    this.#removeParent = () =>
      input.context.signal.removeEventListener("abort", close);
    this.#emit();
    return { close };
  }
}
