import type { IntentDefinition } from "./intents.js";
import type { JsonValue } from "./json.js";
import type { ToolDefinition } from "./tools.js";

export type Disposer = () => void;

export interface RegistryEntry {
  readonly id: string;
}

/**
 * An effect-owned registry. Registering returns the only capability that can
 * remove that exact entry, and disposal is idempotent. No ambient runner or
 * process singleton participates in registration.
 */
export class EffectRegistry<T extends RegistryEntry> {
  #entries = new Map<string, T>();
  #owners = new Map<string, symbol>();

  register(entry: T): Disposer {
    if (!entry.id) throw new TypeError("Registry entry ID must not be empty");
    if (this.#entries.has(entry.id)) {
      throw new Error(`Registry entry "${entry.id}" is already registered`);
    }

    const owner = Symbol(entry.id);
    this.#entries.set(entry.id, Object.freeze(entry));
    this.#owners.set(entry.id, owner);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.#owners.get(entry.id) !== owner) return;
      this.#owners.delete(entry.id);
      this.#entries.delete(entry.id);
    };
  }

  get(id: string): T | undefined {
    return this.#entries.get(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  list(): readonly T[] {
    return Object.freeze(
      [...this.#entries.values()].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    );
  }

  get size(): number {
    return this.#entries.size;
  }
}

export interface WorkflowDefinition<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
  Context = unknown,
> extends RegistryEntry {
  readonly description?: string;
  readonly run: (
    input: Input,
    context: {
      readonly host: Context;
      readonly signal: AbortSignal;
    },
  ) => Output | Promise<Output>;
}

export interface AcceptanceDecision {
  readonly verdict: "accepted" | "rejected" | "needs-user";
  readonly evidence?: JsonValue;
}

export interface AcceptanceDefinition<
  Subject extends JsonValue = JsonValue,
  Context = unknown,
> extends RegistryEntry {
  readonly description?: string;
  readonly evaluate: (
    subject: Subject,
    context: {
      readonly host: Context;
      readonly signal: AbortSignal;
    },
  ) => AcceptanceDecision | Promise<AcceptanceDecision>;
}

export interface SkillDefinition<Context = unknown> extends RegistryEntry {
  readonly description?: string;
  readonly activate: (context: Context) => void | Disposer;
}

export function createIntentRegistry<
  Context = unknown,
>(): EffectRegistry<IntentDefinition<Context>> {
  return new EffectRegistry();
}

export function createToolRegistry<
  Context = unknown,
>(): EffectRegistry<ToolDefinition<Context>> {
  return new EffectRegistry();
}

export function createWorkflowRegistry<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
  Context = unknown,
>(): EffectRegistry<WorkflowDefinition<Input, Output, Context>> {
  return new EffectRegistry();
}

export function createAcceptanceRegistry<
  Subject extends JsonValue = JsonValue,
  Context = unknown,
>(): EffectRegistry<AcceptanceDefinition<Subject, Context>> {
  return new EffectRegistry();
}

export function createSkillRegistry<
  Context = unknown,
>(): EffectRegistry<SkillDefinition<Context>> {
  return new EffectRegistry();
}

/**
 * Activates the current deterministic skill snapshot and disposes successful
 * effects in reverse order. If activation throws, already-active skills are
 * rolled back before the error escapes.
 */
export function activateSkills<Context>(
  registry: EffectRegistry<SkillDefinition<Context>>,
  context: Context,
): Disposer {
  const disposers: Disposer[] = [];
  try {
    for (const skill of registry.list()) {
      const dispose = skill.activate(context);
      if (dispose) disposers.push(dispose);
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) dispose();
  };
}
